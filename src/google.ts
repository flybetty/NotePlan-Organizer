import { OAuth2Client, type Credentials } from "google-auth-library";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import type { AppConfig } from "./config.js";
import type { CalendarCommitment, EmailThreadInput, GmailBacklogResult, GmailReadResult, GmailSyncState, ReviewDecision } from "./domain.js";

const INITIAL_THREAD_LIMIT_PER_QUERY = 100;
const THREAD_MESSAGE_LIMIT = 6;
const THREAD_CHARACTER_LIMIT = 24_000;
const BACKLOG_THREAD_LIMIT = 25;
const offsetFormatterByTimeZone = new Map<string, Intl.DateTimeFormat>();
const runtimeRequire = createRequire(import.meta.url);
type GoogleSdkClient = any;
type GmailMessage = any;

function gmailClient(auth: OAuth2Client): GoogleSdkClient {
  const { gmail } = runtimeRequire("googleapis/build/src/apis/gmail");
  return gmail({ version: "v1", auth });
}

function calendarClient(auth: OAuth2Client): GoogleSdkClient {
  const { calendar } = runtimeRequire("googleapis/build/src/apis/calendar");
  return calendar({ version: "v3", auth });
}

export class ReconnectRequiredError extends Error {
  constructor(message = "Google authorization must be renewed") {
    super(message);
    this.name = "ReconnectRequiredError";
  }
}

export interface GoogleDataGateway {
  authorizationUrl(): string;
  exchangeCode(code: string, state: string): Promise<void>;
  hasConnection(): Promise<boolean>;
  readRecentThreads(state: GmailSyncState | null): Promise<GmailReadResult>;
  readBacklogThreads(beforeEpoch: number | null): Promise<GmailBacklogResult>;
  readThreadsByIds(threadIds: string[]): Promise<EmailThreadInput[]>;
  readCalendar(date: string): Promise<CalendarCommitment[]>;
  applyReviewLabels(threadId: string, decision: ReviewDecision): Promise<void>;
}

class GoogleTokenStore {
  private clientPromise: Promise<GoogleSdkClient> | null = null;

  constructor(private readonly projectId: string, private readonly secretId: string) {}

  private get parent() {
    return `projects/${this.projectId}/secrets/${this.secretId}`;
  }

  private client(): Promise<GoogleSdkClient> {
    if (!this.clientPromise) this.clientPromise = Promise.resolve().then(() => {
      const { SecretManagerServiceClient } = runtimeRequire("@google-cloud/secret-manager");
      return new SecretManagerServiceClient();
    });
    return this.clientPromise;
  }

  async read(): Promise<Credentials | null> {
    try {
      const [version] = await (await this.client()).accessSecretVersion({ name: `${this.parent}/versions/latest` });
      const value = version.payload?.data?.toString();
      return value ? JSON.parse(value) as Credentials : null;
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 5) return null;
      throw error;
    }
  }

  async write(credentials: Credentials): Promise<void> {
    await (await this.client()).addSecretVersion({ parent: this.parent, payload: { data: Buffer.from(JSON.stringify(credentials)) } });
  }
}

function parseDateParts(value: string): { year: number; month: number; day: number } {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid date value: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function dateByAddingDays(date: string, days: number): string {
  const { year, month, day } = parseDateParts(date);
  const value = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  value.setUTCDate(value.getUTCDate() + days);
  const nextYear = value.getUTCFullYear();
  const nextMonth = String(value.getUTCMonth() + 1).padStart(2, "0");
  const nextDay = String(value.getUTCDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = offsetFormatterByTimeZone.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  offsetFormatterByTimeZone.set(timeZone, formatter);
  return formatter;
}

function offsetMinutesAt(instant: Date, timeZone: string): number {
  const raw = offsetFormatter(timeZone).formatToParts(instant).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const normalized = raw.replace("UTC", "GMT").replace("−", "-");
  if (normalized === "GMT") return 0;
  const match = normalized.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) throw new Error(`Unexpected timezone offset format: ${raw}`);
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes);
}

function zonedMidnightUtc(date: string, timeZone: string): Date {
  const { year, month, day } = parseDateParts(date);
  const baseUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let value = baseUtc;
  for (let index = 0; index < 4; index += 1) {
    const offsetMinutes = offsetMinutesAt(new Date(value), timeZone);
    const adjusted = baseUtc - offsetMinutes * 60_000;
    if (adjusted === value) break;
    value = adjusted;
  }
  return new Date(value);
}

