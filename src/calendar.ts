import { BUSINESS_TIMEZONE, VISIT_DURATION_MINUTES, VISIT_HOURS, type Config } from './config.ts';
import type { Booking, ServiceRequest, ToolError } from './contracts.ts';
import { evaluate, refreshSummary } from './intake.ts';
import { formatAddress, formatVisitTime } from './records.ts';
import type { Store } from './store.ts';
import { z } from 'zod';

const TIMEOUT_MS = 8_000;

/** Distinguishes rejected writes from timeouts or errors where the result is uncertain. */
export class CalendarError extends Error {
  constructor(
    readonly kind: 'TIMEOUT' | 'NETWORK' | 'HTTP',
    readonly status?: number,
  ) {
    super(status ? `${kind} ${status}` : kind);
  }

  get definite(): boolean {
    return this.kind === 'HTTP' && this.status !== undefined && this.status < 500 && this.status !== 429;
  }
}

export type CalendarEvent = {
  id: string;
  summary: string;
  location: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
};

/** Calendar operations, replaced with a fake in tests. */
export type CalendarClient = {
  /** ALREADY_EXISTS means an earlier attempt with the same event ID was written. */
  insertEvent(calendarId: string, event: CalendarEvent): Promise<'CREATED' | 'ALREADY_EXISTS'>;
  /** Null when the event does not exist. */
  getEvent(calendarId: string, eventId: string): Promise<{ id: string } | null>;
  busyTimes(calendarId: string, startAt: string, endAt: string): Promise<TimeWindow[]>;
};

export type TimeWindow = { startAt: string; endAt: string };
const GoogleTime = z.object({ dateTime: z.string().optional(), date: z.string().optional() });
const GoogleEvents = z.object({
  kind: z.literal('calendar#events'),
  nextPageToken: z.string().optional(),
  items: z.array(z.object({
    status: z.string().optional(), transparency: z.string().optional(),
    start: GoogleTime.optional(), end: GoogleTime.optional(),
  })).default([]),
});

export function googleCalendarClient(google: Config['google']): CalendarClient {
  let token: { value: string; expiresAt: number } | null = null;

  async function request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new CalendarError((error as Error).name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK');
    }
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const response = await request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: google.clientId,
        client_secret: google.clientSecret,
        refresh_token: google.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!response.ok) throw new CalendarError('HTTP', response.status);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return token.value;
  }

  const eventsUrl = (calendarId: string) =>
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

  return {
    async insertEvent(calendarId, event) {
      const response = await request(`${eventsUrl(calendarId)}?sendUpdates=none`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
      if (response.status === 409) return 'ALREADY_EXISTS';
      if (!response.ok) throw new CalendarError('HTTP', response.status);
      return 'CREATED';
    },
    async getEvent(calendarId, eventId) {
      const response = await request(`${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`, {
        headers: { authorization: `Bearer ${await accessToken()}` },
      });
      if (response.status === 404 || response.status === 410) return null;
      if (!response.ok) throw new CalendarError('HTTP', response.status);
      return { id: eventId };
    },
    async busyTimes(calendarId, startAt, endAt) {
      const busy: TimeWindow[] = [];
      let pageToken = '';
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      // A bounded lookup; a truncated or unreadable calendar is never treated as free.
      for (let page = 0; page < 10; page += 1) {
        const query = new URLSearchParams({
          timeMin: startAt, timeMax: endAt, timeZone: BUSINESS_TIMEZONE,
          singleEvents: 'true', showDeleted: 'false', maxResults: '2500',
          fields: 'kind,nextPageToken,items(status,transparency,start,end)',
          ...(pageToken ? { pageToken } : {}),
        });
        const response = await request(`${eventsUrl(calendarId)}?${query}`, {
          headers: { authorization: `Bearer ${await accessToken()}` },
          signal,
        });
        if (!response.ok) throw new CalendarError('HTTP', response.status);
        const body = GoogleEvents.parse(await response.json());
        for (const event of body.items) {
          if (event.status === 'cancelled' || event.transparency === 'transparent') continue;
          const start = event.start?.dateTime ?? (event.start?.date ? easternMidnight(event.start.date) : '');
          const end = event.end?.dateTime ?? (event.end?.date ? easternMidnight(event.end.date) : '');
          if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) {
            throw new Error('Invalid calendar interval');
          }
          busy.push({ startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() });
        }
        if (!body.nextPageToken) return busy;
        pageToken = body.nextPageToken;
      }
      throw new Error('Calendar lookup exceeded page limit');
    },
  };
}

