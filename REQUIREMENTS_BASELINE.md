# Work Activation Assistant Requirements Baseline

This document is the non-regression contract for the rebuild. No architectural change is acceptable if it removes or weakens a requirement below.

## Completion Standard

- Do not report a workflow fix as complete until its automated regression test passes and the corresponding live NotePlan user flow has been exercised successfully.

## Product Goal

Create an ADHD-friendly work activation system that reduces the effort required to determine what to do next. It must use real Gmail, Google Calendar, and NotePlan data; present a visually scannable plan; and turn decisions into reliable, editable work in NotePlan.

## Primary Interface

- NotePlan is the only work destination.
- The visual dashboard remains the main review and planning interface.
- A prominent button in every daily note opens the dashboard; no command typing is required.
- Native NotePlan tasks and timeline blocks must show the same state as the dashboard.
- A task can be edited either in the dashboard or natively in NotePlan without creating a duplicate.
- Opening NotePlan alone does not need to open the dashboard automatically, but the daily-note button must always work.
- The old browser prototype, digest email, Google Doc, and Future ADHD PDF are not part of the active workflow.

## ADHD-Friendly UX

- Keep the interface visual, calm, formatted, and easy to scan.
- Keep `Start Here` and the highest-priority work short without deleting or hiding the remaining valid work.
- Use clear categories rather than one overwhelming list.
- Show concise text inside time blocks; retain the full editable task wording elsewhere.
- Ask one question at a time.
- Ask useful idea, energy, priority, or blocker questions approximately three weekdays per week.
- Feedback must immediately affect future planning instead of disappearing into a passive note.
- Never impose a rollover limit; a large workload must remain represented without overloading the top-priority area.

## Source Data and Trust

- Every displayed email task and calendar event must come from verified real data.
- Never use fictional fallback tasks, people, dates, links, metrics, or calendar commitments.
- Display work Gmail account, connection state, last Gmail check, last Calendar check, and last successful refresh.
- If Gmail or Calendar fails, show a visible warning and do not imply the report is complete.
- Provide a clear reconnect action for expired or revoked Google access.
- Work Gmail launches first; the model must support a future personal Gmail account and separate personal section.
- Calendar availability uses the real 9:00 AM–5:00 PM workday in America/Vancouver.
- The scheduled weekday refresh remains 8:00 AM Monday–Friday.

## Gmail Discovery

- Find all unresolved emails that reasonably require action by the mailbox owner.
- Include inbox requests, commitments made in sent mail, follow-ups, website work, invoicing, payment follow-up, and dependencies preventing completion.
- Exclude spam without exception.
- Exclude newsletters, promotions, FYI-only messages, receipts, resolved work, and meetings already confirmed on the calendar.
- Exclude old assistant-generated digest emails.
- Show the received date for incoming email tasks.
- Show latest thread activity for sent-only follow-ups without incorrectly calling it a received date.
- Link to Gmail rather than copying passwords, API keys, verification codes, or other secrets.
- Historical scanning must be bounded, resumable, deduplicated, and visibly report coverage.
- A reprocessed Gmail thread may update an unresolved suggestion but must not duplicate it.
- A genuinely new message after a prior decision may create a new review suggestion when it contains new unresolved work.

## Email Task Review

- Email Task Review stays at the top of the dashboard beside the visible schedule.
- Every email-derived task remains inactive until explicitly reviewed.
- Every review item supports:
  - Today
  - Schedule with required date and time
  - Waiting with a dependency, without requiring a guessed follow-up date
  - Completed
  - Edit
  - Ignore
  - Open source email
- Ignored items remain ignored across every refresh and reclassification.
- Completed items remain completed and do not return.
- An older dashboard, delayed drag, or native synchronization may never overwrite a newer Ignore or Completed decision.
- Scheduled items disappear from Email Task Review only after scheduling is confirmed.
- Today and Waiting items disappear from Email Task Review only after their decisions are confirmed.
- If saving fails, the item remains visible with a clear retry message.
- Review counts update immediately after a confirmed decision.
- Related review items can be selected and converted into one scheduled task.
- Grouping dismisses the selected source suggestions only after the grouped native task is confirmed.
- Waiting items appear together in one compact `Waiting Review` panel.
- A new incoming reply on a waiting Gmail thread reactivates the original task without creating a duplicate.
- Reactivated waiting work is placed automatically in the next available working block and visibly marked with `↩`.

## Scheduling and Blocks

