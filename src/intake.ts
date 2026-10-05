import {
  IntakeFacts,
  type IntakeStatus,
  type IntakeUpdate,
  type ServiceRequest,
  type ToolError,
} from './contracts.ts';
import { renderSummary } from './records.ts';
import type { Store } from './store.ts';
import { assessPriority, assessServiceArea, latchPriority, planNextStep, type Plan } from './triage.ts';

type Result<T> = { ok: true; data: T } | ToolError;

const SAFETY_ACTIONS = new Set(['EMERGENCY_GUIDANCE', 'TRANSFER_TO_HUMAN']);

const fail = (code: string, message: string, retryable: boolean): ToolError => ({
  ok: false,
  code,
  message,
  retryable,
});

/** Accepts US numbers; returns null for invalid input. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1') && /^[2-9]/.test(digits.slice(1))) return `+${digits}`;
  return null;
}

/** Best-effort redaction of card numbers, SSNs, and passwords before saving. */
export function redactSensitive(text: string): string {
  return text
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, '[redacted number]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted number]')
    .replace(/\b(password|passcode|pin)\b(\s+(is|was))?\s*:?\s*\S+/gi, '$1 [redacted]');
}

type Merge = { ok: true; facts: IntakeFacts; rejected: string[] } | ToolError;

// Null and UNKNOWN keep existing facts; corrections replace them.
// Reject bad fields individually so a malformed phone number can't hide a reported hazard.
export function mergeFacts(current: IntakeFacts, update: IntakeUpdate): Merge {
  const next: IntakeFacts = structuredClone(current);
  const rejected: string[] = [];
  const clean = (value: string | null) => (value === null ? null : redactSensitive(value));

  for (const key of ['intent', 'propertyType', 'issueCategory', 'systemImpact', 'temperatureRisk', 'businessImpact'] as const) {
    const value = update[key];
    if (value !== null && value !== 'UNKNOWN') (next[key] as string) = value;
  }
  if (update.callerName !== null) next.callerName = clean(update.callerName);
  if (update.issueSummary !== null) next.issueSummary = clean(update.issueSummary);
  if (update.availabilityNotes !== null) next.availabilityNotes = clean(update.availabilityNotes);
  if (update.triageEvidence !== null) next.triageEvidence = clean(update.triageEvidence);
  if (update.callerAskedForHuman) next.humanRequests += 1;
  if (update.vulnerableOccupants !== null) next.vulnerableOccupants = [...new Set(update.vulnerableOccupants)];
  if (update.safetySignals !== null) next.safetySignals = [...new Set(update.safetySignals)];

  if (update.callbackPhone !== null) {
    const phone = normalizePhone(update.callbackPhone);
    if (phone) next.callbackPhone = phone;
    else rejected.push('callbackPhone');
  }
  if (update.address !== null) {
    const address = next.address ?? { line1: null, unit: null, city: null, state: null, postalCode: null, county: null };
    for (const [field, value] of Object.entries(update.address) as Array<[keyof typeof address, string | null]>) {
      if (value !== null) address[field] = clean(value);
    }
    next.address = address;
  }

  // Changed contact details need a new read-back, even if this update also claims confirmation.
  const confirmations = [
    ['nameConfirmed', next.callerName !== current.callerName],
    ['phoneConfirmed', next.callbackPhone !== current.callbackPhone],
    ['addressConfirmed', JSON.stringify(next.address) !== JSON.stringify(current.address)],
  ] as const;
  for (const [flag, changed] of confirmations) {
    if (changed) next[flag] = false;
    else if (update[flag] !== null) next[flag] = update[flag];
    else if (update.detailsConfirmed !== null) next[flag] = update.detailsConfirmed;
  }
  next.detailsConfirmed = next.nameConfirmed && next.phoneConfirmed && next.addressConfirmed;

  const parsed = IntakeFacts.safeParse(next);
  if (!parsed.success) return fail('INVALID_INTAKE', 'Some details could not be saved; ask again.', true);
  return { ok: true, facts: parsed.data, rejected };
}

/** Recomputes priority (with the P0/P1 latch), service area, and the permitted next step. */
export function evaluate(request: ServiceRequest, facts: IntakeFacts) {
  const priority = latchPriority(
    { tier: request.priorityTier, reasons: request.priorityReasons },
    assessPriority(facts),
  );
  const area = assessServiceArea(facts.address);
  return { priority, area, plan: planNextStep(facts, priority, area) };
}

