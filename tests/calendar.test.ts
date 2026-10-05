import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bookUrgentVisit,
  earliestVisit,
  findVisitTime,
  googleCalendarClient,
  CalendarError,
  reconcileBookings,
  validateVisitTime,
  type CalendarClient,
  type CalendarEvent,
  type TimeWindow,
} from '../src/calendar.ts';
import { loadConfig } from '../src/config.ts';
import { applyIntakeUpdate, finishIntake } from '../src/intake.ts';
import { nextStep } from '../src/records.ts';
import { openStore, type Store } from '../src/store.ts';
import { CONTACT, PROVIDER_TEST_ENV, update } from './fixtures.ts';

const config = loadConfig({
  OPENAI_API_KEY: 'test-openai-key',
  OPENAI_REALTIME_MODEL: 'test-realtime-model',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  TWILIO_PUBLIC_BASE_URL: 'https://summit.example.test',
  DEMO_PASSWORD: 'test-demo-password',
  ...PROVIDER_TEST_ENV,
});

// Fixed reference: Friday, October 2, 2026, noon Eastern (EDT, UTC-04:00).
const NOW = new Date('2026-10-02T16:00:00Z');
// Booking tests use the real clock, so choose a future weekday.
const FUTURE_MONDAY_9AM = nextWeekdayAt9Eastern();

test('accepts a future weekday time inside visit hours with the correct Eastern offset', () => {
  assert.deepEqual(validateVisitTime('2026-10-05T09:00:00-04:00', NOW), {
    ok: true,
    value: { startAt: '2026-10-05T13:00:00.000Z', endAt: '2026-10-05T14:00:00.000Z' },
  });
  // Standard time in winter uses -05:00; 4 PM is the latest start for a one-hour visit.
  assert.ok(validateVisitTime('2027-01-11T16:00:00-05:00', NOW).ok);
});

test('rejects a wrong offset instead of booking a different hour than agreed', () => {
  for (const time of ['2026-10-05T09:00:00-05:00', '2026-10-05T13:00:00Z']) {
    const result = validateVisitTime(time, NOW);
    assert.equal(!result.ok && result.code, 'WRONG_TIMEZONE_OFFSET', time);
    assert.match(!result.ok ? result.message : '', /UTC-04:00/);
  }
});

test('rejects times outside the visit rules', () => {
  const code = (time: string) => {
    const result = validateVisitTime(time, NOW);
    return result.ok ? 'OK' : result.code;
  };
  assert.equal(code('2026-10-05T09:00:00'), 'INVALID_TIME_FORMAT');
  assert.equal(code('next monday at 9'), 'INVALID_TIME_FORMAT');
  assert.equal(code('2026-10-02T09:00:00-04:00'), 'TIME_IN_PAST');
  assert.equal(code('2026-10-03T10:00:00-04:00'), 'OUTSIDE_VISIT_HOURS'); // Saturday
  assert.equal(code('2026-10-05T07:59:00-04:00'), 'OUTSIDE_VISIT_HOURS');
  assert.equal(code('2026-10-05T16:01:00-04:00'), 'OUTSIDE_VISIT_HOURS');
});

/** A programmable calendar that records every call. */
function fakeCalendar(behave: {
  insert?: (event: CalendarEvent) => Promise<'CREATED' | 'ALREADY_EXISTS'>;
  get?: (eventId: string) => Promise<{ id: string } | null>;
  busy?: () => Promise<TimeWindow[]>;
} = {}) {
  const inserts: CalendarEvent[] = [];
  const gets: string[] = [];
  const calendar: CalendarClient = {
    busyTimes: async () => behave.busy ? behave.busy() : [],
    async insertEvent(_calendarId, event) {
      inserts.push(event);
      return behave.insert ? behave.insert(event) : 'CREATED';
    },
    async getEvent(_calendarId, eventId) {
      gets.push(eventId);
      return behave.get ? behave.get(eventId) : { id: eventId };
    },
  };
  return { calendar, inserts, gets };
}

