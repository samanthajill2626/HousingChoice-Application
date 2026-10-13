# Plan review R2 - reviewer A

Plan: `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md` v2 @dd8505e5
Spec: rev 6 as edited in dd8505e5 (4.7 bullet, 9.2 scalar paragraph)
Inputs read: `plan-review/adjudications.md`, `plan-review/R1-reviewer-b.md`,
`plan-research/plan-assembly-rulings.md` (R2), `git diff 08fd4208 dd8505e5`.
Read-only: nothing was run except grep, sed and git.

Decisions DO change: two findings are BLOCKING. Literal execution stops at a
GREEN step that the plan says will pass.

## Scope

Re-read deeply in this round:

- Every v2 change: section 0, the section 3 watch items, the S1 preconditions,
  S2.7 (`oldWasPrimary` + `else`), S2.8 (`clearedLandlordHeir`, the fake, the
  new test and its RED line), S3.7 (2b), S4.13 2b, the SUPERSEDED notes, spec
  4.7 and 9.2.
- Both R1 reports' "skimmed" sets, now read against the tree: S3.2, S3.4, S4.1,
  S4.2, S4.10b, S4.11, S4.12, S5.3 (run), and S5.6 walk (c).
- Every existing app test that drives the contact-list route, the restore
  route, or `restoreWithLandlord`. These are `unitsApiRoster`,
  `unitsApiRosterAutoPrimary`, `unitsApiRosterTypeChecks`, `unitsApiActivity`,
  `unitsRestoreLandlord`, `unitsRepoRestoreWithLandlord.integration`,
  `unitsRepoAutoPrimary.integration` and `unitsRepoContactListRules.integration`.

## Findings

### N1 [BLOCKING] The v2 flag-only rule contradicts three existing caseworker-integrity pins the plan leaves untouched, so S2.7 and S2.8 GREEN fail

**What is wrong.** v2 decides "was the old landlord the primary?" from the flag
only, in three places: plan L7974 (real repo), L8718 (`clearedLandlordHeir`)
and L8901 (fake). With no hand-off, the new `else` branch re-aligns the scalar
to the stored flag (`primary_contact` = the flagged row, else REMOVE).

Three existing tests pin the OPPOSITE behavior. Each is named for it and cites
caseworker-integrity "R1 code review, backend finding 4":

- `app/test/unitsRepoRestoreWithLandlord.integration.test.ts:154-173`, "moves
  the primary to the new landlord when only the primary_contact scalar named
  the old one".
  - Setup: roster `[c-old false, c-pm false]`, scalar `c-old`, swap to `c-new`.
  - Under v2: `oldWasPrimary` is false, so the `else` branch REMOVEs the scalar
    and `c-new` joins non-primary.
  - The test expects `primary_contact === 'c-new'` and the `c-new` row flagged.
    It FAILS.
- The same file, `:248-262`, "without a landlord: promotes when only the
  primary_contact scalar named the cleared landlord".
  - Setup: `promote: 'c-pm'`.
  - Under v2: no hand-off, so the contacts stay `[c-pm false]` and the scalar
    is REMOVEd.
  - The test expects `c-pm` flagged. It FAILS.
- `app/test/unitsRestoreLandlord.test.ts:386-403`, "promoted too when only the
  primary_contact scalar named the cleared landlord" (route + fake).
  - Under v2 the result is `[c-pm false]`, with no `primaryPromoted`.
  - The test expects `c-pm` promoted. It FAILS.

The plan says the opposite of what will happen:

- S2.7 step 1(b) EDITS the first test's call ("Call 2", L7718). It states
  "every assertion stays as it is" (L7659) and "The edited existing file passes
  already" (L7829). Both claims are true at RED, under the old code, and false
  at GREEN.
- S2.7 step 4 (`unitsRepoRestoreWithLandlord.integration.test.ts`, "Expected:
  all pass") fails twice.
- S2.8 step 4 (`unitsRestoreLandlord.test.ts`, "Expected: all pass") fails
  once.

The builder gets no instruction for this. Its options are to stop, or to
rewrite pins from a merged feature on its own initiative.

**Answer to the coordinator's RED question.** The NEW S2.8 test (L8508) IS red
at its RED step, for the reason its RED line gives. The route still runs
`main`'s `soleLandlordToPromote` (`app/src/routes/units.ts:468`, the scalar
disjunct). The fake's `restoreWithLandlord` is still `main`'s, which carries
the same disjunct and was only replaced in S2.8 (e). Neither touches the S2.7
real-repo change. So both legs promote nobody (two eligible rows) and clear
`c-pm`'s flag. It goes GREEN after S2.8. The defect is the three OLD pins, not
the new test.

**Answer to the `else`-branch question.** I walked every restore test listed
above. Apart from the three pins, every case either:

- hands off (the old landlord's row is flagged: `seedDeletedUnit` /
  `seedClearedPrimary` defaults at `unitsRestoreLandlord.test.ts:23-38,348-353`,
  and all S2.7 and S2.12 restore cases),
