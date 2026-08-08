# Work Activation Assistant

An ADHD-friendly, NotePlan-first work system for Gmail and Google Calendar.

## What it does

- Refreshes Gmail and Calendar at 8:00 AM Monday–Friday and whenever the NotePlan dashboard opens.
- Sends every unresolved email action to **Email Task Review** with **Today**, **Schedule**, **Waiting**, **Edit**, and **Ignore** controls.
- Keeps review suggestions inactive until Leslee chooses an action.
- Shows approved tasks in editable 9–5 focus blocks that can be moved, resized, renamed, and completed.
- Carries every unchecked active task into the next workday, including Friday to Monday.
- Groups task-derived projects and asks whether each is **Active**, **Later**, or **Not active**.
- Uses NotePlan as the only output. It does not send digest emails or create Google Docs.

## Email coverage

- Incremental Gmail history checks capture new messages after the initial connection.
- A one-year historical scan works backward through all unreviewed inbox and sent threads in bounded batches.
- Thread reprocessing removes stale unreviewed suggestions when later messages resolve the work.
- Reviewed or activated tasks are preserved until Leslee completes or ignores them.
- Message chronology and sender metadata are included during classification; secrets and verification codes are redacted.

The assistant never replies, archives, deletes, or marks email read, and it never modifies calendar events.

## Verification

```sh
npm test
npm run typecheck
```

See `TEST_AND_FLOW_PLAN.md` for the acceptance matrix and `PROJECT_PLAN.md` for the current architecture.
