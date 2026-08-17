import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const source = readFileSync(new URL("./script.js", import.meta.url), "utf8");

function pluginContext() {
  const context = vm.createContext({
    console,
    DataStore: {
      settings: { serviceUrl: "https://service.example.com", apiToken: "test-token" },
      calendarNotes: [],
      projectNotes: [],
      calendarNoteByDateString: () => null,
      loadJSON: () => null,
      saveJSON: () => {},
    },
    CommandBar: { prompt: async () => null, showInput: async () => null },
    NotePlan: { openURL: async () => {} },
    HTMLView: { showWindow: () => {}, showWindowWithOptions: () => {} },
    Calendar: { eventsToday: async () => [], eventsBetween: async () => [] },
  });
  vm.runInContext(source, context);
  return context;
}

function task(id, title = `Task ${id}`) {
  return {
    id,
    title,
    project: "Client",
    status: "review",
    sourceUrl: `https://mail.google.com/${id}`,
    emailReceivedAt: "2026-08-10T17:00:00Z",
    emailLastActivityAt: "2026-08-10T17:00:00Z",
    scheduledFor: null,
  };
}

function plan(overrides = {}) {
  return {
    date: "2026-08-10",
    generatedAt: "2026-08-10T18:00:00Z",
    sources: [],
    warnings: [],
    startHere: null,
    review: [],
    today: [],
    waiting: [],
    scheduled: [],
    other: [],
    ideas: [],
    projects: [],
    emailCoverage: { complete: true, scannedThreads: 1, lastScanAt: null },
    availableMinutes: 480,
    focusBlocks: [],
    calendarEvents: [],
    planningStartMinute: 540,
    nextInstruction: "Review work.",
    ...overrides,
  };
}

function renderDashboard(planValue, options = {}) {
  const context = pluginContext();
  context.frontendPlan = planValue;
  const html = vm.runInContext("dashboardHtml(frontendPlan)", context);
  const messages = [];
  const pluginUrls = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://noteplan.local/dashboard",
    beforeParse(window) {
      window.fetch = options.fetch || (async () => ({ ok: true, status: 200 }));
      window.DataStore = options.dataStore || {
        calendarNotes: [],
        calendarNoteByDateString: async () => null,
        calendarNoteByDate: async () => null,
        loadJSON: async () => null,
        saveJSON: async () => {},
      };
      window.webkit = { messageHandlers: { jsBridge: { postMessage: (message) => messages.push(message) } } };
      window.NotePlan = { openURL: async (url) => { pluginUrls.push(url); } };
      window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
      window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
    },
  });
  return { dom, document: dom.window.document, messages, pluginUrls };
}

function pluginAction(pluginUrls, action) {
  assert.equal(pluginUrls.length, 1, `Expected one ${action} plugin command`);
  const url = new URL(pluginUrls[0]);
  assert.equal(url.searchParams.get("command"), "Assistant: Apply Dashboard Action");
  const payload = JSON.parse(url.searchParams.get("arg0"));
  assert.equal(payload.type, action);
  return payload.data;
}

test("Ignore saves directly, removes the card, and remains absent after refresh", async () => {
  const ignored = task("email-ignore", "Ignore this item");
  const calls = [];
  const first = renderDashboard(plan({ review: [ignored] }), { fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200 }; } });
  assert.match(first.document.querySelector(".statuses").textContent, /assistant · v0\.19\.1/);
  assert.ok([...first.document.querySelectorAll("a")].some((link) => link.textContent === "Run System Check"));
  const button = [...first.document.querySelectorAll(".direct-review")].find((item) => item.textContent === "Ignore");
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/reviews\/email-ignore$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { decision: "ignore" });
  assert.equal(first.document.querySelector('[data-review-card="email-ignore"]'), null);
  assert.match(first.document.getElementById("save-state").textContent, /Ignored permanently/);
  assert.equal(first.messages.length, 0);

  const refreshed = renderDashboard(plan({ review: [] }));
  assert.equal(refreshed.document.querySelector('[data-review-card="email-ignore"]'), null);
  assert.match(refreshed.document.querySelector(".review-list").textContent, /Every discovered email action has been reviewed/);
});

test("Today uses NotePlan activation while Completed saves directly", () => {
  const dashboard = renderDashboard(plan({ review: [task("email-decisions")] }));
  const today = [...dashboard.document.querySelectorAll(".direct-review")].find((item) => item.textContent === "Today");
  assert.match(today.href, /arg1=addToday/);
  assert.match(today.href, /Assistant%3A%20Review%20Email%20Tasks/);
  const completed = [...dashboard.document.querySelectorAll(".direct-review")].find((item) => item.textContent === "Completed");
  assert.equal(completed.dataset.directDecision, "complete");
});

test("direct review decisions do not depend on drag-and-timeline initialization", () => {
  const context = pluginContext();
  context.frontendPlan = plan({ review: [task("early-handler")] });
  const html = vm.runInContext("dashboardHtml(frontendPlan)", context);
  assert.match(html, /Assistant%3A%20Review%20Email%20Tasks/);
  assert.match(html, /data-direct-decision="ignore"/);
});

