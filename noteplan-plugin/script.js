/* global DataStore, CommandBar, NotePlan, HTMLView, Calendar */

const START_MARKER = "%% work-assistant:start %%";
const END_MARKER = "%% work-assistant:end %%";
const LEGACY_START_MARKER = "<!-- work-assistant:start -->";
const LEGACY_END_MARKER = "<!-- work-assistant:end -->";
const BLOCKS_START_MARKER = "%% work-assistant:blocks:start %%";
const BLOCKS_END_MARKER = "%% work-assistant:blocks:end %%";
const PILOT_FILENAME = "pilot-review.json";
const DASHBOARD_BLOCKS_FILENAME = "dashboard-focus-blocks.json";
const DASHBOARD_FEEDBACK_FILENAME = "dashboard-feedback.json";

function settings(required = true) {
  const value = DataStore.settings || {};
  const serviceUrl = String(value.serviceUrl || "").replace(/\/$/, "");
  const apiToken = String(value.apiToken || "");
  if (required && (!serviceUrl || !apiToken)) throw new Error("The cloud service is not connected yet. Import the pilot review or configure the service URL and API token.");
  return { serviceUrl, apiToken };
}

function serviceConfigured() {
  const value = settings(false);
  return Boolean(value.serviceUrl && value.apiToken);
}

function localDate(offsetDays = 0, compact = false) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return compact ? `${year}${month}${day}` : `${year}-${month}-${day}`;
}

function normalizeDate(value = localDate()) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : localDate();
}

function validDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && localDateFor(date) === value;
}

function localDateFor(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateAtNoon(value) {
  return new Date(`${normalizeDate(value)}T12:00:00`);
}

function compactDate(value) {
  return normalizeDate(value).replace(/-/g, "");
}

function moveWorkday(value, direction) {
  const date = dateAtNoon(value);
  do date.setDate(date.getDate() + direction); while (date.getDay() === 0 || date.getDay() === 6);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function selectedDateLabel(value) {
  return new Intl.DateTimeFormat("en-CA", { weekday: "long", month: "long", day: "numeric" }).format(dateAtNoon(value));
}

function loadDashboardBlocks() {
  return DataStore.loadJSON(DASHBOARD_BLOCKS_FILENAME) || { version: 1, dates: {} };
}

function saveDashboardBlocks(value) {
  DataStore.saveJSON(value, DASHBOARD_BLOCKS_FILENAME);
}

function normalizeFocusBlocks(blocks) {
  return blocks.map((block) => ({
    ...block,
    id: block.id || `focus-${block.task.id}`,
    taskId: block.taskId || block.task.id,
  }));
}

function dashboardBlocksForDate(targetDate, suggestedBlocks) {
  const store = loadDashboardBlocks();
  const saved = store.dates?.[normalizeDate(targetDate)];
  if (Array.isArray(saved)) return saved.map((block) => ({ ...block, task: { id: block.taskId, title: block.title, project: block.project || null } }));
  const initial = normalizeFocusBlocks(suggestedBlocks);
  store.dates ??= {};
  store.dates[normalizeDate(targetDate)] = initial.map((block) => ({ id: block.id, taskId: block.taskId, title: block.task.title, project: block.task.project || null, start: block.start, end: block.end }));
  saveDashboardBlocks(store);
  return initial;
}

function saveDashboardBlock(targetDate, changedBlock) {
  const store = loadDashboardBlocks();
  const date = normalizeDate(targetDate);
  const blocks = Array.isArray(store.dates?.[date]) ? store.dates[date] : [];
  const index = blocks.findIndex((block) => block.id === changedBlock.id);
  if (index < 0) throw new Error("The focus block could not be found.");
  blocks[index] = { ...blocks[index], start: changedBlock.start, end: changedBlock.end };
  store.dates[date] = blocks;
  saveDashboardBlocks(store);
  return blocks[index];
}

function createDashboardBlock(targetDate, task, start, end) {
  const store = loadDashboardBlocks();
  const date = normalizeDate(targetDate);
  store.dates ??= {};
  const blocks = Array.isArray(store.dates[date]) ? store.dates[date] : [];
  const id = `focus-${task.id}`;
  const value = { id, taskId: task.id, title: task.title, project: task.project || null, start, end };
  const index = blocks.findIndex((block) => block.id === id);
  if (index >= 0) blocks[index] = value;
  else blocks.push(value);
  store.dates[date] = blocks;
  saveDashboardBlocks(store);
  return value;
}

function removeDashboardTask(taskId) {
  const store = loadDashboardBlocks();
  for (const date of Object.keys(store.dates || {})) store.dates[date] = (store.dates[date] || []).filter((block) => block.taskId !== taskId);
  saveDashboardBlocks(store);
}

function updateDashboardTaskTitle(taskId, title) {
  const store = loadDashboardBlocks();
  for (const date of Object.keys(store.dates || {})) {
    store.dates[date] = (store.dates[date] || []).map((block) => block.taskId === taskId ? { ...block, title } : block);
  }
  saveDashboardBlocks(store);
}

function abbreviatedBlockTitle(value, maximum = 34) {
  const title = String(value || "").replace(/^(reply to|follow up with|send|check whether)\s+/i, "").trim();
  return title.length <= maximum ? title : `${title.slice(0, maximum - 1).trimEnd()}…`;
}

function saveDashboardFeedbackEntry(type, text) {
  const store = DataStore.loadJSON(DASHBOARD_FEEDBACK_FILENAME) || { version: 1, entries: [] };
  const entry = { id: `feedback-${Date.now()}`, type, text: text.trim(), createdAt: new Date().toISOString() };
  store.entries.unshift(entry);
  DataStore.saveJSON(store, DASHBOARD_FEEDBACK_FILENAME);
  return entry;
}

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return (value >>> 0).toString(36);
}

async function request(path, options = {}) {
  const config = settings();
  const response = await fetch(`${config.serviceUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiToken}`, ...(options.headers || {}) },
  });
  let value;
  if (typeof response === "string") value = JSON.parse(response);
  else if (typeof response.json === "function") value = await response.json();
  else if (typeof response.text === "function") value = JSON.parse(await response.text());
  else if (typeof response.body === "string") value = JSON.parse(response.body);
  else value = response;
  if (typeof response !== "string" && response.ok === false) throw new Error(value.error || `Service request failed (${response.status})`);
  return value;
}

function taskUrl(note) {
  return `noteplan://x-callback-url/openNote?noteTitle=${encodeURIComponent(note.title || note.filename || "")}`;
}

function noteDate(note) {
  const compact = String(note.filename || note.title || "").match(/\b(\d{4})(\d{2})(\d{2})\b/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const separated = String(note.filename || note.title || "").match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  return separated ? `${separated[1]}-${separated[2]}-${separated[3]}` : null;
}

function collectOpenTasks() {
  const tasks = [];
  const notes = [...(DataStore.calendarNotes || []), ...(DataStore.projectNotes || [])];
  for (const note of notes) {
    const date = noteDate(note);
    (note.paragraphs || []).forEach((paragraph, index) => {
      const content = paragraph.content.replace(/^[-*]\s*/, "").trim();
      const isPastTimeBlock = date && date < localDate() && /^\d{1,2}:\d{2}\s*(?:AM|PM)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:AM|PM)\b/i.test(content);
      if (!['open', 'task'].includes(paragraph.type) || content.includes("#assistant/") || isPastTimeBlock) return;
      const sourceId = paragraph.id || `${note.filename}:${index}:${hash(paragraph.content)}`;
      const dayDistance = date ? Math.max(0, Math.floor((new Date(`${localDate()}T12:00:00`) - new Date(`${date}T12:00:00`)) / 86400000)) : 0;
      const activeFromDailyNote = Boolean(date && date <= localDate());
      tasks.push({
        id: `noteplan-${hash(sourceId)}`,
        actionKey: "open-task",
        title: content,
        project: note.title || null,
        status: activeFromDailyNote ? "today" : "scheduled",
        dueDate: null,
        sourceType: "noteplan",
        sourceId,
        sourceUrl: taskUrl(note),
        sourceAccount: "NotePlan CloudKit",
        confidence: 1,
        urgencyReason: date === localDate() ? "In today's NotePlan note" : null,
        waitingOn: null,
        verifiedAt: new Date().toISOString(),
        reviewedAt: new Date().toISOString(),
        reviewDecision: "schedule",
        scheduledFor: date && date > localDate() ? date : null,
        previousDay: dayDistance > 0 ? new Intl.DateTimeFormat("en", { weekday: "long" }).format(new Date(`${date}T12:00:00`)) : null,
        carryCount: dayDistance,
      });
    });
  }
  return tasks;
}

function markdownTask(task) {
  const source = task.sourceUrl ? ` [source](${task.sourceUrl})` : "";
  const context = [task.project, task.dueDate ? `due ${task.dueDate}` : null, task.waitingOn ? `waiting: ${task.waitingOn}` : null, task.followUpDate ? `follow up ${task.followUpDate}` : null, task.scheduledFor ? `scheduled ${task.scheduledFor}` : null].filter(Boolean).join(" · ");
  return `* ${task.title}${context ? ` — ${context}` : ""}${source} #assistant/managed`;
}

function planMarkdown(plan) {
  const sourceStatus = plan.sources.map((source) => `${source.source} ${source.status === "connected" || source.status === "pilot imported" ? "✓" : "⚠"}`).join(" · ");
  const dashboardUrl = commandUrl("Assistant: Dashboard", [plan.date]);
  return [
    "## Work Activation",
    `> [🟢 OPEN WORK DASHBOARD](${dashboardUrl})`,
    `_${sourceStatus}_`,
    plan.warnings.length ? `_⚠ ${plan.warnings.join(" ")}_` : "",
  ].filter((line) => line !== "").join("\n");
}

