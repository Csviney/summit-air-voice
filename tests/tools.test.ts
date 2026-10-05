import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunContext } from '@openai/agents';
import { loadConfig } from '../src/config.ts';
import { intakeValidationIssues } from '../src/contracts.ts';
import { openStore, type Store } from '../src/store.ts';
import type { CalendarClient } from '../src/calendar.ts';
import { createTools, type CallContext } from '../src/voice/tools.ts';
import { CONTACT, UNUSED_CALENDAR, PROVIDER_TEST_ENV, update } from './fixtures.ts';

const config = loadConfig({
  OPENAI_API_KEY: 'test-openai-key',
  OPENAI_REALTIME_MODEL: 'test-realtime-model',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  TWILIO_PUBLIC_BASE_URL: 'https://summit.example.test',
  DEMO_PASSWORD: 'test-demo-password',
  ...PROVIDER_TEST_ENV,
});

function tools(store: Store, context: CallContext, calendar: CalendarClient = UNUSED_CALENDAR) {
  const redirects: string[] = [];
  const [updateIntake, finish, escalate, book, find] = createTools({
    store,
    config,
    calendar,
    calls: { redirect: async (_sid, twiml) => void redirects.push(twiml) },
  });
  const run = new RunContext(context);
  const invoke = async (tool: typeof updateIntake, input: object) => {
    const output = await tool!.invoke(run as never, JSON.stringify(input));
    // Input the SDK rejects comes back as plain text rather than a tool result.
    if (typeof output === 'string' && !output.startsWith('{')) return { ok: false, rejected: output };
    return (typeof output === 'string' ? JSON.parse(output) : output) as Record<string, any>;
  };
  return {
    updateIntake: (input: object) => invoke(updateIntake, input),
    finish: (callerDeclined = false) => invoke(finish, { callerDeclined }),
    escalate: () => invoke(escalate, {}),
    book: (input: object) => invoke(book, input),
    find: (input: object) => invoke(find, input),
    redirects,
  };
}

test('a hazard still gets emergency handling when saving fails, without claiming a save', async () => {
  const store = openStore(':memory:');
  const id = store.createCall('CA_TOOLS', null);
  const broken: Store = {
    ...store,
    getRequestForCall: () => {
      throw new Error('database locked');
    },
  };
  const context: CallContext = { call: { callSessionId: id, callSid: 'CA_TOOLS', priority: null, finishedAt: null, handedOff: false, agentMuted: false, ended: false, callerTurn: 0, humanAskTurn: null, proposedVisit: null } };
  const call = tools(broken, context);

  const result = await call.updateIntake(update({ safetySignals: ['CO_CONCERN'] }));
  assert.equal(result.ok, true);
  assert.equal(result.data.nextAction, 'EMERGENCY_GUIDANCE');
  assert.equal(result.data.saved, false);

  const escalated = await call.escalate();
  assert.equal(escalated.ok, true);
  assert.match(call.redirects[0]!, /fresh air/);
});

