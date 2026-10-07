# Code review round 3 - adjudications (orchestrator)

- Fresh re-reviewers on fix wave 2 (FW2-A c15ae9a7..f9d0fa29, FW2-B
  e03d39aa..5848ff6d), plan-blind. R3-BE: 0 CRITICAL, 0 HIGH, 0 MEDIUM,
  2 LOW, 2 INFO ("the claim is sound for what A6 targeted"). R3-FE: 0
  CRITICAL, 0 HIGH, 1 MEDIUM (a pre-existing composer race), 3 LOW, 4 INFO.
  Every wave-2 fix is real (B14 and B16 empirically, against the pre-fix
  hooks from git).
- The loop is converging (round 1: 1 HIGH + 3 MEDIUM; round 2: 4 MEDIUM;
  round 3: 1 MEDIUM, pre-existing). Wave 3 fixes the remaining items with a
  real user-visible outcome and the one-line ones; the narrow races go to
  docs/issues. Wave 3 then gets ONE fresh reviewer on its diff; after that,
  any LOW/INFO is filed, not fixed - only a MEDIUM+ regression introduced by
  wave 3 reopens the loop.

## Rulings

| finding | severity | ruling | where |
|---|---|---|---|
| R3-FE-1 a filter changed while a Preview is in flight: Send posts the pre-change candidates to the new filtered draft | MEDIUM (pre-existing mechanism; the new picker is one more trigger) | FIX - cheap, and its outcome is a text to the wrong tenants | FW3-B B20 |
| R3-FE-3 under a failed list read, typed text is skipped and Save/Create succeeds without it (challenge to B10) | LOW | FIX - the last path to R1-ADV-FE-1's harm; challenge upheld | FW3-B B21 |
| R3-FE-5 a failed list read marks every stored chip "Not on the list" | INFO | FIX (one condition) | FW3-B B22 |
| R3-FE-6 a refusal outlives its cause | INFO | FIX (one expression) | FW3-B B23 |
| R3-FE-8 hint and note run together for a screen reader | INFO | FIX (a period) | FW3-B B24 |
| R3-BE-4 a refused claim leaves Settings offering a Run again that must 409 | INFO | FIX (dashboard side) | FW3-B B25 |
| R3-BE-1 a claimed pass can write under a lock that lapses DURING the pass | LOW | FIX (beat before each write + a local lease) | FW3-A A11 |
| R3-BE-3 the dry run counts a property twice for a repeated unresolved member | INFO | FIX (it is the preview reviewed with Sam) | FW3-A A12 |
| R3-BE-2 a conditional write the SDK retried after it landed reads as a lost race | LOW (pre-existing SDK semantics; self-healing; no record data lost) | FILE | FW3-A A13 |
| R3-FE-2 a provisional entry outlives a concurrent rename | LOW (narrow race; saving the old name is safe - D5 resolves it as a spelling) | FILE | FW3-A A13 |
| R3-FE-4 a hung Settings details read blocks later ones | LOW (stale page, not bad data; server guards refuse settles that no longer apply) | FILE | FW3-A A13 |
| R3-FE-7 a wrapping note still reflows at phone width | INFO (plausible; layout) | FILE - checked in live self-QA at 360 px | FW3-A A13 |
| R3-BE observation: re-validate on EVERY claim, not only a lapsed one | INFO | ACCEPT as is - the A6 tests pin the lapsed-lock rule; cross-host skew on AWS is milliseconds | - |

## Fix specifications

### FW3-A (backend)

- A11 (R3-BE-1). (1) `OrgRecordsService.rewrite` calls its heartbeat check at
  the TOP of each record iteration, before matching and writing (the cleanup
  already beats before each row) - a record is never written after a stall
  without a lock check. (2) A local lease in the job's heartbeat wrapper and
  in the cleanup's beat: remember when a heartbeat last answered true; once
  that is `ORG_REWRITE_STALE_MS` minus 60 s old, a heartbeat that THROWS
  counts as lost (job: `lock_lost`, no finish; cleanup:
  `CleanupLockLostError`). Fix the two overclaiming comments/doc lines the
  reviewer names (jobs/orgRewrite.ts header, the RUNBOOK lock paragraph).
  Tests: the reviewer's two interleavings (a stall before a write; every
  heartbeat throwing past the lease) -> the VA's exact-name record survives.
- A12 (R3-BE-3). The cleanup's leftover preview de-duplicates a unit's
  leftovers per (field, value) before tallying, and counts a kept agency
  member once per property.
- A13. File four issues (copy `_TEMPLATE.md`, status open, severity low):
  `org-list-write-retry-reads-as-lost-race` (R3-BE-2),
  `org-provisional-entry-concurrent-rename` (R3-FE-2),
  `org-settings-details-read-no-age-cap` (R3-FE-4),
  `org-picker-note-wrap-reflow` (R3-FE-7); run `npm run issues`.

### FW3-B (dashboard)

- B20 (R3-FE-1). The composer freezes the audience while a Preview is in
  flight (AudienceFilters - picker, chips, voucher chips - disabled while the
  preview loads), AND `onPreview` discards a result whose draft is no longer
  the current one (or whose recreate is pending) with "The audience changed -
  preview again." (copy beside the composer's other copy). Both halves; tests
  for each (pick during a held preview -> no review of stale candidates, no
  send of them).
- B21 (R3-FE-3). One typed-text rule under a failed list: when entries are
  still in hand (a failed RE-read), settle against them as usual; when no
  list ever loaded, keep the picker's input ENABLED while it holds text
  (clear-only - no options, no add step) and refuse Save/Create with "The
  list did not load - clear the text to save without it." A form never blocks
  on a field staff cannot edit, and never drops typed text silently. Update
  the tests that pinned "Create goes on without it" and the comment at
  UnitCreateForm.tsx:81.
- B22 (R3-FE-5). No "Not on the list" mark while the list is unknown (failed
  with nothing in hand).
- B23 (R3-FE-6). After a refused Save, the alert shows the CURRENT verdict's
  refusal (or none once the text settles).
- B24 (R3-FE-8). The Housing authority hint ends with a period (update the
  assertion that pins the joined description).
- B25 (R3-BE-4). A rewrite that failed with an error starting
  `org_rewrite_target_gone` shows "The list changed since this update started,
  so it cannot run again - start a new one from the list." and is not offered
  Run again.
