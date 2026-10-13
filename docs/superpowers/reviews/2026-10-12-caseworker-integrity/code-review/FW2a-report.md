# FW2a report - fix wave 2, backend (caseworker integrity)

Implementer: FW2a (Claude Opus 5.5), caseworker-integrity mission,
2026-10-12. Worktree `W:\tmp\caseworker-integrity`, branch
`fix/caseworker-integrity`, from 299f17ba. Brief `.superpowers/sdd/briefs/FW2a.md`;
work order `R2-adjudications.md` rows FW2-1..FW2-4 and "Cameron's rulings on
Q4 and Q5" (FW2-11, FW2-12); contract: spec revision 5, section 4 "Restore"
(sole-landlord promotion) and "Contact list (I4)" (auto-primary). Findings
only; code is cited by file:line at 534f971d (the last code commit).

Headline: six item commits (FW2-1 and FW2-11 split for review) plus one
issue-refs commit and this report. Every RED failed for the stated reason
before its fix; every revert proof went red and was restored byte-identically
(sha256 against a pre-revert baseline each time); the gate is green,
including the property-roster e2e (4/4). No STOP condition was hit: no item
grew past its description, the FakeWorld fake mirrors both repo methods
exactly, no reader of the primary contact or the contact list breaks (swept
below), and nothing contradicts spec revision 5. No dashboard file was
edited and no dashboard type had to change.

## Commits

| Item | Commit | RED (before the fix) | GREEN | Revert proof |
|---|---|---|---|---|
| FW2-1 (B1) | f5f242ee | DynamoDB Local 3/3 failed, `promise resolved ... instead of rejecting` (the caseworker re-seated, the tenant claimed); FakeWorld route 2 failed / 17, `expected 200 to be 409` | 8 files / 107; typecheck 0 | repo's two checks removed: 3/3 red; decide-once mutant (`attempts === 1 &&` on both checks): ONLY the per-attempt case red (1/3); fake's two checks removed: 2 red, `expected 200 to be 409` |
| FW2-11 (Q4) | 874bc6dc | 7 failed / 28 (3 DynamoDB Local, 4 route): the non-landlord row `"primaryContact": true` vs `false` | 8 files / 114 | `facts.landlordTyped &&` removed in repo and fake: the same 7 red |
| FW2-2 (R2B-A1) | 0a99ef31 | 1 failed / 17: audited `primaryContact: false`, no `autoPrimary` (the PIN passed) | 4 files / 72 | audit back to the request flag: 1 red |
| FW2-3 (R2B-A3) | 7e7d6fcb | 4 failed / 23: role landlord `expected 409 to be 404`, role pm `expected 200 to be 404` | 3 files / 65 | pointer clause removed: the same 4 red |
| FW2-12 (Q5) | 460b5cd7 | DynamoDB Local 4 failed / 18 (promotion x2: the PM row `primaryContact: false`; conflict x2: `promise resolved ... instead of rejecting`); route 5 failed / 47 (promotion x3, the consistent-read pin with no reads yet, the race `expected 200 to be 409`); the nobody-promoted and not-the-primary cases are pins (green by construction) | 6 files / 93; wide set 14 files / 247; typecheck 0 | repo promotion reverted: 2 red; repo roster check removed: 2 red (the second is the silent stale retry); fake promotion + check reverted: 4 red; route mutants: promote always null 4 red, pointer clause dropped 1 red (missing + pointer case), scalar disjunct dropped 1 red (scalar-only case), `consistentRead` dropped 1 red (the pin) |
| FW2-4 (R2B-A5) | 534f971d | docs / comment | eslint 0, ASCII 0 | n/a |
| issue refs | 17ff585a | docs: the resolved issue's line refs re-pointed at 534f971d | `npm run issues` 0 | n/a |
| report | (this commit) | - | - | - |

Logs: `.superpowers/sdd/logs/fw2a-*.log` (47 logs, every run redirected with
`$?` echoed, never piped); hash baselines `.superpowers/sdd/fw2a-*-baseline.sha256`.

