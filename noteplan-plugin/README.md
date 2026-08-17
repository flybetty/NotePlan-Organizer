# Work Activation Assistant NotePlan Plugin

NotePlan is the only user interface and output for the assistant.

Version 0.17 stores approved work as native NotePlan task paragraphs. Dashboard blocks are views of those same paragraphs, so timeline dragging, resizing, editing, completion, and weekday carry-forward stay synchronized.

## Daily use

1. Open the daily note and click **🟢 OPEN WORK DASHBOARD**.
2. Review email suggestions with **Today**, **Schedule**, **Waiting**, **Completed**, **Edit**, or **Ignore**.
3. Waiting items stay in one compact panel. A new incoming reply automatically returns the original task to the next available work block with a visible `↩` marker.
3. Drag or resize gold focus blocks, use **Edit** to rename them, and use **✓** to complete them.
4. Answer one project question at a time to maintain the **Main Projects** list.

Opening the dashboard refreshes Gmail, Calendar, NotePlan tasks, and project status. Unchecked active tasks remain active on the next workday.

The plugin uses NotePlan APIs and does not edit CloudKit files directly.
