# Fix wave 2 - fresh review (feat/matching-blast-rules)

- Range reviewed: 619af70a..e1c2bbe8 (f0b33c94, da45d910, 088a12f8, 44a0263a,
  c0a3bc9c, 9b0bea63 + the wave report), from
  `.superpowers/review/fw2-package.diff`, the source at HEAD, the wave report,
  and `planner-review/adjudications.md` (with conformance/adversarial for the
  cited evidence). Requirement: spec revision 7 D3 "Timing" and plan AR44.
- Method: source read-only. Throwaway tests and ONE mutant copy (all named
  `zz-review-fw2-*`, new files, never imported by the app), single-file
  vitest runs only. When the reviewer started, the live gate run (label fw2,
  commit e1c2bbe8) had finished gates 1-3 (typecheck, npm test, smoke: exit
  0) and was in e2e, so no new file could be collected by a gate run. No
  suite was run; :5174/:8080 untouched; nothing committed (e2e is live).
- Abbreviations: BC = `dashboard/src/routes/broadcasts/BroadcastComposer.tsx`,
  BCT = its test, AF / AFT = `AudienceFilters.tsx` / its test (same folder).
  Lines at e1c2bbe8.

**Counts: 0 BLOCKING, 0 HIGH, 0 MEDIUM, 5 LOW, 3 INFO.** The AR44 gate itself
is correct: no interleaving found creates or previews a filter draft while a
read is failed, no hold sticks without a notice and a Try again, and every
notice implies a hold (BC:246-251). The findings are copy, accessibility, a
stale doc row, missing e2e coverage, and one PRE-EXISTING (main) message
hazard that the charge's seeds-only interleaving surfaced.

## 1. What the earlier reviews missed (charge 1)

Swept: every consumer of `prefillPending` (draft hook `hold` BC:325,
`canPreview` BC:588, the hint BC:844), `unitLoad` / `unitRetry` (BC:190-191,
:383-399, :510), the org list's `loading` / `error` / `reload`
(`useOrgList.ts` unchanged: `error` stays true through a reload until a read
succeeds, :91-94; aborted answers ignored, :84, :92), the draft hook's
`hold` (`useComposerDraft.ts:177`, `reachPending` derived :287), Preview's
enablement, both notices and every "Try again" on the page,
`wireAudienceFilter`'s three callers (`app/src/routes/broadcasts.ts:450`,
`:480`, `:987`) and every reader of the wire `audience_filter`
(`BroadcastsList.tsx:48`, `BroadcastResults.tsx:209`; the e2e readers are the
create echo and request bodies; SSE emits carry no filter).

Interleavings walked, each as a throwaway test against the real module
(`zz-review-fw2-interleavings.test.tsx`, 12/12 passed - the behavior below is
what the code DOES):

| Id | Interleaving | Result |
|---|---|---|
| I1 | `?unitId=`, property load fails | held; hint and spinner misdescribe it (FW2-1); notice not announced (FW2-2) |
| I2 | BOTH reads fail on one property | property notice alone (one Try again); after its success the list notice and the hold; after that, one create with the prefill |
| I3 | `?contactId=` seeds-only with a failed list, then filters on | seeds-only Preview works; the flip holds with the list notice, no filter create; Try again -> exactly one filter create with the authority |
| I4 | seeds-only with a failed property load, then filters on | no notice while seeds-only; the flip shows the property notice and holds |
| I5 | list Try again clicked twice | the aborted first answer is ignored (list notice stays); the second settles; one create |
| I6 | property Try again clicked twice | the aborted first retry (AbortError) ignored; the second settles; one create |
| I7 | a property retry that lands after a property change | the new property settles normally; no stale notice |
| I8 | StrictMode double mount, both reads failing | one notice; 2 calls each after mount (first aborted); both Try agains settle |
| I9 | resumed draft (`?draftId=`), both reads failing | never gated, no notice |
| I10 | property whose accepted authorities are all blank, list failed | not held (nothing to fill in) |
| I11 | legacy `jurisdiction`-only property, list failed | held (authoritiesOf reads it) |
| I12 | seeded 1:1, failed property load, typed message, flip, Try again | the one-tenant text goes out to the filter (FW2-3, pre-existing) |

### FW2-1 - LOW - CONFIRMED - the Preview hint and spinner describe a failure hold as work in progress

