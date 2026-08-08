import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDueDate } from "../src/classifier.js";
import { applyReviewDecision, calculateCapacity, checkInForDate, organizeCarryForward, stableTaskId, type TaskSuggestion } from "../src/domain.js";
import { applyKnownPreferences, normalizeProject } from "../src/preferences.js";
import { isAssistantDigest, utcDayRangeForTimeZone } from "../src/google.js";

const baseTask: TaskSuggestion = {
  id: "gmail-thread-action",
  actionKey: "action",
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

test("email tasks always need review before activation", () => {
  assert.equal(baseTask.status, "review");
  const emptyDetails = { scheduledFor: null, waitingOn: null, followUpDate: null };
  assert.equal(applyReviewDecision(baseTask, "addToday", emptyDetails, "2026-08-06T16:00:00Z").status, "today");
  assert.throws(() => applyReviewDecision(baseTask, "schedule", emptyDetails, "2026-08-06T16:00:00Z"));
  assert.throws(() => applyReviewDecision(baseTask, "waiting", emptyDetails, "2026-08-06T16:00:00Z"));
  const waiting = applyReviewDecision(baseTask, "waiting", { scheduledFor: null, waitingOn: "James", followUpDate: "2026-08-10" }, "2026-08-06T16:00:00Z");
  assert.equal(waiting.waitingOn, "James");
  assert.equal(waiting.followUpDate, "2026-08-10");
});

test("stable IDs deduplicate thread actions", () => {
  assert.equal(stableTaskId("abc", "Send Invoice"), stableTaskId("abc", "send invoice"));
  assert.notEqual(stableTaskId("abc", "invoice"), stableTaskId("abc", "testing"));
});

test("preserves unlimited unfinished tasks and Friday history", () => {
  const tasks = Array.from({ length: 25 }, (_, index) => ({ ...baseTask, id: String(index), previousDay: index === 0 ? "Friday" : null }));
  const result = organizeCarryForward(tasks, "Monday");
  assert.equal(result.length, 25);
  assert.equal(result[0]?.previousDay, "Friday");
});

test("capacity protects real commitments and transition time", () => {
  const available = calculateCapacity([
    { id: "one", title: "Private", start: "2026-08-06T09:00:00-07:00", end: "2026-08-06T09:30:00-07:00", sourceUrl: null, private: true },
    { id: "two", title: "Anniversary", start: "2026-08-06T16:00:00-07:00", end: "2026-08-06T17:00:00-07:00", sourceUrl: null, private: false },
  ], 9, 17, 15, "America/Vancouver");
  assert.equal(available, 360);
});

test("capacity uses configured timezone instead of host timezone", () => {
  const available = calculateCapacity([
    { id: "meeting", title: "Client", start: "2026-08-06T16:00:00Z", end: "2026-08-06T17:00:00Z", sourceUrl: null, private: false },
  ], 9, 17, 15, "America/Vancouver");
  assert.equal(available, 405);
});

test("asks check-ins three weekdays per week", () => {
  assert.ok(checkInForDate("2026-08-03"));
  assert.ok(checkInForDate("2026-08-05"));
  assert.ok(checkInForDate("2026-08-07"));
  assert.equal(checkInForDate("2026-08-06"), null);
});

test("does not re-propose the confirmed Automattic meeting", () => {
  const result = applyKnownPreferences([{ ...baseTask, sourceId: "19fcf694a8a2a1cf" }, baseTask]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.sourceId, "thread");
});

test("filters resolved Automattic attendance but preserves rescheduling", () => {
  const result = applyKnownPreferences([
    { ...baseTask, id: "attend", title: "Attend Automattic discovery meeting" },
    { ...baseTask, id: "reschedule", title: "Reschedule Automattic discovery meeting" },
    { ...baseTask, id: "receipt", title: "Record payment received — client invoice" },
  ]);
  assert.deepEqual(result.map((task) => task.id), ["reschedule"]);
});

test("normalizes known project aliases", () => {
  assert.equal(normalizeProject("FBCA website sync"), "Fanny Bay Community Association");
  assert.equal(normalizeProject("TopShelf"), "Top Shelf Hospitality");
  assert.equal(normalizeProject("The Circle"), "The Circle Education");
  assert.equal(normalizeProject("Domains / Hosting"), "Business Operations");
});

test("normalizes stored due dates while applying preferences", () => {
  const [task] = applyKnownPreferences([{ ...baseTask, dueDate: "2026-07-31T23:59:59.000Z" }]);
  assert.equal(task?.dueDate, "2026-07-31");
});

test("normalizes classifier due dates to date-only values", () => {
  assert.equal(normalizeDueDate("2026-07-31T23:59:59.000Z"), "2026-07-31");
  assert.equal(normalizeDueDate("not a date"), null);
});

test("skips old self-delivered assistant digests", () => {
  assert.equal(isAssistantDigest("Work Plan — August 7", "Leslee <leslee@example.com>", "leslee@example.com", "leslee@example.com"), true);
  assert.equal(isAssistantDigest("Client work plan", "client@example.com", "leslee@example.com", "leslee@example.com"), false);
});

test("timezone day windows respect DST and configured timezone", () => {
  assert.deepEqual(utcDayRangeForTimeZone("2026-01-15", "America/Vancouver"), {
    startIso: "2026-01-15T08:00:00.000Z",
    endIso: "2026-01-16T08:00:00.000Z",
  });
  assert.deepEqual(utcDayRangeForTimeZone("2026-07-15", "America/Vancouver"), {
    startIso: "2026-07-15T07:00:00.000Z",
    endIso: "2026-07-16T07:00:00.000Z",
  });
});