/** An in-area residential outage with complete, confirmed intake. */
function qualifiedP2(store: Store = openStore(':memory:'), callSid = 'CA_P2') {
  const id = store.createCall(callSid, null);
  const result = applyIntakeUpdate(
    store,
    id,
    update({
      ...CONTACT,
      issueCategory: 'NO_COOLING',
      issueSummary: 'AC completely out',
      systemImpact: 'COMPLETE_OUTAGE',
      safetySignals: [],
      vulnerableOccupants: [],
      temperatureRisk: 'NONE_REPORTED',
    }),
  );
  assert.ok(result.ok);
  const confirmed = applyIntakeUpdate(store, id, update({ detailsConfirmed: true }));
  assert.ok(confirmed.ok);
  assert.equal(confirmed.data.nextAction, 'AGREE_VISIT_TIME');
  return { store, id };
}

/** Simulate confirmation after a proposal and another caller turn. */
const book = (store: Store, calendar: CalendarClient, id: string, startAt = FUTURE_MONDAY_9AM) =>
  bookUrgentVisit({ store, calendar, config }, id, { startAt, callerConfirmed: true }, {
    startAt: new Date(startAt).toISOString(),
    callerSpokeSince: true,
  });

test('a qualified P2 at a confirmed time creates one minimal event and is recorded as booked', async () => {
  const { store, id } = qualifiedP2();
  const { calendar, inserts } = fakeCalendar();
  const result = await book(store, calendar, id);
  assert.ok(result.ok);
  assert.equal(result.data.status, 'CONFIRMED');

  assert.equal(inserts.length, 1);
  const event = inserts[0]!;
  assert.match(event.id, /^sa[0-9a-f]{32}$/);
  assert.equal(event.location, '100 Example St, Raleigh, NC 27601, Wake County');
  assert.equal(new Date(event.end.dateTime).getTime() - new Date(event.start.dateTime).getTime(), 60 * 60_000);
  assert.equal(event.start.timeZone, 'America/New_York');
  assert.deepEqual(Object.keys(event).sort(), ['description', 'end', 'id', 'location', 'start', 'summary']);

  const record = store.getRecord(id)!;
  assert.equal(record.booking?.status, 'CONFIRMED');
  assert.equal(record.request?.status, 'BOOKED');
  assert.equal(record.session.outcome, 'BOOKED');
  assert.equal(nextStep(record).code, 'VISIT_CONFIRMED');
});

test('repeated booking calls never create a second event', async () => {
  const { store, id } = qualifiedP2();
  const { calendar, inserts, gets } = fakeCalendar();
  await book(store, calendar, id);
  const again = await book(store, calendar, id);
  assert.ok(again.ok);
  assert.equal(again.data.status, 'CONFIRMED');
  assert.equal(inserts.length, 1);
  assert.equal(gets.length, 0, 'a confirmed booking is answered from the record');
});

test('a duplicate call while the first write is in flight does not misreport or double-book', async () => {
  const { store, id } = qualifiedP2();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { calendar, inserts, gets } = fakeCalendar({ insert: async () => (await gate, 'CREATED') });
  const first = book(store, calendar, id);
  const second = await book(store, calendar, id);
  assert.ok(second.ok);
  assert.equal(second.data.status, 'PENDING');
  release();
  const done = await first;
  assert.ok(done.ok && done.data.status === 'CONFIRMED');
  assert.equal(inserts.length, 1);
  assert.equal(gets.length, 0);
});

test('a booking needs the same time proposed first and the caller to speak before confirming', async () => {
  const { store, id } = qualifiedP2();
  const { calendar, inserts } = fakeCalendar();
  const deps = { store, calendar, config };
  const proposedUtc = new Date(FUTURE_MONDAY_9AM).toISOString();

  // Proposing checks the time and writes nothing.
  const proposed = await bookUrgentVisit(deps, id, { startAt: FUTURE_MONDAY_9AM, callerConfirmed: false });
  assert.ok(proposed.ok);
  assert.equal(proposed.data.status, 'PROPOSED');
  assert.equal(proposed.data.startAt, proposedUtc);
  assert.match(proposed.data.appointment, /at 9:00 AM E[SD]T$/);

  const refused = [
    // Confirmed without any proposal.
    await bookUrgentVisit(deps, id, { startAt: FUTURE_MONDAY_9AM, callerConfirmed: true }),
    // Confirmed in the same turn it was proposed: the caller never had a chance to answer.
    await bookUrgentVisit(deps, id, { startAt: FUTURE_MONDAY_9AM, callerConfirmed: true }, { startAt: proposedUtc, callerSpokeSince: false }),
    // Confirmed for a different time than the one read back.
    await bookUrgentVisit(deps, id, { startAt: FUTURE_MONDAY_9AM.replace('T09:00', 'T11:00'), callerConfirmed: true }, { startAt: proposedUtc, callerSpokeSince: true }),
  ];
  for (const result of refused) assert.equal(!result.ok && result.code, 'CONFIRMATION_REQUIRED');
  assert.equal(inserts.length, 0);

  const booked = await book(store, calendar, id);
  assert.ok(booked.ok && booked.data.status === 'CONFIRMED');
  assert.equal(inserts.length, 1);
});

