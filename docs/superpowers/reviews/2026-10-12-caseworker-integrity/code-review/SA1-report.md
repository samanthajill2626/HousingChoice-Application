# SA-1 report - auto-primary (human-ruled scope addition)

Implementer: SA-1 (Claude Opus 5.5), caseworker-integrity mission,
2026-10-12. Worktree `W:\tmp\caseworker-integrity`, branch
`fix/caseworker-integrity`, from 2338bef1 (S1-S5 and fix wave 1 committed).
Brief `.superpowers/sdd/briefs/SA1.md`; the ruling is `R1-adjudications.md`
"Human-ruled scope addition SA-1"; the contract is spec revision 4, section 4
"Contact list (I4)", paragraph "Auto-primary (Cameron, 2026-10-12)".
Findings only; code is cited by file:line at 5d9c317b (the last code commit).

Headline: three commits (repo + fake + tests; dashboard copy + tests +
selectors row; e2e) plus this report. The rule is decided inside
`unitsRepo.addContact`'s attempt loop from the unit that attempt read and is
mirrored line for line in the FakeWorld fake; the route and the page's request
are unchanged. Every positive case went RED for the stated reason (the added
row stayed `primaryContact: false`). The negative cases are PINs - green on the
old code by construction, since it never auto-promotes - and each is proven
able to fail by a mutant of its own clause. Six app mutants, three dashboard
proofs and one e2e RED were each applied and restored with the Edit tool,
sha256-verified. The gate is green. No STOP condition was hit: every
primary-contact reader was swept (below) and none breaks, the one typed
`UnitsRepo` fake mirrors exactly, and every RED failed for its reason.

## Commits

