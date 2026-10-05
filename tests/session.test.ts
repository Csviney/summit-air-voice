import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { loadConfig } from '../src/config.ts';
import { applyIntakeUpdate } from '../src/intake.ts';
import { openStore } from '../src/store.ts';
import { CONTACT, UNUSED_CALENDAR, PROVIDER_TEST_ENV, update } from './fixtures.ts';
import { startCall } from '../src/voice/session.ts';

const config = loadConfig({
  OPENAI_API_KEY: 'sk-test-secret-key',
  OPENAI_REALTIME_MODEL: 'test-realtime-model',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  TWILIO_PUBLIC_BASE_URL: 'https://summit.example.test',
  DEMO_PASSWORD: 'test-demo-password',
  ...PROVIDER_TEST_ENV,
});
const TIMEOUT_MS = 300;

type ServerEvent = Record<string, unknown>;
const audioDelta: ServerEvent = {
  type: 'response.output_audio.delta',
  event_id: 'evt_audio',
  response_id: 'resp_1',
  item_id: 'item_1',
  output_index: 0,
  content_index: 0,
  delta: Buffer.alloc(160, 0xff).toString('base64'),
};
// The message echoes a rejected value, as real provider errors can.
const fatalError: ServerEvent = {
  type: 'error',
  event_id: 'evt_error',
  error: {
    type: 'invalid_request_error',
    code: 'invalid_api_key',
    message: 'Incorrect API key provided: sk-test-secret-key',
    param: null,
    event_id: null,
  },
};

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

// Run startCall with local Twilio and OpenAI fakes; onResponseCreate supplies model replies.
async function harness(
  onResponseCreate?: (openAi: WebSocket) => void,
  startupTimeoutMs = TIMEOUT_MS,
  silenceTimeoutMs = 60_000,
  redirectFails = false,
  stallMs = 60_000,
) {
  const openAiServer = new WebSocketServer({ port: 0 });
  const openAiSockets: WebSocket[] = [];
  const openAiEvents: ServerEvent[] = [];
  openAiServer.on('connection', (openAi) => {
    openAiSockets.push(openAi);
    openAi.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as ServerEvent;
      openAiEvents.push(event);
      if (event.type === 'response.create') onResponseCreate?.(openAi);
    });
  });
  await once(openAiServer, 'listening');

  const store = openStore(':memory:');
  const callSessionId = store.createCall('CA_ANSWERED', '+15555550100');
  const pendingCalls = new Set(['CA_ANSWERED']);
  const redirects: string[] = [];
  const calls = {
    redirect: async (_callSid: string, twiml: string) => {
      if (redirectFails) throw new Error('simulated Twilio failure');
      redirects.push(twiml);
    },
  };
  const twilioServer = new WebSocketServer({ port: 0 });
  twilioServer.on('connection', (socket) =>
    startCall(socket, { config, store, calls, calendar: UNUSED_CALENDAR }, (callSid) => pendingCalls.delete(callSid), {
      streamStartTimeoutMs: TIMEOUT_MS,
      startupTimeoutMs,
      silenceCheckInMs: silenceTimeoutMs,
      silenceHangUpMs: silenceTimeoutMs,
      holdCheckInMs: silenceTimeoutMs * 3,
      holdHangUpMs: silenceTimeoutMs * 3,
      agentStallMs: stallMs,
      goodbyeGraceMs: 50,
      realtimeUrl: `ws://localhost:${(openAiServer.address() as AddressInfo).port}`,
    }),
  );
  await once(twilioServer, 'listening');

  const twilio = new WebSocket(`ws://localhost:${(twilioServer.address() as AddressInfo).port}`);
  const media: unknown[] = [];
  twilio.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as { event?: string };
    if (message.event === 'media') media.push(message);
  });
  const closeCode = new Promise<number>((resolve) => twilio.on('close', (code) => resolve(code)));
  await once(twilio, 'open');

  cleanups.push(() => {
    twilio.terminate();
    openAiSockets.forEach((socket) => socket.terminate());
    openAiServer.close();
    twilioServer.close();
  });

  const start = (callSid = 'CA_ANSWERED') =>
    twilio.send(
      JSON.stringify({
        event: 'start',
        streamSid: 'MZ_TEST',
        start: {
          streamSid: 'MZ_TEST',
          callSid,
          mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        },
      }),
    );
  const greeted = async () => {
    while (media.length === 0) await delay(10);
  };
  const stillOpenAfterDeadline = async () => {
    await delay(TIMEOUT_MS + 150);
    return twilio.readyState === WebSocket.OPEN;
  };
  return {
    twilio, openAiSockets, openAiEvents, closeCode, start, greeted, stillOpenAfterDeadline, store, callSessionId, redirects, media,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (socket: WebSocket, ...events: ServerEvent[]) =>
  events.forEach((event) => socket.send(JSON.stringify(event)));

test('configures μ-law, noise reduction, and turn detection; plays the greeting', async () => {
  const call = await harness((openAi) => send(openAi, audioDelta));
  call.start();
  await call.greeted();

  const update = call.openAiEvents.find((event) => event.type === 'session.update') as {
    session?: {
      audio?: {
        input?: { format?: unknown; noise_reduction?: unknown; turn_detection?: unknown; transcription?: unknown };
        output?: { format?: unknown };
      };
    };
  };
  const input = update?.session?.audio?.input;
  assert.deepEqual(input?.format, { type: 'audio/pcmu' });
  assert.deepEqual(update?.session?.audio?.output?.format, { type: 'audio/pcmu' });
  // Handset noise shouldn't interrupt the agent.
  assert.deepEqual(input?.noise_reduction, { type: 'near_field' });
  assert.deepEqual(input?.turn_detection, { type: 'semantic_vad', eagerness: 'medium' });
  assert.deepEqual(input?.transcription, { model: 'gpt-4o-mini-transcribe', language: 'en' });
  assert.equal(await call.stillOpenAfterDeadline(), true);
});

test('ends the stream when no greeting audio arrives before the startup deadline', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const call = await harness();
  call.start();
  assert.equal(await call.closeCode, 1011);
});

