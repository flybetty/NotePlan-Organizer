# NotePlan Workflow Prototype

This static prototype displays a verified snapshot from the August 6, 2026 Gmail and Google Calendar pilot. It does not make live API calls, and every email task and calendar block links to its source. Review decisions are stored only in browser `localStorage`.

No fictional fallback content is displayed. The active and waiting sections remain empty until a review decision is made; NotePlan tasks remain explicitly unavailable until the plugin is connected.

## Run

Open `index.html` in a browser or serve this directory with any static file server.

## Test

```sh
node --test app.test.mjs
```

The tests cover unlimited valid-task retention, Friday-to-Monday carry-forward, email task creation, non-actionable email exclusion, and thread-level deduplication.
