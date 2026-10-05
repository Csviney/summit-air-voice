import { EMPTY_FACTS, type IntakeFacts, type IntakeUpdate } from '../src/contracts.ts';

// Synthetic demo data only.

const NO_UPDATE: IntakeUpdate = {
  intent: null,
  callerName: null,
  callbackPhone: null,
  propertyType: null,
  address: null,
  issueCategory: null,
  issueSummary: null,
  systemImpact: null,
  temperatureRisk: null,
  vulnerableOccupants: null,
  safetySignals: null,
  businessImpact: null,
  availabilityNotes: null,
  nameConfirmed: null,
  phoneConfirmed: null,
  addressConfirmed: null,
  detailsConfirmed: null,
  triageEvidence: null,
  callerAskedForHuman: null,
};

/** A full tool input where everything not given is null ("not mentioned"). */
export const update = (fields: Partial<IntakeUpdate>): IntakeUpdate => ({ ...NO_UPDATE, ...fields });

export const facts = (fields: Partial<IntakeFacts>): IntakeFacts => ({ ...EMPTY_FACTS, ...fields });

/** Every contact detail read back and confirmed by the caller. */
export const ALL_CONFIRMED = { nameConfirmed: true, phoneConfirmed: true, addressConfirmed: true, detailsConfirmed: true } as const;

export const IN_AREA_ADDRESS = {
  line1: '100 Example St',
  unit: null,
  city: 'Raleigh',
  state: 'NC',
  postalCode: '27601',
  county: 'Wake',
};

/** Everything a residential caller provides once triage questions are answered. */
export const CONTACT = {
  intent: 'HVAC_SERVICE',
  propertyType: 'RESIDENTIAL',
  callerName: 'Test Caller',
  callbackPhone: '(919) 555-0100',
  address: IN_AREA_ADDRESS,
  availabilityNotes: 'Weekday mornings',
} as const;

/** Synthetic provider settings for config validation; nothing here reaches Twilio or Google. */
export const PROVIDER_TEST_ENV = {
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_PHONE_NUMBER: '+15555550100',
  TRANSFER_PHONE_NUMBER: '+15555550199',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REFRESH_TOKEN: 'test-refresh-token',
  GOOGLE_CALENDAR_ID: 'test-calendar@example.test',
};

/** A calendar that never answers; for tests that must not book. */
export const UNUSED_CALENDAR = {
  insertEvent: async (): Promise<'CREATED'> => {
    throw new Error('unexpected calendar write');
  },
  getEvent: async () => null,
  busyTimes: async (): Promise<never> => { throw new Error('unexpected calendar lookup'); },
};
