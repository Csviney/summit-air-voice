import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { TwilioRealtimeTransportLayer } from '@openai/agents-extensions';
import twilio from 'twilio';
import type { WebSocket } from 'ws';
import type { Config } from '../config.ts';
import { intakeValidationIssues } from '../contracts.ts';
import type { CalendarClient } from '../calendar.ts';
import { SCRIPT_VOICE, type CallControl } from '../escalation.ts';
import { recordStreamClosed, saveReadyFollowUp } from '../intake.ts';
import type { Store } from '../store.ts';
import { CONVERSATION_GUIDE } from './conversation-guide.ts';
import { AGENT_NAME, INSTRUCTIONS } from './instructions.ts';
import { createTools, type CallContext } from './tools.ts';
import { createTranscript } from './transcript.ts';

export type SessionOptions = {
  /** Deadline for Twilio's "start" message after the socket opens. */
  streamStartTimeoutMs: number;
  /** Deadline for the agent's first audio. */
  startupTimeoutMs: number;
  /** Caller silence allowed before checking in. */
  silenceCheckInMs: number;
  /** Further silence allowed after the check-in before hanging up. */
  silenceHangUpMs: number;
  /** Longer check-in and hang-up waits when the caller asks for a moment. */
  holdCheckInMs: number;
  holdHangUpMs: number;
  /** Wait before nudging a model that hasn't replied. */
  agentStallMs: number;
  /** Pause after goodbye playback before hanging up. */
  goodbyeGraceMs: number;
  /** Endpoint override for local tests. */
  realtimeUrl?: string;
};

const DEFAULT_OPTIONS: SessionOptions = {
  streamStartTimeoutMs: 10_000,
  startupTimeoutMs: 8_000,
  silenceCheckInMs: 10_000,
  silenceHangUpMs: 6_000,
  holdCheckInMs: 20_000,
  holdHangUpMs: 20_000,
  agentStallMs: 5_000,
  goodbyeGraceMs: 1_500,
};

const SILENCE_GOODBYE = "It sounds like you may have stepped away, so I'll end the call here. Goodbye.";
const STALL_APOLOGY = "I'm sorry, I'm having trouble on my end right now. Please call back in a few minutes. Goodbye.";
// Retry silent replies before playing the fallback.
const MAX_STALL_NUDGES = 2;
// Give callers more time when they ask for a moment.
const HOLD_PHRASES =
  /\b(hold on|hang on|one (sec|second|moment|minute)|just a (sec|second|moment|minute)|give me a (sec|second|moment|minute)|wait a (sec|second|moment|minute)|let me (check|find|look|grab|get))\b/i;
// Twilio plays 8 kHz μ-law: 8 bytes of audio per millisecond.
const MULAW_BYTES_PER_MS = 8;

type TwilioStartMessage = { event: 'start'; start?: { callSid?: unknown } };

// Put shared rules before the call flow in the system prompt.
const AGENT_INSTRUCTIONS = `${INSTRUCTIONS}\n\n${CONVERSATION_GUIDE}`;

// Block model audio during handoff, even if it ignores the prompt to stay silent.
class HandoffAwareTransport extends TwilioRealtimeTransportLayer {
  constructor(
    twilioWebSocket: WebSocket,
    private readonly withholdAgentAudio: () => boolean,
    private readonly diagnostic: (message: string) => void,
  ) {
    super({ twilioWebSocket });
  }

  override async connect(options: Parameters<TwilioRealtimeTransportLayer['connect']>[0]): Promise<void> {
    await super.connect(options);
    const websocket = this.connectionState.websocket;
    if (!websocket) return;
    // Log actual sends; requestResponse() may only queue a request in the SDK.
    const send = websocket.send.bind(websocket);
    websocket.send = (data) => {
      send(data);
      try {
        if (typeof data !== 'string') return;
        const event = JSON.parse(data);
        if (event.type === 'response.create' || event.type === 'response.cancel') {
          this.diagnostic(`OUT ${event.type} event=${logCode(event.event_id)} response=${logCode(event.response_id)}`);
        } else if (event.type === 'conversation.item.create' && event.item?.type === 'function_call_output') {
          this.diagnostic(`OUT function_call_output call=${logCode(event.item.call_id)}`);
        } else if (event.type === 'conversation.item.truncate') {
          this.diagnostic(`OUT conversation.item.truncate item=${logCode(event.item_id)}`);
        }
      } catch {
        // A logging failure must not interrupt audio or expose the raw payload.
      }
    };
  }