test('ends the stream on an error before the greeting and never logs the provider message', async (t) => {
  const logged: string[] = [];
  const capture = (...args: unknown[]) => void logged.push(args.join(' '));
  t.mock.method(console, 'error', capture);
  t.mock.method(console, 'warn', capture);
  // A long deadline proves the error itself ends the stream, not the startup timeout.
  const call = await harness((openAi) => send(openAi, fatalError), 10_000);
  const startedAt = Date.now();
  call.start();

  assert.equal(await call.closeCode, 1011);
  assert.ok(Date.now() - startedAt < 2_000, 'closed by the error, not the deadline');
  assert.ok(logged.some((line) => line.includes('invalid_api_key')), 'logs the error code');
  assert.ok(!logged.some((line) => line.includes('sk-test-secret-key')), 'omits the echoed key');
});

test('keeps the call up when an error arrives after the greeting has started', async (t) => {
  t.mock.method(console, 'error', () => {});
  const call = await harness((openAi) => send(openAi, audioDelta, fatalError));
  call.start();
  await call.greeted();
  assert.equal(await call.stillOpenAfterDeadline(), true);
});

test('ends the stream when OpenAI disconnects mid-call', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const call = await harness((openAi) => {
    send(openAi, audioDelta);
    setTimeout(() => openAi.close(), 50);
  });
  call.start();
  assert.equal(await call.closeCode, 1011);
});

test('closes the OpenAI connection when the caller hangs up', async () => {
  const call = await harness((openAi) => send(openAi, audioDelta));
  call.start();
  await call.greeted();
  const openAiClosed = once(call.openAiSockets[0]!, 'close');
  call.twilio.close();
  await openAiClosed;

  // A hangup before finish_intake is saved as an incomplete call.
  const { session } = call.store.getRecord(call.callSessionId)!;
  assert.equal(session.status, 'ENDED');
  assert.equal(session.outcome, 'INCOMPLETE');
});

