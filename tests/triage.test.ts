import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessPriority, assessServiceArea, latchPriority, planNextStep } from '../src/triage.ts';
import { ALL_CONFIRMED, IN_AREA_ADDRESS, facts } from './fixtures.ts';

const hvac = (fields: Parameters<typeof facts>[0]) => facts({ intent: 'HVAC_SERVICE', ...fields });

test('P0 for any current safety signal, regardless of other facts', () => {
  assert.deepEqual(assessPriority(hvac({ issueCategory: 'MAINTENANCE', safetySignals: ['GAS_ODOR'] })), {
    tier: 'P0',
    reasons: ['SAFETY_GAS_ODOR'],
  });
  // Safety applies even when the request is not HVAC.
  assert.equal(assessPriority(facts({ intent: 'OTHER', safetySignals: ['FIRE_SMOKE'] })).tier, 'P0');
});

test('a denied or unknown hazard is not P0', () => {
  assert.equal(assessPriority(hvac({ issueCategory: 'GAS_ODOR', safetySignals: [] })).tier, 'P3');
  assert.equal(assessPriority(hvac({ issueCategory: 'GAS_ODOR', safetySignals: null })).tier, 'P3');
});

test('P1 for an outage with a vulnerable occupant or dangerous indoor temperature', () => {
  const elderly = hvac({ issueCategory: 'NO_HEAT', systemImpact: 'COMPLETE_OUTAGE', vulnerableOccupants: ['ELDERLY'] });
  assert.deepEqual(assessPriority(elderly), { tier: 'P1', reasons: ['OUTAGE_WITH_VULNERABLE_OCCUPANT'] });
  assert.deepEqual(assessPriority(hvac({ issueCategory: 'NO_COOLING', temperatureRisk: 'UNSAFE_HEAT' })), {
    tier: 'P1',
    reasons: ['UNSAFE_INDOOR_TEMPERATURE'],
  });
  // "Other" occupants and partial outages do not qualify.
  const other = hvac({ systemImpact: 'COMPLETE_OUTAGE', vulnerableOccupants: ['OTHER'] });
  assert.equal(assessPriority(other).tier, 'P2');
  const partial = hvac({ issueCategory: 'NO_HEAT', systemImpact: 'PARTIAL', vulnerableOccupants: ['INFANT'] });
  assert.equal(assessPriority(partial).tier, 'P3');
});

test('P2 for a complete outage or stopped commercial operations; commercial alone is not enough', () => {
  assert.deepEqual(assessPriority(hvac({ issueCategory: 'NO_COOLING', systemImpact: 'COMPLETE_OUTAGE' })), {
    tier: 'P2',
    reasons: ['COMPLETE_OUTAGE'],
  });
  const stopped = hvac({ propertyType: 'COMMERCIAL', issueCategory: 'NO_COOLING', businessImpact: 'OPERATIONS_STOPPED' });
  assert.deepEqual(assessPriority(stopped), { tier: 'P2', reasons: ['COMMERCIAL_OPERATIONS_STOPPED'] });
  const commercialOnly = hvac({ propertyType: 'COMMERCIAL', issueCategory: 'THERMOSTAT', businessImpact: 'DEGRADED' });
  assert.equal(assessPriority(commercialOnly).tier, 'P3');
});

test('P3 for malfunctions, P4 for maintenance, unclassified for unclear or non-HVAC requests', () => {
  assert.equal(assessPriority(hvac({ issueCategory: 'EQUIPMENT_NOISE' })).tier, 'P3');
  assert.equal(assessPriority(hvac({ issueCategory: 'MAINTENANCE' })).tier, 'P4');
  // Maintenance plus reduced performance is a repair.
  assert.equal(assessPriority(hvac({ issueCategory: 'MAINTENANCE', systemImpact: 'PARTIAL' })).tier, 'P3');
  assert.equal(assessPriority(hvac({})).tier, null);
  assert.equal(assessPriority(facts({ intent: 'OTHER', issueCategory: 'OTHER' })).tier, null);
});

test('P0/P1 latch for the call; other tiers follow corrections', () => {
  const p1 = { tier: 'P1' as const, reasons: ['UNSAFE_INDOOR_TEMPERATURE'] };
  assert.deepEqual(latchPriority(p1, { tier: 'P3', reasons: ['STANDARD_REPAIR'] }), p1);
  assert.deepEqual(latchPriority(p1, { tier: null, reasons: [] }), p1);
  assert.equal(latchPriority(p1, { tier: 'P0', reasons: ['SAFETY_GAS_ODOR'] }).tier, 'P0');
  assert.equal(latchPriority({ tier: 'P2', reasons: [] }, { tier: 'P3', reasons: [] }).tier, 'P3');
});

