# Plan review R1 - reviewer A (adversarial, plan-blind)

Plan: `docs/superpowers/plans/2026-10-27-permanent-flyer-links-plan.md` (v1).
Spec: `docs/superpowers/specs/2026-10-27-permanent-flyer-links-design.md` (rev 3).
Read at branch `feat/permanent-flyer-links` @3db4e4ba. Read-only review; no
suite was run.

## Coverage summary

Every spec decision has a delivering task: D1 -> T1; D2/D3a -> T2; D3 needs no
code (FlyerPage has no status input, `FlyerPage.tsx:300-447`, and already hides
a null listing link via `safeHttpUrl`, `dashboard/src/lib/safeUrl.ts:9-10`);
D4 -> T5; D5/D6 -> T3; D7 -> T4 + T6; D8 -> T7 (+ T9.4); D9 -> watch items;
section 4 -> T1-T8; section 5 -> T1-T9. Reader enumeration (plan section 1) was
re-derived by grepping `SHAREABLE`, `shareable`, `no longer available`,
`flyer link`, `status === 'available'`, `capture_source`, `unit_of_interest`,
`flyerUrl(`, `/p/` across app, dashboard and e2e: no runtime reader of the
invariant is missing (`similarUnits.ts:167`, `ListingsList.tsx:429`,
`unitListFacets.ts:248` are staff-only availability readers unrelated to the
flyer; `applyFlyerShareEntry` has no status gate; `consentMethodFromCaptureSource`
maps 'flyer' and 'housing_fair' identically, `smsCompliance.ts:118-120`). Every
test that pins the old rule and turns a gate red is named by some task. The
findings below are about steps that do not work as written, and tests that
would not be red or would pass vacuously.

---

## F1 [HIGH] T9.1(c) names a helper that cannot create a Setup property

What is wrong. T9.1(c) says to create the fresh Setup property with
`createUnitViaApi(staff.request, stamp, { available: false })` "from
`e2e/support/followUpFixtures.ts:48`". That exported helper's third parameter
is `tourType?: 'self_guided' | 'landlord_led' | 'pm_team'`
(`e2e/support/followUpFixtures.ts:48-52`), not an options object, and it
ALWAYS flips the new unit to `available` (`followUpFixtures.ts:70-73`). The
`{ available: boolean; authorities?: string[] }` signature the plan quotes
belongs to a different, NON-exported local function in
`e2e/tests/dashboard-next/broadcasts.spec.ts:87-112`.

Evidence. `followUpFixtures.ts:48-75`; `broadcasts.spec.ts:87-112`. The test
being rewritten (`public-pages.spec.ts:522-550`) has only a `page` fixture and
no staff session; the plan writes `staff.request` without saying to open one.

What it implies. A literal builder gets an e2e-workspace type error
(`e2e/package.json` typecheck is `tsc -p tsconfig.json`); a builder who forces
the call (or drops the third argument) gets an AVAILABLE unit, so case (c)
asserts the fallback against a served flyer and fails - or, worse, the builder
"fixes" the assertion. The one e2e proof that Setup takes the fallback (spec
section 5) is not deliverable as written.

Suggested fix. In T9.1(c): open a staff page with `devLogin` (as
`public-pages.spec.ts:205-210` does), then POST `/api/units` once and do NOT
call the listing-status transition - a new unit starts in `setup`
(`public-pages.spec.ts:123`, step (1) of `createShareableUnit`). Either inline
that POST or factor step (1) of `createShareableUnit` into a `createSetupUnit`
helper in the same spec. Assert the created unit's status is `setup` through
`GET /api/units/:id` before visiting `/p/<id>`, so the case cannot silently test
an Available unit.

---

## F2 [MEDIUM] T3's "two sign-ups in 24 hours from the same occupied flyer -> one pin" is not red and does not prove R4

What is wrong. T3 step 1 lists this case under "Red because occupied/on_hold
are not `viaFlyer` today". It is green today. With the old gate an occupied
flyer is not `viaFlyer`, so `sourceRefId` is undefined (`public.ts:692`) and
both sign-ups hit the shared no-property source; `hasEventSince` with no ref
matches the no-ref pin (`activityEventsRepo.ts:19-21`), so the second sign-up
is a repeat and there is exactly one pin - the same count the new code gives.

