import { BUSINESS_TIMEZONE } from './config.ts';
import type { IntakeFacts } from './contracts.ts';
import type { CallRecord } from './store.ts';

// Shared display values for summaries, the demo page, and exports, derived from saved records.

export const NOT_CAPTURED = 'Not captured';

export type NextStep = { code: string; label: string };

/** Derived from saved priority, status, and outcomes only, never from model text. */
export function nextStep({ session, request, escalations, booking }: CallRecord): NextStep {
  const urgent = ['P0', 'P1', 'P2'].includes(request?.priorityTier ?? '');
  const guidance = escalations.find((e) => e.type === 'EMERGENCY_GUIDANCE' && e.status === 'GUIDANCE_ISSUED');
  if (guidance) {
    return { code: 'EMERGENCY_GUIDANCE_ISSUED', label: 'Emergency guidance issued (911 not called by the system)' };
  }
  const transfer = escalations.find((e) => e.type === 'HUMAN_TRANSFER');
  if (transfer?.status === 'CONNECTED') {
    return { code: 'TRANSFER_CONNECTED', label: 'Transferred to representative (call connected)' };
  }
  if (booking?.status === 'CONFIRMED') {
    return { code: 'VISIT_CONFIRMED', label: `Visit booked for ${formatVisitTime(booking.startAt)}` };
  }
  if (request?.followUpReason === 'BOOKING_UNCONFIRMED') {
    return { code: 'BOOKING_UNCONFIRMED', label: 'Booking could not be confirmed; urgent follow-up saved (no one notified)' };
  }
  if (request?.followUpReason === 'BOOKING_FAILED') {
    return { code: 'BOOKING_FAILED', label: 'Booking failed; urgent follow-up saved (no one notified)' };
  }
  if (request?.followUpReason === 'TRANSFER_RESULT_UNKNOWN') {
    return { code: 'TRANSFER_RESULT_UNKNOWN', label: 'Transfer result unknown; urgent follow-up saved (no one notified)' };
  }
  if (request?.followUpReason === 'TRANSFER_FAILED') {
    // Transfers also happen for non-urgent callers who kept asking for a person.
    return urgent
      ? { code: 'URGENT_FOLLOW_UP_AFTER_FAILURE', label: 'Transfer not connected; urgent follow-up saved (no one notified)' }
      : { code: 'FOLLOW_UP_AFTER_FAILED_TRANSFER', label: 'Transfer not connected; follow-up saved (no one notified)' };
  }
  if (transfer?.status === 'INITIATED') return { code: 'TRANSFER_ATTEMPTED', label: 'Transfer attempted, result pending' };
  if (request?.status === 'FOLLOW_UP_PENDING') {
    if (!request.priorityTier) {
      return { code: 'SAVED_FOR_REVIEW', label: 'Saved for team review (no one notified)' };
    }
    return urgent
      ? { code: 'URGENT_FOLLOW_UP', label: 'Urgent follow-up saved (not booked, no one notified)' }
      : { code: 'FOLLOW_UP_SAVED', label: 'Follow-up request saved (not booked, no one notified)' };
  }
  if (request?.status === 'CLOSED_UNBOOKED' && session.outcome === 'DECLINED') {
    return { code: 'DECLINED', label: 'Caller declined further help' };
  }
  if (session.status === 'ACTIVE' || session.status === 'TRANSFERRING') {
    return { code: 'IN_PROGRESS', label: 'Intake in progress' };
  }
  return urgent
    ? { code: 'INCOMPLETE_URGENT', label: 'Incomplete call with urgent priority (nothing saved as follow-up)' }
    : { code: 'INCOMPLETE', label: 'Incomplete call' };
}

const PRIORITY_LABELS: Record<string, string> = {
  P0: 'P0 emergency',
  P1: 'P1 critical',
  P2: 'P2 urgent service',
  P3: 'P3 standard repair',
  P4: 'P4 routine',
};

const words = (value: string) => value.toLowerCase().replaceAll('_', ' ');
const known = (value: string) => (value === 'UNKNOWN' ? null : value);

