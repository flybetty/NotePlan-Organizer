import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./script.js", import.meta.url), "utf8");

test("displayed plugin version matches the manifest", () => {
  const manifest = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8"));
  const { run } = pluginContext();
  assert.equal(run("PLUGIN_VERSION"), manifest["plugin.version"]);
});

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
    HTMLView: { showWindow: () => {}, showWindowWithOptions: () => {} },
    Calendar: { eventsToday: async () => [], eventsBetween: async () => [] },
    ...overrides,
  });
  vm.runInContext(source, context);
  return { context, notes, json, run: (expression) => vm.runInContext(expression, context) };
}

function addDailyNote(environment, date, content = "") {
  const note = { filename: date.replaceAll("-", ""), title: date, content, paragraphs: [] };
  environment.notes.set(note.filename, note);
  environment.context.DataStore.calendarNotes.push(note);
  return note;
}

test("date navigation skips weekends in both directions", () => {
  const { run } = pluginContext();
  assert.equal(run('moveWorkday("2026-08-07", 1)'), "2026-08-10");
  assert.equal(run('moveWorkday("2026-08-10", -1)'), "2026-08-07");
});

test("native task parser accepts NotePlan scheduling suffixes", () => {
  const { run } = pluginContext();
  const details = run(`nativeTaskDetails("* [x] 10:00 AM - 11:00 AM Finish invoice [email](https://mail.google.com/thread) #assistant/work ^w7wdpv >2026-08-17")`);
  assert.equal(details.blockId, "w7wdpv");
  assert.equal(details.title, "Finish invoice");
  assert.equal(details.start, 600);
  assert.equal(details.end, 660);
  assert.equal(details.completed, true);
  assert.equal(details.scheduledDate, "2026-08-17");
});

test("native NotePlan date links define the effective scheduled workday", () => {
  const environment = pluginContext();
  addDailyNote(environment, "2026-08-14", "## Work Activation Tasks\n* 10:00 AM - 11:00 AM Monday work #assistant/work ^wmonda >2026-08-17");
  environment.json.set("native-task-index.json", { version: 1, tasks: { monday: { blockId: "wmonda", date: "2026-08-14", title: "Monday work", status: "scheduled", done: false } } });
  environment.context.collections = environment.run(`nativeTaskCollections("2026-08-17")`);
  assert.equal(environment.context.collections.focusBlocks.length, 1);
  assert.equal(environment.context.collections.focusBlocks[0].task.title, "Monday work");
});

test("native collections are authoritative over stale cloud active lists", () => {
  const environment = pluginContext();
  addDailyNote(environment, "2026-08-17", "## Work Activation Tasks\n* Native real task #assistant/work ^wnativ");
  environment.json.set("native-task-index.json", { version: 1, tasks: { "native-task": { blockId: "wnativ", date: "2026-08-17", title: "Native real task", status: "today", done: false } } });
  environment.context.collections = environment.run(`nativeTaskCollections("2026-08-17")`);
  assert.deepEqual(Array.from(environment.context.collections.today, (task) => task.title), ["Native real task"]);
  assert.equal(environment.context.collections.focusBlocks.length, 0);
});

test("terminal decisions remove ignored native tasks before dashboard rendering", () => {
  const environment = pluginContext();
  const note = addDailyNote(environment, "2026-08-17", "## Work Activation Tasks\n* Ignore forever #assistant/work ^wignor");
  environment.json.set("native-task-index.json", { version: 1, tasks: { ignored: { blockId: "wignor", date: "2026-08-17", title: "Ignore forever", status: "today", done: false } } });
  environment.context.states = [{ id: "ignored", status: "ignored", reviewDecision: "ignore" }];
  assert.equal(environment.run("applyTerminalTaskStates(states)"), true);
  assert.doesNotMatch(note.content, /Ignore forever/);
  assert.equal(environment.json.get("native-task-index.json").tasks.ignored, undefined);
});

test("cached review cards are filtered by durable terminal decisions", () => {
  const { run, context } = pluginContext();
  context.plan = { review: [{ id: "duplicate", sourceId: "old-thread", actionKey: "follow up", title: "Please follow up with James", project: "Sparky's", emailLastActivityAt: "2026-08-06T15:00:00Z" }], waiting: [] };
  context.states = [{ id: "ignored", sourceId: "other-thread", actionKey: "follow-up", title: "Follow up with James", project: "Sparky's", status: "ignored", reviewDecision: "ignore", reviewedAt: "2026-08-07T16:00:00Z" }];
  const filtered = run("filterPlanByTaskStates(plan, states)");
  assert.equal(filtered.review.length, 0);
});

test("duplicate native placements collapse to the latest one", () => {
  const environment = pluginContext();
  const friday = addDailyNote(environment, "2026-08-14", "## Work Activation Tasks\n* Old copy #assistant/work ^wdupli");
  const monday = addDailyNote(environment, "2026-08-17", "## Work Activation Tasks\n* Current copy #assistant/work ^wdupli");
  environment.json.set("native-task-index.json", { version: 1, tasks: { duplicate: { blockId: "wdupli", date: "2026-08-14", title: "Old copy", status: "today", done: false } } });
  assert.equal(environment.run("deduplicateNativeTaskOccurrences()"), 1);
  assert.doesNotMatch(friday.content, /Old copy/);
  assert.match(monday.content, /Current copy/);
  assert.equal(environment.json.get("native-task-index.json").tasks.duplicate.date, "2026-08-17");
});

test("old review email is collapsed into a separate backlog", () => {
  const { run, context } = pluginContext();
  context.items = [
    { id: "new", title: "New action", emailReceivedAt: "2026-08-16T15:00:00Z" },
    { id: "old", title: "Old action", emailReceivedAt: "2026-06-01T15:00:00Z" },
  ];
  const html = run('reviewDashboardSection(items, "2026-08-17")');
  assert.match(html, /Email Task Review/);
  assert.match(html, /Older Email Backlog · 1/);
  assert.match(html, /<details class="email-backlog">/);
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
  assert.match(html, /Assistant%3A%20View%20Workday/);
  assert.match(html, /Drag blocks to move them/);
  assert.match(html, /saveFocusBlock/);
  assert.match(html, /Anything new or corrected that you want me to remember/);
  assert.match(html, /Live Gmail setup required/);
  assert.doesNotMatch(html, /Connect \/ Reconnect Google/);
});

