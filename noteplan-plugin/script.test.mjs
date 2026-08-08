import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./script.js", import.meta.url), "utf8");

function pluginContext(overrides = {}) {
  const notes = new Map();
  const json = new Map();
  const context = vm.createContext({
    console,
    fetch: async () => { throw new Error("Unexpected fetch"); },
    DataStore: {
      settings: {},
      calendarNotes: [],
      projectNotes: [],
      calendarNoteByDateString: (date) => notes.get(date) || null,
      loadJSON: (name) => json.get(name) || null,
      saveJSON: (value, name) => json.set(name, structuredClone(value)),
    },
    CommandBar: { prompt: async () => null, showInput: async () => null },
    NotePlan: { openURL: async () => {} },
    HTMLView: { showWindow: () => {} },
    Calendar: { eventsToday: async () => [], eventsBetween: async () => [] },
    ...overrides,
  });
  vm.runInContext(source, context);
  return { context, notes, json, run: (expression) => vm.runInContext(expression, context) };
}

test("date navigation skips weekends in both directions", () => {
  const { run } = pluginContext();
  assert.equal(run('moveWorkday("2026-08-07", 1)'), "2026-08-10");
  assert.equal(run('moveWorkday("2026-08-10", -1)'), "2026-08-07");
});

test("selected dates use the correct planning window", () => {
  const { run } = pluginContext();
  const today = run("localDate()");
  const future = run(`moveWorkday("${today}", 1)`);
  const past = run(`moveWorkday("${today}", -1)`);
  assert.equal(run(`planningStartMinute("${future}", new Date("${today}T16:25:00"))`), 540);
  assert.equal(run(`planningStartMinute("${past}", new Date("${today}T16:25:00"))`), 1020);
  assert.equal(run(`planningStartMinute("${today}", new Date("${today}T16:25:00"))`), 990);
});

test("dashboard exposes previous, today, and next-workday links", () => {
  const { run, context } = pluginContext();
  const today = run("localDate()");
  context.plan = {
    date: today,
    generatedAt: `${today}T16:25:00`,
    sources: [], warnings: [], startHere: null, review: [], today: [], waiting: [], scheduled: [], other: [], ideas: [],
    availableMinutes: 0, focusBlocks: [], calendarEvents: [], hasExistingFocusBlocks: false, planningStartMinute: 990,
    nextInstruction: "Shut down.",
  };
  const html = run("dashboardHtml(plan)");
  assert.match(html, /← Previous/);
  assert.match(html, />Today</);
  assert.match(html, /Next Workday →/);
  assert.match(html, /arg0=/);
  assert.match(html, /Drag blocks to move them/);
  assert.match(html, /saveFocusBlock/);
  assert.match(html, /Anything new or corrected that you want me to remember/);
  assert.match(html, /Live Gmail setup required/);
  assert.doesNotMatch(html, /Connect \/ Reconnect Google/);
});

test("connected dashboard exposes bounded older-email scanning", () => {
  const { run, context } = pluginContext({ DataStore: { settings: { serviceUrl: "https://service.example.com", apiToken: "private-token" }, calendarNotes: [], projectNotes: [], calendarNoteByDateString: () => null, loadJSON: () => null, saveJSON: () => {} } });
  context.plan = {
    date: "2026-08-10", generatedAt: "2026-08-10T16:25:00", sources: [], warnings: [], startHere: null,
    review: [], today: [], waiting: [], scheduled: [], other: [], ideas: [], availableMinutes: 480,
    focusBlocks: [], calendarEvents: [], hasExistingFocusBlocks: false, planningStartMinute: 540, nextInstruction: "Begin.",
    emailCoverage: { complete: false, scannedThreads: 75, lastScanAt: null }, projects: [],
  };
  const html = run("dashboardHtml(plan)");
  assert.match(html, /Continue Full Email Scan · 75 checked/);
  assert.match(html, /Assistant%3A%20Scan%20Older%20Email/);
});

test("dashboard shows every email review item with direct decisions", () => {
  const { run, context } = pluginContext({ DataStore: { settings: { serviceUrl: "https://service.example.com", apiToken: "private-token" }, calendarNotes: [], projectNotes: [], calendarNoteByDateString: () => null, loadJSON: () => null, saveJSON: () => {} } });
  const task = (index) => ({ id: `review-${index}`, title: `Review item ${index}`, project: "Client", sourceUrl: "https://mail.google.com", scheduledFor: null });
  context.plan = {
    date: "2026-08-10", generatedAt: "2026-08-10T09:00:00", sources: [], warnings: [], startHere: null,
    review: Array.from({ length: 9 }, (_, index) => task(index)), today: [], waiting: [], scheduled: [], other: [], ideas: [], projects: [],
    emailCoverage: { complete: true, scannedThreads: 100, lastScanAt: null }, availableMinutes: 480,
    focusBlocks: [], calendarEvents: [], planningStartMinute: 540, nextInstruction: "Review.",
  };
  const html = run("dashboardHtml(plan)");
  assert.match(html, /Review item 8/);
  assert.match(html, /data-review="today"/);
  assert.match(html, /data-review="schedule"/);
  assert.match(html, /data-review="waiting"/);
  assert.match(html, /data-review="ignore"/);
});

