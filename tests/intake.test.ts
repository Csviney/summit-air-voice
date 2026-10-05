import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IntakeUpdate } from '../src/contracts.ts';
import { applyIntakeUpdate, finishIntake, mergeFacts, normalizePhone, recordStreamClosed, redactSensitive, saveReadyFollowUp } from '../src/intake.ts';
import { nextStep } from '../src/records.ts';
import { recordCallStatus } from '../src/escalation.ts';
import { openStore, type Store } from '../src/store.ts';
import { ALL_CONFIRMED, CONTACT, facts, update } from './fixtures.ts';

function newCall(store: Store = openStore(':memory:'), callSid = 'CA_TEST') {
  return { store, id: store.createCall(callSid, '+15555550100') };
}

function apply(store: Store, id: string, fields: Parameters<typeof update>[0]) {
  const result = applyIntakeUpdate(store, id, update(fields));
  assert.ok(result.ok, JSON.stringify(result));
  return result.data;
}

test('null and UNKNOWN never erase saved facts; corrections replace them', () => {
  const saved = facts({ callerName: 'Test Caller', issueCategory: 'NO_HEAT', systemImpact: 'PARTIAL' });
  const kept = mergeFacts(saved, update({ systemImpact: 'UNKNOWN' }));
  assert.ok(kept.ok);
  assert.equal(kept.facts.callerName, 'Test Caller');
  assert.equal(kept.facts.systemImpact, 'PARTIAL');

  const corrected = mergeFacts(saved, update({ systemImpact: 'COMPLETE_OUTAGE' }));
  assert.ok(corrected.ok);
  assert.equal(corrected.facts.systemImpact, 'COMPLETE_OUTAGE');
});

test('address updates merge by field, and changing a detail clears only its own confirmation', () => {
  const confirmed = facts({
    callerName: 'Test Caller',
    address: { line1: '100 Example St', unit: null, city: 'Raleigh', state: 'NC', postalCode: null, county: null },
    ...ALL_CONFIRMED,
  });
  const merged = mergeFacts(confirmed, update({ address: { line1: null, unit: null, city: null, state: null, postalCode: '27601', county: 'Wake' } }));
  assert.ok(merged.ok);
  assert.equal(merged.facts.address?.line1, '100 Example St');
  assert.equal(merged.facts.address?.county, 'Wake');
  assert.equal(merged.facts.addressConfirmed, false);
  assert.equal(merged.facts.nameConfirmed, true, 'the name was not touched');
  assert.equal(merged.facts.detailsConfirmed, false);

  const unchanged = mergeFacts(confirmed, update({ availabilityNotes: 'Mornings' }));
  assert.ok(unchanged.ok);
  assert.equal(unchanged.facts.detailsConfirmed, true);

  // A correction cannot be confirmed in the same update; the new value needs a read-back.
  const correctedAndClaimed = mergeFacts(confirmed, update({ callerName: 'Corrected Name', detailsConfirmed: true }));
  assert.ok(correctedAndClaimed.ok);
  assert.equal(correctedAndClaimed.facts.detailsConfirmed, false);
});

test('callback numbers are normalized or rejected, never guessed', () => {
  assert.equal(normalizePhone('(919) 555-0100'), '+19195550100');
  assert.equal(normalizePhone('1 919 555 0100'), '+19195550100');
  assert.equal(normalizePhone('555-0100'), null);
  // The bad number is dropped and reported; the rest of the update still saves.
  const result = mergeFacts(facts({}), update({ callbackPhone: '555-0100', callerName: 'Test Caller' }));
  assert.ok(result.ok);
  assert.deepEqual(result.rejected, ['callbackPhone']);
  assert.equal(result.facts.callbackPhone, null);
  assert.equal(result.facts.callerName, 'Test Caller');
});

test('a hazard is saved and triaged even when the same update has an invalid phone number', () => {
  const { store, id } = newCall();
  const status = apply(store, id, { safetySignals: ['GAS_ODOR'], callbackPhone: '555-01', triageEvidence: 'Smells gas now' });
  assert.equal(status.priorityTier, 'P0');
  assert.equal(status.nextAction, 'EMERGENCY_GUIDANCE');
  assert.deepEqual(status.rejectedFields, ['callbackPhone']);
  assert.equal(store.getRequestForCall(id)?.priorityTier, 'P0');
});

