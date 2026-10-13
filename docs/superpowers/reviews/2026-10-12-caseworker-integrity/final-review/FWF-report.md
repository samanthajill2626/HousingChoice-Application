# FWF report - final fix wave (caseworker integrity)

Implementer: FWF (Claude Opus 5.5), caseworker-integrity mission,
2026-10-13. Worktree `W:\tmp\caseworker-integrity`, branch
`fix/caseworker-integrity`, from 437686d6 (spec revision 6). Brief
`.superpowers/sdd/briefs/FWF.md`; work order `final-review/adjudications.md`
(rulings A2, A3, A4, A5 client, A7 read; issue updates A1, A5, A6, A7, A8,
A9). Findings only; code is cited by file:line at 9d41b591 (the last code
commit; the issues commit after it changes no code).

Headline: five item commits and one issues commit, plus this report. Every
RED failed for the reviewer's stated reason before its fix; every revert
proof went red on exactly the new cases and was restored byte-identically
(sha256 against a post-fix baseline). The gate is green. No STOP condition
was hit: no item grew past its description and none contradicted the code.

## Commits

| Item | Commit | RED (before the fix) | GREEN | Revert proof |
|---|---|---|---|---|
| FWF-1 (A2) | 3a0ed89d | `unitsRestoreLandlord.test.ts` 6 failed / 32, each `expected 200 to be 409` (the plain path ran and ignored the body) | 32 / 32; dashboard 3 files / 147; typecheck 0 | guard removed: the same 6 red; restored, sha256 `3e2ac3d2...` OK |
| FWF-2 (A3) | d8574816 | `ListingDetail.test.tsx` 3 failed / 86, each `getUnit` called 0 times | 86 / 86 | the typed branch without `await settle()`: the same 3 red; restored, sha256 `33c6d0fb...` OK |
| FWF-3 (A4) | b9a60221 | 4 failed / 34 (2 DynamoDB Local, 2 FakeWorld route), each the soft-deleted contact's row `"primaryContact": true` | 11 files / 178; typecheck 0 | repo, fake, route each back on the type alone: 2 red each; predicate without its deleted clause: 4 red; without its pointer clause: 1 red; all three files restored, sha256 OK |
| FWF-4 (A5 client) | c04b22e5 | `ContactDetail.test.tsx` 1 failed / 128: `updateContact` called with `{ housingAuthority: 'Atlanta Housing Authority' }` onto the converted caseworker | 128 / 128 | reset removed: the same 1 red; restored, sha256 `9d0dbc0e...` OK |
| FWF-5 (A7 read) | 9d41b591 | `unitsRepoContactListRules.integration.test.ts` 2 failed / 5: `expected [ undefined ] to deeply equal [ true ]` | 3 real-repo files / 37 | option removed: the same 2 red; restored, sha256 `37c64d9f...` OK |
| issues | 8da0f6c8 | - | `npm run issues` 0 | n/a |
| report | (this commit) | - | - | - |

Logs: `.superpowers/sdd/logs/fwf*.log` (every run redirected with its exit
code echoed, never piped). Hash baselines: `.superpowers/sdd/fwf-start-baseline.sha256`
(every touched file before any edit) and `fwf-fwf1/fwf1-dash/fwf2/fwf3/fwf4/fwf5-baseline.sha256`.
Baselines before any edit: app (the 10-file gate set) 187 passed; dashboard
(the 3 listed files) 222 passed (ListingDetail 84, RestoreLandlordDialog 11,
ContactDetail 127).

## FWF-1: a late restore body answers 409 and writes nothing

- `app/src/routes/units.ts:1779-1786`: inside the plain path
  (`!needsLandlord`), a body (`choosesLandlord`, `landlordId` a string or
  null) answers 409 `{ error: 'unit_roster_conflict' }` with a log line,
  before `units.restore` and the `unit_restored` audit. The plain restore (no
  body) is unchanged. Route doc `:1738-1744`.
- Tests, `app/test/unitsRestoreLandlord.test.ts`: the pinned "a body is
  ignored when the stored landlord is still valid" is replaced by six cases
  (`:200-259`): three states where the plain restore applies (no longer
  deleted; stored landlord typed landlord again; ownerless) x `{ landlordId:
  'c-new' }` / `{ landlordId: null }`, each 409 `unit_roster_conflict`, the
  unit deep-equal to its pre-request `structuredClone` (so: a live unit
  unchanged, a deleted one still deleted, `updated_at` untouched) and no
  `unit_restored` row.
