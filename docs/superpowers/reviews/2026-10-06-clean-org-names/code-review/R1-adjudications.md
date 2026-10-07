# Code review round 1 - adjudications (orchestrator)

- Branch feat/clean-org-names @81de4477 (all slices built; Phase 3 gates
  green pre-sync: typecheck 0, npm test 0, smoke 0, e2e 0 with 320 passed,
  eslint 25 errors all pre-existing at d839494a).
- Reviewers (opus, parallel, read-only): R1-CONF (spec conformance: 205
  CONFORMS, 3 PARTIAL, 0 MISSING, 4 DEVIATES-BY-RULING), R1-ADV-BE
  (plan-blind, app/: 0 CRITICAL, 0 HIGH, 1 MEDIUM, 3 LOW, 2 INFO), R1-ADV-FE
  (plan-blind, dashboard/ + e2e/: 0 CRITICAL, 1 HIGH, 2 MEDIUM, 5 LOW,
  2 INFO). The adversarial review was split by area because the diff is about
  20,000 lines; both halves swept the whole repo for other readers/writers.
- ONE fix wave, two sequential children: FW-A (backend) then FW-B
  (dashboard). Every fix is test-first (RED on today's code, GREEN after).

## Rulings

| finding | severity | ruling | where it goes |
|---|---|---|---|
| R1-ADV-FE-1 typed-but-unpicked text silently dropped on Save/Create | HIGH | FIX | FW-B B1 |
| R1-ADV-FE-2 listbox stays open after Tab; Escape then closes the whole dialog | MEDIUM | FIX | FW-B B2 |
| R1-ADV-BE-1 / R1-ADV-FE-3 a name added while a rewrite runs is rewritten away | MEDIUM | FIX (narrow refusal) | FW-A A1 |
| R1-ADV-BE-2 machine REMOVE of housingAuthority leaves `housingAuthority_source` (stale "Auto" badge) | LOW | FIX (one repo point) | FW-A A2 |
| R1-ADV-BE-4 cleanup audit append failure aborts the apply; permanent audit gap | LOW | FIX | FW-A A3 |
| R1-CONF-1 whitespace-only stored values reported nowhere | LOW | FIX the report only (dry-run count); the "Not on the list" skip is ACCEPTED (blank in all but bytes; legacy pre-trim data) | FW-A A5 |
| R1-ADV-FE-4 rewrite staleness judged on the browser clock | LOW | FIX | FW-B B3 |
| R1-ADV-FE-5 polls abort each other when a read takes over 2 s (was RE2-5) | LOW | FIX now - an empirical repro outweighs the earlier "precedent" reason for leaving it | FW-B B4 |
| R1-ADV-FE-6 spellings dialog drops an un-added draft on Save | LOW | FIX | FW-B B5 |
| R1-ADV-FE-7 "Use X" from the dialog still marks the chip "Not on the list" | LOW | FIX | FW-B B6 |
| R1-ADV-FE-8 NewOrgDialog stuck "Checking the list..." (latent) | LOW | FIX (one condition) | FW-B B7 |
| R1-ADV-FE-9 settle confirm understates normalized sibling rows | INFO | FIX (confirm copy counts siblings) | FW-B B8 |
| R1-CONF-2 a stale notice survives Settings "Add" (RE2-3 incomplete) | LOW | FIX + resolve the issue filed for it | FW-B B9 |
| R1-ADV-BE-3 PATCH {spellings} is a blind full-list replace | LOW | FILE (two admins / two tabs only; needs a version on the API) | FW-A A4 |
| R1-ADV-BE-5 a whole rename/merge pass runs inside one queue message | INFO | FILE (seconds at today's volume) | FW-A A4 |
| R1-ADV-FE-10 composer 422 with one candidate (a rename) says "pick it again" | INFO | FILE (current behavior conforms to D7 "asks for a new pick") | FW-A A4 |
| R1-ADV-BE-6 merge leaves records holding a spelling shared only with the target | INFO | ACCEPT - spec D11 ("spellings that no other entry shares"); those records surface in "Not on the list" resolved to the target, where Use settles them | - |
| R1-CONF DEVIATES-BY-RULING rows (U1, U2, B-2, I1 residual races) | - | already ruled in worklist.md; carried to the handback | - |

## Fix specifications

### FW-A (backend)

- A1 (R1-ADV-BE-1 / FE-3). `OrgNamesService.add` (inside its list mutate,
  so the check and the write see one item) refuses 409
  `{ error: 'org_rewrite_running', lastRewrite }` when a rewrite is running
  (`isOrgRewriteRunning(lastRewrite, now)`) AND the new name normalizes equal
  to one of that rewrite's `fromTexts`. Any other add during a rewrite still
  succeeds (adds are not rewrites; spec D10 lets everyone add). Narrow on
  purpose: it closes exactly the interleaving the reviewers reproduced (the
  pass matches normalized from-texts and would rewrite the new exact name);
  the cleanup lock carries no from-texts, and the cleanup only rewrites texts
  its own snapshot resolves - accepted residual. Tests: RED - a running Clear
  of "Metro HA" then add "Metro HA" -> 409; PIN - an unrelated add during the
  same rewrite succeeds; PIN - the same add after the rewrite finished
  succeeds; one route-level case through POST /api/organizations.
- A2 (R1-ADV-BE-2). `contactsRepo.rewriteOrgFields`: when
  `next.housingAuthority === null` (the REMOVE), also REMOVE
  `housingAuthority_source` in the same conditional UpdateItem (a REMOVE of an
  absent attribute is a no-op); the harness fake mirrors it. A value
  replacement keeps the stamp. Both the rewrite job (clear, move_to_agency)
  and the cleanup's move go through this one writer. Tests in
  `app/test/orgRecordWriters.integration.test.ts` (parity: fake and DynamoDB
  Local): RED - REMOVE drops the stamp; PIN - a replacement keeps it.
- A3 (R1-ADV-BE-4). `app/scripts/clean-org-names.ts`: wrap each
  `org_name_cleanup` audit append (contacts and units) like
  `orgRecords.ts` does: log WARN with the record key, count `auditFailed` in
  the result and print it in the summary, continue. Test: one append throws
  -> the apply completes (no PARTIAL, exit path unchanged), the record is
  rewritten, `auditFailed: 1`.
- A5 (R1-CONF-1). The cleanup dry run and apply summary also count records
  holding a whitespace-only `housingAuthority`, `agency` or
  `accepted_authorities` member (expected 0), printed beside the RG-5 count.
  Count only. One test.
- A4. File three issues (copy `docs/issues/_TEMPLATE.md`, status open,
  severity low): `org-spellings-patch-blind-replace` (R1-ADV-BE-3),
  `org-rewrite-single-message-pass` (R1-ADV-BE-5),
  `composer-org-422-offer-renamed-entry` (R1-ADV-FE-10); run
  `npm run issues`.

### FW-B (dashboard)

- B1 (R1-ADV-FE-1). Typed text is never silently dropped.
  - `OrgPicker` reports its uncommitted input text to the host (an optional
    callback, called with '' after a pick, a clear or an emptied input), and
    when the input loses focus while holding uncommitted text it shows an
    inline note under the input (copy in `orgCopy.ts`, linked with
    `aria-describedby`): "Not saved - pick a name from the list, or clear the
    text."
  - Tenant form (both pickers) and both property forms: on submit, for each
    picker holding uncommitted text - if the text normalizes
    (`normalizeOrgText`) equal to exactly one entry NAME of the picker's
    kinds, or to a spelling carried by exactly one such entry, commit that
    entry's exact name as a pick would (single: replace; multi: add,
    de-duplicated) and go on with the save; otherwise BLOCK the save, show
    "Pick a name from the list, add it as new, or clear the text." under that
    picker (`role="alert"`), focus its input, send nothing. A committed value
    equal to the current one stays unchanged (the tenant form still never
    sends an unchanged housingAuthority).
  - The composer keeps its commit-only-on-pick rule (spec D7, section 7):
    only the blur note applies there.
  - Enter with nothing highlighted still submits; the guard above handles it.
  - Tests per form: exact name typed -> sent; unique spelling typed ("DCA")
    -> "Georgia Department of Community Affairs" sent; ambiguous ("AHA") or
    unknown text -> nothing sent, alert shown, input focused; OrgPicker: the
    callback and the blur note.
- B2 (R1-ADV-FE-2). `OrgPicker` closes its listbox when focus leaves the
  field (blur whose `relatedTarget` is outside the listbox; options already
  keep focus on mousedown). Test: type "AHA", Tab -> the listbox is gone and
  `aria-expanded` is false.
- B3 (R1-ADV-FE-4). `useOrgAdmin` / `OrgListSection` judge the heartbeat with
  `serverNowMs()` (`dashboard/src/api/serverClock.ts`) in
  isRewriteLive / canRunAgain / the status text. Test with a skewed browser
  clock.
- B4 (R1-ADV-FE-5). The poll never aborts its own previous read: schedule
  the next poll after the previous read settles, or skip a tick while one is
  in flight. Keep it StrictMode-safe and keep the StrictMode test green.
  Test: reads take 60 ms with pollMs 25 -> the status still advances.
- B5 (R1-ADV-FE-6). SpellingsDialog Save folds a non-empty draft into the list
  first (same validation as Add) and skips the PATCH when nothing changed.
- B6 (R1-ADV-FE-7). After "Use X" in "Is this really new?" (onUse /
  onUseOtherField in the three forms) the used name counts as on the list at
  once (as `noteAdded` does for an added entry; extend it to an `OrgRef` if
  needed) - no "Not on the list" mark.
- B7 (R1-ADV-FE-8). `NewOrgDialog` skips the check only when the stored
  check belongs to the current trimmed text.
- B8 (R1-ADV-FE-9). Settle confirms count every row of the same field whose
  value normalizes equal (count + deleted) and name the sibling values when
  there is more than one.
- B9 (R1-CONF-2). `OrgListSection` `onAdded` clears the notice; test; resolve
  `docs/issues/org-settings-notice-stale-after-add.md` (status resolved,
  `resolved: 2026-10-07`, a Resolution paragraph naming the fix commit).
