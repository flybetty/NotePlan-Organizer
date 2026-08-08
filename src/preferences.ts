import type { TaskSuggestion } from "./domain.js";

export const knownResolvedSources = new Map<string, string>([
  ["19fcf694a8a2a1cf", "Automattic meeting already scheduled; confirmed by user on August 6, 2026."],
]);

const projectAliases: Array<[RegExp, string]> = [
  [/^(?:fbca|fanny bay(?: community association)?)\b/i, "Fanny Bay Community Association"],
  [/^top\s*shelf\b/i, "Top Shelf Hospitality"],
  [/^(?:the\s+)?circle\b/i, "The Circle Education"],
  [/^boom(?:\s*(?:\+|and|&)\s*batten)?\b/i, "Boom + Batten"],
  [/\bmed(?:iterranean)?\s+grill\b/i, "Med Grill"],
  [/automattic|proactive discovery/i, "Automattic for Agencies"],
  [/hosting|tooling|data migration|domains/i, "Business Operations"],
];

export function normalizeProject(project: string | null): string | null {
  if (!project) return null;
  const value = project.trim();
  return projectAliases.find(([pattern]) => pattern.test(value))?.[1] ?? value;
}

export function applyKnownPreferences(tasks: TaskSuggestion[]): TaskSuggestion[] {
  return tasks
    .filter((task) => !knownResolvedSources.has(task.sourceId))
    .filter((task) => !/^attend (?:the )?automattic\b/i.test(task.title.trim()))
    .filter((task) => !/^record payment received\b/i.test(task.title.trim()))
    .map((task) => ({
      ...task,
      project: normalizeProject(task.project),
      dueDate: task.dueDate?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null,
    }));
}
