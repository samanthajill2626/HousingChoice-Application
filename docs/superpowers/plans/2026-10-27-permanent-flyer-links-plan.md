# Implementation plan - permanent flyer links

- Spec (the contract - read it in full before T1):
  `docs/superpowers/specs/2026-10-27-permanent-flyer-links-design.md` (rev 3,
  APPROVED by Cameron 2026-10-27). "D<n>" and "spec section <n>" refer to it.
- Branch `feat/permanent-flyer-links`, worktree `W:\tmp\permanent-flyer-links`,
  cut from main @d0e2c2d8. Mission records:
  `docs/superpowers/reviews/2026-10-27-permanent-flyer-links/`.
- Spec review: 2 rounds, closed -
  `docs/superpowers/reviews/2026-10-27-permanent-flyer-links/design-review/adjudications.md`.
- Status: PLAN v1 (2026-10-27), before plan review.

Line numbers below were read at d0e2c2d8 and are hints; the SYMBOLS and the
quoted text identify each site.

## 0. Ground rules

- Every task is TDD: write or change the test, run it RED and confirm it is
  red for the stated reason, implement, run it GREEN, commit. One commit per
  task. A task marked comment-only or docs-only has no RED step.
- Setup, once, before T1: if the worktree has no `node_modules`, run `npm ci`
  at the worktree root (bare; expect exit 0). Never symlink another
  worktree's node_modules. No dependency is added by this plan.
- Run single test files while iterating:
  `cd W:\tmp\permanent-flyer-links\app; npx vitest run test/<file>` and
  `cd W:\tmp\permanent-flyer-links\dashboard; npx vitest run src/<path>`.
  App tests that touch DynamoDB Local need `npm run db:start` first; the
  files this plan touches use the in-memory fake world and do not.
- Commits: a separate bare `git status` read first; check that
  `W:\AI Projects\Housing Choice\HC Application\.git\worktrees\permanent-flyer-links\MERGE_HEAD`
  is absent; stage explicit paths only (never `git add -A`); ASCII message
  ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or
  the authoring model's name). Never commit while `npm run e2e` runs.
- Every new or touched line is ASCII. Many touched files already hold
  non-ASCII (em dashes, "Loading..." with an ellipsis glyph in
  FlyerPage.tsx); leave those lines alone and keep ADDED lines ASCII. Check
  a file's added lines with
  `git diff -U0 -- <file> | grep '^+' | grep -nP '[^\x00-\x7F]'` (no output
  = clean).
- Vocabulary (AGENTS.md): "home" on the public page, "property" in the
  dashboard, `unit` in code.
- Never touch the live :5174/:8080 stack. e2e runs only through
  `npm run e2e` (or an `e2e:session` lane) from this worktree.
- Do not change anything the spec lists as unchanged (D9) or as a non-goal
  (spec section 6): the broadcast send guard, the composer's Available-only
  unit list, `/join`, `IntakeForm`, rate limits, `/unit-media`, the
  properties-sent rows.

## 1. Surfaces of the invariant "which units does the public flyer serve"

The spec moves the flyer from `SHAREABLE` (`{'available'}`) to a new
`FLYER_PUBLIC` (six statuses). Every reader and writer of that decision:

Readers (all changed by this plan unless marked):

