import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateCapacity,
  buildPilotTransfer,
  applyTaskCorrection,
  mergeEmailTask,
  nextIdeaQuestion,
  organizeCarryForward,
  reviewEmailTask,
  taskFromEmail,
  verifiedCalendarEvents,
  verifiedTasks,
} from "./app.js";

test("preserves every valid unfinished task", () => {
  const tasks = [
    { id: "a", previousDay: "Friday" },
    { id: "b", waiting: true },
    { id: "c", urgent: true },
    { id: "d", done: true },
  ];

  const result = organizeCarryForward(tasks, "Monday");
  assert.deepEqual(result.map((task) => task.id), ["a", "b", "c"]);
  assert.equal(result[0].carriedFromFriday, true);
  assert.equal(result[1].group, "waiting");
  assert.equal(result[2].group, "must");
});

test("creates a review suggestion from a confident email", () => {
  const task = taskFromEmail({
    threadId: "123",
    sender: "Client",
    action: "Send the client invoice",
    due: "today",
    confidence: 0.94,
  });

  assert.equal(task.id, "gmail-123");
  assert.equal(task.group, "review");
  assert.match(task.meta, /Review required/);
});

test("does not create tasks from FYI or newsletter email", () => {
  assert.equal(taskFromEmail({ threadId: "1", action: "Read", fyiOnly: true }), null);
  assert.equal(taskFromEmail({ threadId: "2", action: "Read", newsletter: true }), null);
});

test("updates an existing email task instead of duplicating it", () => {
  const existing = [{ id: "gmail-123", title: "Old title" }];
  const updated = mergeEmailTask(existing, { id: "gmail-123", title: "Updated title" });

  assert.equal(updated.length, 1);
  assert.equal(updated[0].title, "Updated title");
});

test("uses only source-linked verified prototype tasks", () => {
  assert.equal(verifiedTasks.length, 11);
  assert.ok(verifiedTasks.every((task) => task.group === "review"));
  assert.ok(verifiedTasks.every((task) => task.sourceUrl.startsWith("https://mail.google.com/")));
  assert.ok(verifiedTasks.every((task) => task.verifiedAt));
});

test("retains task corrections as explicit feedback", () => {
  const corrected = applyTaskCorrection({ title: "Book an Automattic call" }, "Automattic meeting is already scheduled");
  assert.equal(corrected.title, "Automattic meeting is already scheduled");
  assert.equal(corrected.corrected, true);
});

test("asks one useful idea question at a time", () => {
  assert.match(nextIdeaQuestion(0), /done look like/i);
  assert.match(nextIdeaQuestion(1), /completed already/i);
  assert.match(nextIdeaQuestion(4), /smallest next action/i);
  assert.equal(nextIdeaQuestion(5), null);
});

test("builds a complete one-time NotePlan transfer", () => {
  const payload = buildPilotTransfer(verifiedTasks, { [verifiedTasks[0].id]: "addToday" }, { corrections: {}, events: [], ideas: [] }, { gmail: { checkedAt: "gmail-time" }, calendar: { checkedAt: "calendar-time" } }, 360);
  assert.equal(payload.version, 1);
  assert.equal(payload.tasks.length, 11);
  assert.equal(payload.decisions[verifiedTasks[0].id], "addToday");
  assert.equal(payload.availableMinutes, 360);
});

test("models Sparky's invoice and James dependencies correctly", () => {
  const sparkys = verifiedTasks.filter((task) => task.project === "Sparky’s");
  assert.equal(sparkys.length, 2);
  assert.match(sparkys[0].title, /invoice/i);
  assert.match(sparkys[1].title, /James.*content.*testing.*feedback/i);
  assert.ok(sparkys.every((task) => !/homepage/i.test(task.title)));
});

test("calculates 9–5 capacity with calendar transition buffers", () => {
  const capacity = calculateCapacity(verifiedCalendarEvents);
  assert.equal(capacity.busyMinutes, 120);
  assert.equal(capacity.availableMinutes, 360);
});

test("keeps email suggestions out of the active plan until reviewed", () => {
  const suggestion = { id: "email-321", title: "Reply to client", group: "review" };
  assert.equal(reviewEmailTask(suggestion, "addToday").group, "must");
  assert.equal(reviewEmailTask(suggestion, "waiting").group, "waiting");
  assert.equal(reviewEmailTask(suggestion, "ignore").group, "ignored");
});
