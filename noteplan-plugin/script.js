/* global DataStore, CommandBar, NotePlan, HTMLView, Calendar */

const START_MARKER = "%% work-assistant:start %%";
const END_MARKER = "%% work-assistant:end %%";
const LEGACY_START_MARKER = "<!-- work-assistant:start -->";
const LEGACY_END_MARKER = "<!-- work-assistant:end -->";
const PILOT_FILENAME = "pilot-review.json";
const DASHBOARD_BLOCKS_FILENAME = "dashboard-focus-blocks.json";
const DASHBOARD_FEEDBACK_FILENAME = "dashboard-feedback.json";
const NATIVE_TASK_INDEX_FILENAME = "native-task-index.json";
const MIGRATION_STATE_FILENAME = "migration-state.json";
const NATIVE_TASK_HEADING = "## Work Activation Tasks";
const DASHBOARD_WINDOW_ID = "work-activation-dashboard";
const PLUGIN_VERSION = "0.20.0";

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

function taskObligationKey(task) {
  const normalize = (value) => String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
  const genericActions = new Set(["action", "follow up", "reply", "task", "work"]);
  const action = normalize(task.actionKey);
  const title = normalize(task.title)
    .replace(/^(please )?(check|email|follow up with|follow up|reply to|send|update)\s+/, "")
    .replace(/\b(the|a|an|please|client|email)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${normalize(task.project)}|${genericActions.has(action) ? title : action || title}`;
}

function loadNativeTaskIndex() {
  return DataStore.loadJSON(NATIVE_TASK_INDEX_FILENAME) || { version: 1, tasks: {}, legacyMigrated: false };
}

function saveNativeTaskIndex(value) {
  DataStore.saveJSON(value, NATIVE_TASK_INDEX_FILENAME);
}

function nativeBlockId(taskId, salt = 0) {
  return `w${hash(`${taskId}:${salt}`).padEnd(5, "0").slice(0, 5)}`;
}

function calendarNoteForDate(targetDate) {
  const date = normalizeDate(targetDate);
  const direct = DataStore.calendarNoteByDateString?.(compactDate(date));
  if (direct) return direct;
  return typeof DataStore.calendarNoteByDate === "function" ? DataStore.calendarNoteByDate(dateAtNoon(date)) : null;
}

function noteLines(note) {
  return String(note?.content || "").split("\n");
}

function paragraphTypeForBlock(note, blockId) {
  const paragraph = (note?.paragraphs || []).find((item) => String(item.content || "").includes(`^${blockId}`));
  return paragraph?.type || "open";
}

function nativeTaskLine(task, start = null, end = null, blockId = nativeBlockId(task.id)) {
  const time = Number.isInteger(start) && Number.isInteger(end) ? `${timeLabel(start)} - ${timeLabel(end)} ` : "";
  const source = task.sourceUrl ? ` [email](${task.sourceUrl})` : "";
  const marker = task.done ? "* [x]" : "*";
  return `${marker} ${time}${task.title}${source} #assistant/work ^${blockId}`;
}

function nativeTaskDetails(line) {
  const value = String(line || "");
  const block = value.match(/\^([A-Za-z0-9_-]+)(?=\s|$)/);
  if (!block || !value.includes("#assistant/work")) return null;
  const cleaned = value.replace(/^\s*[-*]\s*(?:\[[ xX-]\]\s*)?/, "").trim();
  const time = cleaned.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\s*[-–]\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s+/i);
  const toMinutes = (hour, minute, suffix) => (Number(hour) % 12) * 60 + Number(minute) + (suffix.toUpperCase() === "PM" ? 720 : 0);
  const start = time ? toMinutes(time[1], time[2], time[3]) : null;
  const end = time ? toMinutes(time[4], time[5], time[6]) : null;
  const title = cleaned
    .replace(time?.[0] || "", "")
    .replace(/\s*\[email\]\([^)]+\)/, "")
    .replace(/\s+#assistant\/work\s+\^[A-Za-z0-9_-]+(?:\s+>\d{4}-\d{2}-\d{2})?\s*$/, "")
    .trim();
  const sourceUrl = cleaned.match(/\[email\]\(([^)]+)\)/)?.[1] || null;
  const completed = /^\s*[-*]\s*\[[xX]\]/.test(value);
  const scheduledDate = value.match(/\s>(\d{4}-\d{2}-\d{2})(?=\s|$)/)?.[1] || null;
  return { blockId: block[1], start, end, title, sourceUrl, completed, scheduledDate };
}

function completedParagraphType(type) {
  return ["done", "cancelled", "canceled"].includes(String(type || "").toLowerCase());
}

function findNativeTask(taskId) {
  const index = loadNativeTaskIndex();
  const entry = index.tasks?.[taskId];
  if (!entry) return null;
  const direct = entry.date ? calendarNoteForDate(entry.date) : null;
  const candidates = [...new Set([direct, ...(DataStore.calendarNotes || [])].filter(Boolean))];
  for (const note of candidates) {
    const lineIndex = noteLines(note).findIndex((line) => line.includes(`^${entry.blockId}`));
    if (lineIndex >= 0) {
      const line = noteLines(note)[lineIndex];
      const details = nativeTaskDetails(line);
      return { taskId, entry, note, lineIndex, line, date: details?.scheduledDate || noteDate(note), originDate: noteDate(note), type: paragraphTypeForBlock(note, entry.blockId) };
    }
  }
  return null;
}

