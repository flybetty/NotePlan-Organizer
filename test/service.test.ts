import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import type { EmailClassifier } from "../src/classifier.js";
import type { EmailThreadInput, TaskSuggestion } from "../src/domain.js";
import type { GoogleDataGateway } from "../src/google.js";
import { ReconnectRequiredError } from "../src/google.js";
import { WorkAssistantService } from "../src/service.js";
import { MemoryAssistantStore } from "../src/store.js";

const config = {
  PUBLIC_BASE_URL: "https://service.example.com",
  WORK_GMAIL_ACCOUNT: "work@example.com",
  WORKDAY_START: 9,
  WORKDAY_END: 17,
} as AppConfig;

const suggestion: TaskSuggestion = {
  id: "gmail-thread-reply",
  actionKey: "reply",
  title: "Reply to client",
  project: "Client",
  status: "review",
  dueDate: null,
  sourceType: "gmail",
  sourceId: "thread",
  sourceUrl: "https://mail.google.com/mail/#all/thread",
  sourceAccount: "work@example.com",
  confidence: 0.9,
  urgencyReason: null,
  waitingOn: null,
  verifiedAt: "2026-08-06T15:00:00Z",
  reviewedAt: null,
  reviewDecision: null,
  scheduledFor: null,
  followUpDate: null,
};

class FakeClassifier implements EmailClassifier {
  planningContext: string[] = [];
  async classify(threads: EmailThreadInput[], _sourceAccount?: string, _verifiedAt?: string, planningContext: string[] = []): Promise<TaskSuggestion[]> {
    this.planningContext = planningContext;
    return threads.length ? [{ ...suggestion, emailReceivedAt: threads[0]!.latestReceivedAt, emailLastActivityAt: threads[0]!.latestAt, gmailLocationVerifiedAt: "2026-08-10T16:00:00Z" }] : [];
  }
}

class FakeGoogle implements GoogleDataGateway {
  documents = 0;
  emails = 0;
  failGmail = false;
  knownThreads: EmailThreadInput[] = [{ threadId: "thread", sender: "Client", subject: "Question", sentByUser: false, latestAt: "2026-08-06T15:00:00Z", latestReceivedAt: "2026-08-06T15:00:00Z", content: "Please reply", sourceUrl: suggestion.sourceUrl! }];
  recentThreads: EmailThreadInput[] = [...this.knownThreads];
  authorizationUrl() { return "https://accounts.google.com/auth"; }
  async exchangeCode() {}
  async hasConnection() { return true; }
  async readRecentThreads() { if (this.failGmail) throw new ReconnectRequiredError(); return { historyId: "123", mode: "incremental" as const, threads: this.recentThreads }; }
  async readBacklogThreads() { return { nextBeforeEpoch: 1, complete: false, threads: [{ threadId: "thread", sender: "Client", subject: "Question", sentByUser: false, latestAt: "2026-07-01T15:00:00Z", latestReceivedAt: "2026-07-01T15:00:00Z", content: "Please reply", sourceUrl: suggestion.sourceUrl! }] }; }
  async readThreadsByIds(threadIds: string[]) { return this.knownThreads.filter((thread) => threadIds.includes(thread.threadId)); }
  async readCalendar() { return []; }
  async applyReviewLabels() {}
  async publishDocument() { this.documents += 1; return "https://docs.google.com/document/d/real/edit"; }
  async sendDigest() { this.emails += 1; }
}

test("keeps daily output in NotePlan without email or document delivery", async () => {
  const store = new MemoryAssistantStore();
  const google = new FakeGoogle();
  const service = new WorkAssistantService(config, store, google, new FakeClassifier());
  const first = await service.generateDailyPlan("2026-08-06");
  const second = await service.generateDailyPlan("2026-08-06");
  assert.equal(first.review.length, 1);
  assert.equal(first.review[0]?.emailReceivedAt, "2026-08-06T15:00:00Z");
  assert.equal(first.review[0]?.emailLastActivityAt, "2026-08-06T15:00:00Z");
  assert.equal(second.generatedAt, first.generatedAt);
  assert.equal(google.documents, 0);
  assert.equal(google.emails, 0);
});

