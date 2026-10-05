import { tool } from '@openai/agents/realtime';
import { z } from 'zod';
import {
  BookUrgentVisitInput,
  EMPTY_FACTS,
  EscalateCallInput,
  FinishIntakeInput,
  FindVisitTimeInput,
  IntakeStatus,
  IntakeUpdate,
  toolResult,
  type ToolError,
} from '../contracts.ts';
import { bookUrgentVisit, findVisitTime, type CalendarClient } from '../calendar.ts';
import { BUSINESS_TIMEZONE, type Config } from '../config.ts';
import { escalateCall, type CallControl } from '../escalation.ts';
import { applyIntakeUpdate, finishIntake, mergeFacts, saveReadyFollowUp } from '../intake.ts';
import { formatVisitTime } from '../records.ts';
import type { Store } from '../store.ts';
import { assessPriority, latchPriority, planNextStep, type Priority } from '../triage.ts';

// Bind tools to the verified CallSid; the model can't choose a call or request ID.
// Cache backend priority so emergency handling survives storage failures.
export type CallContext = {
  call: {
    callSessionId: string | null;
    callSid: string | null;
    priority: Priority | null;
    /** When finish_intake succeeded; the call hangs up after the agent's goodbye. */
    finishedAt: number | null;
    /** Set once a transfer or emergency script has taken over the call. */
    handedOff: boolean;
    /** Mute during handoff; unmute on failure so the agent can speak the fallback. */
    agentMuted: boolean;
    /** Set when the caller's stream closes; tools refuse to act after that. */
    ended: boolean;
    /** Caller turns so far, and the turn whose ask for a person was already counted. */
    callerTurn: number;
    humanAskTurn: number | null;
    /** The last visit time proposed to the caller, and the caller turn it was proposed in. */
    proposedVisit: { startAt: string; turn: number } | null;
  };
};

const storageError: ToolError = {
  ok: false,
  code: 'STORAGE_ERROR',
  message: 'Saving failed.',
  retryable: true,
};

function boundCall(context: unknown): string | null {
  return (context as CallContext | undefined)?.call.callSessionId ?? null;
}

const callState = (context: unknown) => (context as CallContext | undefined)?.call ?? null;

const callEnded: ToolError = {
  ok: false,
  code: 'CALL_ENDED',
  message: 'The caller has hung up.',
  retryable: false,
};
const hasEnded = (context: unknown) => callState(context)?.ended === true;

/** Triage in memory if storage fails, so reported hazards still get handled. */
function triageWithoutStorage(input: z.infer<typeof IntakeUpdate>, known: Priority | null) {
  const merged = mergeFacts(EMPTY_FACTS, input);
  if (!merged.ok) return null;
  const priority = latchPriority(known ?? { tier: null, reasons: [] }, assessPriority(merged.facts));
  if (priority.tier !== 'P0' && priority.tier !== 'P1') return null;
  const plan = planNextStep(merged.facts, priority, 'UNKNOWN');
  return { priority, plan };
}

const notBound: ToolError = {
  ok: false,
  code: 'NO_ACTIVE_CALL',
  message: 'Nothing can be saved on this call.',
  retryable: false,
};

const UpdateResult = toolResult(IntakeStatus);
// Return state; the prompt supplies the caller-facing wording.
const FinishResult = toolResult(z.strictObject({
  status: z.string(), followUpReason: z.string().nullable(), followUpReady: z.boolean(),
}));
const EscalateResult = toolResult(z.strictObject({ type: z.string(), status: z.string() }));
const BookResult = toolResult(
  z.strictObject({
    status: z.string(),
    appointment: z.string(),
    startAt: z.string(),
    followUpSaved: z.boolean(),
    rechecked: z.boolean(),
  }),
);
const FindResult = toolResult(z.strictObject({
  status: z.enum(['PROPOSED', 'NO_OPENING', 'UNAVAILABLE']),
  appointment: z.string().nullable(),
  startAt: z.string().nullable(),
  followUpSaved: z.boolean(),
}));

