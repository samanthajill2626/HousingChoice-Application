---
id: extraction-runwindow-module-cycle
title: extraction job and runWindow import each other, and the API route pulls the job graph in
type: debt
severity: low
status: open
area: app/extraction
created: 2026-08-09
refs: app/src/services/extraction/runWindow.ts:5, app/src/jobs/extraction.ts:45, app/src/routes/aiRuns.ts:14
---

**Problem.** Two structural imports that work today but are fragile.

1. **Import cycle.** `app/src/services/extraction/runWindow.ts:5-12` imports six
   window constants (`MAX_TRANSCRIPT_AGE_DAYS`, `MAX_TRANSCRIPT_MESSAGES`,
   `NEW_MESSAGE_CHAR_CAP`, `SEEN_MESSAGE_CHAR_CAP`, `TRUNCATION_MARKER`,
   `WINDOW_CHAR_BUDGET`) from `../../jobs/extraction.js`, while
   `app/src/jobs/extraction.ts:45` imports `buildFullRunWindow`,
   `buildLightRunWindow` and `WindowMessagePieces` back from
   `../services/extraction/runWindow.js`. The cycle resolves only because every
   imported constant is read inside a function body. The moment either side
   reads one of those bindings at module top level (a derived constant, a frozen
   config object, a default parameter evaluated at load), the import order
   decides whether it is initialized, and one direction is a TDZ
   `ReferenceError` at process start.

2. **Layering.** `app/src/routes/aiRuns.ts:14` imports `capUtterances` and
   `toUtterances` from `../jobs/extraction.js`, so loading the read-only admin
   API router drags `applyExtraction` and the entire extraction adapter/job
   graph into the API process, which never runs extraction.

Both were called out as watch items in the plan and neither breaks anything at
HEAD.

**Suggested fix.** Move the shared window constants (and `capUtterances` /
`toUtterances`, which are pure transcript helpers) out of `jobs/extraction.ts`
into a leaf module - `services/extraction/runTypes.ts` or a new
`services/extraction/windowLimits.ts` - and have the job, `runWindow.ts`, and
`routes/aiRuns.ts` all import downward from there. That breaks the cycle and
stops the route from depending on the job.
