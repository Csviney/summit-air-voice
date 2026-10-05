import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { applyIntakeUpdate } from '../src/intake.ts';
import { openStore } from '../src/store.ts';
import { PROVIDER_TEST_ENV, update } from './fixtures.ts';

const config = loadConfig({
  OPENAI_API_KEY: 'test-openai-key',
  OPENAI_REALTIME_MODEL: 'test-realtime-model',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  TWILIO_PUBLIC_BASE_URL: 'https://summit.example.test',
  DEMO_PASSWORD: 'test-demo-password',
  ...PROVIDER_TEST_ENV,
});
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const AUTH = { authorization: basic('demo', 'test-demo-password') };

async function setup() {
  const store = openStore(':memory:');
  const app = await buildApp(config, store, { calls: { redirect: async () => {} }, startCall: () => {} });
  return { app, store };
}

test('demo routes require the demo credentials', async () => {
  const { app, store } = await setup();
  const id = store.createCall('CA_TEST', null);
  for (const url of ['/demo', `/demo/calls/${id}`, '/demo/styles.css']) {
    const anonymous = await app.inject({ url });
    assert.equal(anonymous.statusCode, 401, url);
    assert.match(String(anonymous.headers['www-authenticate']), /^Basic/);
    assert.equal((await app.inject({ url, headers: { authorization: basic('demo', 'wrong') } })).statusCode, 401);
    assert.equal((await app.inject({ url, headers: { authorization: basic('admin', 'test-demo-password') } })).statusCode, 401);
    assert.equal((await app.inject({ url, headers: AUTH })).statusCode, 200, url);
  }
  await app.close();
});

test('captured text is escaped and pages cannot run scripts or be cached', async () => {
  const { app, store } = await setup();
  const id = store.createCall('CA_TEST', null);
  const result = applyIntakeUpdate(
    store,
    id,
    update({ intent: 'HVAC_SERVICE', callerName: '<script>alert(1)</script>', issueSummary: '"><img src=x onerror=alert(1)>' }),
  );
  assert.ok(result.ok);

  for (const url of ['/demo', `/demo/calls/${id}`]) {
    const response = await app.inject({ url, headers: AUTH });
    assert.ok(!response.body.includes('<script>alert'), url);
    assert.ok(!response.body.includes('<img src=x'), url);
    assert.ok(response.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), url);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(String(response.headers['content-security-policy']), /default-src 'none'/);
  }
  await app.close();
});

test('detail shows saved values, missing fields as "Not captured", and an in-progress call', async () => {
  const { app, store } = await setup();
  const id = store.createCall('CA_TEST', null);
  applyIntakeUpdate(store, id, update({ intent: 'HVAC_SERVICE', issueCategory: 'NO_HEAT', callerName: 'Test Caller' }));

  const detail = await app.inject({ url: `/demo/calls/${id}`, headers: AUTH });
  assert.match(detail.body, /Test Caller/);
  assert.match(detail.body, /<dt>Callback number<\/dt><dd><span class="missing">Not captured<\/span>/);
  assert.match(detail.body, /P3 standard repair/);
  assert.match(detail.body, /Intake in progress/);

  const list = await app.inject({ url: '/demo', headers: AUTH });
  assert.match(list.body, /In progress/);
  assert.match(list.body, new RegExp(`/demo/calls/${id}`));
  assert.equal((await app.inject({ url: '/demo/calls/not-a-call', headers: AUTH })).statusCode, 404);
  await app.close();
});