| # | Reader | Site | Task |
|---|---|---|---|
| R1 | Flyer API gate | `app/src/routes/public.ts` `router.get('/units/:unitId/flyer'` (~842-855) | T2 |
| R2 | Sign-up attribution `viaFlyer` | `public.ts` ~507-518 | T3 |
| R3 | Pin label | `public.ts` `signupPinLabel` ~198-211 | T3 |
| R4 | Pin repeat-check source, properties-sent entry, capture source, unit of interest | all keyed off `viaFlyer` (`public.ts` ~603-610, ~692, ~762-777) | T3 (follow R2; no code change of their own) |
| R5 | Dashboard property page flyer line | `dashboard/src/routes/listing/ListingDetail.tsx` `flyerShareable` ~418, render ~937-958 | T6 |
| R6 | Flyer page (renders whatever R1 answers) | `dashboard/src/routes/public/FlyerPage.tsx` | T5 |
| R7 | Broadcast send guard | `app/src/routes/broadcasts.ts` ~1181-1193 | UNCHANGED (keeps `SHAREABLE_STATUSES`); comment only, T7 |
| R8 | Composer early note, 400 text, make-available modal | `BroadcastComposer.tsx` ~540-549, `RecipientPreview.tsx` ~416-419, ~756-759 | T7 (copy only) |
| R9 | Composer unit list (Available only) | `BroadcastComposer.tsx` ~376 | UNCHANGED |
| R10 | Dashboard `SHAREABLE` mirror | `dashboard/src/api/types.ts` ~935-936 (no runtime reader) | T4 (comment + new FLYER_PUBLIC mirror) |
| R11 | `flyerPath` helper | `dashboard/src/routes/listing/listingLinks.ts` (no status logic, no runtime caller) | UNCHANGED |
| R12 | `[FlyerLink]` merge field | `app/src/lib/mergeFields.ts:30` (builds the URL, no status logic) | UNCHANGED |

Writers of the inputs (unit status and soft-delete). None changes; each is a
WATCH item because its effect on the flyer changes:

- W1 Manual listing-status transition (`app/src/routes/statusTransition.ts`
  ~346-361): any status from any status. Moving to Setup now hides the flyer
  only until derivation (spec D1) - do not document Setup as a take-down.
- W2 Derivation on placement events (`app/src/lib/statusModel.ts` ~321-337):
  overwrites setup and the derived statuses; only on_hold / off_market pin.
- W3 Unit create (starts `setup` -> fallback, unchanged).
- W4 Soft-delete / restore (`app/src/routes/units.ts` ~2501): deleted ->
  fallback; restore -> served again if the status is public. Covered by the
  T2 deleted case; restore needs no code.
- W5 Import apply (`app/src/lib/import/apply.ts` ~1622): comment only (T8).
- W6 Seeds (`app/src/lib/seed/lean.ts` ~211): comment only (T8). The seeded
  `unit-0001` is `under_application` and now serves its flyer; e2e uses it
  read-only (T9).

## 2. Tasks

### T1. `FLYER_PUBLIC` in the status model (D1)

Files: `app/src/lib/statusModel.ts`, `app/src/repos/unitsRepo.ts`,
`app/test/statusModel.test.ts`.

1. RED: in `app/test/statusModel.test.ts` add a describe
   `statusModel - public flyer statuses (permanent-flyer-links D1)` with:
   - `FLYER_PUBLIC` equals exactly
     `['available','under_application','finalizing','occupied','on_hold','off_market']`
     (compare sorted arrays, so order is free but membership is exact).
   - `FLYER_PUBLIC` does not contain `setup`.
   - `SHAREABLE` still equals exactly `['available']` (PIN).
   - `FLYER_PUBLIC_STATUSES` (import from `../src/repos/unitsRepo.js`) is the
     same set object as `FLYER_PUBLIC`, and `.has('placed')` is false (a
     stored value outside LISTING_STATUSES is not public).
   Red because the exports do not exist.
