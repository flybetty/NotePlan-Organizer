import { createHash } from "node:crypto";
import { applyReviewDecision, applyTaskUpdate, removeSuggestionFromPlan, taskObligationKey, type DailyPlan, type GmailBacklogState, type GmailSyncState, type ProjectStatus, type ReviewDecision, type ReviewDetails, type SourceHealth, type TaskSuggestion, type TaskUpdate } from "./domain.js";

function projectId(name: string): string {
  return createHash("sha256").update(name.trim().toLowerCase()).digest("hex").slice(0, 24);
}

export interface AssistantStore {
  upsertSuggestions(tasks: TaskSuggestion[]): Promise<void>;
  reconcileGmailSuggestions(threadIds: string[], tasks: TaskSuggestion[]): Promise<void>;
  removeUnreviewedGmailSuggestions(sourceIds: string[]): Promise<void>;
  replaceNotePlanSuggestions(tasks: TaskSuggestion[]): Promise<void>;
  listSuggestions(): Promise<TaskSuggestion[]>;
  getSuggestion(id: string): Promise<TaskSuggestion | null>;
  reviewSuggestion(id: string, decision: ReviewDecision, details: ReviewDetails, reviewedAt: string): Promise<TaskSuggestion>;
  removeSuggestionFromPlans(id: string): Promise<void>;
  correctSuggestion(id: string, title: string, correctedAt: string): Promise<TaskSuggestion>;
  updateTask(id: string, update: TaskUpdate, updatedAt: string): Promise<TaskSuggestion>;
  listProjectStatuses(): Promise<Map<string, ProjectStatus>>;
  setProjectStatus(name: string, status: ProjectStatus, updatedAt: string): Promise<void>;
  saveSourceHealth(health: SourceHealth): Promise<void>;
  listSourceHealth(): Promise<SourceHealth[]>;
  savePlan(plan: DailyPlan): Promise<void>;
  getPlan(date: string): Promise<DailyPlan | null>;
  saveIdea(text: string, createdAt: string): Promise<string>;
  addIdeaAnswer(id: string, answer: string, createdAt: string): Promise<number>;
  listIdeas(): Promise<Array<{ id: string; text: string; answers: Array<{ answer: string; createdAt: string }> }>>;
  saveCheckIn(question: string, answer: string, createdAt: string): Promise<void>;
  listCheckIns(): Promise<Array<{ question: string; answer: string; createdAt: string }>>;
  setPaused(paused: boolean): Promise<void>;
  isPaused(): Promise<boolean>;
  getGmailSyncState(): Promise<GmailSyncState | null>;
  saveGmailSyncState(state: GmailSyncState): Promise<void>;
  getGmailBacklogState(): Promise<GmailBacklogState | null>;
  saveGmailBacklogState(state: GmailBacklogState): Promise<void>;
}

export class FirestoreAssistantStore implements AssistantStore {
  constructor(private readonly firestore: any) {}

  async upsertSuggestions(tasks: TaskSuggestion[]): Promise<void> {
    if (!tasks.length) return;
    const references = tasks.map((task) => this.firestore.collection("taskSuggestions").doc(task.id));
    const existing = await this.firestore.getAll(...references);
    const batch = this.firestore.batch();
    for (const [index, task] of tasks.entries()) {
      const previous = existing[index]?.data() as TaskSuggestion | undefined;
      const preserved = previous?.reviewedAt && task.sourceType !== "noteplan" ? {
        status: previous.status,
        reviewedAt: previous.reviewedAt,
        reviewDecision: previous.reviewDecision,
        scheduledFor: previous.scheduledFor,
        waitingOn: previous.waitingOn,
        followUpDate: previous.followUpDate,
        waitingSince: previous.waitingSince,
        returnedFromWaiting: previous.returnedFromWaiting,
        waitingResponseReceivedAt: previous.waitingResponseReceivedAt,
      } : {};
      const notePlanDone = task.sourceType === "noteplan" && previous?.status === "done" ? { status: "done", done: true, completedAt: previous.completedAt } : {};
      const correction = previous?.userCorrection ? { title: previous.title, userCorrection: previous.userCorrection } : {};
      batch.set(references[index]!, { ...task, ...preserved, ...notePlanDone, ...correction }, { merge: true });
    }
    await batch.commit();
  }

