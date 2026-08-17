import OpenAI from "openai";
import { z } from "zod";
import type { EmailThreadInput, TaskSuggestion } from "./domain.js";
import { stableTaskId } from "./domain.js";

const classifiedTaskSchema = z.object({
  threadId: z.string(),
  actionKey: z.string(),
  title: z.string(),
  project: z.string().nullable(),
  dueDate: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  urgencyReason: z.string().nullable(),
  waitingOn: z.string().nullable(),
  actionable: z.boolean(),
});

const resultSchema = z.object({ tasks: z.array(classifiedTaskSchema) });

export interface EmailClassifier {
  classify(threads: EmailThreadInput[], sourceAccount: string, verifiedAt: string, planningContext?: string[]): Promise<TaskSuggestion[]>;
}

export function normalizeDueDate(value: string | null): string | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match || Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`))) return null;
  return match[1];
}

export class OpenAIEmailClassifier implements EmailClassifier {
  private readonly client: OpenAI;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new OpenAI({ apiKey });
  }

  async classify(threads: EmailThreadInput[], sourceAccount: string, verifiedAt: string, planningContext: string[] = []): Promise<TaskSuggestion[]> {
    if (!threads.length) return [];
    const suggestions: TaskSuggestion[] = [];
    for (let index = 0; index < threads.length; index += 20) {
      const batch = threads.slice(index, index + 20);
      suggestions.push(...await this.classifyBatch(batch, sourceAccount, verifiedAt, planningContext));
    }
    return suggestions;
  }

  private async classifyBatch(threads: EmailThreadInput[], sourceAccount: string, verifiedAt: string, planningContext: string[]): Promise<TaskSuggestion[]> {
    const response = await this.client.responses.create({
      model: this.model,
      reasoning: { effort: "low" },
      safety_identifier: `work-assistant-${sourceAccount.toLowerCase()}`,
      input: [
        {
          role: "system",
          content: `Extract every distinct unresolved work action for the mailbox owner. Read the messages chronologically and treat the latest messages as authoritative. Include direct requests, explicit owner commitments, replies needed, deadlines, unpaid or unsent invoices, website work, and sent messages that still need follow-up. Exclude newsletters, promotions, FYI messages, completed work, resolved problems, meetings already represented by calendar events, payment receipts, and requests the latest sender confirms are fixed or no longer needed. Do not invent work from quoted older messages after a newer resolution. Never copy credentials, API keys, passwords, passcodes, or verification codes. Every result is only a review suggestion, never an approved task. Return all distinct unresolved actions in each thread. Use short stable actionKey values that describe the action and remain unchanged when wording changes.${planningContext.length ? ` Respect these user-supplied planning corrections and blockers as authoritative context: ${JSON.stringify(planningContext.slice(0, 30))}` : ""}`,
        },
        { role: "user", content: JSON.stringify(threads) },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "email_task_suggestions",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["tasks"],
            properties: {
              tasks: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["threadId", "actionKey", "title", "project", "dueDate", "confidence", "urgencyReason", "waitingOn", "actionable"],
                  properties: {
                    threadId: { type: "string" },
                    actionKey: { type: "string" },
                    title: { type: "string" },
                    project: { type: ["string", "null"] },
                    dueDate: { type: ["string", "null"] },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    urgencyReason: { type: ["string", "null"] },
                    waitingOn: { type: ["string", "null"] },
                    actionable: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    });

    const result = resultSchema.parse(JSON.parse(response.output_text));
    const byThread = new Map(threads.map((thread) => [thread.threadId, thread]));
    return result.tasks.filter((task) => task.actionable && byThread.has(task.threadId)).map((task) => {
      const thread = byThread.get(task.threadId)!;
      return {
        id: stableTaskId(task.threadId, task.actionKey),
        actionKey: task.actionKey,
        title: task.title,
        project: task.project,
        status: "review",
        dueDate: normalizeDueDate(task.dueDate),
        sourceType: "gmail",
        sourceId: task.threadId,
        sourceUrl: thread.sourceUrl,
        sourceAccount,
        confidence: task.confidence,
        urgencyReason: task.urgencyReason,
        waitingOn: task.waitingOn,
        emailReceivedAt: thread.latestReceivedAt,
        emailLastActivityAt: thread.latestAt,
        gmailLocationVerifiedAt: verifiedAt,
        verifiedAt,
        reviewedAt: null,
        reviewDecision: null,
        scheduledFor: null,
        followUpDate: null,
      } satisfies TaskSuggestion;
    });
  }
}