/** Server date for interpreting relative dates like "tomorrow." */
function today(): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date());
}

export function createTools(deps: { store: Store; calls: CallControl; calendar: CalendarClient; config: Config }) {
  const { store } = deps;
  const updateIntake = tool({
    name: 'update_intake',
    description:
      'Save facts the caller just gave or corrected. Use null for anything not mentioned; null never erases ' +
      'saved facts. Record safety signals only for danger happening now, not denied, past, or hypothetical ' +
      'mentions; use [] when the caller says there is none. Returns the priority and what to do next.',
    parameters: IntakeUpdate,
    strict: true,
    errorFunction: (runContext) => JSON.stringify(hasEnded(runContext?.context) ? callEnded : {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'Nothing was saved. Retry with only the new facts and valid schema values. For clear current danger, ' +
        'send only safetySignals, e.g. {"safetySignals":["FIRE_SMOKE"]} for a current fire, then follow nextAction. ' +
        'Do not ask intake questions or repeat failed arguments while handling current danger.',
      retryable: true,
    }),
    execute: async (input, runContext) => {
      if (hasEnded(runContext?.context)) return callEnded;
      const call = callState(runContext?.context);
      const callSessionId = boundCall(runContext?.context);
      try {
        if (!callSessionId) throw new Error('no saved call');
        // Count requests for a person once per caller turn, even if the model saves it twice.
        if (input.callerAskedForHuman && call) {
          if (call.humanAskTurn === call.callerTurn) input = { ...input, callerAskedForHuman: null };
          else call.humanAskTurn = call.callerTurn;
        }
        const result = applyIntakeUpdate(store, callSessionId, input);
        if (!result.ok) return result;
        const { plan: _plan, ...status } = result.data;
        if (call) call.priority = { tier: status.priorityTier, reasons: status.priorityReasons };
        return UpdateResult.parse({
          ok: true,
          data: { ...status, saved: true, today: status.nextAction === 'AGREE_VISIT_TIME' ||
            (status.missing.length === 1 && status.missing[0] === 'availability') ? today() : null },
        });
      } catch (error) {
        console.error(`update_intake failed: ${(error as Error).name}`);
        const urgent = triageWithoutStorage(input, call?.priority ?? null);
        if (!urgent || !call) return callSessionId ? storageError : notBound;
        call.priority = urgent.priority;
        return UpdateResult.parse({
          ok: true,
          data: {
            priorityTier: urgent.priority.tier,
            priorityReasons: urgent.priority.reasons,
            serviceAreaStatus: 'UNKNOWN',
            missing: [],
            nextAction: urgent.plan.nextAction,
            rejectedFields: [],
            saved: false,
            today: null,
          },
        });
      }
    },
  });

  const finish = tool({
    name: 'finish_intake',
    description:
      'Call once the next step says to, or when the caller wants to end the call. Saves the outcome ' +
      'from what was recorded; set callerDeclined if they do not want further help.',
    parameters: FinishIntakeInput,
    strict: true,
    execute: async (input, runContext) => {
      if (hasEnded(runContext?.context)) return callEnded;
      const callSessionId = boundCall(runContext?.context);
      if (!callSessionId) return notBound;
      try {
        const result = finishIntake(store, callSessionId, input.callerDeclined);
        if (!result.ok) return result;
        const call = callState(runContext?.context);
        if (call) call.finishedAt = Date.now();
        return FinishResult.parse({ ok: true, data: result.data });
      } catch (error) {
        console.error(`finish_intake failed: ${(error as Error).name}`);
        return storageError;
      }
    },
  });

  const escalate = tool({
    name: 'escalate_call',
    description:
      'Hand the call to the system for emergency guidance or an urgent human transfer. Only works ' +
      'when update_intake returned EMERGENCY_GUIDANCE or TRANSFER_TO_HUMAN; the backend decides which.',
    parameters: EscalateCallInput,
    strict: true,
    execute: async (_input, runContext) => {
      if (hasEnded(runContext?.context)) return callEnded;
      const call = callState(runContext?.context);
      if (!call?.callSid) return notBound;
      // Mute before escalation; restore speech only if the agent needs to handle a failure.
      call.agentMuted = true;
      try {
        const result = await escalateCall(deps, call as typeof call & { callSid: string });
        if (!result.ok) {
          call.agentMuted = false;
          return result;
        }
        call.handedOff = true;
        return EscalateResult.parse({ ok: true, data: result.data });
      } catch (error) {
        call.agentMuted = false;
        console.error(`escalate_call failed: ${(error as Error).name}`);
        return storageError;
      }
    },
  });

  const book = tool({
    name: 'book_urgent_visit',
    description:
      'Book the proposed urgent visit only after the caller confirms its date and time in a later turn. ' +
      'Rechecks the slot before writing. Repeating an uncertain booking checks the same event; never duplicates it.',
    parameters: BookUrgentVisitInput,
    strict: true,
    execute: async (input, runContext) => {
      if (hasEnded(runContext?.context)) return callEnded;
      const callSessionId = boundCall(runContext?.context);
      if (!callSessionId) return notBound;
      try {
        const call = callState(runContext?.context);
        const proposed = call?.proposedVisit ?? null;
        const result = await bookUrgentVisit(
          deps,
          callSessionId,
          input,
          proposed && call ? { startAt: proposed.startAt, callerSpokeSince: call.callerTurn > proposed.turn } : null,
        );
        if (!result.ok) {
          if (result.code !== 'CALENDAR_UNAVAILABLE') return result;
          const followUpSaved = saveReadyFollowUp(store, callSessionId) === 'UNBOOKED';
          return BookResult.parse({ ok: true, data: {
            status: 'FAILED', appointment: '', startAt: input.startAt, followUpSaved, rechecked: false,
          } });
        }
        if (call && result.data.status === 'PROPOSED') {
          call.proposedVisit = { startAt: result.data.startAt, turn: call.callerTurn };
        }
        return BookResult.parse({ ok: true, data: result.data });
      } catch (error) {
        console.error(`book_urgent_visit failed: ${(error as Error).name}`);
        return { ...storageError, message: 'The booking could not be made.' };
      }
    },
  });

  const findTime = tool({
    name: 'find_visit_time',
    description:
      'Save caller availability and find the earliest open one-hour urgent visit within their approved windows. ' +
      'Requires confirmed contact details and an in-area urgent request. PROPOSED is not booked; read it back and await a yes.',
    parameters: FindVisitTimeInput,
    strict: true,
    execute: async (input, runContext) => {
      if (hasEnded(runContext?.context)) return callEnded;
      const callSessionId = boundCall(runContext?.context);
      if (!callSessionId) return notBound;
      try {
        const saved = applyIntakeUpdate(store, callSessionId, IntakeUpdate.parse({ availabilityNotes: input.availabilityNotes }));
        if (!saved.ok) return saved;
        const call = callState(runContext?.context);
        if (call) call.proposedVisit = null;
        const result = await findVisitTime(deps, callSessionId, input.windows);
        if (hasEnded(runContext?.context)) return callEnded;
        if (!result.ok) {
          if (result.code !== 'CALENDAR_UNAVAILABLE') return result;
          const followUpSaved = saveReadyFollowUp(store, callSessionId) === 'UNBOOKED';
          return FindResult.parse({ ok: true, data: { status: 'UNAVAILABLE', appointment: null, startAt: null, followUpSaved } });
        }
        const slot = result.value;
        if (call && slot) call.proposedVisit = { startAt: new Date(slot.startAt).toISOString(), turn: call.callerTurn };
        return FindResult.parse({ ok: true, data: {
          status: slot ? 'PROPOSED' : 'NO_OPENING',
          appointment: slot ? formatVisitTime(slot.startAt) : null,
          startAt: slot?.startAt ?? null,
          followUpSaved: false,
        } });
      } catch (error) {
        console.error(`find_visit_time failed: ${(error as Error).name}`);
        return storageError;
      }
    },
  });

  return [updateIntake, finish, escalate, book, findTime];
}