function setNoteLines(note, lines) {
  note.content = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function removeNativeTaskLine(found) {
  const lines = noteLines(found.note);
  lines.splice(found.lineIndex, 1);
  setNoteLines(found.note, lines);
}

function deleteNativeTask(taskId) {
  const found = findNativeTask(taskId);
  if (found) removeNativeTaskLine(found);
  const index = loadNativeTaskIndex();
  if (index.tasks?.[taskId]) {
    delete index.tasks[taskId];
    saveNativeTaskIndex(index);
  }
  return Boolean(found);
}

function appendNativeTaskLine(note, line) {
  const lines = noteLines(note);
  let headingIndex = lines.findIndex((value) => value.trim() === NATIVE_TASK_HEADING);
  if (headingIndex < 0) {
    if (lines.some((value) => value.trim())) lines.push("");
    lines.push(NATIVE_TASK_HEADING);
    headingIndex = lines.length - 1;
  }
  let insertAt = headingIndex + 1;
  while (insertAt < lines.length && !/^##\s/.test(lines[insertAt])) insertAt += 1;
  lines.splice(insertAt, 0, line);
  setNoteLines(note, lines);
}

function upsertNativeTask(task, targetDate, start = null, end = null) {
  const date = normalizeDate(targetDate);
  const note = calendarNoteForDate(date);
  if (!note) throw new Error(`Open or create the ${date} daily note before scheduling this task.`);
  const index = loadNativeTaskIndex();
  const blockId = index.tasks?.[task.id]?.blockId || nativeBlockId(task.id);
  const existing = findNativeTask(task.id);
  if (existing) removeNativeTaskLine(existing);
  appendNativeTaskLine(note, nativeTaskLine(task, start, end, blockId));
  index.tasks ??= {};
  index.tasks[task.id] = {
    blockId,
    date,
    title: task.returnedFromWaiting ? task.title.replace(/^↩\s*/, "") : task.title,
    status: task.status || existing?.entry?.status || "today",
    done: Boolean(task.done),
    sourceUrl: task.sourceUrl || existing?.entry?.sourceUrl || null,
    sourceType: task.sourceType || existing?.entry?.sourceType || "gmail",
    project: task.project || existing?.entry?.project || null,
    returnedFromWaiting: Boolean(task.returnedFromWaiting || existing?.entry?.returnedFromWaiting),
  };
  saveNativeTaskIndex(index);
  return { id: `native-${blockId}`, taskId: task.id, title: task.title, project: task.project || null, start, end, blockId, date };
}

function nativeBlocksForDate(targetDate) {
  const date = normalizeDate(targetDate);
  const note = calendarNoteForDate(date);
  if (!note) return [];
  const index = loadNativeTaskIndex();
  const taskIdByBlock = new Map(Object.entries(index.tasks || {}).map(([taskId, entry]) => [entry.blockId, taskId]));
  return noteLines(note).flatMap((line) => {
    const details = nativeTaskDetails(line);
    if (!details || details.start === null || details.end === null) return [];
    const taskId = taskIdByBlock.get(details.blockId);
    if (!taskId || details.completed || completedParagraphType(paragraphTypeForBlock(note, details.blockId))) return [];
    const entry = index.tasks[taskId];
    return [{ id: `native-${details.blockId}`, taskId, start: details.start, end: details.end, returnedFromWaiting: Boolean(entry.returnedFromWaiting), task: { id: taskId, title: details.title, project: entry.project || null, sourceUrl: details.sourceUrl || entry.sourceUrl || null, returnedFromWaiting: Boolean(entry.returnedFromWaiting) } }];
  });
}

function updateNativeTaskBlock(taskId, targetDate, start, end) {
  const found = findNativeTask(taskId);
  if (!found) throw new Error("The native NotePlan task could not be found.");
  const details = nativeTaskDetails(found.line);
  return upsertNativeTask({ id: taskId, title: details.title, sourceUrl: details.sourceUrl || found.entry.sourceUrl, project: found.entry.project }, targetDate, start, end);
}

function completeNativeTask(taskId) {
  const found = findNativeTask(taskId);
  const index = loadNativeTaskIndex();
  if (found) {
    const lines = noteLines(found.note);
    lines[found.lineIndex] = lines[found.lineIndex].replace(/^\s*\*\s+(?:\[[ xX-]\]\s*)?/, "* [x] ");
    setNoteLines(found.note, lines);
  }
  index.tasks ??= {};
  index.tasks[taskId] = { ...(index.tasks[taskId] || {}), done: true };
  saveNativeTaskIndex(index);
  return Boolean(found);
}

function reopenNativeTask(taskId) {
  const found = findNativeTask(taskId);
  if (!found) return false;
  const lines = noteLines(found.note);
  lines[found.lineIndex] = lines[found.lineIndex].replace(/^\s*\*\s+(?:\[[ xX-]\]\s*)?/, "* ");
  setNoteLines(found.note, lines);
  const index = loadNativeTaskIndex();
  if (index.tasks?.[taskId]) {
    index.tasks[taskId].done = false;
    saveNativeTaskIndex(index);
  }
  return true;
}

function renameNativeTask(taskId, title) {
  const found = findNativeTask(taskId);
  if (!found) return false;
  const details = nativeTaskDetails(found.line);
  const lines = noteLines(found.note);
  lines[found.lineIndex] = nativeTaskLine({ id: taskId, title, sourceUrl: details.sourceUrl || found.entry.sourceUrl }, details.start, details.end, found.entry.blockId);
  setNoteLines(found.note, lines);
  return true;
}

function snapshotNativeTask(taskId) {
  const found = findNativeTask(taskId);
  return found ? { entry: { ...found.entry }, date: found.date, line: found.line } : null;
}

function restoreNativeTask(taskId, snapshot) {
  const current = findNativeTask(taskId);
  if (current) removeNativeTaskLine(current);
  const index = loadNativeTaskIndex();
  index.tasks ??= {};
  if (!snapshot) delete index.tasks[taskId];
  else {
    const note = calendarNoteForDate(snapshot.date);
    if (!note) throw new Error(`Could not restore the ${snapshot.date} NotePlan task after a failed save.`);
    appendNativeTaskLine(note, snapshot.line);
    index.tasks[taskId] = snapshot.entry;
  }
  saveNativeTaskIndex(index);
}

function migrateNativeBlockIds() {
  const index = loadNativeTaskIndex();
  const entries = Object.entries(index.tasks || {});
  const occupied = new Set(entries.map(([, entry]) => entry.blockId).filter((blockId) => /^[a-z0-9]{6}$/i.test(String(blockId || ""))));
  let migrated = 0;
  for (const [taskId, entry] of entries) {
    if (/^[a-z0-9]{6}$/i.test(String(entry.blockId || ""))) continue;
    const found = findNativeTask(taskId);
    if (!found) continue;
    let salt = 0;
    let blockId = nativeBlockId(taskId, salt);
    while (occupied.has(blockId)) blockId = nativeBlockId(taskId, salt += 1);
    const lines = noteLines(found.note);
    lines[found.lineIndex] = lines[found.lineIndex].replace(new RegExp(`\\^${String(entry.blockId).replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?=\\s|$)`), `^${blockId}`);
    setNoteLines(found.note, lines);
    entry.blockId = blockId;
    occupied.add(blockId);
    migrated += 1;
  }
  if (migrated) saveNativeTaskIndex(index);
  return migrated;
}

function deduplicateNativeTaskOccurrences() {
  const index = loadNativeTaskIndex();
  const notes = DataStore.calendarNotes || [];
  let removed = 0;
  for (const [taskId, entry] of Object.entries(index.tasks || {})) {
    const occurrences = [];
    for (const note of notes) {
      noteLines(note).forEach((line, lineIndex) => {
        if (!line.includes(`^${entry.blockId}`)) return;
        const details = nativeTaskDetails(line);
        if (!details) return;
        occurrences.push({ note, line, lineIndex, details, originDate: noteDate(note), effectiveDate: details.scheduledDate || noteDate(note), type: paragraphTypeForBlock(note, entry.blockId) });
      });
    }
    if (occurrences.length <= 1) continue;
    const completed = occurrences.filter((item) => item.details.completed || completedParagraphType(item.type));
    const candidates = completed.length ? completed : occurrences;
    const keep = [...candidates].sort((left, right) => String(right.effectiveDate || "").localeCompare(String(left.effectiveDate || "")) || right.lineIndex - left.lineIndex)[0];
    const removalsByNote = new Map();
    for (const occurrence of occurrences) {
      if (occurrence === keep) continue;
      if (!removalsByNote.has(occurrence.note)) removalsByNote.set(occurrence.note, []);
      removalsByNote.get(occurrence.note).push(occurrence.lineIndex);
      removed += 1;
    }
    for (const [note, lineIndexes] of removalsByNote) {
      const lines = noteLines(note);
      for (const lineIndex of lineIndexes.sort((left, right) => right - left)) lines.splice(lineIndex, 1);
      setNoteLines(note, lines);
    }
    entry.date = keep.effectiveDate;
    entry.title = keep.details.title;
    entry.done = completed.length > 0;
    index.tasks[taskId] = entry;
  }
  if (removed) saveNativeTaskIndex(index);
  return removed;
}

function migrateLegacyDashboardBlocks(plan) {
  const index = loadNativeTaskIndex();
  if (index.legacyMigrated) return { migrated: 0, skipped: 0, complete: true };
  const validTasks = new Map([...(plan.today || []), ...(plan.scheduled || []), ...(plan.waiting || [])].map((task) => [task.id, task]));
  const legacy = loadDashboardBlocks();
  let migrated = 0;
  let skipped = 0;
  let complete = true;
  const latestByTask = new Map();
  for (const [date, blocks] of Object.entries(legacy.dates || {})) {
    for (const block of blocks || []) {
      if (!validTasks.has(block.taskId)) { skipped += 1; continue; }
      const previous = latestByTask.get(block.taskId);
      if (!previous || date > previous.date) latestByTask.set(block.taskId, { ...block, date });
    }
  }
  for (const block of latestByTask.values()) {
    const task = validTasks.get(block.taskId);
    try {
      upsertNativeTask({ ...task, title: block.title || task.title, project: block.project || task.project }, block.date, block.start, block.end);
      migrated += 1;
    } catch (_) {
      complete = false;
    }
  }
  if (complete) {
    const updated = loadNativeTaskIndex();
    updated.legacyMigrated = true;
    updated.legacyMigrationAt = new Date().toISOString();
    updated.legacySkipped = skipped;
    saveNativeTaskIndex(updated);
  }
  return { migrated, skipped, complete };
}

async function carryForwardNativeTasks(targetDate) {
  const date = normalizeDate(targetDate);
  if (date !== localDate() || [0, 6].includes(dateAtNoon(date).getDay())) return { moved: 0, warnings: [] };
  const index = loadNativeTaskIndex();
  let moved = 0;
  const warnings = [];
  for (const [taskId, entry] of Object.entries(index.tasks || {})) {
    if (!entry.date || entry.date >= date || entry.done || !["today", "scheduled"].includes(entry.status || "today")) continue;
    const found = findNativeTask(taskId);
    const details = found && nativeTaskDetails(found.line);
    if (!found || !details || details.completed || completedParagraphType(found.type)) continue;
    if (found.date && found.date >= date) {
      if (entry.date !== found.date) {
        entry.date = found.date;
        saveNativeTaskIndex(index);
      }
      continue;
    }
    const task = { id: taskId, title: details.title, project: entry.project || null, sourceUrl: details.sourceUrl || entry.sourceUrl || null, status: entry.status || "today" };
    const snapshot = snapshotNativeTask(taskId);
    try {
      upsertNativeTask({ ...task, status: "scheduled" }, date);
      if (serviceConfigured()) await request(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "POST", body: JSON.stringify({ scheduledFor: date }) });
      moved += 1;
    } catch (error) {
      restoreNativeTask(taskId, snapshot);
      warnings.push(`Could not carry forward “${details.title}”: ${error.message}`);
    }
  }
  return { moved, warnings };
}

function applyTerminalTaskStates(taskStates) {
  const terminal = (taskStates || []).filter((task) => task.status === "ignored" || task.status === "done" || task.reviewDecision === "ignore" || task.reviewDecision === "complete");
  const index = loadNativeTaskIndex();
  let changed = false;
  for (const task of terminal) {
    if (!index.tasks?.[task.id]) continue;
    if (task.status === "ignored" || task.reviewDecision === "ignore") {
      deleteNativeTask(task.id);
      changed = true;
    } else if (!index.tasks[task.id].done) {
      completeNativeTask(task.id);
      changed = true;
    }
  }
  return changed;
}

function filterPlanByTaskStates(plan, taskStates) {
  if (!(taskStates || []).length) return plan;
  const byId = new Map(taskStates.map((task) => [task.id, task]));
  const terminal = taskStates.filter((task) => task.status === "ignored" || task.status === "done" || task.reviewDecision === "ignore" || task.reviewDecision === "complete");
  const terminalBySource = new Map(terminal.map((task) => [task.sourceId, task]));
  const terminalByObligation = new Map(terminal.map((task) => [taskObligationKey(task), task]));
  const review = (plan.review || []).filter((task) => {
    const state = byId.get(task.id);
    if (state && state.status !== "review") return false;
    const decided = terminalBySource.get(task.sourceId) || terminalByObligation.get(taskObligationKey(task));
    return !decided || Boolean(task.emailLastActivityAt && decided.reviewedAt && task.emailLastActivityAt > decided.reviewedAt);
  });
  const waiting = (plan.waiting || []).filter((task) => !byId.has(task.id) || byId.get(task.id).status === "waiting");
  return { ...plan, review, waiting };
}

function nativeTaskCollections(selectedDate) {
  const index = loadNativeTaskIndex();
  const today = [];
  const later = [];
  const focusBlocks = [];
  const warnings = [];
  for (const [taskId, entry] of Object.entries(index.tasks || {})) {
    const found = findNativeTask(taskId);
    if (!found) {
      if (!entry.done) warnings.push(`A managed task is missing from NotePlan: ${entry.title || taskId}.`);
      continue;
    }
    const details = nativeTaskDetails(found.line);
    if (!details) {
      warnings.push(`A managed NotePlan task could not be read: ${entry.title || taskId}.`);
      continue;
    }
    if (details.completed || completedParagraphType(found.type) || entry.done) continue;
    const task = {
      id: taskId,
      title: details.title,
      project: entry.project || null,
      sourceUrl: details.sourceUrl || entry.sourceUrl || null,
      sourceType: entry.sourceType || "gmail",
      status: "scheduled",
      scheduledFor: found.date,
      returnedFromWaiting: Boolean(entry.returnedFromWaiting),
    };
    if (found.date === selectedDate && details.start !== null && details.end !== null) {
      focusBlocks.push({ id: `native-${details.blockId}`, taskId, start: details.start, end: details.end, returnedFromWaiting: task.returnedFromWaiting, task });
    } else if (found.date === selectedDate) today.push({ ...task, status: "today" });
    else if (found.date && found.date > selectedDate) later.push(task);
  }
  focusBlocks.sort((left, right) => left.start - right.start);
  later.sort((left, right) => String(left.scheduledFor).localeCompare(String(right.scheduledFor)) || left.title.localeCompare(right.title));
  return { today, later, focusBlocks, warnings };
}

async function reconcileNativeTasks() {
  if (!serviceConfigured()) return { changed: false, warnings: [] };
  const index = loadNativeTaskIndex();
  let changed = false;
  const warnings = [];
  for (const [taskId, entry] of Object.entries(index.tasks || {})) {
    const found = findNativeTask(taskId);
    if (!found) {
      warnings.push(`A managed NotePlan task could not be found for ${entry.title || taskId}.`);
      continue;
    }
    const details = nativeTaskDetails(found.line);
    if (!details) continue;
    const completed = details.completed || completedParagraphType(found.type);
    const update = {};
    const syncedTitle = entry.returnedFromWaiting ? details.title.replace(/^↩\s*/, "") : details.title;
    if (syncedTitle && syncedTitle !== entry.title) update.title = syncedTitle;
    if (found.date && found.date !== entry.date) update.scheduledFor = found.date;
    if (completed && !entry.done) update.completed = true;
    if (!Object.keys(update).length) continue;
    try {
      await request(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "POST", body: JSON.stringify(update) });
      entry.title = syncedTitle;
      entry.date = found.date || entry.date;
      entry.done = completed;
      changed = true;
    } catch (error) {
      warnings.push(`NotePlan change for “${details.title}” is not synced yet: ${error.message}`);
    }
  }
  if (changed) saveNativeTaskIndex(index);
  return { changed, warnings };
}

async function request(path, options = {}) {
  const config = settings();
  const response = await fetch(`${config.serviceUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiToken}`, ...(options.headers || {}) },
  });
  if (response === undefined || response === null) throw new Error("The cloud service did not return a response. Try opening the dashboard again; use Refresh Gmail & Calendar only when you want a new scan.");
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
  const dashboardUrl = commandUrl("Assistant: Dashboard");
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

function dashboardTask(task, completable = true, schedulable = false, selectedDate = localDate()) {
  const origin = task.returnedFromWaiting ? "↩ Returned reply" : task.sourceType === "gmail" ? "Email" : task.sourceType === "noteplan" ? "NotePlan" : "Added in dashboard";
  const context = [origin, task.project, task.waitingOn ? `Waiting: ${task.waitingOn}` : null, task.waitingResponseReceivedAt ? `Response received ${task.waitingResponseReceivedAt.slice(0, 10)}` : null, task.followUpDate ? `Follow up ${task.followUpDate}` : null, task.scheduledFor ? `Scheduled ${task.scheduledFor}` : task.scheduledFor === null ? "Needs a date" : null, task.dueDate ? `Due ${task.dueDate}` : null].filter(Boolean).join(" · ");
  const check = completable ? `<a class="check complete-task" style="display:block" href="${escapeHtml(commandUrl("Assistant: Complete Task", [task.id, selectedDate]))}" title="Mark complete" aria-label="Mark ${escapeHtml(task.title)} complete"></a>` : '<span class="check"></span>';
  const native = findNativeTask(task.id);
  const nativeLink = native ? `<a class="text-action" href="${escapeHtml(nativeTaskUrl(task.id))}">Open in NotePlan ↗</a>` : "";
  const ignore = completable ? `<a class="text-action" href="${escapeHtml(commandUrl("Assistant: Review Email Tasks", [task.id, "ignore", selectedDate]))}">Ignore</a>` : "";
  return `<article data-task-card="${escapeHtml(task.id)}"><div class="task">${check}<div><strong class="task-title">${escapeHtml(task.title)}</strong>${context ? `<small>${escapeHtml(context)}</small>` : ""}<button class="text-action edit-task" type="button" data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}">Edit</button>${ignore}${nativeLink}</div>${task.sourceUrl ? `<a class="source" href="${escapeHtml(task.sourceUrl)}">Source ↗</a>` : ""}</div>${schedulable ? scheduleDragHandle(task) : ""}</article>`;
}