## FW2-1 + FW2-11: the facts input

- Design: a REQUIRED third parameter of `UnitsRepo.addContact`,
  `facts: ContactListFacts` (`app/src/repos/unitsRepo.ts:162`, interface
  `:509`): `caseworker` (`isCaseworker(contact)`) and `landlordTyped`
  (`contact.type === 'landlord'`). Required because the call sites number 25
  (< 30): the route plus 24 test calls.
- Repo, per attempt on that attempt's read (`:882`): I4
  `existing === undefined && facts.caseworker` throws
  `ContactListCaseworkerError` (`:131`, `:916`); I3
  `claimsVacantLandlord && !facts.landlordTyped` throws
  `LandlordClaimNotLandlordError` (`:145`, `:917`); then the existing
  reassignment refusal (moved below the roster computation - pure code
  motion - so the per-attempt order is the spec's route order: I4, I3,
  reassignment). Q4: `autoPrimary = facts.landlordTyped && existing ===
  undefined && !hasLandlordId && no primary row` (`:938`). The write is still
  `updateRosterIfCurrent` on the landlordId + contacts[] the attempt read, so a
  lost condition re-reads and re-decides all three.
- Route (`app/src/routes/units.ts`): pre-checks unchanged (`:1180-1192`);
  facts from the consistent contact read passed at `:1207`; the two errors
  mapped to the same 409s with a log line each (`:1210-1225`).
- Fake (`app/test/helpers/twilioWebhookHarness.ts:2944`): the same checks in
  the same order (`:2963-2964`) and the same `facts.landlordTyped` clause
  (`:2979`).
- Call sites changed: `app/src/routes/units.ts:1198`;
  `app/test/unitsRepoRoster.integration.test.ts` (16, `LANDLORD_FACTS`);
  `app/test/unitsRepoAutoPrimary.integration.test.ts` (7, plus the new (g)
  cases); `app/test/placementsVoiceRouting.test.ts:239` (1); the new file's 3.
  The two `world.unitsRepo.addContact = async () => ...` overrides in
  `app/test/unitsApiRoster.test.ts:233`, `:254` take no parameters and needed
  no change.
