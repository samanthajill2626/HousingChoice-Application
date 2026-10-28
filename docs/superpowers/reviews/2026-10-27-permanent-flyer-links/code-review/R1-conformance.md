# R1 code review - spec conformance (permanent flyer links)

- Reviewer: R1 spec-conformance (read-only), 2026-10-28.
- Tree: `W:\tmp\permanent-flyer-links`, `feat/permanent-flyer-links`, HEAD
  49d9fd24 (main 71fb9b45 merged in). Every line number below is the LIVE
  tree at 49d9fd24.
- Contract: spec rev 3 (`docs/superpowers/specs/2026-10-27-permanent-flyer-links-design.md`);
  plan v2 (watch items WI1-WI8); binding `build-research/WORKLIST.md`
  (WL-1..WL-43, G1-G4); slice reports S1-S5.
- Gate battery 1 at this HEAD (`.superpowers/sdd/battery-1/summary.txt`):
  typecheck 0, smoke 0, npm test 0, e2e 0 (385 passed, 16.4m), lint 1 =
  exactly the four pre-existing G4 errors.
- Test strength: 30 mutants run in memory (section 2). A scratchpad vitest
  config wraps the app's and the dashboard's own configs and adds a transform
  plugin that rewrites ONE module in memory and throws if its pattern is not
  found. This reviewer edited and created no repo file besides this report.

Result: BLOCKER 0, HIGH 0, MEDIUM 1, LOW 1, INFO 3. 29 of 30 mutants killed.

## 1. Conformance

### 1.1 Work map

| Item | Verdict | Evidence (live) |
|---|---|---|
| T1 `FLYER_PUBLIC` + re-export (D1) | CONFORMS | `app/src/lib/statusModel.ts:298-305` (the six, written out); `SHAREABLE` still `{'available'}` :290, doc :285-289; module still a leaf (0 imports). `app/src/repos/unitsRepo.ts:37` import, :52-58 UnitStatus doc, :65-69 SHAREABLE_STATUSES doc, :72 `FLYER_PUBLIC_STATUSES` |
| T2 flyer API (D2, D3a) | CONFORMS | `app/src/routes/public.ts:869` gate; :879-884 `listing_link` nulled in the route; `toUnitFlyer` untouched (`git diff 71fb9b45 HEAD -- app/src/lib/unitFields.ts` empty); opaque 404 body :469-471 unchanged |
| T3 attribution + pin suffix, unused import dropped (D5, D6) | CONFORMS | public.ts:76 imports only `FLYER_PUBLIC_STATUSES, isDeleted`; :533 `viaFlyer`; :208-225 `signupPinLabel`; every viaFlyer reader follows (:627-628, :711, :758, :782-797) |
| T4 dashboard mirror + cross-workspace test | CONFORMS | `dashboard/src/api/types.ts:958-976`; `dashboard/src/api/flyerPublicMirror.test.ts:15-41` |
| T5 FlyerPage fallback (D4) | CONFORMS | `dashboard/src/routes/public/FlyerPage.tsx:42-57`, :239-259, :268-279, :289-325 |
| T6 property page flyer line (D7) | CONFORMS | `dashboard/src/routes/listing/ListingDetail.tsx:418-422` (deleted first), :429-434, :955-970 |
| T7 broadcast staff copy only, guard unchanged (D8) | CONFORMS | `BroadcastComposer.tsx:540-550`; `RecipientPreview.tsx:87-90`, :376-377, :420, :757-760; `app/src/routes/broadcasts.ts:1181-1186` comment, guard :1187-1193 still `SHAREABLE_STATUSES` (:1189); composer list `BroadcastComposer.tsx:376` unchanged |
| T8 docs + comment sweep incl. selectors.md fallback row | PARTIAL | every spec section 4 site is done (1.4) and the fallback row is `e2e/support/selectors.md:50`; two retired-rule statements came in with the main sync after the sweep - C-1 |
| T9 e2e | CONFORMS | `public-pages.spec.ts:546-637`, :639-680; `listing-photos.spec.ts:307-350`; `environment-identity.spec.ts:44-47`; `broadcasts.spec.ts:278-288`; `flyer-leads.spec.ts:730-822` |
| D9 unchanged surfaces | CONFORMS | no branch diff in IntakeForm.tsx, HousingFairIntake.tsx, app.ts (limits), unitMediaServe.ts, contact Card.tsx, listingFormat.ts, followUps.ts. The merge kept every branch hunk byte-for-byte in the 6 files both sides touched (-U0 hunk hash, d0e2c2d8..26b4013b vs 71fb9b45..49d9fd24) |
| Spec section 6 non-goals | CONFORMS | guard and Available-only composer list unchanged; no status word on either public stage; no sent-row status; no indexing or limit change |