  async reconcileGmailSuggestions(threadIds: string[], tasks: TaskSuggestion[]): Promise<void> {
    const processed = new Set(threadIds);
    const existing = await this.firestore.collection("taskSuggestions").get();
    const existingTasks: TaskSuggestion[] = existing.docs.map((document: any) => document.data() as TaskSuggestion);
    const terminalTasks = existingTasks.filter((task) => task.sourceType === "gmail" && (task.status === "ignored" || task.status === "done"));
    const terminalBySource = new Map<string, TaskSuggestion>(terminalTasks.map((task) => [task.sourceId, task]));
    const terminalByObligation = new Map<string, TaskSuggestion>(terminalTasks.map((task) => [taskObligationKey(task), task]));
    const returnedResponses = new Map<string, string>(existingTasks.filter((task) => task.sourceType === "gmail" && task.returnedFromWaiting && task.waitingResponseReceivedAt).map((task) => [task.sourceId, task.waitingResponseReceivedAt!]));
    const reviewedActivity = new Map<string, string | null>();
    for (const task of existingTasks.filter((item) => item.sourceType === "gmail" && item.status !== "review" && item.reviewedAt)) {
      const activity = task.emailLastActivityAt ?? null;
      const previous = reviewedActivity.get(task.sourceId);
      if (previous === undefined || activity && (!previous || activity > previous)) reviewedActivity.set(task.sourceId, activity);
    }
    const accepted = tasks.filter((task) => {
      if (task.sourceType !== "gmail") return true;
      const terminal = terminalBySource.get(task.sourceId) || terminalByObligation.get(taskObligationKey(task));
      if (terminal && (!task.emailLastActivityAt || !terminal.reviewedAt || task.emailLastActivityAt <= terminal.reviewedAt)) return false;
      const returnedAt = returnedResponses.get(task.sourceId);
      if (returnedAt && task.emailReceivedAt && task.emailReceivedAt <= returnedAt) return false;
      const reviewedAtActivity = reviewedActivity.get(task.sourceId);
      return reviewedAtActivity === undefined || Boolean(task.emailLastActivityAt && reviewedAtActivity && task.emailLastActivityAt > reviewedAtActivity);
    });
    const incoming = new Set(accepted.map((task) => task.id));
    const batch = this.firestore.batch();
    for (const document of existing.docs) {
      const task = document.data() as TaskSuggestion;
      if (task.sourceType === "gmail" && processed.has(task.sourceId) && task.status === "review" && !incoming.has(task.id)) batch.delete(document.ref);
    }
    await batch.commit();
    await this.upsertSuggestions(accepted);
  }

  async removeUnreviewedGmailSuggestions(sourceIds: string[]): Promise<void> {
    if (!sourceIds.length) return;
    const rejected = new Set(sourceIds);
    const existing = await this.firestore.collection("taskSuggestions").get();
    const batch = this.firestore.batch();
    for (const document of existing.docs) {
      const task = document.data() as TaskSuggestion;
      if (task.sourceType === "gmail" && task.status === "review" && rejected.has(task.sourceId)) batch.delete(document.ref);
    }
    await batch.commit();
  }

  async replaceNotePlanSuggestions(tasks: TaskSuggestion[]): Promise<void> {
    const incoming = new Set(tasks.map((task) => task.id));
    const existing = await this.firestore.collection("taskSuggestions").where("sourceType", "==", "noteplan").get();
    const batch = this.firestore.batch();
    for (const document of existing.docs) {
      const task = document.data() as TaskSuggestion;
      if (!incoming.has(task.id) && task.status !== "done") batch.delete(document.ref);
    }
    await batch.commit();
    await this.upsertSuggestions(tasks);
  }

  async listSuggestions(): Promise<TaskSuggestion[]> {
    const snapshot = await this.firestore.collection("taskSuggestions").get();
    return snapshot.docs.map((document: any) => document.data() as TaskSuggestion);
  }

  async getSuggestion(id: string): Promise<TaskSuggestion | null> {
    const snapshot = await this.firestore.collection("taskSuggestions").doc(id).get();
    return snapshot.exists ? snapshot.data() as TaskSuggestion : null;
  }