test('service area needs NC and an in-area county; anything else unknown or out', () => {
  assert.equal(assessServiceArea(IN_AREA_ADDRESS), 'IN_AREA');
  assert.equal(assessServiceArea({ ...IN_AREA_ADDRESS, county: 'Durham County', state: 'north carolina' }), 'IN_AREA');
  assert.equal(assessServiceArea({ ...IN_AREA_ADDRESS, county: 'Orange', state: 'CA' }), 'OUT_OF_AREA');
  assert.equal(assessServiceArea({ ...IN_AREA_ADDRESS, county: 'Mecklenburg' }), 'OUT_OF_AREA');
  assert.equal(assessServiceArea({ ...IN_AREA_ADDRESS, state: null }), 'UNKNOWN');
  assert.equal(assessServiceArea(null), 'UNKNOWN');
});

test('next step asks safety first and treats unknown answers as unanswered', () => {
  const noHeat = hvac({ issueCategory: 'NO_HEAT' });
  assert.deepEqual(planNextStep(noHeat, assessPriority(noHeat), 'UNKNOWN'), {
    missing: ['safetySignals', 'systemImpact'],
    nextAction: 'ASK_TRIAGE_QUESTIONS',
  });
  const outage = hvac({ issueCategory: 'NO_HEAT', safetySignals: [], systemImpact: 'COMPLETE_OUTAGE' });
  assert.deepEqual(planNextStep(outage, assessPriority(outage), 'UNKNOWN').missing, [
    'vulnerableOccupants',
    'temperatureRisk',
  ]);
});

test('P2 needs a full confirmed in-area address before a visit time; otherwise it is a follow-up', () => {
  const base = hvac({
    issueCategory: 'NO_COOLING',
    safetySignals: [],
    systemImpact: 'COMPLETE_OUTAGE',
    vulnerableOccupants: [],
    temperatureRisk: 'NONE_REPORTED',
    propertyType: 'RESIDENTIAL',
    callerName: 'Test Caller',
    callbackPhone: '+19195550100',
    address: { ...IN_AREA_ADDRESS, county: null },
    availabilityNotes: 'Tomorrow morning',
  });
  const priority = assessPriority(base);
  assert.deepEqual(planNextStep({ ...base, nameConfirmed: true, phoneConfirmed: true }, priority, 'UNKNOWN'), {
    missing: ['address.county'],
    nextAction: 'COLLECT_DETAILS',
  });
  // Each detail is read back as soon as it is captured: name, then phone, then the address.
  const complete = { ...base, address: IN_AREA_ADDRESS };
  assert.equal(planNextStep(complete, priority, 'IN_AREA').nextAction, 'CONFIRM_NAME');
  assert.equal(planNextStep({ ...complete, nameConfirmed: true }, priority, 'IN_AREA').nextAction, 'CONFIRM_PHONE');
  assert.equal(
    planNextStep({ ...complete, nameConfirmed: true, phoneConfirmed: true }, priority, 'IN_AREA').nextAction,
    'CONFIRM_ADDRESS',
  );
  const confirmed = { ...complete, ...ALL_CONFIRMED };
  assert.equal(planNextStep(confirmed, priority, 'IN_AREA').nextAction, 'AGREE_VISIT_TIME');
  assert.equal(planNextStep(confirmed, priority, 'OUT_OF_AREA').nextAction, 'SAVE_FOLLOW_UP');
});

test('every P2 needs vulnerability and temperature answers, not only outages', () => {
  const stopped = hvac({
    propertyType: 'COMMERCIAL',
    issueCategory: 'NO_COOLING',
    systemImpact: 'PARTIAL',
    businessImpact: 'OPERATIONS_STOPPED',
    safetySignals: [],
    callerName: 'Test Caller',
    callbackPhone: '+19195550100',
    address: IN_AREA_ADDRESS,
    availabilityNotes: 'Today',
    ...ALL_CONFIRMED,
  });
  const priority = assessPriority(stopped);
  assert.equal(priority.tier, 'P2');
  assert.deepEqual(planNextStep(stopped, priority, 'IN_AREA'), {
    missing: ['vulnerableOccupants', 'temperatureRisk'],
    nextAction: 'ASK_TRIAGE_QUESTIONS',
  });
  const answered = { ...stopped, vulnerableOccupants: [], temperatureRisk: 'NONE_REPORTED' as const };
  assert.equal(planNextStep(answered, priority, 'IN_AREA').nextAction, 'AGREE_VISIT_TIME');
});

test('an out-of-area P2 needs a complete postal address and availability, but not county', () => {
  const connecticut = hvac({
    issueCategory: 'NO_COOLING',
    systemImpact: 'COMPLETE_OUTAGE',
    safetySignals: [],
    vulnerableOccupants: [],
    temperatureRisk: 'NONE_REPORTED',
    propertyType: 'RESIDENTIAL',
    callerName: 'Test Caller',
    callbackPhone: '+12035550100',
    address: { line1: '1 Example Rd', unit: null, city: 'Hartford', state: 'CT', postalCode: null, county: null },
    ...ALL_CONFIRMED,
  });
  const area = assessServiceArea(connecticut.address);
  assert.equal(area, 'OUT_OF_AREA');
  assert.deepEqual(planNextStep(connecticut, assessPriority(connecticut), area), {
    missing: ['address.postalCode'], nextAction: 'COLLECT_DETAILS',
  });
  const complete = { ...connecticut, address: { ...connecticut.address!, postalCode: '06103' } };
  assert.deepEqual(planNextStep(complete, assessPriority(complete), area), { missing: ['availability'], nextAction: 'COLLECT_DETAILS' });
  const available = { ...complete, availabilityNotes: 'Monday 9 AM–noon Eastern' };
  assert.deepEqual(planNextStep(available, assessPriority(available), area), { missing: [], nextAction: 'SAVE_FOLLOW_UP' });
});

