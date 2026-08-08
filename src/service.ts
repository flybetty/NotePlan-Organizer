import type { AppConfig } from "./config.js";
import type { EmailClassifier } from "./classifier.js";
import { createHash } from "node:crypto";
import { calculateCapacity, checkInForDate, nextIdeaQuestion, selectStartHere, type CalendarCommitment, type DailyPlan, type ProjectStatus, type ProjectSummary, type ReviewDecision, type ReviewDetails, type SourceHealth, type TaskSuggestion, type TaskUpdate } from "./domain.js";
import type { GoogleDataGateway } from "./google.js";
import { ReconnectRequiredError } from "./google.js";
import type { AssistantStore } from "./store.js";
import { applyKnownPreferences } from "./preferences.js";

export class AutomationPausedError extends Error {}

function summarizeProjects(tasks: TaskSuggestion[], statuses: Map<string, ProjectStatus>): ProjectSummary[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (!task.project || ["ignored", "done"].includes(task.status)) continue;
    counts.set(task.project, (counts.get(task.project) ?? 0) + 1);
  }
  const summaries: ProjectSummary[] = [...counts.entries()].map(([name, openTaskCount]) => ({
    id: createHash("sha256").update(name.trim().toLowerCase()).digest("hex").slice(0, 24),
    name,
    status: (statuses.get(name) ?? "unconfirmed") as ProjectSummary["status"],
    openTaskCount,
  }));
  return summaries.sort((left, right) => {
    const rank: Record<ProjectSummary["status"], number> = { active: 0, unconfirmed: 1, later: 2, inactive: 3 };
    return rank[left.status] - rank[right.status] || right.openTaskCount - left.openTaskCount || left.name.localeCompare(right.name);
  });
}

