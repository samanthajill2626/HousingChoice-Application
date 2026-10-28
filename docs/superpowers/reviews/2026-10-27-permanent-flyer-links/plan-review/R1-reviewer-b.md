# Plan review R1 - reviewer B (adversarial, plan-blind to rationale)

- Plan: `docs/superpowers/plans/2026-10-27-permanent-flyer-links-plan.md` (v1)
- Spec: `docs/superpowers/specs/2026-10-27-permanent-flyer-links-design.md` (rev 3)
- Repo read at branch `feat/permanent-flyer-links` HEAD 3db4e4ba (code identical
  to d0e2c2d8; the two later commits are docs only).
- Method: walked D1-D9, spec sections 4 and 5 to tasks; grepped app/src,
  app/test, app/scripts, dashboard/src, e2e (tests, scenarios, support,
  performance), documentation, docs/issues, scripts, RUNBOOK and README for
  `SHAREABLE|shareable`, `no longer available`, `flyer link`, `/p/`,
  `public/units`, `housing-fair`, `status === 'available'`, `capture_source`,
  `unit_of_interest`, `signed_up`; read every hit that touches the flyer gate
  or flyer-sign-up credit.

Coverage summary: every spec decision D1-D8 has a delivering task, and the
reader/writer enumeration in plan section 1 is complete for RUNTIME behavior
(I found no reader of the gate that the plan misses: `SHAREABLE_STATUSES` has
exactly three runtime readers - `public.ts:515`, `public.ts:845`,
`broadcasts.ts:1189` - plus the dashboard-only `ListingDetail.tsx:418`,
`BroadcastComposer.tsx:376/544` and `RecipientPreview.tsx:390`; the share
ledger `applyFlyerShareEntry` has no status check, `shareLedger.ts:276-296`;
`capture_source` / `unit_of_interest` have no reader outside `public.ts` but
`consentMethodFromCaptureSource`, which maps 'flyer' and 'housing_fair' alike,
`smsCompliance.ts:112-123`). The findings below are about steps that, executed
literally, do not pass, do not test what they claim, or leave a gate red.

---

## F1 [HIGH] T9 step 1(c) mints the Setup property with a helper that does not exist in that shape

What is wrong. T9 step 1(c) says: "a fresh Setup property
(`createUnitViaApi(staff.request, stamp, { available: false })` from
`e2e/support/followUpFixtures.ts:48`)".

Evidence.
- `e2e/support/followUpFixtures.ts:48-75`: `createUnitViaApi(api, stamp,
  tourType?: 'self_guided' | 'landlord_led' | 'pm_team')`. The third argument
  is a tour type, and the helper ALWAYS flips the unit to `available`
  (`:70-74`). There is no `available` option.
- The `{ available: boolean }` signature is a DIFFERENT, file-local, unexported
  helper in `e2e/tests/dashboard-next/broadcasts.spec.ts:87-114`.
- The test being rewritten (`public-pages.spec.ts:522-550`) takes only
  `{ page }`; there is no `staff` in scope. The file's own pattern opens a
  staff page with `devLogin` (`public-pages.spec.ts:205-209`).

What it implies. Literally executed: an e2e `tsc` error (an object passed
where a string-literal union is expected) at gate 1, and, if cast through, an
AVAILABLE unit whose `/p/<id>` renders the full flyer, so the "Setup property
-> fallback" assertion fails. A builder improvising a fix may well reach for
`createShareableUnit` and skip its flip, or copy broadcasts.spec's helper - the
plan should say which.

Suggested fix. Name the real mechanism: open a staff page as
`public-pages.spec.ts:205-209` does, then `POST /api/units` directly (a new
unit starts in `setup`, `units.ts` ~982) or add a `{ publish: false }` option
to the spec file's own `createShareableUnit` (`public-pages.spec.ts:103`).
Do not cite followUpFixtures.

---

## F2 [HIGH] T9 step 1(d) asserts an address heading the seeded unit cannot render

