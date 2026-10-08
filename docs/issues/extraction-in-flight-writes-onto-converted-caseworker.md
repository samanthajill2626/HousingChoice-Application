---
id: extraction-in-flight-writes-onto-converted-caseworker
title: An extraction run in flight can write tenant facts or new suggestions onto a contact just converted to a caseworker
type: bug
severity: low
status: open
area: app/extraction
created: 2026-10-08
refs: app/src/jobs/extraction.ts:457, app/src/services/extraction/apply.ts, app/src/services/caseworkerConversion.ts
---

**Problem.** Extraction skips a `partner` contact when a run STARTS
(`jobs/extraction.ts:457`), and the caseworker conversion (`feat/caseworkers`,
spec D19) supersedes every pending suggestion when it converts. But a run
that read the contact while it was still a tenant or unknown applies its
writes afterwards, unconditionally against its run-start snapshot - no
condition on the contact's type or classification revision. So in that
window (one run, seconds) a just-converted caseworker can gain a housing
authority the conversion removed on purpose, other tenant facts, or new
pending suggestions that will never resolve (a partner is never extracted
again). Accepted for branch B. RUNBOOK ("Caseworkers") says how to clean up:
`make` again supersedes the suggestions; an AI-written housing authority is
removed by hand.

**Suggested fix.** Make the apply layer's contact writes and suggestion
puts conditional on the run-start `classification_revision` (the fence the
conversion bumps, as the type drain already is), or re-read the contact's
type before applying and drop the run's output when it is no longer a
tenant or unknown.