- Dashboard, `dashboard/src/routes/listing/ListingDetail.test.tsx:1457`: the
  dialog picks Nora, "Restore with this landlord" answers 409
  `unit_roster_conflict`, the re-read is LIVE with Yolanda as landlord: the
  dialog closes; the page is live (no Deleted badge, no Restore, the status
  pill back); the Contacts card's first row is `Yolanda Banks (primary)`,
  neither Nora nor James shown. A PIN (the page already behaves so,
  `ListingDetail.tsx:1438-1452`); killed by two mutants of `onConflict`:
  the dialog close removed (2 red: this case and the existing without-landlord
  PIN) and the re-read applied with `setUnit` only (2 red: this case and the
  existing still-deleted re-read case). Restored to the start hash.
- `dashboard/src/api/endpoints.ts:1045-1046`: `restoreUnit`'s doc names the
  new 409 meaning (either body, the plain restore would apply now, nothing
  written).

### The still-deleted behavior, recorded (not changed, per the brief)

When the stored landlord became a landlord again while the dialog was open,
the dialog's request answers 409 `unit_roster_conflict` (nothing written);
the dialog shows "The property contacts changed - try that change again."
and re-reads (`RestoreLandlordDialog.tsx:82-84`); the re-read is still
deleted, so `onConflict` applies it and keeps the dialog open
(`ListingDetail.tsx:1438-1452`) with its first sentence - now false - and the
retry sentence. Either restore action answers the same 409 on every retry
until Cancel (`ListingDetail.tsx:1453`); the banner's Restore then sends the
plain restore, which restores the property with its stored landlord
(`ListingDetail.tsx:371-388`). Recorded as a paragraph on the D3 entry (item
2) of `docs/issues/contact-type-refusal-copy-edge-cases.md`, which also says
FWF-1 replaced that entry's "closes as a success".

## FWF-2: a typed contact-list refusal settles the card

- `dashboard/src/routes/listing/ListingDetail.tsx:438-474`: the best-effort
  `getUnit` + `applyRosterUnit` settle is a local `settle` (`:440-446`) run by
  both the typed branch (`:456-460`, the sentence set first, so it stays) and
  the 409 catch-all (`:473`).
- Tests, `ListingDetail.test.tsx`: the "does not refetch" pin flips (`:1884-1921`):
  for `contact_list_caseworker` and `landlord_not_landlord` on the add row,
  `getUnit('u1')` is called, the re-read's roster replaces the card (Dana's
  removed seat disappears), the alert keeps the sentence and the add row keeps
  the pick. Added (`:1923`): a row's re-role refused `landlord_not_landlord`
  (the landlord cleared meanwhile) - after the re-read drops James's row,
  Dana's row still carries the sentence.

## FWF-3: one automatic-routing eligibility rule

