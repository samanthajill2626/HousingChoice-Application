# FW-P1 report - feat/flyer-leads (planner review P1 fix wave)

Scope: the six items of the FW-P1 section of `adjudications.md` (same
directory), nothing else. OR-26 / OR-26b untouched, no main sync, no e2e run,
no full suite run. Base `955a60d5`.

## Commits

- `6b632aef` fix(app): item 1 (A-L2)
- `0363dde2` fix(app): item 2 (C-F1)
- `21b47d65` docs(dashboard,spec): items 3 and 6 (A-I2, C-F2)
- `4a7796fb` docs(issues): items 4 and 5 (A-M2, A-L3, A-L1)
- this report, last

## RED / GREEN evidence

All app runs `cd app && npx vitest run <files>`, bare, log then `EXIT:$?`.

| Item | Run | Result |
|---|---|---|
| 1 RED | `test/unitsApiActivity.test.ts` | 1 failed / 19 passed (20), EXIT:1. Reason: the nameless contact's event had no `contactName` (expected `(404) 555-0142`). |
| 1 GREEN | `test/unitsApiActivity.test.ts test/contactsBatchReads.test.ts test/listingSendsApi.test.ts` | 3 files, 59 passed (20 + 10 + 29), EXIT:0 |
| 2 RED | `test/publicSignupLeads.test.ts` | 2 failed / 55 passed (57), EXIT:1. Reason: `expected 500 to be 200` on both new cases (main path and deleted path). |
| 2 RED (pin) | `test/publicIntake.test.ts` against HEAD's `public.ts`, swapped in and restored byte-identical (sha256 `ac4bb9ad...` checked) | 1 failed / 59 passed (60), EXIT:1, `expected 500 to be 200` |
| 2 GREEN | `test/publicSignupLeads.test.ts test/publicIntake.test.ts` | 2 files, 117 passed (57 + 60), EXIT:0 |
| 2 neighbors | `test/settings.test.ts test/rateLimitClientKey.test.ts test/cloudfrontBehaviors.test.ts test/backfillJoinHousingAuthority.test.ts` | 4 files, 175 passed, EXIT:0 |
| 3 | `cd dashboard && npx vitest run src/routes/public/FlyerPage.test.tsx` | 62 passed, EXIT:0 |
| all | `npm run typecheck` (after item 1, after item 2, final) | EXIT:0 each |
| all | `npx eslint` on the six touched .ts/.tsx files | EXIT:1, exactly 2 errors, both pre-existing `react-hooks/set-state-in-effect` at `FlyerPage.tsx:212:5` and `:230:7`; 0 new (items 1 and 2 files alone: EXIT:0) |
| 4, 5 | `npm run issues` | EXIT:0 (436 open, 213 closed); `INDEX.md` is gitignored, not committed |
| all | ASCII on added lines; `grep -F '\u'` on added lines | 0 non-ASCII bytes, 0 hits, all 9 files |

## Where the work differs from the fix list's wording

- Item 1 test home: the activity cases live in `app/test/unitsApiActivity.test.ts`
  (the `contactsBatchReads.test.ts:211-267` cases are the batching pins); the
  three new cases went there, on `listing_declined` rows (the A-L2 scenario).
  The named and the neither-name-nor-phone cases are PINs (green before and
  after); only the phone case was RED.
- Item 1: `recipientLabelOf`'s parameter is widened from `RecipientDisplay` to
  `ContactDisplayItem` (`app/src/routes/units.ts:211`, type import at `:77`) -
  the projection `getDisplaysByIds` returns; `RecipientDisplay` extends it, so
  the Sent to callers are unchanged.
- Item 2: `SIGNUP_STEP_FAILED`'s doc did not enumerate the step names before;
  it now lists them (`app/src/routes/public.ts:135-143`). One comment beyond
  the three named: the thread step now says it is NOT best-effort and points
  to the consent issue where A-L1 is filed (`public.ts:602-604`); the step
  itself is unchanged, unguarded.
- Item 2: `app/test/publicIntake.test.ts:125-163`, the "(PIN) NEVER logs PII
  ... every failed step" case, asserted the exact SET of step names; it now
  also fails the audit and expects `audit` in the set, so "every" stays true.
  Seam used throughout: the harness's `world.failAuditAppendFor` (throws
  before recording).
- Item 3: reworded inside the same five lines, so no later `FlyerPage.tsx`
  line moved (item 5 cites `:251`, `:431`, `:440`).
- Item 4: lines verified - `today.ts:182` (cap), the collect loop
  `today.ts:704-752` with the break at `:752`, the capped WARN at `:754`;
  `config.ts:1008` (max 5) and `:1014` (60 000 ms); no deployed override in the
  repo (only `.env.example` comments and the e2e launcher's 100000). The
  PLAUSIBLE reads are cited at their post-item-1 lines, `units.ts:1495-1520`
  and `followUps.ts:141-161` (P1-adversarial cited `:1498-1507` and
  `:146-161`).
- Item 5, three corrections recorded in the issue:
  - the `consent_method: 'web_form'` + no `housing_fair_welcomed: true` pair
    is NOT unique to "a contact this endpoint created and never welcomed"
    (P1-adversarial L1). A refused or failed welcome leaves it too (spec D5's
    accepted consequence, which the candidate rule would reverse), and
    `app/scripts/backfillConsentMethod.ts` stamps `web_form` on legacy
    `housing_fair` / `flyer` contacts;
  - /join's thank-you makes the same promise ("A team member will text you",
    `HousingFairIntake.tsx:163`), unchanged from main;
  - Twilio Advanced Opt-Out is on (`smsCompliance.ts:262-266`), so a STOP is
    also held at Twilio (21610). Clearing the app's flag alone would not reach
    the person - context for the START decision.
- Item 6: appended verbatim, wrapped at 73 columns.

## Residuals for the planner (not changed: "change nothing else in the spec")

- Spec section 4, `2026-10-21-flyer-leads-design.md:624`: "The property
  Activity card is unchanged" is stale after item 1, since a nameless contact
  now reads as its formatted phone there. Its reason, "a sign-up is not a
  property audit", still holds. A section 7 line, "AR13's label also applies
  to the Activity card", would square it.
- Spec D6.4 (`design.md:357-361`) lists the best-effort steps without the
  audit, which the code now treats as one. Its "every step after the contact
  is resolved or created is best-effort" is still untrue for the thread
  get-or-create and link, by the C-F1 ruling. No residual bullet names that.
- Line drift (pre-FW-P1 numbering): item 2 moved `public.ts` lines by +5 after
  `:41`, rising to +29 after the main-path audit (`:731`). Item 1 moved
  `units.ts` lines by +1 after `:76`, +4 after `:205` and +8 after `:2263`.
  Older citations in the two touched issues
  (`public.ts:637-673`, `:686-703`, `:495-528`, `:584`, `:718-731`, ...) and in
  other `docs/issues/` files now point early. Text added in this wave cites
  post-FW-P1 lines. No refs refresh was done, since it is outside the six
  items.