export function applyIntakeUpdate(
  store: Store,
  callSessionId: string,
  update: IntakeUpdate,
): Result<Omit<IntakeStatus, 'saved' | 'today'> & { plan: Plan }> {
  const request = store.getRequestForCall(callSessionId);
  if (!request) return fail('NO_ACTIVE_REQUEST', 'No saved request exists for this call.', false);
  // Keep accepting facts after booking or escalation so new hazards can still be handled.
  const merged = mergeFacts(request.facts, update);
  if (!merged.ok) return merged;
  const { priority, area, plan } = evaluate(request, merged.facts);

  // Repeated or empty updates write nothing.
  if (JSON.stringify(merged.facts) !== JSON.stringify(request.facts)) {
    let saved: ServiceRequest = {
      ...request,
      facts: merged.facts,
      serviceAreaStatus: area,
      priorityTier: priority.tier,
      priorityReasons: priority.reasons,
    };
    // Update the saved outcome immediately so a late hazard isn't lost if the caller hangs up.
    if (request.status === 'FOLLOW_UP_PENDING' || request.status === 'CLOSED_UNBOOKED') {
      const settled = settle(saved, request.status === 'CLOSED_UNBOOKED');
      saved = settled.request;
      store.setOutcome(callSessionId, settled.outcome);
    }
    store.saveRequest(saved);
    refreshSummary(store, callSessionId);
  }

  return {
    ok: true,
    data: {
      priorityTier: priority.tier,
      priorityReasons: priority.reasons,
      serviceAreaStatus: area,
      missing: plan.missing,
      nextAction: request.status === 'BOOKED' && !SAFETY_ACTIONS.has(plan.nextAction) ? 'VISIT_BOOKED' : plan.nextAction,
      rejectedFields: merged.rejected,
      plan,
    },
  };
}

/** Follow-up reasons are backend-owned. */
function followUpReason(request: ServiceRequest): string {
  switch (request.priorityTier) {
    case 'P0':
      return 'EMERGENCY_REPORTED';
    case 'P1':
      return 'TRANSFER_NOT_ATTEMPTED';
    case 'P2':
      return 'URGENT_NOT_BOOKED';
    case 'P3':
    case 'P4':
      return 'NONURGENT';
    default:
      return 'NEEDS_REVIEW';
  }
}

/** Derives the disposition from saved state; P0/P1 are never closed as declined. */
function settle(request: ServiceRequest, callerDeclined: boolean) {
  const urgentSafety = request.priorityTier === 'P0' || request.priorityTier === 'P1';
  return callerDeclined && !urgentSafety
    ? { request: { ...request, status: 'CLOSED_UNBOOKED' as const, followUpReason: null }, outcome: 'DECLINED' as const }
    : {
        request: { ...request, status: 'FOLLOW_UP_PENDING' as const, followUpReason: followUpReason(request) },
        outcome: 'FOLLOW_UP' as const,
      };
}

export function finishIntake(
  store: Store,
  callSessionId: string,
  callerDeclined: boolean,
): Result<{ status: ServiceRequest['status']; followUpReason: string | null; followUpReady: boolean }> {
  const request = store.getRequestForCall(callSessionId);
  if (!request) return fail('NO_ACTIVE_REQUEST', 'No saved request exists for this call.', false);

  // Finishing twice keeps the saved outcome, including any booking or escalation.
  let finalRequest = request;
  if (request.status === 'OPEN') {
    const { request: saved, outcome } = settle(request, callerDeclined);
    store.saveRequest(saved);
    store.setOutcome(callSessionId, outcome);
    refreshSummary(store, callSessionId);
    finalRequest = saved;
  }
  const { area, plan } = evaluate(finalRequest, finalRequest.facts);
  const booking = store.bookingFor(request.id);
  // Saving an incomplete or out-of-area request must not imply it is ready for an appointment.
  const followUpReady = finalRequest.status === 'FOLLOW_UP_PENDING' && area === 'IN_AREA' &&
    ['P2', 'P3', 'P4'].includes(finalRequest.priorityTier ?? '') &&
    (!booking || booking.status === 'FAILED') &&
    (plan.nextAction === 'SAVE_FOLLOW_UP' || plan.nextAction === 'AGREE_VISIT_TIME');
  return { ok: true, data: { status: finalRequest.status, followUpReason: finalRequest.followUpReason, followUpReady } };
}

/** Saves a ready urgent request for follow-up if scheduling is interrupted. */
export function saveReadyFollowUp(store: Store, callSessionId: string): 'UNBOOKED' | 'UNCERTAIN' | null {
  const record = store.getRecord(callSessionId);
  const request = record?.request;
  if (!request || record.session.status !== 'ACTIVE' ||
      !['OPEN', 'FOLLOW_UP_PENDING'].includes(request.status) ||
      evaluate(request, request.facts).plan.nextAction !== 'AGREE_VISIT_TIME') return null;
  const booking = store.bookingFor(request.id);
  if (booking?.status === 'CONFIRMED') return null;
  const uncertain = booking?.status === 'PENDING' || booking?.status === 'UNKNOWN';
  const result = finishIntake(store, callSessionId, false);
  if (!result.ok || result.data.status !== 'FOLLOW_UP_PENDING') return null;
  return uncertain ? 'UNCERTAIN' : 'UNBOOKED';
}

/** Called when the media stream closes. A transferring call continues without the stream. */
export function recordStreamClosed(store: Store, callSessionId: string): void {
  saveReadyFollowUp(store, callSessionId);
  store.endCall(callSessionId, { includeTransferring: false });
  refreshSummary(store, callSessionId);
}

export function refreshSummary(store: Store, callSessionId: string): void {
  const record = store.getRecord(callSessionId);
  if (record) store.saveSummary(callSessionId, renderSummary(record));
}