test("existing email review tasks receive their original Gmail date", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([suggestion]);
  const google = new FakeGoogle();
  google.recentThreads = [];
  const service = new WorkAssistantService(config, store, google, new FakeClassifier());
  const plan = await service.generateDailyPlan("2026-08-10", true);
  assert.equal(plan.review[0]?.emailReceivedAt, "2026-08-06T15:00:00Z");
  assert.equal(plan.review[0]?.emailLastActivityAt, "2026-08-06T15:00:00Z");
});

test("email review is ordered by most recently received", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([
    { ...suggestion, id: "older", sourceId: "older", emailReceivedAt: "2026-08-01T15:00:00Z", gmailLocationVerifiedAt: "2026-08-10T15:00:00Z" },
    { ...suggestion, id: "newer", sourceId: "newer", emailReceivedAt: "2026-08-09T15:00:00Z", gmailLocationVerifiedAt: "2026-08-10T15:00:00Z" },
  ]);
  const google = new FakeGoogle();
  google.recentThreads = [];
  const service = new WorkAssistantService(config, store, google, new FakeClassifier());
  const plan = await service.generateDailyPlan("2026-08-10", true);
  assert.deepEqual(plan.review.map((task) => task.id), ["newer", "older"]);
});

test("confirmed active projects remain visible with no current cloud tasks", async () => {
  const store = new MemoryAssistantStore();
  await store.setProjectStatus("The Circle Education", "active");
  const service = new WorkAssistantService(config, store, new FakeGoogle(), new FakeClassifier());
  const projects = await service.listProjects();
  assert.deepEqual(projects.map((project) => ({ name: project.name, status: project.status, count: project.openTaskCount })), [
    { name: "The Circle Education", status: "active", count: 0 },
  ]);
});

test("existing unreviewed Gmail items absent from non-spam results are removed", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([{ ...suggestion, id: "spam", sourceId: "spam-thread" }]);
  const google = new FakeGoogle();
  google.recentThreads = [];
  const service = new WorkAssistantService(config, store, google, new FakeClassifier());
  const plan = await service.generateDailyPlan("2026-08-10", true);
  assert.equal(plan.review.some((task) => task.id === "spam"), false);
});

test("a reconnect failure is visible and removes confident Start Here", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([suggestion]);
  const google = new FakeGoogle();
  google.failGmail = true;
  const service = new WorkAssistantService(config, store, google, new FakeClassifier());
  const plan = await service.generateDailyPlan("2026-08-06");
  assert.equal(plan.startHere, null);
  assert.equal(plan.sources.find((source) => source.source === "gmail")?.status, "needs_reconnect");
  assert.match(plan.warnings.join(" "), /reconnect/i);
});

test("review decisions survive Gmail reprocessing", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([suggestion]);
  await store.reviewSuggestion(suggestion.id, "waiting", { scheduledFor: null, waitingOn: "Client", followUpDate: null }, "2026-08-06T16:00:00Z");
  await store.upsertSuggestions([{ ...suggestion, title: "Updated reply wording" }]);
  const updated = await store.getSuggestion(suggestion.id);
  assert.equal(updated?.status, "waiting");
  assert.equal(updated?.followUpDate, null);
  assert.equal(updated?.title, "Updated reply wording");
});

