import { z } from 'zod';

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_REALTIME_MODEL: z.string().min(1),
  TWILIO_ACCOUNT_SID: z.string().regex(/^AC[0-9a-f]{32}$/),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_PHONE_NUMBER: z.string().regex(/^\+1\d{10}$/, 'E.164, e.g. +19195550100'),
  TWILIO_PUBLIC_BASE_URL: z.string().min(1),
  TRANSFER_PHONE_NUMBER: z.string().regex(/^\+1\d{10}$/, 'E.164, e.g. +19195550100'),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_TOKEN: z.string().min(1),
  GOOGLE_CALENDAR_ID: z.string().min(1),
  DEMO_PASSWORD: z.string().min(12),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default('var/summit-air.db'),
});

// Demo service area; county and state come from the caller and aren't verified.
export const SERVICE_AREA = { state: 'NC', counties: ['Wake', 'Durham', 'Orange'] } as const;
export const BUSINESS_TIMEZONE = 'America/New_York';
// Urgent visits must fit within weekday business hours.
export const VISIT_HOURS = { startMinute: 8 * 60, endMinute: 17 * 60 } as const;
export const VISIT_DURATION_MINUTES = 60;

export type Config = {
  openAiApiKey: string;
  realtimeModel: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  /** The only number critical calls are ever transferred to. */
  transferPhoneNumber: string;
  /** HTTPS origin Twilio calls; signatures are validated against this, never the Host header. */
  publicOrigin: string;
  google: { clientId: string; clientSecret: string; refreshToken: string; calendarId: string };
  demoPassword: string;
  port: number;
  databasePath: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid or missing environment variables: ${names.join(', ')}`);
  }
  const values = parsed.data;
  return {
    openAiApiKey: values.OPENAI_API_KEY,
    realtimeModel: values.OPENAI_REALTIME_MODEL,
    twilioAccountSid: values.TWILIO_ACCOUNT_SID,
    twilioAuthToken: values.TWILIO_AUTH_TOKEN,
    twilioPhoneNumber: values.TWILIO_PHONE_NUMBER,
    transferPhoneNumber: values.TRANSFER_PHONE_NUMBER,
    publicOrigin: parsePublicOrigin(values.TWILIO_PUBLIC_BASE_URL),
    google: {
      clientId: values.GOOGLE_CLIENT_ID,
      clientSecret: values.GOOGLE_CLIENT_SECRET,
      refreshToken: values.GOOGLE_REFRESH_TOKEN,
      calendarId: values.GOOGLE_CALENDAR_ID,
    },
    demoPassword: values.DEMO_PASSWORD,
    port: values.PORT,
    databasePath: values.DATABASE_PATH,
  };
}

function parsePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TWILIO_PUBLIC_BASE_URL must be a valid HTTPS origin.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'TWILIO_PUBLIC_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment.',
    );
  }
  return url.origin;
}