test('rejects an unknown CallSid without contacting OpenAI', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const call = await harness();
  call.start('CA_UNKNOWN');
  assert.equal(await call.closeCode, 1008);
  assert.equal(call.openAiSockets.length, 0);
});

test('ends a stream that never sends a start message without contacting OpenAI', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const call = await harness();
  assert.equal(await call.closeCode, 1008);
  assert.equal(call.openAiSockets.length, 0);
});

const serverEvent = (type: string, extra: ServerEvent = {}): ServerEvent => ({ type, event_id: `evt_${type}`, ...extra });
const responseCreated = (id: string) =>
  serverEvent('response.created', { response: { id, object: 'realtime.response', status: 'in_progress', output: [] } });
const responseDone = (id: string, output: unknown[] = []) =>
  serverEvent('response.done', { response: { id, object: 'realtime.response', status: 'completed', output } });
const audio = (responseId: string) => ({ ...audioDelta, response_id: responseId });

test('diagnostics distinguish failed, cancelled, empty and text-only responses without logging content', async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => logged.push(args.join(' ')));
  const secret = 'sk-test-never-log-this';
  const callerText = 'Private caller address and phone number';
  const call = await harness((openAi) => send(openAi, responseCreated('resp_greeting'), audio('resp_greeting'), responseDone('resp_greeting')));
  call.start();
  await call.greeted();
  send(
    call.openAiSockets[0]!,
    responseCreated('resp_failed'),
    serverEvent('response.done', {
      response: {
        id: 'resp_failed', status: 'failed', output: [],
        status_details: { type: 'failed', error: { type: 'server_error', code: 'server_error', message: secret } },
      },
    }),
    responseCreated('resp_cancelled'),
    serverEvent('response.done', {
      response: { id: 'resp_cancelled', status: 'cancelled', output: [], status_details: { type: 'cancelled', reason: 'turn_detected' } },
    }),
    responseCreated('resp_empty'),
    responseDone('resp_empty'),
    responseCreated('resp_text'),
    responseDone('resp_text', [{ type: 'message', content: [{ type: 'output_text', text: callerText }] }]),
  );
  while (!logged.some((line) => line.includes('response.done response=resp_text'))) await delay(10);
  assert.ok(logged.some((line) => /response=resp_failed status=failed .*error=\(server_error server_error\).*audio=false/.test(line)));
  assert.ok(logged.some((line) => /response=resp_cancelled status=cancelled .*reason=turn_detected/.test(line)));
  assert.ok(logged.some((line) => /response=resp_empty status=completed .*output=none audio=false/.test(line)));
  assert.ok(logged.some((line) => /response=resp_text .*output=message\/output_text audio=false/.test(line)));
  assert.ok(logged.some((line) => /response=resp_greeting status=completed .*audio=true/.test(line)));
  assert.ok(logged.some((line) => /realtime \+\d+\.\ds IN response.created response=resp_failed/.test(line)));
  assert.ok(!logged.join('\n').includes(secret));
  assert.ok(!logged.join('\n').includes(callerText));
  assert.equal(call.twilio.readyState, WebSocket.OPEN, 'diagnostics do not change error handling');
});

test('hangs up with a short scripted goodbye after an extended silence', async () => {
  const call = await harness((openAi) => send(openAi, responseCreated('resp_1'), audio('resp_1'), responseDone('resp_1')), TIMEOUT_MS, 300);
  call.start();
  await call.greeted();
  while (call.redirects.length === 0) await delay(20);
  assert.match(call.redirects[0]!, /stepped away/);
  assert.match(call.redirects[0]!, /<Hangup\/>/);
});