test("a new incoming reply reactivates the original waiting task without duplication", async () => {
  const store = new MemoryAssistantStore();
  const waitingTask = { ...suggestion, emailReceivedAt: "2026-08-06T15:00:00Z", emailLastActivityAt: "2026-08-06T15:00:00Z" };
  await store.upsertSuggestions([waitingTask]);
  await store.reviewSuggestion(waitingTask.id, "waiting", { scheduledFor: null, waitingOn: "Client", followUpDate: null }, "2026-08-06T16:00:00Z");
  const google = new FakeGoogle();
  google.recentThreads = [{ ...google.knownThreads[0]!, latestAt: "2026-08-13T16:00:00Z", latestReceivedAt: "2026-08-13T16:00:00Z", content: "Here is the response" }];
  google.knownThreads = [...google.recentThreads];
  const service = new WorkAssistantService(config, store, google, new FakeClassifier());
  const plan = await service.generateDailyPlan("2026-08-13", true);
  const reactivated = await store.getSuggestion(waitingTask.id);
  assert.equal(reactivated?.status, "scheduled");
  assert.equal(reactivated?.scheduledFor, "2026-08-13");
  assert.equal(reactivated?.returnedFromWaiting, true);
  assert.equal(reactivated?.waitingResponseReceivedAt, "2026-08-13T16:00:00Z");
  assert.deepEqual(plan.today.map((task) => task.id), [waitingTask.id]);
  assert.equal(plan.review.length, 0);
  assert.match(plan.warnings.join(" "), /waiting task received a reply/i);
});

test("ignored Gmail threads stay ignored when reclassification changes the action ID", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([suggestion]);
  await store.reviewSuggestion(suggestion.id, "ignore", { scheduledFor: null, waitingOn: null, followUpDate: null }, "2026-08-06T16:00:00Z");
  const reclassified = { ...suggestion, id: "gmail-thread-answer-client", actionKey: "answer-client", title: "Answer the client question" };
  await store.reconcileGmailSuggestions([suggestion.sourceId], [reclassified]);
  assert.equal((await store.getSuggestion(suggestion.id))?.status, "ignored");
  assert.equal(await store.getSuggestion(reclassified.id), null);
});

test("ignored obligations from old email do not return from another old thread", async () => {
  const store = new MemoryAssistantStore();
  const ignored = { ...suggestion, project: "Sparky's", actionKey: "follow-up", title: "Follow up with James", emailLastActivityAt: "2026-08-06T15:00:00Z" };
  await store.upsertSuggestions([ignored]);
  await store.reviewSuggestion(ignored.id, "ignore", { scheduledFor: null, waitingOn: null, followUpDate: null }, "2026-08-07T16:00:00Z");
  const duplicate = { ...ignored, id: "gmail-another-thread-follow-up", sourceId: "another-thread", actionKey: "follow up", title: "Please follow up with James", emailLastActivityAt: "2026-08-06T18:00:00Z" };
  await store.reconcileGmailSuggestions([duplicate.sourceId], [duplicate]);
  assert.equal(await store.getSuggestion(duplicate.id), null);
});

test("a genuinely new matching obligation can return for review", async () => {
  const store = new MemoryAssistantStore();
  const ignored = { ...suggestion, project: "Sparky's", actionKey: "follow-up", title: "Follow up with James", emailLastActivityAt: "2026-08-06T15:00:00Z" };
  await store.upsertSuggestions([ignored]);
  await store.reviewSuggestion(ignored.id, "ignore", { scheduledFor: null, waitingOn: null, followUpDate: null }, "2026-08-07T16:00:00Z");
  const newer = { ...ignored, id: "gmail-new-thread-follow-up", sourceId: "new-thread", actionKey: "follow up", title: "Please follow up with James", emailLastActivityAt: "2026-08-10T18:00:00Z" };
  await store.reconcileGmailSuggestions([newer.sourceId], [newer]);
  assert.equal((await store.getSuggestion(newer.id))?.status, "review");
});

test("scheduled Gmail tasks disappear even when refresh changes the action ID", async () => {
  const store = new MemoryAssistantStore();
  const original = { ...suggestion, emailLastActivityAt: "2026-08-06T15:00:00Z" };
  await store.upsertSuggestions([original]);
  await store.reviewSuggestion(original.id, "schedule", { scheduledFor: "2026-08-11", waitingOn: null, followUpDate: null }, "2026-08-06T16:00:00Z");
  const duplicate = { ...original, id: "gmail-thread-answer-client", actionKey: "answer-client", title: "Answer the client question" };
  await store.reconcileGmailSuggestions([original.sourceId], [duplicate]);
  assert.equal(await store.getSuggestion(duplicate.id), null);
  assert.equal((await store.getSuggestion(original.id))?.status, "scheduled");
});