export function formatAddress(address: IntakeFacts['address']): string | null {
  if (!address) return null;
  const street = [address.line1, address.unit].filter(Boolean).join(' ');
  const region = [address.state, address.postalCode].filter(Boolean).join(' ');
  const county = address.county ? `${address.county.replace(/\s+county$/i, '')} County` : null;
  const parts = [street, address.city, region, county].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** Display values for the demo view; anything missing reads "Not captured". */
export function toView(record: CallRecord) {
  const facts = record.request?.facts;
  const tier = record.request?.priorityTier;
  const issue = facts?.issueSummary ?? (facts && known(facts.issueCategory) ? words(facts.issueCategory) : null);
  return {
    id: record.session.id,
    startedAt: formatTime(record.session.startedAt),
    endedAt: record.session.endedAt ? formatTime(record.session.endedAt) : null,
    callStatus: record.session.status,
    outcome: record.session.outcome,
    issue: issue ?? NOT_CAPTURED,
    issueCategory: facts && known(facts.issueCategory) ? words(facts.issueCategory) : NOT_CAPTURED,
    propertyType: facts && known(facts.propertyType) ? words(facts.propertyType) : NOT_CAPTURED,
    callerName: facts?.callerName ?? NOT_CAPTURED,
    callbackPhone: facts?.callbackPhone ?? NOT_CAPTURED,
    address: formatAddress(facts?.address ?? null) ?? NOT_CAPTURED,
    serviceArea: record.request ? words(record.request.serviceAreaStatus) : NOT_CAPTURED,
    availability: facts?.availabilityNotes ?? NOT_CAPTURED,
    detailsConfirmed: facts?.detailsConfirmed ? 'Yes' : 'No',
    priority: tier ? PRIORITY_LABELS[tier]! : 'Not yet classified',
    priorityReasons: record.request?.priorityReasons.map(words) ?? [],
    nextStep: nextStep(record),
    visit: describeBooking(record),
    transfer: describeEscalation(record, 'HUMAN_TRANSFER'),
    emergencyGuidance: describeEscalation(record, 'EMERGENCY_GUIDANCE'),
    summary: record.session.summary || NOT_CAPTURED,
    transcriptState: TRANSCRIPT_STATES[record.session.transcriptState] ?? record.session.transcriptState,
    transcript: [...record.session.transcript]
      .sort((a, b) => a.order - b.order)
      .map((turn) => ({
        speaker: SPEAKERS[turn.speaker]!,
        text: turn.text || '(transcription pending or unavailable)',
        time: formatClock(turn.timestamp),
        note: turn.speaker === 'SYSTEM'
          ? 'Scripted message issued; not proof it was heard'
          : turn.interrupted
            ? 'Interrupted; not all of this was necessarily heard'
            : null,
      })),
  };
}

const TRANSCRIPT_STATES: Record<string, string> = {
  CAPTURING: 'Capturing (call in progress)',
  COMPLETE_AI_LEG: 'Complete for the AI portion of the call',
  PARTIAL: 'Partial (some turns missing or unfinished)',
};

const SPEAKERS: Record<string, string> = { CALLER: 'Caller', AGENT: 'Assistant', SYSTEM: 'System' };

function formatClock(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso));
}

const ESCALATION_LABELS: Record<string, string> = {
  INITIATED: 'Attempted, result pending',
  CONNECTED: 'Connected (provider-confirmed bridge)',
  NO_ANSWER: 'Not connected: no answer',
  BUSY: 'Not connected: busy',
  FAILED: 'Not connected: failed',
  GUIDANCE_ISSUED: 'Scripted guidance issued (not proof it was heard)',
};

function describeBooking({ booking }: CallRecord): string {
  if (!booking) return 'Not booked';
  const when = formatVisitTime(booking.startAt);
  switch (booking.status) {
    case 'CONFIRMED':
      return `Confirmed for ${when}`;
    case 'PENDING':
      return `Being booked for ${when}`;
    case 'UNKNOWN':
      return `Not confirmed: calendar result unknown (requested ${when})`;
    default:
      return `Not booked: calendar write failed (requested ${when})`;
  }
}

function describeEscalation(record: CallRecord, type: 'HUMAN_TRANSFER' | 'EMERGENCY_GUIDANCE'): string {
  const escalation = record.escalations.find((e) => e.type === type);
  if (!escalation) return 'Not attempted';
  const label = ESCALATION_LABELS[escalation.status] ?? escalation.status;
  return escalation.failureCode && escalation.status === 'FAILED' ? `${label} (${words(escalation.failureCode)})` : label;
}

/** Builds the summary from saved facts and outcomes. */
export function renderSummary(record: CallRecord): string {
  const facts = record.request?.facts;
  if (!facts) return 'No intake was saved for this call.';
  const view = toView(record);
  const who = facts.callerName ?? 'an unnamed caller';
  const property = known(facts.propertyType) ? `${words(facts.propertyType)} ` : '';
  const issue = view.issue === NOT_CAPTURED ? 'an unspecified request' : view.issue;
  const priority = record.request?.priorityTier
    ? `${view.priority} (${view.priorityReasons.join(', ')})`
    : 'not yet classified';

  const missing = [
    ['callback number', facts.callbackPhone],
    ['address', facts.address?.line1 && facts.address.city && facts.address.state && facts.address.postalCode],
    ['availability', facts.availabilityNotes],
    ['property type', known(facts.propertyType)],
  ].filter(([, value]) => !value).map(([label]) => label);

  return [
    capitalize(`${property}call from ${who} about ${issue}.`),
    `Priority: ${priority}.`,
    `Next step: ${view.nextStep.label}.`,
    missing.length ? `Not captured: ${missing.join(', ')}.` : 'All contact details captured.',
  ].join(' ');
}

/** Linked records for local JSON export and future CRM mapping. */
export function toExport(record: CallRecord) {
  return {
    callSession: record.session,
    serviceRequest: record.request,
    escalations: record.escalations,
    booking: record.booking,
    nextStep: nextStep(record),
  };
}

/** e.g. "Monday, October 5 at 9:00 AM EDT", always in the business timezone. */
export function formatVisitTime(iso: string): string {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(iso));
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
  return `${date} at ${time}`;
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