test('sensitive values are redacted from saved free text', () => {
  assert.equal(redactSensitive('card 4111 1111 1111 1111 please'), 'card [redacted number] please');
  assert.equal(redactSensitive('ssn 123-45-6789'), 'ssn [redacted number]');
  assert.equal(redactSensitive('my password is hunter2!'), 'my password [redacted]');
  assert.equal(redactSensitive('call 919-555-0100 after 5'), 'call 919-555-0100 after 5');
  const merged = mergeFacts(
    facts({}),
    update({
      issueSummary: 'AC out, card 4111111111111111',
      callerName: 'Test Caller 4111 1111 1111 1111',
      address: { line1: '100 Example St, ssn 123-45-6789', unit: null, city: null, state: null, postalCode: null, county: null },
    }),
  );
  assert.ok(merged.ok);
  assert.equal(merged.facts.issueSummary, 'AC out, card [redacted number]');
  assert.equal(merged.facts.callerName, 'Test Caller [redacted number]');
  assert.equal(merged.facts.address?.line1, '100 Example St, ssn [redacted number]');
});

test('the tool input rejects extra fields, so the model cannot pick priority or status', () => {
  assert.equal(IntakeUpdate.safeParse({ ...update({}), priorityTier: 'P0' }).success, false);
  assert.equal(IntakeUpdate.safeParse({ ...update({}), status: 'BOOKED' }).success, false);
});

test('P4 routine maintenance ends as a saved follow-up', () => {
  const { store, id } = newCall();
  apply(store, id, { ...CONTACT, issueCategory: 'MAINTENANCE', issueSummary: 'Annual tune-up' });
  const status = apply(store, id, { safetySignals: [], detailsConfirmed: true });
  assert.equal(status.priorityTier, 'P4');
  assert.equal(status.nextAction, 'SAVE_FOLLOW_UP');

  const finished = finishIntake(store, id, false);
  assert.ok(finished.ok);
  const record = store.getRecord(id)!;
  assert.equal(record.request?.status, 'FOLLOW_UP_PENDING');
  assert.equal(record.request?.followUpReason, 'NONURGENT');
  assert.equal(record.session.outcome, 'FOLLOW_UP');
  assert.equal(nextStep(record).code, 'FOLLOW_UP_SAVED');
  assert.match(record.session.summary, /P4 routine/);
});

test('"just mark me urgent" changes nothing without evidence', () => {
  const { store, id } = newCall();
  const status = apply(store, id, {
    ...CONTACT,
    issueCategory: 'THERMOSTAT',
    safetySignals: [],
    triageEvidence: 'Caller asked to be marked urgent',
  });
  assert.equal(status.priorityTier, 'P3');
});

test('P2 outage finished without an agreed time ends as an urgent follow-up', () => {
  const { store, id } = newCall();
  apply(store, id, { ...CONTACT, issueCategory: 'NO_COOLING', systemImpact: 'COMPLETE_OUTAGE' });
  const status = apply(store, id, { safetySignals: [], vulnerableOccupants: [], temperatureRisk: 'NONE_REPORTED', detailsConfirmed: true });
  assert.equal(status.priorityTier, 'P2');
  assert.equal(status.serviceAreaStatus, 'IN_AREA');
  assert.equal(status.nextAction, 'AGREE_VISIT_TIME');

  finishIntake(store, id, false);
  const record = store.getRecord(id)!;
  assert.equal(record.request?.followUpReason, 'URGENT_NOT_BOOKED');
  assert.equal(nextStep(record).code, 'URGENT_FOLLOW_UP');
});

test('finishing incomplete, out-of-area, declined, or emergency intake never signals ready for scheduling', () => {
  for (const kind of ['incomplete', 'unconfirmed', 'out-of-area', 'declined', 'emergency', 'uncertain']) {
    const { store, id } = newCall();
    apply(store, id, { ...CONTACT, issueCategory: 'MAINTENANCE', safetySignals: [],
      ...(kind === 'incomplete' ? { address: { ...CONTACT.address, postalCode: null } } : {}),
      ...(kind === 'out-of-area' ? { address: { ...CONTACT.address, state: 'CT' } } : {}),
      ...(kind === 'emergency' ? { safetySignals: ['GAS_ODOR'] as const } : {}),
    });
    if (kind !== 'unconfirmed') apply(store, id, { detailsConfirmed: true });
    if (kind === 'uncertain') {
      store.createBooking({ serviceRequestId: store.getRequestForCall(id)!.id, startAt: '2030-01-07T15:00:00.000Z',
        endAt: '2030-01-07T16:00:00.000Z', timezone: 'America/New_York', calendarId: 'test' });
    }
    const result = finishIntake(store, id, kind === 'declined');
    assert.ok(result.ok);
    assert.equal(result.data.followUpReady, false, kind);
  }
});

