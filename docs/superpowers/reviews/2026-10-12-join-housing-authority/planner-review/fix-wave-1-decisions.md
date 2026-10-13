# Planner fix wave 1 - orchestrator decisions (binding on the fix children)

Source: `planner-review/adjudications.md` (fix wave list FW-1..FW-5) and spec revision 5
(@09acd16b: D10 additions, D12). These are the orchestrator's calls where the list leaves a
choice open; each states its reason.

## Backfill (FW-1, FW-2, FW-3)

1. "Pending" suggestion (FW-2), verified in `app/src/repos/extractionRepo.ts`: a suggestion
   is ONE row `sugg#<contactId>#<target>` that exists only while pending - accept and dismiss
   DELETE it (`deleteSuggestion*`), and a dismissal is a separate tombstone row
   (`putDismissal`, a `dism...` id, never returned by `getSuggestion`). So "pending" =
   `getSuggestion(contactId, 'housingAuthority', { consistentRead: true })` returns an item;
   the reason prints that item's `suggestedValue`, escaped like report names.
2. Left-out reasons and their PRECEDENCE (every reason leaves the lead out; precedence only
   picks the ONE reason printed):
   1. `skipped` - named in --skip on THIS run ("named in --skip");
   2. `excluded_earlier` - holds a `housing_authority_backfill_excluded` event ("excluded on
      an earlier run");
   3. `signed_up_again` (unchanged);
   4. `authority_history` (unchanged);
   5. `pending_suggestion` ("has a pending housing authority suggestion (<value>) - accept or
      dismiss it first").
   Reason: the operator's explicit decisions first (this run's, then an earlier run's), then
   the facts in the audit trail, then the live suggestion. The suggestion read happens only
   for a candidate no earlier reason leaves out (one GetItem per would-be target). Every
   candidate's whole audit history is read, --skip ones included, so an --apply knows
   whether an exclusion is already recorded.
3. Persisted exclusion (FW-1): on `--apply`, each candidate left out as `skipped` gets ONE
   `housing_authority_backfill_excluded` audit event, payload
   `{ field: 'housingAuthority' }`, no actor - unless its history already holds one
   (re-runs add no duplicates). A dry run records nothing. If that append FAILS, the lead's
   line says the exclusion could not be recorded, it counts as failed (exit 1): an
   unrecorded exclusion is exactly the A4 hazard, so it must not pass as clean. The new
   event type is NOT authority history (`touchesHousingAuthority` stays false for it).
4. `--skip` ids (FW-1): the candidate Scan already reads every contact row, so the set of
   existing contactIds (pointer rows excluded) comes from that Scan - no extra reads. An id
   in no row: a dry run reports it on its own line; `--apply` REFUSES after the Scan and
   before any write (`BackfillRefusedError`, exit 1, message names the ids). An id naming an
   existing non-candidate (deleted, already holding an authority, not a /join lead): reported,
   ignored, as before. A deleted contact is an existing contact.
5. Failure wording (FW-3): a non-conditional WRITE error -> the lead's line reads
   "FAILED: the write may or may not have landed (an ERROR line names this contactId) -
   re-run the dry run to see"; its log line likewise never says "nothing written". A failed
   history or suggestion READ keeps "FAILED: nothing written ... re-run" (true: no write was
   attempted). Both exit 1. The audit event stays a separate best-effort append (planner A9
   ruling).

## Settings note (FW-4, spec D12)

6. The help line "Housing authority names appear on the public sign-up form." goes on every
   UI surface that ADDS, RENAMES, or RE-KINDS an organization-list entry INTO a housing
   authority, shown only while the entry is or will become a housing authority. If one of
   those surfaces is a component shared with the record forms' "Add as new" (contact,
   listing, caseworker), the line shows there too: the publication consequence is identical
   wherever the entry is added, and the spec's purpose is that staff adding an authority
   know it goes public (both readings honor D12's intent; the superset is chosen).
   Agencies show nothing new. Copy only.

## Issues (FW-5)

7. Delete `docs/issues/join-repeat-signup-answer-unreachable.md` and its LIVE references
   (RUNBOOK, other docs/issues, code comments); mission records stay as history. Resolve
   `docs/issues/join-backfill-ignores-pending-authority-suggestion.md` (status resolved,
   `resolved: 2026-10-12`, a Resolution paragraph naming the FW-2 commit).