type Checked<T> = { ok: true; value: T } | ToolError;

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

function localParts(instant: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: BUSINESS_TIMEZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return {
    weekday: parts.weekday!,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    // "GMT-04:00" → "-04:00"
    offset: parts.timeZoneName!.replace('GMT', '') || '+00:00',
  };
}

/** Calendar all-day dates use local midnight, including across daylight-saving changes. */
function easternMidnight(date: string): string {
  let value = `${date}T00:00:00-05:00`;
  for (let i = 0; i < 2; i += 1) value = `${date}T00:00:00${localParts(new Date(value)).offset}`;
  return value;
}

function easternTime(instant: Date): string {
  const offset = localParts(instant).offset;
  const minutes = (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4))) * (offset[0] === '-' ? -1 : 1);
  return `${new Date(instant.getTime() + minutes * 60_000).toISOString().slice(0, 19)}${offset}`;
}

const overlaps = (a: TimeWindow, b: TimeWindow) =>
  Date.parse(a.startAt) < Date.parse(b.endAt) && Date.parse(b.startAt) < Date.parse(a.endAt);

/** Earliest one-hour opening inside caller-approved windows, ordered by date and time. */
export function earliestVisit(windows: TimeWindow[], busy: TimeWindow[], now: Date): Checked<TimeWindow | null> {
  const normalized: TimeWindow[] = [];
  for (const window of windows) {
    const start = validateVisitTime(window.startAt, new Date(0));
    if (!start.ok) return start;
    const end = new Date(window.endAt);
    if (!ISO_WITH_OFFSET.test(window.endAt) || !Number.isFinite(end.getTime()) ||
        window.startAt.slice(0, 10) !== window.endAt.slice(0, 10) ||
        window.endAt.slice(-6) !== localParts(end).offset ||
        localParts(end).minutes > VISIT_HOURS.endMinute ||
        Date.parse(window.endAt) - Date.parse(window.startAt) < VISIT_DURATION_MINUTES * 60_000) {
      return invalid('INVALID_WINDOW', 'Give a weekday window on one date, within 8 AM–5 PM Eastern, long enough for a one-hour visit.');
    }
    normalized.push({ startAt: start.value.startAt, endAt: end.toISOString() });
  }
  for (const window of normalized.sort((a, b) => a.startAt.localeCompare(b.startAt))) {
    let start = Math.max(Date.parse(window.startAt), Math.floor(now.getTime() / 60_000) * 60_000 + 60_000);
    for (const block of [...busy].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))) {
      const candidate = { startAt: new Date(start).toISOString(), endAt: new Date(start + VISIT_DURATION_MINUTES * 60_000).toISOString() };
      if (overlaps(candidate, block)) start = Math.ceil(Date.parse(block.endAt) / 60_000) * 60_000;
    }
    const end = start + VISIT_DURATION_MINUTES * 60_000;
    if (end <= Date.parse(window.endAt)) return { ok: true, value: { startAt: easternTime(new Date(start)), endAt: easternTime(new Date(end)) } };
  }
  return { ok: true, value: null };
}