What it implies. The test cannot fail if the R4 re-keying regresses (e.g. if
`sourceRefId` is computed from a stale `SHAREABLE_STATUSES` check). It is a
vacuous assertion presented as the R4 proof.

Suggested fix. Make the case distinguish the two sources: (a) `/join` sign-up,
then an occupied-flyer sign-up within 24 hours -> TWO pins (new: different
sources; old: one), and/or (b) assert the single pin carries
`refType: 'unit', refId: <unitId>` and that `hasEventSince` was called with the
unitId as its 4th argument (the file already spies on it,
`publicSignupLeads.test.ts:481`).

---

## F3 [MEDIUM] Renaming `unit-placed` to `unit-setup` can silently re-point a test at the MISSING-unit path

What is wrong. T3 asks the builder to rename the seeded id `unit-placed` ->
`unit-setup` "with the matching `unitId` in the request bodies" across many
separated sites in `publicSignupLeads.test.ts` (seed at `:287`, `:469`, `:727`,
`:858`, `:1048`, `:1166`; request bodies at `:282`, `:475`, `:734`, `:859`, and
the `PIN_FORMS` row `:1040`) and in `publicIntake.test.ts` (`:920`, `:1186`).
The seed and the body are often in different statements (`PIN_FORMS` is a
module constant far from its seeds).

What it implies. Any body left at `'unit-placed'` after its seed is renamed
posts a made-up id. A made-up id takes the identical no-property path (label
`Signed up from a flyer as ...`, no ref, `sentSkipped 'not_shareable'`;
`public.ts:206`, `:764-765`), so every such test stays GREEN while testing
"missing" instead of "setup" - exactly the boundary spec section 5 says these
re-pointed tests exist to cover ("so the boundary is really tested").

Suggested fix. Change only the STATUS (`'placed'` -> `'setup'`) and keep the
ids, or, if the ids are renamed, add a step: after the edit,
`git grep -n "unit-placed" -- app/test` must return nothing. Either makes the
mistake visible.

---

## F4 [LOW] The unused-import cleanup is instructed in T2 but becomes due in T3

What is wrong. T2 says "If `SHAREABLE_STATUSES` has no other use left in the
file after T3, drop it from the import". After T3 it has none (its only uses
are `public.ts:515` and `:845`; D3a uses the literal `'available'`). T3 itself
never repeats the instruction.

What it implies. A builder following T3 literally commits an unused import;
`@typescript-eslint/no-unused-vars` is configured (`eslint.config.mjs:32`), so
gate 5 at T10 reports it. Caught, but late, and the T3 commit carries it.

Suggested fix. Move the instruction into T3 step 2: "remove
`SHAREABLE_STATUSES` from the `public.ts` import (`:71`); it has no use left".

---

## F5 [LOW] T5's submit assertion uses an id the test file never routes

What is wrong. T5 says "submitting sends `{ ...input, unitId: 'u1' }` (the
route id)". `FlyerPage.test.tsx` renders `/p/unit-1` by default
(`renderPage(entry = '/p/unit-1')`, `FlyerPage.test.tsx:55`; existing calls
assert `unitId: 'unit-1'`, `:397`).

What it implies. A literal assertion on `'u1'` fails against the default
route; a builder will fix it, but the plan asserts a value that is wrong in
this file.