test('team scheduling readiness still requires saved availability', () => {
  const { store, id } = newCall();
  apply(store, id, { ...CONTACT, availabilityNotes: null, issueCategory: 'NO_COOLING', systemImpact: 'COMPLETE_OUTAGE',
    safetySignals: [], vulnerableOccupants: [], temperatureRisk: 'NONE_REPORTED' });
  apply(store, id, { detailsConfirmed: true });
  const result = finishIntake(store, id, false);
  assert.ok(result.ok);
  assert.equal(result.data.followUpReady, false);
  assert.equal(store.getRequestForCall(id)!.facts.availabilityNotes, null);
  apply(store, id, { availabilityNotes: 'Monday 9 AM–noon; Wednesday 1 PM–4 PM Eastern' });
  const completed = finishIntake(store, id, false);
  assert.ok(completed.ok);
  assert.equal(completed.data.followUpReady, true);
});

test('a fully captured P2 survives an interrupted booking as urgent follow-up, without replacing other outcomes', () => {
  for (const status of ['OPEN', 'CLOSED_UNBOOKED', 'BOOKED', 'ESCALATED'] as const) {
    const { store, id } = newCall();
    apply(store, id, { ...CONTACT, issueCategory: 'NO_COOLING', systemImpact: 'COMPLETE_OUTAGE',
      safetySignals: [], vulnerableOccupants: [], temperatureRisk: 'NONE_REPORTED' });
    apply(store, id, { detailsConfirmed: true });
    store.setRequestStatus(store.getRequestForCall(id)!.id, status, null);
    recordStreamClosed(store, id);
    const record = store.getRecord(id)!;
    assert.equal(record.request!.status, status === 'OPEN' ? 'FOLLOW_UP_PENDING' : status);
    if (status === 'OPEN') {
      assert.equal(record.session.outcome, 'FOLLOW_UP');
      assert.equal(record.request!.facts.availabilityNotes, CONTACT.availabilityNotes);
    }
  }
});

test('fallback preserves uncertainty while a booking may still exist', () => {
  const { store, id } = newCall();
  apply(store, id, { ...CONTACT, issueCategory: 'NO_COOLING', systemImpact: 'COMPLETE_OUTAGE',
    safetySignals: [], vulnerableOccupants: [], temperatureRisk: 'NONE_REPORTED' });
  apply(store, id, { detailsConfirmed: true });
  const { booking } = store.createBooking({ serviceRequestId: store.getRequestForCall(id)!.id,
    startAt: '2030-01-07T15:00:00.000Z', endAt: '2030-01-07T16:00:00.000Z',
    timezone: 'America/New_York', calendarId: 'test-calendar' });
  store.updateBooking(booking.id, { status: 'UNKNOWN' });
  assert.equal(saveReadyFollowUp(store, id), 'UNCERTAIN');
  assert.equal(store.getRecord(id)!.booking!.status, 'UNKNOWN');
  recordStreamClosed(store, id);
  assert.equal(store.getRecord(id)!.session.outcome, 'FOLLOW_UP');
});

test('a final status callback arriving before stream close also saves qualified follow-up', () => {
  const { store, id } = newCall();
  apply(store, id, { ...CONTACT, issueCategory: 'NO_COOLING', systemImpact: 'COMPLETE_OUTAGE',
    safetySignals: [], vulnerableOccupants: [], temperatureRisk: 'NONE_REPORTED' });
  apply(store, id, { detailsConfirmed: true });
  recordCallStatus(store, 'CA_TEST', 'completed');
  recordStreamClosed(store, id);
  assert.equal(store.getRecord(id)!.session.outcome, 'FOLLOW_UP');
});