export async function findVisitTime(deps: Deps, callSessionId: string, windows: TimeWindow[]) {
  const request = deps.store.getRequestForCall(callSessionId);
  if (!request) return invalid('NO_ACTIVE_REQUEST', 'No saved request exists.');
  const existing = deps.store.bookingFor(request.id);
  if (existing && existing.status !== 'FAILED') {
    return invalid('NOT_BOOKABLE', 'A booking already exists or is uncertain. Use book_urgent_visit to check its status before proposing another time.');
  }
  const { priority, area, plan } = evaluate(request, request.facts);
  if (plan.nextAction !== 'AGREE_VISIT_TIME') return invalid('NOT_BOOKABLE', notBookableReason(priority.tier, area, plan.missing));
  const checked = earliestVisit(windows, [], new Date());
  if (!checked.ok) return checked;
  if (!checked.value) return { ok: true as const, value: null };
  const startAt = new Date(Math.min(...windows.map((w) => Date.parse(w.startAt)))).toISOString();
  const endAt = new Date(Math.max(...windows.map((w) => Date.parse(w.endAt)))).toISOString();
  if (Date.parse(endAt) - Date.parse(startAt) > 31 * 86_400_000) return invalid('INVALID_WINDOW', 'Search days within one month at a time.');
  let busy: TimeWindow[];
  try {
    busy = await deps.calendar.busyTimes(deps.config.google.calendarId, startAt, endAt);
  } catch {
    return invalid('CALENDAR_UNAVAILABLE', 'Could not check the calendar. Nothing was booked.');
  }
  const current = deps.store.getRecord(callSessionId);
  if (current?.session.status !== 'ACTIVE') return invalid('CALL_ENDED', 'The call is no longer active.');
  if (!current.request || evaluate(current.request, current.request.facts).plan.nextAction !== 'AGREE_VISIT_TIME') {
    return invalid('NOT_BOOKABLE', 'The intake changed; follow its latest nextAction.');
  }
  return earliestVisit(windows, [...busy, ...deps.store.busyBookings(deps.config.google.calendarId, startAt, endAt, request.id)], new Date());
}

const invalid = (code: string, message: string): ToolError => ({ ok: false, code, message, retryable: true });

/** Checks an agreed time against the visit rules; never picks or adjusts a time itself. */
export function validateVisitTime(startAt: string, now: Date): Checked<{ startAt: string; endAt: string }> {
  if (!ISO_WITH_OFFSET.test(startAt)) {
    return invalid('INVALID_TIME_FORMAT', 'Send startAt as ISO-8601 with an explicit offset, e.g. 2026-10-05T09:00:00-04:00.');
  }
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return invalid('INVALID_TIME_FORMAT', 'That is not a real date and time.');

  // A wrong offset would silently book a different hour than the caller agreed to.
  const local = localParts(start);
  const given = startAt.endsWith('Z') ? '+00:00' : startAt.slice(-6);
  if (given !== local.offset) {
    return invalid(
      'WRONG_TIMEZONE_OFFSET',
      `On that date Eastern Time is UTC${local.offset}. Resend the same local time with offset ${local.offset}.`,
    );
  }
  if (start.getTime() <= now.getTime()) {
    return invalid('TIME_IN_PAST', 'That time has already passed. Ask the caller for a future time.');
  }
  const latestStart = VISIT_HOURS.endMinute - VISIT_DURATION_MINUTES;
  if (!WEEKDAYS.has(local.weekday) || local.minutes < VISIT_HOURS.startMinute || local.minutes > latestStart) {
    return invalid(
      'OUTSIDE_VISIT_HOURS',
      'Visits are one hour, on weekdays, between 8 AM and 5 PM Eastern, so the latest start is 4 PM. Ask for a time that fits.',
    );
  }
  const end = new Date(start.getTime() + VISIT_DURATION_MINUTES * 60_000);
  return { ok: true, value: { startAt: start.toISOString(), endAt: end.toISOString() } };
}

/** Location and minimal service/contact details only: no medical details, attendees, or meeting links. */
function eventFor(booking: Booking, request: ServiceRequest): CalendarEvent {
  const facts = request.facts;
  const issue = facts.issueCategory === 'UNKNOWN' ? 'service' : facts.issueCategory.toLowerCase().replaceAll('_', ' ');
  return {
    id: booking.calendarEventId,
    summary: `Summit Air urgent visit: ${issue}`,
    location: formatAddress(facts.address) ?? '',
    description: [
      `Caller: ${facts.callerName ?? 'not captured'}`,
      `Callback: ${facts.callbackPhone ?? 'not captured'}`,
      `Property: ${facts.propertyType.toLowerCase()}`,
      `Issue: ${facts.issueSummary ?? issue}`,
      'Booked by the Summit Air AI phone assistant.',
    ].join('\n'),
    start: { dateTime: booking.startAt, timeZone: booking.timezone },
    end: { dateTime: booking.endAt, timeZone: booking.timezone },
  };
}

export type BookingOutcome = {
  /** PROPOSED is a checked time awaiting caller confirmation, not a booking. */
  status: Booking['status'] | 'PROPOSED';
  appointment: string;
  /** UTC start used to match confirmation to the proposed time. */
  startAt: string;
  /** Whether an urgent follow-up was saved for this unconfirmed booking. */
  followUpSaved: boolean;
  /** True after looking up an uncertain booking by event ID. */
  rechecked: boolean;
};

