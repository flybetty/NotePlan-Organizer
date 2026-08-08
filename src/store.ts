import { Firestore } from "@google-cloud/firestore";
import { createHash } from "node:crypto";
import { applyReviewDecision, type DailyPlan, type GmailBacklogState, type GmailSyncState, type ProjectStatus, type ReviewDecision, type ReviewDetails, type SourceHealth, type TaskSuggestion, type TaskUpdate } from "./domain.js";

function projectId(name: string): string {
  return createHash("sha256").update(name.trim().toLowerCase()).digest("hex").slice(0, 24);
}

export interface AssistantStore {
  upsertSuggestions(tasks: TaskSuggestion[]): Promise<void>;
  reconcileGmailSuggestions(threadIds: string[], tasks: TaskSuggestion[]): Promise<void>;
  replaceNotePlanSuggestions(tasks: TaskSuggestion[]): Promise<void>;
  listSuggestions(): Promise<TaskSuggestion[]>;
  getSuggestion(id: string): Promise<TaskSuggestion | null>;
  reviewSuggestion(id: string, decision: ReviewDecision, details: ReviewDetails, reviewedAt: string): Promise<TaskSuggestion>;
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
  saveCheckIn(question: string, answer: string, createdAt: string): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  isPaused(): Promise<boolean>;
  getGmailSyncState(): Promise<GmailSyncState | null>;
  saveGmailSyncState(state: GmailSyncState): Promise<void>;
  getGmailBacklogState(): Promise<GmailBacklogState | null>;
  saveGmailBacklogState(state: GmailBacklogState): Promise<void>;
}

export class FirestoreAssistantStore implements AssistantStore {
  private readonly firestore: Firestore;