- Scheduling always provides a date, start time, and duration choice.
- The currently selected date defaults to today, not a stale prior day.
- Previous, Today, and Next Workday navigation is always available.
- Friday's next workday is Monday.
- Current-time awareness prevents proposing blocks in elapsed time.
- Real calendar commitments and transition time reduce available 9–5 capacity.
- Conflicts are prevented and explained visibly.
- Review tasks can be dragged into the dashboard schedule when practical.
- Every confirmed scheduled item becomes one native NotePlan timed task on the target daily note.
- The native task appears in NotePlan's timeline.
- Dashboard blocks are views of native NotePlan paragraphs, not private JSON copies.
- Blocks can be dragged, resized, renamed, and completed in the dashboard.
- Blocks can be dragged, resized, renamed, and completed natively in NotePlan.
- Both interfaces must display the same date, time, wording, and completion state after refresh.
- `Open in NotePlan` opens the exact native paragraph for a block.

## Carry Forward

- Every valid incomplete active task moves to the next workday automatically.
- Friday tasks move to Monday.
- Carry-forward moves the same native task; it does not create copies.
- Stable identity is preserved across dates.
- Old time ranges are removed before replanning on the new day.
- Completed, canceled, ignored, waiting, and future-scheduled tasks do not roll forward as active work.
- There is no maximum number of carried tasks.

## Native NotePlan Behavior

- Activated work is represented by native NotePlan task paragraphs with stable block IDs.
- Native task completion is authoritative.
- Native edits and timeline changes are reconciled to backend metadata when the dashboard opens or refreshes.
- Assistant-managed paragraphs are not re-imported as unrelated NotePlan tasks.
- The plugin modifies only clearly marked assistant-managed paragraphs or sections.
- Existing user-created NotePlan tasks remain untouched except when the user explicitly schedules or groups them through this assistant.

## Projects and Recurring Work

- Display the main projects currently being worked on.
- Ask whether a detected project is Active, Later, or Not active using buttons.
- A project answer updates the displayed project list and planning priority immediately.
- Active project status persists across refreshes.
- Website updates, client dependencies, completion work, invoicing, and payment follow-up remain connected as one client project cycle.
- Monthly invoicing and associated website updates remain supported recurring work.

## Feedback and Ideas

- The dashboard keeps a working feedback loop for new ideas, tasks, corrections, and blockers.
- Saving feedback visibly confirms success or leaves the entry available after failure.
- Corrections influence future classification and planning.
- A new idea generates one useful follow-up question at a time.
- Answers remain attached to the idea and generate the next relevant question.
- Confirmed facts, such as an already-arranged meeting, suppress incorrect future suggestions.

## Known Content Corrections

- Sparky's work includes invoicing and following up on James-dependent content, testing, or feedback required to finish the website work.
- Sparky's must not be reduced to fictional homepage changes.
- The already-arranged Automattic meeting must not be proposed as a setup task unless a genuinely new rescheduling request appears.

## Safety Boundaries

- Never send email replies automatically.
- Never delete or archive email.
- Never mark email read automatically.
- Never mark a task complete automatically.
- Never modify Google Calendar events.
- Gmail labels may be applied when they are minimal, clear, and used to preserve review state.
- Sensitive context may be stored when useful, but passwords, keys, codes, and secrets remain linked in Gmail rather than copied.

## Reliability Rules

- Every dashboard action has a confirmed success or explicit failure state.
- UI elements are never removed optimistically before persistence succeeds.
- Ignore and Completed are terminal, transactional decisions; stale writes receive a visible conflict instead of reactivating work.
- Refresh is idempotent.
- Retries do not duplicate tasks, paragraphs, blocks, or review decisions.
- Firestore and NotePlan disagreements produce a visible consistency warning.
- Last-successful-run timestamps remain available for recovery.
- Legacy JSON blocks remain read-only during migration and are deleted only after successful pilot verification.

## Mandatory Non-Regression Scenarios

1. Ignore an email task, refresh twice, and confirm it never returns.
2. Schedule an email task, confirm it leaves review, appears once in the target daily note, and appears once in the native timeline.
3. Disconnect the network during Ignore and Schedule; confirm the cards remain visible with retry messages.
4. Drag and resize a block natively, reopen the dashboard, and confirm the same placement.
5. Drag and resize the same block in the dashboard, open NotePlan, and confirm the native placement.
6. Complete the task natively and confirm it disappears from active work after refresh.
7. Leave a task incomplete Friday and confirm exactly one Monday task with the same identity.
8. Group multiple email tasks and confirm exactly one editable, completable native block.
9. Confirm spam, promotions, resolved work, and the arranged Automattic meeting are absent.
10. Confirm Sparky's invoicing and James dependency remain correctly represented.
11. Confirm project-button and feedback answers visibly change the dashboard.
12. Confirm Gmail or Calendar failure produces a warning rather than a misleading partial plan.

## Implementation Gate

Before implementation begins, every item in `NATIVE_NOTEPLAN_REBUILD_PLAN.md` must be mapped to this baseline. Before deployment, every mandatory scenario above must pass both automated tests and a live NotePlan test where applicable.
