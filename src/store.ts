import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  EMPTY_FACTS,
  IntakeFacts,
  type Booking,
  type CallSession,
  type Escalation,
  type ServiceRequest,
  type TranscriptTurn,
} from './contracts.ts';
import { redactSensitive } from './intake.ts';

export type CallRecord = {
  session: CallSession;
  request: ServiceRequest | null;
  escalations: Escalation[];
  booking: Booking | null;
};
export type Store = ReturnType<typeof openStore>;

type Row = Record<string, unknown>;

// Synchronous SQLite keeps each read-merge-write together within this process.
export function openStore(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

  const now = () => new Date().toISOString();

  const transaction = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const toSession = (row: Row): CallSession => ({
    id: row.id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    twilioCallSid: row.twilio_call_sid as string,
    fromPhone: (row.from_phone as string | null) ?? null,
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string | null) ?? null,
    status: row.status as CallSession['status'],
    outcome: (row.outcome as CallSession['outcome']) ?? null,
    summary: row.summary as string,
    transcriptState: row.transcript_state as CallSession['transcriptState'],
    transcript: JSON.parse(row.transcript as string) as TranscriptTurn[],
  });

  const toRequest = (row: Row): ServiceRequest => ({
    id: row.id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    callSessionId: row.call_session_id as string,
    // Validate stored facts before passing them to triage.
    facts: IntakeFacts.parse(JSON.parse(row.facts as string)),
    serviceAreaStatus: row.service_area_status as ServiceRequest['serviceAreaStatus'],
    priorityTier: (row.priority_tier as ServiceRequest['priorityTier']) ?? null,
    priorityReasons: JSON.parse(row.priority_reasons as string) as string[],
    status: row.status as ServiceRequest['status'],
    followUpReason: (row.follow_up_reason as string | null) ?? null,
  });

  const toEscalation = (row: Row): Escalation => ({
    id: row.id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    serviceRequestId: row.service_request_id as string,
    type: row.type as Escalation['type'],
    reasonCodes: JSON.parse(row.reason_codes as string) as string[],
    status: row.status as Escalation['status'],
    announcementIssuedAt: (row.announcement_issued_at as string | null) ?? null,
    twilioChildCallSid: (row.twilio_child_call_sid as string | null) ?? null,
    guidanceCode: (row.guidance_code as string | null) ?? null,
    failureCode: (row.failure_code as string | null) ?? null,
    initiatedAt: row.initiated_at as string,
    endedAt: (row.ended_at as string | null) ?? null,
  });

  const escalationsFor = (serviceRequestId: string) =>
    (db.prepare('SELECT * FROM escalations WHERE service_request_id = ? ORDER BY initiated_at').all(serviceRequestId) as Row[]).map(
      toEscalation,
    );

  const toBooking = (row: Row): Booking => ({
    id: row.id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    serviceRequestId: row.service_request_id as string,
    startAt: row.start_at as string,
    endAt: row.end_at as string,
    timezone: row.timezone as string,
    calendarId: row.calendar_id as string,
    calendarEventId: row.calendar_event_id as string,
    status: row.status as Booking['status'],
    confirmedAt: (row.confirmed_at as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
  });

  const bookingFor = (serviceRequestId: string): Booking | null => {
    const row = db.prepare('SELECT * FROM bookings WHERE service_request_id = ?').get(serviceRequestId) as Row | undefined;
    return row ? toBooking(row) : null;
  };

  const recordFor = (session: CallSession): CallRecord => {
    const request = getRequestForCall(session.id);
    return {
      session,
      request,
      escalations: request ? escalationsFor(request.id) : [],
      booking: request ? bookingFor(request.id) : null,
    };
  };

  const getSession = (id: string) => {
    const row = db.prepare('SELECT * FROM call_sessions WHERE id = ?').get(id) as Row | undefined;
    return row ? toSession(row) : null;
  };

  const getRequestForCall = (callSessionId: string) => {
    const row = db
      .prepare('SELECT * FROM service_requests WHERE call_session_id = ?')
      .get(callSessionId) as Row | undefined;
    return row ? toRequest(row) : null;
  };

  // Keep the existing outcome, or mark the call incomplete.
  // A stream closing doesn't end a transfer; pass includeTransferring: false in that case.
  const endCall = (
    callSessionId: string,
    { includeTransferring = true, failed = false }: { includeTransferring?: boolean; failed?: boolean } = {},
  ): void => {
    const at = now();
    const statuses = includeTransferring ? "('ACTIVE', 'TRANSFERRING')" : "('ACTIVE')";
    db.prepare(
      `UPDATE call_sessions SET updated_at = ?, ended_at = ?, status = ?,
         outcome = COALESCE(outcome, 'INCOMPLETE') WHERE id = ? AND status IN ${statuses}`,
    ).run(at, at, failed ? 'FAILED' : 'ENDED', callSessionId);
  };

  return {
    /** Creates the call and its empty request at call start; repeated webhooks are no-ops. */
    createCall(callSid: string, fromPhone: string | null): string {
      return transaction(() => {
        const existing = db
          .prepare('SELECT id FROM call_sessions WHERE twilio_call_sid = ?')
          .get(callSid) as { id: string } | undefined;
        if (existing) return existing.id;
        const id = randomUUID();
        const at = now();
        db.prepare(
          `INSERT INTO call_sessions (id, created_at, updated_at, twilio_call_sid, from_phone, started_at, status)
           VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
        ).run(id, at, at, callSid, fromPhone, at);
        db.prepare(
          `INSERT INTO service_requests (id, created_at, updated_at, call_session_id, facts, service_area_status, status)
           VALUES (?, ?, ?, ?, ?, 'UNKNOWN', 'OPEN')`,
        ).run(randomUUID(), at, at, id, JSON.stringify(EMPTY_FACTS));
        return id;
      });
    },

    findCallId(callSid: string): string | null {
      const row = db
        .prepare('SELECT id FROM call_sessions WHERE twilio_call_sid = ?')
        .get(callSid) as { id: string } | undefined;
      return row?.id ?? null;
    },

    getRequestForCall,

    getRequest(id: string): ServiceRequest | null {
      const row = db.prepare('SELECT * FROM service_requests WHERE id = ?').get(id) as Row | undefined;
      return row ? toRequest(row) : null;
    },

    getSession,

    /** Changes call status only from the expected state, so an ended call is never reopened. */
    transitionCall(callSessionId: string, from: CallSession['status'], to: CallSession['status']): boolean {
      const result = db
        .prepare('UPDATE call_sessions SET updated_at = ?, status = ? WHERE id = ? AND status = ?')
        .run(now(), to, callSessionId, from);
      return Number(result.changes) === 1;
    },

    /** Status-only write, so facts saved concurrently by update_intake are never overwritten. */
    setRequestStatus(id: string, status: ServiceRequest['status'], followUpReason: string | null): void {
      db.prepare('UPDATE service_requests SET updated_at = ?, status = ?, follow_up_reason = ? WHERE id = ?').run(
        now(),
        status,
        followUpReason,
        id,
      );
    },

    /** Reuses an escalation for the same request and type. */
    createEscalation(
      serviceRequestId: string,
      type: Escalation['type'],
      reasonCodes: string[],
    ): { escalation: Escalation; created: boolean } {
      const at = now();
      const result = db
        .prepare(
          `INSERT INTO escalations (id, created_at, updated_at, service_request_id, type, reason_codes, status, initiated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'INITIATED', ?) ON CONFLICT (service_request_id, type) DO NOTHING`,
        )
        .run(randomUUID(), at, at, serviceRequestId, type, JSON.stringify(reasonCodes), at);
      const row = db
        .prepare('SELECT * FROM escalations WHERE service_request_id = ? AND type = ?')
        .get(serviceRequestId, type) as Row;
      return { escalation: toEscalation(row), created: Number(result.changes) === 1 };
    },

    getEscalation(id: string): Escalation | null {
      const row = db.prepare('SELECT * FROM escalations WHERE id = ?').get(id) as Row | undefined;
      return row ? toEscalation(row) : null;
    },

    escalationsFor,

    bookingFor,

    busyBookings(calendarId: string, startAt: string, endAt: string, excludeRequestId: string) {
      return db.prepare(`SELECT start_at AS startAt, end_at AS endAt FROM bookings
        WHERE calendar_id = ? AND service_request_id <> ?
        AND status IN ('PENDING', 'CONFIRMED', 'UNKNOWN') AND start_at < ? AND end_at > ?`)
        .all(calendarId, excludeRequestId, endAt, startAt) as Array<{ startAt: string; endAt: string }>;
    },

    /** Reuses the request's booking to prevent duplicates. */
    createBooking(
      booking: Pick<Booking, 'serviceRequestId' | 'startAt' | 'endAt' | 'timezone' | 'calendarId'>,
    ): { booking: Booking; created: boolean } {
      const id = randomUUID();
      const at = now();
      // Google event IDs allow lowercase base32hex; a UUID's hex digits always qualify.
      const eventId = `sa${id.replaceAll('-', '')}`;
      const result = db
        .prepare(
          `INSERT INTO bookings (id, created_at, updated_at, service_request_id, start_at, end_at, timezone,
             calendar_id, calendar_event_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
           ON CONFLICT (service_request_id) DO NOTHING`,
        )
        .run(id, at, at, booking.serviceRequestId, booking.startAt, booking.endAt, booking.timezone, booking.calendarId, eventId);
      return { booking: bookingFor(booking.serviceRequestId)!, created: Number(result.changes) === 1 };
    },

    updateBooking(
      id: string,
      patch: Partial<Pick<Booking, 'status' | 'startAt' | 'endAt' | 'confirmedAt' | 'errorCode'>>,
    ): void {
      const columns: Record<string, string> = {
        status: 'status',
        startAt: 'start_at',
        endAt: 'end_at',
        confirmedAt: 'confirmed_at',
        errorCode: 'error_code',
      };
      const entries = Object.entries(patch).filter(([key]) => key in columns);
      if (!entries.length) return;
      db.prepare(
        `UPDATE bookings SET updated_at = ?, ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')} WHERE id = ?`,
      ).run(now(), ...entries.map(([, value]) => value ?? null), id);
    },

    /** Bookings whose calendar write may or may not have happened; reconciled on startup. */
    unsettledBookings(): Booking[] {
      return (db.prepare("SELECT * FROM bookings WHERE status IN ('PENDING', 'UNKNOWN')").all() as Row[]).map(toBooking);
    },

    updateEscalation(
      id: string,
      patch: Partial<
        Pick<Escalation, 'status' | 'announcementIssuedAt' | 'twilioChildCallSid' | 'guidanceCode' | 'failureCode' | 'endedAt'>
      >,
    ): void {
      const columns: Record<string, string> = {
        status: 'status',
        announcementIssuedAt: 'announcement_issued_at',
        twilioChildCallSid: 'twilio_child_call_sid',
        guidanceCode: 'guidance_code',
        failureCode: 'failure_code',
        endedAt: 'ended_at',
      };
      const entries = Object.entries(patch).filter(([key]) => key in columns);
      if (!entries.length) return;
      db.prepare(
        `UPDATE escalations SET updated_at = ?, ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')} WHERE id = ?`,
      ).run(now(), ...entries.map(([, value]) => value ?? null), id);
    },

    saveRequest(request: ServiceRequest): void {
      db.prepare(
        `UPDATE service_requests SET updated_at = ?, facts = ?, service_area_status = ?, priority_tier = ?,
           priority_reasons = ?, status = ?, follow_up_reason = ? WHERE id = ?`,
      ).run(
        now(),
        JSON.stringify(request.facts),
        request.serviceAreaStatus,
        request.priorityTier,
        JSON.stringify(request.priorityReasons),
        request.status,
        request.followUpReason,
        request.id,
      );
    },

    setOutcome(callSessionId: string, outcome: CallSession['outcome']): void {
      db.prepare('UPDATE call_sessions SET updated_at = ?, outcome = ? WHERE id = ?').run(
        now(),
        outcome,
        callSessionId,
      );
    },

    endCall,

    /** On startup, calls left active by a crash or restart cannot still be connected. */
    recoverStaleCalls(): string[] {
      const rows = db
        .prepare("SELECT id FROM call_sessions WHERE status IN ('ACTIVE', 'TRANSFERRING')")
        .all() as Array<{ id: string }>;
      for (const { id } of rows) endCall(id);
      // Transcription stopped mid-call, so whatever was captured is partial.
      db.prepare("UPDATE call_sessions SET transcript_state = 'PARTIAL' WHERE transcript_state = 'CAPTURING' AND status != 'ACTIVE'").run();
      return rows.map(({ id }) => id);
    },

    // Redact each turn before saving. Late text updates the same turn without changing its order.
    upsertTranscriptTurn(
      callSessionId: string,
      turn: Pick<TranscriptTurn, 'itemId' | 'speaker'> & Partial<Pick<TranscriptTurn, 'text' | 'interrupted'>>,
    ): void {
      transaction(() => {
        const row = db.prepare('SELECT transcript FROM call_sessions WHERE id = ?').get(callSessionId) as
          | { transcript: string }
          | undefined;
        if (!row) return;
        const turns = JSON.parse(row.transcript) as TranscriptTurn[];
        const existing = turns.find((t) => t.itemId === turn.itemId);
        const text = turn.text === undefined ? undefined : redactSensitive(turn.text);
        if (existing) {
          if (text !== undefined) existing.text = text;
          if (turn.interrupted) existing.interrupted = true;
        } else {
          turns.push({
            itemId: turn.itemId,
            order: turns.reduce((max, t) => Math.max(max, t.order), 0) + 1,
            speaker: turn.speaker,
            text: text ?? '',
            timestamp: now(),
            interrupted: turn.interrupted ?? false,
          });
        }
        db.prepare('UPDATE call_sessions SET transcript = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(turns),
          now(),
          callSessionId,
        );
      });
    },

    setTranscriptState(callSessionId: string, state: CallSession['transcriptState']): void {
      db.prepare('UPDATE call_sessions SET transcript_state = ? WHERE id = ?').run(state, callSessionId);
    },

    saveSummary(callSessionId: string, summary: string): void {
      db.prepare('UPDATE call_sessions SET summary = ? WHERE id = ?').run(summary, callSessionId);
    },

    getRecord(callSessionId: string): CallRecord | null {
      const session = getSession(callSessionId);
      return session ? recordFor(session) : null;
    },

    listRecords(limit = 50): CallRecord[] {
      const rows = db
        .prepare('SELECT * FROM call_sessions ORDER BY started_at DESC LIMIT ?')
        .all(limit) as Row[];
      return rows.map((row) => recordFor(toSession(row)));
    },

    /** Explicit local cleanup for synthetic demo data. */
    deleteAll(): number {
      const result = db.prepare('DELETE FROM call_sessions').run();
      return Number(result.changes);
    },

    close(): void {
      db.close();
    },
  };
}