test('booking requires a qualifying request', async () => {
  const { calendar, inserts } = fakeCalendar();

  const cases: Array<[string, Parameters<typeof update>[0]]> = [
    ['P4 maintenance', { ...CONTACT, issueCategory: 'MAINTENANCE', safetySignals: [], detailsConfirmed: true }],
    ['P3 repair', { ...CONTACT, issueCategory: 'THERMOSTAT', safetySignals: [], detailsConfirmed: true }],
    ['"mark me urgent"', { ...CONTACT, issueCategory: 'EQUIPMENT_NOISE', safetySignals: [], triageEvidence: 'Wants urgent' }],
    ['P1 critical', { intent: 'HVAC_SERVICE', temperatureRisk: 'UNSAFE_HEAT' }],
  ];
  for (const [label, fields] of cases) {
    const other = openStore(':memory:');
    const otherId = other.createCall('CA_OTHER', null);
    assert.ok(applyIntakeUpdate(other, otherId, update(fields)).ok);
    const result = await book(other, calendar, otherId);
    assert.equal(!result.ok && result.code, 'NOT_BOOKABLE', label);
  }

  // Reject out-of-area requests and unconfirmed contact changes.
  const outOfArea = qualifiedP2(openStore(':memory:'));
  applyIntakeUpdate(outOfArea.store, outOfArea.id, update({ address: { line1: null, unit: null, city: 'Charlotte', state: null, postalCode: null, county: 'Mecklenburg' } }));
  applyIntakeUpdate(outOfArea.store, outOfArea.id, update({ detailsConfirmed: true }));
  const outside = await book(outOfArea.store, calendar, outOfArea.id);
  assert.equal(!outside.ok && outside.code, 'NOT_BOOKABLE');
  assert.match(!outside.ok ? outside.message : '', /outside the service area/);

  const changed = qualifiedP2(openStore(':memory:'));
  applyIntakeUpdate(changed.store, changed.id, update({ callbackPhone: '919-555-0111' }));
  const unreconfirmed = await book(changed.store, calendar, changed.id);
  assert.equal(!unreconfirmed.ok && unreconfirmed.code, 'NOT_BOOKABLE');

  assert.equal(inserts.length, 0);
});

test('a hazard reported before the write stops the booking', async () => {
  const { store, id } = qualifiedP2();
  applyIntakeUpdate(store, id, update({ safetySignals: ['GAS_ODOR'] }));
  const { calendar, inserts } = fakeCalendar();
  const result = await book(store, calendar, id);
  assert.equal(!result.ok && result.code, 'NOT_BOOKABLE');
  assert.equal(inserts.length, 0);
});

test('a hazard reported while the write is in flight is saved and wins over the booked state', async () => {
  const { store, id } = qualifiedP2();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let inserting!: () => void;
  const started = new Promise<void>((resolve) => (inserting = resolve));
  const { calendar } = fakeCalendar({ insert: async () => (inserting(), await gate, 'CREATED') });
  const pending = book(store, calendar, id);
  await started;

  const hazard = applyIntakeUpdate(store, id, update({ safetySignals: ['CO_CONCERN'] }));
  assert.ok(hazard.ok);
  assert.equal(hazard.data.nextAction, 'EMERGENCY_GUIDANCE');
  release();
  await pending;

  // The real event stays recorded, and the next update still routes to emergency handling.
  assert.equal(store.getRecord(id)!.booking?.status, 'CONFIRMED');
  const after = applyIntakeUpdate(store, id, update({ triageEvidence: 'CO alarm sounding' }));
  assert.ok(after.ok);
  assert.equal(after.data.priorityTier, 'P0');
  assert.equal(after.data.nextAction, 'EMERGENCY_GUIDANCE');
});