test('a non-urgent update during a storage failure reports the failure honestly', async () => {
  const store = openStore(':memory:');
  const id = store.createCall('CA_TOOLS', null);
  const broken: Store = {
    ...store,
    getRequestForCall: () => {
      throw new Error('database locked');
    },
  };
  const call = tools(broken, { call: { callSessionId: id, callSid: 'CA_TOOLS', priority: null, finishedAt: null, handedOff: false, agentMuted: false, ended: false, callerTurn: 0, humanAskTurn: null, proposedVisit: null } });
  const result = await call.updateIntake(update({ issueCategory: 'MAINTENANCE' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STORAGE_ERROR');
});

test('update_intake accepts the partial arguments the realtime model actually sends', async () => {
  const store = openStore(':memory:');
  const id = store.createCall('CA_TOOLS', null);
  const call = tools(store, { call: { callSessionId: id, callSid: 'CA_TOOLS', priority: null, finishedAt: null, handedOff: false, agentMuted: false, ended: false, callerTurn: 0, humanAskTurn: null, proposedVisit: null } });

  // Match a real tool call that omitted unchanged fields and address parts.
  const partial = await call.updateIntake({
    callerName: 'Test Caller',
    callbackPhone: '203-555-0142',
    address: { line1: '1 Example Road', city: 'Hartford', state: 'Connecticut' },
    availabilityNotes: 'Any time works',
  });
  assert.equal(partial.ok, true);
  assert.equal(partial.data.serviceAreaStatus, 'OUT_OF_AREA');
  assert.equal(store.getRequestForCall(id)!.facts.address?.state, 'Connecticut');

  // Fields the model may not set are still rejected.
  const extra = await call.updateIntake({ callerName: 'Test Caller', priorityTier: 'P0' });
  assert.notEqual(extra.ok, true);
  assert.equal(store.getRequestForCall(id)!.priorityTier, null);
});

test('a rejected emergency update can be corrected without losing the safety handoff', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const id = store.createCall('CA_FIRE_VALIDATION', null);
  const context: CallContext = { call: { callSessionId: id, callSid: 'CA_FIRE_VALIDATION', priority: null, finishedAt: null, handedOff: false, agentMuted: false, ended: false, callerTurn: 1, humanAskTurn: null, proposedVisit: null } };
  const call = tools(store, context);
  const invalid = {
    issueCategory: 'FIRE_SMOKE', safetySignals: ['FIRE_SMOKE'], callerName: 'Private Test Caller',
  };
  const rejected = await call.updateIntake(invalid);
  const issues = intakeValidationIssues(JSON.stringify(invalid));
  assert.equal(rejected.code, 'INVALID_INPUT');
  assert.deepEqual(issues, [{ field: 'issueCategory', code: 'invalid_value' }]);
  assert.match(rejected.message, /only safetySignals/);
  assert.equal(store.getRequestForCall(id)!.priorityTier, null);
  assert.doesNotMatch(JSON.stringify({ rejected, issues }), /Private Test Caller/);
  assert.equal((await call.escalate()).code, 'NOT_ESCALATABLE');

  const corrected = await call.updateIntake({ safetySignals: ['FIRE_SMOKE'] });
  assert.equal(corrected.data.nextAction, 'EMERGENCY_GUIDANCE');
  assert.equal((await call.escalate()).data.status, 'GUIDANCE_ISSUED');
  assert.match(call.redirects[0]!, /Get everyone out now, and call 911 from a safe place/);
  assert.match(call.redirects[0]!, /<Hangup\/>/);
  assert.doesNotMatch(call.redirects[0]!, /<Dial/);
  assert.equal(context.call.handedOff, true);
});

test('invalid safety signals and injected fields stay rejected, and ended calls cannot retry', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const id = store.createCall('CA_INVALID_SAFETY', null);
  const context: CallContext = { call: { callSessionId: id, callSid: 'CA_INVALID_SAFETY', priority: null, finishedAt: null, handedOff: false, agentMuted: false, ended: false, callerTurn: 1, humanAskTurn: null, proposedVisit: null } };
  const call = tools(store, context);
  for (const input of [
    { safetySignals: ['private-invalid-value'] },
    { safetySignals: ['FIRE_SMOKE'], 'private-injected-key': 'private-invalid-value' },
    { safetySignals: ['FIRE_SMOKE'], priorityTier: 'P0' },
  ]) {
    const rejected = await call.updateIntake(input);
    assert.equal(rejected.code, 'INVALID_INPUT');
    const issues = intakeValidationIssues(JSON.stringify(input));
    assert.doesNotMatch(JSON.stringify({ rejected, issues }), /private-/);
    assert.equal(store.getRequestForCall(id)!.priorityTier, null);
  }
  assert.deepEqual(intakeValidationIssues('{private-malformed'), [{ field: 'input', code: 'invalid_json' }]);
  assert.deepEqual(intakeValidationIssues('{"safetySignals":["FIRE_SMOKE"]}'), []);
  const none = await call.updateIntake({ safetySignals: [] });
  assert.notEqual(none.data.nextAction, 'EMERGENCY_GUIDANCE');
  assert.equal((await call.escalate()).code, 'NOT_ESCALATABLE');
  context.call.ended = true;
  assert.equal((await call.updateIntake({ safetySignals: ['invalid'] })).code, 'CALL_ENDED');
  assert.equal((await call.updateIntake({ safetySignals: ['FIRE_SMOKE'] })).code, 'CALL_ENDED');
  assert.equal(call.redirects.length, 0);
});

test('tools refuse to act once the caller has hung up', async () => {
  const store = openStore(':memory:');
  const id = store.createCall('CA_TOOLS', null);
  const call = tools(store, { call: { callSessionId: id, callSid: 'CA_TOOLS', priority: null, finishedAt: null, handedOff: false, agentMuted: false, ended: true, callerTurn: 0, humanAskTurn: null, proposedVisit: null } });
  const result = await call.updateIntake({ safetySignals: ['GAS_ODOR'] });
  assert.equal(result.code, 'CALL_ENDED');
  const escalated = await call.escalate();
  assert.equal(escalated.code, 'CALL_ENDED');
  assert.equal(call.redirects.length, 0);
});

test('asking for a person counts once per caller turn, and the second turn leads to a transfer', async () => {
  const store = openStore(':memory:');
  const id = store.createCall('CA_TOOLS', null);
  const context: CallContext = {
    call: { callSessionId: id, callSid: 'CA_TOOLS', priority: null, finishedAt: null, handedOff: false, agentMuted: false, ended: false, callerTurn: 1, humanAskTurn: null, proposedVisit: null },
  };
  const call = tools(store, context);
  await call.updateIntake({ intent: 'HVAC_SERVICE', issueCategory: 'THERMOSTAT', callerAskedForHuman: true });
  // The model saving the same utterance twice must not count as asking twice.
  const sameTurn = await call.updateIntake({ callerAskedForHuman: true });
  assert.notEqual(sameTurn.data.nextAction, 'TRANSFER_TO_HUMAN');
  assert.equal(store.getRequestForCall(id)!.facts.humanRequests, 1);

  context.call.callerTurn = 2;
  const secondTurn = await call.updateIntake({ callerAskedForHuman: true });
  assert.equal(secondTurn.data.nextAction, 'TRANSFER_TO_HUMAN');
  const escalated = await call.escalate();
  assert.equal(escalated.ok, true);
  assert.match(call.redirects[0]!, /Of course\. I'm transferring you to a representative now\./);
});

test('a proposed visit is only booked after the caller speaks again', async () => {
  const store = openStore(':memory:');
  const id = store.createCall('CA_TOOLS', null);
  const context: CallContext = {
    call: { callSessionId: id, callSid: 'CA_TOOLS', priority: null, finishedAt: null, handedOff: false, agentMuted: false, ended: false, callerTurn: 1, humanAskTurn: null, proposedVisit: null },
  };
  let inserts = 0;
  const calendar: CalendarClient = { insertEvent: async () => (inserts++, 'CREATED'), getEvent: async () => null, busyTimes: async () => [] };
  const call = tools(store, context, calendar);
  await call.updateIntake({
    ...CONTACT,
    issueCategory: 'NO_COOLING',
    systemImpact: 'COMPLETE_OUTAGE',
    safetySignals: [],
    vulnerableOccupants: [],
    temperatureRisk: 'NONE_REPORTED',
  });
  await call.updateIntake({ detailsConfirmed: true });

  const startAt = '2030-01-07T10:00:00-05:00';
  const proposed = await call.book({ startAt, callerConfirmed: false });
  assert.equal(proposed.data.status, 'PROPOSED');
  // Confirmation requires another caller turn.
  const sameTurn = await call.book({ startAt, callerConfirmed: true });
  assert.equal(sameTurn.code, 'CONFIRMATION_REQUIRED');
  assert.equal(inserts, 0);

  context.call.callerTurn = 2; // the caller answered
  const booked = await call.book({ startAt, callerConfirmed: true });
  assert.equal(booked.data.status, 'CONFIRMED');
  assert.equal(inserts, 1);
});

async function readyWithoutAvailability(calendar: CalendarClient) {
  const store = openStore(':memory:');
  const id = store.createCall('CA_TIME_SEARCH', null);
  const context: CallContext = { call: { callSessionId: id, callSid: 'CA_TIME_SEARCH', priority: null,
    finishedAt: null, handedOff: false, agentMuted: false, ended: false, callerTurn: 1, humanAskTurn: null, proposedVisit: null } };
  const call = tools(store, context, calendar);
  await call.updateIntake({ ...CONTACT, availabilityNotes: null, issueCategory: 'NO_COOLING',
    systemImpact: 'COMPLETE_OUTAGE', safetySignals: [], vulnerableOccupants: [], temperatureRisk: 'NONE_REPORTED' });
  const last = await call.updateIntake({ detailsConfirmed: true });
  assert.deepEqual(last.data.missing, ['availability']);
  assert.equal(typeof last.data.today, 'string');
  return { store, id, context, call };
}

const availability = { availabilityNotes: 'Monday at 10 AM', windows: [
  { startAt: '2030-01-07T10:00:00-05:00', endAt: '2030-01-07T11:00:00-05:00' },
] };

test('availability is saved and a slot proposed in one call, with separate caller confirmation before booking', async () => {
  let inserts = 0;
  const { store, id, context, call } = await readyWithoutAvailability({
    ...UNUSED_CALENDAR, busyTimes: async () => [], insertEvent: async () => (inserts++, 'CREATED'),
  });
  const result = await call.find(availability);
  assert.equal(result.data.status, 'PROPOSED');
  assert.equal(result.data.startAt, availability.windows[0]!.startAt);
  assert.equal(store.getRequestForCall(id)!.facts.availabilityNotes, availability.availabilityNotes);
  assert.equal(inserts, 0);
  const sameTurn = await call.book({ startAt: result.data.startAt, callerConfirmed: true });
  assert.equal(sameTurn.code, 'CONFIRMATION_REQUIRED');
  context.call.callerTurn++;
  const booked = await call.book({ startAt: result.data.startAt, callerConfirmed: true });
  assert.equal(booked.data.status, 'CONFIRMED');
  assert.equal(inserts, 1);
});

test('a failed availability lookup saves urgent follow-up without pretending a visit was booked', async () => {
  const { store, id, call } = await readyWithoutAvailability(UNUSED_CALENDAR);
  const result = await call.find(availability);
  assert.equal(result.data.status, 'UNAVAILABLE');
  assert.equal(result.data.followUpSaved, true);
  assert.equal(store.getRequestForCall(id)!.status, 'FOLLOW_UP_PENDING');
  assert.equal(store.getRecord(id)!.session.outcome, 'FOLLOW_UP');
  assert.equal(store.getRecord(id)!.booking, null);
});

test('a failed calendar recheck saves a follow-up without sending a booking', async () => {
  let reads = 0;
  const { store, id, context, call } = await readyWithoutAvailability({ ...UNUSED_CALENDAR,
    busyTimes: async () => { if (++reads === 1) return []; throw new Error('calendar unavailable'); },
  });
  const proposal = await call.find(availability);
  context.call.callerTurn++;
  const result = await call.book({ startAt: proposal.data.startAt, callerConfirmed: true });
  assert.equal(result.data.status, 'FAILED');
  assert.equal(result.data.followUpSaved, true);
  assert.equal(store.getRequestForCall(id)!.status, 'FOLLOW_UP_PENDING');
  assert.equal(store.getRecord(id)!.booking, null);
});

test('availability search never bypasses priority checks or saves after hangup', async () => {
  const { store, id, context, call } = await readyWithoutAvailability(UNUSED_CALENDAR);
  await call.updateIntake({ safetySignals: ['GAS_ODOR'] });
  assert.equal((await call.find(availability)).code, 'NOT_BOOKABLE');
  context.call.ended = true;
  assert.equal((await call.find({ ...availability, availabilityNotes: 'Different availability' })).code, 'CALL_ENDED');
  assert.equal(store.getRequestForCall(id)!.facts.availabilityNotes, availability.availabilityNotes);
});

test('follow-up calls finish the full address first, then save days and time ranges without a calendar lookup', async () => {
  for (const issueCategory of ['THERMOSTAT', 'MAINTENANCE']) {
    const store = openStore(':memory:');
    const id = store.createCall('CA_FULL_ADDRESS', null);
    const call = tools(store, { call: { callSessionId: id, callSid: 'CA_FULL_ADDRESS', priority: null,
      finishedAt: null, handedOff: false, agentMuted: false, ended: false, callerTurn: 1, humanAskTurn: null, proposedVisit: null } });
    await call.updateIntake({ ...CONTACT, availabilityNotes: null, address: { line1: '123 Eagle Street' },
      issueCategory, safetySignals: [] });
    await call.updateIntake({ nameConfirmed: true, phoneConfirmed: true });
    const city = await call.updateIntake({ address: { city: 'Raleigh' } });
    assert.deepEqual(city.data.missing, ['address.state', 'address.postalCode', 'address.county']);
    assert.equal(city.data.nextAction, 'COLLECT_DETAILS');
    assert.match(store.getRecord(id)!.session.summary, /Not captured: address/);
    const state = await call.updateIntake({ address: { state: 'NC' } });
    assert.deepEqual(state.data.missing, ['address.postalCode', 'address.county']);
    const zip = await call.updateIntake({ address: { postalCode: '27601' } });
    assert.deepEqual(zip.data.missing, ['address.county']);
    assert.equal((await call.updateIntake({ address: { county: 'Wake' } })).data.nextAction, 'CONFIRM_ADDRESS');
    const confirmed = await call.updateIntake({ addressConfirmed: true });
    assert.equal(confirmed.data.nextAction, 'COLLECT_DETAILS');
    assert.deepEqual(confirmed.data.missing, ['availability']);
    assert.equal(typeof confirmed.data.today, 'string');
    const notes = 'Monday 9 AM–noon; Wednesday 1 PM–4 PM Eastern';
    const available = await call.updateIntake({ availabilityNotes: notes });
    assert.equal(available.data.nextAction, 'SAVE_FOLLOW_UP');
    const finished = await call.finish();
    assert.equal(finished.data.followUpReady, true);
    const record = store.getRecord(id)!;
    assert.equal(record.request!.status, 'FOLLOW_UP_PENDING');
    assert.deepEqual(record.request!.facts.address, { ...CONTACT.address, line1: '123 Eagle Street' });
    assert.equal(record.request!.facts.availabilityNotes, notes);
    assert.equal(record.request!.facts.detailsConfirmed, true);
    assert.equal(record.booking, null);
    assert.match(record.session.summary, /All contact details captured/);
  }
});
