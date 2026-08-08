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
  async classify(_threads: EmailThreadInput[]): Promise<TaskSuggestion[]> { return [suggestion]; }
}

class FakeGoogle implements GoogleDataGateway {
  documents = 0;
  emails = 0;
  failGmail = false;
  authorizationUrl() { return "https://accounts.google.com/auth"; }
  async exchangeCode() {}
  async hasConnection() { return true; }
  async readRecentThreads() { if (this.failGmail) throw new ReconnectRequiredError(); return { historyId: "123", mode: "incremental" as const, threads: [{ threadId: "thread", sender: "Client", subject: "Question", sentByUser: false, latestAt: "2026-08-06T15:00:00Z", content: "Please reply", sourceUrl: suggestion.sourceUrl! }] }; }
  async readBacklogThreads() { return { nextBeforeEpoch: 1, complete: false, threads: [{ threadId: "thread", sender: "Client", subject: "Question", sentByUser: false, latestAt: "2026-07-01T15:00:00Z", content: "Please reply", sourceUrl: suggestion.sourceUrl! }] }; }
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
  assert.equal(second.generatedAt, first.generatedAt);
  assert.equal(google.documents, 0);
  assert.equal(google.emails, 0);
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
  await store.reviewSuggestion(suggestion.id, "waiting", { scheduledFor: null, waitingOn: "Client", followUpDate: "2026-08-10" }, "2026-08-06T16:00:00Z");
  await store.upsertSuggestions([{ ...suggestion, title: "Updated reply wording" }]);
  const updated = await store.getSuggestion(suggestion.id);
  assert.equal(updated?.status, "waiting");
  assert.equal(updated?.followUpDate, "2026-08-10");
  assert.equal(updated?.title, "Updated reply wording");
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

test("confirmed main projects remain grouped with open task counts", async () => {
  const store = new MemoryAssistantStore();
  await store.upsertSuggestions([{ ...suggestion, status: "today", reviewedAt: "2026-08-06T16:00:00Z", reviewDecision: "addToday" }]);
  const service = new WorkAssistantService(config, store, new FakeGoogle(), new FakeClassifier());
  await service.setProjectStatus("Client", "active");
  const projects = await service.listProjects();
  assert.equal(projects[0]?.status, "active");
  assert.equal(projects[0]?.openTaskCount, 1);
});

test("scheduled and waiting tasks activate on their selected date", async () => {
  const store = new MemoryAssistantStore();
  const scheduled = { ...suggestion, id: "scheduled", sourceId: "scheduled" };
  const waiting = { ...suggestion, id: "waiting", sourceId: "waiting" };
  await store.upsertSuggestions([scheduled, waiting]);
  await store.reviewSuggestion(scheduled.id, "schedule", { scheduledFor: "2026-08-10", waitingOn: null, followUpDate: null }, "2026-08-06T16:00:00Z");
  await store.reviewSuggestion(waiting.id, "waiting", { scheduledFor: null, waitingOn: "James", followUpDate: "2026-08-10" }, "2026-08-06T16:00:00Z");
  const service = new WorkAssistantService(config, store, new FakeGoogle(), { classify: async () => [] });
  const before = await service.generateDailyPlan("2026-08-07", true);
  assert.equal(before.today.length, 0);
  assert.equal(before.scheduled.length, 1);
  assert.equal(before.waiting.length, 1);
  const due = await service.generateDailyPlan("2026-08-10", true);
  assert.deepEqual(due.today.map((task) => task.id).sort(), ["scheduled", "waiting"]);
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
