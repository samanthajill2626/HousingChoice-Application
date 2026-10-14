# Handback - primary-contact integrity, planner fix wave 3

Build orchestrator (Fable 5.1, AUTO mode), 2026-10-13 (local; 2026-10-14
UTC). Branch `feat/primary-contact-integrity`, worktree
`W:\tmp\primary-contact-integrity`. Follows `handback.md` (the build) and
the two code-review fix waves; this wave builds the planner's Cameron-ruled
findings list `planner-review/fix-wave-findings.md` (F1-F5) and nothing
else. No reviewer round of mine, by ruling - the planner continues its own
two reviewers on this wave.

**MERGE-READY @d3f5089d** (the gated code tip; the branch tip is this
handback plus the self-QA record, docs-only on top) on
`feat/primary-contact-integrity` (`W:\tmp\primary-contact-integrity`),
**6 behind `main`** (drift after the one sync, see below), **UNMERGED
(human gate)**.

## Per work-map item

| Item | State | Commits | What shipped |
|---|---|---|---|
| F1 - the box's one-click names an `autoEligible` row only | shipped | `7aea785a`, `2b133dab`, `30005052`, `0ae9096a` (+ `4e430a6e` for the two extra spec sentences) | Response-only `autoEligible?: true` on `UnitContactView`, set in `enrichRosterView` from its complete read (`isAutoRoutingEligible`), absent on an incomplete read, never stored; the dashboard row type and the `listingRoster` pass-through; the box's FOUR cases exactly as ruled (one -> `Make <Name> primary`; two or more -> `Choose a primary`; none but a live non-caseworker row -> the line AND `Choose a primary`; none -> the line only); edit mode's per-row Make primary unchanged (type-agnostic); the three script `noEligible` strings verbatim and all three pinned; RUNBOOK 506/511/512/516 (step 4 rewritten); spec 7.4 / 7.5 / 8; selectors.md:88 |
| F2 - deleting the landlord of record of a NO-flag roster hands off | shipped | `f18ac75f`, `4e430a6e` | ONE exported pure predicate `contactIsPrimaryToHandOff(unit, contactId)` beside `landlordWasPrimary` (`app/src/repos/unitsRepo.ts:900`): the landlord of record (non-empty `landlordId`) -> `landlordWasPrimary(unitContacts(unit), contactId)`, anyone else -> their row is the flagged primary; used by the Scan (`services/primaryHandoff.ts:97`), `handOffPrimaryFrom`'s consistent re-check which every retry re-runs (`unitsRepo.ts:1784`) and the FakeWorld mirror (`twilioWebhookHarness.ts:3312`) - no copies. `chooseHeir` still excludes the deleted contact (its `usable()` returns undefined for the excluded id at the landlord step too, so the deleted landlord of record is never its own heir), `landlordId` unchanged, the audit row `handoff_on_delete { from: <deleted landlord> }`. Spec 4.6 both bullets (restore and delete AGREE); `docs/issues/primary-handoff-no-flag-landlord-delete-gap.md` resolved with a dated Resolution naming `f18ac75f`; comments swept in `primaryHandoff.ts`, `unitsRepo.ts`, `routes/contacts.ts`, `ContactDetail.tsx`; spec 9.2 checked (does not restate the asymmetry) and GLOSSARY checked (no contradicting sentence) - both unchanged |
| F3 - the no-eligible line | shipped | `4d4f4a41`, `0ae9096a` | `Add a property manager or owner - they become the primary automatically.` in `NO_ELIGIBLE_LINE`, its test pins, spec 7.4, selectors.md:88, RUNBOOK step 4; a sweep of live files finds the old string nowhere |
| F4 | NO change, as ruled | - | - |
| F5a - consistent restore reads | shipped | `fc7607de`, `4e430a6e` | `getManyByIds(ids, { requireComplete?, consistentRead? })`; `batchGetByIds` spreads `ConsistentRead: true` into the contacts table's `RequestItems` entry on EVERY request of the walk (each chunk, each UnprocessedKeys retry) only when asked; `readRosterContacts(contacts, ids, logger?, opts?)`; the restore route's two reads ask for it (`clearedLandlordHeir` `units.ts:708`; the `readContacts` handed to `restoreWithLandlord` `units.ts:2434`); every other caller unchanged (`enrichRosterView` :653, the roster write :1747, the remove route :1858, `primaryHandoff.ts:110`, the script). FakeWorld `getManyByIds(contactIds, _opts)` mirrors the signature. Pins: new `app/test/contactsRepoConsistentBatchRead.test.ts` (ConsistentRead when asked, on a second chunk and on a retry; absent by default / with `requireComplete` alone / with `false`; never on the display reads), `propertyContact.test.ts` pass-through, `unitsRestoreLandlord.test.ts` PIN + swap case, a DynamoDB Local acceptance case. `docs/issues/roster-liveness-read-eventual-consistency.md` dated Update, `refs:` refreshed, stays OPEN narrowed; spec 4.2 one bullet |
| F5b - the Delete-dialog sentence | shipped | `b5561c2c`, `4e430a6e` | `...takes over when someone can, and restoring them won't change that back.` in `ContactDetail.tsx`, its test pin, spec 7.6 |