test('nonurgent requests can only save a follow-up, never reach a visit time', () => {
  const tuneUp = hvac({
    issueCategory: 'MAINTENANCE',
    safetySignals: [],
    propertyType: 'RESIDENTIAL',
    callerName: 'Test Caller',
    callbackPhone: '+19195550100',
    address: IN_AREA_ADDRESS,
    availabilityNotes: 'Monday 9 AM–noon Eastern',
    ...ALL_CONFIRMED,
  });
  assert.equal(planNextStep(tuneUp, assessPriority(tuneUp), 'IN_AREA').nextAction, 'SAVE_FOLLOW_UP');
});

test('emergency and critical tiers skip intake entirely', () => {
  const gas = hvac({ safetySignals: ['GAS_ODOR'] });
  assert.equal(planNextStep(gas, assessPriority(gas), 'UNKNOWN').nextAction, 'EMERGENCY_GUIDANCE');
  const hot = hvac({ temperatureRisk: 'UNSAFE_HEAT' });
  assert.equal(planNextStep(hot, assessPriority(hot), 'UNKNOWN').nextAction, 'TRANSFER_TO_HUMAN');
});

test('a caller who asks for a person a second time is transferred, but emergencies still come first', () => {
  const repair = hvac({ issueCategory: 'THERMOSTAT', safetySignals: [] });
  assert.notEqual(planNextStep({ ...repair, humanRequests: 1 }, assessPriority(repair), 'UNKNOWN').nextAction, 'TRANSFER_TO_HUMAN');
  assert.equal(planNextStep({ ...repair, humanRequests: 2 }, assessPriority(repair), 'UNKNOWN').nextAction, 'TRANSFER_TO_HUMAN');
  const gas = hvac({ safetySignals: ['GAS_ODOR'], humanRequests: 2 });
  assert.equal(planNextStep(gas, assessPriority(gas), 'UNKNOWN').nextAction, 'EMERGENCY_GUIDANCE');
});

test('a detail is confirmed right after it is captured, before collecting the next one', () => {
  const started = hvac({ issueCategory: 'THERMOSTAT', safetySignals: [], propertyType: 'RESIDENTIAL', callerName: 'Siobhan Nguyen' });
  assert.equal(planNextStep(started, assessPriority(started), 'UNKNOWN').nextAction, 'CONFIRM_NAME');
  const named = { ...started, nameConfirmed: true };
  assert.deepEqual(planNextStep(named, assessPriority(named), 'UNKNOWN').missing,
    ['callbackPhone', 'address.line1', 'address.city', 'address.state', 'address.postalCode', 'address.county']);
});

test('P2, P3, and P4 all require state and ZIP after street and city; availability never jumps ahead', () => {
  for (const issue of [
    { issueCategory: 'NO_COOLING', systemImpact: 'COMPLETE_OUTAGE' },
    { issueCategory: 'THERMOSTAT', systemImpact: 'PARTIAL' },
    { issueCategory: 'MAINTENANCE', systemImpact: 'NONE' },
  ] as const) {
    const partial = hvac({ ...issue, callerName: 'Test Caller', callbackPhone: '+19195550100',
      propertyType: 'RESIDENTIAL', safetySignals: [], vulnerableOccupants: [], temperatureRisk: 'NONE_REPORTED',
      nameConfirmed: true, phoneConfirmed: true,
      address: { ...IN_AREA_ADDRESS, state: null, postalCode: null, county: null } });
    const priority = assessPriority(partial);
    assert.deepEqual(planNextStep(partial, priority, 'UNKNOWN'), {
      missing: ['address.state', 'address.postalCode', 'address.county'], nextAction: 'COLLECT_DETAILS',
    });
    const complete = { ...partial, address: IN_AREA_ADDRESS };
    assert.equal(planNextStep(complete, priority, 'IN_AREA').nextAction, 'CONFIRM_ADDRESS');
    const confirmed = { ...complete, ...ALL_CONFIRMED };
    assert.deepEqual(planNextStep(confirmed, priority, 'IN_AREA'), { missing: ['availability'], nextAction: 'COLLECT_DETAILS' });
    const available = { ...confirmed, availabilityNotes: 'Monday 9 AM–noon Eastern' };
    assert.deepEqual(planNextStep(available, priority, 'IN_AREA'), { missing: [],
      nextAction: priority.tier === 'P2' ? 'AGREE_VISIT_TIME' : 'SAVE_FOLLOW_UP' });
  }
});
