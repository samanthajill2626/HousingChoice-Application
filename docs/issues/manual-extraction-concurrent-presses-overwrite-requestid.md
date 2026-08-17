---
id: manual-extraction-concurrent-presses-overwrite-requestid
title: Two operators pressing Run AI extraction on one contact overwrite each other's requestId, so the first indicator can only time out
type: decision
severity: low
status: wontfix
area: app/extraction
created: 2026-08-16
refs: app/src/repos/extractionRepo.ts:270, app/src/routes/contacts.ts:2014, dashboard/src/routes/contact/ContactDetail.tsx:88, docs/superpowers/specs/2026-08-13-manual-extraction-trigger-design.md
---

**A deliberate, specified design, not a bug.** Design section 5: "Two presses in
quick succession slide the single due row forward; one run happens. Existing
debounce behavior, correct here." Filed here so the operator-visible half of
that decision is in the registry.

**Behaviour.** Each press mints one `requestId`
(`app/src/routes/contacts.ts:2014`) and `requestManualExtraction`
(`app/src/repos/extractionRepo.ts:270`) writes it onto the due row as a sliding
upsert - last writer wins. So when two presses land on the same contact before
the poll claims the row (two operators, or one operator on two tabs), one run
happens and it carries only the SECOND press's id. The second operator's
indicator resolves normally. The first operator's indicator never sees a
matching `ai_run.completed`, so it sits until `RUN_INDICATOR_TIMEOUT_MS`
(180s, `dashboard/src/routes/contact/ContactDetail.tsx:88`) and then reads
"Still running - check Settings > AI runs."

**Why that is the right degradation.** The collapse itself is the point: it is
what stops a burst of presses billing a model call each. And the timeout copy is
built for exactly this - design 4.6 requires that "the indicator must never
claim an outcome it did not observe". The first operator is told to look at the
run log, where the run they caused is recorded. Nobody is told something false,
and nothing is billed twice.

**A related sub-case, same outcome.** A completion event that arrives before its
own POST response has filled in the `requestId` also cannot match (the state
holds `''` until then, and no event matches an empty key). That requires the
worker poll to beat an in-process HTTP response; it degrades to the same
timeout.

**If it is ever reopened.** The fix is not a second `requestId` slot on the row
- it is the recovery path design 4.6 already costed and rejected: query the run
log by contact since the press timestamp (the `byEntity` index supports it) and
resolve the indicator from the record instead of the event. That is machinery
bought for a rare case on a wait measured in tens of seconds.