test("a genuinely newer reply can create a new task after scheduling", async () => {
  const store = new MemoryAssistantStore();
  const original = { ...suggestion, emailLastActivityAt: "2026-08-06T15:00:00Z" };
  await store.upsertSuggestions([original]);
  await store.reviewSuggestion(original.id, "schedule", { scheduledFor: "2026-08-11", waitingOn: null, followUpDate: null }, "2026-08-06T16:00:00Z");
  const newer = { ...original, id: "gmail-thread-new-request", actionKey: "new-request", title: "Handle the new request", emailLastActivityAt: "2026-08-10T17:00:00Z" };
  await store.reconcileGmailSuggestions([original.sourceId], [newer]);
  assert.equal((await store.getSuggestion(newer.id))?.status, "review");
});

test("existing duplicate review items are hidden when their Gmail thread was ignored", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([
    { ...suggestion, status: "ignored", reviewedAt: "2026-08-06T16:00:00Z", reviewDecision: "ignore" },
    { ...suggestion, id: "gmail-thread-answer-client", actionKey: "answer-client", title: "Answer the client question" },
  ]);
  const google = new FakeGoogle();
  google.recentThreads = [];
  const service = new WorkAssistantService(config, store, google, { classify: async () => [] });
  const plan = await service.generateDailyPlan("2026-08-10", true);
  assert.equal(plan.review.length, 0);
});

test("reviewing an item removes it from the cached review dashboard immediately", async () => {
  const store = new MemoryAssistantStore();
  const service = new WorkAssistantService(config, store, new FakeGoogle(), new FakeClassifier());
  await store.upsertSuggestions([suggestion]);
  await store.savePlan({
    date: "2026-08-12", generatedAt: "2026-08-12T16:00:00Z", sources: [], warnings: [], startHere: suggestion,
    review: [suggestion], today: [], waiting: [], scheduled: [], other: [], projects: [], ideas: [], calendar: [],
    emailCoverage: { complete: true, scannedThreads: 1, lastScanAt: null }, availableMinutes: 480, checkInQuestion: null,
  });
  await service.review(suggestion.id, "schedule", { scheduledFor: "2026-08-13", waitingOn: null, followUpDate: null });
  const plan = await store.getPlan("2026-08-12");
  assert.deepEqual(plan?.review, []);
  assert.equal(plan?.startHere, null);
});

test("completing an active task removes it from cached daily plans", async () => {
  const store = new MemoryAssistantStore();
  const active = { ...suggestion, status: "today" as const, reviewedAt: "2026-08-12T15:00:00Z", reviewDecision: "addToday" as const };
  const service = new WorkAssistantService(config, store, new FakeGoogle(), new FakeClassifier());
  await store.upsertSuggestions([active]);
  await store.savePlan({
    date: "2026-08-12", generatedAt: "2026-08-12T16:00:00Z", sources: [], warnings: [], startHere: active,
    review: [], today: [active], waiting: [], scheduled: [], other: [], projects: [], ideas: [], calendar: [],
    emailCoverage: { complete: true, scannedThreads: 1, lastScanAt: null }, availableMinutes: 480, checkInQuestion: null,
  });
  await service.updateTask(active.id, { completed: true });
  const plan = await store.getPlan("2026-08-12");
  assert.deepEqual(plan?.today, []);
  assert.equal(plan?.startHere, null);
});