export class WorkAssistantService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: AssistantStore,
    private readonly google: GoogleDataGateway,
    private readonly classifier: EmailClassifier,
  ) {}

  async status(): Promise<{ connected: boolean; reconnectUrl: string; sources: SourceHealth[]; paused: boolean }> {
    return {
      connected: await this.google.hasConnection(),
      reconnectUrl: `${this.config.PUBLIC_BASE_URL}/api/oauth-url`,
      sources: await this.store.listSourceHealth(),
      paused: await this.store.isPaused(),
    };
  }

  async review(id: string, decision: ReviewDecision, details: ReviewDetails): Promise<{ labelWarning: string | null }> {
    const updated = await this.store.reviewSuggestion(id, decision, details, new Date().toISOString());
    if (updated.sourceType !== "gmail") return { labelWarning: null };
    try {
      await this.google.applyReviewLabels(updated.sourceId, decision);
      return { labelWarning: null };
    } catch (error) {
      return { labelWarning: `Decision saved, but Gmail labels were not updated: ${(error as Error).message}` };
    }
  }

  async correctReview(id: string, title: string): Promise<TaskSuggestion> {
    if (!title.trim()) throw new Error("Corrected task wording is required");
    return this.store.correctSuggestion(id, title.trim(), new Date().toISOString());
  }

  async updateTask(id: string, update: TaskUpdate): Promise<TaskSuggestion> {
    if (update.title !== undefined && !update.title.trim()) throw new Error("Task wording cannot be empty");
    return this.store.updateTask(id, update, new Date().toISOString());
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return summarizeProjects(applyKnownPreferences(await this.store.listSuggestions()), await this.store.listProjectStatuses());
  }

  async setProjectStatus(name: string, status: ProjectStatus): Promise<ProjectSummary[]> {
    if (!name.trim()) throw new Error("Project name is required");
    await this.store.setProjectStatus(name.trim(), status, new Date().toISOString());
    return this.listProjects();
  }

  async captureIdea(text: string): Promise<{ ideaId: string; question: string }> {
    const ideaId = await this.store.saveIdea(text, new Date().toISOString());
    return { ideaId, question: nextIdeaQuestion(0)! };
  }

  async answerIdea(id: string, answer: string): Promise<{ nextQuestion: string | null }> {
    if (!answer.trim()) throw new Error("Idea answer is required");
    const answerCount = await this.store.addIdeaAnswer(id, answer.trim(), new Date().toISOString());
    return { nextQuestion: nextIdeaQuestion(answerCount) };
  }

  async recordCheckIn(question: string, answer: string): Promise<void> {
    await this.store.saveCheckIn(question, answer, new Date().toISOString());
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.store.setPaused(paused);
  }

  async getPlan(date: string): Promise<DailyPlan | null> {
    return this.store.getPlan(date);
  }

  async scanGmailBacklog(): Promise<{ threadsChecked: number; suggestionsAdded: number; scannedThreads: number; complete: boolean }> {
    const state = await this.store.getGmailBacklogState();
    if (state?.completed) return { threadsChecked: 0, suggestionsAdded: 0, scannedThreads: state.scannedThreads ?? 0, complete: true };
    const result = await this.google.readBacklogThreads(state?.beforeEpoch ?? null);
    const verifiedAt = new Date().toISOString();
    const suggestions = applyKnownPreferences(await this.classifier.classify(result.threads, this.config.WORK_GMAIL_ACCOUNT, verifiedAt));
    await this.store.reconcileGmailSuggestions(result.threads.map((thread) => thread.threadId), suggestions);
    const scannedThreads = (state?.scannedThreads ?? 0) + result.threads.length;
    await this.store.saveGmailBacklogState({ beforeEpoch: result.nextBeforeEpoch, completed: result.complete, lastScanAt: verifiedAt, scannedThreads });
    return { threadsChecked: result.threads.length, suggestionsAdded: suggestions.length, scannedThreads, complete: result.complete };
  }

  async generateDailyPlan(date: string, force = false): Promise<DailyPlan> {
    if (await this.store.isPaused()) throw new AutomationPausedError("Automation is paused");
    const existing = await this.store.getPlan(date);
    if (existing && !force) return existing;

    const generatedAt = new Date().toISOString();
    const sources: SourceHealth[] = [];
    const warnings: string[] = [];
    let calendar: CalendarCommitment[] = [];

    try {
      const syncState = await this.store.getGmailSyncState();
      const gmailResult = await this.google.readRecentThreads(syncState);
      const suggestions = applyKnownPreferences(await this.classifier.classify(gmailResult.threads, this.config.WORK_GMAIL_ACCOUNT, generatedAt));
      await this.store.reconcileGmailSuggestions(gmailResult.threads.map((thread) => thread.threadId), suggestions);
      await this.store.saveGmailSyncState({
        historyId: gmailResult.historyId,
        initializedAt: syncState?.initializedAt ?? generatedAt,
        lastSuccessfulSyncAt: generatedAt,
      });
      sources.push({ source: "gmail", status: "connected", account: this.config.WORK_GMAIL_ACCOUNT, checkedAt: generatedAt });
    } catch (error) {
      const reconnect = error instanceof ReconnectRequiredError;
      const health: SourceHealth = { source: "gmail", status: reconnect ? "needs_reconnect" : "error", account: this.config.WORK_GMAIL_ACCOUNT, checkedAt: generatedAt, error: (error as Error).message };
      sources.push(health);
      warnings.push(reconnect ? "Gmail needs to be reconnected. No new email was classified." : "Gmail could not be checked. Existing tasks may be stale.");
    }

    try {
      calendar = await this.google.readCalendar(date);
      sources.push({ source: "calendar", status: "connected", account: this.config.WORK_GMAIL_ACCOUNT, checkedAt: generatedAt });
    } catch (error) {
      const reconnect = error instanceof ReconnectRequiredError;
      sources.push({ source: "calendar", status: reconnect ? "needs_reconnect" : "error", account: this.config.WORK_GMAIL_ACCOUNT, checkedAt: generatedAt, error: (error as Error).message });
      warnings.push(reconnect ? "Calendar needs to be reconnected. Capacity is unavailable." : "Calendar could not be checked. Capacity is unavailable.");
    }

    for (const health of sources) await this.store.saveSourceHealth(health);
    const tasks = applyKnownPreferences(await this.store.listSuggestions());
    const review = tasks.filter((task) => task.status === "review");
    const activatedScheduled = tasks.filter((task) => task.status === "scheduled" && task.scheduledFor && task.scheduledFor <= date);
    const activatedWaiting = tasks.filter((task) => task.status === "waiting" && task.followUpDate && task.followUpDate <= date);
    const today = [...tasks.filter((task) => task.status === "today"), ...activatedScheduled, ...activatedWaiting];
    const waiting = tasks.filter((task) => task.status === "waiting" && !activatedWaiting.includes(task));
    const scheduled = tasks.filter((task) => task.status === "scheduled" && !activatedScheduled.includes(task));
    const other = tasks.filter((task) => !["review", "today", "scheduled", "waiting", "ignored", "done"].includes(task.status));
    const projects = summarizeProjects(tasks, await this.store.listProjectStatuses());
    const backlogState = await this.store.getGmailBacklogState();
    const sourcesHealthy = sources.every((source) => source.status === "connected");
    const plan: DailyPlan = {
      date,
      generatedAt,
      sources,
      startHere: sourcesHealthy ? selectStartHere(today) : null,
      review,
      today,
      waiting,
      scheduled,
      other,
      calendar,
      availableMinutes: sources.find((source) => source.source === "calendar")?.status === "connected"
        ? calculateCapacity(calendar, this.config.WORKDAY_START, this.config.WORKDAY_END, 15, this.config.TIME_ZONE)
        : 0,
      checkInQuestion: checkInForDate(date),
      warnings,
      projects,
      emailCoverage: {
        complete: backlogState?.completed === true,
        scannedThreads: backlogState?.scannedThreads ?? 0,
        lastScanAt: backlogState?.lastScanAt ?? null,
      },
    };

    await this.store.savePlan(plan);
    return plan;
  }
}