| Commit | Subject | What it proved |
|---|---|---|
| ecbaa09c | fix(units): a contact added to a property with no primary and no landlord becomes its primary contact | the rule on DynamoDB Local, cases (a)-(f); through `POST /api/units/:id/contacts` on FakeWorld, cases (a)-(d) and (f) (the fake's parity); two older DynamoDB Local pins moved to the ruled rule |
| 37bfcfa1 | fix(dashboard): the ownerless remove-the-primary notice names adding a new contact as a remedy | the exact new sentence in the string, both pins, the selectors row and the comment; the Contacts card renders a server-made primary |
| 5d9c317b | test(e2e): after Restore without a landlord, the contact added next is the property's primary contact | end to end on the hermetic lane: the PM added after "Restore without a landlord" is the primary contact in the card and on the wire |
| (this commit) | docs(records): SA-1 report | - |

## Where the code landed (at 5d9c317b)

- `app/src/repos/unitsRepo.ts`
  - `:396-402` the interface doc of `addContact` states the rule.
  - `:826-839` the decision: `autoPrimary = existing === undefined &&
    !hasLandlordId && !roster.some((c) => c.primaryContact === true)`, computed
    per attempt from that attempt's read (`:799` the read, `:809`
    `hasLandlordId`, `:824` the roster, `:825` `existing`).
  - `:849` effective primary = `contact.primaryContact === true || autoPrimary`.
  - `:863-868` the demotion comment the brief named ("When it isn't, leave any
    existing primary as-is") rewritten; the demotion code `:869-871` and the
    scalar code `:879-882` are unchanged, so `primary_contact` is set exactly
    as the existing primary path sets it.
  - `:915` the 'unit contact added' log line also logs `autoPrimary`.
  - Why per attempt is race-safe: the write (`updateRosterIfCurrent`, `:558`)
    is conditioned on the landlordId (`:589`, or its absence) and the
    contacts[] (`:598`, or its absence) the attempt read - exactly the two
    inputs of the decision - and a lost condition re-reads and re-runs
    (`:887-907`), so a loser re-decides from the winner's state.
- `app/test/helpers/twilioWebhookHarness.ts:2943-2944` (comment) and
  `:2963-2972` - the same decision and effective flag in the FakeWorld fake.
  It is the only typed `UnitsRepo` implementer of `addContact` (repo-wide grep:
  the real repo, this fake; `placementsVoiceRouting.test.ts:239` only calls it).
- Tests
  - `app/test/unitsRepoAutoPrimary.integration.test.ts` (new, DynamoDB Local):
    (a) `:104` over four shapes, (b) `:125`, (c) `:144`, (d) `:156`, (e) `:166`,
    (f) `:219` over two variants.
  - `app/test/unitsApiRosterAutoPrimary.test.ts` (new, FakeWorld route): (a)
    `:71` over four shapes and `:96` over roles owner/other, (b) `:111`, (c)
    `:128`, (d) `:145`, (f) `:162` over two variants. Every body posts
    `primaryContact: false`, as the dashboard does.
  - `app/test/unitsRepoRoster.integration.test.ts:82-91` and `:215-221` - two
    existing pins updated (see Decisions 4).
- `dashboard/src/routes/listing/ListingDetail.tsx:513-524` the comment above
  `promotionNotice`, `:532` the sentence. Pins
  `dashboard/src/routes/listing/ListingDetail.test.tsx:1835`, `:1856`; the new
  render test `:1572`. `e2e/support/selectors.md:85`.
- `e2e/tests/dashboard-next/property-roster.spec.ts:295-296` (`UnitWire` gains
  `primary_contact` and a row's `primaryContact`), `:381` (the PM fixture),
  `:412-434` (the block).

## Tests: RED, GREEN and the proofs that each can fail

RED run, against the untouched implementation: 3 files, 15 failed / 23 passed
(`sa1-app-red.log`); every failure diffs `"primaryContact": true` against
`false`, or a primaries list `['...']` against `[]`. GREEN: 3 files / 38. The
mutant runs used the 10-file app set below (135 tests); every mutant was
applied and reverted with the Edit tool and both mutable files
(`unitsRepo.ts`, `twilioWebhookHarness.ts`) were checked against
`.superpowers/sdd/sa1-mutant-baseline.sha256` after each revert (all OK).

| Case | Where | RED on the old code | Can fail (mutant) |
|---|---|---|---|
| (a) ownerless, no primary, add a PM -> PM primary, scalar = PM; x4 shapes | repo `:104` | red: the PM row `primaryContact: false` | MR1 (rule reverted in the repo, `:849` -> request flag only): all 4 red |
| (a) the same, plus roles owner / other | route `:71`, `:96` | red: `"primaryContact": false`; primaries `[]` | MF1 (rule reverted in the fake, `:2972`): all 6 red |
| (b) landlord of record, no primary row -> PM not primary, scalar stays unset | repo `:125`, route `:111` | PIN (green) | MB (`!hasLandlordId` dropped in both): (b) red on both, nothing else |
| (c) ownerless WITH a primary row -> add not primary, primary and scalar unchanged | repo `:144`, route `:128` | PIN (green) | MC (no-primary-row clause dropped in both): (c) red on both, and (e) |
| (d) ownerless, no primary, role landlord -> claims landlordId AND primary, scalar = it | repo `:156`, route `:145` | red: the claim row `primaryContact: false` | MR1 / MF1 |
| (e) two concurrent adds (the file's gated-read racing client) -> exactly one primary row, the scalar names it, and it is the add whose write committed first | repo `:166` | red: primaries `[]` vs `['c-racer-one']` (the lost-write count 1 and the winner detection already held) | MR1 red; MC red; MR5 (the rule decided ONCE, from the first attempt's read - i.e. outside the loop): (e) alone red, and for the reason the in-loop rule exists - the LOSER ended primary (expected `c-racer-two`, received `c-racer-one`) |
| (f) PIN: an upsert of a seat already on an ownerless no-primary list (role edit to owner; role edit to landlord, which claims) -> not primary | repo `:219`, route `:162` | PIN (green) | MF (new-seat clause dropped in both): all four (f) cases red, nothing else |
| claim pin (updated) | `unitsRepoRoster.integration.test.ts:82-91` | red: `primaryContact: false` | MR1 red |
| claim-vs-removal race pin (updated) | `unitsRepoRoster.integration.test.ts:215-221` | red: `primaryContact: false` | MR1 red |
| the new notice sentence, x2 pins | `ListingDetail.test.tsx:1835`, `:1856` | changed FIRST; red on the old copy: "Unable to find an element with the text: ... or a new contact is added." | D1 (old sentence put back at `ListingDetail.tsx:532`): both red, nothing else |
| the Contacts card renders a server-made primary (marker on the added row, no Make primary on it, Dana keeps hers, the page still posts `primaryContact: false`, read mode lists it first) | `ListingDetail.test.tsx:1572` | PIN (green on the unchanged page) | D2 (`runRosterWrite`'s success applies the answer with `setUnit` only, `ListingDetail.tsx:435`): red, with three existing card tests; D3 (the mocked server answer set to the pre-SA-1 non-primary roster - the dashboard analog of reverting the rule): red, alone |
| e2e: after "Restore without a landlord", "+ Add contact" with a PM makes the PM the primary contact | `property-roster.spec.ts:412-434` | red with MR1 applied in the source BEFORE the lane booted (the app runs from source under tsx): `Make <pm> the primary contact` expected 0, received 1 at `:425`; the other three tests passed; exit 1 | that run |

Mutant totals (10-file app set): MR1 8 red, MF1 7, MB 2, MC 3, MF 4, MR5 1;
after the last revert 135/135. Dashboard (2 files, 92): D1 2, D2 4, D3 1 (of
the single file's 82); after the reverts 92/92 and both dashboard files back
on their sha256 baseline (`.superpowers/sdd/sa1-dash-mutant-baseline.sha256`).

## Readers of the primary contact - swept, none breaks

The rule produces no new kind of state: exactly what "Make primary" on a
seated row already produces (one row `primaryContact: true`, every other
demoted, the scalar naming it), and only on a property where every reader
below found NO property contact before.

- `app/src/lib/rosterResolution.ts:293-294` - the default roster's property
  contact is the primary row (`=== true`), else `nonEmpty(landlordId)`;
  ownerless with no primary row resolved no property member. Now it resolves
  the auto-primary contact. The rule tests "no primary row" with the same
  `=== true`, so it fires exactly when this resolver found nobody. The
  tenant-is-property-contact de-dupe is unchanged.
- `app/src/lib/tourContacts.ts:124-129` - the same ladder for tour names and
  reminder copy; its tenant guard is unchanged.
- `app/src/services/rosterProvision.ts:233` (answered "unit has no landlord"
  before) and `:525` (answered 400 `landlord_unreachable` before) - both now
  resolve the auto-primary contact; `:615` goes through the resolver above.
- `app/src/routes/webhooks/voice.ts` - no read of the unit's primary at all:
  the masked call dials the live thread's participants (`:996-998`); the
  business-number-to-unit path is unbuilt (`:627` comment). New relay groups
  pick the primary up through the resolvers; an existing thread is untouched
  (`placementsVoiceRouting.test.ts`, green in gate step 1b).
- ListingDetail's Contacts card (`ListingDetail.tsx:942`, `:972`, `:1005`;
  `buildListingFile.ts:52` sorts the primary first) renders each row's
  `primaryContact` from the server's answer - no page change was needed
  (the new dashboard test and the e2e prove it).
- The `primary_contact` scalar: no runtime reader routes on it (written by
  `unitsRepo`, unit create/PATCH via `unitFields`, and seeds); it is set as
  the existing primary path sets it.
- The rule is role- and type-agnostic, as ruled ("whatever its role"): on an
  ownerless property a tenant or partner added with any role becomes the
  primary contact - the same state Make primary on a seated non-landlord
  already produces. The only type gates on a new seat remain I4 (no
  caseworker) and I3 (a landlord-role claim needs a landlord), both refused
  before the repo call.

## Decisions and divergences

1. "No primary contact" = no row with `primaryContact === true`, the spec's
   definition and the resolvers' test. A stale `primary_contact` scalar with no
   primary row does not count: the add becomes primary and the scalar is
   rewritten to it (an extra (a) shape on both sides pins it).
2. "No landlord of record" = no `landlordId` attribute on the unit as read
   BEFORE the add (`hasLandlordId`, `unitsRepo.ts:809`) - the same test as the
   vacant-slot claim (`:814`), as briefed. An empty-string `landlordId` cannot
   be stored on the real table (it is the byLandlord GSI key).
3. "Adds" = a NEW seat (the orchestrator's recorded interpretation): an upsert
   keeps the request's flag. That includes a seated contact re-roled to
   Landlord on an ownerless property: it claims the slot (today's behavior)
   but is not made primary - the second (f) variant pins it. With that claim
   the resolvers fall back to the new landlord of record, so the property is
   reachable either way.
4. Two existing DynamoDB Local tests pinned the pre-SA-1 behavior and were
   updated in ecbaa09c: `unitsRepoRoster.integration.test.ts` "addContact
   claims an unowned unit ..." (`:82-91`: the claim is now primary and the
   scalar names it) and "preserves the landlord row when a claim races a
   roster removal" (`:215-221`: in either order the claim lands on a unit with
   no primary row and no landlord, so the final row is primary and the scalar
   names it - deterministic in both orders). Both went RED on the old code for
   the stated reason. The file's other two ownerless race tests assert no
   primary flag; they are unchanged and green.
5. Beyond the brief's list: (a) runs over four ownerless shapes on both sides
   (no stored list; an empty list - on DynamoDB Local reached through the real
   `restoreWithLandlord { next: null }`, the e2e's exact state; a list without
   a primary row; a stale scalar), plus roles owner and other on the route;
   (f) has the claim variant; (e) also asserts the lost-write count (1) and
   WHICH add is primary. That last assertion is what kills MR5: "exactly one
   primary row" alone survives a decide-once implementation, because the
   loser's retry demotes the winner and still leaves exactly one.
6. The repo's 'unit contact added' log line gains `autoPrimary`
   (`unitsRepo.ts:915`) beside the effective `primaryContact` it already
   logged. No behavior.
7. (b), (c), (f) and the dashboard render test are PINs (green on the old
   code); their failure proofs are mutants, not a RED-first.
8. e2e: the PM is minted with the test's other fixtures before `page.goto`
   (`:381`), because the Add contact search reads the contact list at page
   mount. In edit mode the proof is the absence of
   `Make <name> the primary contact` (`:425`); the read-mode marker is
   asserted on the row link's accessible name (`^<name> \(primary\)`, `:428`),
   since the "(primary)" span has no role of its own. The test also reads the
   API answer (GET, `:429-434`).
9. The route (`app/src/routes/units.ts`) and its log line are unchanged, as
   briefed (see Noticed 1); the dashboard still posts `primaryContact: false`.

## Gate (bare, from the worktree, at 5d9c317b)

| Step | Command (short) | Exit | Counts |
|---|---|---|---|
| 1a | app `npx vitest run` unitsRepoAutoPrimary.integration, unitsApiRosterAutoPrimary, unitsRepoRoster.integration, unitsApiRoster, unitsApiRosterTypeChecks, unitsRestoreLandlord, unitsRepoRestoreWithLandlord.integration | 0 | 7 files, 109 passed, 0 skipped; the DynamoDB Local suites ran (10, 17, 13) |
| 1b (extra) | app unitsApiActivity, placementsVoiceRouting, unitsSoftDelete (the other suites that drive the fake's `addContact`) | 0 | 3 files, 26 passed |
| 2 | dashboard `npx vitest run` src/routes/listing/ListingDetail.test.tsx src/routes/listing/RestoreLandlordDialog.test.tsx | 0 | 2 files, 92 passed (baseline 91 + the new test) |
| 3 | `npm run typecheck` | 0 | five workspaces, 0 TS errors |
| 4 | `npx eslint $(git diff --name-only --diff-filter=d 2338bef1..HEAD -- '*.ts' '*.tsx')` | 0 | 8 files (list non-empty), no output |
| 5 | `timeout 1200 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/property-roster.spec.ts` | 0 | 4 passed, 0 failed, 0 flaky, 0 skipped (17.4 s); afterwards lane 6's ports (9601/9611/9621/9631) free and its launcher gone |
| 6 | ASCII | - | 2 new files 0 each, no MISSING; 7 edited files, 140 added lines vs 2338bef1, 0 non-ASCII bytes; commit messages 2338bef1..HEAD 0. The one removed line holding non-ASCII bytes is the rewritten "leave any existing primary as-is" comment (its em dash) |

Baselines before any edit: app (the brief's 5 files) 88 passed; dashboard 91.
Earlier e2e runs: RED (MR1 applied) 1 failed / 3 passed, exit 1 (33.1 s);
GREEN before commit 3, 4/4 (18.4 s) - lane ports checked free between every
run, so no run could adopt a previous stack. Every run's output went to
`.superpowers/sdd/logs/sa1-*.log` with `$?` echoed (never piped); each e2e ran
in the background with an exit marker and was waited for in-turn; no file was
edited or committed while one ran. No `[dynamoAdmin]` line and no SKIPPED line
in any of the 35 SA-1 logs. DynamoDB Local was not started, stopped or
restarted; no `AWS_*` variable was exported. No full `npm test` or full e2e
was run.

## Noticed, not fixed

1. The `unit_contact_added` audit row (`app/src/routes/units.ts:1171-1176`)
   and the route's log line (`:1177`) record the REQUEST's `primaryContact`,
   so an auto-promoted dashboard add is audited as `primaryContact: false`.
   Nothing user-facing reads it - Activity (`listingFormat.ts:200`) and the
   contact timeline (`contactTimeline.ts:791`) do not render the flag - and the
   repo log (`unitsRepo.ts:915`) carries the effective flag and `autoPrimary`.
   Left as briefed; anything that later reads the audit for primary changes
   should get the effective flag.
2. The I4 race in `docs/issues/contact-list-checks-outside-roster-write-loop.md`
   widens slightly: a caseworker re-seated as a NEW row by that race on an
   ownerless property with no primary now also becomes primary when the
   request did not ask (before: only with `primaryContact: true`). Same window,
   same suggested fix (carry the seat rule into the attempt loop). That
   issue's line refs have drifted with this change: `unitsRepo.ts` addContact
   is now `:795` (was `:788`), the claim `:814` (was `:807`), the push `:860`
   (was `:839`), the write and retry `:886-907` (was `:862-883`); the harness
   fake `:2941` is unchanged.
3. The scalar comment in addContact (`unitsRepo.ts:873-878`) says
   `primary_contact` "is also the contactId the masked-call landlord leg
   dials, see routes/webhooks/voice.ts"; voice.ts no longer reads the unit (it
   dials the thread's participants, `voice.ts:996-998`). Stale before this
   branch; not touched.
4. The dashboard's `addUnitContact` doc (`dashboard/src/api/endpoints.ts:1048-1059`)
   describes the server's primary handling without the auto-primary rule -
   incomplete, not wrong; outside the brief's copy list.