### 1.2 Decisions D1-D9

| D | Verdict | Evidence |
|---|---|---|
| D1 | CONFORMS | two sets (statusModel.ts:290, :298); an off-list stored value is not public (statusModel.test.ts:344); doc rewording :285-289, unitsRepo.ts:52-58, :65-67. Setup is never offered as a take-down: `documentation/STATUS-MODEL.md:311-313` says it is NOT one; the branch diff holds no take-down copy (WI6) |
| D2 | CONFORMS | public.ts:866-885; missing / deleted / setup / off-list share `sendNotFound`; no status key. Test gap for a status under another key: C-2 |
| D3 | CONFORMS | the served render path is untouched by the branch; `PublicFlyer` has no status; "Same-day tours available" kept |
| D3a | CONFORMS | public.ts:883; FlyerPage unchanged for it (safeHttpUrl hides the row); video row kept (flyer-leads.spec.ts:766 terms include `Video tour`) |
| D4 | CONFORMS | copy in 1.3; trim + 1..200 check only on the fallback (FlyerPage.tsx:273-279), served `handleIntakeSubmit` :261-266 unchanged (WI2); 404, 5xx, network and 429 share one stage (:250-256); "See other homes" and UNAVAILABLE_PREFILL gone. The 200 copy cites `public.ts MAX_UNIT_ID_LEN` by symbol (:52-57), not `public.ts:124` - WL-23's sanctioned, S2-named deviation; the constant now sits at public.ts:129 |
| D5 | CONFORMS | public.ts:533 drives :627-628, :711, :758, :782-797; `'not_shareable'` kept (:164, :785) with its doc reworded (:152-160); abuse issue updated (1.4) |
| D6 | CONFORMS | public.ts:222-224; label through `isListingStatus` (statusModel.ts:472) + `LISTING_STATUS_LABELS`; after the address, before ` as`, opt-out note last |
| D7 | CONFORMS | ListingDetail.tsx:422 `deleted`, :429 `flyerPublic = !deleted && FLYER_PUBLIC.has(...)`, :430-434 deleted, then Setup, then other; mirror import :38 |
| D8 | CONFORMS | copy in 1.3; guard, composer list and modal flow unchanged; comments reworded (BroadcastComposer.tsx:540-543, broadcasts.ts:1181-1186) |
| D9 | CONFORMS | see 1.1; `docs/issues/sent-row-interested-ignores-listing-status.md` filed |

### 1.3 Fixed copy, byte-for-byte

JSX text lines join with one space; each string is also asserted whole by a test.

| Spec string | Live | Verdict |
|---|---|---|
| D4 h1 `Find a home that fits your voucher` | FlyerPage.tsx:295 | MATCH |
| D4 `Sign up and we'll text you about homes that fit your voucher. Signing up does not book a tour.` | :316-319 | MATCH |
| D4 submit `Sign up` | :320 | MATCH |
| D4 `Thanks - you're all set!` (focused) | :309-311 (h2, `ref={headingRef}`, tabIndex -1; effect :234-237) | MATCH |
| D4 `We'll text you about homes that fit your voucher.` | :312 | MATCH |
| D4 link `I'm looking for a home - text us` | :298-300 | MATCH |
| D4 prefill `I'm looking for a home that fits my voucher.` | :50 | MATCH |
| D4 `Looking for a home? Reply to the text we sent you and we'll help you find one.` | :302-305 | MATCH |
| D6 `Signed up from the flyer for <address> (Occupied) as <name>`; Available unchanged; `<unitId> (On hold)`; note last | public.ts:223-224 | MATCH |
| D7 `The public flyer is off while this property is deleted.` | ListingDetail.tsx:431 | MATCH |
| D7 `The public flyer goes live once this property leaves Setup.` | :433 | MATCH |
| D7 `The public flyer is off for this property.` | :434 | MATCH |
| D8 `This property is <status>. Only Available properties can be sent - you'll be asked to make it Available when you send.` | BroadcastComposer.tsx:547-549 | MATCH |
| D8 `This property isn't Available. Only Available properties can be sent - make it Available, then send.` | RecipientPreview.tsx:420 | MATCH |
| D8 `Only Available properties can be sent. Its status is currently <status>.` | RecipientPreview.tsx:758-759 | MATCH |

