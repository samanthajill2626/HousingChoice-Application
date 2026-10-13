# Planner fix wave 2 - orchestrator decisions (binding on the fix child)

Source: `planner-review/adjudications.md` (round 2 and Cameron's 2026-10-13 ruling: FW2-1..FW2-4),
`adversarial-r2.md` findings 1-3, spec revision 6 (@b40ee312) D10. Scope is the backfill script,
its test and RUNBOOK.md ONLY - no app/src change.

1. Dismissed Atlanta (FW2-2) - the AI suggest path's own rule, verified in the code:
   `putSuggestionSafe` (`app/src/services/extraction/apply.ts:824-850`) builds the keys
   `normalizeSuggestionValue(target, value)` plus the same function over each text in
   `alsoDismissedAs`, de-duplicated, and calls `extraction.hasDismissal(contactId, target, key)`
   for each (`app/src/repos/extractionRepo.ts:739-744`: one GetItem on the
   `dism#<contactId>#<target>#<key>` tombstone). For a housing authority `alsoDismissedAs` is
   the model's own text plus the matched entry's spellings that resolve to THAT entry alone
   (`apply.ts:281-288`: `resolveOrgText(entries, spelling, KINDS_FOR_FIELD.housingAuthority)`
   is a match with the same orgId - ruling B-3, so the shared "AHA" (Atlanta and Augusta) does
   NOT count). The backfill has no model text, so its keys are: the normalized name "Atlanta
   Housing Authority" plus each of its own spellings that resolves to it alone, taken from the
   org-list item the run already reads. The script CALLS `normalizeSuggestionValue`,
   `resolveOrgText`/`KINDS_FOR_FIELD` and `extraction.hasDismissal` - the same functions, not
   copies; the only composition it repeats is apply.ts's four-line spelling filter, which is
   not exported (exporting it would touch app/src, out of scope). Any key with a tombstone
   leaves the lead out: "staff dismissed an Atlanta Housing Authority suggestion".
2. In-flight resolution (FW2-3): `createSuggestionResolutionRepo(...).get(contactId,
   'housingAuthority')` (consistent read of `resolve#<contactId>#housingAuthority` in the
   extraction table); `state === 'active'` leaves the lead out: "a suggestion accept or
   dismiss is in progress - re-run after it finishes". A `completed` journal does not.
3. PRECEDENCE, extended (one reason printed; every reason leaves the lead out):
   1. skipped (named in --skip on this run) - no read;
   2. excluded_earlier;
   3. signed_up_again;
   4. authority_history;
   5. resolution_in_progress (NEW) - a live staff action on this very field; re-run soon;
   6. pending_suggestion;
   7. dismissed_atlanta (NEW) - a past staff decision on this exact value.
   Reads 5-7 happen only for a candidate nothing earlier leaves out, in that order, stopping at
   the first hit. A failed read of any of them = `read_failed`, "nothing written" (true).
4. Exclusions first (FW2-1): on --apply, after the Scan and the typo refusal and BEFORE any
   other per-candidate read or any write, a first pass records the exclusion for every
   candidate named in --skip (the existing no-duplicate check, the append-anyway-on-a-failed-
   history-read rule). If ANY append failed, the run STOPS before any write: no target is
   read or written, the report lists the leads whose exclusion may not have been recorded,
   says nothing was written for any lead, and the run exits 1. A dry run records nothing.
5. RUNBOOK: keep the same `--skip` value for EVERY run on that environment, always (dry runs
   and applies, re-runs and retries included); remove "no longer needed" and any "apply again"
   that omits it; the two new reasons in the list in precedence order; the exclusions-first
   stop; FW2-4's wording.
6. FW2-4: the post-write audit warning says the `housing_authority_backfill` event "may not
   have been written" (the authority WAS set).