test('does not hang up for silence while the caller is still talking', async () => {
  const call = await harness(
    (openAi) => send(openAi, responseCreated('resp_1'), audio('resp_1'), responseDone('resp_1'), serverEvent('input_audio_buffer.speech_started', { audio_start_ms: 0, item_id: 'item_caller' })),
    TIMEOUT_MS,
    300,
  );
  call.start();
  await call.greeted();
  await delay(700);
  assert.equal(call.redirects.length, 0);
});

test('hangs up without extra words once the goodbye after finish_intake has played', async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => logged.push(args.join(' ')));
  let responses = 0;
  const call = await harness((openAi) => {
    responses += 1;
    if (responses === 1) {
      // Finish intake before the spoken goodbye.
      const finishCall = {
        id: 'item_fn',
        type: 'function_call',
        status: 'completed',
        name: 'finish_intake',
        call_id: 'call_1',
        arguments: '{"callerDeclined":false}',
      };
      send(
        openAi,
        responseCreated('resp_1'),
        audio('resp_1'),
        serverEvent('response.output_item.done', { response_id: 'resp_1', output_index: 0, item: finishCall }),
        responseDone('resp_1', [finishCall]),
      );
    } else {
      // Speak the goodbye after the tool returns.
      send(openAi, responseCreated('resp_2'), audio('resp_2'), responseDone('resp_2'));
    }
  });
  call.start();
  while (call.redirects.length === 0) await delay(20);
  assert.equal(call.redirects[0], '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  assert.equal(call.store.getRecord(call.callSessionId)!.session.outcome, 'FOLLOW_UP');
  assert.ok(logged.some((line) => line.includes('OUT function_call_output call=call_1')));
  const transmitted = call.openAiEvents.filter((event) => event.type === 'response.create');
  assert.equal(logged.filter((line) => line.includes('OUT response.create')).length, transmitted.length);
  for (const event of transmitted) {
    assert.ok(logged.some((line) => line.includes(`OUT response.create event=${event.event_id}`)));
  }
});

test('an abrupt hangup keeps the partial transcript and marks it partial', async () => {
  const call = await harness((openAi) =>
    send(
      openAi,
      responseCreated('resp_1'),
      serverEvent('conversation.item.added', {
        previous_item_id: null,
        item: { id: 'item_caller', type: 'message', role: 'user', status: 'completed', content: [{ type: 'input_audio', transcript: null }] },
      }),
      audio('resp_1'),
      responseDone('resp_1'),
    ),
  );
  call.start();
  await call.greeted();
  await delay(100);
  call.twilio.close();
  await delay(300);

  const session = call.store.getRecord(call.callSessionId)!.session;
  assert.deepEqual(session.transcript.map((t) => [t.speaker, t.text]), [['CALLER', '']]);
  assert.equal(session.transcriptState, 'PARTIAL');
  assert.equal(session.outcome, 'INCOMPLETE');
});

test('a caller who keeps talking after the goodbye is not hung up on until a fresh finish_intake', async () => {
  let responses = 0;
  const finishCall = {
    id: 'item_fn',
    type: 'function_call',
    status: 'completed',
    name: 'finish_intake',
    call_id: 'call_1',
    arguments: '{"callerDeclined":false}',
  };
  const call = await harness((openAi) => {
    responses += 1;
    if (responses === 1) {
      send(
        openAi,
        responseCreated('resp_1'),
        audio('resp_1'),
        serverEvent('response.output_item.done', { response_id: 'resp_1', output_index: 0, item: finishCall }),
        responseDone('resp_1', [finishCall]),
      );
    } else if (responses === 2) {
      // The caller speaks during goodbye, reopening the conversation.
      send(
        openAi,
        responseCreated('resp_2'),
        audio('resp_2'),
        responseDone('resp_2'),
        serverEvent('input_audio_buffer.speech_started', { audio_start_ms: 0, item_id: 'item_caller' }),
        serverEvent('input_audio_buffer.speech_stopped', { audio_end_ms: 500, item_id: 'item_caller' }),
        responseCreated('resp_3'),
        audio('resp_3'),
        responseDone('resp_3'),
      );
    }
  });
  call.start();
  while (responses < 2) await delay(20);
  await delay(800);
  assert.equal(call.redirects.length, 0);
});

