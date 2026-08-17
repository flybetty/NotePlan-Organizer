export type SourceStatus = "connected" | "needs_reconnect" | "error" | "not_configured";
export type TaskStatus = "review" | "today" | "scheduled" | "waiting" | "ignored" | "done";
export type ReviewDecision = "addToday" | "schedule" | "waiting" | "complete" | "ignore";
export type ProjectStatus = "active" | "later" | "inactive";

export class TerminalTaskConflictError extends Error {}

export interface ReviewDetails {
  scheduledFor: string | null;
  waitingOn: string | null;
  followUpDate: string | null;
  waitingSince?: string | null;
  returnedFromWaiting?: boolean;
  waitingResponseReceivedAt?: string | null;
}

export interface SourceHealth {
  source: "gmail" | "calendar" | "noteplan";
  status: SourceStatus;
  account?: string;
  checkedAt?: string;
  error?: string;
}

export interface TaskSuggestion {
  id: string;
  actionKey: string;
  title: string;
  project: string | null;
  status: TaskStatus;
  dueDate: string | null;
  sourceType: "gmail" | "noteplan" | "recurring";
  sourceId: string;
  sourceUrl: string | null;
  sourceAccount: string;
  confidence: number;
  urgencyReason: string | null;
  waitingOn: string | null;
  emailReceivedAt?: string | null;
  emailLastActivityAt?: string | null;
  gmailLocationVerifiedAt?: string;
  verifiedAt: string;
  reviewedAt: string | null;
  reviewDecision: ReviewDecision | null;
  scheduledFor: string | null;
  followUpDate: string | null;
  waitingSince?: string | null;
  returnedFromWaiting?: boolean;
  waitingResponseReceivedAt?: string | null;
  previousDay?: string | null;
  done?: boolean;
  canceled?: boolean;
  rescheduled?: boolean;
  carryCount?: number;
  completedAt?: string | null;
  migrationSource?: "pilot";
  userCorrection?: {
    previousTitle: string;
    correctedTitle: string;
    correctedAt: string;
  };
}

export interface TaskUpdate {
  title?: string;
  completed?: boolean;
  scheduledFor?: string;
  returnedFromWaiting?: boolean;
  waitingResponseReceivedAt?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: ProjectStatus | "unconfirmed";
  openTaskCount: number;
}

export interface CalendarCommitment {
  id: string;
  title: string;
  start: string;
  end: string;
  sourceUrl: string | null;
  private: boolean;
}

export interface DailyPlan {
  date: string;
  generatedAt: string;
  sources: SourceHealth[];
  startHere: TaskSuggestion | null;
  review: TaskSuggestion[];
  today: TaskSuggestion[];
  waiting: TaskSuggestion[];
  scheduled: TaskSuggestion[];
  other: TaskSuggestion[];
  calendar: CalendarCommitment[];
  availableMinutes: number;
  checkInQuestion: string | null;
  warnings: string[];
  projects: ProjectSummary[];
  emailCoverage: {
    complete: boolean;
    scannedThreads: number;
    lastScanAt: string | null;
  };
  ideas?: Array<{ id: string; text: string; answers: Array<{ answer: string; createdAt: string }> }>;
  documentUrl?: string;
  documentCreatedAt?: string;
  emailDeliveredAt?: string;
}

export interface EmailThreadInput {
  threadId: string;
  sender: string;
  subject: string;
  sentByUser: boolean;
  latestAt: string;
  latestReceivedAt: string | null;
  content: string;
  sourceUrl: string;
}

export interface GmailSyncState {
  historyId: string;
  initializedAt: string;
  lastSuccessfulSyncAt: string;
}

export interface GmailReadResult {
  threads: EmailThreadInput[];
  historyId: string;
  mode: "initial" | "incremental" | "fallback";
}

export interface GmailBacklogState {
  beforeEpoch: number;
  completed: boolean;
  lastScanAt: string;
  scannedThreads?: number;
}

export interface GmailBacklogResult {
  threads: EmailThreadInput[];
  nextBeforeEpoch: number;
  complete: boolean;
}

const minuteFormatterByTimeZone = new Map<string, Intl.DateTimeFormat>();

export function stableTaskId(sourceId: string, actionKey: string): string {
  const safeKey = actionKey.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `gmail-${sourceId}-${safeKey || "action"}`;
}