function reviewDashboardTask(task, selectedDate = localDate()) {
  const received = emailReceivedLabel(task.emailReceivedAt, task.emailLastActivityAt);
  const context = [task.project, task.dueDate ? `Due ${task.dueDate}` : null, task.urgencyReason].filter(Boolean).join(" · ");
  const direct = (decision, label, className = "") => decision === "addToday"
    ? `<a class="direct-review ${className}" style="display:inline-block;border:1px solid #b7d1d1;background:${className ? "#fff" : "#edf7f6"};color:${className ? "#68777a" : "#245e63"};border-radius:8px;padding:7px 10px;font-size:11px;font-weight:800" href="${escapeHtml(commandUrl("Assistant: Review Email Tasks", [task.id, decision, selectedDate]))}">${label}</a>`
    : `<button class="direct-review ${className}" type="button" data-direct-decision="${decision}" data-task-id="${escapeHtml(task.id)}">${label}</button>`;
  return `<article class="review-card" data-review-card="${escapeHtml(task.id)}"><div class="review-copy"><label class="group-select"><input type="checkbox" data-group-select data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}" data-task-project="${escapeHtml(task.project || "")}"> Group</label><strong>${escapeHtml(task.title)}</strong><small class="received-date">${escapeHtml(received)}</small>${context ? `<small>${escapeHtml(context)}</small>` : ""}${task.sourceUrl ? `<a class="source" href="${escapeHtml(task.sourceUrl)}">Open email ↗</a>` : ""}</div>${scheduleDragHandle(task)}<div class="review-actions">${direct("addToday", "Today")}<button type="button" data-review="schedule" data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}" data-task-project="${escapeHtml(task.project || "")}" data-task-source-url="${escapeHtml(task.sourceUrl || "")}">Other date…</button><button type="button" data-review="waiting" data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}" data-task-project="${escapeHtml(task.project || "")}" data-task-source-url="${escapeHtml(task.sourceUrl || "")}">Waiting</button>${direct("complete", "Completed")}<button type="button" data-review="edit" data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}">Edit</button>${direct("ignore", "Ignore", "quiet")}</div></article>`;
}

function reviewGroupingTokens(value) {
  const ignored = new Set(["about", "after", "before", "check", "client", "email", "follow", "from", "have", "into", "need", "please", "reply", "send", "task", "that", "their", "this", "update", "with", "work"]);
  return [...new Set(String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((word) => word.length >= 4 && !ignored.has(word)))];
}

function suggestedReviewGroups(items) {
  const parent = items.map((_, index) => index);
  const root = (index) => parent[index] === index ? index : (parent[index] = root(parent[index]));
  const join = (left, right) => { const leftRoot = root(left); const rightRoot = root(right); if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot; };
  const genericProjects = new Set(["", "client", "general", "inbox", "other", "unknown"]);
  const normalizedProject = (task) => String(task.project || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokenSets = items.map((task) => new Set(reviewGroupingTokens(task.title)));
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const sameThread = Boolean(items[left].sourceId && items[left].sourceId === items[right].sourceId);
      const leftProject = normalizedProject(items[left]);
      const rightProject = normalizedProject(items[right]);
      const sameProject = leftProject === rightProject && !genericProjects.has(leftProject);
      const sharedWords = [...tokenSets[left]].filter((word) => tokenSets[right].has(word));
      const contentOnly = genericProjects.has(leftProject) && genericProjects.has(rightProject) && sharedWords.length >= 2;
      if (sameThread || sameProject || contentOnly) join(left, right);
    }
  }
  const components = new Map();
  items.forEach((task, index) => {
    const key = root(index);
    if (!components.has(key)) components.set(key, []);
    components.get(key).push(task);
  });
  return [...components.values()].filter((group) => group.length >= 2).map((group) => {
    const projects = [...new Set(group.map((task) => task.project).filter(Boolean))];
    const commonTokens = reviewGroupingTokens(group[0].title).filter((word) => group.every((task) => reviewGroupingTokens(task.title).includes(word)));
    const label = projects.length === 1 ? projects[0] : commonTokens.length ? commonTokens.slice(0, 2).join(" + ") : "Related email work";
    const ids = group.map((task) => task.id).sort();
    return { id: `suggested-${hash(ids.join("|"))}`, label, ids };
  }).sort((left, right) => right.ids.length - left.ids.length || left.label.localeCompare(right.label)).slice(0, 6);
}

function emailReceivedLabel(receivedAt, activityAt) {
  const received = receivedAt ? new Date(receivedAt) : null;
  const activity = activityAt ? new Date(activityAt) : null;
  const validReceived = received && !Number.isNaN(received.getTime()) ? received : null;
  const validActivity = activity && !Number.isNaN(activity.getTime()) ? activity : null;
  const format = (date) => new Intl.DateTimeFormat("en-CA", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
  if (validActivity && validReceived && validActivity.getTime() > validReceived.getTime()) return `You sent ${format(validActivity)} · Last received ${format(validReceived)}`;
  if (validReceived) return `Received ${format(validReceived)}`;
  if (validActivity) return `Latest thread activity ${format(validActivity)}`;
  return "Email date unavailable";
}

function scheduleDragHandle(task) {
  return `<div class="schedule-drag" draggable="true" data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}" data-task-project="${escapeHtml(task.project || "")}" data-task-source-url="${escapeHtml(task.sourceUrl || "")}" data-task-status="${escapeHtml(task.status || "review")}" data-task-duration="${taskMinutes(task)}"><span>⠿</span> Drag into the visible schedule</div>`;
}

function nativeTaskUrl(taskId) {
  const found = findNativeTask(taskId);
  if (!found) return commandUrl("Assistant: Dashboard");
  const start = Math.max(0, String(found.note.content || "").indexOf(found.line));
  return `noteplan://x-callback-url/openNote?noteDate=${compactDate(found.originDate || found.date)}&highlightStart=${start}&highlightLength=${found.line.length}`;
}

function scheduledDashboardTask(task) {
  const context = [task.project, task.scheduledFor ? `Currently ${task.scheduledFor}` : "Choose a date and time"].filter(Boolean).join(" · ");
  return `<article class="scheduled-card" data-scheduled-card><div class="task"><span class="calendar-icon">+</span><span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(context)}</small></span><button class="text-action choose-schedule" type="button" data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}" data-task-project="${escapeHtml(task.project || "")}" data-scheduled-for="${escapeHtml(task.scheduledFor || "")}">Other date…</button></div>${scheduleDragHandle(task)}</article>`;
}

function dashboardSection(title, items, empty, tone = "aqua", schedulable = false, selectedDate = localDate()) {
  return `<section class="panel ${tone}"><div class="panel-head"><h2>${escapeHtml(title)}</h2><span>${items.length}</span></div>${items.length ? items.map((item) => dashboardTask(item, true, schedulable, selectedDate)).join("") : `<p class="empty">${escapeHtml(empty)}</p>`}</section>`;
}

function waitingDashboardSection(items) {
  if (!items.length) return `<section class="panel amber"><div class="panel-head"><h2>⏳ Waiting Review</h2><span>0</span></div><p class="empty">Nothing is waiting right now.</p></section>`;
  const rows = items.map((task) => `<li><span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml([task.waitingOn ? `Waiting on ${task.waitingOn}` : "Waiting for a response", task.waitingSince ? `since ${task.waitingSince.slice(0, 10)}` : null].filter(Boolean).join(" · "))}</small></span>${task.sourceUrl ? `<a class="source" href="${escapeHtml(task.sourceUrl)}">Email ↗</a>` : ""}</li>`).join("");
  return `<section class="panel amber waiting-review"><div class="panel-head"><h2>⏳ Waiting Review</h2><span>${items.length}</span></div><p class="section-help">These stay together until Gmail detects a new incoming reply.</p><ul>${rows}</ul></section>`;
}

function reviewDashboardSection(items, selectedDate = localDate()) {
  const cutoff = new Date(`${selectedDate}T12:00:00`);
  cutoff.setDate(cutoff.getDate() - 21);
  const recent = items.filter((task) => {
    const date = new Date(task.emailReceivedAt || task.emailLastActivityAt || 0);
    return !Number.isNaN(date.getTime()) && date >= cutoff;
  });
  const backlog = items.filter((task) => !recent.includes(task));
  const visible = recent.length ? recent : items.slice(0, 8);
  const hiddenBacklog = recent.length ? backlog : items.slice(8);
  const suggestions = suggestedReviewGroups(visible);
  const suggested = suggestions.length ? `<style>.suggested-groups{margin:10px 0;padding:11px;border:1px solid #d8cde2;border-radius:11px;background:#f5f0f8}.suggested-groups strong,.suggested-groups small{display:block}.suggested-groups small{margin:3px 0 8px;color:#6d6672;font-size:11px}.suggested-groups div{display:flex;gap:6px;flex-wrap:wrap}.suggested-groups button{border:1px solid #c9b6d7;border-radius:999px;background:#fff;color:#674c78;padding:7px 10px;font-size:11px;font-weight:800;cursor:pointer}.suggested-groups button:hover{background:#e9dff0}</style><div class="suggested-groups"><strong>Suggested related work</strong><small>Choose a group to schedule its email actions as one editable task.</small><div>${suggestions.map((group) => `<button type="button" data-suggested-group data-task-ids="${escapeHtml(JSON.stringify(group.ids))}">${escapeHtml(group.label)} · ${group.ids.length}</button>`).join("")}</div></div>` : "";
  const backlogHtml = hiddenBacklog.length ? `<details class="email-backlog"><summary>Older Email Backlog · ${hiddenBacklog.length}</summary><p class="section-help">Older unresolved email is kept separate so it does not overwhelm today’s review.</p>${hiddenBacklog.map((task) => reviewDashboardTask(task, selectedDate)).join("")}</details>` : "";
  return `<section class="panel review-panel"><div class="panel-head"><h2>Email Task Review</h2><span>${items.length}</span></div><p class="section-help">Newest email actions are shown first. Drag ⠿ into the pinned schedule, choose an action, or combine related items into one task.</p>${suggested}<div class="group-toolbar"><button id="group-schedule" type="button" disabled>Group & Schedule</button><small id="group-count">Select at least 2 items</small></div><div class="review-list">${items.length ? visible.map((task) => reviewDashboardTask(task, selectedDate)).join("") + backlogHtml : '<p class="empty">Every discovered email action has been reviewed.</p>'}</div></section>`;
}

function projectsDashboardSection(projects) {
  const active = projects.filter((project) => project.status === "active");
  const question = projects.find((project) => project.status === "unconfirmed");
  const activeRows = active.length ? active.map((project) => `<li><strong>${escapeHtml(project.name)}</strong><span>${project.openTaskCount} open</span></li>`).join("") : '<li class="empty">No projects confirmed yet.</li>';
  const prompt = question ? `<div class="project-question" data-project-question><p>Is <strong>${escapeHtml(question.name)}</strong> a main project you are currently working on?</p><small>${question.openTaskCount} related open task${question.openTaskCount === 1 ? "" : "s"}</small><div><button data-project-status="active" data-project-name="${escapeHtml(question.name)}">Yes, active</button><button data-project-status="later" data-project-name="${escapeHtml(question.name)}">Later</button><button class="quiet" data-project-status="inactive" data-project-name="${escapeHtml(question.name)}">Not active</button></div></div>` : '<p class="empty">All detected projects have been categorized.</p>';
  return `<section class="projects"><p class="eyebrow">Main Projects</p><ul>${activeRows}</ul>${prompt}</section>`;
}

function ideasDashboardSection(ideas) {
  if (!ideas.length) return "";
  const [current, ...rest] = ideas;
  const question = current.nextQuestion;
  const followUp = question ? `<div class="idea-answer"><label>${escapeHtml(question)}<input id="idea-answer" type="text"></label><button id="idea-answer-save" type="button" data-idea-id="${escapeHtml(current.id)}">Save answer</button><small id="idea-answer-state"></small></div>` : `<small>${escapeHtml(current.nextAction || "Captured")}</small>`;
  const rows = rest.map((idea) => `<article class="idea"><strong>${escapeHtml(idea.text)}</strong><small>${escapeHtml(idea.nextQuestion || idea.nextAction || "Captured")}</small></article>`).join("");
  return `<section class="ideas"><p class="eyebrow">Ideas & Follow-Up</p><article class="idea current"><strong>${escapeHtml(current.text)}</strong>${followUp}</article>${rows}</section>`;
}

function scheduledDashboardSection(items) {
  return `<section class="panel"><div class="panel-head"><h2>Later</h2><span>${items.length}</span></div>${items.length ? items.map(scheduledDashboardTask).join("") : '<p class="empty">Nothing is scheduled for a later workday.</p>'}</section>`;
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

function nextOpenTaskSlot(targetDate, events, duration) {
  const ranges = [...mergeBusyRanges(events), ...nativeTaskCollections(targetDate).focusBlocks.map((block) => ({ start: block.start, end: block.end }))]
    .sort((first, second) => first.start - second.start)
    .reduce((merged, range) => {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
      return merged;
    }, []);
  let cursor = planningStartMinute(targetDate);
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    if (range.start - cursor >= duration) return { start: cursor, end: cursor + duration };
    cursor = Math.max(cursor, range.end);
  }
  return 1020 - cursor >= duration ? { start: cursor, end: cursor + duration } : null;
}

async function placeReturnedWaitingTasks(plan, selectedDate, selectedEvents) {
  const returned = (plan.today || []).filter((task) => task.returnedFromWaiting && !findNativeTask(task.id));
  const placements = new Map();
  const warnings = [];
  for (const task of returned) {
    const duration = Math.min(60, Math.max(30, taskMinutes(task)));
    let date = selectedDate;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const note = calendarNoteForDate(date);
      const events = date === selectedDate ? selectedEvents : await calendarEventsForDate(date);
      const slot = note ? nextOpenTaskSlot(date, events, duration) : null;
      if (slot) {
        const nativeTask = { ...task, title: task.title.startsWith("↩ ") ? task.title : `↩ ${task.title}`, status: "scheduled", returnedFromWaiting: true };
        upsertNativeTask(nativeTask, date, slot.start, slot.end);
        if (serviceConfigured() && task.scheduledFor !== date) await request(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "POST", body: JSON.stringify({ scheduledFor: date }) });
        placements.set(task.id, { date, ...slot });
        break;
      }
      date = moveWorkday(date, 1);
    }
    if (!placements.has(task.id)) warnings.push(`A reply arrived for “${task.title}”, but no available NotePlan workday block could be created yet.`);
  }
  return { placements, warnings };
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
    const returnedClass = block.returnedFromWaiting || block.task.returnedFromWaiting ? " returned-waiting" : "";
    return `<div class="cal-block focus${returnedClass}" tabindex="0" title="${escapeHtml(block.task.title)}" data-block-id="${escapeHtml(block.id)}" data-task-id="${escapeHtml(block.taskId || block.task.id)}" data-task-title="${escapeHtml(block.task.title)}" data-start="${block.start}" data-end="${block.end}" style="top:${top}%;height:${height}%"><b class="block-time">${timeLabel(block.start)}–${timeLabel(block.end)}</b><span class="block-title">${escapeHtml(abbreviatedBlockTitle(block.task.title))}</span><span class="block-tools"><button type="button" class="block-edit" title="Edit block">Edit</button><button type="button" class="block-done" title="Mark complete">✓</button></span><i class="resize-handle" title="Drag to change duration"></i></div>`;
  }).join("");
  const allDay = (plan.calendarEvents || []).filter((event) => event.allDay).map((event) => `<span>${escapeHtml(event.title)}</span>`).join("");
  const now = plan.planningStartMinute;
  const nowLine = plan.date === localDate() && now > 540 && now < 1020 ? `<div class="now-line" style="top:${((now - 540) / 480) * 100}%"><span>Now</span></div>` : "";
  const dragStyles = `<style>.side{position:sticky;top:0;height:100vh;overflow-y:auto}.review-panel{margin-bottom:18px}.waiting-review ul{list-style:none;margin:0;padding:0}.waiting-review li{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-top:1px solid #eee0c5}.waiting-review li:first-child{border-top:0}.waiting-review small{display:block;color:#76654a;margin-top:3px}.cal-block.returned-waiting{background:#e6dcf0;border-color:#8c79a9;color:#5e4773}.group-toolbar{display:flex;align-items:center;gap:9px;margin:10px 0;padding:9px;border-radius:10px;background:#f2f9f8}.group-toolbar button{border:0;border-radius:8px;padding:8px 11px;background:#2e6e72;color:#fff;font-size:11px;font-weight:800;cursor:pointer}.group-toolbar button:disabled{background:#c9d4d2;color:#71807f;cursor:not-allowed}.group-toolbar small{color:#536566}.group-select{display:flex;align-items:center;gap:5px;grid-column:1/-1;color:#536566;font-size:11px;font-weight:800}.group-select input{accent-color:#2e6e72}.schedule-drag{display:flex;align-items:center;gap:7px;margin-top:8px;padding:8px 10px;border:1px dashed #7aa8a8;border-radius:9px;background:#f2f9f8;color:#245e63;font-size:11px;font-weight:800;cursor:grab;user-select:none}.schedule-drag span{font-size:16px;line-height:1}.schedule-drag:active{cursor:grabbing;background:#d8eeee}.scheduled-card{border-top:1px solid #eeeae4;padding-bottom:8px}.scheduled-card:first-of-type{border-top:0}.drop-help{margin:0 0 9px;color:#536566;font-size:11px;line-height:1.4}.calendar-track.drop-ready{outline:2px dashed #2e6e72;outline-offset:3px;background:rgba(216,238,238,.24)}.calendar-track.drop-ready:after{content:"Drop task here";position:absolute;top:6px;right:6px;z-index:10;padding:5px 7px;border-radius:7px;background:#2e6e72;color:#fff;font-size:9px;font-weight:800;pointer-events:none}.calendar-track.drop-full{outline-color:#c84d3c}.calendar-track.drop-full:after{content:"No open slot fits";background:#c84d3c}.cal-block.drop-preview{left:48%;background:#d8eeee;border:2px dashed #2e6e72;color:#245e63;z-index:7;opacity:.92;pointer-events:none}.cal-block.drop-preview .block-title{padding-right:0}@media(max-width:820px){.side{position:static;height:auto;overflow:visible}}</style>`;
  return `${dragStyles}<p class="drop-help"><strong>Schedule visually:</strong> drag a ⠿ task handle here. The preview snaps to the nearest open time.</p>${allDay ? `<div class="all-day"><b>All day</b>${allDay}</div>` : ""}<div class="timeline">${hours}${lines}<div class="calendar-track">${events}${focus}${nowLine}</div></div>`;
}

