import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const taskId = process.argv[2];
if (!taskId) throw new Error("Usage: npm run test:live-ignore -- <existing-review-task-id>");

const settingsPath = `${homedir()}/Library/Containers/co.noteplan.NotePlan3/Data/Library/Application Support/co.noteplan.NotePlan3/Plugins/data/leslee.WorkActivationAssistant/settings.json`;
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const source = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

async function api(path, options = {}) {
  const response = await fetch(`${settings.serviceUrl}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${settings.apiToken}`, "content-type": "application/json", ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

const before = await api(`/api/today?date=${today}`);
assert.ok(before.review.some((task) => task.id === taskId), `${taskId} is not currently in Email Task Review`);

const context = vm.createContext({
  console,
  DataStore: { settings, calendarNotes: [], projectNotes: [], calendarNoteByDateString: () => null, loadJSON: () => null, saveJSON: () => {} },
  CommandBar: { prompt: async () => null, showInput: async () => null },
  NotePlan: { openURL: async () => {} },
  HTMLView: { showWindow: () => {}, showWindowWithOptions: () => {} },
  Calendar: { eventsToday: async () => [], eventsBetween: async () => [] },
});
vm.runInContext(source, context);
context.livePlan = before;
const html = vm.runInContext("dashboardHtml(livePlan)", context);
const requests = [];
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: "https://noteplan.local/dashboard",
  beforeParse(window) {
    window.fetch = async (...args) => { requests.push(args); return fetch(...args); };
    window.webkit = { messageHandlers: { jsBridge: { postMessage: () => {} } } };
    window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
    window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
  },
});

const card = dom.window.document.querySelector(`[data-review-card="${taskId}"]`);
assert.ok(card, "The live review card was not rendered");
const ignore = [...card.querySelectorAll("button")].find((button) => button.textContent === "Ignore");
assert.ok(ignore, "The live review card has no Ignore button");
ignore.click();

for (let attempt = 0; attempt < 40 && dom.window.document.querySelector(`[data-review-card="${taskId}"]`); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(requests.length, 1, "Ignore should send exactly one front-end request");
assert.equal(dom.window.document.querySelector(`[data-review-card="${taskId}"]`), null, "The card did not disappear after persistence succeeded");

const saved = await api(`/api/today?date=${today}`);
assert.equal(saved.review.some((task) => task.id === taskId), false, "The ignored item remained in the live review list");
await api(`/api/generate?date=${today}`, { method: "POST" });
const refreshed = await api(`/api/today?date=${today}`);
assert.equal(refreshed.review.some((task) => task.id === taskId), false, "The ignored item returned after Gmail refresh");

console.log(`PASS: ${taskId} was ignored through the dashboard front end and stayed absent after refresh.`);
dom.window.close();