- Where: BC:839-847 (hint chain), BC:834 (Spinner), BC:835-838 (its comment).
- Trigger: a property attached and the filters on, and `GET /api/units/:id`
  fails (the `?unitId=` entry or a picked property). The message is empty: the
  message prefill needs the loaded unit.
- Effect: the hint under the disabled Preview reads "Write a message to
  enable the preview." Writing one does NOT enable it: the hint turns to
  "Sizing the audience" + U+2026 beside a spinner that never stops, and the
  reach line keeps "Estimating reach" + U+2026. Only the notice in the filters
  column tells the truth. Reproduced (I1, quoted output):
  `I1 hint before typing: "Write a message to enable the preview."`;
  after typing and 2.5 s, `I1 hint after typing + 2.5s: "Sizing the
  audience..." reach: "Estimating reach..." statuses: [ 'Estimating reach...',
  'Loading' ]` (U+2026 rendered as "..." here); Preview still disabled, no
  create. The comment at BC:835-838 ("the operator-actionable gates are the
  empty message and text typed ...; the settling draft/reach is transient
  (spinner)") no longer holds: a failure hold is operator-actionable (Try
  again) and not transient. The wave report's judgment call 3 flags the
  spinner but not the "Write a message" promise, and AR44 rules only the
  reach line ("pending as for any unsettled prefill").
