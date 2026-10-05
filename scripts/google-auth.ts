import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// Authorize event access and print a refresh token for .env.

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const base64url = (buffer: Buffer) => buffer.toString('base64url');
const verifier = base64url(randomBytes(32));
const challenge = base64url(createHash('sha256').update(verifier).digest());
const state = base64url(randomBytes(16));

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/callback') return void response.writeHead(404).end();
  const code = url.searchParams.get('code');
  if (url.searchParams.get('state') !== state || !code) {
    response.writeHead(400).end('Authorization failed or was denied. Check the terminal.');
    console.error(`Authorization failed: ${url.searchParams.get('error') ?? 'state mismatch'}`);
    return void server.close();
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const body = (await tokenResponse.json()) as { refresh_token?: string; error?: string };
  if (!tokenResponse.ok || !body.refresh_token) {
    response.writeHead(500).end('Token exchange failed. Check the terminal.');
    console.error(`Token exchange failed: ${body.error ?? tokenResponse.status}. If you authorized before, revoke access and retry.`);
  } else {
    response.writeHead(200).end('Authorized. You can close this tab and return to the terminal.');
    console.log('\nAdd this line to .env (keep it secret; it is not committed):\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${body.refresh_token}\n`);
  }
  server.close();
});

const redirectUri = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

server.listen(0, '127.0.0.1', () => {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    // Forces a refresh token even if this account authorized the app before.
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  console.log('Open this URL in your browser and sign in with the Google account that owns the demo calendar:\n');
  console.log(`${url}\n`);
});