- Tests: `app/test/unitsRepoContactListRules.integration.test.ts` (new,
  DynamoDB Local, a racing document client): `:115` I4 race in the route's
  window (no write sent, B's removal stands), `:134` I4 race in the add's own
  window (one lost write, then the re-read refuses - the case that kills a
  decide-once implementation), `:153` I3 race (slot stays vacant, no write).
  `app/test/unitsApiRosterTypeChecks.test.ts:265` (FakeWorld): the R2 review's
  two probes, the race injected after the route's reads (`:266` I4 on an
  ownerless primary-less unit, `:289` I3 with B's "Restore without a
  landlord"), each 409 with the right code and nothing written.
  Q4: `app/test/unitsRepoAutoPrimary.integration.test.ts:143` (g) roles pm,
  owner, other with `landlordTyped: false` join non-primary, then a
  landlord-typed PM is primary; `app/test/unitsApiRosterAutoPrimary.test.ts:123`
  (g) tenant, partner (Navigator), unknown, team member, same shape.
- SA-1 tests relying on any-type promotion: none did (every SA-1 contact is
  typed landlord: the route file's `seedContact` defaults to it, and the repo
  cases now pass `LANDLORD_FACTS`); both SA-1 file headers now state the
  revision-5 rule.
- Issue `docs/issues/contact-list-checks-outside-roster-write-loop.md`:
  resolved 2026-10-12 with a Resolution paragraph (f5f242ee), refs re-pointed
  at 534f971d (17ff585a).

## FW2-2: the effective primary flag in the audit

`app/src/routes/units.ts:1245-1266`: `primaryContact` in the
`unit_contact_added` payload and the route's log line is read from the
written unit (the added row flagged primary); `autoPrimary: true` is added
only when the row is primary and the request did not ask. Tests
`app/test/unitsApiRosterAutoPrimary.test.ts:155` (auto-primary add audited
`primaryContact: true, autoPrimary: true`) and `:168` (pin: a requested
primary is audited without `autoPrimary`, a plain add `primaryContact: false`).
The Activity projection whitelists neither key (`app/src/routes/units.ts:221`),
so nothing on the wire changes. `role` stays the request's (see Noticed).

## FW2-3: pointer rows answer 404

`app/src/routes/units.ts:1158-1162`: `!contact || contact.phone_ref === true
|| contact.email_ref === true` -> 404 `contact_not_found` (the inline test of
`app/src/services/contactTypeGuards.ts:71`, `:88`). Tests
`app/test/unitsApiRosterTypeChecks.test.ts:228` (phone and email pointer,
role landlord on an ownerless unit: 404, slot vacant, no audit) and `:243`
(role pm: 404, nothing seated, no primary).

## FW2-12: the sole-landlord promotion of "Restore without a landlord"

- Input: `RestoreWithLandlordInput` (`app/src/repos/unitsRepo.ts:181`), a
  union on `next`: the `{ landlordId: <id> }` variant is unchanged; the
  `next: null` variant REQUIRES `expectContacts` (the stored `contacts`
  attribute the caller read; undefined when none) and `promote` (the
  decision: a contactId or null).
- Route decision (`app/src/routes/units.ts:429`, `soleLandlordToPromote`):
  only when the cleared landlord was the primary on the route's read (its row
  flagged, or the scalar naming it - the repo's own rule), it reads every
  remaining row's contact CONSISTENTLY (one `getById` each, in parallel; the
  contacts repo has no consistent batch read) and returns the one row whose
  contact exists, is not a pointer and is typed `landlord`; zero or two-plus
  -> null. Called at `:1772`; the null variant gets `expectContacts:
  stored.contacts` (`:1781`).
- Repo (`:1243`): for `next === null`, after the deleted and landlordId
  checks, `isDeepStrictEqual(unit.contacts, input.expectContacts)` must hold
  or `RosterWriteConflictError` (`:1273`) - on every attempt, so a change
  landing between the read and the conditioned write loses the write and the
  re-read refuses instead of retrying with stale eligibility. The promotion
  applies only when the repo's own read says the cleared landlord was the
  primary and `promote` names a remaining row (`:1320-1323`): its row
  flagged, every other unflagged, `primary_contact` set; otherwise the old
  clearing. Swaps keep their contacts-only retry. The repo log gains
  `primaryPromoted`.
- Fake (`app/test/helpers/twilioWebhookHarness.ts:3123`): the same check
  (`:3136`) and promotion (`:3172`), same order.
- Audit (`app/src/routes/units.ts:1796-1807`): `primaryPromoted: { to }` next
  to `landlordCleared` when the promoted row is primary in the written unit
  (the effective outcome, as FW2-2).
- Tests, DynamoDB Local (`app/test/unitsRepoRestoreWithLandlord.integration.test.ts`):
  `:228` promotion by row flag (scalar + flags, stored), `:248` by scalar
  alone, `:264` pin: the cleared landlord not the primary -> unchanged,
  `:284` a list changed before the repo's read -> conflict, no write sent,
  `:306` a list changed between the read and the write -> conflict, nothing
  written; `:175` (promote null) and every other null call site updated to
  the required input. FakeWorld route (`app/test/unitsRestoreLandlord.test.ts`):
  `:300` one eligible -> promoted + audit, `:331` scalar-only, `:350` two
  eligible -> none, `:371` a non-landlord only -> none, `:384` not the
  primary -> unchanged, `:409` a missing contact and a pointer row (even one
  carrying type landlord) are not eligible, `:436` consistent reads (pin),
  `:447` the race -> 409 `unit_roster_conflict`, nothing written, no audit.