test("late schedule requests cannot reactivate ignored or completed tasks", async () => {
  const store = new MemoryAssistantStore();
  const service = new WorkAssistantService(config, store, new FakeGoogle(), new FakeClassifier());
  await store.upsertSuggestions([suggestion]);
  await service.review(suggestion.id, "ignore", { scheduledFor: null, waitingOn: null, followUpDate: null });
  await assert.rejects(() => service.review(suggestion.id, "schedule", { scheduledFor: "2026-08-14", waitingOn: null, followUpDate: null }), /already ignored/i);
  await assert.rejects(() => service.updateTask(suggestion.id, { scheduledFor: "2026-08-14" }), /already ignored/i);

  const second = { ...suggestion, id: "completed-terminal", sourceId: "completed-terminal" };
  await store.upsertSuggestions([second]);
  await service.review(second.id, "complete", { scheduledFor: null, waitingOn: null, followUpDate: null });
  await assert.rejects(() => service.review(second.id, "schedule", { scheduledFor: "2026-08-14", waitingOn: null, followUpDate: null }), /already completed/i);
  await assert.rejects(() => service.updateTask(second.id, { scheduledFor: "2026-08-14" }), /already completed/i);
});

test("multiple email reviews become one scheduled task and stay dismissed", async () => {
  const store = new MemoryAssistantStore();
  const second = { ...suggestion, id: "gmail-second-send-files", sourceId: "second", actionKey: "send-files", title: "Send requested files" };
  await store.upsertSuggestions([suggestion, second]);
  const service = new WorkAssistantService(config, store, new FakeGoogle(), new FakeClassifier());
  const grouped = await service.groupReviews([suggestion.id, second.id], "group-123", "Client email follow-ups", "2026-08-11");
  assert.equal(grouped.status, "scheduled");
  assert.equal(grouped.scheduledFor, "2026-08-11");
  assert.equal((await store.getSuggestion(suggestion.id))?.status, "ignored");
  assert.equal((await store.getSuggestion(second.id))?.status, "ignored");
  const plan = await service.generateDailyPlan("2026-08-10", true);
  assert.deepEqual(plan.scheduled.map((task) => task.id), ["group-123"]);
  assert.equal(plan.review.length, 0);
});

test("native NotePlan date changes update the existing task without duplication", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([{ ...suggestion, status: "today", reviewedAt: "2026-08-07T16:00:00Z", reviewDecision: "addToday" }]);
  const service = new WorkAssistantService(config, store, new FakeGoogle(), new FakeClassifier());
  const updated = await service.updateTask(suggestion.id, { scheduledFor: "2026-08-10" });
  assert.equal(updated.status, "scheduled");
  assert.equal(updated.scheduledFor, "2026-08-10");
  assert.equal((await store.listSuggestions()).filter((task) => task.id === suggestion.id).length, 1);
});

test("dashboard corrections become authoritative context for later email classification", async () => {
  const store = new MemoryAssistantStore();
  await store.saveCheckIn("Dashboard correction", "The client meeting is already arranged.", "2026-08-10T09:00:00Z");
  const classifier = new FakeClassifier();
  const service = new WorkAssistantService(config, store, new FakeGoogle(), classifier);
  await service.generateDailyPlan("2026-08-10", true);
  assert.deepEqual(classifier.planningContext, ["The client meeting is already arranged."]);
});

test("captured ideas appear in plans with their attached answers", async () => {
  const store = new MemoryAssistantStore();
  const service = new WorkAssistantService(config, store, new FakeGoogle(), new FakeClassifier());
  const captured = await service.captureIdea("Apply for a role");
  await service.answerIdea(captured.ideaId, "A finished resume and cover letter");
  const plan = await service.generateDailyPlan("2026-08-10", true);
  assert.equal(plan.ideas?.[0]?.text, "Apply for a role");
  assert.equal(plan.ideas?.[0]?.answers[0]?.answer, "A finished resume and cover letter");
});

test("dashboard task capture creates one active task for the selected date", async () => {
  const store = new MemoryAssistantStore();
  const service = new WorkAssistantService(config, store, new FakeGoogle(), new FakeClassifier());
  const task = await service.captureManualTask("Prepare project outline", "2026-08-10");
  assert.equal(task.status, "today");
  assert.equal(task.scheduledFor, "2026-08-10");
  assert.equal((await store.listSuggestions()).filter((item) => item.id === task.id).length, 1);
});

