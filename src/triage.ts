import { SERVICE_AREA } from './config.ts';
import type { IntakeFacts, NextAction } from './contracts.ts';

// The model extracts facts; these rules choose priority and the next action.
// An unknown answer doesn't mean "no."

export type Tier = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
export type Priority = { tier: Tier | null; reasons: string[] };
export type ServiceArea = 'IN_AREA' | 'OUT_OF_AREA' | 'UNKNOWN';

const MALFUNCTIONS = new Set([
  'NO_HEAT', 'NO_COOLING', 'GAS_ODOR', 'CO_CONCERN', 'WATER_LEAK', 'THERMOSTAT', 'EQUIPMENT_NOISE', 'OTHER',
]);

/** Evaluates the tiers top to bottom; the first that matches wins. */
export function assessPriority(facts: IntakeFacts): Priority {
  // P0: only current danger. The model leaves negated/historical/hypothetical mentions out.
  if (facts.safetySignals?.length) {
    return { tier: 'P0', reasons: facts.safetySignals.map((signal) => `SAFETY_${signal}`) };
  }

  const critical: string[] = [];
  const vulnerable = facts.vulnerableOccupants?.some((occupant) => occupant !== 'OTHER');
  if (facts.systemImpact === 'COMPLETE_OUTAGE' && vulnerable) critical.push('OUTAGE_WITH_VULNERABLE_OCCUPANT');
  if (facts.temperatureRisk === 'UNSAFE_HEAT' || facts.temperatureRisk === 'UNSAFE_COLD') {
    critical.push('UNSAFE_INDOOR_TEMPERATURE');
  }
  if (critical.length) return { tier: 'P1', reasons: critical };

  // Below the safety tiers, only HVAC requests are classified; never invent urgency.
  if (facts.intent === 'OTHER') return { tier: null, reasons: [] };

  // Commercial status alone never raises priority; stopped operations can justify P2.
  const urgent: string[] = [];
  if (facts.systemImpact === 'COMPLETE_OUTAGE') urgent.push('COMPLETE_OUTAGE');
  if (facts.businessImpact === 'OPERATIONS_STOPPED') urgent.push('COMMERCIAL_OPERATIONS_STOPPED');
  if (urgent.length) return { tier: 'P2', reasons: urgent };

  if (facts.systemImpact === 'PARTIAL' || MALFUNCTIONS.has(facts.issueCategory)) {
    return { tier: 'P3', reasons: ['STANDARD_REPAIR'] };
  }
  if (facts.issueCategory === 'MAINTENANCE') return { tier: 'P4', reasons: ['ROUTINE_MAINTENANCE'] };
  return { tier: null, reasons: [] };
}

const RANK: Record<Tier, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };

/** Once P0/P1 is reached, a call never drops to a lower tier, even after corrections. */
export function latchPriority(previous: Priority, next: Priority): Priority {
  const latched = previous.tier === 'P0' || previous.tier === 'P1';
  if (!latched || (next.tier && RANK[next.tier] <= RANK[previous.tier!])) return next;
  return previous;
}

export function assessServiceArea(address: IntakeFacts['address']): ServiceArea {
  const state = address?.state?.trim().toLowerCase();
  const county = address?.county?.trim().toLowerCase().replace(/\s+county$/, '');
  const inState = state === SERVICE_AREA.state.toLowerCase() || state === 'north carolina';
  if (state && !inState) return 'OUT_OF_AREA';
  if (county && !SERVICE_AREA.counties.some((name) => name.toLowerCase() === county)) return 'OUT_OF_AREA';
  // Wake, Durham, and Orange counties also exist elsewhere, so both are needed to be in area.
  return county && inState ? 'IN_AREA' : 'UNKNOWN';
}

export type Plan = { missing: string[]; nextAction: NextAction };

/** The first ask gets an explanation of what the assistant can do; the second gets a person. */
export const HUMAN_REQUESTS_BEFORE_TRANSFER = 2;

/** Decides what is still needed and what the conversation may do next. */
export function planNextStep(facts: IntakeFacts, priority: Priority, area: ServiceArea): Plan {
  if (priority.tier === 'P0') return { missing: [], nextAction: 'EMERGENCY_GUIDANCE' };
  if (priority.tier === 'P1') return { missing: [], nextAction: 'TRANSFER_TO_HUMAN' };
  // Transfer after repeated requests for a person.
  if (facts.humanRequests >= HUMAN_REQUESTS_BEFORE_TRANSFER) return { missing: [], nextAction: 'TRANSFER_TO_HUMAN' };
  if (facts.intent === 'OTHER') return { missing: [], nextAction: 'CLARIFY_REQUEST' };

  const triage: string[] = [];
  if (facts.issueCategory === 'UNKNOWN') triage.push('issue');
  if (facts.safetySignals === null) triage.push('safetySignals');
  if (['NO_HEAT', 'NO_COOLING'].includes(facts.issueCategory) && facts.systemImpact === 'UNKNOWN') {
    triage.push('systemImpact');
  }
  // Check vulnerability and temperature for every P2; either answer could raise it to P1.
  if (facts.systemImpact === 'COMPLETE_OUTAGE' || priority.tier === 'P2') {
    if (facts.vulnerableOccupants === null) triage.push('vulnerableOccupants');
    if (facts.temperatureRisk === 'UNKNOWN') triage.push('temperatureRisk');
  }
  if (
    facts.propertyType === 'COMMERCIAL' &&
    priority.tier !== 'P2' &&
    MALFUNCTIONS.has(facts.issueCategory) &&
    facts.businessImpact === 'UNKNOWN'
  ) {
    triage.push('businessImpact');
  }
  if (triage.length) return { missing: triage, nextAction: 'ASK_TRIAGE_QUESTIONS' };

  // Follow-ups need a full address too. Ask for county unless the address is already out of area.
  const addressFields = area === 'OUT_OF_AREA'
    ? (['line1', 'city', 'state', 'postalCode'] as const)
    : (['line1', 'city', 'state', 'postalCode', 'county'] as const);
  const missingAddress = addressFields.filter((field) => !facts.address?.[field]).map((field) => `address.${field}`);

  // Confirm each detail before moving on, while it's fresh in the caller's mind.
  if (facts.callerName && !facts.nameConfirmed) return { missing: [], nextAction: 'CONFIRM_NAME' };
  if (facts.callbackPhone && !facts.phoneConfirmed) return { missing: [], nextAction: 'CONFIRM_PHONE' };
  if (facts.address && !missingAddress.length && !facts.addressConfirmed) {
    return { missing: [], nextAction: 'CONFIRM_ADDRESS' };
  }

  const details: string[] = [];
  if (facts.propertyType === 'UNKNOWN') details.push('propertyType');
  if (!facts.callerName) details.push('callerName');
  if (!facts.callbackPhone) details.push('callbackPhone');
  details.push(...missingAddress);
  if (details.length) return { missing: details, nextAction: 'COLLECT_DETAILS' };

  // Both bookings and follow-ups need availability, after contact/address read-back.
  if (!facts.availabilityNotes) return { missing: ['availability'], nextAction: 'COLLECT_DETAILS' };
  if (priority.tier === 'P2' && area === 'IN_AREA') return { missing: [], nextAction: 'AGREE_VISIT_TIME' };
  return { missing: [], nextAction: 'SAVE_FOLLOW_UP' };
}