function commandUrl(command, args = []) {
  const encodedArgs = args.map((arg, index) => `&arg${index}=${encodeURIComponent(arg)}`).join("");
  return `noteplan://x-callback-url/runPlugin?pluginID=leslee.WorkActivationAssistant&command=${encodeURIComponent(command)}${encodedArgs}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character]));
}

function dashboardTask(task, completable = true) {
  const context = [task.project, task.waitingOn ? `Waiting: ${task.waitingOn}` : null, task.followUpDate ? `Follow up ${task.followUpDate}` : null, task.scheduledFor ? `Scheduled ${task.scheduledFor}` : task.scheduledFor === null ? "Needs a date" : null, task.dueDate ? `Due ${task.dueDate}` : null].filter(Boolean).join(" · ");
  const check = completable ? `<button class="check complete-task" type="button" data-task-id="${escapeHtml(task.id)}" title="Mark complete" aria-label="Mark ${escapeHtml(task.title)} complete"></button>` : '<span class="check"></span>';
  return `<article class="task" data-task-card="${escapeHtml(task.id)}">${check}<div><strong class="task-title">${escapeHtml(task.title)}</strong>${context ? `<small>${escapeHtml(context)}</small>` : ""}<button class="text-action edit-task" type="button" data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}">Edit</button></div>${task.sourceUrl ? `<a class="source" href="${escapeHtml(task.sourceUrl)}">Source ↗</a>` : ""}</article>`;
}

function reviewDashboardTask(task) {
  const context = [task.project, task.dueDate ? `Due ${task.dueDate}` : null, task.urgencyReason].filter(Boolean).join(" · ");
  return `<article class="review-card" data-review-card="${escapeHtml(task.id)}"><div class="review-copy"><strong>${escapeHtml(task.title)}</strong>${context ? `<small>${escapeHtml(context)}</small>` : ""}${task.sourceUrl ? `<a class="source" href="${escapeHtml(task.sourceUrl)}">Open email ↗</a>` : ""}</div><div class="review-actions"><button type="button" data-review="today" data-task-id="${escapeHtml(task.id)}">Today</button><button type="button" data-review="schedule" data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}" data-task-project="${escapeHtml(task.project || "")}">Schedule</button><button type="button" data-review="waiting" data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}">Waiting</button><button type="button" data-review="edit" data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}">Edit</button><button class="quiet" type="button" data-review="ignore" data-task-id="${escapeHtml(task.id)}">Ignore</button></div></article>`;
}

function scheduledDashboardTask(task) {
  const context = [task.project, task.scheduledFor ? `Currently ${task.scheduledFor}` : "Choose a date and time"].filter(Boolean).join(" · ");
  return `<button class="task scheduled-task" type="button" data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}" data-task-project="${escapeHtml(task.project || "")}" data-scheduled-for="${escapeHtml(task.scheduledFor || "")}"><span class="calendar-icon">+</span><span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(context)}</small></span><span class="source">Schedule →</span></button>`;
}

function dashboardSection(title, items, empty, tone = "aqua") {
  return `<section class="panel ${tone}"><div class="panel-head"><h2>${escapeHtml(title)}</h2><span>${items.length}</span></div>${items.length ? items.map((item) => dashboardTask(item)).join("") : `<p class="empty">${escapeHtml(empty)}</p>`}</section>`;
}

function reviewDashboardSection(items) {
  return `<section class="panel review-panel"><div class="panel-head"><h2>Email Task Review</h2><span>${items.length}</span></div><p class="section-help">Nothing becomes active until you choose an option.</p><div class="review-list">${items.length ? items.map(reviewDashboardTask).join("") : '<p class="empty">Every discovered email action has been reviewed.</p>'}</div></section>`;
}

function projectsDashboardSection(projects) {
  const active = projects.filter((project) => project.status === "active");
  const question = projects.find((project) => project.status === "unconfirmed");
  const activeRows = active.length ? active.map((project) => `<li><strong>${escapeHtml(project.name)}</strong><span>${project.openTaskCount} open</span></li>`).join("") : '<li class="empty">No projects confirmed yet.</li>';
  const prompt = question ? `<div class="project-question" data-project-question><p>Is <strong>${escapeHtml(question.name)}</strong> a main project you are currently working on?</p><small>${question.openTaskCount} related open task${question.openTaskCount === 1 ? "" : "s"}</small><div><button data-project-status="active" data-project-name="${escapeHtml(question.name)}">Yes, active</button><button data-project-status="later" data-project-name="${escapeHtml(question.name)}">Later</button><button class="quiet" data-project-status="inactive" data-project-name="${escapeHtml(question.name)}">Not active</button></div></div>` : '<p class="empty">All detected projects have been categorized.</p>';
  return `<section class="projects"><p class="eyebrow">Main Projects</p><ul>${activeRows}</ul>${prompt}</section>`;
}

function scheduledDashboardSection(items) {
  return `<section class="panel"><div class="panel-head"><h2>Scheduled / Needs Date</h2><span>${items.length}</span></div>${items.length ? items.map(scheduledDashboardTask).join("") : '<p class="empty">No scheduled tasks.</p>'}</section>`;
}

function minuteOfDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.getHours() * 60 + date.getMinutes();
}

function timeLabel(minutes) {
  const hours = Math.floor(minutes / 60);
  const minute = String(minutes % 60).padStart(2, "0");
  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}

async function calendarEventsForDate(targetDate = localDate()) {
  try {
    const date = dateAtNoon(targetDate);
    const events = normalizeDate(targetDate) === localDate() ? await Calendar.eventsToday() : await Calendar.eventsBetween(date, date);
    return (events || []).map((event) => ({
      id: event.id || event.eventID || hash(`${event.title}-${event.date}`),
      title: event.title || "Busy",
      start: event.date,
      end: event.endDate,
      allDay: Boolean(event.isAllDay),
      url: event.calendarItemLink || event.url || null,
    })).filter((event) => event.allDay || (event.start && event.end));
  } catch (error) {
    return [];
  }
}

function taskMinutes(task) {
  const title = task.title.toLowerCase();
  if (/invoice|investigate|build|write|resume|cover letter/.test(title)) return 60;
  if (/reply|contact|follow up|check whether|decide/.test(title)) return 30;
  return 45;
}

function mergeBusyRanges(events) {
  const ranges = events.filter((event) => !event.allDay).map((event) => ({
    start: Math.max(540, minuteOfDay(event.start) - 10),
    end: Math.min(1020, minuteOfDay(event.end) + 10),
  })).filter((range) => range.end > 540 && range.start < 1020);
  ranges.push({ start: 720, end: 750 });
  ranges.sort((first, second) => first.start - second.start);
  return ranges.reduce((merged, range) => {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
    return merged;
  }, []);
}

function planningStartMinute(targetDate = localDate(), now = new Date()) {
  const selected = normalizeDate(targetDate);
  if (selected > localDate()) return 540;
  if (selected < localDate()) return 1020;
  const current = now.getHours() * 60 + now.getMinutes();
  if (current <= 540) return 540;
  return Math.min(1020, Math.ceil(current / 10) * 10);
}

function nextWorkdayLabel(targetDate = localDate()) {
  return new Intl.DateTimeFormat("en-CA", { weekday: "long", month: "short", day: "numeric" }).format(dateAtNoon(moveWorkday(targetDate, 1)));
}

function availableGaps(events, startMinute = 540) {
  const busy = mergeBusyRanges(events);
  const gaps = [];
  let cursor = Math.max(540, startMinute);
  for (const range of busy) {
    if (range.end <= cursor) continue;
    if (range.start > cursor) gaps.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < 1020) gaps.push({ start: cursor, end: 1020 });
  return gaps;
}

function buildFocusBlocks(tasks, events, startMinute = planningStartMinute()) {
  const gaps = availableGaps(events, startMinute);
  const blocks = [];
  for (const task of tasks.slice(0, 5)) {
    const wanted = taskMinutes(task);
    const gap = gaps.find((candidate) => candidate.end - candidate.start >= Math.min(wanted, 25));
    if (!gap) break;
    const duration = Math.min(wanted, gap.end - gap.start);
    blocks.push({ task, start: gap.start, end: gap.start + duration });
    gap.start += duration + 10;
  }
  return blocks;
}

function existingFocusBlocks(targetDate = localDate()) {
  const note = DataStore.calendarNoteByDateString(compactDate(targetDate));
  if (!note) return [];
  return (note.paragraphs || []).flatMap((paragraph) => {
    const content = paragraph.content || "";
    if (!content.includes("#assistant/block")) return [];
    const match = content.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\s*[-–]\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s+(.+?)\s+#assistant\/block$/i);
    if (!match) return [];
    const toMinutes = (hour, minute, suffix) => {
      const normalizedHour = (Number(hour) % 12) + (suffix.toUpperCase() === "PM" ? 12 : 0);
      return normalizedHour * 60 + Number(minute);
    };
    return [{
      task: { title: match[7], project: "Edited in NotePlan" },
      start: toMinutes(match[1], match[2], match[3]),
      end: toMinutes(match[4], match[5], match[6]),
      userEdited: true,
    }];
  });
}