test("successful Gmail processing stores incremental sync state", async () => {
  const store = new MemoryAssistantStore();
  const service = new WorkAssistantService(config, store, new FakeGoogle(), new FakeClassifier());
  await service.generateDailyPlan("2026-08-06", true);
  const state = await store.getGmailSyncState();
  assert.equal(state?.historyId, "123");
  assert.ok(state?.lastSuccessfulSyncAt);
});

test("older email is scanned only in bounded review batches", async () => {
  const store = new MemoryAssistantStore();
  const service = new WorkAssistantService(config, store, new FakeGoogle(), new FakeClassifier());
  const result = await service.scanGmailBacklog();
  assert.deepEqual(result, { threadsChecked: 1, suggestionsAdded: 1, scannedThreads: 1, complete: false });
  assert.equal((await store.getGmailBacklogState())?.beforeEpoch, 1);
  assert.equal((await store.listSuggestions())[0]?.status, "review");
});

test("resolved Gmail threads remove stale unreviewed suggestions", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([suggestion]);
  await store.reconcileGmailSuggestions([suggestion.sourceId], []);
  assert.equal(await store.getSuggestion(suggestion.id), null);
});

test("resolved Gmail threads preserve tasks the user already activated", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([suggestion]);
  await store.reviewSuggestion(suggestion.id, "addToday", { scheduledFor: null, waitingOn: null, followUpDate: null }, "2026-08-06T16:00:00Z");
  await store.reconcileGmailSuggestions([suggestion.sourceId], []);
  assert.equal((await store.getSuggestion(suggestion.id))?.status, "today");
});

test("review suggestions never become Start Here before approval", async () => {
  const store = new MemoryAssistantStore();
  const service = new WorkAssistantService(config, store, new FakeGoogle(), new FakeClassifier());
  const plan = await service.generateDailyPlan("2026-08-06", true);
  assert.equal(plan.review.length, 1);
  assert.equal(plan.startHere, null);
});

test("completed active work does not carry into another workday", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([{ ...suggestion, status: "today", reviewedAt: "2026-08-06T16:00:00Z", reviewDecision: "addToday" }]);
  const service = new WorkAssistantService(config, store, new FakeGoogle(), { classify: async () => [] });
  await service.updateTask(suggestion.id, { completed: true });
  const monday = await service.generateDailyPlan("2026-08-10", true);
  assert.equal(monday.today.length, 0);
});

test("unfinished Friday work remains active on Monday", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([{ ...suggestion, status: "today", reviewedAt: "2026-08-07T16:00:00Z", reviewDecision: "addToday" }]);
  const service = new WorkAssistantService(config, store, new FakeGoogle(), { classify: async () => [] });
  const monday = await service.generateDailyPlan("2026-08-10", true);
  assert.deepEqual(monday.today.map((task) => task.id), [suggestion.id]);
});

test("migrated Friday work suppresses the duplicate Gmail review suggestion", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([
    suggestion,
    { ...suggestion, id: "noteplan-pilot", sourceType: "noteplan", status: "today", reviewedAt: "2026-08-07T16:00:00Z", reviewDecision: "addToday" },
  ]);
  const service = new WorkAssistantService(config, store, new FakeGoogle(), { classify: async () => [] });
  const monday = await service.generateDailyPlan("2026-08-10", true);
  assert.equal(monday.review.length, 0);
  assert.deepEqual(monday.today.map((task) => task.id), ["noteplan-pilot"]);
});