  override requestResponse(response?: Parameters<TwilioRealtimeTransportLayer['requestResponse']>[0]): void {
    this.diagnostic('REQUEST response.create');
    super.requestResponse(response);
  }

  protected override _onAudio(audioEvent: Parameters<TwilioRealtimeTransportLayer['_onAudio']>[0]): void {
    if (this.withholdAgentAudio()) return;
    super._onAudio(audioEvent);
  }
}

export type CallDeps = { config: Config; store: Store; calls: CallControl; calendar: CalendarClient };

export function startCall(
  socket: WebSocket,
  deps: CallDeps,
  claimCallSid: (callSid: string) => boolean,
  options: SessionOptions = DEFAULT_OPTIONS,
): void {
  const { config, store } = deps;
  const agent = new RealtimeAgent<CallContext>({
    name: AGENT_NAME,
    instructions: AGENT_INSTRUCTIONS,
    tools: createTools(deps),
  });
  // The SDK copies context; a shared holder lets tools see the verified call once it's bound.
  const context: CallContext = {
    call: { callSessionId: null, callSid: null, priority: null, finishedAt: null, handedOff: false, agentMuted: false, ended: false, callerTurn: 0, humanAskTurn: null, proposedVisit: null },
  };
  const transcript = createTranscript(store, () => context.call.callSessionId, () => context.call.agentMuted);

  // Listen early to capture streamSid; connect to OpenAI only after verifying the call.
  const transport = new HandoffAwareTransport(socket, () => context.call.agentMuted, diagnostic);
  // Set 8 kHz μ-law explicitly; the adapter's default previously negotiated incompatible PCM.
  const session = new RealtimeSession(agent, {
    transport,
    context,
    model: config.realtimeModel,
    config: {
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          // Filter handset noise to reduce false interruptions.
          noiseReduction: { type: 'near_field' },
          // Allow natural pauses; medium eagerness avoids the long waits seen with low.
          turnDetection: { type: 'semantic_vad', eagerness: 'medium' },
          // Reduce wrong-language transcriptions of unclear English audio.
          transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
        },
        // Keep the same voice across replies.
        output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
      },
    },
  });
  let callSid: string | null = null;
  // Until the first agent audio, any failure means the caller would sit in silence.
  let speaking = false;
  // Log turn timing without recording speech content.
  const startedAt = Date.now();
  let callerTurns = 0;
  let agentAudioActive = false;
  let callerStoppedAt: number | null = null;
  const responsesWithAudio = new Set<unknown>();

  // Estimate playback from bytes sent; audio arrives faster than Twilio plays it.
  // Track whose turn it is so a stalled reply isn't mistaken for caller silence.
  let playbackEndsAt = 0;
  let lastCallerActivityAt = Date.now();
  let callerSpeaking = false;
  let replyStartedAt = 0;
  let replyHadAudio = false;
  let goodbyePlayed = false;
  let hangingUp = false;
  let responseActive = false;
  let toolsInFlight = 0;
  let waitingOnAgentSince: number | null = null;
  let stallNudges = 0;
  let checkedInAt: number | null = null;
  let callerAskedToWait = false;
  const turnWatch = setInterval(watchTurns, 500);
  turnWatch.unref();

  let deadline = setTimeout(
    () => endStream(1008, 'Stream start not received.'),
    options.streamStartTimeoutMs,
  );

  // Ending the stream makes Twilio continue to the voice webhook's fallback <Say>.
  function endStream(code: number, reason: string): void {
    clearTimeout(deadline);
    if (socket.readyState === socket.OPEN) {
      console.warn(`Call ${callSid ?? 'unbound'}: ${reason} Ending stream.`);
      socket.close(code, reason);
    }
  }

  // Listen on the transport: the session only forwards transport events after connect().
  transport.on('*', (event) => {
    traceResponse(event);
    trackTurns(event as Parameters<typeof trackTurns>[0]);
    transcript.handle(event as Parameters<typeof transcript.handle>[0]);
    if (event.type === 'input_audio_buffer.speech_stopped') callerStoppedAt = Date.now();
    if (event.type === 'response.output_audio.delta' && callerStoppedAt) {
      // Includes the end-of-speech wait, any tool calls, and the model's first audio.
      console.log(`Call ${callSid}: agent replied ${((Date.now() - callerStoppedAt) / 1000).toFixed(1)}s after caller stopped.`);
      callerStoppedAt = null;
    }
    if (event.type === 'response.output_audio.delta') agentAudioActive = true;
    if (event.type === 'response.done') agentAudioActive = false;
    if (event.type === 'input_audio_buffer.speech_started') {
      callerTurns += 1;
      const at = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`Call ${callSid}: caller speech detected at ${at}s${agentAudioActive ? ', interrupting agent' : ''}.`);
    }
    if (!speaking && event.type === 'response.output_audio.delta') {
      speaking = true;
      clearTimeout(deadline);
      return;
    }
    if (callSid || event.type !== 'twilio_message') return;
    const message = (event as { message?: TwilioStartMessage }).message;
    if (message?.event !== 'start') return;

    clearTimeout(deadline);
    const sid = message.start?.callSid;
    if (typeof sid !== 'string' || !claimCallSid(sid)) {
      endStream(1008, 'Unknown or already-claimed call.');
      return;
    }
    callSid = sid;
    context.call.callSid = sid;
    try {
      context.call.callSessionId = store.findCallId(sid);
    } catch (error) {
      console.error(`Call ${sid}: could not load call record (${(error as Error).name}).`);
    }
    // Keep safety guidance available if storage fails; tools report that nothing was saved.
    if (!context.call.callSessionId) console.error(`Call ${sid}: no saved call record; intake will not be saved.`);
    deadline = setTimeout(
      () => endStream(1011, 'Realtime startup timed out.'),
      options.startupTimeoutMs,
    );
    void connect();
  });

  // Don't treat slow tools as a stalled model. Log names, result codes, and timing only.
  const toolStartedAt = new Map<string, number>();
  session.on('agent_tool_start', (_context, _agent, tool, details) => {
    toolsInFlight += 1;
    const key = toolCallKey(details, tool.name);
    toolStartedAt.set(key, Date.now());
    diagnostic(`tool start ${tool.name} call=${logCode(key)}`);
    if (tool.name === 'update_intake' && details.toolCall.type === 'function_call') {
      const issues = intakeValidationIssues(details.toolCall.arguments);
      if (issues.length) diagnostic(`update_intake invalid fields=${JSON.stringify(issues)} call=${logCode(key)}`);
    }
  });
  session.on('agent_tool_end', (_context, _agent, tool, result, details) => {
    toolsInFlight = Math.max(0, toolsInFlight - 1);
    const key = toolCallKey(details, tool.name);
    const ms = Date.now() - (toolStartedAt.get(key) ?? Date.now());
    toolStartedAt.delete(key);
    diagnostic(`tool ${tool.name} → ${toolOutcome(result)} (${ms}ms) call=${logCode(key)}`);
  });

  // Fail on errors before the greeting. Later errors may be harmless interruption races;
  // connection_change handles disconnects separately.
  session.on('error', (event) => {
    console.error(`Call ${callSid ?? 'unbound'}: realtime error ${describeError(event.error)} at +${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
    if (callSid && !speaking) endStream(1011, 'Realtime startup failed.');
  });

  // OpenAI can accept the socket and then drop it (e.g. a bad key or model).
  transport.on('connection_change', (status) => {
    if (status === 'disconnected' && callSid) endStream(1011, 'Realtime connection lost.');
  });

  socket.on('close', () => {
    clearTimeout(deadline);
    clearInterval(turnWatch);
    // Refuse tools once the call ends, including any model reply still in flight.
    context.call.ended = true;
    session.close();
    if (!callSid) return;
    // The adapter closes OpenAI with the stream, so unfinished transcription stays partial.
    transcript.finish();
    console.log(`Call ${callSid}: media stream closed after ${callerTurns} caller turn(s).`);
    // Ends the record only if the call was not redirected into a transfer.
    const callSessionId = context.call.callSessionId;
    if (callSessionId) {
      try {
        recordStreamClosed(store, callSessionId);
      } catch (error) {
        console.error(`Call ${callSid}: could not finalize call record (${(error as Error).name}).`);
      }
    }
  });

  function diagnostic(message: string): void {
    console.log(`Call ${callSid ?? 'unbound'}: realtime +${((Date.now() - startedAt) / 1000).toFixed(1)}s ${message}.`);
  }

  function traceResponse(event: {
    type: string;
    response_id?: unknown;
    item_id?: unknown;
    response?: {
      id?: unknown;
      status?: unknown;
      status_details?: { type?: unknown; reason?: unknown; error?: unknown } | null;
      output?: Array<{ type?: unknown; content?: Array<{ type?: unknown }> }> | null;
    };
  }): void {
    if (event.type === 'response.created') {
      diagnostic(`IN response.created response=${logCode(event.response?.id)}`);
    } else if (event.type === 'response.output_audio.delta') {
      if (!responsesWithAudio.has(event.response_id)) {
        responsesWithAudio.add(event.response_id);
        diagnostic(`IN first_audio response=${logCode(event.response_id)} muted=${context.call.agentMuted}`);
      }
    } else if (event.type === 'response.done') {
      const response = event.response;
      const details = response?.status_details;
      // Only types and codes, never generated text, arguments, or provider error messages.
      const output = response?.output?.map((item) =>
        [logCode(item.type), ...(item.content ?? []).map((part) => logCode(part.type))].join('/'),
      ).join(',') || 'none';
      diagnostic(`IN response.done response=${logCode(response?.id)} status=${logCode(response?.status)} detail=${logCode(details?.type)} reason=${logCode(details?.reason)} error=${details?.error ? describeError(details.error) : 'none'} output=${output} audio=${responsesWithAudio.has(response?.id)}`);
      responsesWithAudio.delete(response?.id);
    } else if (event.type === 'input_audio_buffer.speech_stopped' || event.type === 'input_audio_buffer.committed' || event.type === 'conversation.item.truncated') {
      diagnostic(`IN ${event.type} item=${logCode(event.item_id)}`);
    }
  }

  function trackTurns(event: {
    type: string;
    delta?: string;
    transcript?: string;
    item?: { type?: string; role?: string };
  }): void {
    const now = Date.now();
    switch (event.type) {
      case 'conversation.item.added':
        if (event.item?.type === 'message' && event.item.role === 'user') {
          context.call.callerTurn += 1;
        // The caller is now waiting for the agent's reply.
          waitingOnAgentSince = now;
          lastCallerActivityAt = now;
        }
        break;
      case 'conversation.item.input_audio_transcription.completed':
        callerAskedToWait = HOLD_PHRASES.test(event.transcript ?? '');
        break;
      case 'input_audio_buffer.speech_started':
        callerSpeaking = true;
        checkedInAt = null;
        // New caller speech requires another finish_intake and goodbye before automatic hang-up.
        goodbyePlayed = false;
        context.call.finishedAt = null;
        break;
      case 'input_audio_buffer.speech_stopped':
        callerSpeaking = false;
        lastCallerActivityAt = now;
        break;
      case 'response.created':
        responseActive = true;
        // A new response means any tool calls before it have returned.
        toolsInFlight = 0;
        replyStartedAt = now;
        replyHadAudio = false;
        break;
      case 'response.output_audio.delta': {
        const playMs = Buffer.byteLength(event.delta ?? '', 'base64') / MULAW_BYTES_PER_MS;
        playbackEndsAt = Math.max(playbackEndsAt, now) + playMs;
        replyHadAudio = true;
        waitingOnAgentSince = null;
        stallNudges = 0;
        break;
      }
      case 'response.done': {
        responseActive = false;
        const finishedAt = context.call.finishedAt;
        if (finishedAt && replyHadAudio && replyStartedAt >= finishedAt) goodbyePlayed = true;
        break;
      }
    }
  }

  function watchTurns(): void {
    if (!speaking || hangingUp || context.call.handedOff) return;
    const now = Date.now();
    if (goodbyePlayed && !callerSpeaking && now >= playbackEndsAt + options.goodbyeGraceMs) {
      void hangUp(null, 'after goodbye');
      return;
    }

    // Don't start reply or silence timers while the caller is speaking.
    if (callerSpeaking) return;

    // Recover a stalled agent reply separately from caller silence.
    if (waitingOnAgentSince !== null) {
      if (responseActive || toolsInFlight > 0 || now - waitingOnAgentSince < options.agentStallMs) return;
      if (stallNudges >= MAX_STALL_NUDGES) {
        void hangUp(STALL_APOLOGY, 'after the assistant stopped responding');
        return;
      }
      stallNudges += 1;
      waitingOnAgentSince = now;
      console.warn(`Call ${callSid}: no reply after the caller spoke; prompting the model (${stallNudges}/${MAX_STALL_NUDGES}).`);
      // Explain the nudge so the model doesn't repeat the same silent response.
      addSystemNote('The caller finished speaking and is waiting for your reply. Respond to them now, out loud.');
      transport.requestResponse();
      return;
    }

    if (responseActive) return;
    const quietFor = now - Math.max(lastCallerActivityAt, playbackEndsAt);
    if (checkedInAt === null) {
      if (quietFor >= (callerAskedToWait ? options.holdCheckInMs : options.silenceCheckInMs)) checkIn(now);
    } else if (now - Math.max(playbackEndsAt, checkedInAt) >= (callerAskedToWait ? options.holdHangUpMs : options.silenceHangUpMs)) {
      void hangUp(SILENCE_GOODBYE, 'after extended silence');
    }
  }

  /** Ask the model to check in using its own voice. */
  function checkIn(now: number): void {
    checkedInAt = now;
    console.log(`Call ${callSid}: caller silent; checking in.`);
    const note = callerAskedToWait
      ? 'The caller asked for a moment and has been quiet a while. Gently let them know you are still here and there is no rush.'
      : 'The caller has been quiet for a while. Briefly and warmly ask if they are still there.';
    addSystemNote(note);
    transport.requestResponse();
  }

  function addSystemNote(text: string): void {
    transport.sendEvent({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
    });
  }

  async function hangUp(script: string | null, reason: string): Promise<void> {
    if (!callSid) return;
    hangingUp = true;
    if (script && context.call.callSessionId) {
      try {
        const followUp = saveReadyFollowUp(store, context.call.callSessionId);
        if (followUp === 'UNBOOKED') {
          script = "I've saved the details needed to arrange your appointment. Our team will send you some potential times shortly. Nothing is booked yet. Goodbye.";
        } else if (followUp === 'UNCERTAIN') {
          script = "I couldn't confirm whether your visit was booked. Your request and availability are saved for representative review. Goodbye.";
        }
      } catch (error) {
        console.error(`Call ${callSid}: could not save booking follow-up (${(error as Error).name}).`);
      }
    }
    const twiml = new twilio.twiml.VoiceResponse();
    if (script) twiml.say(SCRIPT_VOICE, script);
    twiml.hangup();
    if (script) transcript.system(script);
    try {
      await deps.calls.redirect(callSid, twiml.toString());
      console.log(`Call ${callSid}: hung up ${reason}.`);
    } catch (error) {
      // Leave finalization to the stream close if the redirect fails.
      console.error(`Call ${callSid}: hang-up failed (${(error as Error).name}).`);
    }
  }

  async function connect(): Promise<void> {
    try {
      await session.connect({ apiKey: config.openAiApiKey, url: options.realtimeUrl });
      // Speak first so the caller hears the greeting.
      transport.requestResponse();
      console.log(`Call ${callSid}: realtime socket opened.`);
    } catch (error) {
      console.error(`Call ${callSid}: realtime connect failed ${describeError(error)}.`);
      endStream(1011, 'Realtime startup failed.');
    }
  }
}

const toolCallKey = (details: { toolCall?: unknown } | undefined, name: string) =>
  (details?.toolCall as { callId?: string } | undefined)?.callId ?? name;

/** "ok", "ok PROPOSED", or an error code; never the content of the result. */
function toolOutcome(result: unknown): string {
  try {
    const parsed = JSON.parse(String(result)) as { ok?: boolean; code?: string; data?: { status?: string; nextAction?: string } };
    if (parsed.ok) return ['ok', parsed.data?.nextAction ?? parsed.data?.status].filter(Boolean).join(' ');
    return parsed.code ?? 'error';
  } catch {
    return 'rejected input';
  }
}

// Provider messages may echo credentials; log only codes that look like identifiers.
const logCode = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : 'unknown';

function describeError(error: unknown): string {
  const safe = (value: unknown) =>
    typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
  if (!error || typeof error !== 'object') return '(unknown)';
  const record = error as { name?: unknown; type?: unknown; code?: unknown; error?: unknown };
  if (record.error && typeof record.error === 'object') return describeError(record.error);
  const parts = [safe(record.type) ?? safe(record.name), safe(record.code)].filter(Boolean);
  return parts.length ? `(${parts.join(' ')})` : '(unknown)';
}