test('a booked request answers later updates with VISIT_BOOKED and keeps BOOKED on finish', async () => {
  const { store, id } = qualifiedP2();
  await book(store, fakeCalendar().calendar, id);
  const later = applyIntakeUpdate(store, id, update({ availabilityNotes: 'Gate code is on the door' }));
  assert.ok(later.ok);
  assert.equal(later.data.nextAction, 'VISIT_BOOKED');
  const finished = finishIntake(store, id, false);
  assert.ok(finished.ok);
  assert.equal(finished.data.status, 'BOOKED');
});

test('a timed-out write found by its event ID is confirmed without inserting again', async () => {
  const { store, id } = qualifiedP2();
  const { calendar, inserts, gets } = fakeCalendar({
    insert: async () => {
      throw new CalendarError('TIMEOUT');
    },
  });
  const result = await book(store, calendar, id);
  assert.ok(result.ok);
  assert.equal(result.data.status, 'CONFIRMED');
  assert.equal(inserts.length, 1);
  assert.deepEqual(gets, [inserts[0]!.id]);
});

test('a timed-out write that does not exist is not booked and becomes an urgent follow-up', async () => {
  const { store, id } = qualifiedP2();
  const { calendar } = fakeCalendar({
    insert: async () => {
      throw new CalendarError('HTTP', 503);
    },
    get: async () => null,
  });
  const result = await book(store, calendar, id);
  assert.ok(result.ok);
  assert.equal(result.data.status, 'FAILED');
  assert.equal(result.data.followUpSaved, true);
  const record = store.getRecord(id)!;
  assert.equal(record.request?.followUpReason, 'BOOKING_FAILED');
  assert.equal(record.session.outcome, 'FOLLOW_UP');
  assert.equal(nextStep(record).code, 'BOOKING_FAILED');
});

test('an unverifiable write stays UNKNOWN, never confirmed, until reconciliation finds it', async () => {
  const { store, id } = qualifiedP2();
  const outage = fakeCalendar({
    insert: async () => {
      throw new CalendarError('NETWORK');
    },
    get: async () => {
      throw new CalendarError('TIMEOUT');
    },
  });
  const result = await book(store, outage.calendar, id);
  assert.ok(result.ok);
  assert.equal(result.data.status, 'UNKNOWN');
  let record = store.getRecord(id)!;
  assert.equal(record.request?.followUpReason, 'BOOKING_UNCONFIRMED');
  assert.equal(nextStep(record).code, 'BOOKING_UNCONFIRMED');

  // Startup lookup finds the event that was written before the timeout.
  const recovered = fakeCalendar();
  await reconcileBookings({ store, calendar: recovered.calendar, config });
  assert.equal(recovered.inserts.length, 0);
  assert.deepEqual(recovered.gets, [outage.inserts[0]!.id]);
  record = store.getRecord(id)!;
  assert.equal(record.booking?.status, 'CONFIRMED');
  assert.equal(record.request?.status, 'BOOKED');
  assert.equal(record.session.outcome, 'BOOKED');
});

test('a definite rejection fails without a lookup, and a retry reuses the same event ID', async () => {
  const { store, id } = qualifiedP2();
  const rejected = fakeCalendar({
    insert: async () => {
      throw new CalendarError('HTTP', 403);
    },
  });
  const first = await book(store, rejected.calendar, id);
  assert.ok(first.ok);
  assert.equal(first.data.status, 'FAILED');
  assert.equal(rejected.gets.length, 0);

  // A saved follow-up must still allow a booking retry on this call.
  assert.equal(store.getRequestForCall(id)!.followUpReason, 'BOOKING_FAILED');
  // The caller picks another hour; the retry keeps the event ID but uses the new time.
  const laterTime = FUTURE_MONDAY_9AM.replace('T09:00', 'T11:00');
  const retry = fakeCalendar();
  const second = await book(store, retry.calendar, id, laterTime);
  assert.ok(second.ok && second.data.status === 'CONFIRMED');
  assert.equal(retry.inserts[0]!.id, rejected.inserts[0]!.id);
  assert.equal(retry.inserts[0]!.start.dateTime, new Date(laterTime).toISOString());
  assert.equal(store.getRecord(id)!.booking?.startAt, new Date(laterTime).toISOString());
  assert.equal(store.getRequestForCall(id)!.status, 'BOOKED');
});

test('an event that already exists from an earlier attempt counts as confirmed', async () => {
  const { store, id } = qualifiedP2();
  const { calendar } = fakeCalendar({ insert: async () => 'ALREADY_EXISTS' });
  const result = await book(store, calendar, id);
  assert.ok(result.ok && result.data.status === 'CONFIRMED');
});