- `app/src/routes/units.ts:133-153`: `autoRoutingEligible(contact)` - exists,
  not a `phone_ref` / `email_ref` pointer, not soft-deleted (the contacts
  repo's `isDeleted`, imported as `isContactDeleted`), typed `landlord`.
  Used by `soleLandlordToPromote` (`:474`) and passed to `addContact` as
  `autoPrimaryEligible` (`:1247-1251`); `landlordTyped` still feeds the I3
  claim.
- `app/src/repos/unitsRepo.ts:164-181`: `ContactListFacts` gains the
  REQUIRED `autoPrimaryEligible`; auto-primary uses it (`:961-965`) in place
  of `landlordTyped`; the I3 claim check (`:938`) is unchanged. Docs at
  `:490-499` and `:946-960`.
- Fakes changed: the FakeWorld `addContact`
  (`app/test/helpers/twilioWebhookHarness.ts:2972-2984`) - the same clause.
  It is the only other `addContact` implementer (repo-wide grep); the
  `unitsApiRoster.test.ts` overrides take no parameters and the
  `unitsApiRosterTypeChecks.test.ts` wrappers pass `facts` through.
- Callers updated: the route; facts constants or calls in
  `unitsRepoAutoPrimary.integration.test.ts:53-60`,
  `unitsRepoRoster.integration.test.ts:45`,
  `unitsRepoContactListRules.integration.test.ts:53-54`,
  `placementsVoiceRouting.test.ts:243`, `unitsRestoreLandlord.test.ts:552`,
  `:595`.
- Tests: DynamoDB Local (i) (`unitsRepoAutoPrimary.integration.test.ts:174`),
  roles pm and landlord with the fact false on an ownerless, primary-less
  property (restored without a landlord): joins non-primary, no scalar; the
  landlord role still claims `landlordId`. FakeWorld route (i)
  (`unitsApiRosterAutoPrimary.test.ts:155`): a soft-deleted landlord-typed
  contact, same two roles, same outcome. Kept and green: the live
  landlord-typed PM still auto-promotes (cases (a), (d), (g)); the restore
  promotion still excludes soft-deleted and pointer contacts
  (`unitsRestoreLandlord.test.ts` F3a / F3b and the missing / pointer case) -
  the predicate mutants above prove both consumers read the one rule.

## FWF-4: the housing-authority review closes on a type change

- `dashboard/src/routes/contact/ContactDetail.tsx:280-289`: a render-time
  reset - `if (haReview !== null && contact !== null && contact.type !==
  'tenant') setHaReview(null)` - the "adjust state when a prop changes"
  pattern `ListingDetail.tsx:225` uses; eslint (React Compiler rules) clean.
- Test, `ContactDetail.test.tsx:2735`: the review open on tenant k1 (close
  name offered); staff B's conversion arrives through the page's own path -
  a `suggestion.updated` naming k1 makes `useContact` re-read (the contact is
  now partner + Caseworker) and `useSuggestions` re-read (empty); after the
  header shows the converted contact, the "Use Atlanta Housing Authority"
  button held from before is pressed: no `updateContact`, no dialog, no
  accept.
- Test mock change: `useEventStream`'s mock also keeps one ref per caller
  with its latest handlers (`:101`, `:153-155`) and `emitSuggestionUpdated`
  (`:195`) dispatches to each - the `EventStreamProvider` model. Needed
  because both `suggestion.updated` listeners pass inline handlers (a new
  function every render), which the existing merged slot and handler Sets
  cannot deliver to both.

## FWF-5: addContact's per-attempt read is consistent

- `app/src/repos/unitsRepo.ts:903-907`: each attempt's unit read passes
  `consistentRead: true`.
- Tests, `unitsRepoContactListRules.integration.test.ts`: the suite's racing
  client records each unit `GetCommand`'s `ConsistentRead` (`:82`, `:95-101`;
  the three existing cases unchanged and green). `:193`: a caseworker
  refused a new seat on attempt 1 - reads `[true]`, no write. `:206`: the
  per-attempt race (one lost write, the refusal on attempt 2) - attempt 1's
  read and the last (refusing) read are both `true`.

## Issues (8da0f6c8)

- Appended: `import-bypasses-contact-type-rules` (A1, first to fix before the
  next `import:apply` run, with the two fix options; refs `apply.ts:1512-1554`,
  `unitsRepo.ts:1331`, `placementNudges.ts:436-443`);
  `landlord-of-record-no-reassign-ui` (A6; `units.ts:1615-1642`, `:1669`);
  `ai-run-log-refused-accept-replay-200` (A9; `suggestionResolution.ts:787-801`,
  `:894-895`, `suggestionResolutionRepo.ts:303-319`); the D3 paragraph above.
- Filed (low, open, created 2026-10-13): `ha-review-close-name-patch-unfenced`
  (app), `contact-list-rule-duplication-and-fake-drift` (app; notes FWF-5 as
  done), `auto-routing-changes-not-named` (dashboard).
- Every `path:line` in the seven files was printed and checked at the tip.

## Divergences, and why

1. FWF-1: the live-unit PIN (`unitsRestoreLandlord.test.ts:127`) also sent a
   body (`{ landlordId: null }`) and expected 200 - the old contract. It now
   sends no body (its own intent: a live unit's plain restore runs no
   landlord check); its body variant is one of the six new 409 cases.
2. FWF-1 dashboard: a PIN proven by two mutants, not a RED - the page
   already closed on a live re-read; the brief asked to prove it.