test("Other date hands one plain scheduling payload to the plugin command", async () => {
  const dashboard = renderDashboard(plan({ review: [task("email-schedule", "Schedule me")] }));
  dashboard.document.querySelector('[data-review="schedule"]').click();
  assert.equal(dashboard.document.getElementById("schedule-dialog").open, true);
  dashboard.document.getElementById("schedule-date").value = "2026-08-11";
  dashboard.document.getElementById("schedule-time").value = "10:30";
  dashboard.document.getElementById("schedule-duration").value = "60";
  dashboard.document.getElementById("schedule-save").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const data = pluginAction(dashboard.pluginUrls, "scheduleTask");
  assert.deepEqual({ id: data.task.id, date: data.date, dashboardDate: data.dashboardDate, start: data.start, end: data.end }, { id: "email-schedule", date: "2026-08-11", dashboardDate: "2026-08-10", start: 630, end: 690 });
  assert.equal(dashboard.messages.length, 0);
  assert.equal(dashboard.document.querySelector('[data-review-card="email-schedule"]').style.opacity, "0.55");
});

test("dragging an email task uses no HTML bridge or DataStore writes", async () => {
  let dataStoreWrites = 0;
  const dashboard = renderDashboard(plan({ date: "2026-08-11", review: [task("email-drag", "Drag to tomorrow")] }), { dataStore: { saveJSON: async () => { dataStoreWrites += 1; } } });
  const handle = dashboard.document.querySelector(".schedule-drag");
  const track = dashboard.document.querySelector(".calendar-track");
  track.getBoundingClientRect = () => ({ top: 0, height: 480, left: 0, right: 300, bottom: 480, width: 300, x: 0, y: 0, toJSON() {} });
  const dataTransfer = { effectAllowed: "", setData() {} };
  const dragStart = new dashboard.dom.window.Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
  handle.dispatchEvent(dragStart);
  const dragOver = new dashboard.dom.window.Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperty(dragOver, "clientY", { value: 60 });
  track.dispatchEvent(dragOver);
  track.dispatchEvent(new dashboard.dom.window.Event("drop", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const data = pluginAction(dashboard.pluginUrls, "scheduleTask");
  assert.deepEqual({ id: data.task.id, date: data.date, dashboardDate: data.dashboardDate, start: data.start, end: data.end }, { id: "email-drag", date: "2026-08-11", dashboardDate: "2026-08-11", start: 600, end: 645 });
  assert.equal(dataStoreWrites, 0);
  assert.equal(dashboard.messages.length, 0);
  assert.match(dashboard.document.getElementById("save-state").textContent, /Handing off safely/);
});

test("Waiting requires only dependency details and sends no guessed date", () => {
  const dashboard = renderDashboard(plan({ review: [task("email-waiting", "Wait for client")] }));
  dashboard.document.querySelector('[data-review="waiting"]').click();
  dashboard.document.getElementById("waiting-on").value = "Client response";
  dashboard.document.getElementById("waiting-save").click();
  const data = pluginAction(dashboard.pluginUrls, "waitingTask");
  assert.equal(data.waitingOn, "Client response");
  assert.equal(data.followUpDate, null);
  assert.equal(dashboard.document.getElementById("waiting-date"), null);
});

test("two selected email items become one grouped schedule action", () => {
  const dashboard = renderDashboard(plan({ review: [task("email-one"), task("email-two")] }));
  const checkboxes = [...dashboard.document.querySelectorAll("[data-group-select]")];
  for (const checkbox of checkboxes) {
    checkbox.checked = true;
    checkbox.dispatchEvent(new dashboard.dom.window.Event("change", { bubbles: true }));
  }
  const group = dashboard.document.getElementById("group-schedule");
  assert.equal(group.disabled, false);
  group.click();
  dashboard.document.getElementById("schedule-date").value = "2026-08-11";
  dashboard.document.getElementById("schedule-time").value = "13:00";
  dashboard.document.getElementById("schedule-duration").value = "60";
  dashboard.document.getElementById("schedule-save").click();
  const data = pluginAction(dashboard.pluginUrls, "groupSchedule");
  assert.deepEqual(data.ids, ["email-one", "email-two"]);
  assert.equal(data.dashboardDate, "2026-08-10");
  assert.equal(data.start, 780);
});

test("suggested related-work button selects its group and opens scheduling", () => {
  const first = { ...task("sparky-invoice", "Prepare invoice"), project: "Sparky’s" };
  const second = { ...task("sparky-testing", "Confirm James testing"), project: "Sparky’s" };
  const unrelated = { ...task("studio-booking", "Investigate booking sync"), project: "Studio One" };
  const dashboard = renderDashboard(plan({ review: [first, second, unrelated] }));
  const suggestion = [...dashboard.document.querySelectorAll("[data-suggested-group]")].find((button) => button.textContent.includes("Sparky"));
  assert.ok(suggestion);
  suggestion.click();
  assert.equal(dashboard.document.getElementById("schedule-dialog").open, true);
  const selected = [...dashboard.document.querySelectorAll("[data-group-select]:checked")].map((checkbox) => checkbox.dataset.taskId).sort();
  assert.deepEqual(selected, ["sparky-invoice", "sparky-testing"]);
});

test("timeline completion sends one command for the native task", () => {
  const focusTask = { ...task("native-task", "Finish native task"), status: "scheduled" };
  const dashboard = renderDashboard(plan({ focusBlocks: [{ id: "native-block", taskId: focusTask.id, task: focusTask, start: 600, end: 660 }] }));
  dashboard.document.querySelector(".block-done").click();
  assert.equal(pluginAction(dashboard.pluginUrls, "completeTask").id, "native-task");
});
