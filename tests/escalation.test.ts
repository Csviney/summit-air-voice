import assert from 'node:assert/strict';
import { test } from 'node:test';
import twilio from 'twilio';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import {
  escalateCall,
  recordCallStatus,
  recordDialResult,
  type CallControl,
  type KnownCall,
} from '../src/escalation.ts';
import { applyIntakeUpdate, finishIntake, recordStreamClosed } from '../src/intake.ts';
import { nextStep } from '../src/records.ts';
import { openStore, type Store } from '../src/store.ts';
import { PROVIDER_TEST_ENV, update } from './fixtures.ts';

const env = {
  OPENAI_API_KEY: 'test-openai-key',
  OPENAI_REALTIME_MODEL: 'test-realtime-model',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  TWILIO_PUBLIC_BASE_URL: 'https://summit.example.test',
  DEMO_PASSWORD: 'test-demo-password',
  ...PROVIDER_TEST_ENV,
};
const config = loadConfig(env);
const CALL_SID = 'CA_ESCALATION_TEST';

/** Records every redirect instead of calling Twilio; `fail` simulates a provider error. */
function fakeCalls(fail = false) {
  const redirects: Array<{ callSid: string; twiml: string }> = [];
  const calls: CallControl = {
    async redirect(callSid, twiml) {
      if (fail) throw new Error('simulated Twilio failure');
      redirects.push({ callSid, twiml });
    },
  };
  return { calls, redirects };
}

function callAt(fields: Parameters<typeof update>[0], store: Store = openStore(':memory:')) {
  const id = store.createCall(CALL_SID, null);
  const result = applyIntakeUpdate(store, id, update({ intent: 'HVAC_SERVICE', ...fields }));
  assert.ok(result.ok);
  return { store, id };
}

const known = (id: string, priority: KnownCall['priority'] = null): KnownCall => ({
  callSessionId: id,
  callSid: CALL_SID,
  priority,
});

const P0 = { safetySignals: ['GAS_ODOR' as const], triageEvidence: 'Smells gas now' };
const P1 = { issueCategory: 'NO_HEAT' as const, systemImpact: 'COMPLETE_OUTAGE' as const, vulnerableOccupants: ['ELDERLY' as const] };

test('P0 plays server-scripted guidance and hangs up without dialing anyone', async () => {
  const { store, id } = callAt(P0);
  const { calls, redirects } = fakeCalls();
  const result = await escalateCall({ store, calls, config }, known(id));
  assert.deepEqual(result, { ok: true, data: { type: 'EMERGENCY_GUIDANCE', status: 'GUIDANCE_ISSUED' } });

  assert.equal(redirects.length, 1);
  const { callSid, twiml } = redirects[0]!;
  assert.equal(callSid, CALL_SID);
  assert.match(twiml, /Leave the building now\. Do not use flames, lighters, or light switches\. Call 911 from outside\./);
  assert.match(twiml, /<Hangup\/>/);
  assert.doesNotMatch(twiml, /<Dial/);
  assert.doesNotMatch(twiml, /(dispatched|on the way|we called|have called)/i);

  // The scripted guidance is transcribed as a SYSTEM line.
  const systemTurn = store.getRecord(id)!.session.transcript.find((t) => t.speaker === 'SYSTEM');
  assert.match(systemTurn?.text ?? '', /Leave the building now/);

  // The redirect closes the media stream; the guidance outcome survives it.
  recordStreamClosed(store, id);
  const record = store.getRecord(id)!;
  assert.equal(record.session.outcome, 'EMERGENCY_GUIDANCE');
  assert.equal(record.session.status, 'ENDED');
  assert.equal(record.request?.status, 'ESCALATED');
  assert.equal(nextStep(record).code, 'EMERGENCY_GUIDANCE_ISSUED');
});