- already has the scalar equal to the flag (`u-p5` at `:437-461`, and the PINs
  at repo `:126-146` and `:265-281`), or
- writes nothing (the race and conflict tests at `:284-306` and repo
  `:283-400`).

So the re-align breaks no other existing test.

**Implication.** The planner has to choose. Both options keep the new u-p8
test GREEN.

- (a) Keep flag-only, as spec 9.2 now says.
  - Rewrite the three pins to the new outcome: no hand-off, the scalar
    REMOVEd, the new or remaining contact left unflagged. Add them to S2.7 and
    S2.8's file lists and RED/GREEN text.
  - Those rewritten repo tests then become the real-repo pin (N3).
  - The cost is a user-visible change to a merged rule. A zero-flag owned unit
    restored without a landlord no longer promotes its remaining landlord-typed
    contact, so it ends with no primary although an eligible contact exists.
  - That also falsifies the GLOSSARY text (N4).
- (b) Decide "was the primary" by P1's own candidate order instead of the
  scalar.
  - The rule: the old landlord's row is flagged, OR no row is flagged at all
    (P1 then falls back to the landlord of record). This reads no scalar.
  - It keeps all three pins' expectations unchanged: `:154` hands off to
    `c-new`, `:248` and `:386` promote `c-pm`.
  - It needs one spec sentence. Spec 4.6 / 4.7 "primary" then means "the
    property contact by P1's order" for the two restore deciders.

Either way, the plan must say which, and must touch the three tests.

### N2 [BLOCKING] S2.4 GREEN fails: an existing add test seeds no record for the landlord of record, which widened P2 now reads as absent

**What is wrong.** `app/test/unitsApiRoster.test.ts:166-190`, "adds a roster
contact, denormalizes name/company, and audits unit_contact_added":

- The test seeds `u-3` with `landlordId: 'c-ll-1'` and NO contact record for
  `c-ll-1`.
- It adds `c-pm-3`, which is typed `landlord` (eligible), with `role: 'pm'`.
- It expects `c-pm-3` to be `primaryContact: false`.

After S2.4:

- The fake's `addContact` calls `autoPrimaryLivenessIds`. The derived
  `c-ll-1` row is both the flagged primary and the landlord of record, so the
  ids are `['c-ll-1']`.
- The route's `readRosterContacts` asks `world.contactsRepo.getManyByIds`. It
  answers a complete map without `c-ll-1`, which means MISSING.
- `decideAutoPrimary` counts a missing contact as absent (spec 4.4) and
  answers `promote`.
- So `c-pm-3` becomes primary and the test fails.

S2.4 step 4 (plan L6026, "Expected: all pass") runs this file. S2.6, S2.14
and S3.5 run it too. The plan adds the analogous seed for the REMOVE test
(S2.6 (b), `seedContact(world, 'c-ll-c')`) but not for this ADD test. Both R1
reviewers missed it.

I checked the other route-level add callers. `unitsApiRosterAutoPrimary`
seeds its landlords and primaries (`:200,:219,:238`). `unitsApiRosterTypeChecks`
and `unitsApiActivity` add only non-eligible types, or ask for primary
explicitly. Direct `world.unitsRepo.addContact` calls pass no `opts`, so they
keep `main`'s rule. This is the only one.

**Implication.** Add an Edit to S2.4 that seeds `c-ll-1` as a live contact,
with the same one-line reason S2.6 gives. Then list the file under S2.4's
modified files and RED/GREEN text.

### N3 [MEDIUM] No real-repo or parity pin covers the flag-only rule or the new `else` re-align

**What is wrong.** The only test of the v2 fix is the new S2.8 route test,
which runs on the FakeWorld fake.

- The real repo and the fake share only `chooseHeir` / `applyPrimary`. The
  `oldWasPrimary` decision and the new `else` branch are hand-copied in both
  (L7974 and L8040-8047 versus L8901 and L8948-8953).
- S2.7's new integration file (L7340-7650) has no stale-scalar case, and no
  case where the scalar differs from the flag on a no-hand-off restore.
- S2.12 parity (L10560-10790) has one restore case, and its old landlord is
  flagged.
- So a builder who keeps the scalar disjunct, or drops the `else`, in
  `unitsRepo.restoreWithLandlord` passes every test once N1's pins are deleted.
- `unitsRepo.restoreWithLandlord` is the code that runs in production.

**Implication.** Yes, a real-repo pin is needed, because the deciding code is
duplicated rather than shared.

- Under N1 (a), the two rewritten repo tests are that pin.
- Under N1 (b), add one repo case with a stale scalar beside a live flagged
  contact, and one with no flag.
- Either way, add a parity case to S2.12: "restore clear: stale scalar, live
  flagged contact stays, scalar re-aligned".

### N4 [LOW] S5.9's GLOSSARY claim about when zero primary is reachable overclaims

**What is wrong.** Plan L20286 says: "zero primary is reachable only when
nobody can take over (no live landlord of record and no eligible live contact)
or for legacy data the script has not repaired." Two non-legacy paths
contradict it:

