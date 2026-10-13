# Build research (Phase 1) - Matching (plan S6, S7): findings

Reader: build-research, area `matching`. Tree W:\tmp\last-heard-from @25adc1ef
(code byte-identical to f6aba402), plan v3. Findings only - byte-exact quotes,
line tables and the full checklists are in the gitignored worklist
`.superpowers/sdd/worklist-matching.md`. 90 anchors checked: 1 wrong, 3 drifted;
everything else in S6/S7 matches the live tree verbatim.

## F1 (BLOCKS gate 2, cross-area - S3.8, not S6/S7) - the dashboard mutation inventory

`e2e/performance/mutationCatalog.test.ts` statically scans dashboard/src for
every non-GET `request(...)` call and requires the checked-in catalog
(`e2e/performance/mutationCatalog.ts`) to match it in both directions, with an
exact count of 120 (`mutationCatalog.test.ts:380`, `:383`). S3.8 adds
`setListingSendOutcome` (a `request:POST` to
`/api/units/:unitId/recipients/:contactId/outcome`, plan :4791-4799) and the
plan never mentions the catalog. Root `npm test` runs the e2e workspace's
vitest (`package.json:39`, `e2e/package.json:9`), so gate 2 goes red. Fix in
S3.8: add the catalog entry (its `interception` must equal
`isCatalogPathIntercepted(pathCategory)`, `e2e/performance/firewall.ts:234`)
and bump 120 to 121 with a comment. S6/S7's own additions are safe: the only new
dashboard endpoint is `getFollowUps`, a GET, which the inventory filters out
(`mutationCatalog.test.ts:323-328`).

## F2 (medium, plan-unlisted surface) - `npm run perf:pages` contracts

S7.3 (Matching) and S7.4 (Properties) fetch `GET /api/broadcasts/follow-ups`
on mount. The perf harness declares the exact GETs per surface and has no
template for the new path: `e2e/performance/templates.ts:132-136` would bucket
it as `/api/broadcasts/:broadcastId`; `/broadcasts` declares only
`/api/broadcasts?limit` (`e2e/performance/routes.ts:303`, `:642`) and
`/listings` only the unit walk (`routes.ts:260-263`, `:612`). An undeclared API
GET is classed `required` with `forceUnmatched` (`e2e/performance/collect.ts:385-414`),
so both surfaces report `unmatched_api` and `unexpected_endpoint`
(`e2e/performance/report.ts:315`, `:337`). Not a completion gate, but the plan
keeps perf:pages honest elsewhere (S4.6). Either add the template plus the two
surface declarations (`/listings` only - `UNIT_LIVE_WALK` is shared with other
sources; `/listings/deleted` disables the hook) and their pins
(`e2e/performance/routes.test.ts:82`, `:109`), or file a docs/issues entry.

## F3 (low) - Task 6.3's RED expectation is wrong

Plan :8439-8442 says exactly the three new C6 cases fail before the source
hunk. `keeps a short list below the input when it fits there` PASSES on the
unpatched source: `dashboard/src/routes/contact/ContactSearchField.tsx:128-130`
already sets `top = rect.bottom + 4` (140px) and no `bottom`, which is all that
case asserts. Two cases go RED; the third is a PIN. A builder told "exactly
three" may stop and treat the run as broken.

## F4 (low) - 7.1 GREEN 1a duplicates an existing exported helper

The plan creates `app/src/lib/contactDisplay.ts` as "the app's ONE display-name
rule" by moving `displayNameOfContact` out of `app/src/routes/units.ts:155-176`.
`app/src/lib/contactName.ts:74-82` already exports `contactDisplayName` with the
same logic (part-wise trim, join, undefined when empty; it also accepts
`undefined`). Twilio, voice, participantNames and rosterDriftTally already use
it (`twilio.ts:126`, `voice.ts:55`, `participantNames.ts:27`,
`rosterDriftTally.ts:8`). The move adds a third copy, against
`docs/issues/consolidate-contact-display-name-helpers.md`, which lists units.ts's
copy as one to consolidate. A simpler fix: `services/followUps.ts` imports
`contactDisplayName` from `../lib/contactName.js`, and units.ts is left alone.
That also avoids churn in a file W2's S3.6/S3.7 edit heavily.

## F5 (low, precision) - Task 6.5 `visibleRows` has two `rows` references

Plan :8829-8831 says make `visibleRows` "filter `orderedRows` instead of
`rows`". The memo also has an early return,
`if (q.length === 0) return rows;` (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:146`).
If only the `.filter` at :147 changes, the default (unsearched) list keeps
server order and both order tests in the new describe fail. Both :146 and :147
must use `orderedRows`.

## F6 (low, precision) - Task 6.2's api.ts anchor text is not unique

Plan :8374-8375 anchors the broadcasts mount on "after `events,` (:1104)".
`      events,` occurs 10 times in `app/src/routes/api.ts` (:660 through :1135),
and `orgNamesService: orgNames,` occurs 5 times. S3.7 also moves the lines
first. The unique context is the comment at api.ts:1101 inside
`createBroadcastsRouter({` (:1085).

## F7 (low, precision) - 6.5's "no e2e pins a checkbox accessible name"

The claim (plan :382-384, :9154-9161) leaves out
`e2e/scenarios/steps.ts:1081-1083`, which selects a review-step checkbox by
accessible name (`^<firstName>( |$)`). The pattern ignores the separator, so
the ASCII rename is safe. S8's re-grep should still include `e2e/scenarios/`,
not only `e2e/tests/`.

## F8 (low) - line drift in two test anchors

- `BroadcastComposer.test.tsx`: the plan says the response is at :487-494 with
  the candidate at :490. The live response is :488-495 with the candidate at
  :491.
- `ListingsList.test.tsx`: the plan puts `beforeEach` at :156-159. It is at
  :157-160.

## F9 (nit) - `beforeEach` arrows that return the mock

In `useFollowUps.test.tsx` (plan :10345) and `useFollowUpCounts.test.tsx`
(plan :11232), `beforeEach(() => getFollowUps.mockReset()...)` returns the mock
function. Vitest treats a function returned from a hook as teardown and calls
it after each test, which adds one stray call. It is harmless today but
confusing. Use a block body.

## F10 (nit) - weak in-place assertions in FollowUpView.test

`findByText('Not interested')` inside a row (plan :10183, :10284) also matches
the pre-resolution "Not interested" BUTTON. In the in-flight test it therefore
resolves before `release` lands. Asserting the `Undo not interested for <name>`
button instead proves the in-place state.