### 1.4 Spec section 4 (docs and comments)

| Site | Live | Verdict |
|---|---|---|
| STATUS-MODEL.md:308-309 | :308-313 | CONFORMS |
| GLOSSARY ~657-673 and :73 | :73, :706-721 (new bullet), :729-731, :737-742, :770-771 | CONFORMS |
| selectors.md ~54 | :55 (suffix, five labels, `<unitId> (<Status>)`, note last; "missing, deleted or in Setup (or a made-up id)" per WL-33) | CONFORMS |
| selectors.md fallback row (plan P8) | :50; served row :147 (every status but Setup, `Listing` only on Available) | CONFORMS |
| public-signup-abuse-hardening.md (D5) | :9, :35-40, :68, :131-143, :154, :222-224, :254-260; status and severity unchanged | CONFORMS |
| statusModel.ts:285-288; unitsRepo.ts:51-56, :63 | statusModel.ts:285-289; unitsRepo.ts:52-58, :65-67 | CONFORMS |
| public.ts header and the 15 listed sites | :16-23, :33-44, :53-57, :152-160, :232, :289-294, :321, :396-398, :465-468, :517-532, :604-626, :693-708, :768-770, :806-809, :858-865, :870-871 | CONFORMS |
| broadcasts.ts:1181-1186; units.ts ~982 | broadcasts.ts:1181-1186; units.ts:982-983 | CONFORMS |
| publicApi.ts:5-7; FlyerPage.tsx 14-15, :241-242 | publicApi.ts:5-9, :67-68, :79-80; FlyerPage.tsx:1-6, :16-19, :252-254 | CONFORMS |
| ListingDetail.tsx :82-83, :416-417, :937-938 | :83-85, :423-428, :951-953 | CONFORMS |
| RecipientPreview.tsx :87-89, :375-377 | :87-90, :376-377 | CONFORMS |
| activityEventsRepo.ts:74; types.ts:3048-3049; StatusBadge.tsx:46 | :74-76; :3104-3105; :46 | CONFORMS |
| apply.ts:1622; e2e steps :1033 (e2e/scenarios, plan P7); GLOSSARY:73; lean.ts ~211 | apply.ts:1622; e2e/scenarios/steps.ts:1033-1035; lean.ts:211-212 | CONFORMS |
| "the builder greps for more" | unitsApi.test.ts:673, backfillJoinHousingAuthority.test.ts:193, Timeline.test.tsx:443-446 and :464-466, sequence-diagram-to-test.md:173, unit-media-dangling-reference-race.md:36-39, e2e-session.mjs:169-172, backfill-join-housing-authority.ts:150-154 | CONFORMS at 9a5ef80b |
| The same rule after the main sync | e2e/support/selectors.md:145; e2e/tests/dashboard-next/property-priority.spec.ts:142-143 | MISSING - C-1 |

### 1.5 Spec section 5 (tests): does a regression turn something red?

