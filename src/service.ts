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
    await this.store.removeSuggestionFromPlans(id);
    if (updated.sourceType !== "gmail") return { labelWarning: null };
    try {
      await this.google.applyReviewLabels(updated.sourceId, decision);
      return { labelWarning: null };
    } catch (error) {
      return { labelWarning: `Decision saved, but Gmail labels were not updated: ${(error as Error).message}` };
    }
  }

  async groupReviews(ids: string[], id: string, title: string, scheduledFor: string): Promise<TaskSuggestion> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length < 2) throw new Error("Choose at least two email tasks to group");
    if (!id.startsWith("group-") || !title.trim()) throw new Error("A valid grouped task is required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledFor) || Number.isNaN(Date.parse(`${scheduledFor}T12:00:00Z`))) throw new Error("A valid scheduled date is required");
    const tasks = await Promise.all(uniqueIds.map((taskId) => this.store.getSuggestion(taskId)));
    if (tasks.some((task) => !task || task.sourceType !== "gmail" || task.status !== "review")) throw new Error("Every grouped item must be an unreviewed Gmail task");
    const selected = tasks as TaskSuggestion[];
    const projects = [...new Set(selected.map((task) => task.project).filter((project): project is string => Boolean(project)))];
    const now = new Date().toISOString();
    const grouped: TaskSuggestion = {
      id,
      actionKey: "grouped-email-work",
      title: title.trim(),
      project: projects.length === 1 ? projects[0]! : "Email follow-up",
      status: "scheduled",
      dueDate: scheduledFor,
      sourceType: "recurring",
      sourceId: id,
      sourceUrl: null,
      sourceAccount: this.config.WORK_GMAIL_ACCOUNT,
      confidence: Math.min(...selected.map((task) => task.confidence)),
      urgencyReason: `Grouped from ${selected.length} reviewed email tasks`,
      waitingOn: null,
      verifiedAt: now,
      reviewedAt: now,
      reviewDecision: "schedule",
      scheduledFor,
      followUpDate: null,
    };
    await this.store.upsertSuggestions([grouped]);
    for (const task of selected) await this.review(task.id, "ignore", { scheduledFor: null, waitingOn: null, followUpDate: null });
    return grouped;
  }

  async correctReview(id: string, title: string): Promise<TaskSuggestion> {
    if (!title.trim()) throw new Error("Corrected task wording is required");
    return this.store.correctSuggestion(id, title.trim(), new Date().toISOString());
  }

  async updateTask(id: string, update: TaskUpdate): Promise<TaskSuggestion> {
    if (update.title !== undefined && !update.title.trim()) throw new Error("Task wording cannot be empty");
    if (update.scheduledFor !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(update.scheduledFor) || Number.isNaN(Date.parse(`${update.scheduledFor}T12:00:00Z`)))) throw new Error("A valid scheduled date is required");
    const updated = await this.store.updateTask(id, update, new Date().toISOString());
    if (update.completed === true) await this.store.removeSuggestionFromPlans(id);
    return updated;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return summarizeProjects(applyKnownPreferences(await this.store.listSuggestions()), await this.store.listProjectStatuses());
  }

  async setProjectStatus(name: string, status: ProjectStatus): Promise<ProjectSummary[]> {
    if (!name.trim()) throw new Error("Project name is required");
    await this.store.setProjectStatus(name.trim(), status, new Date().toISOString());
    return this.listProjects();
  }

  async migratePilotReview(tasks: Array<Partial<TaskSuggestion> & { id?: string; title?: string }>, decisions: Record<string, string>): Promise<{ imported: number }> {
    const now = new Date().toISOString();
    const migrated = tasks.flatMap((task): TaskSuggestion[] => {
      if (!task.id || !task.title) return [];
      const decision = decisions[task.id];
      if (!["addToday", "ignore"].includes(decision)) return [];
      const match = task.id.match(/^gmail-([a-f0-9]+)(?:-(.+))?$/i);
      return [{
        id: task.id,
        actionKey: task.actionKey || match?.[2] || "pilot-action",
        title: task.title,
        project: task.project ?? null,
        status: decision === "addToday" ? "today" : "ignored",
        dueDate: task.dueDate ?? null,
        sourceType: "gmail",
        sourceId: task.sourceId || match?.[1] || task.id,
        sourceUrl: task.sourceUrl ?? null,
        sourceAccount: this.config.WORK_GMAIL_ACCOUNT,
        confidence: task.confidence ?? 1,
        urgencyReason: task.urgencyReason ?? null,
        waitingOn: task.waitingOn ?? null,
        verifiedAt: task.verifiedAt ?? now,
        reviewedAt: now,
        reviewDecision: decision as ReviewDecision,
        scheduledFor: null,
        followUpDate: null,
        previousDay: decision === "addToday" ? "Friday" : null,
        carryCount: decision === "addToday" ? 1 : 0,
        migrationSource: "pilot",
      }];
    });
    await this.store.upsertSuggestions(migrated);
    return { imported: migrated.length };
  }

  async captureIdea(text: string): Promise<{ ideaId: string; question: string }> {
    const ideaId = await this.store.saveIdea(text, new Date().toISOString());
    return { ideaId, question: nextIdeaQuestion(0)! };
  }

  async captureManualTask(title: string, date: string): Promise<TaskSuggestion> {
    if (!title.trim()) throw new Error("Task wording is required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) throw new Error("A valid task date is required");
    const now = new Date().toISOString();
    const id = `manual-${createHash("sha256").update(`${title.trim()}|${now}`).digest("hex").slice(0, 24)}`;
    const task: TaskSuggestion = {
      id, actionKey: "manual-task", title: title.trim(), project: null, status: "today", dueDate: null,
      sourceType: "recurring", sourceId: id, sourceUrl: null, sourceAccount: "NotePlan dashboard", confidence: 1,
      urgencyReason: "Captured in the dashboard", waitingOn: null, verifiedAt: now, reviewedAt: now,
      reviewDecision: "addToday", scheduledFor: date, followUpDate: null,
    };
    await this.store.upsertSuggestions([task]);
    return task;
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
    const planningContext = (await this.store.listCheckIns()).filter((item) => /Dashboard (correction|blocker)/.test(item.question)).map((item) => item.answer);
    const suggestions = applyKnownPreferences(await this.classifier.classify(result.threads, this.config.WORK_GMAIL_ACCOUNT, verifiedAt, planningContext));
    await this.store.reconcileGmailSuggestions(result.threads.map((thread) => thread.threadId), suggestions);
    const scannedThreads = (state?.scannedThreads ?? 0) + result.threads.length;
    await this.store.saveGmailBacklogState({ beforeEpoch: result.nextBeforeEpoch, completed: result.complete, lastScanAt: verifiedAt, scannedThreads });
    return { threadsChecked: result.threads.length, suggestionsAdded: suggestions.length, scannedThreads, complete: result.complete };
  }

  private async reconcileReviewEmailMetadata(verifiedAt: string): Promise<void> {
    const unchecked = (await this.store.listSuggestions()).filter((task) => task.sourceType === "gmail" && task.status === "review" && (task.gmailLocationVerifiedAt === undefined || task.emailReceivedAt === undefined || task.emailReceivedAt === null && task.emailLastActivityAt === undefined));
    if (!unchecked.length) return;
    const sourceIds = [...new Set(unchecked.map((task) => task.sourceId))];
    const threads = await this.google.readThreadsByIds(sourceIds);
    const timestampsByThread = new Map(threads.map((thread) => [thread.threadId, { receivedAt: thread.latestReceivedAt, activityAt: thread.latestAt }]));
    const missingSourceIds = sourceIds.filter((sourceId) => !timestampsByThread.has(sourceId));
    await this.store.removeUnreviewedGmailSuggestions(missingSourceIds);
    const updates = unchecked
      .filter((task) => timestampsByThread.has(task.sourceId))
      .map((task) => ({ ...task, emailReceivedAt: timestampsByThread.get(task.sourceId)!.receivedAt, emailLastActivityAt: timestampsByThread.get(task.sourceId)!.activityAt, gmailLocationVerifiedAt: verifiedAt }));
    await this.store.upsertSuggestions(updates);
  }

  private async reactivateWaitingResponses(threads: Array<{ threadId: string; latestReceivedAt: string | null }>, date: string, detectedAt: string): Promise<number> {
    const receivedByThread = new Map(threads.filter((thread) => thread.latestReceivedAt).map((thread) => [thread.threadId, thread.latestReceivedAt!]));
    const waiting = (await this.store.listSuggestions()).filter((task) => task.sourceType === "gmail" && task.status === "waiting");
    let reactivated = 0;
    for (const task of waiting) {
      const receivedAt = receivedByThread.get(task.sourceId);
      const waitingSince = task.waitingSince || task.reviewedAt || task.emailLastActivityAt;
      if (!receivedAt || !waitingSince || receivedAt <= waitingSince) continue;
      await this.store.updateTask(task.id, { scheduledFor: date, returnedFromWaiting: true, waitingResponseReceivedAt: receivedAt }, detectedAt);
      reactivated += 1;
    }
    return reactivated;
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
      const returnedWaiting = await this.reactivateWaitingResponses(gmailResult.threads, date, generatedAt);
      const planningContext = (await this.store.listCheckIns()).filter((item) => /Dashboard (correction|blocker)/.test(item.question)).map((item) => item.answer);
      const suggestions = applyKnownPreferences(await this.classifier.classify(gmailResult.threads, this.config.WORK_GMAIL_ACCOUNT, generatedAt, planningContext));
      await this.store.reconcileGmailSuggestions(gmailResult.threads.map((thread) => thread.threadId), suggestions);
      await this.reconcileReviewEmailMetadata(generatedAt);
      await this.store.saveGmailSyncState({
        historyId: gmailResult.historyId,
        initializedAt: syncState?.initializedAt ?? generatedAt,
        lastSuccessfulSyncAt: generatedAt,
      });
      if (returnedWaiting) warnings.push(`${returnedWaiting} waiting task${returnedWaiting === 1 ? "" : "s"} received a reply and will be placed in the next available work block.`);
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
    const migratedSourceIds = new Set(tasks.filter((task) => task.migrationSource === "pilot" && task.status !== "review").map((task) => task.sourceId));
    const ignoredSourceIds = new Set(tasks.filter((task) => task.sourceType === "gmail" && task.status === "ignored").map((task) => task.sourceId));
    const reviewedActivity = new Map<string, string | null>();
    for (const task of tasks.filter((item) => item.sourceType === "gmail" && item.status !== "review" && item.reviewedAt)) {
      const activity = task.emailLastActivityAt ?? null;
      const previous = reviewedActivity.get(task.sourceId);
      if (previous === undefined || activity && (!previous || activity > previous)) reviewedActivity.set(task.sourceId, activity);
    }
    const activatedKeys = new Set(tasks
      .filter((task) => !["review", "ignored"].includes(task.status))
      .map((task) => `${task.sourceId}:${task.actionKey}`));
    const review = tasks
      .filter((task) => {
        if (task.status !== "review" || ignoredSourceIds.has(task.sourceId) || migratedSourceIds.has(task.sourceId) || activatedKeys.has(`${task.sourceId}:${task.actionKey}`)) return false;
        const reviewedAtActivity = reviewedActivity.get(task.sourceId);
        return reviewedAtActivity === undefined || Boolean(task.emailLastActivityAt && reviewedAtActivity && task.emailLastActivityAt > reviewedAtActivity);
      })
      .sort((left, right) => (right.emailReceivedAt ?? "").localeCompare(left.emailReceivedAt ?? ""));
    const activatedScheduled = tasks.filter((task) => task.status === "scheduled" && task.scheduledFor && task.scheduledFor <= date);
    const today = [...tasks.filter((task) => task.status === "today"), ...activatedScheduled];
    const waiting = tasks.filter((task) => task.status === "waiting");
    const scheduled = tasks.filter((task) => task.status === "scheduled" && !activatedScheduled.includes(task));
    const other = tasks.filter((task) => !["review", "today", "scheduled", "waiting", "ignored", "done"].includes(task.status));
    const projectStatuses = await this.store.listProjectStatuses();
    const projects = summarizeProjects(tasks, projectStatuses);
    const activeProjects = new Set([...projectStatuses.entries()].filter(([, status]) => status === "active").map(([name]) => name));
    const backlogState = await this.store.getGmailBacklogState();
    const sourcesHealthy = sources.every((source) => source.status === "connected");
    const plan: DailyPlan = {
      date,
      generatedAt,
      sources,
      startHere: sourcesHealthy ? selectStartHere(today, activeProjects) : null,
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
      ideas: await this.store.listIdeas(),
    };

    await this.store.savePlan(plan);
    return plan;
  }
}