export function utcDayRangeForTimeZone(date: string, timeZone: string): { startIso: string; endIso: string } {
  const start = zonedMidnightUtc(date, timeZone);
  const end = zonedMidnightUtc(dateByAddingDays(date, 1), timeZone);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function decodeBody(message: GmailMessage): string {
  const decode = (value?: string | null) => value ? Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";
  const walk = (part?: any): string => {
    if (!part) return "";
    if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
    return (part.parts ?? []).map(walk).filter(Boolean).join("\n");
  };
  return walk(message.payload) || message.snippet || "";
}

export function redactSecrets(content: string): string {
  return content
    .replace(/\b(?:api[_ -]?key|password|passcode|verification code|secret|token)\s*[:=]\s*[^\s<]{4,}/gi, "$1: [REDACTED]")
    .replace(/\b\d{6}\b/g, "[REDACTED-CODE]")
    .slice(0, 12_000);
}

function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((item: any) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export function isAssistantDigest(subject: string, from: string, to: string, ownerAccount: string): boolean {
  const owner = ownerAccount.trim().toLowerCase();
  return /^work plan\b/i.test(subject.trim()) && from.toLowerCase().includes(owner) && to.toLowerCase().includes(owner);
}

export function isSpamThread(messages: GmailMessage[]): boolean {
  return messages.some((message) => (message.labelIds ?? []).includes("SPAM"));
}

export class GoogleApiGateway implements GoogleDataGateway {
  private readonly tokenStore: GoogleTokenStore;

  constructor(private readonly config: AppConfig) {
    this.tokenStore = new GoogleTokenStore(config.GOOGLE_CLOUD_PROJECT, config.GOOGLE_TOKEN_SECRET);
  }

  private oauth() {
    return new OAuth2Client(this.config.GOOGLE_CLIENT_ID, this.config.GOOGLE_CLIENT_SECRET, this.config.GOOGLE_REDIRECT_URI);
  }

  authorizationUrl(): string {
    const issuedAt = Date.now().toString();
    const signature = createHmac("sha256", this.config.SERVICE_API_TOKEN).update(issuedAt).digest("hex");
    return this.oauth().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      state: `${issuedAt}.${signature}`,
      scope: [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/calendar.readonly",
      ],
    });
  }

  async exchangeCode(code: string, state: string): Promise<void> {
    const [issuedAt, suppliedSignature] = state.split(".");
    if (!issuedAt || !suppliedSignature || Date.now() - Number(issuedAt) > 10 * 60 * 1000) throw new Error("Expired or invalid OAuth state");
    const expected = createHmac("sha256", this.config.SERVICE_API_TOKEN).update(issuedAt).digest("hex");
    const supplied = Buffer.from(suppliedSignature);
    const valid = supplied.length === expected.length && timingSafeEqual(supplied, Buffer.from(expected));
    if (!valid) throw new Error("Expired or invalid OAuth state");
    const client = this.oauth();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      const existing = await this.tokenStore.read();
      if (!existing?.refresh_token) throw new ReconnectRequiredError("Google did not return an offline refresh token");
      tokens.refresh_token = existing.refresh_token;
    }
    await this.tokenStore.write(tokens);
  }

  async hasConnection(): Promise<boolean> {
    const credentials = await this.tokenStore.read();
    return Boolean(credentials?.refresh_token);
  }

  private async authorizedClient() {
    const credentials = await this.tokenStore.read();
    if (!credentials?.refresh_token) throw new ReconnectRequiredError();
    const client = this.oauth();
    client.setCredentials(credentials);
    client.on("tokens", async (tokens) => {
      const current = await this.tokenStore.read();
      await this.tokenStore.write({ ...current, ...tokens, refresh_token: tokens.refresh_token ?? current?.refresh_token });
    });
    try {
      await client.getAccessToken();
      return client;
    } catch (error) {
      if ((error as Error).message.includes("invalid_grant")) throw new ReconnectRequiredError();
      throw error;
    }
  }

  private async initialThreadIds(gmail: GoogleSdkClient): Promise<Set<string>> {
    const queries = [
      "newer_than:30d in:inbox -in:spam -category:promotions -category:social -category:forums -label:Assistant/Reviewed",
      "newer_than:90d in:sent -in:spam -label:Assistant/Reviewed",
    ];
    const threadIds = new Set<string>();
    for (const query of queries) {
      const response = await gmail.users.threads.list({ userId: "me", q: query, maxResults: INITIAL_THREAD_LIMIT_PER_QUERY });
      for (const thread of response.data.threads ?? []) if (thread.id) threadIds.add(thread.id);
    }
    return threadIds;
  }

  private async incrementalThreadIds(gmail: GoogleSdkClient, startHistoryId: string): Promise<{ threadIds: Set<string>; historyId: string }> {
    const threadIds = new Set<string>();
    let historyId = startHistoryId;
    let pageToken: string | undefined;
    do {
      const response = await gmail.users.history.list({ userId: "me", startHistoryId, historyTypes: ["messageAdded"], maxResults: 500, pageToken });
      for (const record of response.data.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          const threadId = added.message?.threadId;
          if (threadId) threadIds.add(threadId);
        }
      }
      historyId = response.data.historyId ?? historyId;
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return { threadIds, historyId };
  }

  private async fetchThreads(gmail: GoogleSdkClient, threadIds: Set<string>): Promise<EmailThreadInput[]> {
    const threads: EmailThreadInput[] = [];
    const ids = [...threadIds];
    for (let index = 0; index < ids.length; index += 10) {
      const batch = await Promise.all(ids.slice(index, index + 10).map(async (threadId): Promise<EmailThreadInput | null> => {
        const response = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
        const messages = response.data.messages ?? [];
        if (isSpamThread(messages)) return null;
        const latest = messages.at(-1);
        if (!latest) return null;
        const ownerAccount = this.config.WORK_GMAIL_ACCOUNT.toLowerCase();
        const sender = header(latest, "From");
        const subject = header(latest, "Subject");
        if (isAssistantDigest(subject, sender, header(latest, "To"), this.config.WORK_GMAIL_ACCOUNT)) return null;
        const latestReceived = [...messages].reverse().find((message) => !header(message, "From").toLowerCase().includes(ownerAccount));
        const content = messages
          .slice(-THREAD_MESSAGE_LIMIT)
          .map((message: GmailMessage) => {
            const from = header(message, "From");
            const to = header(message, "To");
            const sentAt = new Date(Number(message.internalDate ?? Date.now())).toISOString();
            const ownerMessage = from.toLowerCase().includes(ownerAccount);
            return `[${sentAt}] ${ownerMessage ? "MAILBOX OWNER" : "OTHER PERSON"}\nFrom: ${from}\nTo: ${to}\n${redactSecrets(decodeBody(message))}`;
          })
          .join("\n--- message ---\n")
          .slice(-THREAD_CHARACTER_LIMIT);
        return {
          threadId,
          sender,
          subject,
          sentByUser: sender.toLowerCase().includes(ownerAccount),
          latestAt: new Date(Number(latest.internalDate ?? Date.now())).toISOString(),
          latestReceivedAt: latestReceived ? new Date(Number(latestReceived.internalDate ?? Date.now())).toISOString() : null,
          content,
          sourceUrl: `https://mail.google.com/mail/#all/${threadId}`,
        };
      }));
      threads.push(...batch.filter((thread): thread is EmailThreadInput => thread !== null));
    }
    return threads;
  }

  async readRecentThreads(state: GmailSyncState | null): Promise<GmailReadResult> {
    const auth = await this.authorizedClient();
    const gmailApi = gmailClient(auth);
    if (state?.historyId) {
      try {
        const incremental = await this.incrementalThreadIds(gmailApi, state.historyId);
        return { threads: await this.fetchThreads(gmailApi, incremental.threadIds), historyId: incremental.historyId, mode: "incremental" };
      } catch (error) {
        if ((error as { code?: number }).code !== 404) throw error;
        const profile = await gmailApi.users.getProfile({ userId: "me" });
        const historyId = profile.data.historyId;
        if (!historyId) throw new Error("Gmail did not return a mailbox history ID");
        return { threads: await this.fetchThreads(gmailApi, await this.initialThreadIds(gmailApi)), historyId, mode: "fallback" };
      }
    }
    const profile = await gmailApi.users.getProfile({ userId: "me" });
    const historyId = profile.data.historyId;
    if (!historyId) throw new Error("Gmail did not return a mailbox history ID");
    return { threads: await this.fetchThreads(gmailApi, await this.initialThreadIds(gmailApi)), historyId, mode: "initial" };
  }

  async readBacklogThreads(beforeEpoch: number | null): Promise<GmailBacklogResult> {
    const auth = await this.authorizedClient();
    const gmailApi = gmailClient(auth);
    const nowEpoch = Math.floor(Date.now() / 1000);
    const upperBound = beforeEpoch ?? nowEpoch;
    const lowerBound = nowEpoch - 365 * 24 * 60 * 60;
    if (upperBound <= lowerBound) return { threads: [], nextBeforeEpoch: lowerBound, complete: true };
    const query = `{in:inbox in:sent} after:${lowerBound} before:${upperBound} -in:spam -category:promotions -category:social -category:forums -label:Assistant/Reviewed`;
    const response = await gmailApi.users.threads.list({ userId: "me", q: query, maxResults: BACKLOG_THREAD_LIMIT });
    const threadIds = new Set<string>((response.data.threads ?? []).map((thread: any) => thread.id).filter((id: unknown): id is string => typeof id === "string" && Boolean(id)));
    const threads = await this.fetchThreads(gmailApi, threadIds);
    const oldestEpoch = threads.length ? Math.min(...threads.map((thread) => Math.floor(new Date(thread.latestAt).getTime() / 1000))) - 1 : lowerBound;
    return {
      threads,
      nextBeforeEpoch: Math.max(oldestEpoch, lowerBound),
      complete: threads.length < BACKLOG_THREAD_LIMIT || oldestEpoch <= lowerBound,
    };
  }

  async readThreadsByIds(threadIds: string[]): Promise<EmailThreadInput[]> {
    const auth = await this.authorizedClient();
    const gmailApi = gmailClient(auth);
    return this.fetchThreads(gmailApi, new Set(threadIds));
  }

  async readCalendar(date: string): Promise<CalendarCommitment[]> {
    const auth = await this.authorizedClient();
    const calendarApi = calendarClient(auth);
    const range = utcDayRangeForTimeZone(date, this.config.TIME_ZONE);
    const commitments: CalendarCommitment[] = [];
    for (const calendarId of this.config.calendarIds) {
      const response = await calendarApi.events.list({
        calendarId,
        timeMin: range.startIso,
        timeMax: range.endIso,
        singleEvents: true,
        orderBy: "startTime",
        timeZone: this.config.TIME_ZONE,
      });
      for (const event of response.data.items ?? []) {
        if (event.transparency === "transparent" || !event.start?.dateTime || !event.end?.dateTime) continue;
        const isPrivate = this.config.privateCalendarIds.has(calendarId) || event.visibility === "private";
        commitments.push({
          id: `${calendarId}:${event.id}`,
          title: isPrivate ? "Personal commitment" : event.summary ?? "Busy",
          start: event.start.dateTime,
          end: event.end.dateTime,
          sourceUrl: event.htmlLink ?? null,
          private: isPrivate,
        });
      }
    }
    return commitments;
  }

  async applyReviewLabels(threadId: string, decision: ReviewDecision): Promise<void> {
    const auth = await this.authorizedClient();
    const gmailApi = gmailClient(auth);
    const existing = await gmailApi.users.labels.list({ userId: "me" });
    const labels = new Map<string, string>((existing.data.labels ?? []).flatMap((label: any) => label.name && label.id ? [[String(label.name), String(label.id)]] : []));
    const ensureLabel = async (name: string): Promise<string> => {
      const known = labels.get(name);
      if (known) return known;
      const created = await gmailApi.users.labels.create({ userId: "me", requestBody: { name, labelListVisibility: "labelShowIfUnread", messageListVisibility: "show" } });
      if (!created.data.id) throw new Error(`Could not create Gmail label ${name}`);
      labels.set(name, created.data.id);
      return created.data.id;
    };
    const names = decision === "waiting" ? ["Assistant/Waiting", "Assistant/Reviewed"] : ["complete", "ignore"].includes(decision) ? ["Assistant/Reviewed"] : ["Assistant/Action", "Assistant/Reviewed"];
    const addLabelIds = await Promise.all(names.map(ensureLabel));
    await gmailApi.users.threads.modify({ userId: "me", id: threadId, requestBody: { addLabelIds } });
  }

}