| Spec test | Live test | Mutants (section 2) |
|---|---|---|
| App: six statuses served; setup / deleted / missing 404 with one body; no status key; `listing_link` stored for Available, null otherwise | publicIntake.test.ts:503, :520, :538-577, :719, :783-806 | M1, M3, M8, M10, M14, M15 killed; M16 SURVIVES (C-2) |
| App: Occupied and On hold sign-up (capture source, unit of interest, `(Occupied)` / `(On hold)`, ledger entry); setup and deleted keep the no-property path; Available label unchanged | publicIntake.test.ts:606-625; publicSignupLeads.test.ts:283-296, :299-320, :322-332, :537-569, :1154-1171 | M2, M4-M7, M9, M11 killed |
| App: `'placed'` cases moved to `'setup'` | 0 `unit-placed` left; `'placed'` only on the deliberate off-list seeds publicIntake.test.ts:563, publicSignupLeads.test.ts:338 | M8 killed (only by those two) |
| App: parity, six statuses | statusModel.test.ts:325-346 | M12 killed |
| Dashboard: FlyerPage fallback (both variants, with/without number, no retired words, unitId sent, over-long omitted, thank-you, sms prefill) | FlyerPage.test.tsx:669-832; D3a pin :624-630 | M20-M25 killed |
| Dashboard: ListingDetail available, occupied, setup, deleted, deleted + setup | ListingDetail.test.tsx:187-217, :276-330 (all six + off-list) | M17-M19, M26 killed |
| Dashboard: D8 strings; broadcastApi title | BroadcastComposer.test.tsx:576-598, :1767-1769; RecipientPreview.test.tsx:754-757, :831-835; broadcastApi.test.ts:2162 | M27-M29 killed; M13 (guard widened, WI4) killed by broadcastApi.test.ts:2162 |
| Dashboard: mirror parity | flyerPublicMirror.test.ts:22-41 | M30 and M12 killed |
| e2e (the five items) | 1.1 T9 row | not run here (rule); battery e2e green at this HEAD. By reading, a gate revert fails flyer-leads.spec.ts:763, listing-photos.spec.ts:338-344 and public-pages.spec.ts:628/:634; a kept listing link fails flyer-leads.spec.ts:775/:782; a dropped suffix fails flyer-leads.spec.ts:804-806; retired fallback copy fails public-pages.spec.ts:558/:584/:613 and environment-identity.spec.ts:45-47 |

### 1.6 Worklist (binding)

