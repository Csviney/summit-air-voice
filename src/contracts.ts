import { z } from 'zod';

// Types, tool inputs, and results share these Zod schemas.

export const Intent = z.enum(['HVAC_SERVICE', 'OTHER', 'UNKNOWN']);
export const PropertyType = z.enum(['RESIDENTIAL', 'COMMERCIAL', 'UNKNOWN']);
export const IssueCategory = z.enum([
  'NO_HEAT', 'NO_COOLING', 'MAINTENANCE', 'GAS_ODOR', 'CO_CONCERN',
  'WATER_LEAK', 'THERMOSTAT', 'EQUIPMENT_NOISE', 'OTHER', 'UNKNOWN',
]);
export const SystemImpact = z.enum(['COMPLETE_OUTAGE', 'PARTIAL', 'NONE', 'UNKNOWN']);
export const TemperatureRisk = z.enum(['UNSAFE_HEAT', 'UNSAFE_COLD', 'NONE_REPORTED', 'UNKNOWN']);
export const VulnerableOccupant = z.enum(['ELDERLY', 'INFANT', 'MEDICAL_RISK', 'OTHER']);
export const SafetySignal = z.enum([
  'GAS_ODOR', 'CO_CONCERN', 'FIRE_SMOKE', 'ELECTRICAL_DANGER', 'MEDICAL_EMERGENCY',
]);
export const BusinessImpact = z.enum(['OPERATIONS_STOPPED', 'DEGRADED', 'NONE', 'UNKNOWN']);
export const PriorityTier = z.enum(['P0', 'P1', 'P2', 'P3', 'P4']);
export const ServiceAreaStatus = z.enum(['IN_AREA', 'OUT_OF_AREA', 'UNKNOWN']);
export const RequestStatus = z.enum(['OPEN', 'FOLLOW_UP_PENDING', 'BOOKED', 'ESCALATED', 'CLOSED_UNBOOKED']);
export const CallStatus = z.enum(['ACTIVE', 'TRANSFERRING', 'ENDED', 'FAILED']);
export const CallOutcome = z.enum([
  'BOOKED', 'FOLLOW_UP', 'TRANSFERRED', 'EMERGENCY_GUIDANCE', 'DECLINED', 'INCOMPLETE',
]);
export const TranscriptState = z.enum(['CAPTURING', 'COMPLETE_AI_LEG', 'PARTIAL']);

const text = (max: number) => z.string().trim().min(1).max(max);