function timelineHtml(plan) {
  const hours = Array.from({ length: 9 }, (_, index) => `<span class="hour" style="top:${index * 12.5}%">${timeLabel(540 + index * 60).replace(":00", "")}</span>`).join("");
  const lines = Array.from({ length: 9 }, (_, index) => `<i class="hour-line" style="top:${index * 12.5}%"></i>`).join("");
  const events = (plan.calendarEvents || []).filter((event) => !event.allDay).map((event) => {
    const start = Math.max(540, minuteOfDay(event.start));
    const end = Math.min(1020, minuteOfDay(event.end));
    if (end <= start || end <= 540 || start >= 1020) return "";
    const top = ((start - 540) / 480) * 100;
    const height = Math.max(5, ((end - start) / 480) * 100);
    return `<div class="cal-block event" style="top:${top}%;height:${height}%"><b>${timeLabel(start)}</b>${escapeHtml(event.title)}</div>`;
  }).join("");
  const focus = (plan.focusBlocks || []).map((block) => {
    const top = ((block.start - 540) / 480) * 100;
    const height = Math.max(5, ((block.end - block.start) / 480) * 100);
    return `<div class="cal-block focus" tabindex="0" title="${escapeHtml(block.task.title)}" data-block-id="${escapeHtml(block.id)}" data-task-id="${escapeHtml(block.taskId || block.task.id)}" data-task-title="${escapeHtml(block.task.title)}" data-start="${block.start}" data-end="${block.end}" style="top:${top}%;height:${height}%"><b class="block-time">${timeLabel(block.start)}–${timeLabel(block.end)}</b><span class="block-title">${escapeHtml(abbreviatedBlockTitle(block.task.title))}</span><span class="block-tools"><button type="button" class="block-edit" title="Edit block">Edit</button><button type="button" class="block-done" title="Mark complete">✓</button></span><i class="resize-handle" title="Drag to change duration"></i></div>`;
  }).join("");
  const allDay = (plan.calendarEvents || []).filter((event) => event.allDay).map((event) => `<span>${escapeHtml(event.title)}</span>`).join("");
  const now = plan.planningStartMinute;
  const nowLine = plan.date === localDate() && now > 540 && now < 1020 ? `<div class="now-line" style="top:${((now - 540) / 480) * 100}%"><span>Now</span></div>` : "";
  return `${allDay ? `<div class="all-day"><b>All day</b>${allDay}</div>` : ""}<div class="timeline">${hours}${lines}<div class="calendar-track">${events}${focus}${nowLine}</div></div>`;
}

function dashboardInteractionScript(plan) {
  const busyRanges = (plan.calendarEvents || []).filter((event) => !event.allDay).map((event) => ({
    start: Math.max(540, minuteOfDay(event.start)),
    end: Math.min(1020, minuteOfDay(event.end)),
  })).filter((range) => range.end > range.start);
  return `<script>
    (function () {
      const selectedDate = ${JSON.stringify(plan.date)};
      const busyRanges = ${JSON.stringify(busyRanges)};
      const track = document.querySelector('.calendar-track');
      const saveState = document.getElementById('save-state');
      const snap = (value) => Math.round(value / 10) * 10;
      const label = (minutes) => { const hour = Math.floor(minutes / 60); const minute = String(minutes % 60).padStart(2, '0'); return String(hour % 12 || 12) + ':' + minute + ' ' + (hour >= 12 ? 'PM' : 'AM'); };
      const render = (block, start, end) => {
        block.dataset.start = String(start); block.dataset.end = String(end);
        block.style.top = String(((start - 540) / 480) * 100) + '%';
        block.style.height = String(Math.max(5, ((end - start) / 480) * 100)) + '%';
        block.querySelector('.block-time').textContent = label(start) + '–' + label(end);
      };
      const calendarConflict = (start, end) => busyRanges.some((range) => start < range.end && end > range.start);
      const workConflicts = (start, end, block, except) => Array.from(document.querySelectorAll('.cal-block.focus')).filter((other) => other !== block && other !== except && start < Number(other.dataset.end) && end > Number(other.dataset.start));
      const send = (type, data) => {
        if (!window.webkit) { saveState.textContent = 'Preview mode'; return; }
        const code = '(async function(){await DataStore.invokePluginCommandByName("onMessageFromHTMLView","leslee.WorkActivationAssistant",' + JSON.stringify([type, data]) + ');})()';
        window.webkit.messageHandlers.jsBridge.postMessage({ code: code, onHandle: '', id: String(Date.now()) });
      };
      let interaction = null;
      track.addEventListener('pointerdown', (event) => {
        if (event.target.closest('button')) return;
        const block = event.target.closest('.cal-block.focus');
        if (!block) return;
        event.preventDefault();
        block.setPointerCapture(event.pointerId);
        interaction = { block: block, pointerId: event.pointerId, y: event.clientY, start: Number(block.dataset.start), end: Number(block.dataset.end), mode: event.target.classList.contains('resize-handle') ? 'resize' : 'move' };
        block.classList.add('editing');
        saveState.textContent = interaction.mode === 'resize' ? 'Resizing…' : 'Moving…';
      });
      track.addEventListener('pointermove', (event) => {
        if (!interaction || interaction.pointerId !== event.pointerId) return;
        const delta = snap(((event.clientY - interaction.y) / track.getBoundingClientRect().height) * 480);
        let start = interaction.start;
        let end = interaction.end;
        if (interaction.mode === 'move') {
          const duration = end - start;
          start = Math.max(540, Math.min(1020 - duration, start + delta));
          end = start + duration;
        } else end = Math.max(start + 20, Math.min(1020, end + delta));
        render(interaction.block, start, end);
      });
      const finish = (event) => {
        if (!interaction || interaction.pointerId !== event.pointerId) return;
        const block = interaction.block;
        const start = Number(block.dataset.start);
        const end = Number(block.dataset.end);
        block.classList.remove('editing');
        const conflicts = workConflicts(start, end, block, null);
        let swapped = false;
        if (interaction.mode === 'move' && conflicts.length === 1) {
          const other = conflicts[0];
          const otherDuration = Number(other.dataset.end) - Number(other.dataset.start);
          const otherStart = interaction.start;
          const otherEnd = otherStart + otherDuration;
          if (otherEnd <= 1020 && !calendarConflict(otherStart, otherEnd) && workConflicts(otherStart, otherEnd, other, block).length === 0) {
            render(other, otherStart, otherEnd);
            send('saveFocusBlock', { date: selectedDate, id: other.dataset.blockId, start: otherStart, end: otherEnd });
            swapped = true;
          }
        }
        if (calendarConflict(start, end) || (conflicts.length && !swapped)) {
          render(block, interaction.start, interaction.end);
          block.classList.add('invalid');
          setTimeout(() => block.classList.remove('invalid'), 700);
          saveState.textContent = calendarConflict(start, end) ? 'That overlaps a calendar event' : 'Not enough room to move that block there';
        } else {
          saveState.textContent = 'Saving…';
          send('saveFocusBlock', { date: selectedDate, id: block.dataset.blockId, start: start, end: end });
          setTimeout(() => { saveState.textContent = swapped ? 'Blocks swapped and saved' : 'Saved automatically'; }, 450);
        }
        interaction = null;
      };
      track.addEventListener('pointerup', finish);
      track.addEventListener('pointercancel', finish);
      document.querySelectorAll('.complete-task').forEach((button) => button.addEventListener('click', () => {
        send('completeTask', { id: button.dataset.taskId });
        const card = button.closest('[data-task-card]');
        if (card) card.remove();
        document.querySelectorAll('.cal-block.focus[data-task-id="' + button.dataset.taskId + '"]').forEach((block) => block.remove());
        saveState.textContent = 'Completed';
      }));
      track.addEventListener('click', (event) => {
        const done = event.target.closest('.block-done');
        if (done) {
          const block = done.closest('.cal-block.focus');
          send('completeTask', { id: block.dataset.taskId });
          document.querySelectorAll('[data-task-card="' + block.dataset.taskId + '"]').forEach((card) => card.remove());
          block.remove();
          saveState.textContent = 'Completed';
          return;
        }
        const edit = event.target.closest('.block-edit');
        if (edit) openEdit(edit.closest('.cal-block.focus').dataset.taskId, edit.closest('.cal-block.focus').dataset.taskTitle);
      });
      const dialog = document.getElementById('schedule-dialog');
      const scheduleDate = document.getElementById('schedule-date');
      const scheduleTime = document.getElementById('schedule-time');
      const scheduleDuration = document.getElementById('schedule-duration');
      const scheduleError = document.getElementById('schedule-error');
      let schedulingTask = null;
      const openSchedule = (button) => {
        schedulingTask = { id: button.dataset.taskId, title: button.dataset.taskTitle, project: button.dataset.taskProject, button: button };
        document.getElementById('schedule-task-title').textContent = schedulingTask.title;
        scheduleDate.value = button.dataset.scheduledFor || selectedDate;
        scheduleTime.value = ${JSON.stringify(timeLabel(Math.min(960, Math.max(540, plan.planningStartMinute))).replace(/ (AM|PM)$/, "").split(":").map((part, index) => index ? part : String((Number(part) % 12) + (plan.planningStartMinute >= 720 ? 12 : 0)).padStart(2, "0")).join(":"))};
        scheduleDuration.value = '60';
        scheduleError.textContent = '';
        dialog.showModal();
      };
      document.querySelectorAll('.scheduled-task,[data-review="schedule"]').forEach((button) => button.addEventListener('click', () => openSchedule(button)));
      document.getElementById('schedule-save').addEventListener('click', (event) => {
        event.preventDefault();
        if (!schedulingTask || !scheduleDate.value || !scheduleTime.value) { scheduleError.textContent = 'Choose both a date and start time.'; return; }
        const parts = scheduleTime.value.split(':').map(Number);
        const start = parts[0] * 60 + parts[1];
        const end = start + Number(scheduleDuration.value);
        if (start < 540 || end > 1020) { scheduleError.textContent = 'Choose a block between 9:00 AM and 5:00 PM.'; return; }
        if (scheduleDate.value === selectedDate && (calendarConflict(start, end) || workConflicts(start, end, null, null).length)) { scheduleError.textContent = 'That time is already occupied. Choose another time.'; return; }
        send('scheduleTask', { date: scheduleDate.value, task: { id: schedulingTask.id, title: schedulingTask.title, project: schedulingTask.project || null }, start: start, end: end });
        if (scheduleDate.value === selectedDate) {
          const block = document.createElement('div');
          block.className = 'cal-block focus'; block.tabIndex = 0; block.title = schedulingTask.title;
          block.dataset.blockId = 'focus-' + schedulingTask.id; block.dataset.taskId = schedulingTask.id; block.dataset.taskTitle = schedulingTask.title;
          block.innerHTML = '<b class="block-time"></b><span class="block-title"></span><span class="block-tools"><button type="button" class="block-edit">Edit</button><button type="button" class="block-done">✓</button></span><i class="resize-handle" title="Drag to change duration"></i>';
          block.querySelector('.block-title').textContent = schedulingTask.title.length > 34 ? schedulingTask.title.slice(0, 33).trimEnd() + '…' : schedulingTask.title;
          render(block, start, end); track.appendChild(block);
        }
        const reviewCard = schedulingTask.button.closest('[data-review-card]');
        if (reviewCard) reviewCard.remove(); else schedulingTask.button.remove();
        dialog.close();
        saveState.textContent = scheduleDate.value === selectedDate ? 'Block created and saved' : 'Scheduled for ' + scheduleDate.value;
      });
      document.querySelectorAll('[data-review="today"],[data-review="ignore"]').forEach((button) => button.addEventListener('click', () => {
        const decision = button.dataset.review === 'today' ? 'addToday' : 'ignore';
        send('reviewTask', { id: button.dataset.taskId, decision: decision });
        const card = button.closest('[data-review-card]');
        if (card) card.remove();
        saveState.textContent = decision === 'addToday' ? 'Added to active tasks' : 'Ignored';
      }));
      const waitingDialog = document.getElementById('waiting-dialog');
      const waitingOn = document.getElementById('waiting-on');
      const waitingDate = document.getElementById('waiting-date');
      const waitingError = document.getElementById('waiting-error');
      let waitingTask = null;
      document.querySelectorAll('[data-review="waiting"]').forEach((button) => button.addEventListener('click', () => {
        waitingTask = { id: button.dataset.taskId, card: button.closest('[data-review-card]') };
        document.getElementById('waiting-task-title').textContent = button.dataset.taskTitle;
        waitingOn.value = ''; waitingDate.value = ${JSON.stringify(moveWorkday(plan.date, 1))}; waitingError.textContent = '';
        waitingDialog.showModal();
      }));
      document.getElementById('waiting-save').addEventListener('click', (event) => {
        event.preventDefault();
        if (!waitingOn.value.trim() || !waitingDate.value) { waitingError.textContent = 'Add both the dependency and follow-up date.'; return; }
        send('waitingTask', { id: waitingTask.id, waitingOn: waitingOn.value.trim(), followUpDate: waitingDate.value });
        if (waitingTask.card) waitingTask.card.remove();
        waitingDialog.close(); saveState.textContent = 'Waiting item saved';
      });
      const editDialog = document.getElementById('edit-dialog');
      const editTitle = document.getElementById('edit-title');
      const editError = document.getElementById('edit-error');
      let editingTask = null;
      const openEdit = (id, title) => { editingTask = { id: id }; editTitle.value = title || ''; editError.textContent = ''; editDialog.showModal(); };
      document.querySelectorAll('.edit-task,[data-review="edit"]').forEach((button) => button.addEventListener('click', () => openEdit(button.dataset.taskId, button.dataset.taskTitle)));
      document.getElementById('edit-save').addEventListener('click', (event) => {
        event.preventDefault();
        if (!editingTask || !editTitle.value.trim()) { editError.textContent = 'Task wording is required.'; return; }
        send('updateTask', { id: editingTask.id, title: editTitle.value.trim() });
        document.querySelectorAll('[data-task-card="' + editingTask.id + '"] .task-title').forEach((title) => { title.textContent = editTitle.value.trim(); });
        document.querySelectorAll('.cal-block.focus[data-task-id="' + editingTask.id + '"]').forEach((block) => { block.dataset.taskTitle = editTitle.value.trim(); block.title = editTitle.value.trim(); block.querySelector('.block-title').textContent = editTitle.value.trim().length > 34 ? editTitle.value.trim().slice(0, 33) + '…' : editTitle.value.trim(); });
        editDialog.close(); saveState.textContent = 'Task updated';
      });
      document.querySelectorAll('[data-project-status]').forEach((button) => button.addEventListener('click', () => {
        send('projectStatus', { name: button.dataset.projectName, status: button.dataset.projectStatus });
        const question = button.closest('[data-project-question]');
        if (question) question.innerHTML = '<p><strong>Saved.</strong> Reopen the dashboard for the next project question.</p>';
      }));
      document.getElementById('feedback-save').addEventListener('click', () => {
        const input = document.getElementById('feedback-text');
        const type = document.getElementById('feedback-type').value;
        const state = document.getElementById('feedback-state');
        if (!input.value.trim()) { state.textContent = 'Write something first.'; return; }
        send('saveDashboardFeedback', { type: type, text: input.value.trim(), date: selectedDate });
        input.value = '';
        state.textContent = 'Saved. This will be available during future planning.';
      });
    })();
  </script>`;
}