test("active projects are listed and unconfirmed projects ask one button question", () => {
  const { run, context } = pluginContext();
  context.projects = [
    { id: "active", name: "Sparky's", status: "active", openTaskCount: 2 },
    { id: "new", name: "The Circle", status: "unconfirmed", openTaskCount: 3 },
  ];
  const html = run("projectsDashboardSection(projects)");
  assert.match(html, /Sparky&#039;s/);
  assert.match(html, /Is <strong>The Circle<\/strong> a main project/);
  assert.match(html, /Yes, active/);
  assert.match(html, /Later/);
  assert.match(html, /Not active/);
});

test("service requests parse NotePlan string responses", async () => {
  const { run } = pluginContext({
    fetch: async () => JSON.stringify({ connected: true }),
    DataStore: { settings: { serviceUrl: "https://service.example.com", apiToken: "private-token" } },
  });
  assert.equal((await run('request("/api/status")')).connected, true);
});

test("service requests retain standard fetch compatibility", async () => {
  const { run } = pluginContext({
    fetch: async () => ({ ok: true, json: async () => ({ connected: true }) }),
    DataStore: { settings: { serviceUrl: "https://service.example.com", apiToken: "private-token" } },
  });
  assert.deepEqual(await run('request("/api/status")'), { connected: true });
});

test("daily note includes a prominent dashboard button", () => {
  const { run, context } = pluginContext();
  context.plan = { date: "2026-08-10", sources: [], warnings: [], startHere: null, review: [], today: [], waiting: [], scheduled: [], other: [], availableMinutes: 480, ideas: [], checkInQuestion: null };
  const markdown = run("planMarkdown(plan)");
  assert.match(markdown, /🟢 OPEN WORK DASHBOARD/);
  assert.match(markdown, /noteplan:\/\/x-callback-url\/runPlugin/);
  assert.doesNotMatch(markdown, /work-assistant:start/);
  assert.doesNotMatch(markdown, /### Today/);
});

test("daily note migration removes old visible markers and task duplication", () => {
  const { run, context } = pluginContext();
  context.oldContent = "Personal text\n\n%% work-assistant:start %%\n## Work Activation\n### Today\n* Old task\n%% work-assistant:end %%";
  context.newSection = "## Work Activation\n> Dashboard";
  const updated = run("replaceAssistantSection(oldContent, newSection)");
  assert.equal(updated, "Personal text\n\n## Work Activation\n> Dashboard");
});

test("scheduled and waiting pilot tasks activate on their chosen date", () => {
  const { run, context } = pluginContext();
  context.payload = {
    version: 1,
    tasks: [{ id: "scheduled", title: "Scheduled task" }, { id: "waiting", title: "Waiting task", waitingOn: "James" }],
    decisions: { scheduled: "schedule", waiting: "waiting" },
    feedback: { schedules: { scheduled: "2026-08-10" }, waitingDates: { waiting: "2026-08-10" } },
  };
  const before = run('pilotPlanFromTransfer(payload, [], "2026-08-07")');
  assert.equal(before.today.length, 0);
  assert.equal(before.scheduled.length, 1);
  assert.equal(before.waiting.length, 1);
  const due = run('pilotPlanFromTransfer(payload, [], "2026-08-10")');
  assert.equal(due.today.length, 2);
});

test("dashboard focus block edits persist without writing a daily note", () => {
  const { run, context, notes } = pluginContext();
  context.suggestions = [{ task: { id: "invoice", title: "Finish invoice", project: "Sparky's" }, start: 600, end: 660 }];
  const initial = run('dashboardBlocksForDate("2026-08-10", suggestions)');
  assert.equal(initial[0].start, 600);
  run('saveDashboardBlock("2026-08-10", { id: "focus-invoice", start: 630, end: 720 })');
  const reopened = run('dashboardBlocksForDate("2026-08-10", [])');
  assert.equal(reopened[0].start, 630);
  assert.equal(reopened[0].end, 720);
  assert.equal(notes.size, 0);
});

test("dashboard collisions use visible calendar times and allow block swapping", () => {
  const { run, context } = pluginContext();
  context.plan = { date: "2026-08-10", calendarEvents: [{ start: "2026-08-10T10:00:00-07:00", end: "2026-08-10T11:00:00-07:00", allDay: false }] };
  const script = run("dashboardInteractionScript(plan)");
  assert.match(script, /\[{"start":600,"end":660}\]/);
  assert.match(script, /Blocks swapped and saved/);
  assert.doesNotMatch(script, /"start":590/);
});

test("focus blocks use concise labels while retaining the full title", () => {
  const { run, context } = pluginContext();
  context.blockPlan = { date: "2026-08-10", planningStartMinute: 540, calendarEvents: [], focusBlocks: [{ id: "focus-long", start: 540, end: 600, task: { id: "long", title: "Follow up with Sparky's and James about all remaining website requirements" } }] };
  const html = run("timelineHtml(blockPlan)");
  assert.match(html, /title="Follow up with Sparky/);
  assert.match(html, /Sparky&#039;s and James about all rema…/);
  assert.match(html, /class="block-edit"/);
  assert.match(html, /class="block-done"/);
  assert.doesNotMatch(html, />Follow up with Sparky's and James about all remaining website requirements</);
});

test("unfinished daily-note tasks roll forward as active work", () => {
  const { run, context } = pluginContext();
  const yesterday = run("localDate(-1)");
  context.DataStore.calendarNotes = [{
    filename: yesterday.replaceAll("-", ""), title: yesterday,
    paragraphs: [{ id: "open-one", type: "open", content: "Finish client invoice" }],
  }];
  const tasks = run("collectOpenTasks()");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "today");
  assert.equal(tasks[0].scheduledFor, null);
});

test("dashboard completion updates the service and removes saved blocks", async () => {
  const calls = [];
  const { run, context, json } = pluginContext({ fetch: async (url, options) => { calls.push({ url, options }); return JSON.stringify({ id: "task-one", status: "done" }); } });
  context.DataStore.settings = { serviceUrl: "https://service.example.com", apiToken: "private-token" };
  json.set("dashboard-focus-blocks.json", { version: 1, dates: { "2026-08-10": [{ id: "focus-task-one", taskId: "task-one", title: "Task", start: 600, end: 660 }] } });
  context.completion = { id: "task-one" };
  await run("onMessageFromHTMLView('completeTask', completion)");
  assert.match(calls[0].url, /\/api\/tasks\/task-one$/);
  assert.equal(json.get("dashboard-focus-blocks.json").dates["2026-08-10"].length, 0);
});

test("scheduled dashboard items open date and time controls", () => {
  const { run, context } = pluginContext();
  context.items = [{ id: "task-one", title: "Prepare invoice", project: "Client", scheduledFor: null }];
  const section = run("scheduledDashboardSection(items)");
  assert.match(section, /class="task scheduled-task"/);
  assert.match(section, /Choose a date and time/);
  context.plan = { date: "2026-08-10", planningStartMinute: 540, calendarEvents: [] };
  const script = run("dashboardInteractionScript(plan)");
  assert.match(script, /schedule-date/);
  assert.match(script, /schedule-time/);
  assert.match(script, /scheduleTask/);
});

test("scheduling creates a persisted dashboard block and updates pilot data", async () => {
  const { run, context, json } = pluginContext();
  json.set("pilot-review.json", { version: 1, tasks: [{ id: "task-one", title: "Prepare invoice" }], decisions: {}, feedback: {} });
  context.scheduleData = { date: "2026-08-10", task: { id: "task-one", title: "Prepare invoice", project: "Client" }, start: 600, end: 660 };
  await run("onMessageFromHTMLView('scheduleTask', scheduleData)");
  assert.equal(json.get("pilot-review.json").feedback.schedules["task-one"], "2026-08-10");
  const block = json.get("dashboard-focus-blocks.json").dates["2026-08-10"][0];
  assert.equal(block.title, "Prepare invoice");
  assert.equal(block.start, 600);
  assert.equal(block.end, 660);
});

test("dashboard feedback is retained locally and in pilot history", async () => {
  const { run, context, json } = pluginContext();
  json.set("pilot-review.json", { version: 1, tasks: [], decisions: {}, feedback: {} });
  context.feedback = { type: "correction", text: "The Automattic meeting is already arranged.", date: "2026-08-10" };
  await run("onMessageFromHTMLView('saveDashboardFeedback', feedback)");
  assert.equal(json.get("dashboard-feedback.json").entries[0].type, "correction");
  assert.equal(json.get("pilot-review.json").feedback.events[0].answer, "The Automattic meeting is already arranged.");
});

test("refresh command refuses to imply a Gmail check without a connection", async () => {
  const prompts = [];
  const { run } = pluginContext({ CommandBar: { prompt: async (title, message) => { prompts.push({ title, message }); return "Cancel"; }, showInput: async () => null } });
  await run("assistantRefreshDashboard('2026-08-10')");
  assert.match(prompts[0].message, /cannot be connected or refreshed/i);
});

test("date input validation rejects impossible dates", () => {
  const { run } = pluginContext();
  assert.equal(run('validDateString("2026-08-10")'), true);
  assert.equal(run('validDateString("2026-02-30")'), false);
  assert.equal(run('validDateString("next Monday")'), false);
});
