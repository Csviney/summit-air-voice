import type { FastifyInstance, FastifyRequest } from 'fastify';
import twilio from 'twilio';
import type { WebSocket } from 'ws';
import type { Config } from '../config.ts';
import { recordCallStatus, recordDialResult, SCRIPT_VOICE } from '../escalation.ts';
import type { Store } from '../store.ts';

export type StartCall = (socket: WebSocket, claimCallSid: (callSid: string) => boolean) => void;

// How long a signed voice webhook's CallSid waits for its media stream to connect.
const PENDING_CALL_TTL_MS = 30_000;
// Claimed CallSids are remembered longer than any call so a replayed webhook cannot reopen one.
const CLAIMED_CALL_TTL_MS = 6 * 60 * 60_000;

export function voiceRoutes(app: FastifyInstance, config: Config, store: Store, startCall: StartCall): void {
  const streamUrl = config.publicOrigin.replace(/^https:/, 'wss:') + '/twilio/media';
  const calls = new Map<string, { state: 'pending' | 'claimed'; expiry: NodeJS.Timeout }>();
  const track = (callSid: string, state: 'pending' | 'claimed', ttlMs: number) => {
    clearTimeout(calls.get(callSid)?.expiry);
    calls.set(callSid, { state, expiry: setTimeout(() => calls.delete(callSid), ttlMs).unref() });
  };

  // Twilio signs the public URL it called, so validate against the configured origin.
  const isSigned = (request: FastifyRequest, url: string, params: Record<string, string>) => {
    const signature = request.headers['x-twilio-signature'];
    return (
      typeof signature === 'string' &&
      signature !== '' &&
      twilio.validateRequest(config.twilioAuthToken, signature, url, params)
    );
  };

  const claimCallSid = (callSid: string): boolean => {
    if (calls.get(callSid)?.state !== 'pending') return false;
    track(callSid, 'claimed', CLAIMED_CALL_TTL_MS);
    return true;
  };

  app.post('/twilio/voice', async (request, reply) => {
    const params = formParams(request.body);
    if (!params || !isSigned(request, config.publicOrigin + request.url, params)) {
      // Usually TWILIO_PUBLIC_BASE_URL or the auth token not matching what Twilio used.
      console.warn('Voice webhook rejected: invalid Twilio signature.');
      return reply.code(403).send('Invalid Twilio signature.');
    }
    const callSid = params.CallSid;
    if (!callSid) return reply.code(400).send('Missing CallSid.');
    console.log(`Call ${callSid}: voice webhook accepted.`);

    // Save before answering; storage failure must not block the call or safety guidance.
    try {
      store.createCall(callSid, params.From || null);
    } catch (error) {
      console.error(`Call ${callSid}: could not create call record (${(error as Error).name}).`);
    }

    // Twilio may retry a webhook; a known CallSid keeps its state and original expiry.
    if (!calls.has(callSid)) track(callSid, 'pending', PENDING_CALL_TTL_MS);

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.connect().stream({ url: streamUrl });
    // Reached only if the stream ends without the call being redirected, e.g. a startup failure.
    twiml.say(SCRIPT_VOICE, 'Sorry, our assistant is unavailable right now. Please call back shortly.');
    return reply.type('text/xml').send(twiml.toString());
  });

  // Final status closes the call record; repeated callbacks are safe.
  app.post('/twilio/status', async (request, reply) => {
    const params = formParams(request.body);
    if (!params || !isSigned(request, config.publicOrigin + request.url, params)) {
      console.warn('Status callback rejected: invalid Twilio signature.');
      return reply.code(403).send('Invalid Twilio signature.');
    }
    if (params.CallSid && params.CallStatus) {
      try {
        recordCallStatus(store, params.CallSid, params.CallStatus);
      } catch (error) {
        console.error(`Call ${params.CallSid}: status update failed (${(error as Error).name}).`);
      }
    }
    return reply.code(204).send();
  });

  // Handle the transfer result and return the closing TwiML.
  app.post<{ Querystring: { escalationId?: string } }>('/twilio/dial-result', async (request, reply) => {
    const params = formParams(request.body);
    if (!params || !isSigned(request, config.publicOrigin + request.url, params)) {
      console.warn('Dial result rejected: invalid Twilio signature.');
      return reply.code(403).send('Invalid Twilio signature.');
    }
    console.log(`Call ${params.CallSid}: transfer dial result ${params.DialCallStatus ?? 'unknown'}.`);
    return reply.type('text/xml').send(recordDialResult(store, request.query.escalationId, params));
  });

  app.get(
    '/twilio/media',
    {
      websocket: true,
      // Runs before the upgrade, so unsigned requests never reach startCall or OpenAI.
      preValidation: async (request, reply) => {
        const signed =
          request.url === '/twilio/media' &&
          (isSigned(request, streamUrl, {}) || isSigned(request, streamUrl + '/', {}));
        if (!signed) {
          console.warn('Media stream rejected: invalid Twilio signature.');
          return reply.code(403).send('Invalid Twilio signature.');
        }
      },
    },
    (socket) => startCall(socket, claimCallSid),
  );
}

function formParams(body: unknown): Record<string, string> | null {
  if (!body || typeof body !== 'object') return null;
  const entries = Object.entries(body);
  return entries.every(([, value]) => typeof value === 'string')
    ? (Object.fromEntries(entries) as Record<string, string>)
    : null;
}