  async reviewSuggestion(id: string, decision: ReviewDecision, details: ReviewDetails, reviewedAt: string): Promise<TaskSuggestion> {
    const reference = this.firestore.collection("taskSuggestions").doc(id);
    return this.firestore.runTransaction(async (transaction: any) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) throw new Error(`Unknown task suggestion: ${id}`);
      const updated = applyReviewDecision(snapshot.data() as TaskSuggestion, decision, details, reviewedAt);
      transaction.set(reference, updated);
      return updated;
    });
  }

  async removeSuggestionFromPlans(id: string): Promise<void> {
    const snapshot = await this.firestore.collection("dailyPlans").get();
    if (snapshot.empty) return;
    const batch = this.firestore.batch();
    for (const document of snapshot.docs) {
      const plan = document.data() as DailyPlan;
      batch.set(document.ref, removeSuggestionFromPlan(plan, id), { merge: true });
    }
    await batch.commit();
  }

  async correctSuggestion(id: string, title: string, correctedAt: string): Promise<TaskSuggestion> {
    const existing = await this.getSuggestion(id);
    if (!existing) throw new Error(`Unknown task suggestion: ${id}`);
    const updated: TaskSuggestion = { ...existing, title, userCorrection: { previousTitle: existing.userCorrection?.previousTitle ?? existing.title, correctedTitle: title, correctedAt } };
    await this.firestore.collection("taskSuggestions").doc(id).set(updated);
    return updated;
  }

  async updateTask(id: string, update: TaskUpdate, updatedAt: string): Promise<TaskSuggestion> {
    const reference = this.firestore.collection("taskSuggestions").doc(id);
    return this.firestore.runTransaction(async (transaction: any) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) throw new Error(`Unknown task suggestion: ${id}`);
      const updated = applyTaskUpdate(snapshot.data() as TaskSuggestion, update, updatedAt);
      transaction.set(reference, updated);
      return updated;
    });
  }

  async listProjectStatuses(): Promise<Map<string, ProjectStatus>> {
    const snapshot = await this.firestore.collection("projectStatuses").get();
    return new Map(snapshot.docs.map((document: any) => [String(document.data().name), document.data().status as ProjectStatus]));
  }

  async setProjectStatus(name: string, status: ProjectStatus, updatedAt: string): Promise<void> {
    await this.firestore.collection("projectStatuses").doc(projectId(name)).set({ name: name.trim(), status, updatedAt });
  }

  async saveSourceHealth(health: SourceHealth): Promise<void> {
    await this.firestore.collection("sourceHealth").doc(health.source).set(health);
  }

  async listSourceHealth(): Promise<SourceHealth[]> {
    const snapshot = await this.firestore.collection("sourceHealth").get();
    return snapshot.docs.map((document: any) => document.data() as SourceHealth);
  }

  async savePlan(plan: DailyPlan): Promise<void> {
    await this.firestore.collection("dailyPlans").doc(plan.date).set(plan);
  }

  async getPlan(date: string): Promise<DailyPlan | null> {
    const snapshot = await this.firestore.collection("dailyPlans").doc(date).get();
    return snapshot.exists ? snapshot.data() as DailyPlan : null;
  }

  async saveIdea(text: string, createdAt: string): Promise<string> {
    const reference = await this.firestore.collection("ideas").add({ text, createdAt, status: "captured", answers: [] });
    return reference.id;
  }

  async addIdeaAnswer(id: string, answer: string, createdAt: string): Promise<number> {
    const reference = this.firestore.collection("ideas").doc(id);
    return this.firestore.runTransaction(async (transaction: any) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) throw new Error(`Unknown idea: ${id}`);
      const answers = [...(snapshot.data()?.answers ?? []), { answer, createdAt }];
      transaction.update(reference, { answers, updatedAt: createdAt });
      return answers.length;
    });
  }

  async listIdeas(): Promise<Array<{ id: string; text: string; answers: Array<{ answer: string; createdAt: string }> }>> {
    const snapshot = await this.firestore.collection("ideas").orderBy("createdAt", "desc").limit(50).get();
    return snapshot.docs.map((document: any) => ({ id: document.id, text: String(document.data().text || ""), answers: document.data().answers || [] }));
  }

  async saveCheckIn(question: string, answer: string, createdAt: string): Promise<void> {
    await this.firestore.collection("checkIns").add({ question, answer, createdAt });
  }

  async listCheckIns(): Promise<Array<{ question: string; answer: string; createdAt: string }>> {
    const snapshot = await this.firestore.collection("checkIns").orderBy("createdAt", "desc").limit(50).get();
    return snapshot.docs.map((document: any) => document.data() as { question: string; answer: string; createdAt: string });
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.firestore.collection("settings").doc("automation").set({ paused }, { merge: true });
  }

  async isPaused(): Promise<boolean> {
    const snapshot = await this.firestore.collection("settings").doc("automation").get();
    return snapshot.data()?.paused === true;
  }

  async getGmailSyncState(): Promise<GmailSyncState | null> {
    const snapshot = await this.firestore.collection("settings").doc("gmailSync").get();
    return snapshot.exists ? snapshot.data() as GmailSyncState : null;
  }

  async saveGmailSyncState(state: GmailSyncState): Promise<void> {
    await this.firestore.collection("settings").doc("gmailSync").set(state);
  }

  async getGmailBacklogState(): Promise<GmailBacklogState | null> {
    const snapshot = await this.firestore.collection("settings").doc("gmailBacklog").get();
    return snapshot.exists ? snapshot.data() as GmailBacklogState : null;
  }

  async saveGmailBacklogState(state: GmailBacklogState): Promise<void> {
    await this.firestore.collection("settings").doc("gmailBacklog").set(state);
  }
}