type Deps = { store: Store; calendar: CalendarClient; config: Config };

// Don't recheck an event while its insert is running: "not found" could falsely mark it failed.
const inFlight = new Set<string>();

/** Server-tracked proposal and whether the caller has spoken since it was offered. */
export type Proposal = { startAt: string; callerSpokeSince: boolean } | null;

// Propose first; book only after a later caller turn confirms that same time.
// Recheck eligibility before writing the event.
export async function bookUrgentVisit(
  deps: Deps,
  callSessionId: string,
  input: { startAt: string; callerConfirmed: boolean },
  proposal: Proposal = null,
): Promise<{ ok: true; data: BookingOutcome } | ToolError> {
  const { store, config } = deps;
  const request = store.getRequestForCall(callSessionId);
  if (!request) return { ok: false, code: 'NO_ACTIVE_REQUEST', message: 'No saved request exists for this call.', retryable: false };

  const existing = store.bookingFor(request.id);
  if (existing?.status === 'CONFIRMED') return { ok: true, data: outcome(existing, false) };
  if (existing && inFlight.has(existing.id)) return { ok: true, data: outcome(existing, false) };
  if (existing && existing.status !== 'FAILED') {
    // Recheck uncertain bookings by ID; inserting again could create a duplicate.
    const { data } = await settleUncertain(deps, existing, request);
    return { ok: true, data: { ...data, rechecked: true } };
  }

  const { priority, area, plan } = evaluate(request, request.facts);
  if (plan.nextAction !== 'AGREE_VISIT_TIME') {
    return { ok: false, code: 'NOT_BOOKABLE', message: notBookableReason(priority.tier, area, plan.missing), retryable: false };
  }
  const time = validateVisitTime(input.startAt, new Date());
  if (!time.ok) return time;

  if (!input.callerConfirmed) {
    return {
      ok: true,
      data: { status: 'PROPOSED', appointment: formatVisitTime(time.value.startAt), startAt: time.value.startAt, followUpSaved: false, rechecked: false },
    };
  }
  if (!proposal || proposal.startAt !== time.value.startAt || !proposal.callerSpokeSince) {
    return invalid(
      'CONFIRMATION_REQUIRED',
      'Propose this exact time first (callerConfirmed false), read it back, and book only after the caller agrees.',
    );
  }

  let busy: TimeWindow[];
  try {
    busy = await deps.calendar.busyTimes(config.google.calendarId, time.value.startAt, time.value.endAt);
  } catch {
    return invalid('CALENDAR_UNAVAILABLE', 'Could not check the calendar. Save the request for follow-up; nothing was booked.');
  }
  // Intake can change or the caller can hang up while the calendar is being read.
  const current = store.getRecord(callSessionId);
  if (current?.session.status !== 'ACTIVE') return invalid('CALL_ENDED', 'The call is no longer active.');
  if (!current.request || evaluate(current.request, current.request.facts).plan.nextAction !== 'AGREE_VISIT_TIME') {
    return invalid('NOT_BOOKABLE', 'The intake changed; follow its latest nextAction.');
  }
  const concurrent = store.bookingFor(request.id);
  if (concurrent && concurrent.status !== 'FAILED') return { ok: true, data: outcome(concurrent, false) };
  if ([...busy, ...store.busyBookings(config.google.calendarId, time.value.startAt, time.value.endAt, request.id)]
      .some((block) => overlaps(time.value, block))) {
    return invalid('SLOT_UNAVAILABLE', 'That time is no longer open. Find another time within the caller’s availability and confirm it.');
  }

  // Reuse the booking and event ID when retrying a failed attempt.
  let booking: Booking;
  if (existing) {
    store.updateBooking(existing.id, { status: 'PENDING', ...time.value, errorCode: null });
    booking = { ...existing, status: 'PENDING', ...time.value };
  } else {
    booking = store.createBooking({
      serviceRequestId: request.id,
      ...time.value,
      timezone: BUSINESS_TIMEZONE,
      calendarId: config.google.calendarId,
    }).booking;
  }

  inFlight.add(booking.id);
  try {
    await deps.calendar.insertEvent(booking.calendarId, eventFor(booking, current.request));
    return { ok: true, data: confirm(store, booking) };
  } catch (error) {
    const failure = error instanceof CalendarError ? error : new CalendarError('NETWORK');
    if (failure.definite) return { ok: true, data: markNotBooked(store, booking, 'FAILED', failure.message) };
    console.error(`Booking ${booking.id}: calendar write uncertain (${failure.message}); checking by event ID.`);
    store.updateBooking(booking.id, { status: 'UNKNOWN', errorCode: failure.message });
    return settleUncertain(deps, { ...booking, status: 'UNKNOWN' }, request);
  } finally {
    inFlight.delete(booking.id);
  }
}

