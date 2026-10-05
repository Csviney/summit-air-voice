import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import type { Store } from '../store.ts';
import { detailPage, listPage } from './views.ts';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

// Read-only inspection of saved records, behind HTTP Basic Auth separate from Twilio auth.
export function demoRoutes(app: FastifyInstance, config: Config, store: Store): void {
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest();
  const expected = digest(`demo:${config.demoPassword}`);

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    const [scheme, encoded] = (request.headers.authorization ?? '').split(' ');
    const given = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
    // Comparing fixed-length digests keeps the check constant-time regardless of input length.
    if (!timingSafeEqual(digest(given), expected)) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Basic realm="Summit Air demo", charset="UTF-8"')
        .send('Authentication required.');
    }
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY')
      // No scripts at all: captured text can never execute even if escaping were missed.
      .header('Content-Security-Policy', "default-src 'none'; style-src 'self'; form-action 'none'");
  };

  app.get('/demo', { onRequest: authenticate }, async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(listPage(store.listRecords())),
  );

  app.get<{ Params: { id: string } }>(
    '/demo/calls/:id',
    { onRequest: authenticate },
    async (request, reply) => {
      const record = store.getRecord(request.params.id);
      if (!record) return reply.code(404).type('text/plain').send('Call not found.');
      return reply.type('text/html; charset=utf-8').send(detailPage(record));
    },
  );

  app.get('/demo/styles.css', { onRequest: authenticate }, async (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(styles),
  );
}