- Fix: in the hint chain test the failure hold FIRST
  (`prefillNotices.length > 0`) and show either nothing (the notice says why)
  or a pointer to it (new copy, Cameron's call - e.g. "Try again above to fill
  in the filters."); render the Spinner only while something is in flight
  (`draft.reachPending && prefillNotices.length === 0`). AR44's pending reach
  line stays as ruled. Update the BC:835-838 comment.
- Regression test: in BCT:979 assert, before typing,
  `screen.queryByText('Write a message to enable the preview.')` is null, and
  after typing, `screen.queryByRole('status', { name: 'Loading' })` is null
  (plus the chosen hint copy, if any).

### FW2-2 - LOW - CONFIRMED - the hold notice is silent to assistive technology

- Where: AF:229-236 (the notice is a bare `<p>`); AF:262 (the reach line's
  `role="status" aria-live="polite"`).
- Trigger: any AR44 hold.
- Effect: nothing announces the hold or why Preview is disabled. A screen
  reader user hears the reach live region's "Estimating reach" + U+2026 (see
  FW2-1) and, on Tab, a bare "Try again" button with no context. On a
  property-load failure there is no alert at all (the picker's `role="alert"`
  is the LIST's error). I1: `I1 notice role: null aria-live: null closest
  live: null`. Before AR44 the notice was also a plain `<p>`, but it described
  a state that did not block anything; it is now the only explanation for a
  blocked Preview.
- Fix: `role="status"` on the notice paragraph (not "alert": the list case
  already has the picker's alert, and BCT:990 and e2e read a single
  `getByRole('alert')`), and/or `aria-describedby` from the Preview button and
  the notice's Try again to the notice's id.
- Regression test: AFT:295 - the notice text sits inside a `role="status"`
  element; or in BCT:979, Preview's accessible description contains the
  property notice.

### FW2-3 - LOW - CONFIRMED - PRE-EXISTING (main): a message typed for ONE tenant goes out to the filter audience after "Add more tenants by filters" when the property had not loaded

- Where: BC:484-495 (`onEnableFilters` resets the body only when
  `resolvedMode && unit !== null`, BC:485); BC:429-430 (the multi-recipient
  prefill never replaces an edited body). Same guard on main
  (`main:dashboard/src/routes/broadcasts/BroadcastComposer.tsx:317-318`).
- Trigger: `?unitId=X&contactId=Y` (or a picked property on the
  `?contactId=` entry) whose `GET /api/units/:id` fails. Resolved mode cannot
  auto-fill without the unit, so staff type a message for the one tenant
  (Preview works: seeds-only is never gated). Then "Add more tenants by
  filters": no "Switching the audience resets the message" confirm, AR44
  holds, Try again loads the property.
- Effect: the one-tenant text (with the tenant's name, as typed) is the
  filter blast's body. I12, quoted: `I12 last create:
  {"unitId":"unit-0001","body_template":"Hi Tasha, this one is for
  you","audience_filter":{"contact_type":"tenant","housing_authorities":["Atlanta
  Housing Authority"],"bedroomSize":2},"seedContactIds":["c-seed"]} confirm
  calls: 0`. Not caused by fix wave 2: before AR44 the same flip sent that
  text with NO authority filter at all; AR44 only puts a hold in front of it.
  The text is visible in the editor before Preview and Send, hence LOW.
- Fix (its own change; FILE it): in `onEnableFilters`, treat any edited body
  in resolved mode as one-tenant text whatever `unit` is - confirm, then reset
  to empty (the prefill refills once the unit loads).
- Regression test: I12 inverted - the flip asks the confirm once; accepted,
  the body is reset and no filter draft carries the one-tenant text.

## 2. The wave, reviewed cold (charge 2)

- Changed order / lost case: the two notices can no longer show together
  (`orgListHold` needs a loaded unit, BC:244-245), so with both reads failed
  staff click two Try agains in turn (I2) - disclosed as judgment call 1, and
  fail-closed. The pre-wave list notice for a property accepting NO authority
  is gone by design (nothing to fill in); the picker's own alert remains.
- Holds that stick: none. `unit === null` covers loading, failed and aborted;
  every abort (unmount, property change, StrictMode, a second Try again) is
  followed by a new read or leaves compose (I6-I8); a failure always carries a
  Try again; `pickProperty` (BC:504-511) is reachable only from the property
  step, so its reset of a failed state always comes with a new read.
- Notices that lie: every notice implies a hold (BC:248 needs `unit === null`,
  BC:251 needs `orgListHold`, both inside `prefillPending`). The HINT lies
  (FW2-1).
- Lint: `npx eslint` on all 13 touched `.ts`/`.tsx` files: 3 errors, exactly
  the pre-existing three (BC:414 and BC:433 `react-hooks/set-state-in-effect`,
  the message-prefill effects; `useComposerDraft.ts:152` `react-hooks/refs`).
  The new code sets state only in `.then` / `.catch` and click handlers, and
  reads no ref during render.

### FW2-4 - LOW - CONFIRMED - a selectors.md row still says a failed read settles the prefill

- Where: `e2e/support/selectors.md:134` (the "Org pickers ... text typed but
  never picked" row).
- Trigger: n/a (doc).
- Effect: it still says Preview waits "until the prefill has settled (the
  property and the organization list each loaded or failed - tracker #6 D3)",
  the opposite of AR44. The wave updated the Matching composer row (:148) and
  missed this one; an e2e author following :134 would expect a failed read to
  settle.
- Fix: "(the property loaded and the organization list loaded; a failed
  property load, or a failed list read while the property accepts an
  authority, HOLDS with Try again - AR44)".
- Regression test: none (doc). `grep -n "loaded or failed"
  e2e/support/selectors.md` must come back empty.

### FW2-5 - LOW - CONFIRMED - no e2e spec covers the AR44 hold

- Where: `e2e/tests/dashboard-next/matching-blast-rules.spec.ts` (no case);
  AGENTS.md "UI testing and verification" ("add or extend a spec for new
  behavior").
- Trigger: n/a.
- Effect: the hold, its two notices and Try again are new user-facing
  behavior with unit coverage only. No e2e spec fails `GET
  /api/organizations` or `GET /api/units/:id` (grep of `e2e/tests` for
  `api/organizations` routes and the notice copy: none). The wave report lists
  it under "Not done" as the orchestrator's call.
- Fix: one case in `matching-blast-rules.spec.ts`: `page.route` the
  organizations GET to a 500, open `?unitId=` of a property that accepts a
  run-unique authority, assert the list notice and a disabled `Preview
  recipients`; `page.unroute`, click the notice's `Try again`, assert the chip
  `Remove <name>` and an enabled Preview.
- Regression test: that spec.

### FW2-6 - INFO - CONFIRMED - comments still say the list is read once

- BC:156-159 ("read ONCE here (one GET /api/organizations per mount)") and
  AF:61-63 ("The composer reads it ONCE (useOrgList)"): the list notice's Try
  again (BC:251) now re-reads it after a failure. Suggest "read here, once
  per mount - again only by the failed-read Try again". The issue file already
  says this.

### FW2-7 - INFO - CONFIRMED (by construction) - a name ending in "." gets two periods

- AF:225 appends "." blindly, so an unused authority like "Housing Auth. of
  Fulton Co." reads "... Fulton Co..". Cosmetic; append the period only when
  the last name does not already end with one.

## 3. Cameron's decision, item by item (charge 3)

| Decision element (spec rev 7 D3 Timing, AR44) | Built at | Evidence | Verdict |
|---|---|---|---|
| Only with a property attached and the filters on; resumed drafts and seeds-only never gated | BC:242 | BCT PINs; I3, I4, I9 | CONFORMS |
| Failed property load: no draft, Preview disabled, reach pending | BC:246 (`unit === null`), :325, :588; `useComposerDraft.ts:177`, :287 | BCT:979; I1 | CONFORMS |
| Failed list read holds only a property that accepts an authority | BC:244-246 | BCT:990, :1096; I10, I11 | CONFORMS |
| Notice + Try again re-running ONLY the failed read | BC:248-251; AF:229-236 | BCT:1021, :1060 (call counts); MX2 | CONFORMS |
| Notice and hold stay while the retry runs and after another failure | `useOrgList.ts:91-94`; BC:396 (failed kept until the retry lands) | BCT:1021, :1046, :1060, :1085 | CONFORMS |
| Success settles as usual; then ONE create with the prefilled authorities | BC:246 | BCT:1021, :1060; I2, I3, I6, I8 | CONFORMS |
| An aborted read stays loading, no notice | BC:395 | BCT:1007 (M1); I6, I7 | CONFORMS |
| Voucher size still fills during a list hold | BC:205 | BCT:990 | CONFORMS |
| A failed state belongs to its property | BC:190, :510 | BCT:1126 (R27); I7 | CONFORMS (FW2-8) |
| Exact copy (plan 1.1) | BC:71-76; AF:43-45, :225-226 | character-compared | CONFORMS |
| "Not used" note ends with a period | AF:225 | AFT:274, :282, :292; BCT:860, :876 | CONFORMS |
| PA-5: a stored row with no `audience_filter` never 500s the list | `app/src/lib/blastAudienceRules.ts:222-225`; `broadcastFormat.ts:65-67`; `types.ts:3341`, :3422 | `broadcastApi.test.ts:2811`; `broadcastFormat.test.ts:50` | CONFORMS |
| R55: held row's amber class pinned | test only | `RecipientPreview.test.tsx:1042` | CONFORMS |
| I6 seed comment | `app/src/lib/seed/matrix.ts:1260-1263` | names equal `SEED_AUTHORITY` (`app/src/lib/seed/orgList.ts:33`, :35) | CONFORMS |

No departure found.

### FW2-8 - INFO - spec wording: the LIST failure is per page, not per property

- Spec D3 (`docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md:318-319`):
  "A failed state belongs to the property it was for and clears when that
  property loads or the property changes." For the property load this is
  built exactly (BC:190). The list failure cannot belong to a property: BC:245
  re-evaluates it for each property, so a newly picked property that accepts
  an authority is held by the same failed read (BCT:1096 second half), and
  with both reads failed the list notice appears only after the property's Try
  again (I2). That is the fail-closed reading Cameron chose. Suggest the spec
  say "a failed PROPERTY LOAD belongs to ..." so nobody later "fixes" the list
  hold into clearing on a property change. No code change.

## 4. Are the fixes real (charge 4)

Method for the reviewer's mutants: a same-folder copy
(`zz-review-fw2-BroadcastComposer.mut.tsx`) made by a script that refuses
unless its anchor occurs exactly once, wired in by a throwaway
`dashboard/zz-review-fw2-vitest.config.ts` (merges `vite.config.ts`, one
`resolve.alias` for the test's `./BroadcastComposer.js`). Identity copy MX0:
`cmp` identical, BCT 78/78 passed.

| Mutant (reviewer) | Mutation | Result |
|---|---|---|
| MX1 | drop `orgListHold` from `prefillPending` (a failed list read settles again) | KILLED, 4 failed / 74 passed: BCT:990, :1060, :1085 `expected "spy" to not be called at all, but actually been called 1 times`; BCT:1096 `expected [ [ { unitId: 'u-1', ...(2) } ] ] to have a length of +0 but got 1` |
| MX2 | the list notice's Try again re-reads the PROPERTY | KILLED, 2 failed / 76 passed: BCT:1060, :1085 `expected "spy" to be called 2 times, but got 1 times` |

Fix verification:

| Item | Fix | Test(s) | Fails without the fix? | Evidence |
|---|---|---|---|---|
| AR44 property hold | BC:243-249, :399 | BCT:979, :1021, :1046, :1126 | yes | implementer M3-M6; reviewer I1, I2, I6-I8 |
| AR44 list hold | BC:244-246, :251 | BCT:990, :1060, :1085, :1096 | yes | reviewer MX1, MX2; implementer M2 |
| AR41 abort stays loading | BC:395 | BCT:1007 | yes | implementer M1 |
| Notices with Try again | AF:229-236 | AFT:295 | yes | implementer RED (`Objects are not valid as a React child`) |
| I2 period | AF:225 | AFT:274, :282, :292; BCT:860, :876 | yes | implementer RED 5/104 |
| PA-5 app | `blastAudienceRules.ts:225` | `broadcastApi.test.ts:2811` | yes, by construction: it passes only if the stored row lacks the field, and without the guard `wireAudienceFilter(undefined)` reads `.bedroomSize` -> 500 | implementer RED `expected 500 to be 200` |
| PA-5 dashboard | `broadcastFormat.ts:67` | `broadcastFormat.test.ts:50` | yes, by construction (TypeError on `undefined.bedroomSize`) | implementer RED |
| R55 | test only | `RecipientPreview.test.tsx:1042` (`rowOf` = the `li` carrying the class, `RecipientPreview.tsx:571`) | yes | implementer mutant (hold dropped from `rowAlready`) |
| I6 comment | comment | n/a | n/a | names checked |
| PA-1 / PA-3 filed; prefill issue updated | docs | n/a | n/a | refs spot-checked accurate |

## Swept and clean

- The two "Try again" buttons (prefill notice, 503 refusal) can never be on
  screen together: a current refusal needs a draft made for the on-screen key,
  and a hold makes none.
- `GET /api/organizations` is open to every signed-in user
  (`app/src/routes/organizations.ts:24-26`, :128-138) and a missing list item
  self-creates (`app/src/repos/orgListRepo.ts:166-176`): no role and no fresh
  environment is held forever.
- PA-9 premise ("a stalled read ends in an error"): the client has no timeout
  (`dashboard/src/api/client.ts:116-127`), but CloudFront's
  `origin_read_timeout = 30` (`infra/modules/cloudfront/main.tf:114`) ends a
  stalled origin read as a 504 -> hold + Try again in deployed environments.
  Local `npm run dev` can stay loading (unchanged by this wave).
- The property load's `.then` (BC:388) has no `signal.aborted` guard, unlike
  `useOrgList.load`; safe with the real client (an aborted fetch rejects,
  `client.ts:125`). Pre-existing.
- PA-5 covers the list and results projections, as ruled. The per-row
  preview and send of a stored filterless row (`broadcasts.ts:1021`, :1042,
  :1279, :1285) still assume a filter - pre-existing on main (:730, :747,
  :985, :991) and unreachable from the dashboard (a resumed draft recreates
  before Preview).
- A property accepting no authority with a failed list read: no hold, no
  notice, the picker's own alert; only a page reload re-reads the list for a
  by-hand pick (pre-existing; spec-conformant).
- Issue refs spot-checked accurate: `already-sent-read-fails-open-in-default-check.md`
  (`shareRecipientState.ts:249-269`, `broadcasts.ts:741-743`, :786-801,
  :1032-1035) and `tour-hold-reading-disagrees-with-tours-page.md`
  (`blastAudienceRules.ts:100-103`, `types.ts:937-945`, `useTours.ts:189-191`,
  :264-268, `tours.ts:1296`, :1323-1327, `TourDetail.tsx:597-601`,
  `toursModel.ts:201-205`).
- `.prefillRetry` mirrors the composer's `.retryBtn` (no focus override, so
  the browser's ring stays).

## Throwaway files (created, then deleted by exact name before the reply)

- `W:/tmp/matching-blast-rules/dashboard/src/routes/broadcasts/zz-review-fw2-interleavings.test.tsx`
- `W:/tmp/matching-blast-rules/dashboard/src/routes/broadcasts/zz-review-fw2-BroadcastComposer.mut.tsx`
- `W:/tmp/matching-blast-rules/dashboard/zz-review-fw2-vitest.config.ts`
- Run logs `W:/tmp/matching-blast-rules/.superpowers/review/zz-review-fw2-run1.log`,
  `zz-review-fw2-run2.log`, `zz-review-fw2-eslint.log`,
  `zz-review-fw2-MX0.log`, `zz-review-fw2-MX1.log`, `zz-review-fw2-MX2.log`
  (the evidence they held is quoted above).