test('two different callers cannot book overlapping times, including while the first write is pending', async () => {
  const store = openStore(':memory:');
  const first = qualifiedP2(store, 'CA_FIRST');
  const second = qualifiedP2(store, 'CA_SECOND');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { calendar, inserts } = fakeCalendar({ insert: async () => (await gate, 'CREATED') });
  const pending = book(store, calendar, first.id);
  const secondResult = await book(store, calendar, second.id);
  assert.equal(!secondResult.ok && secondResult.code, 'SLOT_UNAVAILABLE');
  release();
  assert.ok((await pending).ok);
  const again = await book(store, calendar, second.id);
  assert.equal(!again.ok && again.code, 'SLOT_UNAVAILABLE');
  assert.equal(inserts.length, 1);
});

/** The next weekday at least 3 days out, 9 AM Eastern, with that date's correct offset. */
function nextWeekdayAt9Eastern(): string {
  const day = new Date(Date.now() + 3 * 86_400_000);
  for (;;) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        timeZoneName: 'longOffset',
      })
        .formatToParts(day)
        .map((part) => [part.type, part.value]),
    );
    if (!['Sat', 'Sun'].includes(parts.weekday!)) {
      return `${parts.year}-${parts.month}-${parts.day}T09:00:00${parts.timeZoneName!.replace('GMT', '')}`;
    }
    day.setTime(day.getTime() + 86_400_000);
  }
}

test('a second call on an uncertain booking is a recheck by event ID, flagged as rechecked', async () => {
  const { store, id } = qualifiedP2();
  const outage = fakeCalendar({
    insert: async () => {
      throw new CalendarError('TIMEOUT');
    },
    get: async () => {
      throw new CalendarError('TIMEOUT');
    },
  });
  const first = await book(store, outage.calendar, id);
  assert.ok(first.ok);
  assert.deepEqual([first.data.status, first.data.rechecked], ['UNKNOWN', false]);

  const recheck = await book(store, outage.calendar, id);
  assert.ok(recheck.ok);
  assert.deepEqual([recheck.data.status, recheck.data.rechecked], ['UNKNOWN', true]);
  assert.equal(outage.inserts.length, 1, 'the recheck never inserts again');

  // If the recheck finds the event, the visit is confirmed.
  const found = fakeCalendar();
  const confirmed = await book(store, found.calendar, id);
  assert.ok(confirmed.ok);
  assert.deepEqual([confirmed.data.status, confirmed.data.rechecked], ['CONFIRMED', true]);
  assert.equal(found.inserts.length, 0);
});

const windowAt = (date: string, start = '08:00', end = '17:00', offset = '-04:00'): TimeWindow => ({
  startAt: `${date}T${start}:00${offset}`, endAt: `${date}T${end}:00${offset}`,
});

test('search picks the earliest gap on the earliest approved day, then moves to the next approved day', () => {
  const monday = windowAt('2026-10-05');
  const wednesday = windowAt('2026-10-07');
  const partlyBusy = [windowAt('2026-10-05', '08:00', '10:30'), windowAt('2026-10-05', '10:00', '11:00')];
  assert.deepEqual(earliestVisit([wednesday, monday], partlyBusy, NOW), {
    ok: true, value: windowAt('2026-10-05', '11:00', '12:00'),
  });
  assert.deepEqual(earliestVisit([wednesday, monday], [monday], NOW), {
    ok: true, value: windowAt('2026-10-07', '08:00', '09:00'),
  });
  assert.deepEqual(earliestVisit([monday], [monday], NOW), { ok: true, value: null });
});

test('search respects an exact requested time, window boundaries, Eastern offsets, and the current time', () => {
  const exact = windowAt('2026-10-05', '10:00', '11:00');
  assert.deepEqual(earliestVisit([exact], [windowAt('2026-10-05', '10:30', '11:00')], NOW), { ok: true, value: null });
  assert.deepEqual(earliestVisit([exact], [windowAt('2026-10-05', '09:00', '10:00')], NOW), { ok: true, value: exact });
  const winter = windowAt('2027-01-11', '16:00', '17:00', '-05:00');
  assert.deepEqual(earliestVisit([winter], [], NOW), { ok: true, value: winter });
  const past = earliestVisit([windowAt('2026-10-05')], [], new Date('2026-10-05T14:15:30Z'));
  assert.ok(past.ok);
  assert.equal(past.value?.startAt, '2026-10-05T10:16:00-04:00');
  for (const invalid of [windowAt('2026-10-03'), windowAt('2026-10-05', '16:00', '18:00'),
    windowAt('2026-10-05', '10:00', '10:30'), windowAt('2027-01-11', '10:00', '12:00', '-04:00')]) {
    assert.equal(earliestVisit([invalid], [], NOW).ok, false);
  }
});