## FW2-4

- `RUNBOOK.md:475`: two sentences after the L1 sentence - the contact-list
  checks are decided again inside the contact-list write on the property it
  reads (the property side atomic with the write), only the added contact's
  type is still read before it; the restore promotion reads the remaining
  contacts' types before its write and conditions the write on the contact
  list it read (409 `unit_roster_conflict`).
- `app/src/repos/unitsRepo.ts:975-983`: the scalar comment no longer claims
  the masked-call leg dials `primary_contact`; it names the resolvers that
  route (row marked primary, else landlordId) and the masked call dialing the
  thread's participants.

## Readers swept

- Primary contact: `app/src/lib/rosterResolution.ts:293-294`,
  `app/src/lib/tourContacts.ts:124-129`,
  `app/src/services/rosterProvision.ts:233-234`, `:525` (the `=== true` row,
  else landlordId); `app/src/routes/webhooks/voice.ts:996-998` (thread
  participants, no unit read). Q4 only removes auto-promotions; Q5 writes the
  state Make primary already writes on an ownerless property. None breaks.
- The scalar: written by unitsRepo, seeds (`app/src/lib/seed/cast.ts:1367`,
  `performance.ts:604`) and the PATCH (`app/src/lib/unitFields.ts:104`); read
  only by `restoreWithLandlord` and the new route decision. No router.
- Contact-list writers: `addContact` (route only in src, `units.ts:1198`),
  `removeContact`, `restoreWithLandlord` (route only, `units.ts:1772-1783`).
  The only typed `UnitsRepo` implementer is the FakeWorld fake
  (`twilioWebhookHarness.ts:2820`); `app/test/placementNudges.test.ts:176` is
  a cast without either method.
- Dashboard (read only): the restore dialog applies the 200's enriched
  roster (`dashboard/src/routes/listing/ListingDetail.tsx:1415-1417`) and
  re-reads on 409 `unit_roster_conflict`
  (`dashboard/src/routes/listing/RestoreLandlordDialog.tsx:82-84`,
  `ListingDetail.tsx:1419-1425`).

## Divergences, and why

- FW2-1 and FW2-11 are two commits (the brief allowed it): f5f242ee adds
  `landlordTyped` for I3 only, 874bc6dc makes it gate auto-primary.
- Repo-layer error classes, not `contactTypeGuards`' `LandlordNotLandlordError`:
  a repo must not import a services module.
- FW2-12's eligibility is the ROUTE's decision (as briefed), so the DynamoDB
  Local cases take it as input (`promote`): there they prove the conditioned
  write, the promotion inside it and both conflict windows; "two eligible",
  "a non-landlord only" and the missing / pointer cases run on the FakeWorld
  route. No test in this repo drives a route on DynamoDB Local; one was not
  invented here.
- Every `{ landlordId: null }` restore is now conditioned on the contact list
  (not only those that promote), as briefed: a concurrent contact-list change
  there answers 409 where it used to be a silent retry.
- The repo re-checks "the cleared landlord was the primary" on its own read
  before applying `promote` (defense in depth: the scalar is not in the write
  condition); the route reads contacts only when its read says so.
- Extra cases beyond the brief: the I4 race in the add's own window, the
  FW2-2 pin, email pointers, the scalar-only promotion on both sides, the
  missing / pointer eligibility, the consistent-read pin, the not-the-primary
  pin on DynamoDB Local.

## Gate (bare, from the worktree, at 534f971d)