// The model sometimes omits unchanged fields despite the schema. Treat them as null;
// unknown fields are still rejected.
function omittedAsNull<T extends z.ZodObject>(schema: T) {
  const keys = Object.keys(schema.shape);
  return z.preprocess(
    (value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? { ...Object.fromEntries(keys.map((key) => [key, null])), ...value }
        : value,
    schema,
  );
}

const AddressFields = z.strictObject({
  line1: text(200).nullable(),
  unit: text(50).nullable(),
  city: text(100).nullable(),
  state: text(50).nullable(),
  postalCode: text(20).nullable(),
  county: text(100).nullable(),
});
export const Address = omittedAsNull(AddressFields);

/** Persisted intake. `null` means not captured; for the arrays, `[]` means explicitly none. */
export const IntakeFacts = z.strictObject({
  intent: Intent,
  callerName: text(120).nullable(),
  callbackPhone: z.string().regex(/^\+1\d{10}$/).nullable(),
  propertyType: PropertyType,
  address: Address.nullable(),
  issueCategory: IssueCategory,
  issueSummary: text(500).nullable(),
  systemImpact: SystemImpact,
  temperatureRisk: TemperatureRisk,
  vulnerableOccupants: z.array(VulnerableOccupant).nullable(),
  safetySignals: z.array(SafetySignal).nullable(),
  businessImpact: BusinessImpact,
  availabilityNotes: text(300).nullable(),
  /** Each contact detail is read back and confirmed by the caller on its own. */
  nameConfirmed: z.boolean().default(false),
  phoneConfirmed: z.boolean().default(false),
  addressConfirmed: z.boolean().default(false),
  /** All three confirmed; derived, never set directly. */
  detailsConfirmed: z.boolean(),
  triageEvidence: text(300).nullable(),
  /** Separate caller turns in which the caller asked for a person; backend-counted. */
  humanRequests: z.number().int().min(0).default(0),
});
export type IntakeFacts = z.infer<typeof IntakeFacts>;

export const EMPTY_FACTS: IntakeFacts = {
  intent: 'UNKNOWN',
  callerName: null,
  callbackPhone: null,
  propertyType: 'UNKNOWN',
  address: null,
  issueCategory: 'UNKNOWN',
  issueSummary: null,
  systemImpact: 'UNKNOWN',
  temperatureRisk: 'UNKNOWN',
  vulnerableOccupants: null,
  safetySignals: null,
  businessImpact: 'UNKNOWN',
  availabilityNotes: null,
  nameConfirmed: false,
  phoneConfirmed: false,
  addressConfirmed: false,
  detailsConfirmed: false,
  triageEvidence: null,
  humanRequests: 0,
};

// Null means "not mentioned" and leaves saved facts intact. Phone numbers are normalized later.
const IntakeUpdateFields = z.strictObject({
  intent: Intent.nullable(),
  callerName: text(120).nullable(),
  callbackPhone: text(40).nullable(),
  propertyType: PropertyType.nullable(),
  address: Address.nullable(),
  issueCategory: IssueCategory.nullable().describe(
    'Service issue only. Fire, smoke, electrical danger, and medical emergencies belong in safetySignals, not here.',
  ),
  issueSummary: text(500).nullable(),
  systemImpact: SystemImpact.nullable().describe(
    'COMPLETE_OUTAGE only if the heating or cooling produces nothing at all; PARTIAL if it runs poorly.',
  ),
  // Risk descriptions require explicit caller statements to avoid false emergency transfers.
  temperatureRisk: TemperatureRisk.nullable().describe(
    'UNSAFE_HEAT or UNSAFE_COLD only if the caller says the indoor temperature is dangerous or is ' +
      'harming someone. "Hot", "cold", or "uncomfortable" alone is NONE_REPORTED. If unsure, ask.',
  ),
  vulnerableOccupants: z.array(VulnerableOccupant).nullable().describe(
    'Only people the caller says are present: elderly, infant, or medically vulnerable. [] if the caller ' +
      'says no one like that is there. Never infer from voice or age guesses.',
  ),
  safetySignals: z.array(SafetySignal).nullable().describe(
    'Only danger happening now (gas smell, CO alarm, fire or smoke, sparking, medical emergency). ' +
      '[] if the caller says there is none. Denied, past, or hypothetical mentions are not signals.',
  ),
  businessImpact: BusinessImpact.nullable().describe(
    'OPERATIONS_STOPPED only if the caller says the failure has stopped their business from operating.',
  ),
  availabilityNotes: text(300).nullable(),
  nameConfirmed: z.boolean().nullable().describe('True once the caller says yes to the name and spelling you read back.'),
  phoneConfirmed: z.boolean().nullable().describe('True once the caller says yes to the number you read back.'),
  addressConfirmed: z.boolean().nullable().describe('True once the caller says yes to the address you read back.'),
  /** Shorthand for confirming all three at once. */
  detailsConfirmed: z.boolean().nullable(),
  triageEvidence: text(300).nullable(),
  callerAskedForHuman: z
    .boolean()
    .nullable()
    .describe('True only when the caller asks, in what they just said, to speak with a person.'),
});
export const IntakeUpdate = omittedAsNull(IntakeUpdateFields);

export type IntakeUpdate = z.infer<typeof IntakeUpdate>;

// Report only known schema fields and error codes, never rejected values or unknown keys.
export function intakeValidationIssues(raw: string): { field: string; code: string }[] {
  try {
    const parsed = IntakeUpdate.safeParse(JSON.parse(raw));
    if (parsed.success) return [];
    const fields = new Set([...Object.keys(IntakeUpdateFields.shape), ...Object.keys(AddressFields.shape)]);
    return parsed.error.issues.map((issue) => ({
      field: issue.path.filter((part) => typeof part === 'string' && fields.has(part)).join('.') || 'input',
      code: issue.code,
    }));
  } catch {
    return [{ field: 'input', code: 'invalid_json' }];
  }
}

// An omitted callerDeclined means "not declined": declining must be explicit.
export const FinishIntakeInput = z.preprocess(
  (value) => (value && typeof value === 'object' ? { callerDeclined: false, ...value } : value),
  z.strictObject({ callerDeclined: z.boolean() }),
);

/** What the backend permits next; the model never chooses tiers or actions itself. */
export const NextAction = z.enum([
  'EMERGENCY_GUIDANCE',
  'TRANSFER_TO_HUMAN',
  'CLARIFY_REQUEST',
  'ASK_TRIAGE_QUESTIONS',
  'COLLECT_DETAILS',
  'CONFIRM_NAME',
  'CONFIRM_PHONE',
  'CONFIRM_ADDRESS',
  'AGREE_VISIT_TIME',
  'SAVE_FOLLOW_UP',
  'VISIT_BOOKED',
]);
export type NextAction = z.infer<typeof NextAction>;

export const IntakeStatus = z.strictObject({
  priorityTier: PriorityTier.nullable(),
  priorityReasons: z.array(z.string()),
  serviceAreaStatus: ServiceAreaStatus,
  missing: z.array(z.string()),
  nextAction: NextAction,
  /** Fields dropped from this update as invalid; everything else was saved. */
  rejectedFields: z.array(z.string()),
  /** False when storage failed and the update was only triaged in memory. */
  saved: z.boolean(),
  /** Server date for interpreting availability and visit times. */
  today: z.string().nullable(),
});
export type IntakeStatus = z.infer<typeof IntakeStatus>;

export const ToolError = z.strictObject({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
export type ToolError = z.infer<typeof ToolError>;

export const toolResult = <T extends z.ZodType>(data: T) =>
  z.union([z.strictObject({ ok: z.literal(true), data }), ToolError]);

export type TranscriptTurn = {
  /** Realtime conversation item ID, or a server-generated ID for scripted messages. */
  itemId: string;
  /** Conversation order, assigned when the item first appears, not when its text arrives. */
  order: number;
  speaker: 'CALLER' | 'AGENT' | 'SYSTEM';
  /** Redacted. Empty while a transcription is still pending. */
  text: string;
  timestamp: string;
  /** The caller cut the agent off, so not all of this text was necessarily heard. */
  interrupted: boolean;
};

export type CallSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  twilioCallSid: string;
  fromPhone: string | null;
  startedAt: string;
  endedAt: string | null;
  status: z.infer<typeof CallStatus>;
  outcome: z.infer<typeof CallOutcome> | null;
  summary: string;
  transcriptState: z.infer<typeof TranscriptState>;
  transcript: TranscriptTurn[];
};

export type ServiceRequest = {
  id: string;
  createdAt: string;
  updatedAt: string;
  callSessionId: string;
  facts: IntakeFacts;
  serviceAreaStatus: z.infer<typeof ServiceAreaStatus>;
  priorityTier: z.infer<typeof PriorityTier> | null;
  priorityReasons: string[];
  status: z.infer<typeof RequestStatus>;
  followUpReason: string | null;
};

export const EscalationType = z.enum(['HUMAN_TRANSFER', 'EMERGENCY_GUIDANCE']);
export const EscalationStatus = z.enum(['INITIATED', 'CONNECTED', 'NO_ANSWER', 'BUSY', 'FAILED', 'GUIDANCE_ISSUED']);

export const EscalateCallInput = z.strictObject({});

export type Escalation = {
  id: string;
  createdAt: string;
  updatedAt: string;
  serviceRequestId: string;
  type: z.infer<typeof EscalationType>;
  reasonCodes: string[];
  status: z.infer<typeof EscalationStatus>;
  announcementIssuedAt: string | null;
  twilioChildCallSid: string | null;
  guidanceCode: string | null;
  failureCode: string | null;
  initiatedAt: string;
  endedAt: string | null;
};

export const BookUrgentVisitInput = z.strictObject({
  startAt: z.string().describe('Agreed start time, ISO-8601 with explicit UTC offset, e.g. 2026-10-05T09:00:00-04:00'),
  callerConfirmed: z
    .boolean()
    .describe('False to check and propose the time; true only after the caller confirmed that proposed time.'),
});

export const FindVisitTimeInput = z.strictObject({
  availabilityNotes: text(300).describe('Briefly preserve the days and times the caller offered.'),
  windows: z.array(z.strictObject({
    startAt: z.string().describe('Earliest allowed start, ISO-8601 with the Eastern offset for that date.'),
    endAt: z.string().describe('Latest allowed visit end on the same day; a one-hour visit must fit. Use 17:00 if available the rest of the day.'),
  })).min(1).max(10).describe('Caller-approved weekday windows, 08:00–17:00 Eastern. An exact requested time is a one-hour window; do not invent other days.'),
});

export type Booking = {
  id: string;
  createdAt: string;
  updatedAt: string;
  serviceRequestId: string;
  startAt: string;
  endAt: string;
  timezone: string;
  calendarId: string;
  calendarEventId: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN';
  confirmedAt: string | null;
  errorCode: string | null;
};