test('P1 announces the transfer and dials only the configured number', async () => {
  const { store, id } = callAt(P1);
  const { calls, redirects } = fakeCalls();
  const result = await escalateCall({ store, calls, config }, known(id));
  assert.deepEqual(result, { ok: true, data: { type: 'HUMAN_TRANSFER', status: 'INITIATED' } });

  const { twiml } = redirects[0]!;
  assert.match(twiml, /Because this sounds urgent, I'm transferring you to a human representative now\./);
  assert.match(twiml, /<Say voice="Polly\.Joanna-Neural">/);
  assert.match(twiml, /<Dial [^>]*callerId="\+15555550100"/);
  assert.match(twiml, /action="https:\/\/summit\.example\.test\/twilio\/dial-result\?escalationId=[0-9a-f-]{36}"/);
  assert.match(twiml, /<Number>\+15555550199<\/Number>/);

  // The stream ends with the redirect, but the phone call continues into the transfer.
  recordStreamClosed(store, id);
  const record = store.getRecord(id)!;
  assert.equal(record.session.status, 'TRANSFERRING');
  assert.equal(record.session.outcome, null);
  assert.equal(nextStep(record).code, 'TRANSFER_ATTEMPTED');
});

test('repeated escalate_call calls never redirect or dial twice', async () => {
  const { store, id } = callAt(P1);
  const { calls, redirects } = fakeCalls();
  await escalateCall({ store, calls, config }, known(id));
  const again = await escalateCall({ store, calls, config }, known(id));
  assert.deepEqual(again, { ok: true, data: { type: 'HUMAN_TRANSFER', status: 'INITIATED' } });
  assert.equal(redirects.length, 1);
  assert.equal(store.getRecord(id)!.escalations.length, 1);
});

test('non-critical tiers cannot escalate', async () => {
  for (const fields of [
    { issueCategory: 'NO_COOLING' as const, systemImpact: 'COMPLETE_OUTAGE' as const },
    { issueCategory: 'MAINTENANCE' as const },
    {},
  ]) {
    const { store, id } = callAt(fields);
    const { calls, redirects } = fakeCalls();
    const result = await escalateCall({ store, calls, config }, known(id));
    assert.equal(!result.ok && result.code, 'NOT_ESCALATABLE');
  // Allow the agent to save a reported hazard and retry.
    assert.equal(!result.ok && result.retryable, true);
    assert.equal(redirects.length, 0);
  }
});

test('a connected transfer is recorded as transferred, and repeated callbacks keep the first result', async () => {
  const { store, id } = callAt(P1);
  await escalateCall({ store, calls: fakeCalls().calls, config }, known(id));
  const escalationId = store.getRecord(id)!.escalations[0]!.id;

  const twiml = recordDialResult(store, escalationId, { DialCallStatus: 'completed', DialCallSid: 'CA_CHILD' });
  assert.equal(twiml, '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  recordDialResult(store, escalationId, { DialCallStatus: 'no-answer' });

  const record = store.getRecord(id)!;
  assert.equal(record.escalations[0]!.status, 'CONNECTED');
  assert.equal(record.escalations[0]!.twilioChildCallSid, 'CA_CHILD');
  assert.equal(record.session.outcome, 'TRANSFERRED');
  assert.equal(record.session.status, 'ENDED');
  assert.equal(nextStep(record).code, 'TRANSFER_CONNECTED');
});

for (const [dialStatus, expected] of [
  ['no-answer', 'NO_ANSWER'],
  ['busy', 'BUSY'],
  ['failed', 'FAILED'],
  ['canceled', 'FAILED'],
] as const) {
  test(`a ${dialStatus} transfer tells the caller the truth and saves an urgent follow-up`, async () => {
    const { store, id } = callAt(P1);
    await escalateCall({ store, calls: fakeCalls().calls, config }, known(id));
    const escalationId = store.getRecord(id)!.escalations[0]!.id;

    const twiml = recordDialResult(store, escalationId, { DialCallStatus: dialStatus });
    assert.match(twiml, /couldn't connect you to a representative/);
    assert.match(twiml, /no visit has been booked/);
    assert.match(twiml, /<Hangup\/>/);

    const record = store.getRecord(id)!;
    assert.equal(record.escalations[0]!.status, expected);
    assert.equal(record.request?.status, 'FOLLOW_UP_PENDING');
    assert.equal(record.request?.followUpReason, 'TRANSFER_FAILED');
    assert.equal(record.request?.priorityTier, 'P1');
    assert.equal(record.session.outcome, 'FOLLOW_UP');
    assert.equal(nextStep(record).code, 'URGENT_FOLLOW_UP_AFTER_FAILURE');
  });
}

test('a failed redirect keeps the call with the agent and records an urgent follow-up', async () => {
  const p1 = callAt(P1);
  const failedTransfer = await escalateCall({ store: p1.store, calls: fakeCalls(true).calls, config }, known(p1.id));
  assert.equal(!failedTransfer.ok && failedTransfer.code, 'ESCALATION_FAILED');
  assert.match(!failedTransfer.ok ? failedTransfer.message : '', /couldn't connect you to a representative/);
  const transferRecord = p1.store.getRecord(p1.id)!;
  assert.equal(transferRecord.escalations[0]!.status, 'FAILED');
  assert.equal(transferRecord.request?.followUpReason, 'TRANSFER_FAILED');
  assert.equal(transferRecord.session.status, 'ACTIVE');

  // For P0 the agent is told to speak the same server-authored guidance itself.
  const p0 = callAt(P0);
  const failedGuidance = await escalateCall({ store: p0.store, calls: fakeCalls(true).calls, config }, known(p0.id));
  assert.match(!failedGuidance.ok ? failedGuidance.message : '', /Leave the building now/);
  assert.equal(p0.store.getRecord(p0.id)!.request?.followUpReason, 'EMERGENCY_REPORTED');
});

test('a storage failure does not stop the emergency redirect', async () => {
  const { store, id } = callAt(P0);
  const broken: Store = {
    ...store,
    createEscalation: () => {
      throw new Error('disk full');
    },
  };
  const { calls, redirects } = fakeCalls();
  const result = await escalateCall({ store: broken, calls, config }, known(id));
  assert.ok(result.ok);
  assert.equal(redirects.length, 1);
});

test('a call that ends before any dial result is unknown, and a late dial result still settles it', async () => {
  const { store, id } = callAt(P1);
  await escalateCall({ store, calls: fakeCalls().calls, config }, known(id));
  recordCallStatus(store, CALL_SID, 'in-progress');
  assert.equal(store.getRecord(id)!.session.status, 'TRANSFERRING');

  recordCallStatus(store, CALL_SID, 'completed');
  let record = store.getRecord(id)!;
  assert.equal(record.escalations[0]!.status, 'INITIATED');
  assert.equal(record.request?.followUpReason, 'TRANSFER_RESULT_UNKNOWN');
  assert.equal(record.session.status, 'ENDED');
  assert.equal(nextStep(record).code, 'TRANSFER_RESULT_UNKNOWN');

  // The authoritative dial result arriving late replaces the uncertainty.
  recordDialResult(store, record.escalations[0]!.id, { DialCallStatus: 'completed', DialCallSid: 'CA_CHILD' });
  record = store.getRecord(id)!;
  assert.equal(record.escalations[0]!.status, 'CONNECTED');
  assert.equal(record.request?.status, 'ESCALATED');
  assert.equal(record.request?.followUpReason, null);
  assert.equal(record.session.outcome, 'TRANSFERRED');
  assert.equal(nextStep(record).code, 'TRANSFER_CONNECTED');
});

/** A redirect that waits until the test releases it, to simulate a slow Twilio request. */
function slowCalls(fail = false) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const redirects: string[] = [];
  const calls: CallControl = {
    async redirect(_callSid, twiml) {
      redirects.push(twiml);
      if (redirects.length === 1) await gate;
      if (fail) throw new Error('simulated Twilio failure');
    },
  };
  return { calls, redirects, release: () => release() };
}

test('a hazard reported while a transfer is in flight is kept and can supersede it', async () => {
  const { store, id } = callAt(P1);
  const slow = slowCalls();
  const transfer = escalateCall({ store, calls: slow.calls, config }, known(id));

  const hazard = applyIntakeUpdate(store, id, update({ safetySignals: ['GAS_ODOR'] }));
  assert.ok(hazard.ok, 'updates are accepted during a pending transfer');
  assert.equal(hazard.data.nextAction, 'EMERGENCY_GUIDANCE');
  slow.release();
  await transfer;

  const request = store.getRequestForCall(id)!;
  assert.deepEqual(request.facts.safetySignals, ['GAS_ODOR']);
  assert.equal(request.priorityTier, 'P0');

  const guidance = await escalateCall({ store, calls: slow.calls, config }, known(id));
  assert.deepEqual(guidance, { ok: true, data: { type: 'EMERGENCY_GUIDANCE', status: 'GUIDANCE_ISSUED' } });
  assert.match(slow.redirects[1]!, /Leave the building now/);
});

test('a hazard reported after the transfer started is saved and escalates to guidance', async () => {
  const { store, id } = callAt(P1);
  const { calls, redirects } = fakeCalls();
  await escalateCall({ store, calls, config }, known(id));
  assert.equal(store.getRequestForCall(id)!.status, 'ESCALATED');

  const hazard = applyIntakeUpdate(store, id, update({ safetySignals: ['FIRE_SMOKE'] }));
  assert.ok(hazard.ok, 'an escalated request still accepts a new hazard');
  assert.equal(hazard.data.priorityTier, 'P0');
  const guidance = await escalateCall({ store, calls, config }, known(id));
  assert.ok(guidance.ok);
  assert.match(redirects[1]!.twiml, /Get everyone out now/);
});

test('the transfer is recorded before redirecting, so an early stream close does not end the call', async () => {
  const { store, id } = callAt(P1);
  const slow = slowCalls();
  const transfer = escalateCall({ store, calls: slow.calls, config }, known(id));
  recordStreamClosed(store, id);
  assert.equal(store.getRecord(id)!.session.status, 'TRANSFERRING');
  slow.release();
  await transfer;
  const record = store.getRecord(id)!;
  assert.equal(record.session.status, 'TRANSFERRING');
  assert.equal(record.session.endedAt, null);
});

test('a failed redirect after the call already ended does not reopen it', async () => {
  const { store, id } = callAt(P1);
  const slow = slowCalls(true);
  const transfer = escalateCall({ store, calls: slow.calls, config }, known(id));
  recordCallStatus(store, CALL_SID, 'completed');
  slow.release();
  const result = await transfer;
  assert.equal(!result.ok && result.code, 'ESCALATION_FAILED');
  const record = store.getRecord(id)!;
  assert.equal(record.session.status, 'ENDED');
  assert.equal(record.request?.followUpReason, 'TRANSFER_FAILED');
});

test('repeating a failed escalation returns the failure again without redialing', async () => {
  const { store, id } = callAt(P1);
  const { calls } = fakeCalls(true);
  let attempts = 0;
  const counting: CallControl = { redirect: (...args) => (attempts++, calls.redirect(...args)) };
  await escalateCall({ store, calls: counting, config }, known(id));
  const again = await escalateCall({ store, calls: counting, config }, known(id));
  assert.equal(!again.ok && again.code, 'ESCALATION_FAILED');
  assert.match(!again.ok ? again.message : '', /has been saved as urgent/);
  assert.equal(attempts, 1);
});

test('emergency guidance still plays from the cached priority when the database cannot be read', async () => {
  const { store, id } = callAt(P0);
  const broken: Store = {
    ...store,
    getRequestForCall: () => {
      throw new Error('database locked');
    },
  };
  const { calls, redirects } = fakeCalls();
  const result = await escalateCall(
    { store: broken, calls, config },
    known(id, { tier: 'P0', reasons: ['SAFETY_GAS_ODOR'] }),
  );
  assert.ok(result.ok);
  assert.match(redirects[0]!.twiml, /Leave the building now/);
  // Without saved state it cannot claim to have saved anything.
  const { calls: failing } = fakeCalls(true);
  const p1 = await escalateCall(
    { store: broken, calls: failing, config },
    known(id, { tier: 'P1', reasons: ['UNSAFE_INDOOR_TEMPERATURE'] }),
  );
  assert.match(!p1.ok ? p1.message : '', /wasn't able to save your request/);
});

test('a failed dial whose follow-up cannot be saved does not claim it was saved', () => {
  const store = openStore(':memory:');
  const broken: Store = {
    ...store,
    getEscalation: () => {
      throw new Error('database locked');
    },
  };
  const twiml = recordDialResult(broken, 'some-escalation', { DialCallStatus: 'no-answer' });
  assert.match(twiml, /wasn't able to save your request/);
  assert.doesNotMatch(twiml, /has been saved/);
});

test('P1 finished without escalating keeps a truthful urgent follow-up', () => {
  const { store, id } = callAt(P1);
  finishIntake(store, id, false);
  const record = store.getRecord(id)!;
  assert.equal(record.request?.followUpReason, 'TRANSFER_NOT_ATTEMPTED');
  assert.equal(nextStep(record).code, 'URGENT_FOLLOW_UP');
});

test('dial-result and status callbacks require a valid Twilio signature', async () => {
  const { store, id } = callAt(P1);
  const app = await buildApp(config, store, { calls: fakeCalls().calls, startCall: () => {} });
  await escalateCall({ store, calls: fakeCalls().calls, config }, known(id));
  const escalationId = store.getRecord(id)!.escalations[0]!.id;
  const path = `/twilio/dial-result?escalationId=${escalationId}`;
  const params = { CallSid: CALL_SID, DialCallStatus: 'busy' };
  const post = (url: string, signature?: string) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(signature ? { 'x-twilio-signature': signature } : {}),
      },
      payload: new URLSearchParams(params).toString(),
    });

  assert.equal((await post(path)).statusCode, 403);
  assert.equal((await post('/twilio/status')).statusCode, 403);
  // The signature covers the query string, so a different escalation ID is rejected.
  const signed = twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, `https://summit.example.test${path}`, params);
  assert.equal((await post('/twilio/dial-result?escalationId=other', signed)).statusCode, 403);
  assert.equal(store.getRecord(id)!.escalations[0]!.status, 'INITIATED');

  const accepted = await post(path, signed);
  assert.equal(accepted.statusCode, 200);
  assert.match(accepted.body, /couldn't connect you/);
  assert.equal(store.getRecord(id)!.escalations[0]!.status, 'BUSY');
  await app.close();
});

test('a booking still unconfirmed after a recheck can be handed to a representative, with its own wording', async () => {
  const { store, id } = callAt({ issueCategory: 'NO_COOLING', systemImpact: 'COMPLETE_OUTAGE' });
  const request = store.getRequestForCall(id)!;
  const { booking } = store.createBooking({
    serviceRequestId: request.id,
    startAt: '2030-01-07T15:00:00.000Z',
    endAt: '2030-01-07T16:00:00.000Z',
    timezone: 'America/New_York',
    calendarId: 'test',
  });
  const { calls, redirects } = fakeCalls();
  // Not allowed while the booking is merely pending.
  const pending = await escalateCall({ store, calls, config }, known(id));
  assert.equal(!pending.ok && pending.code, 'NOT_ESCALATABLE');

  store.updateBooking(booking.id, { status: 'UNKNOWN' });
  const result = await escalateCall({ store, calls, config }, known(id));
  assert.deepEqual(result, { ok: true, data: { type: 'HUMAN_TRANSFER', status: 'INITIATED' } });
  assert.match(redirects[0]!.twiml, /Connecting you to a representative now\./);

  // A failed transfer must preserve uncertainty about whether the booking exists.
  const escalationId = store.getRecord(id)!.escalations[0]!.id;
  const twiml = recordDialResult(store, escalationId, { DialCallStatus: 'no-answer' });
  assert.match(twiml, /couldn't confirm whether your visit was booked\. Your request has been saved for our team to review\./);
  assert.doesNotMatch(twiml, /no visit has been booked|urgent/);
});

test('a caller who asked twice for a person gets a non-urgent failure message if nobody answers', async () => {
  const { store, id } = callAt({ issueCategory: 'THERMOSTAT' });
  const request = store.getRequestForCall(id)!;
  store.saveRequest({ ...request, facts: { ...request.facts, humanRequests: 2 } });
  await escalateCall({ store, calls: fakeCalls().calls, config }, known(id));
  const record = store.getRecord(id)!;
  assert.deepEqual(record.escalations[0]!.reasonCodes, ['CALLER_REQUESTED_HUMAN']);
  const twiml = recordDialResult(store, record.escalations[0]!.id, { DialCallStatus: 'busy' });
  assert.match(twiml, /Your request has been saved for our team to review/);
  assert.doesNotMatch(twiml, /urgent|911/);
  assert.equal(nextStep(store.getRecord(id)!).code, 'FOLLOW_UP_AFTER_FAILED_TRANSFER');
});