| WL | Verdict | Evidence |
|---|---|---|
| G1 | CONFORMS | no non-ASCII on any added line (`git diff -U0 71fb9b45 HEAD`, records excluded: grep exit 1) |
| G2 | CONFORMS | exact regexes at FlyerPage.test.tsx:690-691, public-pages.spec.ts:73/:76, listing-photos.spec.ts:348-349, flyer-leads.spec.ts:776-777; no `/available/i` absence anywhere |
| G3 | CONFORMS | FlyerPage.test.tsx:687-692 awaits the h1 first; ListingDetail.test.tsx:198-217 positive first; e2e absences follow a positive (public-pages.spec.ts:558-570, :613-620, :628-631) |
| G4 | CONFORMS | battery lint: only BroadcastComposer.tsx:426, :445 and FlyerPage.tsx:223, :241 (react-hooks/set-state-in-effect), all pre-existing |
| WL-1 | CONFORMS | statusModel.ts:298-305 after :290, one per line, trailing comma; 0 imports |
| WL-2 | CONFORMS | statusModel.ts:285-289; unitsRepo.ts:37, :52-58, :65-69, :72 |
| WL-3 | CONFORMS | statusModel.test.ts imports `FLYER_PUBLIC_STATUSES` from unitsRepo; `'placed'` only through it (:344) |
| WL-4 | CONFORMS | public.ts:869, :883-884; projection untouched |
| WL-5 | CONFORMS | one bare harness per status (publicIntake.test.ts:538-556); 404 group makes 4 requests (:557-576) |
| WL-6 | CONFORMS | nested describe :538 inside the :336 describe; `seedFullUnit(world, { status })` :543; seeded literal asserted :551 |
| WL-7 | CONFORMS | publicIntake.test.ts:3, :336, :382, :503-517, :520, :581, :719-733, :754-755, :783-806 |
| WL-8 | CONFORMS | :557-576 (setup, deleted occupied, off-list placed, missing; deep-equal) |
| WL-9 | CONFORMS | public.ts:396-398, :465-468, :858-865, :870-871 |
| WL-10 | CONFORMS | public.ts:533, :76; battery lint clean on public.ts |
| WL-11 | CONFORMS | public.ts:220-224 |
| WL-12 | CONFORMS | public.ts:152-160, :232, :289-294, :321, :517-532, :604-626, :693-708, :768-770, :806-809 |
| WL-13 | CONFORMS | publicIntake.test.ts:640-652, :660-666, :1007-1018, :1251, :1271-1281, :1458 |
| WL-14 | CONFORMS | publicSignupLeads.test.ts:284, :289, :521-529, :815-824, :944-950, :1130, :1138, :1277 |
| WL-15 | CONFORMS | 0 `unit-placed`; `'placed'` only at publicIntake.test.ts:563 and publicSignupLeads.test.ts:338, each seeded and sent in its own test |
| WL-16 | CONFORMS | publicSignupLeads.test.ts:87, :299-320, :322-332, :537-552, :554-569, :1154-1171 |
| WL-17 | CONFORMS | publicSignupLeads.test.ts:336-349 |
| WL-18 | CONFORMS | publicIntake.test.ts:606-625 |
| WL-19 | CONFORMS | flyerPublicMirror.test.ts:15-41 (3-level `.js` app import, literal six, SHAREABLE parity) |
| WL-20 | CONFORMS | types.ts:958-976, :3104-3105 |
| WL-21 | CONFORMS | FlyerPage.tsx:44, :241, :255, :252-254, :289-325; existing classes, no CSS diff |
| WL-22 | CONFORMS | FlyerPage.tsx:273-279 (IntakeForm's own type; `input` itself on the no-id path); :261-266 unchanged |
| WL-23 | CONFORMS | FlyerPage.tsx:52-57 symbol citation; no public.ts import |
| WL-24 | CONFORMS | FlyerPage.tsx:1-6, :16-19; publicApi.ts:5-9, :67-68, :79-80; FlyerPage.test.tsx:8-9 |
| WL-25 | CONFORMS | FlyerPage.test.tsx:726-737 (500, 429, `ApiError(0, 'network_error')`, TypeError); D3a pin :624-630 |
| WL-26 | CONFORMS | S2 ran App.test.tsx and both IntakeForm files; battery npm test green |
| WL-27 | CONFORMS | ListingDetail.tsx:38, :418-422 (moved with its comment), :423-434, :955, :970; comments :83-85, :951-953 |
| WL-28 | CONFORMS | ListingDetail.test.tsx:276-282 kept; :284-330 |
| WL-29 | CONFORMS | BroadcastComposer.tsx:540-543, :546-550 (inline label kept) |
| WL-30 | CONFORMS | RecipientPreview.tsx:87-90, :376-377, :420, :757-760 |
| WL-31 | CONFORMS | broadcasts.ts:1181-1186 replaced whole; :1187-1193 unchanged; broadcastApi.test.ts:2162 title only |
| WL-32 | CONFORMS | BroadcastComposer.test.tsx:576-582, :590, :598, :1767-1769; RecipientPreview.test.tsx:754-757, :831-835 |
| WL-33 | CONFORMS | every site in 1.4 |
| WL-34 | CONFORMS | LEAVE list in the 9a5ef80b body; spot-checked statusTransition.test.ts:152 and unitsApi.test.ts:640 (past tense), RUNBOOK.md:456 (backfill history), README.md:41 (field sense) |
| WL-35 | PARTIAL | complete at 9a5ef80b; at HEAD regex (a) has one new hit, selectors.md:145, plus a wrapped sentence at property-priority.spec.ts:142-143 - C-1 |
| WL-36 | CONFORMS | public-pages.spec.ts:36-39, :49-58, :65-67, :115-127, :168-172 |
| WL-37 | CONFORMS | :546-637; Setup read back :603-605; 404 deep-equal :610; unit-0001 served with its status never asserted :621-636 |
| WL-38 | CONFORMS | :639-680 |
| WL-39 | CONFORMS | listing-photos.spec.ts:24-25, :307-350 |
| WL-40 | CONFORMS | environment-identity.spec.ts:44-47; broadcasts.spec.ts:278, :284-288 (compose step) |
| WL-41 | CONFORMS | flyer-leads.spec.ts:751 (positive control), :755-758 (flip), :763-772 (positives), :775-777, :780-783, :803-809, :817-818, :821 |
| WL-42 | PARTIAL | as WL-35: property-priority.spec.ts:142-143 came in with the merge - C-1 |
| WL-43 | CONFORMS | no listing-status PATCH, delete or sign-up on unit-0001 / unit-0002 anywhere in e2e/; unit-0001 read-only at public-pages.spec.ts:627-636 |

### 1.7 Scope

Nothing built beyond the spec except worklist-ordered extras (the GLOSSARY
"public flyer statuses" bullet, the STATUS-MODEL "not a take-down" caveat,
the GLOSSARY Follow-up qualification, extra test assertions). None changes a
D9 surface or a section 6 non-goal, none puts a status word on a public page,
none describes Setup as a take-down, and the broadcast guard and the
composer's Available-only list are byte-unchanged.

## 2. Mutation runs

Each mutant edits one module in memory; ran the named existing files. App:
publicIntake + publicSignupLeads unless noted. "Killed" = at least one test red.

| M | Mutant (live site) | Result |
|---|---|---|
| M1 | flyer gate back to Available only (public.ts:869) | killed 6: the five non-Available it.each rows, E1 on_hold |
| M2 | sign-up gate back to Available only (:533) | killed 8: both capture-source rows, both suffix rows, no-address row, the P4 pair, opted-out occupied |
| M3 | `listing_link` kept off Available (:883) | killed 5: the five non-Available rows |
| M4 | pin suffix dropped (:224) | killed 6 |
| M5 | suffix moved after the opt-out note (:224) | killed 6 |
| M6 | raw status instead of its label (:223) | killed 6 |
| M7 | suffix on Available too (:223) | killed 23 (every Available-label case) |
| M8 | both gates "anything but setup" | killed 2: the 404 group (:557) and the off-list sign-up (:336) |
| M9 | `'not_shareable'` renamed (:785) | killed 2 (off-list case, SKIP_CASES) |
| M10 | flyer gate ignores soft-delete | killed 3 |
| M11 | sign-up gate ignores soft-delete | killed 2 |
| M12 | `off_market` dropped from app FLYER_PUBLIC | killed 2 app (statusModel, off_market row) + 1 dashboard (mirror) |
| M13 | broadcast guard widened to "anything but setup" (broadcasts.ts:1189; broadcastApi.test.ts) | killed 1 (:2162) |
| M14 | status label added to every payload (`badge`) | killed 1 (exact-key allowlist, Available seed only) |
| M15 | raw status added under another key | killed 7 |
| M16 | status label added ONLY off Available (+ propertyFormFlyerParity, unitFields) | SURVIVED - 246/246 green (C-2) |
| M17 | D7 note order swapped (Setup before deleted) | killed 1 (deleted + Setup) |
| M18 | D7 ignores deleted | killed 1 |
| M19 | D7 back to Available only | killed 5 |
| M26 | D7 "anything but setup" | killed 1 (off-list) |
| M20 | fallback id not trimmed | killed 3 |
| M21 | fallback 200 cap dropped | killed 1 (201 chars) |
| M22 | `unitId: undefined` key on the no-id path | killed 2 |
| M23 | "taken or removed" line restored | killed 15 (every fallback case) |
| M24 | thank-you heading loses its ref (no focus) | killed 1 |
| M25 | old sms prefill restored | killed 1 |
| M27 | composer note reverted | killed 2 |
| M28 | 400 text reverted | killed 1 |
| M29 | modal body reverted | killed 1 |
| M30 | `off_market` dropped from the dashboard mirror (+ ListingDetail) | killed 3 |

## 3. Findings

### C-1 MEDIUM (CONFIRMED) - the retired rule came back with the main sync

Evidence: two statements that the flyer serves only Available properties
arrived in merge 49d9fd24 (WP1 B1 files), after T8/T9's sweeps
(9a5ef80b, 98051455), and nothing re-swept after the sync:
- `e2e/support/selectors.md:145` (Priority switch row): "check it on an
  AVAILABLE property (any other status answers the unavailable page, where an
  absence proves nothing)". No status but Setup answers the fallback now, and
  the "unavailable page" no longer exists.
- `e2e/tests/dashboard-next/property-priority.spec.ts:142-143`: "publish (the
  flyer answers only for an Available property)".
