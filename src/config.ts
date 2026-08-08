import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  PUBLIC_BASE_URL: z.string().url(),
  GOOGLE_CLOUD_PROJECT: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),
  GOOGLE_TOKEN_SECRET: z.string().default("work-assistant-google-token"),
  WORK_GMAIL_ACCOUNT: z.string().email(),
  CALENDAR_IDS: z.string().default("primary"),
  PRIVATE_CALENDAR_IDS: z.string().default(""),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default("gpt-5-mini"),
  SERVICE_API_TOKEN: z.string().min(24),
  JOB_SECRET: z.string().min(24),
  TIME_ZONE: z.string().default("America/Vancouver"),
  WORKDAY_START: z.coerce.number().int().min(0).max(23).default(9),
  WORKDAY_END: z.coerce.number().int().min(1).max(24).default(17),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(environment);
  return {
    ...parsed,
    calendarIds: parsed.CALENDAR_IDS.split(",").map((value) => value.trim()).filter(Boolean),
    privateCalendarIds: new Set(parsed.PRIVATE_CALENDAR_IDS.split(",").map((value) => value.trim()).filter(Boolean)),
  };
}