function validDate(value: string | null): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}` === value;
}

export function applyReviewDecision(task: TaskSuggestion, decision: ReviewDecision, details: ReviewDetails, now: string): TaskSuggestion {
  const terminalDecision = task.status === "ignored" || task.reviewDecision === "ignore"
    ? "ignore"
    : task.status === "done" || task.done === true || task.reviewDecision === "complete"
      ? "complete"
      : null;
  if (terminalDecision) {
    if (decision === terminalDecision) return task;
    throw new TerminalTaskConflictError(`This task is already ${terminalDecision === "ignore" ? "ignored" : "completed"}. Refresh the dashboard before making another change.`);
  }
  if (decision === "schedule" && !validDate(details.scheduledFor)) throw new Error("A valid scheduled date is required when scheduling a task");
  if (decision === "waiting" && !details.waitingOn?.trim()) throw new Error("Who or what this task is waiting on is required");
  const statuses: Record<ReviewDecision, TaskStatus> = {
    addToday: "today",
    schedule: "scheduled",
    waiting: "waiting",
    complete: "done",
    ignore: "ignored",
  };
  return {
    ...task,
    status: statuses[decision],
    reviewDecision: decision,
    reviewedAt: now,
    scheduledFor: decision === "schedule" ? details.scheduledFor : null,
    waitingOn: decision === "waiting" ? details.waitingOn!.trim() : task.waitingOn ?? null,
    followUpDate: null,
    waitingSince: decision === "waiting" ? now : task.waitingSince ?? null,
    returnedFromWaiting: decision === "waiting" ? false : task.returnedFromWaiting ?? false,
    waitingResponseReceivedAt: decision === "waiting" ? null : task.waitingResponseReceivedAt ?? null,
    done: decision === "complete" ? true : task.done ?? false,
    completedAt: decision === "complete" ? now : task.completedAt ?? null,
  };
}

export function applyTaskUpdate(task: TaskSuggestion, update: TaskUpdate, updatedAt: string): TaskSuggestion {
  const terminal = task.status === "ignored" || task.reviewDecision === "ignore"
    ? "ignored"
    : task.status === "done" || task.done === true || task.reviewDecision === "complete"
      ? "completed"
      : null;
  if (terminal) {
    if (terminal === "completed" && update.completed === true && Object.keys(update).every((key) => key === "completed")) return task;
    throw new TerminalTaskConflictError(`This task is already ${terminal}. Refresh the dashboard before making another change.`);
  }
  const title = update.title?.trim();
  return {
    ...task,
    ...(title ? { title } : {}),
    ...(update.scheduledFor ? { status: "scheduled" as const, scheduledFor: update.scheduledFor, done: false, completedAt: null } : {}),
    ...(update.returnedFromWaiting !== undefined ? { returnedFromWaiting: update.returnedFromWaiting } : {}),
    ...(update.waitingResponseReceivedAt ? { waitingResponseReceivedAt: update.waitingResponseReceivedAt } : {}),
    ...(update.completed === true ? { status: "done" as const, done: true, completedAt: updatedAt, reviewedAt: updatedAt, reviewDecision: "complete" as const } : {}),
  };
}

export function organizeCarryForward(tasks: TaskSuggestion[], currentDay: string): TaskSuggestion[] {
  return tasks
    .filter((task) => !task.done && !task.canceled && !task.rescheduled && task.status !== "ignored")
    .map((task) => ({
      ...task,
      previousDay: currentDay === "Monday" && task.previousDay === "Friday" ? "Friday" : task.previousDay,
      carryCount: (task.carryCount ?? 0) + 1,
    }));
}

export function removeSuggestionFromPlan(plan: DailyPlan, id: string): DailyPlan {
  const without = (tasks: TaskSuggestion[] = []) => tasks.filter((task) => task.id !== id);
  return {
    ...plan,
    review: without(plan.review),
    today: without(plan.today),
    waiting: without(plan.waiting),
    scheduled: without(plan.scheduled),
    other: without(plan.other),
    startHere: plan.startHere?.id === id ? null : plan.startHere,
  };
}

function minuteFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = minuteFormatterByTimeZone.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  minuteFormatterByTimeZone.set(timeZone, formatter);
  return formatter;
}

function minuteOfDay(value: string, timeZone?: string): number {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return Number.NaN;
  if (!timeZone) return date.getHours() * 60 + date.getMinutes();
  const parts = minuteFormatter(timeZone).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return Number.NaN;
  return hour * 60 + minute;
}

export function calculateCapacity(events: CalendarCommitment[], workdayStart = 9, workdayEnd = 17, transitionMinutes = 15, timeZone?: string): number {
  const startOfWork = workdayStart * 60;
  const endOfWork = workdayEnd * 60;
  const ranges = events
    .map((event) => {
      const start = minuteOfDay(event.start, timeZone);
      const end = minuteOfDay(event.end, timeZone);
      if (Number.isNaN(start) || Number.isNaN(end)) return null;
      return {
        start: Math.max(startOfWork, start - transitionMinutes),
        end: Math.min(endOfWork, end + transitionMinutes),
      };
    })
    .filter((range): range is { start: number; end: number } => range !== null && range.end > range.start)
    .sort((left, right) => left.start - right.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  const occupied = merged.reduce((total, range) => total + range.end - range.start, 0);
  return Math.max(0, endOfWork - startOfWork - occupied);
}

export function selectStartHere(today: TaskSuggestion[], activeProjects = new Set<string>()): TaskSuggestion | null {
  return [...today].sort((left, right) => {
    const active = Number(activeProjects.has(right.project ?? "")) - Number(activeProjects.has(left.project ?? ""));
    const due = Number(Boolean(right.dueDate)) - Number(Boolean(left.dueDate));
    return active || due || right.confidence - left.confidence;
  })[0] ?? null;
}

export function checkInForDate(date: string): string | null {
  const day = new Date(`${date}T12:00:00`).getDay();
  if (day === 1) return "How is your energy today: low, normal, or high?";
  if (day === 3) return "Do you have any new work ideas you want me to remember?";
  if (day === 5) return "What made work easier or harder to start this week?";
  return null;
}

export function nextIdeaQuestion(answerCount: number): string | null {
  return [
    "What would done look like for this idea?",
    "What have you completed already?",
    "What is still unfinished?",
    "Is there a deadline or preferred completion date?",
    "What is the smallest next action you could take?",
  ][answerCount] ?? null;
}