export class MemoryAssistantStore implements AssistantStore {
  private tasks = new Map<string, TaskSuggestion>();
  private health = new Map<string, SourceHealth>();
  private plans = new Map<string, DailyPlan>();
  readonly ideas: Array<{ text: string; createdAt: string; answers: Array<{ answer: string; createdAt: string }> }> = [];
  readonly checkIns: Array<{ question: string; answer: string; createdAt: string }> = [];
  private paused = false;
  private gmailSyncState: GmailSyncState | null = null;
  private gmailBacklogState: GmailBacklogState | null = null;
  private projectStatuses = new Map<string, ProjectStatus>();

  async upsertSuggestions(tasks: TaskSuggestion[]): Promise<void> {
    for (const task of tasks) {
      const previous = this.tasks.get(task.id);
      const preserved = previous?.reviewedAt && task.sourceType !== "noteplan" ? {
        status: previous.status,
        reviewedAt: previous.reviewedAt,
        reviewDecision: previous.reviewDecision,
        scheduledFor: previous.scheduledFor,
        waitingOn: previous.waitingOn,
        followUpDate: previous.followUpDate,
        waitingSince: previous.waitingSince,
        returnedFromWaiting: previous.returnedFromWaiting,
        waitingResponseReceivedAt: previous.waitingResponseReceivedAt,
      } : {};
      const notePlanDone = task.sourceType === "noteplan" && previous?.status === "done"
        ? { status: "done" as const, done: true, completedAt: previous.completedAt }
        : {};
      const correction = previous?.userCorrection
        ? { title: previous.title, userCorrection: previous.userCorrection }
        : {};
      this.tasks.set(task.id, { ...task, ...preserved, ...notePlanDone, ...correction });
    }
  }
  async reconcileGmailSuggestions(threadIds: string[], tasks: TaskSuggestion[]): Promise<void> {
    const processed = new Set(threadIds);
    const existingTasks = [...this.tasks.values()];
    const terminalTasks = existingTasks.filter((task) => task.sourceType === "gmail" && (task.status === "ignored" || task.status === "done"));
    const terminalBySource = new Map(terminalTasks.map((task) => [task.sourceId, task]));
    const terminalByObligation = new Map(terminalTasks.map((task) => [taskObligationKey(task), task]));
    const returnedResponses = new Map(existingTasks.filter((task) => task.sourceType === "gmail" && task.returnedFromWaiting && task.waitingResponseReceivedAt).map((task) => [task.sourceId, task.waitingResponseReceivedAt!]));
    const reviewedActivity = new Map<string, string | null>();
    for (const task of existingTasks.filter((item) => item.sourceType === "gmail" && item.status !== "review" && item.reviewedAt)) {
      const activity = task.emailLastActivityAt ?? null;
      const previous = reviewedActivity.get(task.sourceId);
      if (previous === undefined || activity && (!previous || activity > previous)) reviewedActivity.set(task.sourceId, activity);
    }
    const accepted = tasks.filter((task) => {
      if (task.sourceType !== "gmail") return true;
      const terminal = terminalBySource.get(task.sourceId) || terminalByObligation.get(taskObligationKey(task));
      if (terminal && (!task.emailLastActivityAt || !terminal.reviewedAt || task.emailLastActivityAt <= terminal.reviewedAt)) return false;
      const returnedAt = returnedResponses.get(task.sourceId);
      if (returnedAt && task.emailReceivedAt && task.emailReceivedAt <= returnedAt) return false;
      const reviewedAtActivity = reviewedActivity.get(task.sourceId);
      return reviewedAtActivity === undefined || Boolean(task.emailLastActivityAt && reviewedAtActivity && task.emailLastActivityAt > reviewedAtActivity);
    });
    const incoming = new Set(accepted.map((task) => task.id));
    for (const [id, task] of this.tasks) if (task.sourceType === "gmail" && processed.has(task.sourceId) && task.status === "review" && !incoming.has(id)) this.tasks.delete(id);
    await this.upsertSuggestions(accepted);
  }
  async removeUnreviewedGmailSuggestions(sourceIds: string[]): Promise<void> {
    const rejected = new Set(sourceIds);
    for (const [id, task] of this.tasks) if (task.sourceType === "gmail" && task.status === "review" && rejected.has(task.sourceId)) this.tasks.delete(id);
  }
  async replaceNotePlanSuggestions(tasks: TaskSuggestion[]): Promise<void> {
    const incoming = new Set(tasks.map((task) => task.id));
    for (const [id, task] of this.tasks) if (task.sourceType === "noteplan" && !incoming.has(id) && task.status !== "done") this.tasks.delete(id);
    await this.upsertSuggestions(tasks);
  }
  async listSuggestions(): Promise<TaskSuggestion[]> { return [...this.tasks.values()]; }
  async getSuggestion(id: string): Promise<TaskSuggestion | null> { return this.tasks.get(id) ?? null; }
  async reviewSuggestion(id: string, decision: ReviewDecision, details: ReviewDetails, reviewedAt: string): Promise<TaskSuggestion> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task suggestion: ${id}`);
    const updated = applyReviewDecision(task, decision, details, reviewedAt);
    this.tasks.set(id, updated);
    return updated;
  }

  async removeSuggestionFromPlans(id: string): Promise<void> {
    const updates: Array<[string, DailyPlan]> = [];
    for (const [date, plan] of this.plans) updates.push([date, removeSuggestionFromPlan(plan, id)]);
    for (const [date, plan] of updates) this.plans.set(date, plan);
  }
  async correctSuggestion(id: string, title: string, correctedAt: string): Promise<TaskSuggestion> {
    const existing = this.tasks.get(id);
    if (!existing) throw new Error(`Unknown task suggestion: ${id}`);
    const updated = { ...existing, title, userCorrection: { previousTitle: existing.userCorrection?.previousTitle ?? existing.title, correctedTitle: title, correctedAt } };
    this.tasks.set(id, updated);
    return updated;
  }
  async updateTask(id: string, update: TaskUpdate, updatedAt: string): Promise<TaskSuggestion> {
    const existing = this.tasks.get(id);
    if (!existing) throw new Error(`Unknown task suggestion: ${id}`);
    const updated = applyTaskUpdate(existing, update, updatedAt);
    this.tasks.set(id, updated);
    return updated;
  }
  async listProjectStatuses(): Promise<Map<string, ProjectStatus>> { return new Map(this.projectStatuses); }
  async setProjectStatus(name: string, status: ProjectStatus): Promise<void> { this.projectStatuses.set(name.trim(), status); }
  async saveSourceHealth(value: SourceHealth): Promise<void> { this.health.set(value.source, value); }
  async listSourceHealth(): Promise<SourceHealth[]> { return [...this.health.values()]; }
  async savePlan(plan: DailyPlan): Promise<void> { this.plans.set(plan.date, plan); }
  async getPlan(date: string): Promise<DailyPlan | null> { return this.plans.get(date) ?? null; }
  async saveIdea(text: string, createdAt: string): Promise<string> { this.ideas.push({ text, createdAt, answers: [] }); return String(this.ideas.length - 1); }
  async addIdeaAnswer(id: string, answer: string, createdAt: string): Promise<number> {
    const idea = this.ideas[Number(id)];
    if (!idea) throw new Error(`Unknown idea: ${id}`);
    idea.answers.push({ answer, createdAt });
    return idea.answers.length;
  }
  async listIdeas(): Promise<Array<{ id: string; text: string; answers: Array<{ answer: string; createdAt: string }> }>> { return this.ideas.map((idea, index) => ({ id: String(index), ...idea })); }
  async saveCheckIn(question: string, answer: string, createdAt: string): Promise<void> { this.checkIns.push({ question, answer, createdAt }); }
  async listCheckIns(): Promise<Array<{ question: string; answer: string; createdAt: string }>> { return [...this.checkIns].reverse(); }
  async setPaused(paused: boolean): Promise<void> { this.paused = paused; }
  async isPaused(): Promise<boolean> { return this.paused; }
  async getGmailSyncState(): Promise<GmailSyncState | null> { return this.gmailSyncState; }
  async saveGmailSyncState(state: GmailSyncState): Promise<void> { this.gmailSyncState = state; }
  async getGmailBacklogState(): Promise<GmailBacklogState | null> { return this.gmailBacklogState; }
  async saveGmailBacklogState(state: GmailBacklogState): Promise<void> { this.gmailBacklogState = state; }
}