  constructor(projectId: string) {
    this.firestore = new Firestore({ projectId });
  }

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
      } : {};
      const notePlanDone = task.sourceType === "noteplan" && previous?.status === "done" ? { status: "done", done: true, completedAt: previous.completedAt } : {};
      const correction = previous?.userCorrection ? { title: previous.title, userCorrection: previous.userCorrection } : {};
      batch.set(references[index]!, { ...task, ...preserved, ...notePlanDone, ...correction }, { merge: true });
    }
    await batch.commit();
  }

  async reconcileGmailSuggestions(threadIds: string[], tasks: TaskSuggestion[]): Promise<void> {
    const processed = new Set(threadIds);
    const incoming = new Set(tasks.map((task) => task.id));
    const existing = await this.firestore.collection("taskSuggestions").get();
    const batch = this.firestore.batch();
    for (const document of existing.docs) {
      const task = document.data() as TaskSuggestion;
      if (task.sourceType === "gmail" && processed.has(task.sourceId) && task.status === "review" && !incoming.has(task.id)) batch.delete(document.ref);
    }
    await batch.commit();
    await this.upsertSuggestions(tasks);
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
    return snapshot.docs.map((document) => document.data() as TaskSuggestion);
  }

  async getSuggestion(id: string): Promise<TaskSuggestion | null> {
    const snapshot = await this.firestore.collection("taskSuggestions").doc(id).get();
    return snapshot.exists ? snapshot.data() as TaskSuggestion : null;
  }

  async reviewSuggestion(id: string, decision: ReviewDecision, details: ReviewDetails, reviewedAt: string): Promise<TaskSuggestion> {
    const existing = await this.getSuggestion(id);
    if (!existing) throw new Error(`Unknown task suggestion: ${id}`);
    const updated = applyReviewDecision(existing, decision, details, reviewedAt);
    await this.firestore.collection("taskSuggestions").doc(id).set(updated);
    return updated;
  }

  async correctSuggestion(id: string, title: string, correctedAt: string): Promise<TaskSuggestion> {
    const existing = await this.getSuggestion(id);
    if (!existing) throw new Error(`Unknown task suggestion: ${id}`);
    const updated: TaskSuggestion = { ...existing, title, userCorrection: { previousTitle: existing.userCorrection?.previousTitle ?? existing.title, correctedTitle: title, correctedAt } };
    await this.firestore.collection("taskSuggestions").doc(id).set(updated);
    return updated;
  }

  async updateTask(id: string, update: TaskUpdate, updatedAt: string): Promise<TaskSuggestion> {
    const existing = await this.getSuggestion(id);
    if (!existing) throw new Error(`Unknown task suggestion: ${id}`);
    const title = update.title?.trim();
    const updated: TaskSuggestion = {
      ...existing,
      ...(title ? { title } : {}),
      ...(update.completed === true ? { status: "done", done: true, completedAt: updatedAt } : {}),
    };
    await this.firestore.collection("taskSuggestions").doc(id).set(updated);
    return updated;
  }

  async listProjectStatuses(): Promise<Map<string, ProjectStatus>> {
    const snapshot = await this.firestore.collection("projectStatuses").get();
    return new Map(snapshot.docs.map((document) => [String(document.data().name), document.data().status as ProjectStatus]));
  }

  async setProjectStatus(name: string, status: ProjectStatus, updatedAt: string): Promise<void> {
    await this.firestore.collection("projectStatuses").doc(projectId(name)).set({ name: name.trim(), status, updatedAt });
  }

  async saveSourceHealth(health: SourceHealth): Promise<void> {
    await this.firestore.collection("sourceHealth").doc(health.source).set(health);
  }

  async listSourceHealth(): Promise<SourceHealth[]> {
    const snapshot = await this.firestore.collection("sourceHealth").get();
    return snapshot.docs.map((document) => document.data() as SourceHealth);
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
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) throw new Error(`Unknown idea: ${id}`);
      const answers = [...(snapshot.data()?.answers ?? []), { answer, createdAt }];
      transaction.update(reference, { answers, updatedAt: createdAt });
      return answers.length;
    });
  }

  async saveCheckIn(question: string, answer: string, createdAt: string): Promise<void> {
    await this.firestore.collection("checkIns").add({ question, answer, createdAt });
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
      this.tasks.set(task.id, previous?.reviewedAt && task.sourceType !== "noteplan" || previous?.userCorrection ? { ...task, status: previous.status, reviewedAt: previous.reviewedAt, reviewDecision: previous.reviewDecision, scheduledFor: previous.scheduledFor, waitingOn: previous.waitingOn, followUpDate: previous.followUpDate, title: previous.userCorrection ? previous.title : task.title, userCorrection: previous.userCorrection } : task.sourceType === "noteplan" && previous?.status === "done" ? { ...task, status: "done", done: true, completedAt: previous.completedAt } : task);
    }
  }
  async reconcileGmailSuggestions(threadIds: string[], tasks: TaskSuggestion[]): Promise<void> {
    const processed = new Set(threadIds);
    const incoming = new Set(tasks.map((task) => task.id));
    for (const [id, task] of this.tasks) if (task.sourceType === "gmail" && processed.has(task.sourceId) && task.status === "review" && !incoming.has(id)) this.tasks.delete(id);
    await this.upsertSuggestions(tasks);
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
    const title = update.title?.trim();
    const updated: TaskSuggestion = { ...existing, ...(title ? { title } : {}), ...(update.completed === true ? { status: "done", done: true, completedAt: updatedAt } : {}) };
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
  async saveCheckIn(question: string, answer: string, createdAt: string): Promise<void> { this.checkIns.push({ question, answer, createdAt }); }
  async setPaused(paused: boolean): Promise<void> { this.paused = paused; }
  async isPaused(): Promise<boolean> { return this.paused; }
  async getGmailSyncState(): Promise<GmailSyncState | null> { return this.gmailSyncState; }
  async saveGmailSyncState(state: GmailSyncState): Promise<void> { this.gmailSyncState = state; }
  async getGmailBacklogState(): Promise<GmailBacklogState | null> { return this.gmailBacklogState; }
  async saveGmailBacklogState(state: GmailBacklogState): Promise<void> { this.gmailBacklogState = state; }
}