| Step | Command (short) | Exit | Counts |
|---|---|---|---|
| 1 | app `npx vitest run` the brief's 11 files + unitsRepoContactListRules.integration, placementsVoiceRouting, unitsApiActivity | 0 | 14 files, 247 passed (baseline before any edit: 13 files / 216); DynamoDB Local suites ran: unitsRepoRoster 17, unitsRepoAutoPrimary 13, unitsRepoRestoreWithLandlord 18, unitsRepoContactListRules 3 |
| 2 | `npm run typecheck` | 0 | all workspaces |
| 3 | `npx eslint $(git diff --name-only --diff-filter=d 299f17ba..HEAD -- '*.ts' '*.tsx')` | 0 | 11 files, no output |
| 4 | `timeout 1200 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/property-roster.spec.ts` (background, exit marker, waited in-turn) | 0 | 4 passed, 0 failed, 0 flaky, 0 skipped (17.4 s), incl. the SA-1 landlord-typed PM case; lane 6 ports (9601/9611/9621/9631) free before and after |
| 5 | ASCII | - | 1 new file: 0; 12 edited files, added lines vs 299f17ba: 0; commit messages 299f17ba..HEAD: 0 |
| 6 | `npm run issues` | 0 | 403 open, 203 closed, 606 total |

No `[dynamoAdmin]`, SKIPPED or ENOBUFS line in any of the 47 logs. DynamoDB
Local was not started, stopped or restarted; no `AWS_*` variable was set. No
full `npm test` or full e2e. No file was edited while the e2e ran.

## Noticed, not fixed

1. `unit_contact_added`'s `role` is still the request's although the repo
   pins the landlord of record's row to `landlord` (R2B-A1's "same class";
   FW2-2 was ruled for the primary flag only).
2. Two more doc comments describe the scalar as the masked-call target:
   `app/src/repos/unitsRepo.ts:63` (the row's doc, close enough) and `:327`
   (`UnitItem.primary_contact`: "the person we put on the relay group and
   reach by a masked call"). Only the comment the brief named was corrected.
3. The `primary_contact` scalar is outside every roster write condition, so a
   scalar PATCH racing a restore without a landlord can make the route's and
   the repo's "was the primary" differ; the repo decides on its own read and
   the audit records the written outcome. Edge only.
4. The route's per-row consistent reads for the promotion are N GetItems
   (a roster is small); the contacts repo's batch reads are never consistent.

## HANDOFF for the dashboard child

No wire SHAPE changed: no new response field, no new error code, no
dashboard type change.

- `POST /api/units/:id/contacts`
  - 409 `contact_list_caseworker` / `landlord_not_landlord` can now also come
    from the roster write (a seat removed or a landlord cleared after the
    route's read) - same codes and bodies, nothing written; the page maps both
    already.
  - 404 `contact_not_found` also for a routing pointer id (the picker never
    offers one).
  - Auto-primary is landlord-typed only: on an ownerless property with no
    primary row, a new landlord, PM or owner becomes the primary; a tenant,
    partner, unknown or team member joins non-primary. The answer's roster
    carries the flags. FW2-8: the comment above `promotionNotice` should state
    this rule (the ruled sentence "...or a new contact is added" stands).
    FW2-9: `addUnitContact`'s doc (`dashboard/src/api/endpoints.ts`) should
    name auto-primary (new seat, no primary row, no landlordId, contact typed
    landlord), the two 409s from the write, and the pointer 404.
  - Audit only: `unit_contact_added` carries the effective `primaryContact`
    and `autoPrimary: true`; Activity does not project either.
- `POST /api/units/:id/restore` with `{ landlordId: null }`
  - 200: when the cleared landlord was the primary and exactly one remaining
    row's contact is typed landlord, that row comes back `primaryContact:
    true` with `primary_contact` naming it (same enriched-roster shape); the
    dialog's `onRestored` -> `applyRosterUnit` renders it as is.
  - 409 `unit_roster_conflict` now also when the contact list changed between
    the route's read and the write (it used to retry); the dialog's existing
    `onConflict` re-read handles it. Plain and `{ landlordId: <id> }`
    restores are unchanged.
  - Audit only: `unit_restored` gains `primaryPromoted: { to }` next to
    `landlordCleared`; Activity still reads "Property restored" (FW2-10 files
    that copy gap).
  - No e2e for Q5 (Cameron's ruling: the restore e2e leaves no remaining
    rows).