2. GREEN: in `statusModel.ts`, after `SHAREABLE`, add
   ```ts
   /**
    * The statuses whose property the PUBLIC FLYER serves (permanent-flyer-links
    * D1, 2026-10-27): every listing status except `setup`, written out so a
    * future status is not public until someone adds it here. A flyer sign-up's
    * attribution follows the same set. Broadcasts do NOT use this - see SHAREABLE.
    */
   export const FLYER_PUBLIC: ReadonlySet<ListingStatus> = new Set<ListingStatus>([
     'available', 'under_application', 'finalizing', 'occupied', 'on_hold', 'off_market',
   ]);
   ```
   (format to the file's prettier style). Reword the `SHAREABLE` doc comment
   (~285-288) to: the only status a property can be SENT in (broadcasts); the
   public flyer uses FLYER_PUBLIC.
3. In `unitsRepo.ts`: import `FLYER_PUBLIC` beside `SHAREABLE` (~38) and add
   below `SHAREABLE_STATUSES` (~64):
   ```ts
   /** Statuses whose unit the public flyer endpoint serves (every status but setup). */
   export const FLYER_PUBLIC_STATUSES: ReadonlySet<string> = FLYER_PUBLIC;
   ```
   Reword the `SHAREABLE_STATUSES` comment (~63: "only `available`") to the
   broadcast meaning, and the `UnitStatus` doc block (~51-56: "also gates the
   public flyer ... `available` is the only publicly shareable status") to:
   the flyer serves every status but setup (FLYER_PUBLIC_STATUSES); only
   `available` can be sent (SHAREABLE_STATUSES).
4. Run the file GREEN; `npm run typecheck` from the worktree root (bare).
   Commit `feat(status): FLYER_PUBLIC - every listing status but setup serves the public flyer`.

### T2. Flyer API serves FLYER_PUBLIC; no listing link off Available (D2, D3a)

Files: `app/src/routes/public.ts`, `app/test/publicIntake.test.ts`.

1. RED - change and add cases in `app/test/publicIntake.test.ts` (read the
   file's `seedFullUnit` / `seedShareable` helpers first):
   - `it('404s a missing unit and a non-shareable (placed/inactive) unit ...')`
     (~505): seed `status: 'setup'` instead of `'placed'`; rename to
     `404s a missing unit and a setup unit - no existence oracle`.
   - The `describe('GET /public/units/:unitId/flyer - the opaque 404 carries contact_number'`
     case `missing, deleted, and not-shareable all return the IDENTICAL body`
     (~640-660) seeds an `on_hold` unit as the not-shareable case: change it
     to `setup` and rename "not-shareable" -> "setup".
   - `E1: flipping the SAME unit to on_hold 404s the WHOLE flyer (photos included)`
     (~715): rewrite as `flipping the SAME unit to on_hold still serves the
     whole flyer, photos included (permanent-flyer-links D2)` - 200, same
     media URLs as the Available case. Add a sibling: flipping to `setup`
     404s with the opaque body.
   - New `describe('GET /public/units/:unitId/flyer - every public status (permanent-flyer-links D2)')`:
     - `it.each` over the six FLYER_PUBLIC statuses: a unit seeded with a
       `listing_link` of `https://example.com/listing` -> 200; the body's
       `flyer` has NO `status` key (`expect(body.flyer).not.toHaveProperty('status')`);
       `listing_link` is the stored link for `available` and `null` for each
       of the other five.
     - setup, soft-deleted (with status `occupied`), and missing -> 404, and
       the three bodies are deep-equal.
   Red because on_hold/occupied etc. 404 today.
2. GREEN in `public.ts`:
   - Import `FLYER_PUBLIC_STATUSES` beside `SHAREABLE_STATUSES` (~71). If
     `SHAREABLE_STATUSES` has no other use left in the file after T3, drop it
     from the import (lint would flag it).
   - Flyer route (~845): `!FLYER_PUBLIC_STATUSES.has(unit.status)`.
   - Build the payload so a non-Available unit carries `listing_link: null`:
     ```ts
     const flyer = toUnitFlyer(unit);
     // permanent-flyer-links D3a: no outside listing link once the home is not
     // Available - that page is likely to say the home is gone.
     const listing_link = unit.status === 'available' ? flyer.listing_link : null;
     res.json({ flyer: { ...flyer, listing_link, media, contact_number: contactNumber } });
     ```
     Do NOT change `toUnitFlyer` (`lib/unitFields.ts`); it has other callers.
   - Reword the route comment (~838-839, ~846) and `sendNotFound`'s comment
     (~450-453): 404 for missing, soft-deleted or setup; "no existence oracle"
     now means nothing beyond holding the id (spec D2); the fallback page (not
     "unavailable") offers the text-us CTA.
3. GREEN; commit `feat(public): the flyer serves every status but setup; no listing link off Available`.

### T3. Sign-up attribution and the pin's status suffix (D5, D6)

Files: `app/src/routes/public.ts`, `app/test/publicIntake.test.ts`,
`app/test/publicSignupLeads.test.ts`.

1. RED:
   - `publicIntake.test.ts`: `falls back to housing_fair when the unit exists but is NOT shareable`
     (~576, `status: 'placed'`) -> `status: 'setup'`, rename "NOT shareable"
     -> "in Setup". The ~919-920 and ~1186 `unit-placed` seeds
     (`status: 'placed'`) -> `status: 'setup'`; rename the id to
     `unit-setup` in those tests and update the test titles that say
     "non-shareable" -> "setup".
   - Add to the flyer-attribution describe: `it.each(['occupied','on_hold'])`
     a sign-up with that unit's id -> the created contact has
     `capture_source: 'flyer'` and `unit_of_interest: <unitId>`.
   - `publicSignupLeads.test.ts`: every `seedUnit(world, 'unit-placed', { status: 'placed' })`
     (~287, ~469, ~727, ~858, ~1048, ~1166) -> `'unit-setup', { status: 'setup' }`,
     with the matching `unitId` in the request bodies, the `it.each` row
     `['a placed property', 'unit-placed']` -> `['a setup property', 'unit-setup']`
     and `PIN_FORMS`' `'a flyer whose property is not shareable'` ->
     `'a flyer whose property is in Setup'`. The `skipped: 'not_shareable'`
     case keeps that value (spec D5: the stored name stays).
   - Add to `publicSignupLeads.test.ts` (next to the existing flyer pin
     label cases; reuse its `seedUnit`, `seedContact`, `signupBody` helpers
     and its label constants' address form):
     - occupied flyer -> pin label
       `Signed up from the flyer for <address> (Occupied) as <First Last>`, the
       pin's ref is the unit, and the properties-sent `flyer` entry is
       written (`sentRecorded: true` in the audit event, as the existing
       Available case asserts it).
     - on_hold flyer with NO address on the unit -> `Signed up from the flyer for <unitId> (On hold) as ...`.
     - occupied flyer for an opted-out contact -> the suffix comes before the
       opt-out note: `... (Occupied) as <name> (marked Do-Not-Contact - ...)`.
     - (PIN) Available label unchanged (the existing case covers it; keep it).
     - Two sign-ups within 24 hours from the same occupied flyer -> one pin
       (the repeat check now keys on that unit, R4).
   Red because occupied/on_hold are not `viaFlyer` today.
2. GREEN in `public.ts`:
   - `viaFlyer` (~515): `FLYER_PUBLIC_STATUSES.has(flyerUnit.status)`.
   - `signupPinLabel` (~198-211): after the address, when
     `args.flyerUnit.status !== 'available'`, append
     ` (${statusLabel})` where `statusLabel` is
     `LISTING_STATUS_LABELS[status as ListingStatus] ?? status` (import
     `LISTING_STATUS_LABELS`, `ListingStatus` from `../lib/statusModel.js`).
     The `viaFlyer` branch only runs for a FLYER_PUBLIC status, so the
     fallback never fires; keep it for type safety. Add one line to the
     function's doc comment: D6, the status suffix for a non-Available flyer.
   - Reword the comments that say shareable/not shareable in the sign-up
     path: header (~17-18, ~30-43, ~50-53), `HousingFairFields.unitId`
     (~218), ~150-157, ~276-279, ~382, ~501-506, ~512-514, ~590-593,
     ~603-607, ~676-681, ~749-752, ~787. "shareable" -> "public
     (FLYER_PUBLIC: every status but setup)"; "not shareable" -> "setup"
     where it means the unit status. Do not rename `SignupSentSkipped`'s
     `'not_shareable'` value; reword its comment where the type is declared
     (grep `not_shareable` in `app/src`) to "the flyer's unit is missing,
     deleted or not public (FLYER_PUBLIC)".
3. GREEN both files; `npm run typecheck`. Commit
   `feat(public): flyer sign-ups from every public status get full credit; the pin names a non-Available status`.

### T4. Dashboard `FLYER_PUBLIC` mirror (D7 prerequisite)

Files: `dashboard/src/api/types.ts`, `dashboard/src/api/statusModel.test.ts`.

1. RED: in `dashboard/src/api/statusModel.test.ts` add a case: `FLYER_PUBLIC`
   equals exactly the six statuses (sorted compare), has no `setup`, and
   `SHAREABLE` is still exactly `['available']`. Import from `./index.js`
   like the file's other imports (check `index.ts` re-exports `types.ts`;
   add the export there if it does not).
2. GREEN: in `types.ts` beside `SHAREABLE` (~935-936) add the mirror
   (`// MIRRORS app/src/lib/statusModel.ts FLYER_PUBLIC`), same six statuses.
   Reword the `SHAREABLE` comment to the broadcast meaning. Reword the
   `signed_up` timeline comment (~3048-3049: "a shareable flyer's pin carries
   refType 'unit'") to "a public flyer's pin".
3. Commit `feat(dashboard): FLYER_PUBLIC mirror`.

### T5. Flyer page: the neutral fallback stage (D4)

Files: `dashboard/src/routes/public/FlyerPage.tsx`,
`dashboard/src/routes/public/FlyerPage.test.tsx`,
`dashboard/src/routes/public/publicApi.ts` (comment only).

1. RED in `FlyerPage.test.tsx` (read its render helpers and the `getFlyer` /
   `submitHousingFair` mocks first):
   - Replace `unavailable (public variant) keeps the /join link` (~321) and
     `unavailable (known variant) offers the text-us CTA from the 404 body`
     (~335) and `(PIN) the unavailable state keeps its copy, with no highlight`
     (~659) with a `describe('FlyerPage - the fallback (permanent-flyer-links D4)')`:
     - form variant, 404: h1 `Find a home that fits your voucher`; the line
       `Sign up and we'll text you about homes that fit your voucher. Signing up does not book a tour.`;
       the IntakeForm with a `Sign up` button; no `/join` link.
     - No text anywhere on the page matches
       `/no longer available|taken|removed/i` - assert on
       `document.body.textContent` in every fallback case (both variants,
       with and without a contact number).
     - submitting sends `{ ...input, unitId: 'u1' }` (the route id), then
       shows h2 `Thanks - you're all set!` + `We'll text you about homes that fit your voucher.`,
       focused (`toHaveFocus()`); the h1 stays.
     - a route unitId with surrounding spaces is sent trimmed.
     - a route unitId of 201 characters (`'x'.repeat(201)`) submits with NO
       `unitId` key (`expect(arg).not.toHaveProperty('unitId')`); exactly 200
       characters still sends it.
     - a non-404 failure (getFlyer rejects with a 500 `ApiError`, and with a
       `TypeError` network error) renders the same fallback.
     - text variant with `contact_number` in the 404 body: the link
       `I'm looking for a home - text us` whose href is
       `sms:<number>?&body=` + encodeURIComponent(`I'm looking for a home that fits my voucher.`);
       no form.
     - text variant without a contact number: the line
       `Looking for a home? Reply to the text we sent you and we'll help you find one.`; no link, no form.
     - "Same-day tours available" does not render on the fallback (keeps the
       old PIN's no-highlight assertion).
   Red because the old stage renders "This home is no longer available".
2. GREEN in `FlyerPage.tsx`:
   - `Stage`: replace `{ kind: 'unavailable'; contactNumber }` with
     `{ kind: 'fallback'; contactNumber: string | null }`; update both
     `setStage` calls and the catch comment (~241-242).
   - Delete `UNAVAILABLE_PREFILL`; add
     `const FALLBACK_PREFILL = "I'm looking for a home that fits my voucher.";`
   - Add a module constant with a citation:
     ```ts
     /** The server's unitId cap (app/src/routes/public.ts:124 MAX_UNIT_ID_LEN,
      *  checked at :279-286 after the app-wide body trim). The fallback sends
      *  the route id only when it passes, so its one button can always succeed. */
     const MAX_UNIT_ID_LEN = 200;
     ```
   - A fallback submit handler (separate from `handleIntakeSubmit`, which
     returns early when `unitId` is undefined and must keep doing so for the
     served flyer):
     ```ts
     async function handleFallbackSubmit(input: Omit<HousingFairInput, 'unitId'>): Promise<void> {
       const id = unitId?.trim() ?? '';
       await submitHousingFair(id.length >= 1 && id.length <= MAX_UNIT_ID_LEN ? { ...input, unitId: id } : input);
       setSubmitted(true);
     }
     ```
   - Replace the `unavailable` render block with the fallback per D4: one
     `section.card`; h1 `Find a home that fits your voucher` (class
     `styles.title`); then by variant:
     - text: contact number -> `a.linkButton` to
       `smsHref(stage.contactNumber, FALLBACK_PREFILL)` reading
       `I&apos;m looking for a home - text us`; else the muted line above.
     - form, not submitted: the muted line, then
       `<IntakeForm onSubmit={handleFallbackSubmit} submitLabel="Sign up" />`.
     - form, submitted: h2 (`ref={headingRef} tabIndex={-1}`) `Thanks - you&apos;re all set!`
       and the muted `We&apos;ll text you about homes that fit your voucher.`
     No "See other homes" link. Reuse existing CSS classes; no CSS change.
   - Header comment (~14-15): "The unavailable state" -> "The fallback
     (missing, deleted, setup or any failure) is a neutral sign-up page and
     is variant-aware too"; line 1-2 "for one shareable unit" -> "for one
     public unit (every status but Setup)".
   - `publicApi.ts` header (~5-7): the 404 is for missing, deleted or setup,
     and the page maps any failure to a neutral sign-up page.
3. GREEN the file; then run the whole dashboard FlyerPage suite and
   `IntakeForm` tests. Commit `feat(flyer): a neutral sign-up page replaces "no longer available"`.

### T6. Property page flyer line (D7)

Files: `dashboard/src/routes/listing/ListingDetail.tsx`,
`dashboard/src/routes/listing/ListingDetail.test.tsx`.

1. RED in `ListingDetail.test.tsx` (extend the existing flyer cases ~240-260):
   - available and occupied: `View flyer` link (href `/p/u1`) and
     `Copy public link` button.
   - setup: `The public flyer goes live once this property leaves Setup.`;
     no View flyer link.
   - deleted (status available, `deleted_at` set): `The public flyer is off while this property is deleted.`
   - deleted + setup: the deleted note wins.
   - an unknown stored status (`status: 'placed'` cast): `The public flyer is off for this property.`
   - The old text `goes live when this property is Available` appears nowhere.
2. GREEN in `ListingDetail.tsx`:
   - Move `const deleted = ...` (~434) above the flyer logic (~418) - check
     nothing between them depends on the order.
   - Replace `flyerShareable` with
     ```ts
     // permanent-flyer-links D7: the flyer serves every status but Setup
     // (FLYER_PUBLIC, mirrors the server) and never a deleted property.
     const flyerPublic = !deleted && (FLYER_PUBLIC as ReadonlySet<string>).has(unit.status);
     const flyerNote = deleted
       ? 'The public flyer is off while this property is deleted.'
       : unit.status === 'setup'
         ? 'The public flyer goes live once this property leaves Setup.'
         : 'The public flyer is off for this property.';
     ```
     and render `flyerNote` in the `flyerNote` span. Import `FLYER_PUBLIC`
     from where the file imports its other status-model names.
   - Reword the comments at ~82-83 (STATUS_TONE: "the one
     publicly-shareable status" -> "the one sendable status"), ~416-417 and
     ~937-938.
3. Commit `feat(listing): the property page offers the flyer for every status but Setup`.

### T7. Broadcast staff copy (D8; the guard is unchanged)

Files: `dashboard/src/routes/broadcasts/BroadcastComposer.tsx`,
`dashboard/src/routes/broadcasts/RecipientPreview.tsx`, their `.test.tsx`
files, `app/src/routes/broadcasts.ts` (comment), `app/test/broadcastApi.test.ts`
(title), `e2e/tests/dashboard-next/broadcasts.spec.ts` (T9 runs it).

1. RED - update the pins to the new strings first:
   - `BroadcastComposer.test.tsx` ~576-592 and ~1764: `/flyer link won't work/`
     -> `/Only Available properties can be sent/`; the full note for an
     On hold property reads
     `This property is On hold. Only Available properties can be sent - you'll be asked to make it Available when you send.`
   - `RecipientPreview.test.tsx`: the `unit_not_available` 400 alert reads
     `This property isn't Available. Only Available properties can be sent - make it Available, then send.`;
     the dialog `Property isn't Available` body reads
     `Only Available properties can be sent. Its status is currently <status>.`
     (find the existing dialog cases ~737-824 and add the body assertion if
     none exists).
   - Assert `flyer link` appears in none of the three.
2. GREEN - change exactly these strings (spec D8):
   - `BroadcastComposer.tsx` ~546-548: `..., so its flyer link won't work. You'll be asked ...`
     -> `<strong>{label}</strong>. Only Available properties can be sent - you'll be asked to make it Available when you send.`
     (keep the `<strong>` status). Comment ~540-542 -> "Only Available
     properties can be sent (a send says the home is open to apply for
     now). Warn EARLY ...".
   - `RecipientPreview.tsx` ~419: the setError string above; ~756-759: the
     modal body `Only Available properties can be sent. Its status is currently <strong>...</strong>.`
     Reword its comments ~87-89 and ~375-377 if they say the link is dead.
   - `app/src/routes/broadcasts.ts` ~1181-1186: comment only - "a send says
     the home is open to apply for now, so only SHAREABLE ('available')
     units can be sent; the public flyer itself serves more (FLYER_PUBLIC)".
     The `if` line does not change.
   - `app/test/broadcastApi.test.ts` ~2162 title: `refuses to send when the unit is not available (only Available properties can be sent)`.
3. Commit `fix(broadcasts): staff copy says only Available properties can be sent`.

### T8. Docs and comment sweep (spec section 4) - docs-only

1. Edit the known sites:
   - `documentation/STATUS-MODEL.md` ~308-309: Setup "not yet public";
     Available "the only status a property can be sent in (broadcasts)";
     add: every status but Setup serves the public flyer (FLYER_PUBLIC).
   - `documentation/GLOSSARY.md` ~73 ("The shareable flyer") -> "The public
     flyer"; ~657-673 ("flyer share entry", "signed up"): "shareable
     property" -> "public property (every status but Setup)", and the pin's
     ` (<Status>)` suffix for a non-Available home (D6).
   - `e2e/support/selectors.md` ~54 (sign-up pin row): add the status
     suffix form and change "not shareable" -> "in Setup, deleted or made up".
   - `docs/issues/public-signup-abuse-hardening.md` items (c), (d), the
     roster-scan note and the other "shareable" mentions (~63, ~126, ~132,
     ~145, ~213, ~243): "shareable" -> "public (every status but Setup)",
     citing the spec (D5); state that old Matching and broadcast links now
     reach these paths. Do not change its status or severity.
   - Code comments: `app/src/routes/units.ts` ~982-983;
     `app/src/repos/activityEventsRepo.ts` ~74;
     `dashboard/src/ui/StatusBadge.tsx` ~46;
     `app/src/lib/import/apply.ts` ~1622; `e2e/support/steps.ts` ~1033;
     `app/src/lib/seed/lean.ts` ~211 ("only 'available' is shareable, sec 6")
     -> "every status but setup serves the public flyer; only 'available'
     can be sent".
2. Sweep: `git grep -n -i -E "shareable|no longer available|flyer link"` over
   `app/src dashboard/src e2e documentation docs/issues` (exclude
   `docs/superpowers/` - dated history). Fix every hit that states the old
   rule. Leave: the `SHAREABLE` / `SHAREABLE_STATUSES` identifiers, the
   `'not_shareable'` value, dated history docs, and anything about
   broadcasts that is still true. Record what you left and why in the commit
   body.
3. Commit `docs: the public flyer serves every status but Setup`.

### T9. e2e (spec section 5)

Each NEW test creates its own run-unique property through the API; seeded
units are shared and must not change status. Read `e2e/support/selectors.md`
and the helpers named below before writing.

1. `e2e/tests/dashboard-next/public-pages.spec.ts`:
   - Rename `NON_SHAREABLE_UNIT` (~57) to `UNDER_APPLICATION_UNIT`, comment
     "seeded `under_application` -> serves the full flyer (read-only here)".
   - Rewrite `unavailable: a bogus id and a non-shareable unit stay opaque ...`
     (~522) as `fallback: a bogus id and a setup property show the neutral sign-up page; an under_application property serves its flyer`:
     (a) bogus id bare -> h1 `Find a home that fits your voucher`, the
     `Sign up` button visible; (b) bogus id `?cta=text` in a fresh context
     -> the same h1 and a `text us` link with an `sms:` href (never click
     it); (c) a fresh Setup property
     (`createUnitViaApi(staff.request, stamp, { available: false })` from
     `e2e/support/followUpFixtures.ts:48`) -> the same fallback;
     (d) `UNDER_APPLICATION_UNIT` -> the `Sign up for home alerts` heading
     and its address heading; (e) in every case
     `page.getByText(/no longer available/i)` has count 0. No sign-in
     redirect (keep the existing `Sign in with Google` count-0 check).
2. `e2e/tests/dashboard-next/listing-photos.spec.ts` (~326-338): after the
   flip to On hold, `/p/<id>` still shows `Home photo 1` with loaded bytes
   (reuse `expectLoadedBytes`) and the flyer API answers 200 with media.
   Update the comment above it.
3. `e2e/tests/dashboard-next/environment-identity.spec.ts:44`: the `/p/...`
   branch expects h1 `Find a home that fits your voucher`.
4. `e2e/tests/dashboard-next/broadcasts.spec.ts` ~283: expect
   `/Only Available properties can be sent/` instead of
   `/its flyer link won't work/`; the comment above it ("NOT shareable, so
   the flyer link is dead") -> "not Available, so it cannot be sent".
5. New test in `e2e/tests/dashboard-next/flyer-leads.spec.ts` (reuse its
   `createAvailableUnit`, `openVisitor`, `fillSignUp`, `contactIdByPhone`,
   `signedUpPins`, `sentOutcome`, `expectWholePinLabelVisible`, and the pin
   label form at ~530): `a sign-up from an Occupied property's flyer: full
   credit and the pin names the status` - create an available unit, PATCH
   `/api/units/<id>/listing-status` `{ toStatus: 'occupied', source: 'manual' }`
   (as listing-photos.spec.ts does for on_hold), sign up a run-unique NEW
   contact from `/p/<id>`, then assert: the contact page pin link
   `Signed up from the flyer for <line1>, <CITY_LINE> (Occupied) as <First Last>`
   (exact); `sentOutcome` is `signed_up`; the contact's
   `capture_source` is `flyer` and `unit_of_interest` is the unit.
6. Do not run e2e per task; T10 runs the suite. While iterating you may use
   an `e2e:session` lane from this worktree only (AGENTS.md); never run a
   lane and the full suite together.
7. Commit `test(e2e): permanent flyer links - fallback, non-Available flyers and the status pin`.

### T10. Gates and handback prep

From `W:\tmp\permanent-flyer-links`, each bare, unpiped, real exit code:

1. `npm run typecheck`
2. `npm test` (DynamoDB Local up: `npm run db:start`; check `env | grep '^AWS_'`
   first - see AGENTS.md)
3. `npm run smoke`
4. `npm run e2e`
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`
   - attribute any error by a baseline run at the merge base.

Sync `main` into the branch once, before these final gates (AGENTS.md). Then
self-QA with the Playwright MCP on an `e2e:session` lane: an Occupied
property's flyer (photos, address, Sign up for home alerts, no Listing row),
a bogus id (the fallback in both variants), a sign-up from the fallback and
from the Occupied flyer (the pin on the contact page), and the property
page's flyer line for Available / Occupied / Setup / deleted. Screenshots go
under `.playwright-mcp/`.

## 3. Watch items

- WI1 The flyer route must not change `toUnitFlyer`; `listing_link` is
  nulled in the route only (T2).
- WI2 `handleIntakeSubmit` on a SERVED flyer is unchanged; only the fallback
  trims and length-checks the id (T5).
- WI3 The `'not_shareable'` audit value keeps its name - it is in stored
  audit events (D5).
- WI4 The broadcast guard and `SHAREABLE_STATUSES` keep governing sends;
  T7 changes copy and comments only. A test that a non-Available unit is
  still refused at send (`broadcastApi.test.ts` ~2162) must stay green with
  only its title changed.
- WI5 Existing tests that asserted on_hold -> 404 (T2) flip to 200 by
  design; a test that asserts the OLD rule anywhere else is a missed site -
  grep the test trees for `on_hold` / `occupied` near `flyer` before T10.
- WI6 Setup is not a take-down (D1): no copy, doc or comment may say "set
  it to Setup to hide the flyer".
- WI7 e2e: never change a seeded unit's status; `unit-0001` is read-only.
- WI8 No status word on any public page (D3): the fallback and the served
  flyer never print a status.
