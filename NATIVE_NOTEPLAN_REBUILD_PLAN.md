# Native NotePlan Rebuild Plan

> This rebuild must preserve every requirement in `REQUIREMENTS_BASELINE.md`. The baseline is authoritative when an implementation shortcut would remove prior requested behavior.

## Decision

Replace the dashboard-only block system with native NotePlan task paragraphs. Firestore continues to hold Gmail review history and source metadata, but after a review item is activated, the corresponding NotePlan paragraph becomes the source of truth for its wording, date, time, completion state, and carry-forward state.

The HTML dashboard remains the review and planning interface. Its timeline becomes another editor for the same native NotePlan paragraphs, not a separate calendar stored in plugin JSON.

## Current-State Findings

1. The daily NotePlan note contains only the dashboard button.
2. Dashboard focus blocks are stored separately in `dashboard-focus-blocks.json`.
3. Scheduled Gmail tasks are also stored in Firestore, creating two records with different lifecycle rules.
4. Native NotePlan tasks are scanned independently and exclude assistant-managed lines.
5. Moving or completing a dashboard block does not change a native NotePlan task because no native task exists.
6. Moving or completing a native NotePlan task cannot update a dashboard block stored in private JSON.
7. Review buttons remove cards optimistically before the plugin confirms that the backend write succeeded. A failed write therefore looks successful until refresh returns the item.
8. Native-task parsing and native time-block rendering code exists, but the current scheduling flow does not use it.

## Target Data Model

### Gmail Review Record

Firestore retains the Gmail thread ID, action ID, review decision, source URL, timestamps, and dismissal history. Review records never become visual time blocks themselves.

### Native Work Task

An activated item is written once as an open paragraph in a NotePlan daily note:

```markdown
* 10:00 AM - 11:00 AM Send client invoice [email](gmail-url) #assistant/work ^stableBlockID
```

- The daily-note filename supplies the scheduled date.
- The time range supplies the native NotePlan time block.
- The paragraph type supplies open, completed, canceled, or scheduled state.
- The block ID supplies stable identity across edits and moves.
- The Gmail link preserves source access.
- A small mapping record links the backend task ID to the NotePlan block ID. It is an index only, never a second copy of task state.

### Waiting Work

Waiting items remain together in the dashboard's compact `Waiting Review` panel with their dependency and Gmail link. They do not require an invented follow-up date. When Gmail detects a new incoming response on the same thread, the original task is reactivated without duplication, automatically placed in the next available working block, and marked with `↩`.

## Required Flows

### Review Decision

1. Disable the selected review controls and show `Saving…`.
2. Save the decision in Firestore.
3. For Today or Schedule, create the native NotePlan paragraph.
4. Confirm the paragraph exists and can be read back by block ID.
5. Only then remove the review card and update its count.
6. If any step fails, leave the card visible and show a specific retry message.

Ignore and Completed do not create a native paragraph. Their cards disappear only after Firestore confirms the decision.

### Scheduling

- Choosing a date and time creates a timed task in that date's NotePlan daily note.
- The task immediately appears in NotePlan's native timeline.
- Dragging or resizing the native block changes the paragraph's time using NotePlan's own behavior.
- Dragging or resizing in the HTML dashboard updates that same paragraph through `updateParagraph`.
- Reopening either view reads the paragraph and shows the same date, time, wording, and status.

### Completion

- Completing the native task is authoritative.
- On dashboard open or refresh, the plugin reconciles assistant block IDs with Firestore.
- A completed native paragraph marks the backend task completed and removes it from active planning.
- Completing from the dashboard updates the native paragraph first, verifies it, then updates Firestore.

### Carry Forward

- On the first dashboard open of a workday, scan incomplete assistant-managed tasks in prior daily notes.
- Move each paragraph—not copy it—to the current workday while preserving its block ID.
- Remove the stale time range before automatic replanning so yesterday's time is not reused blindly.
- Friday tasks move to Monday.
- Completed, canceled, waiting, and future-scheduled tasks do not move.
- There is no rollover quantity limit.

### Grouped Email Work

- Selected review items become one native NotePlan task with one block ID.
- The grouped paragraph includes links to each source thread in an indented details section or project note.
- All selected review records are committed before the grouped card disappears.
- The one native task can be moved, resized, edited, completed, and carried forward normally.

## Dashboard Changes

1. Keep Email Task Review at the top beside the schedule.
2. Replace private JSON focus blocks with blocks parsed from native NotePlan paragraphs.
3. Add explicit states: `Saving`, `Saved in NotePlan`, and `Could not save—item was not removed`.
4. Make the schedule date visible on every block.
5. Add `Open in NotePlan` to each active block so the exact paragraph can be edited natively.
6. Refresh after every confirmed decision instead of relying on optimistic DOM removal.
7. Display a consistency warning if Firestore and NotePlan disagree; never silently choose one.

## Migration

1. Back up `dashboard-focus-blocks.json` and the affected daily notes.
2. Read each existing JSON block and match it to its Firestore task ID.
3. Create one native NotePlan paragraph on the stored date with the stored time and title.
4. Verify each paragraph by block ID before marking the JSON entry migrated.
5. Deduplicate repeated Friday/Monday copies by task ID, keeping the newest incomplete placement.
6. Keep the JSON file read-only for one release as rollback evidence.
7. Remove JSON block reads and writes after five successful weekday pilots.

## Test Plan

### Automated

- A review decision cannot remove a card before confirmed persistence.
- A failed backend request leaves the review item visible with a retry message.
- Scheduling creates exactly one native paragraph and zero JSON blocks.
- The created paragraph is an open task with the correct date, time, title, source link, and block ID.
- Dashboard edits update the same paragraph rather than creating another task.
- Native edits are reflected when the dashboard reopens.
- Native completion updates Firestore and prevents carry-forward.
- Ignore survives refresh and creates no native paragraph.
- Same-message reclassification cannot recreate reviewed work.
- A genuinely newer email reply can create a new review suggestion.
- Friday carry-forward moves one paragraph to Monday without copying it.
- Group scheduling creates one native task and dismisses every selected review item.
- Calendar conflicts are rejected before changing the paragraph.

### Live NotePlan Pilot

1. Review one email with Today and confirm it appears in today's note.
2. Schedule one email and confirm it appears in the native timeline.
3. Drag and resize it in native NotePlan, then reopen the dashboard and compare.
4. Edit and complete it in native NotePlan, then refresh and confirm it is absent.
5. Ignore one email, refresh twice, and confirm it remains absent.
6. Group two emails, schedule the group, and verify there is only one native block.
7. Leave one task incomplete on Friday and verify one Monday task with the same block ID.
8. Disconnect the network during a decision and verify the item remains visible with an error.
9. Repeat for five weekdays before deleting the legacy JSON path.

## Launch Order

1. Build native paragraph repository and parser.
2. Add confirmed request/response handling to the HTML bridge.
3. Convert Today, Schedule, Waiting, Complete, and Ignore flows.
4. Render dashboard blocks from native paragraphs.
5. Add native-to-backend reconciliation and carry-forward.
6. Run migration in dry-run mode and review its report.
7. Run the live pilot and correct discrepancies.
8. Retire `dashboard-focus-blocks.json` after the launch gate passes.

## Launch Gate

The rebuild is ready only when one task can be reviewed, scheduled, moved in native NotePlan, moved in the dashboard, edited, completed, refreshed, and confirmed absent without creating a duplicate at any point.