function dashboardHtml(plan) {
  const capacityHours = `${Math.floor(plan.availableMinutes / 60)}h ${plan.availableMinutes % 60}m`;
  const sourceStatus = plan.sources.map((source) => `<span class="status"><i></i>${escapeHtml(source.source)} · ${escapeHtml(source.status)}</span>`).join("");
  const ideas = (plan.ideas || []).map((idea) => `<article class="idea"><strong>${escapeHtml(idea.text)}</strong><small>${escapeHtml(idea.nextQuestion || idea.nextAction || "Captured")}</small></article>`).join("");
  const noTimeRemains = plan.availableMinutes < 25;
  const heroTitle = noTimeRemains ? "Close the day without forcing another task" : plan.startHere?.title || "Nothing urgent is ready yet";
  const previousDate = moveWorkday(plan.date, -1);
  const nextDate = moveWorkday(plan.date, 1);
  const dateContext = plan.date === localDate() ? `${timeLabel(plan.planningStartMinute)} now · ends 5:00 PM` : plan.date > localDate() ? "Full 9:00 AM–5:00 PM preview" : "Past workday";
  const coverageControl = plan.emailCoverage?.complete ? "" : `<a class="button secondary" href="${commandUrl("Assistant: Scan Older Email")}">Continue Full Email Scan${plan.emailCoverage?.scannedThreads ? ` · ${plan.emailCoverage.scannedThreads} checked` : ""}</a>`;
  const googleControls = serviceConfigured()
    ? `<a class="button refresh" href="${commandUrl("Assistant: Refresh Gmail & Calendar", [plan.date])}">Check Gmail & Calendar Now</a>${coverageControl}<a class="button secondary" href="${commandUrl("Assistant: Reconnect Google")}">Reconnect Google</a>`
    : '<span class="button disabled refresh">Live Gmail setup required</span>';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:light;--ink:#233033;--muted:#68777a;--paper:#fbfaf7;--card:#fff;--line:#e6e1d9;--aqua:#d8eeee;--aqua-ink:#155e63;--amber:#f5dfb5;--amber-ink:#815710;--purple:#8c79a9;--shadow:0 18px 50px rgba(55,45,38,.12)}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}a{text-decoration:none;color:inherit}button{font:inherit}.shell{display:grid;grid-template-columns:minmax(0,1.35fr) 390px;min-height:100vh}.main{padding:34px 42px}.side{padding:28px 24px;background:#f5f1eb;border-left:1px solid var(--line)}header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:10px}.eyebrow{margin:0 0 5px;color:var(--purple);font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}h1{margin:0;font-size:34px;letter-spacing:-.04em}h2{margin:0;font-size:17px}.date{color:var(--muted);font-weight:650}.date-nav{display:flex;gap:8px;margin:12px 0 18px}.date-nav a{padding:7px 10px;border:1px solid var(--line);background:#fff;border-radius:8px;color:#536164;font-size:12px;font-weight:700}.date-nav a.today{background:#2e6e72;color:#fff;border-color:#2e6e72}.statuses{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.status{background:#eef4f2;border-radius:999px;padding:7px 10px;font-size:12px;color:#536566}.status i{display:inline-block;width:7px;height:7px;background:#4ca66b;border-radius:50%;margin-right:6px}.hero{background:linear-gradient(135deg,#245e63,#2f767a);color:#fff;border-radius:18px;padding:23px 25px;box-shadow:var(--shadow);margin-bottom:18px}.hero label{display:block;opacity:.72;font-size:11px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}.hero h2{font-size:22px;margin:8px 0 4px}.hero p{margin:0;opacity:.78}.feedback-panel{display:grid;grid-template-columns:150px 1fr auto;gap:10px;align-items:start;background:#f0eeee;border:1px solid #ddd5e7;border-radius:14px;padding:14px;margin-bottom:18px}.feedback-panel select,.feedback-panel textarea{width:100%;border:1px solid #d7d0df;border-radius:9px;background:#fff;padding:9px;font:inherit}.feedback-panel textarea{resize:vertical;min-height:42px}.feedback-panel button{border:0;border-radius:9px;background:var(--purple);color:#fff;padding:10px 13px;font-weight:750}.feedback-state{grid-column:2/-1;color:var(--muted);font-size:11px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}.panel{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 7px 24px rgba(55,45,38,.05)}.review-panel{grid-column:1/-1}.panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.panel-head span{border-radius:999px;background:var(--aqua);color:var(--aqua-ink);font-size:12px;font-weight:800;padding:4px 8px}.amber .panel-head span{background:var(--amber);color:var(--amber-ink)}.section-help{color:var(--muted);font-size:12px;margin:0 0 8px}.task{display:grid;grid-template-columns:18px 1fr auto;gap:10px;align-items:start;padding:12px 0;border-top:1px solid #eeeae4}.task:first-of-type{border-top:0}.task strong{font-size:14px;line-height:1.35}.task small,.idea small,.review-card small{display:block;color:var(--muted);margin-top:4px;line-height:1.35}.scheduled-task{width:100%;border:0;background:transparent;text-align:left;color:inherit;font:inherit;cursor:pointer}.scheduled-task:hover{background:#f7f3ed}.calendar-icon{display:grid;place-items:center;width:17px;height:17px;border-radius:5px;background:var(--aqua);color:var(--aqua-ink);font-weight:900}.check{width:17px;height:17px;border:2px solid #d39532;border-radius:50%;margin-top:2px;background:#fff;cursor:pointer}.check:hover{background:#f5dfb5}.source{color:var(--purple);font-size:11px;font-weight:750;white-space:nowrap}.text-action{border:0;background:transparent;color:var(--purple);padding:4px 0;font-size:11px;font-weight:750;cursor:pointer}.review-list{max-height:620px;overflow:auto;padding-right:4px}.review-card{padding:13px 0;border-top:1px solid #eeeae4}.review-card:first-child{border-top:0}.review-copy{display:grid;grid-template-columns:1fr auto;gap:4px 12px}.review-copy small{grid-column:1}.review-copy .source{grid-column:2;grid-row:1}.review-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.review-actions button,.project-question button{border:1px solid #b7d1d1;background:#edf7f6;color:#245e63;border-radius:8px;padding:7px 10px;font-size:11px;font-weight:800;cursor:pointer}.review-actions button:hover,.project-question button:hover{background:#d8eeee}.review-actions .quiet,.project-question .quiet{background:#fff;color:#68777a;border-color:var(--line)}.projects{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:14px}.projects ul{list-style:none;margin:0 0 12px;padding:0}.projects li{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid #eeeae4}.projects li span{color:var(--muted);font-size:11px}.project-question{background:#f0eeee;border-radius:10px;padding:11px}.project-question p{margin:0 0 4px;line-height:1.4}.project-question small{color:var(--muted)}.project-question div{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}.empty{color:var(--muted);font-style:italic}.metric-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}.metric{background:#fff;border:1px solid var(--line);border-radius:12px;padding:11px}.metric strong{display:block;font-size:19px;letter-spacing:-.03em}.metric span{display:block;color:var(--muted);font-size:10px;margin-top:2px}.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}.button{display:block;padding:10px 11px;text-align:center;border-radius:9px;background:#2e6e72;color:#fff;font-size:12px;font-weight:750}.button.secondary{background:#fff;color:#425356;border:1px solid var(--line)}.button.refresh{grid-column:1/-1;background:#2e6e72}.button.disabled{background:#d6d0c8;color:#746d65;cursor:not-allowed}.idea{padding:12px 0;border-top:1px solid var(--line)}.warning{background:#fff7e6;border:1px solid #efd8a7;color:#76551b;border-radius:12px;padding:12px;line-height:1.4}.backlog{margin-top:15px;color:var(--muted);font-size:13px}.workflow{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:14px}.workflow b{display:block;margin-bottom:5px}.workflow span{display:block;color:var(--muted);font-size:12px;line-height:1.45}.save-state{display:block;color:#2e6e72;font-size:11px;font-weight:750;margin-top:7px}.all-day{display:flex;gap:7px;align-items:center;background:#fff;border:1px solid var(--line);border-radius:9px;padding:8px;margin-bottom:8px;font-size:11px}.all-day span{background:var(--amber);border-radius:6px;padding:4px 6px}.timeline{position:relative;height:510px;margin:8px 0 14px 42px}.hour{position:absolute;left:-42px;width:38px;color:#8b9494;font-size:10px;transform:translateY(-6px)}.hour-line{position:absolute;left:0;right:0;border-top:1px solid #ded9d1}.calendar-track{position:absolute;inset:0;touch-action:none}.cal-block{position:absolute;left:4px;right:3px;border-radius:7px;padding:5px 7px;overflow:hidden;font-size:10px;line-height:1.2;border-left:3px solid}.cal-block b{display:block;font-size:9px;margin-bottom:2px}.cal-block.event{background:#dbe8e8;border-color:#64aeb0;color:#315f62}.cal-block.focus{left:48%;background:#f5dfb5;border-color:#d88a28;color:#714c17;cursor:grab;user-select:none;overflow:hidden;z-index:4}.block-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:48px}.block-tools{position:absolute;top:3px;right:3px;display:flex;gap:2px}.block-tools button{border:0;border-radius:4px;background:rgba(255,255,255,.72);color:#714c17;padding:2px 4px;font-size:8px;font-weight:800;cursor:pointer}.cal-block.focus.editing{cursor:grabbing;box-shadow:0 6px 16px rgba(113,76,23,.25)}.cal-block.focus.invalid{background:#f4c9c2;border-color:#c84d3c}.resize-handle{position:absolute;left:0;right:0;bottom:-2px;height:8px;cursor:ns-resize;border-bottom:3px solid rgba(113,76,23,.45);border-radius:0 0 6px 6px}.now-line{position:absolute;left:0;right:0;border-top:2px solid #d85454;z-index:8;pointer-events:none}.now-line span{position:absolute;right:0;top:-9px;background:#d85454;color:#fff;border-radius:8px;padding:2px 5px;font-size:8px}.calendar-key{display:flex;gap:12px;color:var(--muted);font-size:10px}.calendar-key i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:4px}.key-event{background:#8fc5c6}.key-focus{background:#e4ad57}dialog{border:0;border-radius:16px;padding:0;box-shadow:var(--shadow);width:min(420px,90vw)}dialog::backdrop{background:rgba(35,48,51,.35)}.schedule-form{padding:24px}.schedule-form h2{font-size:20px;margin-bottom:6px}.schedule-form p{color:var(--muted);margin:0 0 18px}.schedule-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.schedule-fields label{font-size:11px;font-weight:800;color:var(--muted)}.schedule-fields input,.schedule-fields select{display:block;width:100%;margin-top:5px;padding:9px;border:1px solid var(--line);border-radius:8px;font:inherit}.schedule-fields .wide{grid-column:1/-1}.schedule-error{min-height:18px;color:#b23a2c;font-size:12px;margin-top:10px}.dialog-actions{display:flex;justify-content:flex-end;gap:8px}.dialog-actions button{border:0;border-radius:8px;padding:9px 13px;font-weight:750}.dialog-actions .save{background:#2e6e72;color:#fff}@media(max-width:820px){.shell{grid-template-columns:1fr}.side{border-left:0;border-top:1px solid var(--line)}.grid{grid-template-columns:1fr}.review-panel{grid-column:1}.feedback-panel{grid-template-columns:1fr}.feedback-state{grid-column:1}}
  </style></head><body><div class="shell"><main class="main"><header><div><p class="eyebrow">Work Activation Assistant</p><h1>${escapeHtml(selectedDateLabel(plan.date))}</h1></div><span class="date">${escapeHtml(dateContext)}</span></header><nav class="date-nav"><a href="${commandUrl("Assistant: Dashboard", [previousDate])}">← Previous</a><a class="today" href="${commandUrl("Assistant: Dashboard", [localDate()])}">Today</a><a href="${commandUrl("Assistant: Dashboard", [nextDate])}">Next Workday →</a></nav><div class="statuses">${sourceStatus}</div>${plan.warnings.length ? `<p class="warning">⚠ ${escapeHtml(plan.warnings.join(" "))}</p>` : ""}<section class="hero"><label>${noTimeRemains ? "Shutdown Step" : "Start Here"}</label><h2>${escapeHtml(heroTitle)}</h2><p>${escapeHtml(plan.nextInstruction)}</p></section><section class="feedback-panel"><select id="feedback-type"><option value="idea">New idea</option><option value="task">New task</option><option value="correction">Correction</option><option value="blocker">Blocker</option></select><textarea id="feedback-text" placeholder="Anything new or corrected that you want me to remember?"></textarea><button id="feedback-save" type="button">Save Feedback</button><small class="feedback-state" id="feedback-state"></small></section><div class="grid">${dashboardSection("Active Tasks", plan.today, "Nothing approved for this date.")}${dashboardSection("Waiting & Follow-Up", plan.waiting, "No waiting items.", "amber")}${scheduledDashboardSection(plan.scheduled || [])}${reviewDashboardSection(plan.review)}</div><p class="backlog">Unchecked active tasks automatically remain active on the next workday. Completed tasks disappear.</p></main><aside class="side"><p class="eyebrow">${plan.date === localDate() ? "Remaining" : "Selected"} 9–5 Plan</p><div class="workflow"><b>Edit your plan here</b><span>Drag blocks to move them, drag the bottom edge to resize, use Edit to change details, or ✓ to complete.</span><small class="save-state" id="save-state">Saved automatically</small></div><div class="metric-row"><div class="metric"><strong>${capacityHours}</strong><span>${plan.date === localDate() ? "remaining" : "available"}</span></div><div class="metric"><strong>${plan.today.length}</strong><span>active</span></div><div class="metric"><strong>${plan.focusBlocks?.length || 0}</strong><span>editable blocks</span></div></div><div class="calendar-key"><span><i class="key-event"></i>Calendar</span><span><i class="key-focus"></i>Editable work block</span></div>${timelineHtml(plan)}<nav class="actions">${googleControls}</nav>${projectsDashboardSection(plan.projects || [])}${ideas ? `<section><p class="eyebrow">Ideas & Follow-Up</p>${ideas}</section>` : ""}</aside></div><dialog id="schedule-dialog"><form class="schedule-form"><h2>Schedule Task</h2><p id="schedule-task-title"></p><div class="schedule-fields"><label>Date<input id="schedule-date" type="date" required></label><label>Start time<input id="schedule-time" type="time" min="09:00" max="16:30" step="600" required></label><label>Duration<select id="schedule-duration"><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60" selected>1 hour</option><option value="90">1½ hours</option><option value="120">2 hours</option></select></label></div><div class="schedule-error" id="schedule-error"></div><div class="dialog-actions"><button type="button" onclick="document.getElementById('schedule-dialog').close()">Cancel</button><button class="save" id="schedule-save" type="submit">Create Block</button></div></form></dialog><dialog id="waiting-dialog"><form class="schedule-form"><h2>Waiting For</h2><p id="waiting-task-title"></p><div class="schedule-fields"><label class="wide">Who or what?<input id="waiting-on" type="text" required></label><label>Follow-up date<input id="waiting-date" type="date" required></label></div><div class="schedule-error" id="waiting-error"></div><div class="dialog-actions"><button type="button" onclick="document.getElementById('waiting-dialog').close()">Cancel</button><button class="save" id="waiting-save" type="submit">Save Waiting</button></div></form></dialog><dialog id="edit-dialog"><form class="schedule-form"><h2>Edit Task</h2><div class="schedule-fields"><label class="wide">Task wording<input id="edit-title" type="text" required></label></div><div class="schedule-error" id="edit-error"></div><div class="dialog-actions"><button type="button" onclick="document.getElementById('edit-dialog').close()">Cancel</button><button class="save" id="edit-save" type="submit">Save</button></div></form></dialog>${dashboardInteractionScript(plan)}</body></html>`;
}

