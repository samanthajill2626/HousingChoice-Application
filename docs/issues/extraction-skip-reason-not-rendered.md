---
id: extraction-skip-reason-not-rendered
title: The manual-run banner carries skipReason but never renders it, so a no_contact skip reads as "nothing new to extract"
type: decision
severity: low
status: deferred
area: dashboard/extraction
created: 2026-08-16
refs: app/src/lib/events.ts:275, app/src/jobs/extraction.ts:426, app/src/jobs/extraction.ts:499, dashboard/src/routes/contact/ContactDetail.tsx:968, docs/superpowers/specs/2026-08-13-manual-extraction-trigger-design.md
---

**Conformance, not a defect.** Design section 4.6 enumerates exactly three
resolutions for the manual-run indicator plus the `truncated` special case, and
puts every `skipped` outcome under "Ran - nothing new to extract". The dashboard
renders precisely that. Filed so the known imprecision is in the registry rather
than only in a review transcript.

**Behaviour.** `ai_run.completed` carries an optional `skipReason`
(`app/src/lib/events.ts:275`), populated from the job's four skip arms:
`no_contact` (`app/src/jobs/extraction.ts:426`), `ineligible_type` (`:435`),
`no_new_client` (`:493`) and `empty_window` (`:499`). The contact page's reducer
never reads it - `extractionAppliedCopy`
(`dashboard/src/routes/contact/ContactDetail.tsx:968`) branches on counts only -
so all four collapse into one sentence.

**Why it matters a little.** `no_new_client` and `empty_window` genuinely mean
"nothing new to extract", so the copy is accurate for them. `no_contact` and
`ineligible_type` do not: they mean the run could not resolve the thread back to
an eligible contact at all, which is a data problem the operator could act on,
and the banner reports it as a clean no-op instead.

**How reachable is it from THIS button?** Less than it looks. The endpoint has
already resolved the contact and filtered to `tenant_1to1` / `unknown_1to1`
before it queues anything, so `ineligible_type` should not fire on a manually
queued row. `no_contact` is a different resolution (the JOB resolving a
conversation back to a contact, not the route resolving a contact to its
threads), so it is not strictly excluded by the route's checks - it was not
traced. Either way, the AI run log at Settings > AI runs records the skip reason
for every run, so the fact is never lost, only absent from the banner.

**Suggested fix, if picked up.** One extra copy branch for the two
resolution-failure reasons ("This thread is not linked to an eligible contact"),
leaving `no_new_client` / `empty_window` on the existing sentence. It is a
dashboard-only change and needs no server work - the reason is already on the
event.
