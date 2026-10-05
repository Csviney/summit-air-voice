PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS call_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  twilio_call_sid TEXT NOT NULL UNIQUE,
  from_phone TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  outcome TEXT,
  summary TEXT NOT NULL DEFAULT '',
  transcript_state TEXT NOT NULL DEFAULT 'CAPTURING',
  transcript TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS service_requests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  call_session_id TEXT NOT NULL UNIQUE REFERENCES call_sessions (id) ON DELETE CASCADE,
  facts TEXT NOT NULL,
  service_area_status TEXT NOT NULL,
  priority_tier TEXT,
  priority_reasons TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  follow_up_reason TEXT
);

CREATE INDEX IF NOT EXISTS call_sessions_started_at ON call_sessions (started_at DESC);

CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  service_request_id TEXT NOT NULL REFERENCES service_requests (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  reason_codes TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  announcement_issued_at TEXT,
  twilio_child_call_sid TEXT,
  guidance_code TEXT,
  failure_code TEXT,
  initiated_at TEXT NOT NULL,
  ended_at TEXT,
  -- One attempt per request and type, so repeated tool calls cannot dial twice.
  UNIQUE (service_request_id, type)
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- One booking per request, so repeated tool calls cannot create a second event.
  service_request_id TEXT NOT NULL UNIQUE REFERENCES service_requests (id) ON DELETE CASCADE,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  -- Allocated before the insert and reused on every retry, so Google rejects duplicates.
  calendar_event_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  confirmed_at TEXT,
  error_code TEXT
);