Suggested fix. Say `unitId: 'unit-1'` (or "the route id of the rendered
entry").

---

## F6 [LOW] Wrong path for the steps.ts comment site

What is wrong. T8 (copied from spec section 4) names `e2e/support/steps.ts:1033`.
That file does not exist; the comment ("the only shareable status") is at
`e2e/scenarios/steps.ts:1033`.

Suggested fix. Correct the path in T8. The T8 sweep would find it anyway, but
a named site that does not exist invites a builder to conclude it was removed.

---

## F7 [LOW] The T8 sweep excludes app/test and app/scripts, leaving titles that state the old rule

What is wrong. T8's sweep covers `app/src dashboard/src e2e documentation
docs/issues`. Outside it, after this change, text states the old rule as
current: the publicIntake describe `GET /public/units/:unitId/flyer -
shareable view only` (`app/test/publicIntake.test.ts:336`) and its header
`(shareable fields only, 404 otherwise)` (`:3`), `:686` ("the whole-flyer
shareable gate"), `:931`; `app/scripts/backfill-join-housing-authority.ts:150`
("a flyer one for an unshareable unit"); `app/test/broadcastApi.test.ts:2165`
("any non-shareable status" - still true for sends, arguably fine). Spec
section 4 asks for every code comment that says Available gates the flyer.

Suggested fix. Add `app/test` and `app/scripts` to the sweep paths; leave
historical RUNBOOK prose (`RUNBOOK.md:456` describes data from before the
change and stays true).

---

## F8 [LOW] Spec section 5 asks for the properties-sent entry on BOTH Occupied and On hold; the plan asserts it for Occupied only

What is wrong. Spec section 5 app: "Sign-up from an Occupied and an On hold
flyer: capture source 'flyer', unit of interest, pin label ..., properties-sent
entry written." T3 covers capture source and unit of interest for both via
`it.each`, but the sent-entry assertion (`sentRecorded: true`) only for
occupied, and the On hold label only with no address.

Suggested fix. Run the occupied label + sent-entry case as
`it.each([['occupied','Occupied'],['on_hold','On hold']])`.

---

## F9 [LOW] The ASCII check reads only UNSTAGED changes

What is wrong. Ground rules give
`git diff -U0 -- <file> | grep '^+' | grep -nP '[^\x00-\x7F]'` as the added-line
check. `git diff` without `--cached`/a range shows unstaged changes only, so
run after `git add` (the natural place, just before commit) it prints nothing
and "passes" having checked zero lines - the same trap AGENTS.md documents for
gate 5's bare `git diff`.

Suggested fix. Use `git diff -U0 HEAD -- <file>` before the commit, or
`git diff -U0 main...HEAD` at T10.

---

## F10 [LOW] T10 does not say where the self-QA record and handback go

What is wrong. AGENTS.md ("Mission reasoning is version-controlled") requires
self-QA and the handback to be committed under
`docs/superpowers/reviews/YYYY-MM-DD-<branch>/` as produced. T10 says only that
screenshots go under `.playwright-mcp/` (gitignored).

Suggested fix. Add to T10: write the self-QA findings to
`docs/superpowers/reviews/2026-10-27-permanent-flyer-links/self-qa.md` (or the
mission's chosen name) and commit it; screenshots stay in `.playwright-mcp/`.

---

## Checked and found sound (no finding)

- T1-T2 ordering and types: `UnitStatus = ListingStatus`
  (`unitsRepo.ts:58`), so `LISTING_STATUS_LABELS[status as ListingStatus]` and
  the `ReadonlySet<string>` re-export compile as SHAREABLE's does
  (`unitsRepo.ts:64`).
- T2 payload: `toUnitFlyer` is called only from `public.ts:854`, and
  `listing_link` is already `string | null` on both sides
  (`unitFields.ts:418`, `publicApi.ts:45`), so nulling it in the route needs no
  type change.
- T5 handler type: IntakeForm's `onSubmit` takes
  `Omit<HousingFairInput, 'unitId' | 'housingAuthority'>`
  (`IntakeForm.tsx:23`); the plan's `Omit<HousingFairInput, 'unitId'>` handler
  is assignable, as `handleIntakeSubmit` already is (`FlyerPage.tsx:247`).
  IntakeForm text holds none of `taken|removed|no longer available`, so the
  body-text negative assertion is not vacuously red.
- T6: nothing between `ListingDetail.tsx:418` and `:434` reads `deleted`; the only
  `flyerShareable` reader is `ListingDetail.tsx:940`.
- T9.5: a manual `occupied` transition needs no placement
  (`services/statusTransition.ts:684-703`); `createAvailableUnit` sets a
  `listing_link`, and `sentOutcome` / `signedUpPins` exist
  (`flyer-leads.spec.ts:164-248`).
- `environment-identity.spec.ts:40-50`: the fallback form adds no
  `/auth/me` or identity request, so the request-count assertions hold.
- Seeded `unit-0001` read-only in T9.1(d) is robust: no derivation yields
  `setup`, so any status another spec drives it to is still public.