test('P1 stays latched after a correction and cannot be closed as declined', () => {
  const { store, id } = newCall();
  const p1 = apply(store, id, { intent: 'HVAC_SERVICE', issueCategory: 'NO_HEAT', systemImpact: 'COMPLETE_OUTAGE', vulnerableOccupants: ['ELDERLY'] });
  assert.equal(p1.nextAction, 'TRANSFER_TO_HUMAN');
  const corrected = apply(store, id, { vulnerableOccupants: [] });
  assert.equal(corrected.priorityTier, 'P1');

  finishIntake(store, id, true);
  const record = store.getRecord(id)!;
  assert.equal(record.request?.status, 'FOLLOW_UP_PENDING');
  assert.equal(record.request?.followUpReason, 'TRANSFER_NOT_ATTEMPTED');
  assert.equal(record.session.outcome, 'FOLLOW_UP');
});

test('a hazard reported after finishing upgrades the saved disposition immediately', () => {
  const { store, id } = newCall();
  apply(store, id, { ...CONTACT, issueCategory: 'MAINTENANCE', safetySignals: [], detailsConfirmed: true });
  finishIntake(store, id, false);
  const status = apply(store, id, { safetySignals: ['GAS_ODOR'], triageEvidence: 'Smells gas right now' });
  assert.equal(status.priorityTier, 'P0');
  assert.equal(status.nextAction, 'EMERGENCY_GUIDANCE');

  // Even if the caller hangs up now, the upgraded follow-up is already saved.
  recordStreamClosed(store, id);
  const record = store.getRecord(id)!;
  assert.equal(record.request?.status, 'FOLLOW_UP_PENDING');
  assert.equal(record.request?.followUpReason, 'EMERGENCY_REPORTED');
  assert.equal(record.session.outcome, 'FOLLOW_UP');
});

test('a declined caller who then reports danger becomes an urgent follow-up', () => {
  const { store, id } = newCall();
  apply(store, id, { intent: 'HVAC_SERVICE', issueCategory: 'MAINTENANCE' });
  finishIntake(store, id, true);
  apply(store, id, { safetySignals: ['CO_CONCERN'] });
  const record = store.getRecord(id)!;
  assert.equal(record.request?.status, 'FOLLOW_UP_PENDING');
  assert.equal(record.session.outcome, 'FOLLOW_UP');
});

test('empty or repeated updates after finishing keep the saved disposition untouched', () => {
  const { store, id } = newCall();
  apply(store, id, { ...CONTACT, issueCategory: 'MAINTENANCE', safetySignals: [], detailsConfirmed: true });
  finishIntake(store, id, false);
  const before = store.getRecord(id)!;

  apply(store, id, {});
  apply(store, id, { issueCategory: 'MAINTENANCE', callerName: 'Test Caller' });
  recordStreamClosed(store, id);
  const after = store.getRecord(id)!;
  assert.equal(after.request?.status, 'FOLLOW_UP_PENDING');
  assert.equal(after.request?.updatedAt, before.request?.updatedAt);
  assert.equal(after.session.outcome, 'FOLLOW_UP');
});

test('a caller who declines a nonurgent request is closed, not left as follow-up', () => {
  const { store, id } = newCall();
  apply(store, id, { intent: 'HVAC_SERVICE', issueCategory: 'MAINTENANCE' });
  finishIntake(store, id, true);
  const record = store.getRecord(id)!;
  assert.equal(record.request?.status, 'CLOSED_UNBOOKED');
  assert.equal(nextStep(record).code, 'DECLINED');
});

test('partial intake survives a hangup and a restart as an incomplete call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'summit-air-'));
  try {
    const path = join(dir, 'test.db');
    const first = newCall(openStore(path), 'CA_ENDED');
    apply(first.store, first.id, { intent: 'HVAC_SERVICE', callerName: 'Test Caller', issueCategory: 'NO_HEAT' });
    recordStreamClosed(first.store, first.id);
    const active = first.store.createCall('CA_CRASHED', null);
    apply(first.store, active, { intent: 'HVAC_SERVICE', temperatureRisk: 'UNSAFE_COLD' });
    first.store.close();

    const reopened = openStore(path);
    assert.deepEqual(reopened.recoverStaleCalls(), [active]);
    const ended = reopened.getRecord(first.id)!;
    assert.equal(ended.session.outcome, 'INCOMPLETE');
    assert.equal(ended.request?.facts.callerName, 'Test Caller');
    const crashed = reopened.getRecord(active)!;
    assert.equal(crashed.session.status, 'ENDED');
    assert.equal(crashed.request?.priorityTier, 'P1');
    assert.equal(nextStep(crashed).code, 'INCOMPLETE_URGENT');
    assert.match(crashed.session.summary, /^Call from an unnamed caller/);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
