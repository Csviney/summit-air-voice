import twilio from 'twilio';
import type { Config } from './config.ts';
import type { Escalation, ServiceRequest, ToolError } from './contracts.ts';
import { refreshSummary, saveReadyFollowUp } from './intake.ts';
import type { Store } from './store.ts';
import { HUMAN_REQUESTS_BEFORE_TRANSFER, type Priority } from './triage.ts';

/** Redirects a live call; replaced with a fake in tests. */
export type CallControl = { redirect(callSid: string, twiml: string): Promise<void> };

export function twilioCallControl(config: Config): CallControl {
// Use a short timeout and no retries so failed redirects reach the spoken fallback quickly.
  const client = twilio(config.twilioAccountSid, config.twilioAuthToken, { timeout: 8_000, autoRetry: false });
  return {
    async redirect(callSid, twiml) {
      await client.calls(callSid).update({ twiml });
    },
  };
}

// Fixed safety guidance; it must not imply responders were contacted.
const SAFETY_LINES: Record<string, string> = {
  SAFETY_GAS_ODOR: 'Leave the building now. Do not use flames, lighters, or light switches. Call 911 from outside.',
  SAFETY_CO_CONCERN: 'Get everyone outside into fresh air now, and call 911 from outside.',
  SAFETY_FIRE_SMOKE: 'Get everyone out now, and call 911 from a safe place.',
  SAFETY_ELECTRICAL_DANGER: 'Stay away from the equipment, and call 911 from a safe place.',
  SAFETY_MEDICAL_EMERGENCY: 'Call 911 now for the medical emergency.',
};

export function emergencyScript(reasons: string[]): string {
  const lines = [...new Set(reasons.map((reason) => SAFETY_LINES[reason]).filter(Boolean))];
  return lines.length ? lines.join(' ') : 'If anyone is in danger, get to a safe place and call 911.';
}

export const TRANSFER_ANNOUNCEMENT = "Because this sounds urgent, I'm transferring you to a human representative now.";

// Non-urgent transfers: repeated requests for a person or a booking still uncertain after recheck.
export const CALLER_REQUESTED_HUMAN = 'CALLER_REQUESTED_HUMAN';
export const BOOKING_UNCONFIRMED = 'BOOKING_UNCONFIRMED';

export function transferAnnouncement(reasons: string[]): string {
// The agent has already announced the transfer.
  if (reasons.includes(BOOKING_UNCONFIRMED)) return 'Connecting you to a representative now.';
  if (reasons.includes(CALLER_REQUESTED_HUMAN)) return "Of course. I'm transferring you to a representative now.";
  return TRANSFER_ANNOUNCEMENT;
}

/** Only claims the request was saved when that write actually succeeded. */
export function transferFailedMessage(saved: boolean, reasons: string[] = []): string {
  const sorry = "I'm sorry, I couldn't connect you to a representative";
  if (reasons.includes(BOOKING_UNCONFIRMED)) {
    return saved
      ? `${sorry}, and I couldn't confirm whether your visit was booked. Your request has been saved for our team to review.`
      : `${sorry}, I couldn't confirm whether your visit was booked, and I wasn't able to save your request. Please call back.`;
  }
  if (reasons.includes(CALLER_REQUESTED_HUMAN)) {
    return saved
      ? `${sorry}. Your request has been saved for our team to review.`
      : `${sorry}, and I wasn't able to save your request. Please call back.`;
  }
  return saved
    ? `${sorry}. Your request has been saved as urgent for our team, but no visit has been booked. ` +
        'If anyone is in danger, hang up and call 911.'
    : `${sorry}, and I wasn't able to save your request. Please call back. If anyone is in danger, hang up and call 911.`;
}

const DIAL_TIMEOUT_SECONDS = 20;

// Twilio reads the fixed script; a neural voice softens the change from the agent's voice.
export const SCRIPT_VOICE = { voice: 'Polly.Joanna-Neural' } as const;

type Result<T> = { ok: true; data: T } | ToolError;
type Deps = { store: Store; calls: CallControl; config: Config };

/** Verified call ID and last backend priority, used if storage can't be read. */
export type KnownCall = { callSessionId: string | null; callSid: string; priority: Priority | null };

