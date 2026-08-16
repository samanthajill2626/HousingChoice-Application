---
id: ai-run-detail-drops-skip-reason
title: The AI run detail pane renders no skipReason, so a skipped run shows no cause
type: bug
severity: low
status: open
area: dashboard
created: 2026-08-15
refs: dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx, app/src/jobs/extraction.ts
---

**Problem.** `AiRunDetail` renders the header, window, decision ledger, raw text and parsed
result, but never reads `run.skipReason`. A run with outcome `skipped` therefore displays the
word "skipped" and nothing that says *why* - `no_contact`, `ineligible_type`, `no_new_client`
or `empty_window` are all stored on the record and returned by the API, then dropped at render.

This is the same defect as the missing `run.error` block, found while fixing that one on
`fix/extraction-max-tokens`. The error half was fixed there because a failed run was the
active production incident; the skip half was deliberately left out of that change rather than
widen a hotfix. It is lower severity - a skip is a normal, non-alarming outcome - but it has
the same cost: an operator reading the log cannot tell a deliberate skip from a mystery, and
`no_contact` vs `ineligible_type` are very different stories about the same conversation.

**Suggested fix.** Render `run.skipReason` beside the failure block in `AiRunDetail`, reusing
`humanizeEnum` and a neutral (not danger) treatment, since a skip is not an error. Cover it in
`AiRunsSection.test.tsx` alongside the failure-block tests.