function nextIdeaQuestion(answerCount) {
  return [
    "What would done look like for this idea?",
    "What have you completed already?",
    "What is still unfinished?",
    "Is there a deadline or preferred completion date?",
    "What is the smallest next action you could take?",
  ][answerCount] || null;
}

function loadPilotReview() {
  return DataStore.loadJSON(PILOT_FILENAME);
}

function decodeBase64Utf8(encoded) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const input = String(encoded).replace(/[^A-Za-z0-9+/=]/g, "");
  const bytes = [];
  for (let index = 0; index < input.length; index += 4) {
    const first = alphabet.indexOf(input[index]);
    const second = alphabet.indexOf(input[index + 1]);
    const third = input[index + 2] === "=" ? -1 : alphabet.indexOf(input[index + 2]);
    const fourth = input[index + 3] === "=" ? -1 : alphabet.indexOf(input[index + 3]);
    bytes.push((first << 2) | (second >> 4));
    if (third >= 0) bytes.push(((second & 15) << 4) | (third >> 2));
    if (fourth >= 0) bytes.push(((third & 3) << 6) | fourth);
  }
  return decodeURIComponent(bytes.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""));
}

function pilotPlanFromTransfer(payload, notePlanTasks = [], targetDate = localDate()) {
  const selectedDate = normalizeDate(targetDate);
  const decisions = payload.decisions || {};
  const corrections = payload.feedback?.corrections || {};
  const schedules = payload.feedback?.schedules || {};
  const waitingDates = payload.feedback?.waitingDates || {};
  const groups = { review: [], today: [], waiting: [], scheduled: [], other: [] };
  for (const original of payload.tasks || []) {
    const task = { ...original, title: corrections[original.id]?.title || original.title, sourceType: "gmail" };
    const decision = decisions[task.id];
    if (decision === "ignore") continue;
    if (decision === "addToday") groups.today.push(task);
    else if (decision === "waiting") {
      const followUpDate = waitingDates[task.id] || null;
      const waitingTask = { ...task, followUpDate, waitingOn: task.waitingOn || task.meta || "External dependency" };
      if (followUpDate && followUpDate <= selectedDate) groups.today.push({ ...waitingTask, urgencyReason: "Waiting follow-up is due" });
      else groups.waiting.push(waitingTask);
    } else if (decision === "schedule") {
      const scheduledFor = schedules[task.id] || null;
      const scheduledTask = { ...task, scheduledFor };
      if (scheduledFor && scheduledFor <= selectedDate) groups.today.push({ ...scheduledTask, urgencyReason: "Scheduled for this date" });
      else groups.scheduled.push(scheduledTask);
    }
    else groups.review.push(task);
  }
  groups.other.push(...notePlanTasks);
  const ideas = (payload.feedback?.ideas || []).map((idea) => ({
    ...idea,
    nextQuestion: nextIdeaQuestion(idea.answers?.length || 0),
    nextAction: idea.answers?.length >= 5 ? idea.answers.at(-1) : null,
  }));
  return {
    date: selectedDate,
    generatedAt: new Date().toISOString(),
    sources: [
      { source: "gmail", status: "pilot imported", checkedAt: payload.gmailCheckedAt },
      { source: "calendar", status: "pilot imported", checkedAt: payload.calendarCheckedAt },
      { source: "noteplan", status: "connected", checkedAt: new Date().toISOString() },
    ],
    startHere: groups.today[0] || groups.review[0] || null,
    ...groups,
    availableMinutes: payload.availableMinutes ?? 0,
    warnings: ["Imported from the verified pilot. Live Gmail and Calendar refresh begins after the cloud service is connected."],
    checkInQuestion: null,
    ideas,
  };
}