Re-running WL-35 regex (a) over 26b4013b and 49d9fd24 gives exactly one new
hit, selectors.md:145; the spec comment escapes it because the sentence
wraps. Spec section 4: "Every doc or code comment that says Available gates
the public flyer ... is updated." selectors.md is the guide AGENTS.md sends
every spec author to. Behavior is unaffected (the test still publishes to
Available, and e2e is green).

Fix: reword both (doc and comment only), e.g. selectors.md:145 "check it on a
served flyer (any status but Setup; a Setup, deleted or missing property
shows the fallback page, where an absence proves nothing)" and
property-priority.spec.ts:142-143 "publish (the flyer serves every status but
Setup; Available is the plain case)". Then re-run both WL-35 regexes plus a
wrap-tolerant one (`answers only|only for an`) over the merged tree.

### C-2 LOW (CONFIRMED) - "no status field" is pinned only by key name and raw value off Available

Evidence: the six-status it.each (`app/test/publicIntake.test.ts:539-555`)
asserts `not.toHaveProperty('status')` and that `JSON.stringify(body)` lacks
the raw value (`occupied`, `on_hold`, ...). The exact-key allowlist
(:374-430) runs only on an Available unit. Mutant M16 - add
`badge: LISTING_STATUS_LABELS[unit.status]` to the payload only when the unit
is not Available (public.ts:884) - leaves publicIntake, publicSignupLeads,
propertyFormFlyerParity and unitFields green (246/246). The label
("Occupied", "On hold", "Off market") differs from the raw value in case and
spelling, so the JSON check misses it. By reading, e2e misses it too:
flyer-leads.spec.ts:783 and public-pages.spec.ts:636 check only the `status`
key, and the page renders no unknown key. That is the public status oracle D2
("The payload gains NO status field") and D3 ("The page has no status input")
rule out.