Orchestrator addition, adjudicated after implementer A's report: spec 4.4
(the 470 Bolton sentence) and spec 10 (the box test paragraph) still stated
the OLD box rule outside the sections F1 named; ruled part of F1's spec
amendment (the spec must not contradict itself) and amended in `4e430a6e`.

## Gates on the final code tip `d3f5089d` (bare, redirected, real exit codes)

| Gate | Exit | Quoted result | Log |
|---|---|---|---|
| `npm run typecheck` | 0 | 0 `error TS` lines, every workspace | `.superpowers/sdd/fixwave3-gate1-typecheck.log` |
| `npm test` | 0 | `Test Files 507 passed (507)` app, `248 passed (248)` dashboard, `22 passed (22)` e2e workspace, `34 passed (34)`, `13 passed (13)`; `[dynamoAdmin]` lines: 0 | `.superpowers/sdd/fixwave3-gate2-npmtest.log` |
| `npm run smoke` | 0 | `smoke-dist: OK - 1705 import specifier(s) across 296 emitted file(s) resolve under plain Node.` | `.superpowers/sdd/fixwave3-gate3-smoke.log` |
| `timeout 2700 npm run e2e` | 0 | `362 passed (21.8m)` | `.superpowers/sdd/fixwave3-gate4-e2e.log` |
| `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` (90 files) | 1 | `TourDetail.tsx 342:85 error Cannot call impure function during render` - the ONE pre-existing error, identical on the merged base `ebdd025d` before any wave edit (the mission block names it as baseline); nothing else | `.superpowers/sdd/fixwave3-gate5-eslint.log` |

All five green on ONE commit. The same battery minus e2e was also green on
the merged base before the build (`ebdd025d`: typecheck 0, smoke 0,
npm test 0 with app 506 files, eslint the same single error), so every
wave regression would have shown against a green baseline. No flake seen:
e2e 362/362 on its first run, npm test clean on both runs.

## The one `main` sync - done FIRST, and the drift since