// Count any model audio that reaches Twilio after escalation, before the stream closes.
async function escalateThenKeepTalking(redirectFails: boolean) {
  let responses = 0;
  let mediaBeforeFollowUp = 0;
  const escalateCall = { id: 'item_fn', type: 'function_call', status: 'completed', name: 'escalate_call', call_id: 'call_1', arguments: '{}' };
  const call = await harness(
    (openAi) => {
      responses += 1;
      if (responses === 1) {
        send(
          openAi,
          responseCreated('resp_1'),
          audio('resp_1'),
          serverEvent('response.output_item.done', { response_id: 'resp_1', output_index: 0, item: escalateCall }),
          responseDone('resp_1', [escalateCall]),
        );
      } else if (responses === 2) {
        // Try speaking after escalation while Twilio's stream is still open.
        mediaBeforeFollowUp = call.media.length;
        send(openAi, responseCreated('resp_2'), audio('resp_2'), audio('resp_2'), responseDone('resp_2'));
      }
    },
    TIMEOUT_MS,
    60_000,
    redirectFails,
  );
  // A saved emergency, so escalation is allowed.
  assert.ok(applyIntakeUpdate(call.store, call.callSessionId, update({ safetySignals: ['GAS_ODOR'] })).ok);
  call.start();
  while (responses < 2) await delay(20);
  await delay(300);
  return { call, followUpMedia: call.media.length - mediaBeforeFollowUp };
}

test('once a hand-off succeeds, no further agent audio reaches the caller before the stream closes', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { call, followUpMedia } = await escalateThenKeepTalking(false);
  assert.equal(call.redirects.length, 1, 'the emergency script took over');
  assert.equal(followUpMedia, 0);
  assert.equal(call.twilio.readyState, WebSocket.OPEN, 'Twilio has not closed the stream yet');
});

test('when the hand-off fails, the agent can still speak the fallback', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { call, followUpMedia } = await escalateThenKeepTalking(true);
  assert.equal(call.redirects.length, 0);
  assert.ok(followUpMedia > 0);
});

const callerItem = (id: string) =>
  serverEvent('conversation.item.added', {
    previous_item_id: null,
    item: { id, type: 'message', role: 'user', status: 'completed', content: [{ type: 'input_audio', transcript: null }] },
  });
const systemNotes = (events: ServerEvent[]) =>
  events.filter((e) => e.type === 'conversation.item.create' && (e.item as { role?: string })?.role === 'system');

test('a silent caller is asked if they are still there before the call ends', async (t) => {
  t.mock.method(console, 'log', () => {});
  const call = await harness((openAi) => send(openAi, responseCreated('resp_1'), audio('resp_1'), responseDone('resp_1')), TIMEOUT_MS, 300);
  call.start();
  await call.greeted();
  while (call.redirects.length === 0) await delay(20);
  assert.equal(systemNotes(call.openAiEvents).length, 1, 'checked in first');
  assert.match(call.redirects[0]!, /stepped away/);
});