function replaceAssistantSection(content, section) {
  const markerPair = content.includes(START_MARKER) ? [START_MARKER, END_MARKER] : [LEGACY_START_MARKER, LEGACY_END_MARKER];
  const start = content.indexOf(markerPair[0]);
  const end = content.indexOf(markerPair[1]);
  if (start >= 0 && end >= start) return `${content.slice(0, start).trimEnd()}\n\n${section}\n${content.slice(end + markerPair[1].length).trimStart()}`.trim();
  const headingStart = content.indexOf("## Work Activation");
  if (headingStart >= 0) return `${content.slice(0, headingStart).trimEnd()}\n\n${section}`.trim();
  return `${content.trimEnd()}\n\n${section}`.trim();
}

async function updateDailyNote(plan, targetDate = plan.date || localDate()) {
  const note = DataStore.calendarNoteByDateString(compactDate(targetDate));
  if (!note) throw new Error(`Open or create the ${normalizeDate(targetDate)} daily note first.`);
  note.content = replaceAssistantSection(note.content || "", planMarkdown(plan));
}

async function syncNotePlanTasks() {
  const tasks = collectOpenTasks();
  await request("/api/noteplan/sync", { method: "POST", body: JSON.stringify({ tasks }) });
  return tasks.length;
}

async function currentPlan(targetDate = localDate()) {
  const selectedDate = normalizeDate(targetDate);
  let plan;
  if (serviceConfigured()) {
    await syncNotePlanTasks();
    plan = await request(`/api/generate?date=${selectedDate}`, { method: "POST" });
    const projectResult = await request("/api/projects");
    plan.projects = projectResult.projects || [];
  } else {
    const pilot = loadPilotReview();
    if (!pilot) throw new Error("Import the completed pilot review first.");
    plan = pilotPlanFromTransfer(pilot, collectOpenTasks(), selectedDate);
  }
  const calendarEvents = await calendarEventsForDate(selectedDate);
  const startMinute = planningStartMinute(selectedDate);
  const gaps = availableGaps(calendarEvents, startMinute);
  const remainingMinutes = gaps.reduce((total, gap) => total + gap.end - gap.start, 0);
  const focusBlocks = dashboardBlocksForDate(selectedDate, buildFocusBlocks(plan.today, calendarEvents, startMinute));
  const isLateDay = startMinute >= 960;
  const nextInstruction = remainingMinutes < 25
    ? selectedDate === localDate() ? `No workable focus block remains today. Keep unfinished work for ${nextWorkdayLabel(selectedDate)} and do a short shutdown review.` : "No workable focus block is available on this selected date."
    : isLateDay
      ? "The workday is nearly over. Choose one short block, then leave the rest carried forward."
      : "Adjust the gold blocks directly in this dashboard, then begin Start Here.";
  return {
    ...plan,
    date: selectedDate,
    calendarEvents,
    scheduled: plan.scheduled || [],
    focusBlocks,
    hasExistingFocusBlocks: false,
    availableMinutes: remainingMinutes,
    planningStartMinute: startMinute,
    nextInstruction,
  };
}