`main` had advanced 113 commits past the branch (the last-heard-from
mission landed) into exactly this wave's files, with six conflicting files
in a `merge-tree` preview, so the single permitted sync was taken BEFORE
the build: merge commit `ebdd025d` (main `8bec5de1`), both sides kept in
all six conflicts (RUNBOOK's two backfill sections; `routes/dev.ts`'s two
fixtures with their imports and deps; `routes/units.ts`'s two import blocks
and the Activity event list; `types.ts` / `listingFormat.ts` event lists;
`ListingDetail.test.tsx`'s two describes). Rationale and the drift check:
`code-review/fix-wave-3-drift-check.md`.

Drift since, NOT chased (one sync per branch): `main` is now 6 commits
ahead - `e402a053` (freeze last-heard-from docs; RUNBOOK backfill DONE
1.5.4), `cd1b05ef`, `c86fe28c`, `6f0673c9` (last-heard-from planner
records/issues), `814cc258` (an e2e spec: Tenants facets), `8d365094`
(`fix(app): follow-ups drop sends outside the lookback` -
`app/src/services/followUps.ts` + its test, untouched by this branch). A
`merge-tree` preview of `main` into the branch conflicts ONLY in
`RUNBOOK.md`: `e402a053` rewrote the "Last heard from" backfill section
that sits directly after the "Primary contacts backfill" section. Resolution
when merging: keep both sections, take `main`'s text for the last-heard-from
one, ours for primary contacts.

## Files touched by the wave (34 outside the records; +1108 / -190)

App: `app/src/routes/units.ts`, `app/src/routes/contacts.ts`,
`app/src/repos/unitsRepo.ts`, `app/src/repos/contactsRepo.ts`,
`app/src/lib/propertyContact.ts`, `app/src/services/primaryHandoff.ts`,
`app/scripts/assign-primary-contacts.ts`; tests
`unitsApiPropertyContact`, `unitsApiPropertyContactWrites`, `unitsApiRoster`,
`assignPrimaryContacts.run`, `contactDeletePrimaryHandoff`,
`primaryHandoffService`, `unitsRepoHandOffPrimary.integration`,
`primaryHandoffParity.integration`, `landlordWasPrimary`,
`unitsRestoreLandlord`, `propertyContact`, `contactsRepo.integration`, new
`contactsRepoConsistentBatchRead`, and `helpers/twilioWebhookHarness.ts`.
Dashboard: `api/types.ts`, `routes/listing/ListingDetail.tsx` (+ test),
`routes/listing/buildListingFile.ts` (+ test),
`routes/contact/ContactDetail.tsx` (+ test). Docs: the spec, RUNBOOK,
`e2e/support/selectors.md`, the two issues; a comment in
`e2e/tests/dashboard-next/primary-contact-integrity.spec.ts`.

## Commits (after the findings doc `d9269547`)

- `ebdd025d` Merge main (8bec5de1) - the one pre-build sync
- `cabb4e06` docs(records): drift check + the sync decision
- `7aea785a` feat(units): response-only autoEligible roster row flag (F1)
- `4d4f4a41` fix(listing): the no-eligible line asks for a property manager or owner (F3)
- `2b133dab` fix(listing): the no-primary box's one-click names a landlord-typed contact only (F1)
- `30005052` fix(scripts): assign-primary-contacts noEligible copy (F1)
- `0ae9096a` docs: spec 7.4 / 7.5 / 8, RUNBOOK, selectors (F1 + F3)
- `e0b1b5aa` docs(records): implementer A report
- `f18ac75f` fix(units): deleting the landlord of record of a no-flag roster hands off (F2)
- `fc7607de` fix(units): the restore paths read contact liveness strongly consistent again (F5a)
- `b5561c2c` fix(contact): the Delete dialog's hand-off sentence says "when someone can" (F5b)
- `4e430a6e` docs: spec 4.2 / 4.4 / 4.6 / 7.6 / 10 and two issues (F2 + F5a + F5b + the addition)
- `d3f5089d` docs(records): implementer B report - the gated tip
- then (docs-only on top): the self-QA record + screenshots, this handback

## Process and adjudications (mine)

1. Two SEQUENTIAL fresh foreground Opus implementers instead of one (A: F1 +
   F3, 6 commits, 23 min; B: F2 + F5a + F5b, 5 commits, 27 min), each with
   the complete findings file and a disjoint sub-scope - still ONE fix wave;
   the build's own lesson (split halves kept every child under budget).
   Zero recoveries, zero misfires; the failure budget is untouched.
2. I re-verified each implementer's diff against the findings file myself
   (the server flag from the complete read only; the four-case render; the
   three strings; the predicate gated on the landlord-of-record test and its
   three call sites; `ConsistentRead` spread only when asked and only on the
   restore route's reads; the sentence): CONFORMS, no silent deviation.
3. A's `buildListingFile.ts` pass-through (not named in the findings) is
   necessary - `listingRoster` builds rows field by field, so without it the
   box never sees the flag; a plan-unlisted READER of the protected state.
4. Spec 4.4 / 10 old-rule sentences -> amended (above). The resolved issue's
   "What staff see meanwhile" paragraph brought to the F1 rule;
   `docs/issues/restore-without-landlord-can-leave-nobody-reachable.md`
   (resolved; its dated narrative quotes the old box rule) left alone.
5. B's four guard negatives cannot go red on the old code (it targeted no
   no-flag unit at all); B showed their teeth against two deliberately
   wrong predicates (each fails 4 tests), then restored the file
   byte-for-byte before committing - accepted as the red for guards.
6. B's one docs commit for F2 + F5a + F5b + the addition (the brief said
   "your docs commit"); the code commits stay one item each.