- Under N1 (a): "Restore without a landlord" of a zero-flag owned unit with an
  eligible contact.
- In both v1 and v2: the explicit API demotion `primaryContact: false` on the
  primary row (ruling R10), which leaves zero primary beside a live landlord or
  an eligible contact.

**Implication.** Name the API demotion, and the (a) path if (a) is chosen, or
soften the sentence.

## The new gate commands (Git Bash on Windows)

None of the following was run, per the review rules.

- S3.7 (2b): `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test -w @housingchoice/app`.
  - `env` is coreutils (`/usr/bin/env` in this shell).
  - `npm` on PATH is a `#!/usr/bin/env bash` script, which the MSYS runtime
    can exec.
  - The workspace name matches `app/package.json:2`, and its `test` is
    `vitest run` (`app/package.json:10`). This is also AGENTS.md's own form.
  - The `grep ... || echo` probe is fine.
  - Expected to work. UNVERIFIED.
- S4.13 2b, the file list: the quoted pathspecs `'dashboard/*.ts'` match nested
  files, because git's default pathspec `*` crosses `/`.
- S4.13 2b, the baseline: `git show f204106f:<path> | npx eslint --stdin --stdin-filename <path>`.
  - The `REV:path` argument does not start with `/`, so MSYS path conversion
    leaves it alone.
  - `eslint.config.mjs` uses no typed linting, so `--stdin` lints the same as a
    file would.
  - `f204106f` predates every S1-S4 change, and no slice before S4 touches
    `dashboard/`.
  - Expected to work. UNVERIFIED.
- One omission: unlike AGENTS.md gate 5, S4.13 2b has no "if the list is empty,
  skip" guard. S4 always touches dashboard files, so it cannot bite here. No
  finding.

## Contesting the adjudications

- **P1 (resolution incomplete).** "Restore paths decide from the FLAG only ...
  New S2.8 test" does not resolve the finding as written, for three reasons:
  - It reverses three named caseworker-integrity pins without touching them
    (N1), so the build stops at S2.7.
  - It is pinned only through the fake (N3).
  - It frames the change as "dropping a scalar read" (spec 9.2), but it also
    changes what a zero-flag owned unit's restore does. A decision of that
    weight should be (b), or should be ruled explicitly for (a).
- **P6.** The new 4.7 wording covers "a write that does not touch the primary"
  and describes only a leftover deleted flag. Under (a), a landlord-clearing
  restore of a zero-flag unit removes the P1 property contact without "touching
  the primary", and leaves an eligible live contact unpromoted. That case is
  not described anywhere in the spec.
- P2, P3, P4, P5, P7: no disagreement. S3.7 (2b) and S4.13 2b do what P5
  promises.

## Swept and found sound this round (no finding)

- S3.2:
  - The `resolveOwnerInputs` anchor (`app/src/jobs/relayFanOut.ts:785-786`) and
    the intro-handler anchor (`:949-957`) exist verbatim.
  - `RelayOwner`, `getOwner` and `log` are in scope there (`:83-87`, `:744`).
  - Every harness piece the new test uses exists:
    - `InMemorySchedulerAdapter` / `InProcessOutboundQueueAdapter.settle()`
      (`adapters/scheduler.ts:81,137,212`);
    - the `jobs.ts` exports (`:67,77,82,159,290,346`);
    - `world.toursMap`, `world.adapter`, `world.sendAttemptsRepo` and
      `settingsRepo.putOrgSettings`.
  - The placement case's `no_street_address` follows from P1 found plus no
    address.
- S3.4: the `reason` projection is gated on the event type, and the
  listing-status pin holds.
- S4.1: the `rosterPeople` anchor is unique, and the skip sits before the
  `onRoster` check (`rosterPeople.ts:104`).
- S4.2:
  - `GENERIC_WRITE_FAILURE` / `refusalMessage` exist
    (`shared/rosterWrites.ts:179,189`).
  - The link style matches the duplicate warning (`RosterConfirmDialog.tsx:261-262`).
- S4.10b: the anchors match `RestoreLandlordDialog.tsx:94-99`.
- S4.11: `who`, `contactLink` and `humanize` are in scope
  (`listing/listingFormat.ts:172-174`).
- S4.12: `LANDLORD` / `TENANT` fixtures and the More actions / Delete contact
  path exist (`ContactDetail.test.tsx:236,264,1145-1146`).
- S5.3: the run scans with `deleted: 'any'` and `consistentRead`, does one
  complete read per unit, and has no audit on align.
- S5.6 walk (c):
  - Three live non-caseworker rows give "Choose a primary". The tenant counts
    for the deliberate-click box, as spec 7.4 says.
  - The heir skips the tenant.
- The R2 ruling text now matches S2.4 (c) / S2.8 (a) / S3.5 3a, and the two
  SUPERSEDED notes are correct.
- Section 0's two S2 windows and DynamoDB probe paragraph are accurate
  (`app/test/globalSetup.ts:72-86`).