test('calendar lookup follows pages, expands recurring events, blocks all-day events, and ignores free/cancelled events', async (t) => {
  const urls: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input);
    urls.push(url);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'test-token', expires_in: 3600 });
    if (!url.searchParams.has('pageToken')) return Response.json({
      kind: 'calendar#events', nextPageToken: 'next', items: [
        { start: { dateTime: '2026-10-05T09:00:00-04:00' }, end: { dateTime: '2026-10-05T10:00:00-04:00' } },
        { transparency: 'transparent' }, { status: 'cancelled' },
      ],
    });
    return Response.json({ kind: 'calendar#events', items: [
      { start: { date: '2026-11-01' }, end: { date: '2026-11-02' } },
    ] });
  });
  const busy = await googleCalendarClient(config.google).busyTimes('test/calendar', '2026-10-01T00:00:00Z', '2026-11-03T00:00:00Z');
  assert.deepEqual(busy, [
    { startAt: '2026-10-05T13:00:00.000Z', endAt: '2026-10-05T14:00:00.000Z' },
    { startAt: '2026-11-01T04:00:00.000Z', endAt: '2026-11-02T05:00:00.000Z' },
  ]);
  assert.equal(urls.length, 3);
  assert.equal(urls[1]!.searchParams.get('singleEvents'), 'true');
  assert.equal(urls[1]!.searchParams.get('timeZone'), 'America/New_York');
  assert.equal(urls[1]!.searchParams.get('fields'), 'kind,nextPageToken,items(status,transparency,start,end)');
  assert.equal(urls[2]!.searchParams.get('pageToken'), 'next');
});

test('an unreadable calendar is never reported as available', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string) =>
    input.includes('oauth2') ? Response.json({ access_token: 'test-token', expires_in: 3600 }) : Response.json({ unexpected: true }));
  const { store, id } = qualifiedP2();
  const result = await findVisitTime({ store, config, calendar: googleCalendarClient(config.google) }, id, [
    { startAt: FUTURE_MONDAY_9AM, endAt: FUTURE_MONDAY_9AM.replace('T09:', 'T17:') },
  ]);
  assert.equal(!result.ok && result.code, 'CALENDAR_UNAVAILABLE');
  assert.equal(store.getRecord(id)!.booking, null);
});

test('booking rechecks calendar conflicts before inserting', async () => {
  const { store, id } = qualifiedP2();
  const { calendar, inserts } = fakeCalendar({ busy: async () => [{
    startAt: FUTURE_MONDAY_9AM, endAt: FUTURE_MONDAY_9AM.replace('T09:', 'T10:'),
  }] });
  const result = await book(store, calendar, id);
  assert.equal(!result.ok && result.code, 'SLOT_UNAVAILABLE');
  assert.equal(inserts.length, 0);
});

test('search does not propose a second time when a visit is already booked', async () => {
  const { store, id } = qualifiedP2();
  const { calendar } = fakeCalendar();
  await book(store, calendar, id);
  const result = await findVisitTime({ store, calendar, config }, id, [{
    startAt: FUTURE_MONDAY_9AM, endAt: FUTURE_MONDAY_9AM.replace('T09:', 'T17:'),
  }]);
  assert.equal(!result.ok && result.code, 'NOT_BOOKABLE');
});

test('a hazard or hangup during a calendar lookup prevents a subsequent booking', async () => {
  for (const action of ['hazard', 'hangup']) {
    const { store, id } = qualifiedP2();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { calendar, inserts } = fakeCalendar({ busy: async () => (await gate, []) });
    const pending = book(store, calendar, id);
    if (action === 'hazard') applyIntakeUpdate(store, id, update({ safetySignals: ['GAS_ODOR'] }));
    else store.endCall(id);
    release();
    const result = await pending;
    assert.equal(!result.ok && result.code, action === 'hazard' ? 'NOT_BOOKABLE' : 'CALL_ENDED');
    assert.equal(inserts.length, 0);
  }
});