function dashboardInteractionScript(plan) {
  const busyRanges = (plan.calendarEvents || []).filter((event) => !event.allDay).map((event) => ({
    start: Math.max(540, minuteOfDay(event.start)),
    end: Math.min(1020, minuteOfDay(event.end)),
  })).filter((range) => range.end > range.start);
  return `<script>
    (function () {
      const selectedDate = ${JSON.stringify(plan.date)};
      const serviceUrl = ${JSON.stringify(String(DataStore.settings?.serviceUrl || "").replace(/\/$/, ""))};
      const serviceToken = ${JSON.stringify(String(DataStore.settings?.apiToken || ""))};
      const busyRanges = ${JSON.stringify(busyRanges)};
      const main = document.querySelector(".main");
      const reviewPanel = document.querySelector(".review-panel");
      const heroPanel = document.querySelector(".hero");
      if (main && reviewPanel && heroPanel) main.insertBefore(reviewPanel, heroPanel);
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
      let actionInFlight = false;
      const directServiceRequest = async (path, options = {}) => {
        if (!serviceUrl || !serviceToken) throw new Error('Live service is not connected');
        const response = await fetch(serviceUrl + path, {
          ...options,
          headers: { authorization: 'Bearer ' + serviceToken, 'content-type': 'application/json', ...(options.headers || {}) },
        });
        if (response === undefined || response === null) throw new Error('The cloud service did not return a response');
        if (typeof response === 'string') return JSON.parse(response);
        const value = typeof response.json === 'function' ? await response.json() : response;
        if (response && response.ok === false) throw new Error(value.error || 'Save failed (' + response.status + ')');
        return value;
      };
      const persistDirectReview = async (button) => {
        if (actionInFlight) { saveState.textContent = 'Please wait for the current save…'; return; }
        if (!serviceUrl || !serviceToken) { saveState.textContent = 'Live service is not connected'; return; }
        actionInFlight = true;
        const card = button.closest('[data-review-card]');
        const taskId = button.dataset.taskId;
        const decision = button.dataset.directDecision;
        card.querySelectorAll('button,a').forEach((control) => { control.style.pointerEvents = 'none'; if ('disabled' in control) control.disabled = true; });
        card.style.opacity = '.55';
        saveState.textContent = decision === 'ignore' ? 'Saving Ignore…' : 'Saving completion…';
        try {
          await directServiceRequest('/api/reviews/' + encodeURIComponent(taskId), { method: 'POST', body: JSON.stringify({ decision: decision }) });
          card.remove();
          const remaining = document.querySelectorAll('[data-review-card]').length;
          const count = document.querySelector('.review-panel .panel-head span');
          if (count) count.textContent = String(remaining);
          const list = document.querySelector('.review-list');
          if (list && remaining === 0) list.innerHTML = '<p class="empty">Every discovered email action has been reviewed.</p>';
          saveState.textContent = decision === 'ignore' ? 'Ignored permanently' : 'Marked completed';
        } catch (error) {
          card.style.opacity = '';
          card.querySelectorAll('button,a').forEach((control) => { control.style.pointerEvents = ''; if ('disabled' in control) control.disabled = false; });
          saveState.textContent = 'Could not save — item kept in review';
        } finally {
          actionInFlight = false;
        }
      };
      document.querySelectorAll('[data-direct-decision]').forEach((button) => button.addEventListener('click', () => persistDirectReview(button)));
      const send = (type, data) => {
        if (actionInFlight) { saveState.textContent = 'Please wait for the current save…'; return false; }
        if (typeof NotePlan === 'undefined' || typeof NotePlan.openURL !== 'function') { saveState.textContent = 'Preview mode'; return false; }
        try {
          const payload = JSON.stringify({ type: type, data: data });
          const url = 'noteplan://x-callback-url/runPlugin?pluginID=leslee.WorkActivationAssistant&command=' + encodeURIComponent('Assistant: Apply Dashboard Action') + '&arg0=' + encodeURIComponent(payload);
          actionInFlight = true;
          saveState.textContent = 'Handing off safely to NotePlan…';
          Promise.resolve(NotePlan.openURL(url)).catch((error) => { actionInFlight = false; saveState.textContent = 'Could not hand off — ' + (error.message || String(error)); });
          return true;
        } catch (error) {
          actionInFlight = false;
          saveState.textContent = 'Could not prepare this change';
          return false;
        }
      };
      const scheduleTaskAt = (task, source, date, start, end) => {
        const scheduledTask = { id: task.id, title: task.title, project: task.project || null, sourceUrl: task.sourceUrl || null, status: task.status || null };
        const card = source && (source.closest('[data-review-card]') || source.closest('[data-scheduled-card]'));
        if (!send('scheduleTask', { task: scheduledTask, date: date, dashboardDate: selectedDate, start: start, end: end })) return false;
        if (card) { card.style.opacity = '.55'; card.style.pointerEvents = 'none'; }
        return true;
      };
      const earliestDropMinute = ${Math.max(540, plan.planningStartMinute)};
      const nearestAvailableStart = (requested, duration) => {
        const candidates = [];
        for (let start = earliestDropMinute; start + duration <= 1020; start += 10) {
          if (!calendarConflict(start, start + duration) && workConflicts(start, start + duration, null, null).length === 0) candidates.push(start);
        }
        candidates.sort((first, second) => Math.abs(first - requested) - Math.abs(second - requested) || first - second);
        return candidates.length ? candidates[0] : null;
      };
      let draggedTask = null;
      let dropPreview = null;
      let dropStart = null;
      const clearDrop = () => {
        if (dropPreview) dropPreview.remove();
        dropPreview = null; dropStart = null;
        track.classList.remove('drop-ready', 'drop-full');
      };
      document.querySelectorAll('.schedule-drag').forEach((handle) => {
        handle.addEventListener('dragstart', (event) => {
          draggedTask = { id: handle.dataset.taskId, title: handle.dataset.taskTitle, project: handle.dataset.taskProject, sourceUrl: handle.dataset.taskSourceUrl, status: handle.dataset.taskStatus, duration: Number(handle.dataset.taskDuration), source: handle };
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', draggedTask.id);
          track.classList.add('drop-ready');
          saveState.textContent = 'Drop the task onto an open time in this schedule';
        });
        handle.addEventListener('dragend', () => { clearDrop(); draggedTask = null; });
      });
      track.addEventListener('dragover', (event) => {
        if (!draggedTask) return;
        event.preventDefault();
        const bounds = track.getBoundingClientRect();
        const requested = snap(540 + ((event.clientY - bounds.top) / bounds.height) * 480);
        dropStart = nearestAvailableStart(requested, draggedTask.duration);
        if (!dropPreview) {
          dropPreview = document.createElement('div');
          dropPreview.className = 'cal-block drop-preview';
          dropPreview.innerHTML = '<b class="block-time"></b><span class="block-title"></span>';
          dropPreview.querySelector('.block-title').textContent = draggedTask.title;
          track.appendChild(dropPreview);
        }
        if (dropStart === null) {
          track.classList.add('drop-full');
          dropPreview.style.display = 'none';
          saveState.textContent = 'No open slot fits this task on this workday';
          return;
        }
        track.classList.remove('drop-full');
        dropPreview.style.display = 'block';
        render(dropPreview, dropStart, dropStart + draggedTask.duration);
        saveState.textContent = 'Release to schedule at ' + label(dropStart);
      });
      track.addEventListener('drop', (event) => {
        if (!draggedTask) return;
        event.preventDefault();
        if (dropStart === null) { saveState.textContent = 'No open slot fits this task'; clearDrop(); draggedTask = null; return; }
        const task = draggedTask;
        const start = dropStart;
        clearDrop();
        scheduleTaskAt(task, task.source, selectedDate, start, start + task.duration);
        draggedTask = null;
      });
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
        if (calendarConflict(start, end) || conflicts.length) {
          render(block, interaction.start, interaction.end);
          block.classList.add('invalid');
          setTimeout(() => block.classList.remove('invalid'), 700);
          saveState.textContent = calendarConflict(start, end) ? 'That overlaps a calendar event' : 'Not enough room to move that block there';
        } else {
          saveState.textContent = 'Saving…';
          if (!send('saveFocusBlock', { date: selectedDate, id: block.dataset.blockId, taskId: block.dataset.taskId, start: start, end: end })) render(block, interaction.start, interaction.end);
        }
        interaction = null;
      };
      track.addEventListener('pointerup', finish);
      track.addEventListener('pointercancel', finish);
      track.addEventListener('click', (event) => {
        const done = event.target.closest('.block-done');
        if (done) {
          const block = done.closest('.cal-block.focus');
          if (!send('completeTask', { id: block.dataset.taskId, date: selectedDate })) return;
          done.disabled = true;
          saveState.textContent = 'Saving completion…';
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
      const groupButton = document.getElementById('group-schedule');
      const groupCount = document.getElementById('group-count');
      let schedulingTask = null;
      const selectedGroupItems = () => Array.from(document.querySelectorAll('[data-group-select]:checked'));
      const updateGroupSelection = () => {
        const count = selectedGroupItems().length;
        groupButton.disabled = count < 2;
        groupCount.textContent = count < 2 ? 'Select at least 2 items' : count + ' items selected';
      };
      const openSchedule = (button) => {
        schedulingTask = { id: button.dataset.taskId, title: button.dataset.taskTitle, project: button.dataset.taskProject, sourceUrl: button.dataset.taskSourceUrl, button: button };
        document.getElementById('schedule-task-title').textContent = schedulingTask.title;
        scheduleDate.value = button.dataset.scheduledFor || selectedDate;
        scheduleTime.value = ${JSON.stringify(timeLabel(Math.min(960, Math.max(540, plan.planningStartMinute))).replace(/ (AM|PM)$/, "").split(":").map((part, index) => index ? part : String((Number(part) % 12) + (plan.planningStartMinute >= 720 ? 12 : 0)).padStart(2, "0")).join(":"))};
        scheduleDuration.value = '60';
        scheduleError.textContent = '';
        dialog.showModal();
      };
      document.querySelectorAll('.choose-schedule,[data-review="schedule"]').forEach((button) => button.addEventListener('click', () => openSchedule(button)));
      document.querySelectorAll('[data-group-select]').forEach((checkbox) => checkbox.addEventListener('change', updateGroupSelection));
      document.querySelectorAll('[data-suggested-group]').forEach((button) => button.addEventListener('click', () => {
        const ids = new Set(JSON.parse(button.dataset.taskIds || '[]'));
        document.querySelectorAll('[data-group-select]').forEach((checkbox) => { checkbox.checked = ids.has(checkbox.dataset.taskId); });
        updateGroupSelection();
        groupButton.click();
      }));
      groupButton.addEventListener('click', () => {
        const selected = selectedGroupItems();
        if (selected.length < 2) return;
        const projects = [...new Set(selected.map((item) => item.dataset.taskProject).filter(Boolean))];
        const project = projects.length === 1 ? projects[0] : '';
        schedulingTask = {
          id: 'group-' + Date.now(),
          title: project ? project + ' email follow-ups (' + selected.length + ')' : 'Email follow-ups (' + selected.length + ')',
          project: project,
          groupIds: selected.map((item) => item.dataset.taskId),
          groupCards: selected.map((item) => item.closest('[data-review-card]')),
        };
        document.getElementById('schedule-task-title').textContent = schedulingTask.title;
        scheduleDate.value = selectedDate;
        scheduleTime.value = ${JSON.stringify(timeLabel(Math.min(960, Math.max(540, plan.planningStartMinute))).replace(/ (AM|PM)$/, "").split(":").map((part, index) => index ? part : String((Number(part) % 12) + (plan.planningStartMinute >= 720 ? 12 : 0)).padStart(2, "0")).join(":"))};
        scheduleDuration.value = selected.length >= 4 ? '120' : selected.length === 3 ? '90' : '60';
        scheduleError.textContent = '';
        dialog.showModal();
      });
      document.getElementById('schedule-save').addEventListener('click', (event) => {
        event.preventDefault();
        if (!schedulingTask || !scheduleDate.value || !scheduleTime.value) { scheduleError.textContent = 'Choose both a date and start time.'; return; }
        const parts = scheduleTime.value.split(':').map(Number);
        const start = parts[0] * 60 + parts[1];
        const end = start + Number(scheduleDuration.value);
        if (start < 540 || end > 1020) { scheduleError.textContent = 'Choose a block between 9:00 AM and 5:00 PM.'; return; }
        if (scheduleDate.value === selectedDate && (calendarConflict(start, end) || workConflicts(start, end, null, null).length)) { scheduleError.textContent = 'That time is already occupied. Choose another time.'; return; }
        if (schedulingTask.groupIds) {
          if (!send('groupSchedule', { ids: schedulingTask.groupIds, task: { id: schedulingTask.id, title: schedulingTask.title, project: schedulingTask.project || null }, date: scheduleDate.value, dashboardDate: selectedDate, start: start, end: end })) return;
          schedulingTask.groupCards.forEach((card) => { if (card) { card.style.opacity = '.55'; card.style.pointerEvents = 'none'; } });
          saveState.textContent = 'Saving grouped task in NotePlan…';
        } else {
          scheduleTaskAt(schedulingTask, schedulingTask.button, scheduleDate.value, start, end);
        }
        dialog.close();
      });
      const waitingDialog = document.getElementById('waiting-dialog');
      const waitingOn = document.getElementById('waiting-on');
      const waitingError = document.getElementById('waiting-error');
      let waitingTask = null;
      document.querySelectorAll('[data-review="waiting"]').forEach((button) => button.addEventListener('click', () => {
        waitingTask = { id: button.dataset.taskId, title: button.dataset.taskTitle, project: button.dataset.taskProject || null, sourceUrl: button.dataset.taskSourceUrl || null, card: button.closest('[data-review-card]') };
        document.getElementById('waiting-task-title').textContent = button.dataset.taskTitle;
        waitingOn.value = ''; waitingError.textContent = '';
        waitingDialog.showModal();
      }));
      document.getElementById('waiting-save').addEventListener('click', (event) => {
        event.preventDefault();
        if (!waitingOn.value.trim()) { waitingError.textContent = 'Add who or what you are waiting for.'; return; }
        if (!send('waitingTask', { id: waitingTask.id, task: waitingTask, waitingOn: waitingOn.value.trim(), followUpDate: null, date: selectedDate })) return;
        if (waitingTask.card) { waitingTask.card.style.opacity = '.55'; waitingTask.card.style.pointerEvents = 'none'; }
        waitingDialog.close(); saveState.textContent = 'Saving waiting item…';
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
        if (!send('updateTask', { id: editingTask.id, title: editTitle.value.trim(), date: selectedDate })) return;
        editDialog.close(); saveState.textContent = 'Saving task update…';
      });
      document.querySelectorAll('[data-project-status]').forEach((button) => button.addEventListener('click', () => {
        if (!send('projectStatus', { name: button.dataset.projectName, status: button.dataset.projectStatus, date: selectedDate })) return;
        button.closest('[data-project-question]').querySelectorAll('button').forEach((item) => item.disabled = true);
        saveState.textContent = 'Saving project answer…';
      }));
      document.getElementById('feedback-save').addEventListener('click', () => {
        const input = document.getElementById('feedback-text');
        const type = document.getElementById('feedback-type').value;
        const state = document.getElementById('feedback-state');
        if (!input.value.trim()) { state.textContent = 'Write something first.'; return; }
        if (!send('saveDashboardFeedback', { type: type, text: input.value.trim(), date: selectedDate })) return;
        document.getElementById('feedback-save').disabled = true;
        state.textContent = 'Saving…';
      });
      const ideaAnswerButton = document.getElementById('idea-answer-save');
      if (ideaAnswerButton) ideaAnswerButton.addEventListener('click', () => {
        const input = document.getElementById('idea-answer');
        const state = document.getElementById('idea-answer-state');
        if (!input.value.trim()) { state.textContent = 'Write an answer first.'; return; }
        if (!send('answerIdea', { id: ideaAnswerButton.dataset.ideaId, answer: input.value.trim(), date: selectedDate })) return;
        ideaAnswerButton.disabled = true;
        state.textContent = 'Saving…';
      });
    })();
  </script>`;
}

