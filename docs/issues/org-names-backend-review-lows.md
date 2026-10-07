---
id: org-names-backend-review-lows
title: Organization-name backend - low findings from the final independent review (parity, generic names, lock scope, value cap, rewrite-window hint)
type: debt
severity: low
status: open
area: app
created: 2026-10-07
refs: app/scripts/clean-org-names.ts, app/src/services/orgRecords.ts, app/src/services/orgRewrite.ts, app/src/services/orgNames.ts, app/src/lib/orgNames.ts, app/src/routes/organizations.ts, app/src/routes/broadcasts.ts
---

**Problem.** The final independent review of `feat/clean-org-names` (plan-blind backend
reader; report `docs/superpowers/reviews/2026-10-06-clean-org-names/final-review/adversarial-backend.md`,
rulings in `final-review/adjudications.md`) found these LOW items. None changes stored data
wrongly today; each is a sharp edge worth one small-fix branch. Grouped here because they
share one area and one review; pick them off individually.

1. **"Move to agency" parity (LOW-7; also conformance row 3).** The Settings Move / Split
   actions (`orgRecords.ts` planContactRewrite) treat a whitespace-only Agency, or an
   Agency that is a SPELLING of the target agency, as a conflict and leave the record; the
   cleanup script (`clean-org-names.ts` planContact) treats both as free and moves the
   housing authority. Both are safe; the in-app rule is the stricter. Make them one rule
   (the script's, which also rewrites the spelling to the exact name) in one shared planner.
2. **A generic one-word entry poisons compound detection (LOW-2).** `checkNewName`
   (`services/orgNames.ts`) accepts a name such as "Housing", "County" or "The"; once two
   such entries exist, a legitimate new name containing both words ("Cobb County Housing
   Office") is refused as COMPOUND (D4). Suggested guard: refuse a new name or spelling whose
   normalized words are ALL in `GENERIC_WORDS` (`lib/orgNames.ts`), with its own code.
3. **Spelling edits during the cleanup apply (LOW-3).** The lock (`acquireForCleanup`)
   blocks rename, merge and the Not-on-the-list actions, but an admin may still edit
   spellings while the apply runs; the apply resolves against the list it read when it took
   the lock, so a spelling moved mid-run is overridden for every remaining record. Either
   refuse spelling edits while a rewrite runs (one more `org_rewrite_running` site) or
   re-read the list per page. The RUNBOOK already says to add spellings BEFORE the apply.
4. **`POST /api/organizations/not-on-list/resolve` accepts an unbounded `value` (LOW-4).**
   It is persisted on the shared `org-list` item as `lastRewrite.fromTexts` and carried by
   every list read and Settings poll until the next rewrite. Admin-only, and the value comes
   from a stored row, so the exposure is small; cap it (the `POST /check` text cap is 200,
   stored legacy values may be longer - 500 is safe) with a 400.
5. **No composer hint while a rewrite is running, failed or stalled (LOW-6).** Spec D11
   states the window: a blast filtered on the new name misses tenants not yet rewritten.
   Nothing in the composer or the preview says a rewrite is in flight. Show the Settings
   status line's state in the composer when `lastRewrite.status === 'running'` (one extra
   read of the list item the composer already holds).

**Suggested fix.** One small-fix branch, items in the order above; each has a unit-test seam
already (`cleanOrgNames.test.ts`, `orgNamesService.test.ts`, `orgRewriteService.test.ts`,
`organizationsApi.test.ts`, the composer tests).