async function assistantToday(targetDate = localDate()) {
  try {
    const plan = await currentPlan(targetDate);
    await updateDailyNote(plan, targetDate);
  } catch (error) {
    await CommandBar.prompt("Work Activation Assistant", error.message, ["OK"]);
  }
}

async function assistantDashboard(targetDate = localDate()) {
  try {
    const plan = await currentPlan(targetDate);
    HTMLView.showWindow(dashboardHtml(plan), "Work Activation Assistant", 1180, 780);
  } catch (error) {
    await CommandBar.prompt("Work Activation Dashboard", error.message, ["OK"]);
  }
}

function focusBlocksMarkdown(blocks) {
  return [
    BLOCKS_START_MARKER,
    "## Focus Blocks",
    ...blocks.map((block) => `* ${timeLabel(block.start)} - ${timeLabel(block.end)} ${block.task.title} #assistant/block`),
    BLOCKS_END_MARKER,
  ].join("\n");
}

function replaceFocusBlocks(content, section) {
  const start = content.indexOf(BLOCKS_START_MARKER);
  const end = content.indexOf(BLOCKS_END_MARKER);
  if (start >= 0 && end >= start) return `${content.slice(0, start).trimEnd()}\n\n${section}\n${content.slice(end + BLOCKS_END_MARKER.length).trimStart()}`.trim();
  return `${content.trimEnd()}\n\n${section}`.trim();
}

async function assistantBuildTimeBlocks(targetDate = localDate()) {
  return assistantDashboard(targetDate);
}

async function onMessageFromHTMLView(actionType, data) {
  if (actionType === "reviewTask") {
    if (!data?.id || !["addToday", "ignore"].includes(data?.decision)) throw new Error("Invalid review decision.");
    await request(`/api/reviews/${encodeURIComponent(data.id)}`, { method: "POST", body: JSON.stringify({ decision: data.decision, scheduledFor: null, waitingOn: null, followUpDate: null }) });
    return;
  }
  if (actionType === "waitingTask") {
    if (!data?.id || !String(data.waitingOn || "").trim() || !validDateString(data.followUpDate)) throw new Error("Waiting tasks need a dependency and follow-up date.");
    await request(`/api/reviews/${encodeURIComponent(data.id)}`, { method: "POST", body: JSON.stringify({ decision: "waiting", scheduledFor: null, waitingOn: String(data.waitingOn).trim(), followUpDate: data.followUpDate }) });
    return;
  }
  if (actionType === "completeTask") {
    if (!data?.id) throw new Error("Invalid task completion.");
    await request(`/api/tasks/${encodeURIComponent(data.id)}`, { method: "POST", body: JSON.stringify({ completed: true }) });
    removeDashboardTask(data.id);
    return;
  }
  if (actionType === "updateTask") {
    const title = String(data?.title || "").trim();
    if (!data?.id || !title) throw new Error("Task wording is required.");
    await request(`/api/tasks/${encodeURIComponent(data.id)}`, { method: "POST", body: JSON.stringify({ title }) });
    updateDashboardTaskTitle(data.id, title);
    return;
  }
  if (actionType === "projectStatus") {
    if (!String(data?.name || "").trim() || !["active", "later", "inactive"].includes(data?.status)) throw new Error("Invalid project response.");
    await request("/api/projects", { method: "POST", body: JSON.stringify({ name: String(data.name).trim(), status: data.status }) });
    return;
  }
  if (actionType === "saveDashboardFeedback") {
    const type = ["idea", "task", "correction", "blocker"].includes(data?.type) ? data.type : "correction";
    const text = String(data?.text || "").trim();
    if (!text) throw new Error("Feedback text is required.");
    saveDashboardFeedbackEntry(type, text);
    if (serviceConfigured()) {
      if (type === "idea" || type === "task") await request("/api/ideas", { method: "POST", body: JSON.stringify({ text }) });
      else await request("/api/check-ins", { method: "POST", body: JSON.stringify({ question: `Dashboard ${type}`, answer: text }) });
    } else {
      const pilot = loadPilotReview();
      if (pilot) {
        pilot.feedback ??= { corrections: {}, events: [], ideas: [] };
        pilot.feedback.events ??= [];
        pilot.feedback.events.unshift({ type: `dashboard-${type}`, answer: text, createdAt: new Date().toISOString() });
        DataStore.saveJSON(pilot, PILOT_FILENAME);
      }
    }
    return;
  }
  const start = Number(data?.start);
  const end = Number(data?.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 540 || end > 1020 || end - start < 20) throw new Error("Focus blocks must stay between 9:00 AM and 5:00 PM and be at least 20 minutes.");
  if (!validDateString(data?.date)) throw new Error("Invalid focus block date.");
  if (actionType === "saveFocusBlock") {
    if (!data?.id) throw new Error("Invalid focus block update.");
    saveDashboardBlock(data.date, { id: data.id, start, end });
    return;
  }
  if (actionType === "scheduleTask") {
    if (!data?.task?.id || !data.task.title) throw new Error("Invalid scheduled task.");
    if (serviceConfigured()) {
      await request(`/api/reviews/${encodeURIComponent(data.task.id)}`, { method: "POST", body: JSON.stringify({ decision: "schedule", scheduledFor: data.date, waitingOn: null, followUpDate: null }) });
      await request(`/api/generate?date=${data.date}`, { method: "POST" });
    } else {
      const pilot = loadPilotReview();
      if (pilot) {
        pilot.decisions ??= {};
        pilot.decisions[data.task.id] = "schedule";
        pilot.feedback ??= { corrections: {}, events: [], ideas: [] };
        pilot.feedback.schedules ??= {};
        pilot.feedback.schedules[data.task.id] = data.date;
        DataStore.saveJSON(pilot, PILOT_FILENAME);
      }
    }
    createDashboardBlock(data.date, data.task, start, end);
  }
}

async function assistantRefreshDashboard(targetDate = localDate()) {
  try {
    const selectedDate = normalizeDate(targetDate);
    if (!serviceConfigured()) {
      await CommandBar.prompt("Live Gmail Setup Required", "The Google Cloud service has not been deployed yet, so Gmail cannot be connected or refreshed. The dashboard is still using verified pilot data.", ["OK"]);
      return;
    }
    await syncNotePlanTasks();
    await request(`/api/generate?date=${selectedDate}`, { method: "POST" });
    await assistantDashboard(selectedDate);
  } catch (error) {
    await CommandBar.prompt("Check Gmail & Calendar", error.message, ["OK"]);
  }
}

async function assistantScanOlderEmail() {
  try {
    if (!serviceConfigured()) {
      await CommandBar.prompt("Scan Older Email", "Live Gmail must be connected before older email can be reviewed.", ["OK"]);
      return;
    }
    const decision = await CommandBar.prompt("Scan Older Email", "Check the next 25 older work-email threads? Any possible actions will remain in Email Task Review until you approve them.", ["Scan", "Cancel"]);
    if (decision !== "Scan") return;
    const result = await request("/api/gmail/backlog", { method: "POST" });
    await request(`/api/generate?date=${localDate()}`, { method: "POST" });
    const message = result.complete
      ? `Checked ${result.threadsChecked} threads (${result.scannedThreads} total) and found ${result.suggestionsAdded} suggestions. The full one-year email scan is complete.`
      : `Checked ${result.threadsChecked} threads (${result.scannedThreads} total) and found ${result.suggestionsAdded} suggestions. More email remains to scan.`;
    await CommandBar.prompt("Older Email Checked", message, ["Open Dashboard"]);
    await assistantDashboard(localDate());
  } catch (error) {
    await CommandBar.prompt("Scan Older Email", error.message, ["OK"]);
  }
}

async function assistantScheduleTasks() {
  try {
    if (serviceConfigured()) {
      await CommandBar.prompt("Schedule Tasks", "Live cloud scheduling will use the review workflow. No local dates were changed.", ["OK"]);
      return;
    }
    const pilot = loadPilotReview();
    const plan = await currentPlan();
    if (!plan.scheduled.length) {
      await CommandBar.prompt("Schedule Tasks", "No tasks are waiting for a schedule date.", ["OK"]);
      return;
    }
    pilot.feedback ??= { corrections: {}, events: [], ideas: [] };
    pilot.feedback.schedules ??= {};
    for (const task of plan.scheduled) {
      const date = await CommandBar.showInput(`Schedule: ${task.title}\n\nEnter YYYY-MM-DD, or leave blank to keep it unscheduled.`, "Save Date");
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) pilot.feedback.schedules[task.id] = date;
    }
    DataStore.saveJSON(pilot, PILOT_FILENAME);
    await updateDailyNote(await currentPlan());
  } catch (error) {
    await CommandBar.prompt("Schedule Tasks", error.message, ["OK"]);
  }
}

async function assistantReviewWaiting() {
  try {
    if (serviceConfigured()) {
      await CommandBar.prompt("Review Waiting", "Live waiting-item review will be enabled with the cloud service. No items were changed.", ["OK"]);
      return;
    }
    const pilot = loadPilotReview();
    const plan = await currentPlan();
    if (!plan.waiting.length) {
      await CommandBar.prompt("Review Waiting", "No items are currently waiting.", ["OK"]);
      return;
    }
    pilot.feedback ??= { corrections: {}, events: [], ideas: [] };
    pilot.feedback.waitingDates ??= {};
    for (const task of plan.waiting) {
      const answer = await CommandBar.prompt("Waiting Item", `${task.title}\n\n${task.waitingOn || "External dependency"}`, ["Still Waiting", "Add Today", "Set Follow-Up", "Handled", "Stop"]);
      if (!answer || answer === "Stop") break;
      if (answer === "Add Today") pilot.decisions[task.id] = "addToday";
      if (answer === "Handled") pilot.decisions[task.id] = "ignore";
      if (answer === "Set Follow-Up") {
        const date = await CommandBar.showInput("Enter the follow-up date as YYYY-MM-DD", "Save Date");
        if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) pilot.feedback.waitingDates[task.id] = date;
      }
    }
    DataStore.saveJSON(pilot, PILOT_FILENAME);
    await updateDailyNote(await currentPlan());
  } catch (error) {
    await CommandBar.prompt("Review Waiting", error.message, ["OK"]);
  }
}