test('when the model goes quiet after the caller speaks, it is prompted, never treated as caller silence', async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', (...args: unknown[]) => logged.push(args.join(' ')));
  let responses = 0;
  const call = await harness(
    (openAi) => {
      responses += 1;
      // Only the greeting gets a reply; afterwards the model stays silent.
      if (responses === 1) send(openAi, responseCreated('resp_1'), audio('resp_1'), responseDone('resp_1'));
    },
    TIMEOUT_MS,
    300,
    false,
    200,
  );
  call.start();
  await call.greeted();
  send(call.openAiSockets[0]!, callerItem('item_caller'));
  while (call.redirects.length === 0) await delay(20);
  // The SDK queues requests, so check that at least one retry reaches OpenAI.
  assert.ok(responses >= 2, 'the model was prompted after the caller spoke');
  const notes = systemNotes(call.openAiEvents).map((e) => (e.item as { content: Array<{ text: string }> }).content[0]!.text);
  assert.ok(notes.length >= 1 && notes.every((text) => /waiting for your reply/.test(text)), 'nudges explain why');
  assert.ok(!notes.some((text) => /still there/.test(text)), 'no "are you still there" while the caller waits on us');
  assert.match(call.redirects[0]!, /having trouble on my end/);
  assert.doesNotMatch(call.redirects[0]!, /stepped away/);
  const requested = logged.filter((line) => line.includes('REQUEST response.create'));
  const sent = logged.filter((line) => line.includes('OUT response.create'));
  assert.equal(sent.length, responses, 'OUT counts requests actually observed by the server');
  assert.ok(requested.length > sent.length, 'a queued nudge is not logged as sent');
});

test('a caller who says "hold on" gets longer before the check-in', async (t) => {
  t.mock.method(console, 'log', () => {});
  const call = await harness((openAi) => send(openAi, responseCreated('resp_1'), audio('resp_1'), responseDone('resp_1')), TIMEOUT_MS, 300);
  call.start();
  await call.greeted();
  send(
    call.openAiSockets[0]!,
    serverEvent('conversation.item.input_audio_transcription.completed', { item_id: 'item_hold', content_index: 0, transcript: 'Hold on, let me find it.' }),
  );
  await delay(600);
  assert.equal(systemNotes(call.openAiEvents).length, 0, 'not checked in at the normal 300ms');
  while (systemNotes(call.openAiEvents).length === 0) await delay(20);
  const note = systemNotes(call.openAiEvents)[0]!.item as { content: Array<{ text: string }> };
  assert.match(note.content[0]!.text, /no rush/);
});

test('a stalled model after qualified intake saves availability for follow-up and says nothing is booked', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let responses = 0;
  const call = await harness((openAi) => {
    if (++responses === 1) send(openAi, responseCreated('resp_1'), audio('resp_1'), responseDone('resp_1'));
  }, TIMEOUT_MS, 60_000, false, 100);
  call.start();
  await call.greeted();
  applyIntakeUpdate(call.store, call.callSessionId, update({ ...CONTACT, issueCategory: 'NO_COOLING',
    systemImpact: 'COMPLETE_OUTAGE', safetySignals: [], vulnerableOccupants: [], temperatureRisk: 'NONE_REPORTED' }));
  applyIntakeUpdate(call.store, call.callSessionId, update({ detailsConfirmed: true }));
  send(call.openAiSockets[0]!, callerItem('item_booking_availability'));
  while (call.redirects.length === 0) await delay(20);
  assert.match(call.redirects[0]!, /saved the details needed to arrange your appointment/);
  assert.match(call.redirects[0]!, /team will send you some potential times shortly/);
  assert.match(call.redirects[0]!, /Nothing is booked yet/);
  assert.doesNotMatch(call.redirects[0]!, /call back in a few minutes/);
  const record = call.store.getRecord(call.callSessionId)!;
  assert.equal(record.request?.status, 'FOLLOW_UP_PENDING');
  assert.equal(record.session.outcome, 'FOLLOW_UP');
});

test('the model is not nudged while the caller is still mid-answer', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  let responses = 0;
  const call = await harness(
    (openAi) => {
      responses += 1;
      if (responses === 1) send(openAi, responseCreated('resp_1'), audio('resp_1'), responseDone('resp_1'));
    },
    TIMEOUT_MS,
    60_000,
    false,
    200,
  );
  call.start();
  await call.greeted();
  // The first part of a split answer is committed, then the caller keeps talking.
  send(call.openAiSockets[0]!, callerItem('item_part_1'), serverEvent('input_audio_buffer.speech_started', { audio_start_ms: 0, item_id: 'item_part_2' }));
  await delay(700);
  assert.equal(responses, 1, 'no nudge while the caller speaks');
  assert.equal(call.redirects.length, 0);
});