test("pilot migration activates Add Today and preserves Ignore decisions", async () => {
  const store = new MemoryAssistantStore();
  const service = new WorkAssistantService(config, store, new FakeGoogle(), { classify: async () => [] });
  const ignored = { ...suggestion, id: "gmail-ignored-ignore", title: "Handled work" };
  const result = await service.migratePilotReview([suggestion, ignored], { [suggestion.id]: "addToday", [ignored.id]: "ignore" });
  assert.equal(result.imported, 2);
  assert.equal((await store.getSuggestion(suggestion.id))?.status, "today");
  assert.equal((await store.getSuggestion(ignored.id))?.status, "ignored");
  assert.equal((await store.getSuggestion(suggestion.id))?.previousDay, "Friday");
});

test("confirmed main projects remain grouped with open task counts", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([{ ...suggestion, status: "today", reviewedAt: "2026-08-06T16:00:00Z", reviewDecision: "addToday" }]);
  const service = new WorkAssistantService(config, store, new FakeGoogle(), new FakeClassifier());
  await service.setProjectStatus("Client", "active");
  const projects = await service.listProjects();
  assert.equal(projects[0]?.status, "active");
  assert.equal(projects[0]?.openTaskCount, 1);
});

test("confirmed main projects influence Start Here priority", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([
    { ...suggestion, id: "other", sourceId: "other", title: "Other work", project: "Other", status: "today", confidence: 1, reviewedAt: "2026-08-07T16:00:00Z", reviewDecision: "addToday" },
    { ...suggestion, id: "circle", sourceId: "circle", title: "Circle work", project: "The Circle Education", status: "today", confidence: 0.5, reviewedAt: "2026-08-07T16:00:00Z", reviewDecision: "addToday" },
  ]);
  const service = new WorkAssistantService(config, store, new FakeGoogle(), { classify: async () => [] });
  await service.setProjectStatus("The Circle Education", "active");
  const monday = await service.generateDailyPlan("2026-08-10", true);
  assert.equal(monday.startHere?.id, "circle");
});

test("scheduled tasks activate on their date while waiting tasks remain grouped", async () => {
  const store = new MemoryAssistantStore();
  const scheduled = { ...suggestion, id: "scheduled", sourceId: "scheduled" };
  const waiting = { ...suggestion, id: "waiting", sourceId: "waiting" };
  await store.upsertSuggestions([scheduled, waiting]);
  await store.reviewSuggestion(scheduled.id, "schedule", { scheduledFor: "2026-08-10", waitingOn: null, followUpDate: null }, "2026-08-06T16:00:00Z");
  await store.reviewSuggestion(waiting.id, "waiting", { scheduledFor: null, waitingOn: "James", followUpDate: null }, "2026-08-06T16:00:00Z");
  const service = new WorkAssistantService(config, store, new FakeGoogle(), { classify: async () => [] });
  const before = await service.generateDailyPlan("2026-08-07", true);
  assert.equal(before.today.length, 0);
  assert.equal(before.scheduled.length, 1);
  assert.equal(before.waiting.length, 1);
  const due = await service.generateDailyPlan("2026-08-10", true);
  assert.deepEqual(due.today.map((task) => task.id), ["scheduled"]);
  assert.deepEqual(due.waiting.map((task) => task.id), ["waiting"]);
});

test("task corrections survive Gmail reprocessing", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([suggestion]);
  await store.correctSuggestion(suggestion.id, "Corrected client follow-up", "2026-08-06T16:00:00Z");
  await store.upsertSuggestions([{ ...suggestion, title: "Classifier wording" }]);
  const updated = await store.getSuggestion(suggestion.id);
  assert.equal(updated?.title, "Corrected client follow-up");
  assert.equal(updated?.userCorrection?.previousTitle, "Reply to client");
});

test("idea answers remain linked and generate the next question", async () => {
  const store = new MemoryAssistantStore();
  const service = new WorkAssistantService(config, store, new FakeGoogle(), new FakeClassifier());
  const captured = await service.captureIdea("Apply for a role");
  const first = await service.answerIdea(captured.ideaId, "Submit the application");
  assert.match(first.nextQuestion ?? "", /completed already/i);
  assert.equal(store.ideas[0]?.answers[0]?.answer, "Submit the application");
});
