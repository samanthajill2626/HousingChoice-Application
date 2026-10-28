# Build worklist - permanent flyer links (binding)

Orchestrator merge of the four Phase 1 readers (2026-10-28), all at HEAD
34994146 (source identical to main d0e2c2d8):
`R1.md` (app T1-T3, T7 app), `R2.md` (dashboard T4-T7), `R3.md` (e2e T9 +
docs T8), `R4.md` (whole-app invariant sweep). No BLOCKER. Byte-exact quotes
for every site: `.superpowers/sdd/research/R<n>-reference.md` (gitignored;
non-ASCII written as `<U+XXXX>` / `[U+XXXX]` - decode before building an Edit
old_string; NEVER copy an old_string from the plan or this file).

BINDING ORDER: the spec (rev 3) is the contract; where this worklist and the
plan (v2) disagree, THIS WORKLIST wins; where either seems to contradict the
spec, STOP and report. Line numbers are d0e2c2d8 hints - locate by symbol /
quoted text.

## Global rules (every slice)

- G1 ASCII: every ADDED line is ASCII. Several lines this build must rewrite
  hold non-ASCII today (R1-3, R2-3, R3-8): statusModel.ts:286 (U+00A7),
  unitsRepo.ts:54 and :63 (U+00A7), public.ts:277 (U+2192), :279 and :504
  (U+2014), BroadcastComposer.tsx:541-542 (U+2014), StatusBadge.tsx:46
  (U+2192), STATUS-MODEL.md:308-309 (U+2014), units.ts:982 (U+00A7, U+2014),
  lean.ts:211 (U+00A7 - the plan's "sec 6" is NOT the live text),
  e2e-session.mjs:169 (U+2014), publicIntake.test.ts:336, :503, :520
  (U+2014) and :596 (U+2026). Write ` - ` for U+2014, `->` for U+2192,
  `section ` (or `sec `) for U+00A7, `...` for U+2026. Leave every other
  non-ASCII line alone. Check before each commit:
  `git diff -U0 HEAD -- <files> | grep '^+' | grep -nP '[^\x00-\x7F]'`
  (no output = clean).
- G2 Absence checks for retired copy use exactly
  `/no longer available|taken|removed/i` (spec section 5). NEVER assert the
  absence of `/available/i`: every served flyer keeps "Same-day tours
  available" and the Same-day RTA row value "Available" (D3; R2-17, R4-8).
  Status-word absence on a served flyer uses the exact labels:
  `/under application|finalizing|occupied|on hold|off market/i`.
- G3 Any absence assertion comes AFTER a positive assertion on the same
  load (the page shows "Loading..." first; P6, R3-2).
- G4 Gate 5 attribution: four `react-hooks/set-state-in-effect` errors are
  PRE-EXISTING (FlyerPage.tsx:212 and :230, BroadcastComposer.tsx:426 and
  :445; R2-11). T5 renames the literal on FlyerPage.tsx:230 and shifts lines;
  do NOT refactor the effects - compare by rule + statement, not line, and
  report them. Every other touched file lints clean at base (R1-C20, R2-11),
  so any other error is the branch's.

## T1 - FLYER_PUBLIC (app status model)

- WL-1 `FLYER_PUBLIC` directly after `SHAREABLE` (statusModel.ts:289),
  hand-formatted like `LISTING_OVERRIDE_STATES` (:334-337: one entry per
  line, trailing comma) - there is no prettier (R1-10). statusModel.ts stays
  a LEAF module (zero imports; the dashboard mirror test compiles it -
  R1-C1, R2-20).
- WL-2 Reword the SHAREABLE doc (:285-288), unitsRepo.ts UnitStatus doc
  (:52-58) and SHAREABLE_STATUSES comment (:63) in ASCII (G1).
  `FLYER_PUBLIC_STATUSES: ReadonlySet<string> = FLYER_PUBLIC` after :64;
  import FLYER_PUBLIC in the :36-41 block.
- WL-3 Test: import `FLYER_PUBLIC_STATUSES` from `../src/repos/unitsRepo.js`
  (precedent seedData.test.ts:10). Assert `'placed'` ONLY through
  FLYER_PUBLIC_STATUSES - `FLYER_PUBLIC.has('placed')` is TS2345 under
  app/tsconfig.test.json (R1-C4).

## T2 - flyer API (D2, D3a)

- WL-4 Gate `public.ts:845` -> FLYER_PUBLIC_STATUSES; payload nulls
  `listing_link` off Available in the ROUTE; `toUnitFlyer` unchanged (WI1;
  it is the only app caller, and propertyFormFlyerParity.test.ts pins the
  projection - R1-C7, R1-14). Keep the SHAREABLE_STATUSES import until T3.
- WL-5 Rate limit: a bare `makeWebhookHarness()` allows 5 /public requests
  per minute (config.ts:1008); a 6th answers 429 (R1-4). At most 5 per bare
  harness, else `makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100' } })`
  (pattern publicIntake.test.ts:134).
- WL-6 Seed helpers are describe-local: `seedFullUnit` inside the describe
  at :336, `seedShareable` inside :687 (R1-6). Put the new six-status
  `it.each` and the 404 group inside the :336 describe (reusing
  `seedFullUnit(world, { status })`, whose link is
  `https://example.com/listing/1`) or seed inline (pattern :652-662). Assert
  the exact literal you seeded. Do not hoist or rename helpers.
- WL-7 Renames/titles in publicIntake.test.ts (R1-7, R1-C9, R3-9): :503
  title -> `404s a missing unit and a setup unit - no existence oracle`,
  seed :505 -> `'setup'`, local `placed` (:513-517) -> `setupRes`; :650
  title "not-shareable" -> "setup", `unit-held` on_hold seed (:652-653, :664)
  -> `unit-setup` status `setup`; :713 E1 -> served, 200, same media URLs as
  the Available read, plus a sibling: flip to `setup` -> opaque 404; :520
  title -> `404s a soft-deleted unit even while its status is still public - no existence oracle`;
  header :3 -> `(public fields only; every status but setup, 404 otherwise)`;
  describe title :336 and comment :686 reworded (G1); `:382` and `:535`
  "shareable" -> "public" (unit-status sense).
- WL-8 The identical-404-body test gains a FOURTH unit seeded
  `status: 'placed'` (a stored status outside LISTING_STATUSES is not
  public - spec D1; R1-13): setup, deleted-with-`occupied`, missing and
  placed -> 404 with deep-equal bodies.
- WL-9 Comments: route :837-841 and :846, sendNotFound :450-455 (incl.
  "unavailable state" :452), :380-384 ("unavailable state"), :839
  ("non-available unit") - 404 = missing, soft-deleted or setup; "no
  existence oracle" = nothing beyond holding the id; the page shows the
  neutral fallback.

## T3 - sign-up attribution + pin suffix (D5, D6)

- WL-10 `viaFlyer` (:515) -> `FLYER_PUBLIC_STATUSES.has(...)`; REMOVE
  SHAREABLE_STATUSES from the :71 import (else eslint no-unused-vars; tsc
  does not catch it - R1-C13). Run `npx eslint app/src/routes/public.ts`.
- WL-11 signupPinLabel (:198-211): status label via
  `isListingStatus(s) ? LISTING_STATUS_LABELS[s] : s` (statusModel.ts:456;
  cast-free, prototype-safe - R1-12), imported with LISTING_STATUS_LABELS
  from `../lib/statusModel.js`. Suffix ` (<Label>)` right after
  `formatAddress(address) || unitId`, before ` as <name>`; the opt-out note
  stays last. Only when viaFlyer and status !== 'available'.
- WL-12 Comments (plan T3 list) PLUS: :306 "exists or is shareable" ->
  "exists or is public" (R1-2, R4-5); :681 "unavailable"; the
  `SignupSentSkipped` doc :147-153 ("the flyer's unit is missing, deleted or
  not public (FLYER_PUBLIC)"); keep the `'not_shareable'` value (WI3). :277,
  :279, :504 are non-ASCII (G1).
- WL-13 publicIntake.test.ts (R1-7, R3-9): :571 title ->
  `falls back to housing_fair when the unit exists but is in Setup`, its
  `'unit-placed'` (:573-574, :583) -> `'unit-setup'`, :576 ->
  `status: 'setup', // not public (setup)`; :591 title ->
  `falls back to housing_fair when the unit is soft-deleted (even if its status is still public)`,
  :596 comment -> `// a public status, but...` (U+2026 there); :919-923 seed
  AND loop list `unit-placed` -> `unit-setup`, :931 ->
  `// Identical for a public, a missing and a setup unit: no oracle.`;
  :1184-1186 seed + id; :1164, :1371 "shareable" -> "public".
- WL-14 publicSignupLeads.test.ts (R1-1, R1-C15): seeds :287, :469, :727,
  :858, :1048, :1166 + their request bodies -> `'unit-setup', { status: 'setup' }`;
  it.each row :282 -> `['a setup property', 'unit-setup']`; PIN_FORMS :1040
  -> `'a flyer whose property is in Setup'`; titles :467 ->
  `/join, then a flyer for a setup property within 24 hours: one pin (the shared no-property source)`
  and :725 -> `/join, a setup property and a made-up unitId never touch the ledger`.
- WL-15 After T3 the P5 grep
  `grep -n "unit-placed\|'placed'" app/test/publicIntake.test.ts app/test/publicSignupLeads.test.ts`
  prints ONLY the `status: 'placed'` seed lines of the new WL-8 / WL-17
  cases (each a deliberate off-list unit status on a unit id like
  `unit-offlist`, seeded and sent in the same test) - no `unit-placed` id
  remains anywhere.
- WL-16 New assertions use the file's own readers (R1-8): audit
  `signupAudits(world).map((e) => e.payload)` toEqual
  `[expect.objectContaining({ viaFlyer: true, recorded: true, sentRecorded: true })]`
  with no `sentSkipped`; entry `(await ledgerRow(world, '<unitId>'))?.shares`
  toEqual `{ flyer: flyerEntry(T0_ISO) }`; pin via `pins(world)` with
  `refType: 'unit', refId: '<unitId>'`. The label carries the TYPED name
  from `signupBody` (`Keisha Jones`), not the seeded contact's name. Cases:
  occupied (address), on_hold (address), on_hold (no address -> unitId),
  occupied + opted-out (suffix before the note), Available unchanged; P4
  pair: occupied flyer then `/join` -> TWO pins (red today), same occupied
  flyer twice -> one pin whose ref is the unit.
- WL-17 publicSignupLeads.test.ts: one sign-up with a unit seeded
  `status: 'placed'` (id `unit-offlist`) -> the no-property label
  `Signed up from a flyer as ...`, no ref, `sentSkipped: 'not_shareable'`
  (guards viaFlyer against a `!== 'setup'` mutant; R1-13).
- WL-18 publicIntake.test.ts capture-source cases: `it.each(['occupied','on_hold'])`
  -> `capture_source: 'flyer'`, `unit_of_interest: <unitId>` (new contact).

## T4 - dashboard FLYER_PUBLIC mirror

- WL-19 New `dashboard/src/api/flyerPublicMirror.test.ts`: app import
  `../../../app/src/lib/statusModel.js` (3 levels from src/api; keep `.js`;
  R2-22), dashboard copies from `./index.js` (index.ts:3 `export *` already
  re-exports types.ts - R2-19). Assert: equals the app set (sorted), no
  `setup`, SHAREABLE equals the app's, AND the literal six (spec section 5;
  R2-13).
- WL-20 types.ts: mirror after :936 (`// MIRRORS app/src/lib/statusModel.ts FLYER_PUBLIC`),
  reword :935 and :3048-3049 (ASCII today).

## T5 - FlyerPage fallback (D4)

- WL-21 Live anchors (R2-24..R2-31): Stage :38-41; `setStage` unavailable at
  :230 (unitId undefined) and :243 (catch); catch comment :241-242;
  UNAVAILABLE_PREFILL :45-46; `smsHref(number, body)` :50-52; focus effect
  keyed on `[submitted]` (:223-226) - a fallback h2 holding `headingRef` gets
  focus; served thank-you :427-432; classes card/title/muted/linkButton/
  ctaSection exist. The only non-ASCII line is :259 (leave it).
- WL-22 `handleFallbackSubmit` takes IntakeForm's own parameter type
  `Omit<HousingFairInput, 'unitId' | 'housingAuthority'>` (IntakeForm.tsx:23;
  R2-9). On the no-id path pass `input` itself - never
  `{ ...input, unitId: undefined }` (an own undefined key fails
  `not.toHaveProperty('unitId')`). `handleIntakeSubmit` unchanged (WI2).
- WL-23 `MAX_UNIT_ID_LEN = 200` comment cites by SYMBOL: "app/src/routes/public.ts
  MAX_UNIT_ID_LEN, checked in parseHousingFairBody after the app-wide body
  trim (app.ts trimJsonBody)" (R1-11, R2-12). Never import public.ts from a
  dashboard test (not a leaf).
- WL-24 Comments: FlyerPage.tsx header :1-2 and :14-15; publicApi.ts :5-7,
  :66 -> "(and a public unit - every status but Setup)", :77 -> "for a
  missing, deleted or Setup unit"; FlyerPage.test.tsx:8 -> "the
  variant-aware fallback (permanent-flyer-links D4)" (R2-4, R4-5).
- WL-25 Tests (plan T5 list) plus: failures as `ApiError(500, ...)` AND
  `new ApiError(0, 'network_error', 'Network request failed')` (the real
  network shape, client.ts:139-141; R2-14), optionally a TypeError; a D3a
  pin on the BARE fixture (`listing_link: null`):
  `screen.queryByText('Listing', { selector: 'dt' })` is null (R2-18). The
  404 ApiError pattern is FlyerPage.test.tsx:322-327; `renderPage(entry)`
  at :55.
- WL-26 After T5 also run `src/App.test.tsx` (renders `/p/missing-unit`),
  `src/routes/public/IntakeForm.test.tsx` and `IntakeForm.props.test.tsx`
  (R2-7).

## T6 - property page flyer line (D7)

- WL-27 Move `deleted` (:435) WITH its comment (:431-434) above the flyer
  comment (:416); nothing between depends on order (R2-10). `flyerShareable`
  (:418) is read only at :940. Import FLYER_PUBLIC from `'../../api/index.js'`
  (second import block :37-45; R2-32). Reword :82-84, :416-417, :937-938.
- WL-28 Tests: REPLACE :252-259 (title states the retired rule) with the
  Setup case; keep :244-250 (available); add occupied, deleted, deleted +
  setup, unknown `status: 'placed'` (no cast needed - R2-33) (R2-6). After T6
  also run `src/routes/listing/useListing.test.tsx` (R2-7).

## T7 - broadcast staff copy (D8; guard unchanged)

- WL-29 BroadcastComposer.tsx :540-550: keep the inline
  `LISTING_STATUS_LABELS[...] ?? unit.status` inside `<strong>` (there is no
  `label` variable - R2-8); change only the text after `</strong>`; comment
  :540-542 rewritten ASCII (G1).
- WL-30 RecipientPreview.tsx: comments :87-89 and :375-377 (both say the
  link is dead / only resolves while Available - reword), :419 setError,
  :756-760 modal body.
- WL-31 broadcasts.ts :1181-1186: replace the comment WHOLE (R1-9), e.g.
  "Availability guard (spec 2026-07-10; permanent-flyer-links D8): a send
  says the home is open to apply for now, so only SHAREABLE ('available')
  units can be sent; the public flyer itself serves more (FLYER_PUBLIC).
  Re-check at SEND time, not create time - a draft can outlive a status
  change. Missing and soft-deleted units get the same refusal. The dashboard
  maps this 400 to its make-available dialog." Guard :1187-1193 unchanged.
  broadcastApi.test.ts:2162 title -> `refuses to send when the unit is not available (only Available properties can be sent)`
  (stays green with the title change only - R1-C19).
- WL-32 Test mechanics (R2-1, R2-2): the D8 sentence appears in the note,
  the modal body AND the 400 alert on the preview step - scope modal
  assertions with `within(dialog)`, assert the composer note only at the
  compose step; sentences span a `<strong>`, so find by regex then
  `toHaveTextContent('<full sentence>')`; tighten RecipientPreview.test.tsx:824
  to the full 400 string; ADD a dialog-body assertion (none exists); assert
  `not.toHaveTextContent(/flyer link/)` in all three.

## T8 - docs and comment sweep (docs-only)

- WL-33 Known sites with these texts (ASCII; R3 section 3 has drafts):
  - STATUS-MODEL.md:308-309: Setup "being prepped; not yet public (the
    flyer serves every status but Setup)"; Available "the only status a
    property can be sent in (broadcasts)"; plus ONE D1 caveat line: moving a
    property back to Setup is not a take-down (derivation overwrites Setup
    on the next placement event); deleting the property is the only durable
    way to take its flyer down (R3-12; WI6 - never phrase Setup as a
    take-down).
  - GLOSSARY.md :73, :663-665, :671-673 (R3 section 3); :700-701 qualify
    "back on Follow up once quiet" with "while the property is Available
    (Follow up lists Available properties only)" (R4-3 - do NOT widen
    followUps.ts); ONE new "Feature & label notes" bullet: public flyer
    statuses (FLYER_PUBLIC) vs sendable (SHAREABLE), the fallback page,
    Setup not a take-down (R3-13).
  - selectors.md :54 (status suffix form + "missing, deleted or in Setup
    (or a made-up id)"), :143 (served for every status but Setup; `Listing`
    only on an Available home - D3a), and the NEW fallback row placed right
    after the Public form rows (:45-49) - R3-10 cell text, with the
    fallback's OWN thank-you `We'll text you about homes that fit your voucher.`
    (R3-10, R4-4). Keeping it away from :141-143 also avoids WP1 B1's
    insertion there (R4-11).
  - public-signup-abuse-hardening.md: reword :63, :126, :132-134, :145,
    :213 in place; keep the dated :243 wording and APPEND the widening;
    one dated sentence at the end of Problem (every non-setup unitId,
    old Matching/broadcast ids included, is a live 24-hour pin source and
    properties-sent rewrite target - spec D5); bump `updated:`; status and
    severity unchanged (R3-11). Do not claim old links churn Follow up
    (R4-3).
  - Code comments: units.ts:982-983 ("not yet on the public flyer, and only
    'available' can be sent" - no "never"), apply.ts:1622 ("not on the
    public flyer (setup is the one status it does not serve)"),
    activityEventsRepo.ts:74, StatusBadge.tsx:46, lean.ts:211 (U+00A7 live),
    e2e/scenarios/steps.ts:1033, scripts/e2e-session.mjs:169-170 (a 429 now
    renders the fallback), app/scripts/backfill-join-housing-authority.ts:150
    TIME-accurate: "(a /join sign-up, or a flyer one whose unit earned no
    flyer credit when it was written - before permanent-flyer-links, any
    status but available)" (R4-7).
  - Missed hits (R3-9, R4-6): unitsApi.test.ts:673 (present tense ->
    "listing Available (the one sendable status) while the deal
    progresses"), backfillJoinHousingAuthority.test.ts:193 label ->
    `'a flyer sign-up for a public unit'`, Timeline.test.tsx:443 and :463,
    documentation/sequence-diagram-to-test.md:173,
    docs/issues/unit-media-dangling-reference-race.md:36.
- WL-34 LEAVE (record in the commit body): statusTransition.test.ts:152 and
  unitsApi.test.ts:640 (past-tense narrative of the OLD bug),
  seedData.test.ts:6 (bug class, true in both senses), every `SHAREABLE` /
  `SHAREABLE_STATUSES` / `seedShareable` / `ShareableUnit` identifier, the
  `'not_shareable'` value, field-sense "Shareable." (unitsRepo.ts:470-474,
  unitFields.ts:413), URL-sense "flyer link", "shareable deep link"
  (Inbox), still-true broadcast text, EmailTriage.tsx:66, catalog.ts:664,
  the STAFF SMS "no longer available" in tenant-onboarding (spec + sequence
  docs), RUNBOOK.md:456, README.md:41, dated docs under docs/superpowers/
  (R3 section 5, R2-15, R4-6).
- WL-35 Two sweeps, every hit settled (CHANGE or LEAVE-with-reason):
  (a) the plan's `git grep -n -i -E "shareable|no longer available|flyer link"`;
  (b) `git grep -n -i -E "unavailable|non-available|not public yet|flyer link is dead|only resolves while|only works while|equally dead"`
  (R1-1, R4-5), both over app/src app/test app/scripts scripts
  dashboard/src e2e/support e2e/scenarios documentation docs/issues.
  Ignore (b)'s unrelated rosterResolution.ts:26, PeopleCard.test.tsx:6,
  relayFanOut.test.ts:547.

## T9 - e2e (spec section 5)

- WL-36 public-pages.spec.ts: rename `NON_SHAREABLE_UNIT` ->
  `UNDER_APPLICATION_UNIT`; header :36-38 and :47-49 and :57 rewritten
  (R3-7). `createShareableUnit` gets a NEW third parameter
  `opts: { setup?: boolean } = {}` that returns before the Available flip
  (`Partial<ShareableUnit>` has no `setup` key and the e2e workspace is
  typechecked - R3-1); reword its JSDoc and the :147 comment.
- WL-37 The fallback test (plan T9.1 (a)-(e)) with: the `request` fixture
  (R3-2); (c) read the Setup unit's status back via
  `GET /api/units/<id>` (`body.unit.status === 'setup'`) before opening
  `/p/<id>`, and the flyer API answers 404 for the Setup id and a bogus id
  with deep-equal bodies (R3-1); (d) `UNDER_APPLICATION_UNIT` is SERVED -
  `Sign up for home alerts` heading + API 200 - and NEVER assert its status
  (its status follows placement-0001, which other specs move; every derived
  status serves - R4-1; R3-5 (b) rejected); then the G2 status-word absence
  (R3-4); (e) every absence after its positive (G3).
- WL-38 NEW test in public-pages.spec.ts (AGENTS.md: new behavior gets a
  spec; R3-6): a sign-up FROM the fallback of a bogus id (bare variant) -
  fill the inline form (unique phone, the file's `fillIntake`), `Sign up`,
  the thank-you `/you're all set/i` with the exact
  `We'll text you about homes that fit your voucher.`; then via the staff
  API (pattern of the file's flyer-attributed test ~268) the contact has
  `capture_source: 'housing_fair'`, no `unit_of_interest`, status
  `needs_review` (a unitId was sent - public.ts:596).
- WL-39 listing-photos.spec.ts E1 (R3-7): retitle :307, comments :24-25,
  :327, :333-334; after the flip to On hold: `Home photo 1` with loaded
  bytes (`expectLoadedBytes`), the flyer API 200 with the SAME media as the
  Available read (`okFlyer`), then the G2 status-word absence.
- WL-40 environment-identity.spec.ts:44 -> h1
  `Find a home that fits your voucher` (level 1). broadcasts.spec.ts :278
  comment and :283 `/Only Available properties can be sent/` at the COMPOSE
  step only (R2-1).
- WL-41 flyer-leads.spec.ts new Occupied test - follow R3-3's 8 steps:
  run-unique landlord via `createContact`; `createAvailableUnit`; D3a
  positive control (`See the full listing` href `unit.listingUrl`) BEFORE
  the flip; PATCH listing-status `{ toStatus: 'occupied', source: 'manual' }`;
  reload the visitor page, positive first (h1 = line1, `Watch the tour`
  visible), then `See the full listing` count 0, status-word absence (G2),
  flyer API `listing_link === null` and no `status` key; sign up a NEW
  person; `signedUpPins` exactly `[`${pinLabel}|unit|${unitId}`]` with
  `Signed up from the flyer for ${line1}, ${CITY_LINE} (Occupied) as ${first} ${last}`;
  `sentOutcome` `signed_up`; `getContact` capture_source `flyer`,
  unit_of_interest the unit; the contact page link `{ name: pinLabel, exact: true }`;
  finally `serverUnread` polls to 0 (the file's isolation rule, :35-36).
- WL-42 Sweep e2e/tests with both WL-35 regexes; settle every hit per R3
  section 5.2 (LEAVE list there).
- WL-43 Never change a seeded unit's status (WI7); unit-0001 / unit-0002
  are read-only. Verify by running ONLY the touched specs:
  `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/<file>.spec.ts ...`
  (never the root double hop with flags; never commit while it runs).

## Adjudicated FLAGs (orchestrator)

| Item | Ruling |
|---|---|
| R1-12 label lookup | ACCEPT (b) `isListingStatus` guard (WL-11) |
| R1-13 off-list status coverage | ACCEPT both route cases (WL-8, WL-17) |
| R1-14 / R2-16 "Public listing link" On-flyer tag | LEAVE; handback note for Cameron (the tag is a field class; D3a makes it Available-only; no spec item) |
| R2-11 pre-existing hooks lint | LEAVE by baseline attribution; name all four in the handback (G4) |
| R2-12 MAX_UNIT_ID_LEN mirror | ACCEPT (a) symbol citation + 200/201 boundary tests (WL-23) |
| R2-13 literal six in dashboard test | ACCEPT (WL-19) |
| R2-14 network failure shape | ACCEPT (WL-25) |
| R2-15 unrelated grep hits | LEAVE (WL-34) |
| R2-17 / R4-8 "Available" in non-status senses | LEAVE copy (D3); G2 governs tests |
| R2-18 D3a unit pin | ACCEPT (WL-25) |
| R3-4 e2e status-word absence | ACCEPT (G2, WL-37, WL-39, WL-41) |
| R3-5 unit-0001 status precondition | REJECT - R4-1: its status drifts with placement-0001 across specs; the run-unique Occupied and On hold tests prove non-Available serving |
| R3-6 e2e fallback sign-up | ACCEPT (WL-38) - a new user-facing flow gets a spec (AGENTS.md) |
| R3-11 abuse issue history line | ACCEPT (b) append, keep the dated wording (WL-33) |
| R3-12 Setup take-down caveat | ACCEPT one caveat in STATUS-MODEL; no "never" for setup in comments (WL-33) |
| R3-13 GLOSSARY entry | ACCEPT one bullet (WL-33) |
| R4-2 imported Placed -> occupied go public | No code; handback states it (D1/D2 cover it) |
| R4-7 backfill comment | ACCEPT time-accurate wording (WL-33) |
| R4-10 sign-ups under "Interested" on an Occupied Sent to card | LEAVE (D9, intent #6: no tour is created or said); self-QA screenshots it; handback "your eye" |
| R4-11 WP1 B1 overlaps five files | Note for the T10 sync (main has not moved yet) |
| R4-6 vs R1/R3 on statusTransition.test.ts:152, unitsApi.test.ts:640/:673 | :152 and :640 LEAVE (past-tense narrative); :673 CHANGE (present tense) - read by the orchestrator |

## Confirmed invariant facts (R4 - no change needed)

- No other writer of unit status / deleted_at (R4 A11); derivation never
  yields setup; restore never writes status.
- Cameron's rule holds (R4-9): a flyer sign-up never creates a tour or says
  one is needed (no tours dependency in public.ts; tours only via
  POST /api/tours and the staff Interested click; Today's tours_to_book reads
  requested tours only; signed_up never waits; the welcome names no home).
- `unit_of_interest` has no reader; capture_source 'flyer' has no consent
  effect; a flyer entry never marks "already sent" nor clears a decline;
  Follow up / Quiet shares stay Available-only by design.
- CloudFront: /public/* and /p/* CachingDisabled; the 404 JSON passes through.
- No code parses the sign-up pin label (R1-C17).
