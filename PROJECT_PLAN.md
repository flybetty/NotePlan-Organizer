# Current Project Plan

> The current dashboard-only focus-block architecture is being replaced. See `REQUIREMENTS_BASELINE.md` for the non-regression contract and `NATIVE_NOTEPLAN_REBUILD_PLAN.md` for the architecture and migration plan.

## Product Boundary

NotePlan is the sole work interface. Gmail and Calendar are read as sources; no digest email or Google Doc is produced.

## Data Flow

1. Cloud Scheduler refreshes Gmail and Calendar at 8:00 AM on weekdays.
2. Opening the NotePlan dashboard also performs an incremental source refresh.
3. Gmail threads are classified into zero or more unresolved review suggestions.
4. Reprocessed threads reconcile stale unreviewed suggestions while preserving user-approved work.
5. Review decisions activate, schedule, wait, edit, or ignore a task.
6. Active tasks remain active across workdays until explicitly completed.
7. NotePlan displays active tasks, calendar commitments, editable focus blocks, and confirmed projects.

## Safety

- No automatic replies, archive, delete, read-state, calendar edits, task completion, email delivery, or document creation.
- Email tasks never activate before review.
- Source status and historical coverage remain visible.
- Credentials, API keys, passwords, passcodes, and verification codes are redacted before classification.
