import assert from 'node:assert/strict';
import { test } from 'node:test';
import twilio from 'twilio';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openStore } from '../src/store.ts';
import { PROVIDER_TEST_ENV } from './fixtures.ts';

const env = {
  OPENAI_API_KEY: 'test-openai-key',
  OPENAI_REALTIME_MODEL: 'test-realtime-model',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  TWILIO_PUBLIC_BASE_URL: 'https://summit.example.test/',
  DEMO_PASSWORD: 'test-demo-password',
  ...PROVIDER_TEST_ENV,
};
const config = loadConfig(env);
const voiceUrl = 'https://summit.example.test/twilio/voice';
const streamUrl = 'wss://summit.example.test/twilio/media';
const callParams = { CallSid: 'CA00000000000000000000000000000001', From: '+15555550100' };

const sign = (url: string, params: Record<string, string>) =>
  twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, url, params);

async function setup() {
  const calls: Array<(callSid: string) => boolean> = [];
  const store = openStore(':memory:');
  const app = await buildApp(config, store, {
    calls: { redirect: async () => {} },
    startCall: (_socket, claim) => {
      calls.push(claim);
    },
  });
  return { app, calls, store };
}

function postVoice(app: Awaited<ReturnType<typeof buildApp>>, signature: string | undefined) {
  return app.inject({
    method: 'POST',
    url: '/twilio/voice',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(signature ? { 'x-twilio-signature': signature } : {}),
    },
    payload: new URLSearchParams(callParams).toString(),
  });
}

test('config requires an HTTPS origin without a path', () => {
  assert.equal(config.publicOrigin, 'https://summit.example.test');
  assert.throws(() => loadConfig({ ...env, TWILIO_PUBLIC_BASE_URL: 'http://summit.example.test' }));
  assert.throws(() => loadConfig({ ...env, TWILIO_PUBLIC_BASE_URL: 'https://summit.example.test/x' }));
  assert.throws(() => loadConfig({ ...env, OPENAI_API_KEY: '' }), /OPENAI_API_KEY/);
});

test('signed voice webhook returns a stream to the configured public origin', async () => {
  const { app, store } = await setup();
  const response = await postVoice(app, sign(voiceUrl, callParams));
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'] ?? '', /text\/xml/);
  assert.match(response.body, /<Stream url="wss:\/\/summit\.example\.test\/twilio\/media"\/>/);

  // The call and an empty request are saved at call start; a retried webhook adds nothing.
  await postVoice(app, sign(voiceUrl, callParams));
  const records = store.listRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.session.fromPhone, callParams.From);
  assert.equal(records[0]!.request?.status, 'OPEN');
  await app.close();
});

test('unsigned or tampered voice webhooks are rejected', async () => {
  const { app } = await setup();
  assert.equal((await postVoice(app, undefined)).statusCode, 403);
  assert.equal((await postVoice(app, sign(voiceUrl, { ...callParams, From: '+15555550199' }))).statusCode, 403);
  // A spoofed Host header must not change the URL the signature is checked against.
  const spoofed = await app.inject({
    method: 'POST',
    url: '/twilio/voice',
    headers: {
      host: 'attacker.example.test',
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': sign('https://attacker.example.test/twilio/voice', callParams),
    },
    payload: new URLSearchParams(callParams).toString(),
  });
  assert.equal(spoofed.statusCode, 403);
  await app.close();
});

test('unsigned media stream upgrades never start a session', async () => {
  const { app, calls } = await setup();
  await app.ready();
  await assert.rejects(app.injectWS('/twilio/media'), /403/);
  await assert.rejects(
    app.injectWS('/twilio/media', { headers: { 'x-twilio-signature': sign(voiceUrl, {}) } }),
    /403/,
  );
  assert.equal(calls.length, 0);
  await app.close();
});

test('signed media stream starts a session bound only to an answered CallSid', async () => {
  const { app, calls } = await setup();
  await app.ready();
  await postVoice(app, sign(voiceUrl, callParams));

  const socket = await app.injectWS('/twilio/media', {
    headers: { 'x-twilio-signature': sign(streamUrl, {}) },
  });
  socket.terminate();
  assert.equal(calls.length, 1);
  const claim = calls[0]!;
  assert.equal(claim('CA_UNKNOWN'), false);
  assert.equal(claim(callParams.CallSid), true);
  assert.equal(claim(callParams.CallSid), false, 'a CallSid binds to one stream only');

  // A replayed signed webhook must not reopen a claimed CallSid.
  assert.equal((await postVoice(app, sign(voiceUrl, callParams))).statusCode, 200);
  assert.equal(claim(callParams.CallSid), false);
  await app.close();
});