// Saved state determines guidance or transfer. New P0 hazards override any earlier transfer.
export async function escalateCall(
  { store, calls, config }: Deps,
  call: KnownCall,
): Promise<Result<{ type: Escalation['type']; status: Escalation['status'] }>> {
  let request: ServiceRequest | null = null;
  try {
    request = call.callSessionId ? store.getRequestForCall(call.callSessionId) : null;
  } catch (error) {
    console.error(`Call ${call.callSid}: could not read request; using last known priority (${(error as Error).name}).`);
  }
  const priority = request ? { tier: request.priorityTier, reasons: request.priorityReasons } : call.priority;
  const decision = decideEscalation(store, request, priority);
  if (!decision) {
    return {
      ok: false,
      code: 'NOT_ESCALATABLE',
      // Allow a retry after the agent saves any danger it heard but hasn't recorded yet.
      message: 'No emergency is saved for this call, so nothing was escalated.',
      retryable: true,
    };
  }
  const { type, reasons } = decision;
  const script = emergencyScript(reasons);

  // Save intent first, but storage problems must never delay the redirect.
  let escalation: Escalation | null = null;
  if (request && call.callSessionId) {
    const callSessionId = call.callSessionId;
    try {
      const attempt = store.createEscalation(request.id, type, reasons);
      if (!attempt.created) return repeatResult(attempt.escalation, script, request.status === 'FOLLOW_UP_PENDING');
      escalation = attempt.escalation;
      // Mark the transfer first so the stream closing during redirect doesn't end the call record.
      if (type === 'HUMAN_TRANSFER') store.transitionCall(callSessionId, 'ACTIVE', 'TRANSFERRING');
    } catch (error) {
      console.error(`Call ${call.callSid}: could not save escalation (${(error as Error).name}).`);
    }
  }

  const twiml = new twilio.twiml.VoiceResponse();
  if (type === 'EMERGENCY_GUIDANCE') {
    twiml.say(SCRIPT_VOICE, `This may be an emergency. ${script}`);
    twiml.pause({ length: 1 });
    twiml.say(SCRIPT_VOICE, `Again: ${script} I'm ending this call now so you can get to safety.`);
    twiml.hangup();
  } else {
    twiml.say(SCRIPT_VOICE, transferAnnouncement(reasons));
    const query = escalation ? `?escalationId=${encodeURIComponent(escalation.id)}` : '';
    twiml
      .dial({
        action: `${config.publicOrigin}/twilio/dial-result${query}`,
        method: 'POST',
        timeout: DIAL_TIMEOUT_SECONDS,
        callerId: config.twilioPhoneNumber,
      })
      .number(config.transferPhoneNumber);
  }

  try {
    await calls.redirect(call.callSid, twiml.toString());
  } catch (error) {
    console.error(`Call ${call.callSid}: escalation redirect failed (${(error as Error).name}).`);
    const saved = persisted(() => {
      if (!escalation || !request || !call.callSessionId) throw new Error('no saved request');
      store.updateEscalation(escalation.id, { status: 'FAILED', failureCode: 'REDIRECT_FAILED', endedAt: now() });
      // The agent keeps the call; never reopen a call that already ended meanwhile.
      store.transitionCall(call.callSessionId, 'TRANSFERRING', 'ACTIVE');
      markFollowUp(store, request, type === 'EMERGENCY_GUIDANCE' ? 'EMERGENCY_REPORTED' : 'TRANSFER_FAILED');
    });
    return failure(type, script, saved, reasons);
  }

  persisted(() => {
    if (!escalation || !request || !call.callSessionId) return;
    systemTurn(store, call.callSessionId, type === 'EMERGENCY_GUIDANCE' ? `This may be an emergency. ${script}` : transferAnnouncement(reasons));
    if (type === 'EMERGENCY_GUIDANCE') {
      store.updateEscalation(escalation.id, {
        status: 'GUIDANCE_ISSUED',
        announcementIssuedAt: now(),
        guidanceCode: reasons.join(','),
      });
      store.setOutcome(call.callSessionId, 'EMERGENCY_GUIDANCE');
    } else {
      store.updateEscalation(escalation.id, { announcementIssuedAt: now() });
    }
  // Update only status, preserving facts saved during the redirect.
    store.setRequestStatus(request.id, 'ESCALATED', null);
    refreshSummary(store, call.callSessionId);
  });
  return { ok: true, data: { type, status: type === 'EMERGENCY_GUIDANCE' ? 'GUIDANCE_ISSUED' : 'INITIATED' } };
}

/** Which escalation saved state allows, if any. Emergencies always take precedence. */
function decideEscalation(
  store: Store,
  request: ServiceRequest | null,
  priority: Priority | null,
): { type: Escalation['type']; reasons: string[] } | null {
  if (priority?.tier === 'P0') return { type: 'EMERGENCY_GUIDANCE', reasons: priority.reasons };
  if (priority?.tier === 'P1') return { type: 'HUMAN_TRANSFER', reasons: priority.reasons };
  if (!request) return null;
  if (request.facts.humanRequests >= HUMAN_REQUESTS_BEFORE_TRANSFER) {
    return { type: 'HUMAN_TRANSFER', reasons: [CALLER_REQUESTED_HUMAN] };
  }
  try {
    if (store.bookingFor(request.id)?.status === 'UNKNOWN') return { type: 'HUMAN_TRANSFER', reasons: [BOOKING_UNCONFIRMED] };
  } catch (error) {
    console.error(`Booking lookup for escalation failed (${(error as Error).name}).`);
  }
  return null;
}

/** Repeated calls return the first attempt's result, including failures. */
function repeatResult(
  escalation: Escalation,
  script: string,
  followUpSaved: boolean,
): Result<{ type: Escalation['type']; status: Escalation['status'] }> {
  if (['FAILED', 'NO_ANSWER', 'BUSY'].includes(escalation.status)) {
    return failure(escalation.type, script, followUpSaved, escalation.reasonCodes);
  }
  return { ok: true, data: { type: escalation.type, status: escalation.status } };
}