function dashboardHtml(plan) {
  const capacityHours = `${Math.floor(plan.availableMinutes / 60)}h ${plan.availableMinutes % 60}m`;
  const sourceStatus = `<span class="status">assistant · v${PLUGIN_VERSION}</span>` + plan.sources.map((source) => {
    const checked = source.checkedAt ? new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(source.checkedAt)) : "not checked";
    return `<span class="status"><i></i>${escapeHtml(source.source)} · ${escapeHtml(source.status)}${source.account ? ` · ${escapeHtml(source.account)}` : ""} · ${escapeHtml(checked)}</span>`;
  }).join("");
  const ideas = ideasDashboardSection(plan.ideas || []);
  const noTimeRemains = plan.availableMinutes < 25;
  const heroTitle = noTimeRemains ? "Close the day without forcing another task" : plan.startHere?.title || "Nothing urgent is ready yet";
  const previousDate = moveWorkday(plan.date, -1);
  const nextDate = moveWorkday(plan.date, 1);
  const dateContext = plan.date === localDate() ? `${timeLabel(plan.planningStartMinute)} now · ends 5:00 PM` : plan.date > localDate() ? "Full 9:00 AM–5:00 PM preview" : "Past workday";
  const coverageControl = plan.emailCoverage?.complete ? "" : `<a class="button secondary" href="${commandUrl("Assistant: Scan Older Email")}">Continue Full Email Scan${plan.emailCoverage?.scannedThreads ? ` · ${plan.emailCoverage.scannedThreads} checked` : ""}</a>`;
  const googleControls = serviceConfigured()
    ? `<a class="button refresh" href="${commandUrl("Assistant: Refresh Gmail & Calendar", [plan.date])}">Check Gmail & Calendar Now</a>${coverageControl}<a class="button secondary" href="${commandUrl("Assistant: Reconnect Google")}">Reconnect Google</a><a class="button secondary" href="${commandUrl("Assistant: System Check")}">Run System Check</a>`
    : `<span class="button disabled refresh">Live Gmail setup required</span><a class="button secondary" href="${commandUrl("Assistant: System Check")}">Run System Check</a>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:light;--ink:#233033;--muted:#68777a;--paper:#fbfaf7;--card:#fff;--line:#e6e1d9;--aqua:#d8eeee;--aqua-ink:#155e63;--amber:#f5dfb5;--amber-ink:#815710;--purple:#8c79a9;--shadow:0 18px 50px rgba(55,45,38,.12)}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}a{text-decoration:none;color:inherit}button{font:inherit}.shell{display:grid;grid-template-columns:minmax(0,1.35fr) 390px;min-height:100vh}.main{padding:34px 42px}.side{padding:28px 24px;background:#f5f1eb;border-left:1px solid var(--line)}header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:10px}.eyebrow{margin:0 0 5px;color:var(--purple);font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}h1{margin:0;font-size:34px;letter-spacing:-.04em}h2{margin:0;font-size:17px}.date{color:var(--muted);font-weight:650}.date-nav{display:flex;gap:8px;margin:12px 0 18px}.date-nav a{padding:7px 10px;border:1px solid var(--line);background:#fff;border-radius:8px;color:#536164;font-size:12px;font-weight:700}.date-nav a.today{background:#2e6e72;color:#fff;border-color:#2e6e72}.statuses{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.status{background:#eef4f2;border-radius:999px;padding:7px 10px;font-size:12px;color:#536566}.status i{display:inline-block;width:7px;height:7px;background:#4ca66b;border-radius:50%;margin-right:6px}.hero{background:linear-gradient(135deg,#245e63,#2f767a);color:#fff;border-radius:18px;padding:23px 25px;box-shadow:var(--shadow);margin-bottom:18px}.hero label{display:block;opacity:.72;font-size:11px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}.hero h2{font-size:22px;margin:8px 0 4px}.hero p{margin:0;opacity:.78}.feedback-panel{display:grid;grid-template-columns:150px 1fr auto;gap:10px;align-items:start;background:#f0eeee;border:1px solid #ddd5e7;border-radius:14px;padding:14px;margin-bottom:18px}.feedback-panel select,.feedback-panel textarea{width:100%;border:1px solid #d7d0df;border-radius:9px;background:#fff;padding:9px;font:inherit}.feedback-panel textarea{resize:vertical;min-height:42px}.feedback-panel button{border:0;border-radius:9px;background:var(--purple);color:#fff;padding:10px 13px;font-weight:750}.feedback-state{grid-column:2/-1;color:var(--muted);font-size:11px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}.panel{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 7px 24px rgba(55,45,38,.05)}.review-panel{grid-column:1/-1}.panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.panel-head span{border-radius:999px;background:var(--aqua);color:var(--aqua-ink);font-size:12px;font-weight:800;padding:4px 8px}.amber .panel-head span{background:var(--amber);color:var(--amber-ink)}.section-help{color:var(--muted);font-size:12px;margin:0 0 8px}.task{display:grid;grid-template-columns:18px 1fr auto;gap:10px;align-items:start;padding:12px 0;border-top:1px solid #eeeae4}.task:first-of-type{border-top:0}.task strong{font-size:14px;line-height:1.35}.task small,.idea small,.review-card small{display:block;color:var(--muted);margin-top:4px;line-height:1.35}.scheduled-task{width:100%;border:0;background:transparent;text-align:left;color:inherit;font:inherit;cursor:pointer}.scheduled-task:hover{background:#f7f3ed}.calendar-icon{display:grid;place-items:center;width:17px;height:17px;border-radius:5px;background:var(--aqua);color:var(--aqua-ink);font-weight:900}.check{width:17px;height:17px;border:2px solid #d39532;border-radius:50%;margin-top:2px;background:#fff;cursor:pointer}.check:hover{background:#f5dfb5}.source{color:var(--purple);font-size:11px;font-weight:750;white-space:nowrap}.text-action{border:0;background:transparent;color:var(--purple);padding:4px 6px 4px 0;font-size:11px;font-weight:750;cursor:pointer}.review-list{max-height:620px;overflow:auto;padding-right:4px}.review-card{padding:13px 0;border-top:1px solid #eeeae4}.review-card:first-child{border-top:0}.review-copy{display:grid;grid-template-columns:1fr auto;gap:4px 12px}.review-copy small{grid-column:1}.review-copy .received-date{color:#245e63;font-weight:800}.review-copy .source{grid-column:2;grid-row:1}.review-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.review-actions button,.project-question button{border:1px solid #b7d1d1;background:#edf7f6;color:#245e63;border-radius:8px;padding:7px 10px;font-size:11px;font-weight:800;cursor:pointer}.review-actions button:hover,.project-question button:hover{background:#d8eeee}.review-actions .quiet,.project-question .quiet{background:#fff;color:#68777a;border-color:var(--line)}.projects,.ideas{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:14px}.projects ul{list-style:none;margin:0 0 12px;padding:0}.projects li{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid #eeeae4}.projects li span{color:var(--muted);font-size:11px}.project-question{background:#f0eeee;border-radius:10px;padding:11px}.project-question p{margin:0 0 4px;line-height:1.4}.project-question small{color:var(--muted)}.project-question div{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}.idea-answer{margin-top:8px}.idea-answer label{display:block;color:var(--muted);font-size:11px;line-height:1.35}.idea-answer input{display:block;width:100%;margin:6px 0;padding:8px;border:1px solid var(--line);border-radius:8px}.idea-answer button{border:0;border-radius:8px;background:var(--purple);color:#fff;padding:7px 10px;font-size:11px;font-weight:800}.empty{color:var(--muted);font-style:italic}.metric-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}.metric{background:#fff;border:1px solid var(--line);border-radius:12px;padding:11px}.metric strong{display:block;font-size:19px;letter-spacing:-.03em}.metric span{display:block;color:var(--muted);font-size:10px;margin-top:2px}.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}.button{display:block;padding:10px 11px;text-align:center;border-radius:9px;background:#2e6e72;color:#fff;font-size:12px;font-weight:750}.button.secondary{background:#fff;color:#425356;border:1px solid var(--line)}.button.refresh{grid-column:1/-1;background:#2e6e72}.button.disabled{background:#d6d0c8;color:#746d65;cursor:not-allowed}.idea{padding:12px 0;border-top:1px solid var(--line)}.warning{background:#fff7e6;border:1px solid #efd8a7;color:#76551b;border-radius:12px;padding:12px;line-height:1.4}.backlog{margin-top:15px;color:var(--muted);font-size:13px}.workflow{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:14px}.workflow b{display:block;margin-bottom:5px}.workflow span{display:block;color:var(--muted);font-size:12px;line-height:1.45}.save-state{display:block;color:#2e6e72;font-size:11px;font-weight:750;margin-top:7px}.all-day{display:flex;gap:7px;align-items:center;background:#fff;border:1px solid var(--line);border-radius:9px;padding:8px;margin-bottom:8px;font-size:11px}.all-day span{background:var(--amber);border-radius:6px;padding:4px 6px}.timeline{position:relative;height:510px;margin:8px 0 14px 42px}.hour{position:absolute;left:-42px;width:38px;color:#8b9494;font-size:10px;transform:translateY(-6px)}.hour-line{position:absolute;left:0;right:0;border-top:1px solid #ded9d1}.calendar-track{position:absolute;inset:0;touch-action:none}.cal-block{position:absolute;left:4px;right:3px;border-radius:7px;padding:5px 7px;overflow:hidden;font-size:10px;line-height:1.2;border-left:3px solid}.cal-block b{display:block;font-size:9px;margin-bottom:2px}.cal-block.event{background:#dbe8e8;border-color:#64aeb0;color:#315f62}.cal-block.focus{left:48%;background:#f5dfb5;border-color:#d88a28;color:#714c17;cursor:grab;user-select:none;overflow:hidden;z-index:4}.block-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:48px}.block-tools{position:absolute;top:3px;right:3px;display:flex;gap:2px}.block-tools button{border:0;border-radius:4px;background:rgba(255,255,255,.72);color:#714c17;padding:2px 4px;font-size:8px;font-weight:800;cursor:pointer}.cal-block.focus.editing{cursor:grabbing;box-shadow:0 6px 16px rgba(113,76,23,.25)}.cal-block.focus.invalid{background:#f4c9c2;border-color:#c84d3c}.resize-handle{position:absolute;left:0;right:0;bottom:-2px;height:8px;cursor:ns-resize;border-bottom:3px solid rgba(113,76,23,.45);border-radius:0 0 6px 6px}.now-line{position:absolute;left:0;right:0;border-top:2px solid #d85454;z-index:8;pointer-events:none}.now-line span{position:absolute;right:0;top:-9px;background:#d85454;color:#fff;border-radius:8px;padding:2px 5px;font-size:8px}.calendar-key{display:flex;gap:12px;color:var(--muted);font-size:10px}.calendar-key i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:4px}.key-event{background:#8fc5c6}.key-focus{background:#e4ad57}dialog{border:0;border-radius:16px;padding:0;box-shadow:var(--shadow);width:min(420px,90vw)}dialog::backdrop{background:rgba(35,48,51,.35)}.schedule-form{padding:24px}.schedule-form h2{font-size:20px;margin-bottom:6px}.schedule-form p{color:var(--muted);margin:0 0 18px}.schedule-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.schedule-fields label{font-size:11px;font-weight:800;color:var(--muted)}.schedule-fields input,.schedule-fields select{display:block;width:100%;margin-top:5px;padding:9px;border:1px solid var(--line);border-radius:8px;font:inherit}.schedule-fields .wide{grid-column:1/-1}.schedule-error{min-height:18px;color:#b23a2c;font-size:12px;margin-top:10px}.dialog-actions{display:flex;justify-content:flex-end;gap:8px}.dialog-actions button{border:0;border-radius:8px;padding:9px 13px;font-weight:750}.dialog-actions .save{background:#2e6e72;color:#fff}@media(max-width:820px){.shell{grid-template-columns:1fr}.side{border-left:0;border-top:1px solid var(--line)}.grid{grid-template-columns:1fr}.review-panel{grid-column:1}.feedback-panel{grid-template-columns:1fr}.feedback-state{grid-column:1}}
  </style></head><body><div class="shell"><main class="main"><header><div><p class="eyebrow">Work Activation Assistant</p><h1>${escapeHtml(selectedDateLabel(plan.date))}</h1></div><span class="date">${escapeHtml(dateContext)}</span></header><nav class="date-nav"><a href="${commandUrl("Assistant: View Workday", [previousDate])}">← Previous</a><a class="today" href="${commandUrl("Assistant: Dashboard")}">Today</a><a href="${commandUrl("Assistant: View Workday", [nextDate])}">Next Workday →</a></nav><div class="statuses">${sourceStatus}</div>${plan.warnings.length ? `<p class="warning">⚠ ${escapeHtml(plan.warnings.join(" "))}</p>` : ""}<section class="hero"><label>${noTimeRemains ? "Shutdown Step" : "Start Here"}</label><h2>${escapeHtml(heroTitle)}</h2><p>${escapeHtml(plan.nextInstruction)}</p></section><section class="feedback-panel"><select id="feedback-type"><option value="idea">New idea</option><option value="task">New task</option><option value="correction">Correction</option><option value="blocker">Blocker</option></select><textarea id="feedback-text" placeholder="Anything new or corrected that you want me to remember?"></textarea><button id="feedback-save" type="button">Save Feedback</button><small class="feedback-state" id="feedback-state"></small></section><div class="grid">${dashboardSection("Approved — Not Yet Blocked", plan.today, "Nothing approved is waiting for a time block.", "aqua", true, plan.date)}${waitingDashboardSection(plan.waiting)}${scheduledDashboardSection(plan.scheduled || [])}${reviewDashboardSection(plan.review)}</div><p class="backlog">Unchecked approved tasks automatically remain active on the next workday. Completed and ignored tasks disappear permanently.</p></main><aside class="side"><p class="eyebrow">${plan.date === localDate() ? "Remaining" : "Selected"} 9–5 Plan</p><div class="workflow"><b>Edit your plan here</b><span>Drag blocks to move them, drag the bottom edge to resize, use Edit to change details, or ✓ to complete.</span><small class="save-state" id="save-state">Saved automatically</small></div><div class="metric-row"><div class="metric"><strong>${capacityHours}</strong><span>${plan.date === localDate() ? "remaining" : "available"}</span></div><div class="metric"><strong>${plan.today.length}</strong><span>unblocked</span></div><div class="metric"><strong>${plan.focusBlocks?.length || 0}</strong><span>editable blocks</span></div></div><div class="calendar-key"><span><i class="key-event"></i>Calendar</span><span><i class="key-focus"></i>Editable work block</span></div>${timelineHtml(plan)}<nav class="actions">${googleControls}</nav>${projectsDashboardSection(plan.projects || [])}${ideas}</aside></div><dialog id="schedule-dialog"><form class="schedule-form"><h2>Schedule Task</h2><p id="schedule-task-title"></p><div class="schedule-fields"><label>Date<input id="schedule-date" type="date" required></label><label>Start time<input id="schedule-time" type="time" min="09:00" max="16:30" step="600" required></label><label>Duration<select id="schedule-duration"><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60" selected>1 hour</option><option value="90">1½ hours</option><option value="120">2 hours</option></select></label></div><div class="schedule-error" id="schedule-error"></div><div class="dialog-actions"><button type="button" onclick="document.getElementById('schedule-dialog').close()">Cancel</button><button class="save" id="schedule-save" type="submit">Create Block</button></div></form></dialog><dialog id="waiting-dialog"><form class="schedule-form"><h2>Waiting For</h2><p id="waiting-task-title"></p><div class="schedule-fields"><label class="wide">Who or what?<input id="waiting-on" type="text" required></label></div><p class="section-help">No date is needed. A new incoming reply will automatically return this task to the next available work block.</p><div class="schedule-error" id="waiting-error"></div><div class="dialog-actions"><button type="button" onclick="document.getElementById('waiting-dialog').close()">Cancel</button><button class="save" id="waiting-save" type="submit">Save Waiting</button></div></form></dialog><dialog id="edit-dialog"><form class="schedule-form"><h2>Edit Task</h2><div class="schedule-fields"><label class="wide">Task wording<input id="edit-title" type="text" required></label></div><div class="schedule-error" id="edit-error"></div><div class="dialog-actions"><button type="button" onclick="document.getElementById('edit-dialog').close()">Cancel</button><button class="save" id="edit-save" type="submit">Save</button></div></form></dialog>${dashboardInteractionScript(plan)}</body></html>`;
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
  const groups = { review: [], today: [], waiting: [], scheduled: [], other: [] };
  for (const original of payload.tasks || []) {
    const task = { ...original, title: corrections[original.id]?.title || original.title, sourceType: "gmail" };
    const decision = decisions[task.id];
    if (decision === "ignore") continue;
    if (decision === "addToday") groups.today.push(task);
    else if (decision === "waiting") {
      groups.waiting.push({ ...task, followUpDate: null, waitingOn: task.waitingOn || task.meta || "External dependency" });
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
  const heading = /(^|\n)[^\n]*## Work Activation[ \t]*(?=\n|$)/.exec(content);
  if (heading) {
    const lineStart = heading.index + (heading[1] ? 1 : 0);
    const headingEnd = heading.index + heading[0].length;
    const nextHeading = content.indexOf("\n## ", headingEnd);
    const prefix = content.slice(0, lineStart).trimEnd();
    const suffix = nextHeading >= 0 ? content.slice(nextHeading).trim() : "";
    return [prefix, section, suffix].filter(Boolean).join("\n\n").trim();
  }
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

async function migratePilotReview() {
  const pilot = loadPilotReview();
  if (!pilot) return 0;
  const migration = DataStore.loadJSON(MIGRATION_STATE_FILENAME) || {};
  if (migration.pilotImported) return 0;
  const result = await request("/api/pilot/migrate", { method: "POST", body: JSON.stringify({ tasks: pilot.tasks || [], decisions: pilot.decisions || {} }) });
  DataStore.saveJSON({ ...migration, pilotImported: true, pilotImportedAt: new Date().toISOString(), imported: result.imported || 0 }, MIGRATION_STATE_FILENAME);
  return result.imported || 0;
}

function projectSavedPlanToDate(plan, selectedDate) {
  const unique = new Map();
  for (const group of [plan.review, plan.today, plan.waiting, plan.scheduled, plan.other]) {
    for (const task of group || []) if (task?.id) unique.set(task.id, task);
  }
  const groups = { review: [], today: [], waiting: [], scheduled: [], other: [] };
  for (const task of unique.values()) {
    if (task.status === "review") groups.review.push(task);
    else if (["ignored", "done"].includes(task.status)) continue;
    else if (task.status === "scheduled") (task.scheduledFor && task.scheduledFor <= selectedDate ? groups.today : groups.scheduled).push(task);
    else if (task.status === "waiting") groups.waiting.push(task);
    else if (task.status === "today") groups.today.push(task);
    else groups.other.push(task);
  }
  return {
    ...plan,
    ...groups,
    date: selectedDate,
    calendar: [],
    startHere: groups.today[0] || groups.review[0] || null,
    warnings: [...(plan.warnings || []), `No cloud report was generated for ${selectedDate}; showing the last verified Gmail state with this date's live NotePlan calendar.`],
  };
}

async function savedPlanForDate(selectedDate) {
  const exact = await request(`/api/today?date=${selectedDate}`);
  if (exact) return exact;
  const today = localDate();
  const latest = selectedDate === today ? null : await request(`/api/today?date=${today}`);
  if (!latest) throw new Error("No verified plan is available yet. Run Refresh Gmail & Calendar once to create the initial plan.");
  return projectSavedPlanToDate(latest, selectedDate);
}

async function currentPlan(targetDate = localDate()) {
  const selectedDate = normalizeDate(targetDate);
  let plan;
  let taskStates = [];
  if (serviceConfigured()) {
    await migratePilotReview();
    plan = await savedPlanForDate(selectedDate);
    const projectResult = await request("/api/projects");
    plan.projects = projectResult.projects || [];
    try {
      const taskStateResult = await request("/api/task-state");
      taskStates = taskStateResult.tasks || [];
    } catch (error) {
      taskStates = [];
      plan.warnings = [...(plan.warnings || []), `Task decisions could not be verified: ${error.message}`];
    }
  } else {
    const pilot = loadPilotReview();
    if (!pilot) throw new Error("Import the completed pilot review first.");
    plan = pilotPlanFromTransfer(pilot, collectOpenTasks(), selectedDate);
  }
  plan = filterPlanByTaskStates(plan, taskStates);
  migrateNativeBlockIds();
  const duplicateCount = deduplicateNativeTaskOccurrences();
  applyTerminalTaskStates(taskStates);
  const migration = migrateLegacyDashboardBlocks(plan);
  applyTerminalTaskStates(taskStates);
  const reconciliation = await reconcileNativeTasks();
  const carry = await carryForwardNativeTasks(selectedDate);
  if (serviceConfigured() && (reconciliation.changed || carry.moved)) {
    plan = await savedPlanForDate(selectedDate);
    plan = filterPlanByTaskStates(plan, taskStates);
    const projectResult = await request("/api/projects");
    plan.projects = projectResult.projects || [];
  }
  const calendarEvents = await calendarEventsForDate(selectedDate);
  const returnedPlacement = await placeReturnedWaitingTasks(plan, selectedDate, calendarEvents);
  const startMinute = planningStartMinute(selectedDate);
  const gaps = availableGaps(calendarEvents, startMinute);
  const remainingMinutes = gaps.reduce((total, gap) => total + gap.end - gap.start, 0);
  const nativeState = nativeTaskCollections(selectedDate);
  const focusBlocks = nativeState.focusBlocks;
  const returnedElsewhere = new Set([...returnedPlacement.placements].filter(([, placement]) => placement.date !== selectedDate).map(([taskId]) => taskId));
  const unblockedToday = nativeState.today.filter((task) => !returnedElsewhere.has(task.id));
  const unblockedScheduled = nativeState.later;
  plan.ideas = (plan.ideas || []).map((idea) => ({
    ...idea,
    nextQuestion: nextIdeaQuestion(idea.answers?.length || 0),
    nextAction: idea.answers?.length >= 5 ? idea.answers.at(-1)?.answer || null : null,
  }));
  if (!migration.complete) plan.warnings = [...(plan.warnings || []), "Some legacy dashboard blocks could not yet be moved into native NotePlan tasks."];
  if (duplicateCount) plan.warnings = [...(plan.warnings || []), `${duplicateCount} duplicate native task placement${duplicateCount === 1 ? " was" : "s were"} removed.`];
  const placementMessages = [...returnedPlacement.placements].map(([, placement]) => `↩ A waiting reply was scheduled for ${placement.date} at ${timeLabel(placement.start)}.`);
  plan.warnings = [...(plan.warnings || []), ...nativeState.warnings, ...reconciliation.warnings, ...carry.warnings, ...returnedPlacement.warnings, ...placementMessages];
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
    today: unblockedToday,
    scheduled: unblockedScheduled,
    focusBlocks,
    startHere: focusBlocks[0]?.task || unblockedToday[0] || null,
    hasExistingFocusBlocks: focusBlocks.length > 0,
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
    const html = dashboardHtml(plan);
    if (typeof HTMLView.showWindowWithOptions === "function") {
      await HTMLView.showWindowWithOptions(html, "Work Activation Assistant", { id: DASHBOARD_WINDOW_ID, windowId: DASHBOARD_WINDOW_ID, width: 1180, height: 780, shouldFocus: true });
    } else HTMLView.showWindow(html, "Work Activation Assistant", 1180, 780);
  } catch (error) {
    await CommandBar.prompt("Work Activation Dashboard", error.message, ["OK"]);
  }
}

async function assistantDashboardToday() {
  return assistantDashboard(localDate());
}

async function assistantViewWorkday(targetDate = localDate()) {
  return assistantDashboard(targetDate);
}

async function assistantCompleteTask(taskId, targetDate = localDate()) {
  try {
    if (!String(taskId || "").trim()) throw new Error("Invalid active task.");
    const selectedDate = validDateString(targetDate) ? targetDate : localDate();
    await handleMessageFromHTMLView("completeTask", { id: taskId, date: selectedDate });
  } catch (error) {
    await CommandBar.prompt("Complete Active Task", `Could not mark this task complete.\n\n${error.message || String(error)}`, ["OK"]);
    await assistantDashboard(validDateString(targetDate) ? targetDate : localDate());
  }
}

async function assistantReviewDecision(taskId, decision, targetDate = localDate()) {
  try {
    if (!String(taskId || "").trim() || !["addToday", "complete", "ignore"].includes(decision)) throw new Error("Invalid review decision link.");
    const selectedDate = validDateString(targetDate) ? targetDate : localDate();
    let task = null;
    if (decision === "addToday") {
      const plan = serviceConfigured()
        ? await request(`/api/today?date=${selectedDate}`)
        : pilotPlanFromTransfer(loadPilotReview() || { tasks: [], decisions: {} }, collectOpenTasks(), selectedDate);
      task = (plan.review || []).find((item) => item.id === taskId) || null;
      if (!task) throw new Error("This review item is no longer available. Refresh the dashboard.");
    }
    await handleMessageFromHTMLView("reviewTask", { id: taskId, decision, date: selectedDate, task });
  } catch (error) {
    await CommandBar.prompt("Email Task Review", `Could not save this decision.\n\n${error.message || String(error)}`, ["OK"]);
    await assistantDashboard(validDateString(targetDate) ? targetDate : localDate());
  }
}

async function assistantBuildTimeBlocks(targetDate = localDate()) {
  return assistantDashboard(targetDate);
}

async function handleMessageFromHTMLView(actionType, data) {
  if (actionType === "refreshDashboard") {
    const refreshDate = validDateString(data?.date) ? data.date : localDate();
    await assistantDashboard(refreshDate);
    return;
  }
  if (actionType === "reviewTask") {
    if (!data?.id || !["addToday", "complete", "ignore"].includes(data?.decision)) throw new Error("Invalid review decision.");
    const selectedDate = validDateString(data?.date) ? data.date : localDate();
    const snapshot = snapshotNativeTask(data.id);
    if (data.decision === "addToday") {
      if (!data.task?.title) throw new Error("The selected task details are missing. Refresh and try again.");
      upsertNativeTask({ ...data.task, status: "today" }, selectedDate);
    }
    try {
      await request(`/api/reviews/${encodeURIComponent(data.id)}`, { method: "POST", body: JSON.stringify({ decision: data.decision, scheduledFor: null, waitingOn: null, followUpDate: null }) });
    } catch (error) {
      if (data.decision === "addToday") restoreNativeTask(data.id, snapshot);
      throw error;
    }
    if (data.decision === "ignore") deleteNativeTask(data.id);
    await assistantDashboard(selectedDate);
    return;
  }
  if (actionType === "waitingTask") {
    if (!data?.id || !String(data.waitingOn || "").trim()) throw new Error("Waiting tasks need a dependency.");
    if (!data.task?.title) throw new Error("The selected task details are missing. Refresh and try again.");
    try {
      await request(`/api/reviews/${encodeURIComponent(data.id)}`, { method: "POST", body: JSON.stringify({ decision: "waiting", scheduledFor: null, waitingOn: String(data.waitingOn).trim(), followUpDate: null }) });
    } catch (error) {
      throw error;
    }
    await assistantDashboard(validDateString(data?.date) ? data.date : localDate());
    return;
  }
  if (actionType === "completeTask") {
    if (!data?.id) throw new Error("Invalid task completion.");
    const snapshot = snapshotNativeTask(data.id);
    completeNativeTask(data.id);
    try {
      await request(`/api/tasks/${encodeURIComponent(data.id)}`, { method: "POST", body: JSON.stringify({ completed: true }) });
    } catch (error) {
      restoreNativeTask(data.id, snapshot);
      throw error;
    }
    await assistantDashboard(validDateString(data?.date) ? data.date : localDate());
    return;
  }
  if (actionType === "updateTask") {
    const title = String(data?.title || "").trim();
    if (!data?.id || !title) throw new Error("Task wording is required.");
    const snapshot = snapshotNativeTask(data.id);
    renameNativeTask(data.id, title);
    try {
      await request(`/api/tasks/${encodeURIComponent(data.id)}`, { method: "POST", body: JSON.stringify({ title }) });
    } catch (error) {
      restoreNativeTask(data.id, snapshot);
      throw error;
    }
    await assistantDashboard(validDateString(data?.date) ? data.date : localDate());
    return;
  }
  if (actionType === "projectStatus") {
    if (!String(data?.name || "").trim() || !["active", "later", "inactive"].includes(data?.status)) throw new Error("Invalid project response.");
    await request("/api/projects", { method: "POST", body: JSON.stringify({ name: String(data.name).trim(), status: data.status }) });
    await assistantDashboard(validDateString(data?.date) ? data.date : localDate());
    return;
  }
  if (actionType === "saveDashboardFeedback") {
    const type = ["idea", "task", "correction", "blocker"].includes(data?.type) ? data.type : "correction";
    const text = String(data?.text || "").trim();
    if (!text) throw new Error("Feedback text is required.");
    if (serviceConfigured()) {
      if (type === "idea") await request("/api/ideas", { method: "POST", body: JSON.stringify({ text }) });
      else if (type === "task") {
        const targetDate = validDateString(data?.date) ? data.date : localDate();
        if (!calendarNoteForDate(targetDate)) throw new Error(`Open or create the ${targetDate} daily note before adding this task.`);
        const task = await request("/api/tasks/manual", { method: "POST", body: JSON.stringify({ title: text, date: targetDate }) });
        upsertNativeTask(task, targetDate);
      } else await request("/api/check-ins", { method: "POST", body: JSON.stringify({ question: `Dashboard ${type}`, answer: text }) });
    } else {
      const pilot = loadPilotReview();
      if (pilot) {
        pilot.feedback ??= { corrections: {}, events: [], ideas: [] };
        pilot.feedback.events ??= [];
        pilot.feedback.events.unshift({ type: `dashboard-${type}`, answer: text, createdAt: new Date().toISOString() });
        DataStore.saveJSON(pilot, PILOT_FILENAME);
      }
    }
    saveDashboardFeedbackEntry(type, text);
    await assistantDashboard(validDateString(data?.date) ? data.date : localDate());
    return;
  }
  if (actionType === "answerIdea") {
    const answer = String(data?.answer || "").trim();
    if (!data?.id || !answer) throw new Error("An idea answer is required.");
    await request(`/api/ideas/${encodeURIComponent(data.id)}/answers`, { method: "POST", body: JSON.stringify({ answer }) });
    await assistantDashboard(validDateString(data?.date) ? data.date : localDate());
    return;
  }
  const start = Number(data?.start);
  const end = Number(data?.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 540 || end > 1020 || end - start < 20) throw new Error("Focus blocks must stay between 9:00 AM and 5:00 PM and be at least 20 minutes.");
  if (!validDateString(data?.date)) throw new Error("Invalid focus block date.");
  if (actionType === "saveFocusBlock") {
    if (!data?.taskId) throw new Error("Invalid focus block update.");
    updateNativeTaskBlock(data.taskId, data.date, start, end);
    await assistantDashboard(validDateString(data.dashboardDate) ? data.dashboardDate : localDate());
    return;
  }
  if (actionType === "groupSchedule") {
    const ids = Array.isArray(data?.ids) ? data.ids.filter((id) => typeof id === "string") : [];
    if (!serviceConfigured()) throw new Error("Grouped email scheduling requires the connected service.");
    if (ids.length < 2 || !data?.task?.id || !String(data.task.title || "").trim()) throw new Error("Choose at least two valid email tasks to group.");
    const snapshot = snapshotNativeTask(data.task.id);
    upsertNativeTask({ ...data.task, status: "scheduled" }, data.date, start, end);
    try {
      await request("/api/reviews/group", { method: "POST", body: JSON.stringify({ ids, id: data.task.id, title: String(data.task.title).trim(), scheduledFor: data.date }) });
    } catch (error) {
      restoreNativeTask(data.task.id, snapshot);
      throw error;
    }
    await assistantDashboard(validDateString(data.dashboardDate) ? data.dashboardDate : localDate());
    return;
  }
  if (actionType === "scheduleTask") {
    if (!data?.task?.id || !data.task.title) throw new Error("Invalid scheduled task.");
    if (serviceConfigured()) {
      const snapshot = snapshotNativeTask(data.task.id);
      upsertNativeTask({ ...data.task, status: "scheduled" }, data.date, start, end);
      try {
        if (snapshot) await request(`/api/tasks/${encodeURIComponent(data.task.id)}`, { method: "POST", body: JSON.stringify({ scheduledFor: data.date }) });
        else await request(`/api/reviews/${encodeURIComponent(data.task.id)}`, { method: "POST", body: JSON.stringify({ decision: "schedule", scheduledFor: data.date, waitingOn: null, followUpDate: null }) });
      } catch (error) {
        restoreNativeTask(data.task.id, snapshot);
        throw error;
      }
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
      upsertNativeTask(data.task, data.date, start, end);
    }
    await assistantDashboard(validDateString(data.dashboardDate) ? data.dashboardDate : localDate());
    return;
  }
  throw new Error("Unknown dashboard action.");
}

async function onMessageFromHTMLView(actionType, data) {
  try {
    return await handleMessageFromHTMLView(actionType, data);
  } catch (error) {
    await CommandBar.prompt("Work Activation Assistant", `Could not save this change. Nothing was removed.\n\n${error.message || String(error)}`, ["OK"]);
    await assistantDashboard(validDateString(data?.date) ? data.date : localDate());
    return null;
  }
}

async function assistantApplyDashboardAction(payload = "") {
  try {
    const parsed = JSON.parse(String(payload || ""));
    const allowed = ["scheduleTask", "groupSchedule", "waitingTask", "saveFocusBlock", "completeTask", "updateTask", "projectStatus", "saveDashboardFeedback", "answerIdea", "reviewTask"];
    if (!allowed.includes(parsed?.type) || !parsed?.data || typeof parsed.data !== "object") throw new Error("Invalid dashboard action.");
    return await handleMessageFromHTMLView(parsed.type, parsed.data);
  } catch (error) {
    await CommandBar.prompt("Work Activation Assistant", `Could not apply this dashboard change.\n\n${error.message || String(error)}`, ["OK"]);
    return null;
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
    for (const task of plan.waiting) {
      const answer = await CommandBar.prompt("Waiting Item", `${task.title}\n\n${task.waitingOn || "External dependency"}`, ["Still Waiting", "Add Today", "Handled", "Stop"]);
      if (!answer || answer === "Stop") break;
      if (answer === "Add Today") pilot.decisions[task.id] = "addToday";
      if (answer === "Handled") pilot.decisions[task.id] = "ignore";
    }
    DataStore.saveJSON(pilot, PILOT_FILENAME);
    await updateDailyNote(await currentPlan());
  } catch (error) {
    await CommandBar.prompt("Review Waiting", error.message, ["OK"]);
  }
}

async function assistantReview(taskId = "", decision = "", targetDate = localDate()) {
  if (String(taskId || "").trim() && ["addToday", "complete", "ignore"].includes(decision)) {
    return assistantReviewDecision(taskId, decision, targetDate);
  }
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
        const answer = await CommandBar.prompt("Email Task Review", `${task.title}\n\n${task.project || "No project"}${task.urgencyReason ? `\n${task.urgencyReason}` : ""}`, ["Add today", "Schedule", "Waiting", "Correct wording", "Completed", "Ignore", "Stop"]);
        if (answer === "Stop" || !answer) return assistantToday();
        if (answer === "Correct wording") {
          const title = await CommandBar.showInput("Enter the corrected task wording", "Save correction");
          if (!title?.trim()) continue;
          task = await request(`/api/reviews/${encodeURIComponent(task.id)}/correct`, { method: "POST", body: JSON.stringify({ title: title.trim() }) });
          continue;
        }
        let scheduledFor = null;
        let waitingOn = null;
        const followUpDate = null;
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
        }
        const decisions = { "Add today": "addToday", Schedule: "schedule", Waiting: "waiting", Completed: "complete", Ignore: "ignore" };
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

async function assistantSystemCheck() {
  const checks = [`✅ Plugin ${PLUGIN_VERSION} is loaded`];
  try {
    if (!serviceConfigured()) checks.push("⚠ Cloud service is not configured");
    else {
      const status = await request("/api/status");
      checks.push(status.connected ? "✅ Gmail and Calendar connection is available" : "⚠ Google needs to be reconnected");
      const storedPlan = await request(`/api/today?date=${localDate()}`);
      const reviewIds = (storedPlan?.review || []).map((task) => task.id);
      checks.push(new Set(reviewIds).size === reviewIds.length ? `✅ ${reviewIds.length} review items have unique IDs` : "❌ Duplicate review IDs were found");
    }
    const index = loadNativeTaskIndex();
    const activeEntries = Object.entries(index.tasks || {}).filter(([, entry]) => !entry.done);
    const blockIds = activeEntries.map(([, entry]) => entry.blockId).filter(Boolean);
    checks.push(new Set(blockIds).size === blockIds.length ? `✅ ${activeEntries.length} native tasks have unique blocks` : "❌ Duplicate native block IDs were found");
    checks.push(blockIds.every((blockId) => /^[a-z0-9]{6}$/i.test(String(blockId))) ? "✅ Native block markers are hidden correctly" : "❌ Invalid native block marker lengths were found");
    const missing = activeEntries.filter(([taskId]) => !findNativeTask(taskId));
    checks.push(missing.length ? `⚠ ${missing.length} indexed tasks are missing from NotePlan notes` : "✅ Every indexed task is present in NotePlan");
  } catch (error) {
    checks.push(`❌ ${error.message || String(error)}`);
  }
  await CommandBar.prompt("Work Activation System Check", checks.join("\n"), ["OK"]);
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
  assistantDashboardToday,
  assistantViewWorkday,
  assistantCompleteTask,
  assistantReviewDecision,
  assistantBuildTimeBlocks,
  assistantScheduleTasks,
  assistantReviewWaiting,
  assistantToday,
  assistantReview,
  assistantIdea,
  assistantCheckIn,
  assistantPause,
  assistantReconnect,
  assistantSystemCheck,
  assistantImportPilotReview,
  assistantReset,
  onMessageFromHTMLView,
  assistantApplyDashboardAction,
  assistantRefreshDashboard,
  assistantScanOlderEmail,
});
