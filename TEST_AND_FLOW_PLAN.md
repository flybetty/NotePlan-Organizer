# Acceptance and Test Plan

## Email Discovery

- Incremental refresh finds messages received after the prior Gmail history ID.
- The one-year inbox-and-sent backfill runs to completion without skipping the most recent month.
- Every displayed suggestion links to its source thread.
- Resolved latest messages remove stale unreviewed suggestions.
- Activated, scheduled, waiting, edited, and completed decisions survive reprocessing without duplication.

## Review UX

- Every review item is visible in a scrollable list, not truncated to six.
- Each item supports Today, Schedule, Waiting, Completed, Edit, Ignore, and source opening.
- Schedule requires a valid workday date and 9–5 time.
- Waiting requires a dependency but does not force a guessed follow-up date.
- Waiting items remain together in one compact review panel.
- A new incoming reply reactivates the original task, places it in the next available work block, and marks it with `↩`.

## Workday UX

- Active tasks have completion controls.
- Focus blocks can be moved, resized, renamed, and completed.
- Calendar collisions are rejected with a visible explanation.
- Unchecked active work appears on the next weekday; Friday work appears Monday.
- Completed work does not return.

## Projects

- Task-derived project candidates ask one Active/Later/Not active question at a time.
- Confirmed active projects show open-task counts.
- Project responses persist across refreshes.

## Launch Gate

- Unit, integration, NotePlan compatibility, and TypeScript checks pass.
- The live mailbox backfill reports complete coverage.
- Live NotePlan dashboard opens without an alert.
- A live task can be reviewed, scheduled, edited, moved, completed, and confirmed absent after refresh.
- No digest email or Google Doc is created during any refresh or scheduled run.