/** Gives the agent a specific reason the request isn't ready to book. */
function notBookableReason(tier: string | null, area: string, missing: string[]): string {
  if (tier === 'P0' || tier === 'P1') return 'This call needs emergency handling, not a booking.';
  if (tier !== 'P2') return 'Only urgent outages are booked; this request is saved for the team to review.';
  if (area === 'OUT_OF_AREA') return 'The address is outside the service area, so no visit can be booked.';
  return `Still needed before booking: ${missing.join(', ') || 'the caller confirming their details'}.`;
}

/** Looks up an uncertain write by event ID without inserting again. */
async function settleUncertain(
  { store, calendar }: Deps,
  booking: Booking,
  request: ServiceRequest,
): Promise<{ ok: true; data: BookingOutcome }> {
  try {
    const event = await calendar.getEvent(booking.calendarId, booking.calendarEventId);
    if (event) return { ok: true, data: confirm(store, booking) };
    return { ok: true, data: markNotBooked(store, booking, 'FAILED', 'NOT_FOUND_AFTER_UNCERTAIN_WRITE') };
  } catch (error) {
    const code = error instanceof CalendarError ? error.message : 'NETWORK';
    return { ok: true, data: markNotBooked(store, booking, 'UNKNOWN', code, request) };
  }
}

function confirm(store: Store, booking: Booking): BookingOutcome {
  store.updateBooking(booking.id, { status: 'CONFIRMED', confirmedAt: new Date().toISOString(), errorCode: null });
  const request = store.getRequest(booking.serviceRequestId);
  // Keep any emergency outcome set while this booking was in flight.
  if (request && request.status !== 'ESCALATED') {
    store.setRequestStatus(request.id, 'BOOKED', null);
    store.setOutcome(request.callSessionId, 'BOOKED');
  }
  if (request) refreshSummary(store, request.callSessionId);
  return outcome({ ...booking, status: 'CONFIRMED' }, false);
}

/** No agreed time, a failed write, or an unconfirmed write all mean priority follow-up. */
function markNotBooked(
  store: Store,
  booking: Booking,
  status: 'FAILED' | 'UNKNOWN',
  errorCode: string,
  known?: ServiceRequest,
): BookingOutcome {
  let followUpSaved = false;
  try {
    store.updateBooking(booking.id, { status, errorCode });
    const request = known ?? store.getRequest(booking.serviceRequestId);
    if (request && request.status !== 'ESCALATED') {
      store.setRequestStatus(request.id, 'FOLLOW_UP_PENDING', status === 'FAILED' ? 'BOOKING_FAILED' : 'BOOKING_UNCONFIRMED');
      store.setOutcome(request.callSessionId, 'FOLLOW_UP');
      refreshSummary(store, request.callSessionId);
      followUpSaved = true;
    }
  } catch (error) {
    console.error(`Booking ${booking.id}: could not record outcome (${(error as Error).name}).`);
  }
  return outcome({ ...booking, status }, followUpSaved);
}

const outcome = (booking: Booking, followUpSaved: boolean): BookingOutcome => ({
  status: booking.status,
  appointment: formatVisitTime(booking.startAt),
  startAt: booking.startAt,
  followUpSaved,
  rechecked: false,
});

/** On startup, settles bookings left pending or uncertain by a crash or provider timeout. */
export async function reconcileBookings(deps: Deps): Promise<void> {
  for (const booking of deps.store.unsettledBookings()) {
    const request = deps.store.getRequest(booking.serviceRequestId);
    if (!request) continue;
    const { data } = await settleUncertain(deps, booking, request);
    console.log(`Booking ${booking.id}: reconciled as ${data.status}.`);
  }
}
