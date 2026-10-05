import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { Config } from './config.ts';
import { googleCalendarClient, type CalendarClient } from './calendar.ts';
import { demoRoutes } from './demo/routes.ts';
import { twilioCallControl, type CallControl } from './escalation.ts';
import type { Store } from './store.ts';
import { voiceRoutes, type StartCall } from './voice/routes.ts';
import { startCall as startRealtimeCall } from './voice/session.ts';

export async function buildApp(
  config: Config,
  store: Store,
  {
    calls = twilioCallControl(config),
    calendar = googleCalendarClient(config.google),
    startCall,
  }: { calls?: CallControl; calendar?: CalendarClient; startCall?: StartCall } = {},
): Promise<FastifyInstance> {
  startCall ??= (socket, claimCallSid) => startRealtimeCall(socket, { config, store, calls, calendar }, claimCallSid);
  const app = Fastify();

  // Twilio sends webhook fields as form data.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  await app.register(fastifyWebsocket);
  app.get('/health', async () => ({ status: 'ok' }));
  voiceRoutes(app, config, store, startCall);
  demoRoutes(app, config, store);
  return app;
}