async function assistantReview() {
  try {
    if (!serviceConfigured()) {
      const pilot = loadPilotReview();
      const plan = pilot ? pilotPlanFromTransfer(pilot) : null;
      if (!plan?.review.length) return CommandBar.prompt("Email Task Review", "Your imported pilot review is complete. New Gmail suggestions will appear after the cloud service is connected.", ["OK"]);
      return CommandBar.prompt("Email Task Review", "Finish any remaining pilot decisions in the browser, then transfer again. Future reviews happen only here in NotePlan.", ["OK"]);
    }
    const plan = await request(`/api/today?date=${localDate()}`);
    if (!plan || !plan.review.length) return CommandBar.prompt("Email Task Review", "No suggestions are waiting for review.", ["OK"]);
    for (const originalTask of plan.review) {
      let task = originalTask;
      while (true) {
        const answer = await CommandBar.prompt("Email Task Review", `${task.title}\n\n${task.project || "No project"}${task.urgencyReason ? `\n${task.urgencyReason}` : ""}`, ["Add today", "Schedule", "Waiting", "Correct wording", "Already handled", "Ignore", "Stop"]);
        if (answer === "Stop" || !answer) return assistantToday();
        if (answer === "Correct wording") {
          const title = await CommandBar.showInput("Enter the corrected task wording", "Save correction");
          if (!title?.trim()) continue;
          task = await request(`/api/reviews/${encodeURIComponent(task.id)}/correct`, { method: "POST", body: JSON.stringify({ title: title.trim() }) });
          continue;
        }
        let scheduledFor = null;
        let waitingOn = null;
        let followUpDate = null;
        if (answer === "Schedule") {
          scheduledFor = await CommandBar.showInput("When should this become active? Enter YYYY-MM-DD.", "Schedule");
          if (!validDateString(scheduledFor)) {
            await CommandBar.prompt("Schedule Task", "No valid date was saved. This item remains in Email Task Review.", ["OK"]);
            continue;
          }
        }
        if (answer === "Waiting") {
          waitingOn = await CommandBar.showInput("Who or what are you waiting on?", "Continue");
          if (!waitingOn?.trim()) {
            await CommandBar.prompt("Waiting Task", "No dependency was saved. This item remains in Email Task Review.", ["OK"]);
            continue;
          }
          followUpDate = await CommandBar.showInput("When should this return for follow-up? Enter YYYY-MM-DD.", "Set Follow-Up");
          if (!validDateString(followUpDate)) {
            await CommandBar.prompt("Waiting Task", "No valid follow-up date was saved. This item remains in Email Task Review.", ["OK"]);
            continue;
          }
        }
        const decisions = { "Add today": "addToday", Schedule: "schedule", Waiting: "waiting", "Already handled": "ignore", Ignore: "ignore" };
        await request(`/api/reviews/${encodeURIComponent(task.id)}`, { method: "POST", body: JSON.stringify({ decision: decisions[answer], scheduledFor, waitingOn, followUpDate }) });
        break;
      }
    }
    await request(`/api/generate?date=${localDate()}`, { method: "POST" });
    await assistantToday();
  } catch (error) {
    await CommandBar.prompt("Email Task Review", error.message, ["OK"]);
  }
}

async function assistantIdea() {
  try {
    const text = await CommandBar.showInput("What idea do you want me to remember?", "Capture");
    if (!text) return;
    if (!serviceConfigured()) {
      const pilot = loadPilotReview() || { version: 1, tasks: [], decisions: {}, feedback: { corrections: {}, events: [], ideas: [] } };
      const idea = { id: `noteplan-idea-${Date.now()}`, text, answers: [], createdAt: new Date().toISOString() };
      const answer = await CommandBar.showInput(nextIdeaQuestion(0), "Save");
      if (answer) idea.answers.push(answer);
      pilot.feedback ??= { corrections: {}, events: [], ideas: [] };
      pilot.feedback.ideas ??= [];
      pilot.feedback.ideas.unshift(idea);
      DataStore.saveJSON(pilot, PILOT_FILENAME);
      await updateDailyNote(pilotPlanFromTransfer(pilot, collectOpenTasks()));
      if (answer) await CommandBar.prompt("Idea Saved", `Saved. Next time I’ll ask: ${nextIdeaQuestion(1)}`, ["OK"]);
      return;
    }
    const result = await request("/api/ideas", { method: "POST", body: JSON.stringify({ text }) });
    const answer = await CommandBar.showInput(result.question, "Save");
    if (answer) {
      const updated = await request(`/api/ideas/${encodeURIComponent(result.ideaId)}/answers`, { method: "POST", body: JSON.stringify({ answer }) });
      if (updated.nextQuestion) await CommandBar.prompt("Idea Saved", `Saved. Next time I’ll ask: ${updated.nextQuestion}`, ["OK"]);
    }
  } catch (error) {
    await CommandBar.prompt("Capture Idea", error.message, ["OK"]);
  }
}

async function assistantImportPilotReview(encodedReview = "") {
  try {
    const encoded = encodedReview || await CommandBar.showInput("Paste the pilot transfer code", "Import");
    if (!encoded) return;
    const payload = JSON.parse(decodeBase64Utf8(encoded));
    if (payload.version !== 1 || !Array.isArray(payload.tasks)) throw new Error("This pilot transfer code is invalid.");
    DataStore.saveJSON(payload, PILOT_FILENAME);
    await updateDailyNote(pilotPlanFromTransfer(payload, collectOpenTasks()));
    await CommandBar.prompt("Pilot Imported", "Your completed review is now stored in NotePlan. Future review and idea work happens here.", ["OK"]);
  } catch (error) {
    await CommandBar.prompt("Pilot Import", error.message, ["OK"]);
  }
}

async function assistantCheckIn() {
  try {
    let question = "What would make work easier to start right now?";
    if (serviceConfigured()) {
      const plan = await request(`/api/today?date=${localDate()}`);
      question = plan?.checkInQuestion || question;
    }
    const answer = await CommandBar.showInput(question, "Save");
    if (!answer) return;
    if (serviceConfigured()) {
      await request("/api/check-ins", { method: "POST", body: JSON.stringify({ question, answer }) });
      return;
    }
    const pilot = loadPilotReview() || { version: 1, tasks: [], decisions: {}, feedback: { corrections: {}, events: [], ideas: [] } };
    pilot.feedback ??= { corrections: {}, events: [], ideas: [] };
    pilot.feedback.events ??= [];
    pilot.feedback.events.unshift({ type: "check-in", question, answer, createdAt: new Date().toISOString() });
    DataStore.saveJSON(pilot, PILOT_FILENAME);
    await CommandBar.prompt("Assistant Check-in", "Saved in NotePlan's synced assistant data.", ["OK"]);
  } catch (error) {
    await CommandBar.prompt("Assistant Check-in", error.message, ["OK"]);
  }
}

async function assistantPause() {
  try {
    if (!serviceConfigured()) {
      await CommandBar.prompt("Scheduled Delivery", "The local NotePlan assistant has no scheduled cloud delivery to pause yet.", ["OK"]);
      return;
    }
    const status = await request("/api/status");
    const next = await CommandBar.prompt("Scheduled Delivery", status.paused ? "Delivery is paused." : "Delivery is active.", status.paused ? ["Resume", "Cancel"] : ["Pause", "Cancel"]);
    if (next === "Cancel" || !next) return;
    await request("/api/pause", { method: "POST", body: JSON.stringify({ paused: next === "Pause" }) });
  } catch (error) {
    await CommandBar.prompt("Scheduled Delivery", error.message, ["OK"]);
  }
}

async function assistantReconnect() {
  try {
    if (!serviceConfigured()) {
      await CommandBar.prompt("Reconnect Google", "Google connection will be enabled when the Cloud Run service URL and API token are added in NotePlan plugin settings.", ["OK"]);
      return;
    }
    const result = await request("/api/oauth-url");
    await NotePlan.openURL(result.url);
    await CommandBar.prompt("Reconnect Google", "Complete Google authorization in the browser, then run /Assistant: Today.", ["OK"]);
  } catch (error) {
    await CommandBar.prompt("Reconnect Google", error.message, ["OK"]);
  }
}

async function assistantReset() {
  try {
    const note = DataStore.calendarNoteByDateString(localDate(0, true));
    if (note) note.content = replaceAssistantSection(note.content || "", "").trim();
    await assistantToday();
  } catch (error) {
    await CommandBar.prompt("Assistant Reset", error.message, ["OK"]);
  }
}

Object.assign(globalThis, {
  assistantDashboard,
  assistantBuildTimeBlocks,
  assistantScheduleTasks,
  assistantReviewWaiting,
  assistantToday,
  assistantReview,
  assistantIdea,
  assistantCheckIn,
  assistantPause,
  assistantReconnect,
  assistantImportPilotReview,
  assistantReset,
  onMessageFromHTMLView,
  assistantRefreshDashboard,
  assistantScanOlderEmail,
});