What is wrong. T9 step 1(d): "`UNDER_APPLICATION_UNIT` -> the `Sign up for
home alerts` heading and its address heading".

Evidence.
- The seeded `unit-0001` stores its address as a STRING:
  `app/src/lib/seed/lean.ts:224`
  (`address: '1450 Joseph E. Boone Blvd NW, Atlanta, GA 30314'`), and has no
  `area`.
- `toUnitFlyer` re-validates the address with `validateAddress`
  (`app/src/lib/unitFields.ts:482`), which rejects any non-object
  (`app/src/lib/address.ts:54-56`), so the payload carries `address: {}`
  (`unitFields.ts:501`).
- With no address part and no area, FlyerPage renders the PLAIN h1 "Home for
  rent" (`FlyerPage.tsx:136-143`, `:327-329`) - no Maps link, no address
  heading.

What it implies. Step (d) as written is red on the first run. Worse, a
builder who "fixes" it by changing the seeded unit's address breaks WI7 and
the lean world other specs read.

Suggested fix. Assert what the seeded unit really serves: the h1 `Home for
rent`, the `Sign up for home alerts` h2 and the `Sign up` button (exact), and
count 0 for `/no longer available/i`. Note in the plan that the seeded
address is a legacy string, so no address heading appears.

---

## F3 [MEDIUM] The unused `SHAREABLE_STATUSES` import is assigned to the wrong task and will fail gate 5

What is wrong. T2 step 2 says "If `SHAREABLE_STATUSES` has no other use left
in the file after T3, drop it from the import". At T2 time it still has a use
(`viaFlyer`, `public.ts:515`), so the instruction is not actionable in T2. T3
replaces that last use (`public.ts:515`) and its GREEN steps never mention the
import.

Evidence. `SHAREABLE_STATUSES` appears in `public.ts` only at `:71` (import),
`:515` and `:845`. ESLint has `@typescript-eslint/no-unused-vars` on
(`eslint.config.mjs:32`); `public.ts` is a touched file, so gate 5 reports a
NEW error. `tsc` does not catch it (no `noUnusedLocals` in
`tsconfig.base.json`), so T3's `npm run typecheck` stays green and the miss
surfaces only at T10.

Suggested fix. Move the step into T3 GREEN, unconditionally: "replace the
`SHAREABLE_STATUSES` import in public.ts with `FLYER_PUBLIC_STATUSES`; it has
no use left". Delete the conditional from T2.

---

## F4 [MEDIUM] T3's repeat-check test is green before the change, so it does not test the R4 rekey

What is wrong. T3 RED adds "Two sign-ups within 24 hours from the same
occupied flyer -> one pin (the repeat check now keys on that unit, R4)" and
claims the whole RED block is red "because occupied/on_hold are not
`viaFlyer` today".

Evidence. Today an occupied unit is not `viaFlyer`, so `sourceRefId` is
`undefined` (`public.ts:692`) and the repeat check runs against the shared
"no property" source (`public.ts:696-701`, comment `:678-682`). Two sign-ups
from the same occupied flyer therefore ALREADY produce exactly one pin. The
assertion passes before and after the change; it cannot detect a regression
where `viaFlyer` widens but the source stays the no-property one.

What it implies. R4 (pin source for the 24-hour repeat check) - a behavior the
spec names in D5 - has no discriminating test.

Suggested fix. Make the case discriminate: (a) assert the single pin carries
`refType: 'unit'` and `refId: <occupied unitId>`; and (b) add a sign-up from
the occupied flyer followed, within 24 hours, by a `/join` sign-up (no unitId)
-> TWO pins (today: one, because both are the no-property source). Optionally
two different occupied flyers -> two pins.

---

## F5 [LOW] T8's sweep runs before T9 over the same e2e files, and its scope is narrower than the spec's

What is wrong.
- Ordering: T8 (docs-only) sweeps `e2e` for `shareable|no longer
  available|flyer link` and says "Fix every hit that states the old rule". The
  hits in e2e are T9's own rewrite targets: `public-pages.spec.ts:36-38,
  47-49, 57, 522-548`; `listing-photos.spec.ts:24-25, 307, 327, 333-336`;
  `environment-identity.spec.ts:44`; `broadcasts.spec.ts:83, 278, 283`. A
  literal T8 either edits test logic in a "docs-only" commit (with no RED
  step) or leaves them with no rule for which; T9 then names only some of
  them (it does not mention the public-pages header lines 36-38/47-49, nor
  the listing-photos header item (6) at :24-25 or the E1 test title at :307).
- Scope: the sweep path list omits `app/test`, `app/scripts`, `scripts/`,
  `RUNBOOK.md`. Stale old-rule text that remains: 
  `app/scripts/backfill-join-housing-authority.ts:150` ("a flyer one for an
  unshareable unit"), `scripts/e2e-session.mjs:169` ("cascade into 'no longer
  available' funnels"), `app/test/publicIntake.test.ts:3, 336, 382, 686`
  ("shareable view only", "whole-flyer shareable gate").
- `e2e/support/selectors.md` gets only the pin row (~54); the new fallback
  page (h1 `Find a home that fits your voucher`, `Sign up` button, `text us`
  link) is a new public surface with no selector entry beside the flyer rows
  at `:46` and `:143`.

Suggested fix. Exclude `e2e/tests` from T8 and make T9 own every e2e comment
and title (list the header lines above). Extend the sweep to `app/test
app/scripts scripts`. Add a fallback row to selectors.md in T8.

---

## F6 [LOW] T5's "no status words anywhere" assertion can pass vacuously during Loading

What is wrong. T5 asserts `document.body.textContent` has no
`/no longer available|taken|removed/i` "in every fallback case" but does not
say to await the fallback first. Before the mocked `getFlyer` rejects, the
page shows only "Loading..." (`FlyerPage.tsx:256-262`), which passes.

Also: T5 says the submit sends `{ ...input, unitId: 'u1' }`, but the file's
`renderPage()` default route is `/p/unit-1` (`FlyerPage.test.tsx:55`).

Suggested fix. Say: assert body text only after `findByRole('heading', { name:
'Find a home that fits your voucher' })` resolves. Use `unit-1` (or pass the
route explicitly).

---

## F7 [LOW] No end-to-end proof of D3a, though the e2e unit already carries a listing link

What is wrong. D3a (no "See the full listing" on a non-Available flyer) is
tested only at the API (T2) and assumed at the page (`safeHttpUrl(null)`). T9
step 5 opens `/p/<id>` of an Occupied unit created by `createAvailableUnit`,
which sets `listing_link` (`flyer-leads.spec.ts:168, 189`), and asserts
nothing about it. T10 self-QA mentions "no Listing row" only manually.

Suggested fix. In T9 step 5, before signing up, assert
`getByRole('link', { name: /see the full listing/i })` has count 0 and
`Watch the tour` is still visible (D3a keeps the video link).

---

## F8 [LOW] On hold sign-up does not assert the properties-sent entry the spec lists

What is wrong. Spec section 5: "Sign-up from an Occupied and an On hold
flyer: capture source 'flyer', unit of interest, pin label ..., properties-sent
entry written." T3 asserts the entry (`sentRecorded: true`) only for the
occupied case; the on_hold case asserts only the no-address label.

Suggested fix. Add `sentRecorded: true` (and no `sentSkipped`) to the on_hold
case, or make the occupied entry case an `it.each(['occupied','on_hold'])`.

---

## F9 [LOW] Dashboard FLYER_PUBLIC "parity" test is a second hard-coded list, not a mirror check

What is wrong. T4 compares the dashboard mirror to a literal six-status list.
The repo already has a cross-workspace mirror mechanism that imports the APP
module into a dashboard test and compares (`dashboard/src/routes/contact/
contactStatusMirror.test.ts:11-28`, importing
`../../../../app/src/lib/statusModel.js`, a leaf module). The spec's wording
("equals the same six statuses") is satisfied, but the two lists can drift if
someone edits one constant and its own literal test together.

Suggested fix. In T4, compare the dashboard `FLYER_PUBLIC` to the app's
`FLYER_PUBLIC` imported the same way (keep the literal check too if wanted).

---

## F10 [LOW] Wrong path and a false claim carried into the plan

- T8 lists `e2e/support/steps.ts ~1033`; that file does not exist. The site is
  `e2e/scenarios/steps.ts:1033` ("the only shareable status"). Inherited from
  spec section 4.
- T2 and WI1 say `toUnitFlyer` "has other callers". In `app/src` its only
  caller is `public.ts:854`. Harmless as an instruction (do not change it),
  but the stated reason is false; the real reason is that nulling the link is a
  route decision about status, not a projection of unit fields.

---

## F11 [LOW] T10 self-QA has no records destination

What is wrong. T10 says screenshots go under `.playwright-mcp/` but names no
self-QA report. AGENTS.md ("Mission reasoning is version-controlled") requires
self-QA and the handback under
`docs/superpowers/reviews/2026-10-27-permanent-flyer-links/`, committed as
produced.

Suggested fix. Add: write the self-QA findings to
`docs/superpowers/reviews/2026-10-27-permanent-flyer-links/self-qa.md` and
commit it; screenshots stay in `.playwright-mcp/`.

---

## Checked and found sound (no finding)

- T1 RED is really red (missing exports read as undefined).
- T2 existing-test sites are correct: `publicIntake.test.ts:503-505`
  ('placed'), `:650-660` (`on_hold` as the not-shareable case - this one WOULD
  go red, and T2 updates it), `:713-715` (E1).
- T3 `unit-placed` sites in `publicSignupLeads.test.ts` (`:282, 287, 469, 727,
  858, 1040, 1048, 1166`) and `publicIntake.test.ts` (`:571-583, 919-923,
  1184-1194`) match the plan; 'placed' stays non-public, so none goes red on
  its own - the plan's retargeting to `setup` is a meaning fix, as the spec
  asks.
- The manual `available -> occupied` transition used by T9 step 5 is accepted
  (`statusTransition.ts:341-370` checks only that `toStatus` is a listing
  status).
- `IntakeForm` and its consent copy contain no "taken" / "removed" text, so the
  T5 regex will not trip on the form itself.
- An unknown stored status in T6 does not crash `StatusMenu`
  (`TONE_CLASS[undefined]` yields an undefined class, `StatusMenu.tsx:103-109`).
- `App.test.tsx:143` (`/p/missing-unit`) asserts identity/auth only, not copy;
  unaffected.
- No e2e vitest test (`e2e/performance/*`) pins flyer status.