// The agent still has the call after a failed redirect and must speak this fallback verbatim.
function failure(type: Escalation['type'], script: string, saved: boolean, reasons: string[]): ToolError {
  return {
    ok: false,
    code: 'ESCALATION_FAILED',
    message: type === 'EMERGENCY_GUIDANCE' ? script : transferFailedMessage(saved, reasons),
    retryable: false,
  };
}

const DIAL_STATUSES: Record<string, Escalation['status']> = {
  completed: 'CONNECTED',
  answered: 'CONNECTED',
  busy: 'BUSY',
  'no-answer': 'NO_ANSWER',
};

// Twilio's dial result settles the transfer even if it arrives after the call's final status.
export function recordDialResult(
  store: Store,
  escalationId: string | undefined,
  params: Record<string, string>,
): string {
  const twiml = new twilio.twiml.VoiceResponse();
  const status = DIAL_STATUSES[params.DialCallStatus ?? ''] ?? 'FAILED';
  let followUpSaved = false;
  // Match the failure message to the reason for transfer.
  let reasons: string[] = [];
  persisted(() => {
    const escalation = escalationId ? store.getEscalation(escalationId) : null;
    if (!escalation || escalation.type !== 'HUMAN_TRANSFER') return;
    reasons = escalation.reasonCodes;
    const request = store.getRequest(escalation.serviceRequestId);
    if (!request) return;
    // Repeated callbacks keep the first result.
    if (escalation.status !== 'INITIATED') {
      followUpSaved = request.status === 'FOLLOW_UP_PENDING';
      return;
    }
    store.updateEscalation(escalation.id, {
      status,
      twilioChildCallSid: params.DialCallSid || null,
      failureCode: status === 'CONNECTED' ? null : (params.DialCallStatus || 'unknown').toUpperCase(),
      endedAt: now(),
    });
    if (status === 'CONNECTED') {
      // Supersedes an "unknown result" follow-up saved by an earlier final-status callback.
      store.setRequestStatus(request.id, 'ESCALATED', null);
      store.setOutcome(request.callSessionId, 'TRANSFERRED');
    } else {
      markFollowUp(store, request, 'TRANSFER_FAILED');
      followUpSaved = true;
    }
    // The TwiML below ends the call either way.
    store.endCall(request.callSessionId);
    refreshSummary(store, request.callSessionId);
  });
  if (status !== 'CONNECTED') {
    const message = transferFailedMessage(followUpSaved, reasons);
    twiml.say(SCRIPT_VOICE, message);
    persisted(() => {
      const escalation = escalationId ? store.getEscalation(escalationId) : null;
      const request = escalation ? store.getRequest(escalation.serviceRequestId) : null;
      if (request) systemTurn(store, request.callSessionId, message);
    });
  }
  twiml.hangup();
  return twiml.toString();
}

const FINAL_CALL_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

/** Twilio's final call status closes the record; idempotent and safe to receive late. */
export function recordCallStatus(store: Store, callSid: string, callStatus: string): void {
  if (!FINAL_CALL_STATUSES.has(callStatus)) return;
  const callSessionId = store.findCallId(callSid);
  if (!callSessionId) return;
  const record = store.getRecord(callSessionId);
  if (!record?.request) return;
  // Leave transfers without a dial result INITIATED for late callbacks; save a follow-up meanwhile.
  const pending = record.escalations.some((e) => e.type === 'HUMAN_TRANSFER' && e.status === 'INITIATED');
  if (pending && record.request.status !== 'FOLLOW_UP_PENDING') {
    markFollowUp(store, record.request, 'TRANSFER_RESULT_UNKNOWN');
  }
  saveReadyFollowUp(store, callSessionId);
  store.endCall(callSessionId, { failed: callStatus === 'failed' });
  refreshSummary(store, callSessionId);
}

/** Records scripts as SYSTEM turns; issuing a line doesn't prove it was heard. */
function systemTurn(store: Store, callSessionId: string, text: string): void {
  store.upsertTranscriptTurn(callSessionId, { itemId: `system-${crypto.randomUUID()}`, speaker: 'SYSTEM', text });
}

/** Never silently downgrade: a failed or unknown escalation keeps an urgent follow-up. */
function markFollowUp(store: Store, request: ServiceRequest, reason: string): void {
  store.setRequestStatus(request.id, 'FOLLOW_UP_PENDING', reason);
  store.setOutcome(request.callSessionId, 'FOLLOW_UP');
  refreshSummary(store, request.callSessionId);
}

/** Returns true only if every record update succeeded. */
function persisted(work: () => void): boolean {
  try {
    work();
    return true;
  } catch (error) {
    console.error(`Escalation record update failed (${(error as Error).name}).`);
    return false;
  }
}

const now = () => new Date().toISOString();