3. FWF-1: `restoreUnit`'s doc (`endpoints.ts`) updated - the contract it
   documents changed; not in the brief's list.
4. FWF-2: the settle is one local helper for both paths; the typed branch
   settles for any mapped code (only the two 409s reach a roster write). The
   row-edit case is an extra test.
5. FWF-3: the fact is required, not optional (as FW2a made `facts`); the
   predicate is module-level in the route, unexported. Doc comments updated
   in the route, the repo and the fake.
6. FWF-4: the test needed the mock's per-caller dispatch (above).
7. Issues: the D3 paragraph went into the shared issues commit, so its
   refs are computed at the final code tip; in that file the 13 refs this
   wave's code commits moved (4 frontmatter, 9 body) were re-pointed. The A9
   issue's refs moved from file-only to file:line.
8. The bare `git status` before the issues commit ran in the same shell call
   as the INDEX.md ignore check (unpiped); every other commit had its own call.
9. One read-only `docker ps` at the start confirmed DynamoDB Local was up;
   it was not started, stopped or restarted.

## Gate (bare, from the worktree, at 8da0f6c8)

| Step | Command (short) | Exit | Counts |
|---|---|---|---|
| 1 | app `npx vitest run` unitsRestoreLandlord, unitsRepoRestoreWithLandlord.integration, unitsRepoAutoPrimary.integration, unitsApiRosterAutoPrimary, unitsApiRoster, unitsApiRosterTypeChecks, unitsRepoRoster.integration, contactTypeGuards + touched unitsRepoContactListRules.integration, placementsVoiceRouting | 0 | 10 files, 198 passed (baseline 187 + 11): 32, 18, 15, 19, 25, 23, 17, 33, 5, 11; DynamoDB Local suites ran |
| 2 | dashboard `npx vitest run` ListingDetail, RestoreLandlordDialog, ContactDetail + endpoints (its source touched) | 0 | 4 files, 276 passed: 86, 11, 128, 51 |
| 3 | `npm run typecheck` | 0 | all 5 workspaces, 0 TS errors |
| 4 | `npx eslint $(git diff --name-only --diff-filter=d 437686d6..HEAD -- '*.ts' '*.tsx')` | 0 | 14 files (list checked non-empty), no output |
| 5 | ASCII | - | 3 new files: 0 each, none MISSING; 18 edited files, added lines vs 437686d6: 0; commit messages 437686d6..HEAD: 0; this report: checked before its commit |
| 6 | `npm run issues` | 0 | 407 open, 203 closed, 610 total; no warnings |

Extra, during FWF-3: unitsApiActivity and unitsSoftDelete (the other suites
on the fake's `addContact`) green in the 11-file / 178 run. No
`[dynamoAdmin]`, SKIPPED or ENOBUFS line in any log; no `AWS_*` variable in
the environment; no full `npm test`, no e2e.

## Noticed, not fixed

1. `addContact`'s re-read after a lost write (`app/src/repos/unitsRepo.ts:1018`)
   is still eventually consistent; it decides `landlord_reassignment_required`
   before a retry. Outside FWF-5's "per-attempt read"; the FWF-5 pin checks
   the first and the refusing read only, so it pins this read neither way.
   `removeContact`'s twin (`:1108`) is the same.
2. The plain restore's landlord check and `requireLandlordContact` still let
   a SOFT-DELETED landlord-typed contact through (adversarial A4's last
   bullet); the ruling covered automatic routing only.
3. Open issues outside this wave's files that cite moved lines by number
   were not re-pointed - notably `restore-without-landlord-can-leave-nobody-reachable`
   (`units.ts:445-447`, now `:467-469`; `unitsRepo.ts:1292-1293`, now
   `:1309-1310`) and `listing-detail-dialogs-survive-property-navigation`
   (ListingDetail.tsx refs after `:425`).
4. `contact-type-refusal-copy-edge-cases`' "Related" paragraph cites
   `listingFormat.ts:229-230` for the "Property restored" label, which is at
   `:228` - drift from before this wave.
5. In the still-deleted case the dialog's first sentence ("... is no longer a
   landlord") is false once the stored landlord is a landlord again; already
   item 2's "Related" sentence in that issue.