Fix: in the it.each, assert the exact key set (the :409-428 list, or the
Available run's `Object.keys(flyer).sort()`), and/or for the five
non-Available rows assert `JSON.stringify(res.body).toLowerCase()` does not
contain `LISTING_STATUS_LABELS[status].toLowerCase()`.

### C-3 INFO (CONFIRMED) - ungrammatical it.each titles

`app/test/publicIntake.test.ts:607` renders "for a occupied unit" / "for a
on_hold unit", and `app/test/publicSignupLeads.test.ts:306` "a flyer for a
occupied property" / "a flyer for a on_hold property". S1 open item 3; still
present. Fix: "for status %s" or "for a unit in status %s". Cosmetic.

### C-4 INFO (CONFIRMED) - dated reasons and line refs the sweeps left

None states the retired rule as current; all are optional one-line edits.
- `e2e/tests/dashboard-next/broadcasts.spec.ts:86`, :135-136, :352-353 and
  `matching-entry-points.spec.ts:22`, :58-59 give "unit-0001 MUST stay
  under_application for public-pages.spec.ts" as the reason. public-pages now
  needs only a public status; the rule itself (never move a seeded unit, WI7)
  is still right. S5 left them per R3-5.
- `app/src/repos/unitsRepo.ts:477` `/** Public flyer link. */` labels
  `listing_link`, the external listing URL, which since D3a reaches the flyer
  only while Available (pre-existing mislabel, S4 noted).
- `docs/issues/public-signup-abuse-hardening.md:10` refs and body cite
  public.ts ranges this branch shifted (signupPinLabel :198-211, live
  :208-225; repeat check :690-705, live :693-724).

### C-5 INFO (PLAUSIBLE) - a new reader of flyer share entries came in with the sync

WP1 B1's extraction PROPERTIES SENT block
(`app/src/services/extraction/sentPropertiesBlock.ts:10-14`, :91; rendered at
`app/src/jobs/extraction.ts:650`) lists a tenant's listing_sends rows with no
listing-status filter and marks a flyer row "signed up <date>". Since D5 a
sign-up from an Occupied, On hold or Off market flyer writes that row, so
those homes now reach the extraction prompt. This is D5's stated reach
("properties-sent rewrite target") and D9 keeps the rows status-free, so no
change is asked; the spec predates this reader, so one handback line for
Cameron covers it.

## 4. Review hygiene

During this review two untracked throwaway files from the parallel
adversarial reviewer were in the worktree (`app/test/zz-review-flyer.test.ts`,
`dashboard/src/routes/public/zz-review-flyer.test.tsx`, created 22:58 and
22:48, after the battery's npm test ended at 22:39; its e2e phase passed).
This reviewer did not touch them; their owner has since removed them. At
hand-off `git status --short -uall` shows only the two R1 reports
(R1-adversarial.md, R1-conformance.md). This reviewer's mutation harness
lived only in the scratchpad.