## Live self-QA (mine; `self-qa/self-qa-fixwave3.md`, screenshots `self-qa/fixwave3-01..05-*.png`)

Lane 13 at `d3f5089d`, worlds built through the real routes plus the dev
seam, the wire asserted with key PRESENCE (never defaults). Tenant-only
property: the box shows the lead, the effect sentence, the NEW line and one
`Choose a primary`; zero one-click buttons; box `scrollWidth 226 =
clientWidth 226`, button right 788 < box 877, document 929 = 929;
`Choose a primary` opens edit mode where Tia's type-agnostic hand pick
("Make Tia234791 QaTenant the primary contact") is offered. Landlord-typed
sole contact: `Make Mark234791 QaManager primary` only (no line, no
`Choose a primary`; the label wraps inside the box, `white-space: normal`,
button right 883 < box 892); the click removes the box, the row reads
"(primary)", and the wire shows `primary_contact = <Mark>`, the row
`{ primaryContact: true, autoEligible: true }`, the block naming Mark, one
`unit_contact_added` event and no `unit_primary_contact_assigned` (an
explicit click; contract 2.4). Mixed roster (tenant + two landlord-typed):
`Choose a primary` only. On the wire the tenant row has NO `autoEligible`
key and the landlord-typed rows carry `true`. Console: zero errors after
login. Session stopped, tables dropped, ports free.

## Issues

- Resolved: `docs/issues/primary-handoff-no-flag-landlord-delete-gap.md`
  (`status: resolved`, Resolution names `f18ac75f`).
- Updated, stays open: `docs/issues/roster-liveness-read-eventual-consistency.md`
  (the restore paths' regression against `main` closed; add / remove /
  delete fan-out / script still eventually consistent, by ruling).
- Filed: none. `npm run issues` exit 0.

## Not blocking - your eye

- The box's `Choose a primary` stays visible INSIDE edit mode (it re-enters
  the mode the card is already in). Pre-existing for the two-or-more case;
  now also the tenant-only case. Cosmetic.
- B's nits, all docs: spec 9.2's parenthetical lists `landlordWasPrimary`'s
  users without the delete hand-off; spec 10's P3 "delete:" test list does
  not name the no-flag landlord case; spec 4.2's earlier bullet still cites
  `contactsRepo.ts:979` (a pre-merge anchor); the open
  `contact-list-rule-duplication-and-fake-drift.md` does not yet note that
  the delete re-check is now a shared rule (one fewer hand copy).
- The parity table observes end state only, so a "landlord of record
  always counts" mutant passes its flag-wins row (re-flagging the flagged
  row is a no-op); the service pin (`targets` + the audit row) catches it.
- By design the one-click rule is a UI rule: `POST /api/units/:id/contacts`
  with `primaryContact: true` still accepts a tenant (the edit-mode hand
  pick). Nothing server-side was asked for.
- The records are dated 2026-10-13 (Cameron's local date); UTC rolled to
  2026-10-14 mid-wave.

## Post-merge obligations (unchanged - LOUDLY)

The backfill, RUNBOOK "Primary contacts backfill": dry run then `--apply`
on dev, then prod, after each environment's deploy; Cameron runs it. This
wave changed its `noEligible` output strings (`No eligible contact - no live
contact is typed landlord (add a property manager or owner): N`;
`Properties with no eligible contact (open each one and add a property
manager or owner): ...`) and RUNBOOK step 4 says what Sam does with that
list under the new box rule. NO Terraform, secrets, SSM or env change; no
infra touched by this wave.

Records: `code-review/fix-wave-3-drift-check.md`,
`code-review/fix-wave-3A-report.md`, `code-review/fix-wave-3B-report.md`,
`self-qa/self-qa-fixwave3.md` (+ 5 PNG), this file. Run state and logs
(gitignored): `.superpowers/sdd/fixwave3-*`, `progress.md` (STATUS: DONE),
`heartbeat.log`.
