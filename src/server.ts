import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { loadConfig } from "./config.js";
import { OpenAIEmailClassifier } from "./classifier.js";
import { TerminalTaskConflictError, type ProjectStatus, type ReviewDecision, type TaskSuggestion } from "./domain.js";
import { GoogleApiGateway } from "./google.js";
import { WorkAssistantService } from "./service.js";
import { FirestoreAssistantStore } from "./store.js";

const config = loadConfig();
const runtimeRequire = createRequire(import.meta.url);
const { Firestore } = runtimeRequire("@google-cloud/firestore");
const store = new FirestoreAssistantStore(new Firestore({ projectId: config.GOOGLE_CLOUD_PROJECT }));
const google = new GoogleApiGateway(config);
const classifier = new OpenAIEmailClassifier(config.OPENAI_API_KEY, config.OPENAI_MODEL);
const service = new WorkAssistantService(config, store, google, classifier);

class InvalidJsonBodyError extends Error {
  constructor() {
    super("Invalid JSON body");
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new InvalidJsonBodyError();
  }
}

function authorized(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${config.SERVICE_API_TOKEN}`;
}

function dateInVancouver(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: config.TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", config.PUBLIC_BASE_URL);
    if (url.pathname === "/health") return send(response, 200, { ok: true });
    if (url.pathname === "/oauth/google/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return send(response, 400, { error: "Missing OAuth code or state" });
      await google.exchangeCode(code, state);
      response.writeHead(302, { location: `${config.PUBLIC_BASE_URL}/connected` });
      return response.end();
    }
    if (url.pathname === "/connected") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end("<h1>Gmail and Calendar connected</h1><p>You can return to NotePlan.</p>");
    }
    if (url.pathname === "/jobs/daily") {
      if (request.headers["x-job-secret"] !== config.JOB_SECRET) return send(response, 401, { error: "Unauthorized" });
      const plan = await service.generateDailyPlan(url.searchParams.get("date") ?? dateInVancouver());
      return send(response, 200, plan);
    }
    if (!authorized(request)) return send(response, 401, { error: "Unauthorized" });
    if (url.pathname === "/api/oauth-url" && request.method === "GET") return send(response, 200, { url: google.authorizationUrl() });
    if (url.pathname === "/api/status" && request.method === "GET") return send(response, 200, await service.status());
    if (url.pathname === "/api/task-state" && request.method === "GET") return send(response, 200, { tasks: await service.taskDecisionStates() });
    if (url.pathname === "/api/today" && request.method === "GET") return send(response, 200, await service.getPlan(url.searchParams.get("date") ?? dateInVancouver()));
    if (url.pathname === "/api/generate" && request.method === "POST") return send(response, 200, await service.generateDailyPlan(url.searchParams.get("date") ?? dateInVancouver(), true));
    if (url.pathname === "/api/gmail/backlog" && request.method === "POST") return send(response, 200, await service.scanGmailBacklog());
    if (url.pathname === "/api/tasks/manual" && request.method === "POST") {
      const values = await body(request);
      if (typeof values.title !== "string" || typeof values.date !== "string") return send(response, 400, { error: "Task wording and date are required" });
      return send(response, 200, await service.captureManualTask(values.title, values.date));
    }
    if (url.pathname === "/api/reviews/group" && request.method === "POST") {
      const values = await body(request);
      const ids = Array.isArray(values.ids) ? values.ids.filter((id): id is string => typeof id === "string") : [];
      if (typeof values.id !== "string" || typeof values.title !== "string" || typeof values.scheduledFor !== "string") return send(response, 400, { error: "Group ID, title, and scheduled date are required" });
      return send(response, 200, await service.groupReviews(ids, values.id, values.title, values.scheduledFor));
    }
    if (url.pathname.startsWith("/api/reviews/") && url.pathname.endsWith("/correct") && request.method === "POST") {
      const values = await body(request);
      if (typeof values.title !== "string" || !values.title.trim()) return send(response, 400, { error: "Corrected task wording is required" });
      const id = decodeURIComponent(url.pathname.slice("/api/reviews/".length, -"/correct".length));
      return send(response, 200, await service.correctReview(id, values.title));
    }
    if (url.pathname.startsWith("/api/reviews/") && request.method === "POST") {
      const values = await body(request);
      const decision = values.decision as ReviewDecision;
      if (!["addToday", "schedule", "waiting", "complete", "ignore"].includes(decision)) return send(response, 400, { error: "Invalid review decision" });
      const result = await service.review(decodeURIComponent(url.pathname.slice("/api/reviews/".length)), decision, {
        scheduledFor: typeof values.scheduledFor === "string" ? values.scheduledFor : null,
        waitingOn: typeof values.waitingOn === "string" ? values.waitingOn : null,
        followUpDate: typeof values.followUpDate === "string" ? values.followUpDate : null,
      });
      return send(response, 200, { ok: true, ...result });
    }
    if (url.pathname.startsWith("/api/tasks/") && request.method === "POST") {
      const values = await body(request);
      const title = typeof values.title === "string" ? values.title : undefined;
      const completed = typeof values.completed === "boolean" ? values.completed : undefined;
      const scheduledFor = typeof values.scheduledFor === "string" ? values.scheduledFor : undefined;
      const returnedFromWaiting = typeof values.returnedFromWaiting === "boolean" ? values.returnedFromWaiting : undefined;
      const waitingResponseReceivedAt = typeof values.waitingResponseReceivedAt === "string" ? values.waitingResponseReceivedAt : undefined;
      if (title === undefined && completed === undefined && scheduledFor === undefined && returnedFromWaiting === undefined && waitingResponseReceivedAt === undefined) return send(response, 400, { error: "No task change supplied" });
      return send(response, 200, await service.updateTask(decodeURIComponent(url.pathname.slice("/api/tasks/".length)), { title, completed, scheduledFor, returnedFromWaiting, waitingResponseReceivedAt }));
    }
    if (url.pathname === "/api/projects" && request.method === "GET") return send(response, 200, { projects: await service.listProjects() });
    if (url.pathname === "/api/projects" && request.method === "POST") {
      const values = await body(request);
      const status = values.status as ProjectStatus;
      if (typeof values.name !== "string" || !["active", "later", "inactive"].includes(status)) return send(response, 400, { error: "Valid project name and status are required" });
      return send(response, 200, { projects: await service.setProjectStatus(values.name, status) });
    }
    if (url.pathname === "/api/pilot/migrate" && request.method === "POST") {
      const values = await body(request);
      const tasks = Array.isArray(values.tasks) ? values.tasks as TaskSuggestion[] : [];
      const decisions = values.decisions && typeof values.decisions === "object" ? values.decisions as Record<string, string> : {};
      return send(response, 200, await service.migratePilotReview(tasks, decisions));
    }
    if (url.pathname === "/api/noteplan/sync" && request.method === "POST") {
      const values = await body(request);
      const tasks = Array.isArray(values.tasks) ? values.tasks as TaskSuggestion[] : [];
      if (!tasks.every((task) => task.sourceType === "noteplan" && task.sourceId && task.title)) return send(response, 400, { error: "Invalid NotePlan tasks" });
      await store.replaceNotePlanSuggestions(tasks);
      return send(response, 200, { imported: tasks.length });
    }
    if (url.pathname === "/api/ideas" && request.method === "POST") {
      const values = await body(request);
      if (typeof values.text !== "string" || !values.text.trim()) return send(response, 400, { error: "Idea text is required" });
      return send(response, 201, await service.captureIdea(values.text.trim()));
    }
    if (url.pathname.startsWith("/api/ideas/") && url.pathname.endsWith("/answers") && request.method === "POST") {
      const values = await body(request);
      if (typeof values.answer !== "string" || !values.answer.trim()) return send(response, 400, { error: "Idea answer is required" });
      const id = decodeURIComponent(url.pathname.slice("/api/ideas/".length, -"/answers".length));
      return send(response, 201, await service.answerIdea(id, values.answer));
    }
    if (url.pathname === "/api/check-ins" && request.method === "POST") {
      const values = await body(request);
      if (typeof values.question !== "string" || typeof values.answer !== "string") return send(response, 400, { error: "Question and answer are required" });
      await service.recordCheckIn(values.question, values.answer);
      return send(response, 201, { ok: true });
    }
    if (url.pathname === "/api/pause" && request.method === "POST") {
      const values = await body(request);
      await service.setPaused(values.paused !== false);
      return send(response, 200, { paused: values.paused !== false });
    }
    return send(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(JSON.stringify({ severity: "ERROR", message: (error as Error).message, stack: (error as Error).stack }));
    if (error instanceof InvalidJsonBodyError) return send(response, 400, { error: error.message });
    if (error instanceof TerminalTaskConflictError) return send(response, 409, { error: error.message });
    return send(response, 500, { error: "Internal server error" });
  }
});

server.listen(config.PORT, () => console.log(JSON.stringify({ severity: "INFO", message: "server_started", port: config.PORT })));