test("Active Task completion uses a native NotePlan command link", () => {
  const { run, context } = pluginContext();
  context.activeTask = { id: "active-one", title: "Finish active work", status: "today", project: "Client" };
  const html = run('dashboardSection("Active Tasks", [activeTask], "Empty", "aqua", true, "2026-08-14")');
  assert.match(html, /class="check complete-task"/);
  assert.match(html, /Assistant%3A%20Complete%20Task/);
  assert.match(html, /arg0=active-one/);
  assert.match(html, /arg1=2026-08-14/);
  assert.doesNotMatch(html, /<button class="check complete-task"/);
});

test("approved unblocked tasks show their source and permanent Ignore action", () => {
  const { run, context } = pluginContext();
  context.activeTask = { id: "active-email", title: "Old email task", status: "scheduled", sourceType: "gmail", scheduledFor: "2026-08-14" };
  const html = run('dashboardSection("Approved — Not Yet Blocked", [activeTask], "Empty", "aqua", true, "2026-08-14")');
  assert.match(html, /Approved — Not Yet Blocked/);
  assert.match(html, /Email · Scheduled 2026-08-14/);
  assert.match(html, />Ignore</);
  assert.match(html, /arg1=ignore/);
});

test("Next Workday opens from verified saved state when that date has no generated cloud plan", async () => {
  const calls = [];
  const shown = [];
  const prompts = [];
  const environment = pluginContext({
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith("/api/projects")) return JSON.stringify({ projects: [] });
      if (url.includes("/api/today")) {
        const date = new URL(url).searchParams.get("date");
        if (date === "2026-08-18") return "null";
        return JSON.stringify({ date, generatedAt: "2026-08-13T15:00:00Z", sources: [{ source: "gmail", status: "connected", checkedAt: "2026-08-13T15:00:00Z" }], warnings: [], startHere: null, review: [], today: [], waiting: [], scheduled: [], other: [], projects: [], calendar: [], emailCoverage: { complete: true, scannedThreads: 10, lastScanAt: "2026-08-13T15:00:00Z" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    DataStore: { settings: { serviceUrl: "https://service.example.com", apiToken: "secret" }, calendarNotes: [], projectNotes: [], calendarNoteByDateString: () => null, loadJSON: () => null, saveJSON: () => {} },
    CommandBar: { prompt: async (...args) => prompts.push(args), showInput: async () => null },
    HTMLView: { showWindowWithOptions: (html) => shown.push(html) },
  });
  await environment.run("assistantViewWorkday('2026-08-18')");
  assert.ok(calls.some((url) => url.includes("/api/today?date=2026-08-18")));
  assert.ok(calls.some((url) => url.includes("/api/today?date=2026-08-17")));
  assert.equal(shown.length, 1);
  assert.match(shown[0], /Tuesday, August 18/);
  assert.match(shown[0], /No cloud report was generated/);
  assert.equal(prompts.length, 0);
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

test("dashboard shows every email review item with received dates and direct decisions", () => {
  const { run, context } = pluginContext({ DataStore: { settings: { serviceUrl: "https://service.example.com", apiToken: "private-token" }, calendarNotes: [], projectNotes: [], calendarNoteByDateString: () => null, loadJSON: () => null, saveJSON: () => {} } });
  const task = (index) => ({ id: `review-${index}`, title: `Review item ${index}`, project: "Client", sourceUrl: "https://mail.google.com", emailReceivedAt: "2026-08-06T15:30:00Z", scheduledFor: null });
  context.plan = {
    date: "2026-08-10", generatedAt: "2026-08-10T09:00:00", sources: [], warnings: [], startHere: null,
    review: Array.from({ length: 9 }, (_, index) => task(index)), today: [], waiting: [], scheduled: [], other: [], ideas: [], projects: [],
    emailCoverage: { complete: true, scannedThreads: 100, lastScanAt: null }, availableMinutes: 480,
    focusBlocks: [], calendarEvents: [], planningStartMinute: 540, nextInstruction: "Review.",
  };
  const html = run("dashboardHtml(plan)");
  assert.match(html, /Review item 8/);
  assert.match(html, /Received/);
  assert.match(html, /Aug 6, 2026/);
  assert.match(html, /Assistant%3A%20Review%20Email%20Tasks/);
  assert.match(html, /arg1=addToday/);
  assert.match(html, /data-review="schedule"/);
  assert.match(html, /data-review="waiting"/);
  assert.match(html, /data-direct-decision="complete"/);
  assert.match(html, />Completed</);
  assert.match(html, /data-direct-decision="ignore"/);
  assert.match(html, /draggable="true"/);
  assert.match(html, /Drag into the visible schedule/);
  assert.match(html, /data-group-select/);
  assert.match(html, /Group & Schedule/);
  assert.match(html, /groupSchedule/);
  assert.match(html, /\.side\{position:sticky;top:0;height:100vh;overflow-y:auto\}/);
  assert.match(html, /combine related items into one task/);
  assert.match(html, /main\.insertBefore\(reviewPanel, heroPanel\)/);
});

test("waiting items render together without invented follow-up dates", () => {
  const { run, context } = pluginContext();
  context.waitingItems = [
    { id: "wait-one", title: "Finish client setup", waitingOn: "James", waitingSince: "2026-08-04T16:00:00Z", sourceUrl: "https://mail.google.com/one" },
    { id: "wait-two", title: "Confirm final copy", waitingOn: "Amanda", waitingSince: "2026-08-05T16:00:00Z", sourceUrl: "https://mail.google.com/two" },
  ];
  const html = run("waitingDashboardSection(waitingItems)");
  assert.match(html, /⏳ Waiting Review/);
  assert.match(html, /Waiting on James · since 2026-08-04/);
  assert.match(html, /Waiting on Amanda · since 2026-08-05/);
  assert.doesNotMatch(html, /Follow up/);
});

test("returned waiting reply is automatically placed in the next open native block", async () => {
  const targetDate = "2026-08-18";
  const returned = { id: "returned-waiting", title: "Finish website after reply", project: "Client", status: "scheduled", scheduledFor: targetDate, returnedFromWaiting: true, waitingOn: "James", waitingResponseReceivedAt: "2026-08-17T18:00:00Z" };
  const environment = pluginContext({ fetch: async (url) => {
    if (url.endsWith("/api/projects")) return JSON.stringify({ projects: [] });
    if (url.includes("/api/today")) return JSON.stringify({ date: targetDate, generatedAt: "2026-08-17T18:00:00Z", sources: [], warnings: [], startHere: returned, review: [], today: [returned], waiting: [], scheduled: [], other: [], projects: [], calendar: [], emailCoverage: { complete: true, scannedThreads: 1, lastScanAt: null } });
    throw new Error(`Unexpected request: ${url}`);
  } });
  environment.context.DataStore.settings = { serviceUrl: "https://service.example.com", apiToken: "private-token" };
  const note = addDailyNote(environment, targetDate);
  environment.context.returnedPlan = await environment.run(`currentPlan("${targetDate}")`);
  assert.match(note.content, /^\* 9:00 AM - 9:30 AM ↩ Finish website after reply/m);
  assert.equal(environment.context.returnedPlan.today.length, 0);
  assert.equal(environment.context.returnedPlan.focusBlocks[0].returnedFromWaiting, true);
  const html = environment.run("timelineHtml(returnedPlan)");
  assert.match(html, /cal-block focus returned-waiting/);
  assert.match(html, /↩ Finish website after reply/);
});

test("related email actions are suggested as cautious project or content groups", () => {
  const { run, context } = pluginContext();
  context.items = [
    { id: "sparky-invoice", title: "Prepare completed website invoice", project: "Sparky’s" },
    { id: "sparky-testing", title: "Confirm James completed product testing", project: "Sparky’s" },
    { id: "studio-sync", title: "Investigate booking synchronization errors", project: null },
    { id: "studio-errors", title: "Document booking synchronization errors", project: null },
    { id: "unrelated", title: "Reply about office access", project: null },
  ];
  const groups = JSON.parse(run("JSON.stringify(suggestedReviewGroups(items))"));
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find((group) => group.label === "Sparky’s").ids, ["sparky-invoice", "sparky-testing"]);
  assert.deepEqual(groups.find((group) => group.label.includes("booking")).ids, ["studio-errors", "studio-sync"]);
  assert.ok(groups.every((group) => !group.ids.includes("unrelated")));
});

test("sent-only email review items show latest thread activity without calling it received", () => {
  const { run, context } = pluginContext();
  context.task = { id: "sent-only", title: "Follow up", project: "Client", sourceUrl: "https://mail.google.com", emailReceivedAt: null, emailLastActivityAt: "2026-08-07T18:00:00Z" };
  const html = run("reviewDashboardTask(task)");
  assert.match(html, /Latest thread activity/);
  assert.doesNotMatch(html, />Received/);
});

test("threads with a newer sent reply are clearly labeled as sent by the user", () => {
  const { run, context } = pluginContext();
  context.task = { id: "sent-follow-up", title: "Wait for verification code", project: "Client", sourceUrl: "https://mail.google.com", emailReceivedAt: "2026-08-10T17:33:00Z", emailLastActivityAt: "2026-08-10T18:55:03Z" };
  const html = run("reviewDashboardTask(task)");
  assert.match(html, /You sent/);
  assert.match(html, /Last received/);
  assert.doesNotMatch(html, /class="received-date">Received/);
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

test("project answers persist and trigger exactly one dashboard refresh", async () => {
  const calls = [];
  const shown = [];
  const activeProject = { id: "circle", name: "The Circle Education", status: "active", openTaskCount: 2 };
  const { run, context } = pluginContext({
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/api/projects") && options.method === "POST") return JSON.stringify({ projects: [activeProject] });
      if (url.endsWith("/api/projects")) return JSON.stringify({ projects: [activeProject] });
      if (url.includes("/api/today")) return JSON.stringify({ date: "2026-08-10", sources: [], warnings: [], startHere: null, review: [], today: [], waiting: [], scheduled: [], other: [], projects: [], emailCoverage: { complete: true, scannedThreads: 1, lastScanAt: null } });
      return JSON.stringify({ imported: 0 });
    },
    DataStore: { settings: { serviceUrl: "https://service.example.com", apiToken: "private-token" }, calendarNotes: [], projectNotes: [], loadJSON: () => null, saveJSON: () => {} },
    HTMLView: { showWindowWithOptions: (html) => shown.push(html) },
  });
  context.projectAnswer = { name: "The Circle Education", status: "active", date: "2026-08-10" };
  await run("onMessageFromHTMLView('projectStatus', projectAnswer)");
  const projectPost = calls.find((call) => call.url.endsWith("/api/projects") && call.options.method === "POST");
  assert.equal(JSON.parse(projectPost.options.body).status, "active");
  assert.equal(shown.length, 1);
  assert.match(shown[0], /The Circle Education/);
  assert.match(shown[0], /2 open/);
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

test("service requests explain an empty NotePlan fetch response", async () => {
  const { run } = pluginContext({
    fetch: async () => undefined,
    DataStore: { settings: { serviceUrl: "https://service.example.com", apiToken: "private-token" } },
  });
  await assert.rejects(() => run('request("/api/status")'), /did not return a response/);
});

test("daily note includes a prominent dashboard button", () => {
  const { run, context } = pluginContext();
  context.plan = { date: "2026-08-10", sources: [], warnings: [], startHere: null, review: [], today: [], waiting: [], scheduled: [], other: [], availableMinutes: 480, ideas: [], checkInQuestion: null };
  const markdown = run("planMarkdown(plan)");
  assert.match(markdown, /🟢 OPEN WORK DASHBOARD/);
  assert.match(markdown, /noteplan:\/\/x-callback-url\/runPlugin/);
  assert.doesNotMatch(markdown, /arg0=/);
  assert.doesNotMatch(markdown, /work-assistant:start/);
  assert.doesNotMatch(markdown, /### Today/);
});

test("daily note migration removes old visible markers and task duplication", () => {
  const { run, context } = pluginContext();
  context.oldContent = "Personal text\n\n%% work-assistant:start %%\n## Work Activation\n### Today\n* Old task\n%% work-assistant:end %%";
  context.newSection = "## Work Activation\n> Dashboard";
  const updated = run("replaceAssistantSection(oldContent, newSection)");
  assert.equal(updated, "Personal text\n\n## Work Activation\n> Dashboard");
  context.oldContent = "b## Work Activation\n> Old dashboard";
  assert.equal(run("replaceAssistantSection(oldContent, newSection)"), "## Work Activation\n> Dashboard");
  context.oldContent = "b## Work Activation\n> Old dashboard\n\n## Work Activation Tasks\n* Keep native task #assistant/work ^w12345";
  assert.equal(run("replaceAssistantSection(oldContent, newSection)"), "## Work Activation\n> Dashboard\n\n## Work Activation Tasks\n* Keep native task #assistant/work ^w12345");
});

test("scheduled pilot tasks activate while waiting tasks stay grouped", () => {
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
  assert.equal(due.today.length, 1);
  assert.equal(due.waiting.length, 1);
});

test("dashboard block edits update the same native NotePlan task", () => {
  const environment = pluginContext();
  const note = addDailyNote(environment, "2026-08-10");
  environment.context.task = { id: "invoice", title: "Finish invoice", project: "Sparky's", status: "scheduled" };
  environment.run('upsertNativeTask(task, "2026-08-10", 600, 660)');
  environment.run('updateNativeTaskBlock("invoice", "2026-08-10", 630, 720)');
  assert.match(note.content, /10:30 AM - 12:00 PM Finish invoice/);
  assert.equal((note.content.match(/#assistant\/work/g) || []).length, 1);
  assert.equal(environment.json.has("dashboard-focus-blocks.json"), false);
});

test("a native timeline block is not duplicated in active or scheduled lists", async () => {
  const task = { id: "placed-task", title: "Placed once", project: "Client", status: "scheduled", scheduledFor: "2026-08-10" };
  const environment = pluginContext({
    fetch: async (url) => {
      if (url.includes("/api/generate")) return JSON.stringify({ date: "2026-08-10", sources: [], warnings: [], startHere: task, review: [], today: [task], waiting: [], scheduled: [task], other: [], projects: [], emailCoverage: { complete: true, scannedThreads: 1, lastScanAt: null } });
      if (url.endsWith("/api/projects")) return JSON.stringify({ projects: [] });
      return JSON.stringify({ ok: true });
    },
  });
  environment.context.DataStore.settings = { serviceUrl: "https://service.example.com", apiToken: "private-token" };
  addDailyNote(environment, "2026-08-10");
  environment.context.placedTask = task;
  environment.run('upsertNativeTask(placedTask, "2026-08-10", 600, 660)');
  const plan = await environment.run('currentPlan("2026-08-10")');
  assert.equal(plan.focusBlocks.length, 1);
  assert.equal(plan.today.length, 0);
  assert.equal(plan.scheduled.length, 0);
});

test("unfinished native tasks move once to the next workday without a time", async () => {
  const environment = pluginContext();
  const today = environment.run("localDate()");
  const prior = environment.run(`moveWorkday("${today}", -1)`);
  const oldNote = addDailyNote(environment, prior);
  const todayNote = addDailyNote(environment, today);
  environment.context.task = { id: "carry-task", title: "Finish prior work", project: "Client", status: "today" };
  environment.run(`upsertNativeTask(task, "${prior}", 960, 1020)`);
  environment.context.plan = { today: [environment.context.task], scheduled: [] };
  const result = await environment.run(`carryForwardNativeTasks(plan, "${today}")`);
  assert.equal(result.moved, 1);
  assert.doesNotMatch(oldNote.content, /Finish prior work/);
  assert.match(todayNote.content, /^\* Finish prior work/m);
  assert.doesNotMatch(todayNote.content, /\d{1,2}:\d{2} [AP]M/);
  assert.equal((todayNote.content.match(/#assistant\/work/g) || []).length, 1);
});

test("legacy dated dashboard buttons now open the actual current day", async () => {
  const shown = [];
  const calls = [];
  const { run, context } = pluginContext({
    fetch: async (url) => {
      calls.push(url);
      if (url.includes("/api/today")) return JSON.stringify({ date: new URL(url).searchParams.get("date"), sources: [], warnings: [], startHere: null, review: [], today: [], waiting: [], scheduled: [], other: [], projects: [], emailCoverage: { complete: true, scannedThreads: 1, lastScanAt: null } });
      if (url.includes("/api/projects")) return JSON.stringify({ projects: [] });
      return JSON.stringify({ imported: 0 });
    },
    DataStore: { settings: { serviceUrl: "https://service.example.com", apiToken: "private-token" }, calendarNotes: [], projectNotes: [], loadJSON: () => null, saveJSON: () => {} },
    HTMLView: { showWindow: (html) => shown.push(html) },
  });
  context.actualToday = run("localDate()");
  await run('assistantDashboardToday("2026-08-07")');
  assert.equal(shown.length, 1);
  assert.ok(calls.some((url) => url.includes(`/api/today?date=${context.actualToday}`)));
  assert.equal(calls.some((url) => url.includes("/api/generate")), false);
  assert.equal(calls.some((url) => url.includes("/api/noteplan/sync")), false);
});

test("dashboard refreshes reuse one stable NotePlan window", async () => {
  const windows = [];
  const environment = pluginContext({
    fetch: async (url) => {
      if (url.includes("/api/today")) return JSON.stringify({ date: "2026-08-10", sources: [], warnings: [], startHere: null, review: [], today: [], waiting: [], scheduled: [], other: [], projects: [], emailCoverage: { complete: true, scannedThreads: 1, lastScanAt: null } });
      if (url.includes("/api/projects")) return JSON.stringify({ projects: [] });
      return JSON.stringify({ ok: true });
    },
    DataStore: { settings: { serviceUrl: "https://service.example.com", apiToken: "private-token" }, calendarNotes: [], projectNotes: [], loadJSON: () => null, saveJSON: () => {} },
    HTMLView: { showWindowWithOptions: (html, title, options) => windows.push({ html, title, options }) },
  });
  await environment.run('assistantDashboard("2026-08-10")');
  await environment.run('assistantDashboard("2026-08-10")');
  assert.equal(windows.length, 2);
  assert.equal(windows[0].options.id, "work-activation-dashboard");
  assert.equal(windows[1].options.id, windows[0].options.id);
  assert.equal(windows[1].options.windowId, windows[0].options.windowId);
});

test("completed email review uses the completed decision", async () => {
  const calls = [];
  const { run, context } = pluginContext({ fetch: async (url, options) => { calls.push({ url, options }); return JSON.stringify({ ok: true }); } });
  context.DataStore.settings = { serviceUrl: "https://service.example.com", apiToken: "private-token" };
  context.reviewCompletion = { id: "email-task", decision: "complete" };
  await run("onMessageFromHTMLView('reviewTask', reviewCompletion)");
  assert.match(calls[0].url, /\/api\/reviews\/email-task$/);
  assert.equal(JSON.parse(calls[0].options.body).decision, "complete");
});

test("dashboard collisions use visible calendar times and reject overlapping moves", () => {
  const { run, context } = pluginContext();
  context.plan = { date: "2026-08-10", calendarEvents: [{ start: "2026-08-10T10:00:00-07:00", end: "2026-08-10T11:00:00-07:00", allDay: false }] };
  const script = run("dashboardInteractionScript(plan)");
  assert.match(script, /\[{"start":600,"end":660}\]/);
  assert.match(script, /Not enough room to move that block there/);
  assert.doesNotMatch(script, /secondBlock|swap/);
  assert.doesNotMatch(script, /"start":590/);
});

test("generated dashboard interaction JavaScript parses successfully", () => {
  const { run, context } = pluginContext();
  context.plan = { date: "2026-08-10", calendarEvents: [] };
  const script = run("dashboardInteractionScript(plan)");
  const javascript = script.slice(script.indexOf("<script>") + 8, script.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(javascript));
});

test("review cards are never removed before persistence confirmation", () => {
  const { run, context } = pluginContext();
  context.plan = { date: "2026-08-10", planningStartMinute: 540, calendarEvents: [] };
  const script = run("dashboardInteractionScript(plan)");
  assert.doesNotMatch(script, /reviewCard\.remove|scheduledCard\.remove|removeSchedulingSource/);
  assert.match(script, /let actionInFlight = false/);
  assert.match(script, /Please wait for the current save/);
  assert.doesNotMatch(script, /onHandle|onWorkActivationResult|Saved · refreshing/);
  assert.doesNotMatch(script, /send\('refreshDashboard'/);
});

test("registered review command persists direct ignore and complete without the HTML bridge", async () => {
  for (const decision of ["ignore", "complete"]) {
    const calls = [];
    const environment = pluginContext({
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith("/api/projects")) return JSON.stringify({ projects: [] });
        if (url.includes("/api/generate")) return JSON.stringify({ date: "2026-08-10", sources: [], warnings: [], startHere: null, review: [], today: [], waiting: [], scheduled: [], other: [], ideas: [], emailCoverage: { complete: true, scannedThreads: 1, lastScanAt: null } });
        return JSON.stringify({});
      },
      DataStore: { settings: { serviceUrl: "https://service.example.com", apiToken: "private-token" }, calendarNotes: [], projectNotes: [], loadJSON: () => null, saveJSON: () => {} },
      HTMLView: { showWindowWithOptions: () => {} },
    });
    await environment.run(`assistantReview("review-one", "${decision}", "2026-08-10")`);
    const reviewCall = calls.find((call) => call.url.endsWith("/api/reviews/review-one"));
    assert.ok(reviewCall);
    assert.equal(JSON.parse(reviewCall.options.body).decision, decision);
  }
});

test("drag scheduling snaps tasks into the nearest conflict-free timeline slot", () => {
  const { run, context } = pluginContext();
  context.plan = { date: "2026-08-10", planningStartMinute: 540, calendarEvents: [{ start: "2026-08-10T10:00:00-07:00", end: "2026-08-10T11:00:00-07:00", allDay: false }] };
  const script = run("dashboardInteractionScript(plan)");
  assert.match(script, /addEventListener\('dragstart'/);
  assert.match(script, /addEventListener\('drop'/);
  assert.match(script, /nearestAvailableStart/);
  assert.match(script, /No open slot fits this task/);
  assert.match(script, /scheduleTaskAt/);
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

test("pilot tasks are not re-injected into NotePlan collection on every sync", () => {
  const { run, context, json } = pluginContext();
  context.DataStore.settings = { serviceUrl: "https://service.example.com", apiToken: "private-token" };
  json.set("pilot-review.json", {
    version: 1,
    gmailCheckedAt: "2026-08-07T16:00:00Z",
    tasks: [{ id: "gmail-friday-invoice", actionKey: "invoice", title: "Finish Friday invoice", sourceId: "thread-invoice", sourceUrl: "https://mail.google.com/thread-invoice", project: "Client", confidence: 1 }],
    decisions: { "gmail-friday-invoice": "addToday" },
    feedback: {},
  });
  const tasks = run("collectOpenTasks()");
  assert.equal(tasks.length, 0);
});

test("connected dashboard sends the saved pilot decisions to migration API", async () => {
  const calls = [];
  const { run, context, json } = pluginContext({ fetch: async (url, options) => { calls.push({ url, options }); return JSON.stringify({ imported: 3 }); } });
  context.DataStore.settings = { serviceUrl: "https://service.example.com", apiToken: "private-token" };
  json.set("pilot-review.json", { version: 1, tasks: [{ id: "one", title: "Friday work" }], decisions: { one: "addToday" }, feedback: {} });
  const imported = await run("migratePilotReview()");
  assert.equal(imported, 3);
  assert.match(calls[0].url, /\/api\/pilot\/migrate$/);
  assert.equal(JSON.parse(calls[0].options.body).decisions.one, "addToday");
  assert.equal(await run("migratePilotReview()"), 0);
  assert.equal(calls.filter((call) => /\/api\/pilot\/migrate$/.test(call.url)).length, 1);
});

test("dashboard completion updates the service and native NotePlan task", async () => {
  const calls = [];
  const environment = pluginContext({ fetch: async (url, options) => { calls.push({ url, options }); return JSON.stringify(url.includes("/api/generate") ? { date: "2026-08-10", sources: [], warnings: [], startHere: null, review: [], today: [], waiting: [], scheduled: [], other: [], emailCoverage: { complete: true, scannedThreads: 1, lastScanAt: null } } : url.endsWith("/api/projects") ? { projects: [] } : { id: "task-one", status: "done" }); } });
  environment.context.DataStore.settings = { serviceUrl: "https://service.example.com", apiToken: "private-token" };
  const note = addDailyNote(environment, "2026-08-10");
  environment.context.task = { id: "task-one", title: "Task", status: "today" };
  environment.run('upsertNativeTask(task, "2026-08-10", 600, 660)');
  environment.context.completion = { id: "task-one", date: "2026-08-10" };
  await environment.run("onMessageFromHTMLView('completeTask', completion)");
  assert.ok(calls.some((call) => /\/api\/tasks\/task-one$/.test(call.url)));
  assert.match(note.content, /^\* \[x\] 10:00 AM - 11:00 AM Task/m);
  assert.equal(environment.run('nativeBlocksForDate("2026-08-10").length'), 0);
});

test("completed Active Task stays absent when the cloud plan cache is stale", async () => {
  const calls = [];
  const environment = pluginContext({ fetch: async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/api/projects")) return JSON.stringify({ projects: [] });
    if (url.includes("/api/today")) return JSON.stringify({ date: "2026-08-14", generatedAt: "2026-08-13T15:00:00Z", sources: [], warnings: [], startHere: null, review: [], today: [{ id: "active-complete", title: "Complete me", status: "today" }], waiting: [], scheduled: [], other: [], projects: [], calendar: [], emailCoverage: { complete: true, scannedThreads: 1, lastScanAt: null } });
    if (url.includes("/api/tasks/active-complete")) return JSON.stringify({ id: "active-complete", status: "done" });
    if (url.includes("/api/noteplan/sync")) return JSON.stringify({ ok: true });
    throw new Error(`Unexpected request: ${url}`);
  } });
  environment.context.DataStore.settings = { serviceUrl: "https://service.example.com", apiToken: "private-token" };
  const note = addDailyNote(environment, "2026-08-14");
  environment.context.task = { id: "active-complete", title: "Complete me", status: "today" };
  environment.run('upsertNativeTask(task, "2026-08-14", 600, 660)');
  environment.context.refreshedPlan = null;
  await environment.run("assistantDashboard = async (date) => { refreshedPlan = await currentPlan(date); }");
  await environment.run('assistantCompleteTask("active-complete", "2026-08-14")');
  assert.match(note.content, /^\* \[x\] 10:00 AM - 11:00 AM Complete me/m);
  assert.equal(environment.context.refreshedPlan.today.some((task) => task.id === "active-complete"), false);
  assert.ok(calls.some((call) => call.url.includes("/api/tasks/active-complete")));
});

test("completed Active Task without a native block still stays absent", async () => {
  const environment = pluginContext({ fetch: async (url) => {
    if (url.endsWith("/api/projects")) return JSON.stringify({ projects: [] });
    if (url.includes("/api/today")) return JSON.stringify({ date: "2026-08-14", generatedAt: "2026-08-13T15:00:00Z", sources: [], warnings: [], startHere: null, review: [], today: [{ id: "active-without-block", title: "Complete without block", status: "today" }], waiting: [], scheduled: [], other: [], projects: [], calendar: [], emailCoverage: { complete: true, scannedThreads: 1, lastScanAt: null } });
    if (url.includes("/api/tasks/active-without-block")) return JSON.stringify({ id: "active-without-block", status: "done" });
    throw new Error(`Unexpected request: ${url}`);
  } });
  environment.context.DataStore.settings = { serviceUrl: "https://service.example.com", apiToken: "private-token" };
  environment.context.refreshedPlan = null;
  await environment.run("assistantDashboard = async (date) => { refreshedPlan = await currentPlan(date); }");
  await environment.run('assistantCompleteTask("active-without-block", "2026-08-14")');
  assert.equal(environment.context.refreshedPlan.today.some((task) => task.id === "active-without-block"), false);
  assert.equal(environment.json.get("native-task-index.json").tasks["active-without-block"].done, true);
});

test("scheduled dashboard items open date and time controls", () => {
  const { run, context } = pluginContext();
  context.items = [{ id: "task-one", title: "Prepare invoice", project: "Client", scheduledFor: null }];
  const section = run("scheduledDashboardSection(items)");
  assert.match(section, /data-scheduled-card/);
  assert.match(section, /class="schedule-drag" draggable="true"/);
  assert.match(section, /Choose a date and time/);
  context.plan = { date: "2026-08-10", planningStartMinute: 540, calendarEvents: [] };
  const script = run("dashboardInteractionScript(plan)");
  assert.match(script, /schedule-date/);
  assert.match(script, /schedule-time/);
  assert.match(script, /scheduleTask/);
});

test("scheduling creates one native NotePlan block and no private JSON block", async () => {
  const environment = pluginContext();
  const note = addDailyNote(environment, "2026-08-10");
  environment.json.set("pilot-review.json", { version: 1, tasks: [{ id: "task-one", title: "Prepare invoice" }], decisions: {}, feedback: {} });
  environment.context.scheduleData = { date: "2026-08-10", task: { id: "task-one", title: "Prepare invoice", project: "Client" }, start: 600, end: 660 };
  await environment.run("onMessageFromHTMLView('scheduleTask', scheduleData)");
  assert.equal(environment.json.get("pilot-review.json").feedback.schedules["task-one"], "2026-08-10");
  assert.match(note.content, /^\* 10:00 AM - 11:00 AM Prepare invoice/m);
  assert.equal(environment.json.has("dashboard-focus-blocks.json"), false);
});

test("encoded dashboard scheduling runs in plugin context", async () => {
  const environment = pluginContext();
  const note = addDailyNote(environment, "2026-08-10");
  environment.json.set("pilot-review.json", { version: 1, tasks: [{ id: "safe-drag", title: "Safely schedule task" }], decisions: {}, feedback: {} });
  environment.context.payload = JSON.stringify({ type: "scheduleTask", data: { date: "2026-08-10", task: { id: "safe-drag", title: "Safely schedule task", project: "Client" }, start: 600, end: 660 } });
  await environment.run("assistantApplyDashboardAction(payload)");
  assert.match(note.content, /^\* 10:00 AM - 11:00 AM Safely schedule task/m);
  assert.equal(environment.json.get("pilot-review.json").feedback.schedules["safe-drag"], "2026-08-10");
});

test("scheduling another date returns to the dashboard that launched the picker", async () => {
  const environment = pluginContext();
  addDailyNote(environment, "2026-08-10");
  const target = addDailyNote(environment, "2026-08-14");
  environment.json.set("pilot-review.json", { version: 1, tasks: [{ id: "future-task", title: "Schedule in the future" }], decisions: {}, feedback: {} });
  environment.context.dashboardDates = [];
  await environment.run("assistantDashboard = async (date) => dashboardDates.push(date)");
  environment.context.payload = JSON.stringify({ type: "scheduleTask", data: { date: "2026-08-14", dashboardDate: "2026-08-10", task: { id: "future-task", title: "Schedule in the future" }, start: 600, end: 660 } });
  await environment.run("assistantApplyDashboardAction(payload)");
  assert.match(target.content, /^\* 10:00 AM - 11:00 AM Schedule in the future/m);
  assert.deepEqual(environment.context.dashboardDates, ["2026-08-10"]);
});

test("an older open dashboard without a return date safely returns to today", async () => {
  const environment = pluginContext();
  addDailyNote(environment, "2026-08-14");
  environment.json.set("pilot-review.json", { version: 1, tasks: [{ id: "legacy-future-task", title: "Legacy future schedule" }], decisions: {}, feedback: {} });
  environment.context.dashboardDates = [];
  environment.context.expectedToday = environment.run("localDate()");
  await environment.run("assistantDashboard = async (date) => dashboardDates.push(date)");
  environment.context.payload = JSON.stringify({ type: "scheduleTask", data: { date: "2026-08-14", task: { id: "legacy-future-task", title: "Legacy future schedule" }, start: 600, end: 660 } });
  await environment.run("assistantApplyDashboardAction(payload)");
  assert.deepEqual(environment.context.dashboardDates, [environment.context.expectedToday]);
});

test("full review schedule drag and complete workflow stays single-source", async () => {
  const tasks = new Map([
    ["email-ignore", { id: "email-ignore", title: "Ignore this email", project: "Client", status: "review", sourceUrl: "https://mail.google.com/ignore" }],
    ["email-schedule", { id: "email-schedule", title: "Schedule this email", project: "Client", status: "review", sourceUrl: "https://mail.google.com/schedule" }],
  ]);
  const calls = [];
  const environment = pluginContext({
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes("/api/reviews/") && options.method === "POST") {
        const id = decodeURIComponent(url.split("/api/reviews/")[1]);
        const body = JSON.parse(options.body);
        const task = tasks.get(id);
        task.status = body.decision === "ignore" ? "ignored" : body.decision === "schedule" ? "scheduled" : "today";
        task.scheduledFor = body.scheduledFor || null;
        return JSON.stringify(task);
      }
      if (url.includes("/api/tasks/") && options.method === "POST") {
        const id = decodeURIComponent(url.split("/api/tasks/")[1]);
        const body = JSON.parse(options.body);
        const task = tasks.get(id);
        if (body.completed) task.status = "done";
        return JSON.stringify(task);
      }
      if (url.includes("/api/today")) {
        const review = [...tasks.values()].filter((task) => task.status === "review");
        const scheduled = [...tasks.values()].filter((task) => task.status === "scheduled");
        return JSON.stringify({ date: "2026-08-10", sources: [], warnings: [], startHere: null, review, today: [], waiting: [], scheduled, other: [], projects: [], emailCoverage: { complete: true, scannedThreads: 2, lastScanAt: null } });
      }
      if (url.endsWith("/api/projects")) return JSON.stringify({ projects: [] });
      return JSON.stringify({ ok: true });
    },
  });
  environment.context.DataStore.settings = { serviceUrl: "https://service.example.com", apiToken: "private-token" };
  const note = addDailyNote(environment, "2026-08-10");

  environment.context.ignoreData = { id: "email-ignore", decision: "ignore", date: "2026-08-10" };
  await environment.run("onMessageFromHTMLView('reviewTask', ignoreData)");
  const afterIgnore = await environment.run('currentPlan("2026-08-10")');
  assert.equal(afterIgnore.review.some((task) => task.id === "email-ignore"), false);

  environment.context.scheduleData = { date: "2026-08-10", task: tasks.get("email-schedule"), start: 600, end: 660 };
  await environment.run("onMessageFromHTMLView('scheduleTask', scheduleData)");
  assert.equal((note.content.match(/#assistant\/work/g) || []).length, 1);
  assert.equal(environment.run('nativeBlocksForDate("2026-08-10").length'), 1);

  environment.context.firstMove = { date: "2026-08-10", taskId: "email-schedule", start: 630, end: 690 };
  environment.context.secondMove = { date: "2026-08-10", taskId: "email-schedule", start: 660, end: 750 };
  await environment.run("onMessageFromHTMLView('saveFocusBlock', firstMove)");
  await environment.run("onMessageFromHTMLView('saveFocusBlock', secondMove)");
  assert.equal((note.content.match(/#assistant\/work/g) || []).length, 1);
  assert.match(note.content, /11:00 AM - 12:30 PM Schedule this email/);
  assert.equal(environment.run('nativeBlocksForDate("2026-08-10").length'), 1);
  assert.equal(environment.json.has("dashboard-focus-blocks.json"), false);

  environment.context.completeData = { id: "email-schedule", date: "2026-08-10" };
  await environment.run("onMessageFromHTMLView('completeTask', completeData)");
  assert.equal(environment.run('nativeBlocksForDate("2026-08-10").length'), 0);
  assert.equal(tasks.get("email-ignore").status, "ignored");
  assert.equal(tasks.get("email-schedule").status, "done");
  assert.equal(calls.filter((call) => call.url.includes("/api/reviews/email-ignore")).length, 1);
});

test("failed review activation rolls back the native task and keeps the decision retryable", async () => {
  const prompts = [];
  const environment = pluginContext({
    fetch: async () => { throw new Error("Network unavailable"); },
    CommandBar: { prompt: async (title, message) => { prompts.push({ title, message }); return "OK"; }, showInput: async () => null },
  });
  environment.context.DataStore.settings = { serviceUrl: "https://service.example.com", apiToken: "private-token" };
  const note = addDailyNote(environment, "2026-08-10");
  environment.context.review = { id: "email-one", decision: "addToday", date: "2026-08-10", task: { id: "email-one", title: "Reply to client", project: "Client", sourceUrl: "https://mail.google.com/thread", status: "today" } };
  await environment.run("onMessageFromHTMLView('reviewTask', review)");
  assert.doesNotMatch(note.content, /Reply to client/);
  assert.equal(environment.run('Boolean(loadNativeTaskIndex().tasks["email-one"])'), false);
  assert.match(prompts[0].message, /Network unavailable/);
});

test("native edits and completion reconcile to backend metadata", async () => {
  const calls = [];
  const environment = pluginContext({ fetch: async (url, options) => { calls.push({ url, options }); return JSON.stringify({ id: "task-one" }); } });
  environment.context.DataStore.settings = { serviceUrl: "https://service.example.com", apiToken: "private-token" };
  const note = addDailyNote(environment, "2026-08-10");
  environment.context.task = { id: "task-one", title: "Original wording", status: "today" };
  environment.run('upsertNativeTask(task, "2026-08-10", 600, 660)');
  note.content = note.content.replace("Original wording", "Edited natively").replace(/^\* /m, "* [x] ");
  const result = await environment.run("reconcileNativeTasks()");
  const update = calls.find((call) => /\/api\/tasks\/task-one$/.test(call.url));
  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(update.options.body), { title: "Edited natively", completed: true });
});

test("legacy block migration keeps only the latest placement per task", () => {
  const environment = pluginContext();
  const first = addDailyNote(environment, "2026-08-07");
  const latest = addDailyNote(environment, "2026-08-10");
  environment.json.set("dashboard-focus-blocks.json", { version: 1, dates: {
    "2026-08-07": [{ taskId: "same", title: "Old placement", start: 600, end: 660 }],
    "2026-08-10": [{ taskId: "same", title: "Latest placement", start: 630, end: 690 }],
  } });
  environment.context.plan = { today: [{ id: "same", title: "Task", status: "today" }], scheduled: [], waiting: [] };
  const result = environment.run("migrateLegacyDashboardBlocks(plan)");
  assert.equal(result.migrated, 1);
  assert.doesNotMatch(first.content, /#assistant\/work/);
  assert.match(latest.content, /Latest placement/);
});

test("legacy oversized block IDs migrate to hidden six-character NotePlan markers", () => {
  const environment = pluginContext();
  const note = addDailyNote(environment, "2026-08-10", "## Work Activation Tasks\n* Reply to client #assistant/work ^wa1234567");
  environment.json.set("native-task-index.json", { version: 1, legacyMigrated: true, tasks: {
    "task-one": { blockId: "wa1234567", date: "2026-08-10", title: "Reply to client", status: "today", done: false },
  } });
  assert.equal(environment.run("migrateNativeBlockIds()"), 1);
  const blockId = environment.json.get("native-task-index.json").tasks["task-one"].blockId;
  assert.match(blockId, /^[a-z0-9]{6}$/i);
  assert.match(note.content, new RegExp(`\\^${blockId}$`));
  assert.doesNotMatch(note.content, /wa1234567/);
});

test("group scheduling creates one native block through the service", async () => {
  const calls = [];
  const grouped = { id: "group-123", title: "Client email follow-ups (2)", project: "Client", status: "scheduled", scheduledFor: "2026-08-11" };
  const environment = pluginContext({ fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.includes("/api/reviews/group")) return JSON.stringify(grouped);
    if (url.endsWith("/api/projects")) return JSON.stringify({ projects: [] });
    return JSON.stringify({ date: "2026-08-11", sources: [], warnings: [], startHere: null, review: [], today: [], waiting: [], scheduled: [], other: [], emailCoverage: { complete: true, scannedThreads: 1, lastScanAt: null } });
  } });
  environment.context.DataStore.settings = { serviceUrl: "https://service.example.com", apiToken: "private-token" };
  const note = addDailyNote(environment, "2026-08-11");
  environment.context.groupData = { ids: ["email-one", "email-two"], task: { id: grouped.id, title: grouped.title, project: grouped.project }, date: "2026-08-11", start: 600, end: 660 };
  await environment.run("onMessageFromHTMLView('groupSchedule', groupData)");
  const groupCall = calls.find((call) => /\/api\/reviews\/group$/.test(call.url));
  assert.deepEqual(JSON.parse(groupCall.options.body).ids, ["email-one", "email-two"]);
  assert.match(note.content, /Client email follow-ups \(2\)/);
  assert.equal((note.content.match(/#assistant\/work/g) || []).length, 1);
});

test("dashboard feedback is retained locally and in pilot history", async () => {
  const { run, context, json } = pluginContext();
  json.set("pilot-review.json", { version: 1, tasks: [], decisions: {}, feedback: {} });
  context.feedback = { type: "correction", text: "The Automattic meeting is already arranged.", date: "2026-08-10" };
  await run("onMessageFromHTMLView('saveDashboardFeedback', feedback)");
  assert.equal(json.get("dashboard-feedback.json").entries[0].type, "correction");
  assert.equal(json.get("pilot-review.json").feedback.events[0].answer, "The Automattic meeting is already arranged.");
});

test("ideas render one answerable follow-up question in the dashboard", () => {
  const { run, context } = pluginContext();
  context.ideas = [{ id: "idea-one", text: "Apply for Smart Dolphins", answers: [], nextQuestion: "What is still unfinished?" }];
  const html = run("ideasDashboardSection(ideas)");
  assert.match(html, /What is still unfinished/);
  assert.match(html, /id="idea-answer"/);
  assert.match(html, /data-idea-id="idea-one"/);
});

test("manual dashboard tasks are written as native NotePlan tasks", async () => {
  const calls = [];
  const manual = { id: "manual-one", title: "Prepare project outline", status: "today", scheduledFor: "2026-08-10", sourceUrl: null };
  const environment = pluginContext({ fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/tasks/manual")) return JSON.stringify(manual);
    if (url.endsWith("/api/projects")) return JSON.stringify({ projects: [] });
    return JSON.stringify({ date: "2026-08-10", sources: [], warnings: [], startHere: manual, review: [], today: [manual], waiting: [], scheduled: [], other: [], ideas: [], emailCoverage: { complete: true, scannedThreads: 1, lastScanAt: null } });
  } });
  environment.context.DataStore.settings = { serviceUrl: "https://service.example.com", apiToken: "private-token" };
  const note = addDailyNote(environment, "2026-08-10");
  environment.context.feedback = { type: "task", text: "Prepare project outline", date: "2026-08-10" };
  await environment.run("onMessageFromHTMLView('saveDashboardFeedback', feedback)");
  assert.ok(calls.some((call) => call.url.endsWith("/api/tasks/manual")));
  assert.match(note.content, /Prepare project outline #assistant\/work/);
});

test("refresh command refuses to imply a Gmail check without a connection", async () => {
  const prompts = [];
  const { run } = pluginContext({ CommandBar: { prompt: async (title, message) => { prompts.push({ title, message }); return "Cancel"; }, showInput: async () => null } });
  await run("assistantRefreshDashboard('2026-08-10')");
  assert.match(prompts[0].message, /cannot be connected or refreshed/i);
});

test("system check reports loaded version, connection, review IDs, and native blocks", async () => {
  const prompts = [];
  const environment = pluginContext({
    fetch: async (url) => {
      if (url.endsWith("/api/status")) return JSON.stringify({ connected: true });
      if (url.includes("/api/today")) return JSON.stringify({ review: [{ id: "one" }, { id: "two" }] });
      return JSON.stringify({});
    },
    CommandBar: { prompt: async (title, message) => { prompts.push({ title, message }); return "OK"; }, showInput: async () => null },
  });
  environment.context.DataStore.settings = { serviceUrl: "https://service.example.com", apiToken: "private-token" };
  await environment.run("assistantSystemCheck()");
  assert.match(prompts[0].message, /Plugin 0\.20\.0 is loaded/);
  assert.match(prompts[0].message, /Gmail and Calendar connection is available/);
  assert.match(prompts[0].message, /2 review items have unique IDs/);
  assert.match(prompts[0].message, /native tasks have unique blocks/);
});

test("date input validation rejects impossible dates", () => {
  const { run } = pluginContext();
  assert.equal(run('validDateString("2026-08-10")'), true);
  assert.equal(run('validDateString("2026-02-30")'), false);
  assert.equal(run('validDateString("next Monday")'), false);
});
