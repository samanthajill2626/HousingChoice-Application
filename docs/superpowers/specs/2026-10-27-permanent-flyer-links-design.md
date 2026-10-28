# Permanent flyer links - design

Status: APPROVED revision 4 (2026-10-28). Rev 3 passed the spec gate
(2026-10-27) - Cameron: "I think the spec probably looks good." No new off
switch ("We don't need to turn this off"), and the properties-sent row keeps
its buttons on non-Available homes ("Might cause confusion if the property
wasn't properly moved into the right status").
Next: the plan (docs/superpowers/plans/2026-10-27-permanent-flyer-links-plan.md).
- Rev 4 (2026-10-28) corrects D2's premise only: the import namespace is in
  the public repository, so an imported property's unitId is computable from
  its address (code review R2-1). Cameron accepted the true premise (Q1,
  option c); no behavior change.
- Rev 3 folds in round 2 (the continued reviewer): 4 findings, all accepted as
  precision edits (the Setup take-down claim withdrawn, the fallback's unitId
  rule trimmed, missed test and comment sites). Round 2 changed no decision,
  so it is the terminal round.
- Rev 2 folds in design review round 1: two reviewers, 23 findings merged to
  15 items: 9 accepted, 2 settled by Cameron's answer (D3, D3a), 3 accepted
  as wording or a stated consequence, 1 deferred to an issue.

Adjudications:
`docs/superpowers/reviews/2026-10-27-permanent-flyer-links/design-review/adjudications.md`.
Branch: `feat/permanent-flyer-links` (worktree `W:\tmp\permanent-flyer-links`,
cut from main @d0e2c2d8).
Review records: `docs/superpowers/reviews/2026-10-27-permanent-flyer-links/`.
intent.md there holds Cameron's decisions verbatim.

Source: Sam's email to Cameron, 2026-10-27, asking for "all links forever live
on even if a property is no longer available", as a marketing method, and for
visitors to "not see the 'this is no longer available'". Cameron accepted, on
Sam's behalf, that an occupied home's flyer keeps showing its street address,
Maps link and photos.

Vocabulary (documentation/GLOSSARY.md): the dwelling is a `unit` in code, a
"home" on the public flyer, a "property" in the dashboard. "Flyer" = the public,
unauthenticated page `/p/:unitId` (`dashboard/src/routes/public/FlyerPage.tsx`)
and its API `GET /public/units/:unitId/flyer` (`app/src/routes/public.ts`).
"Text variant" = the flyer opened with `?cta=text` (tap-to-text CTA, no form);
"form variant" = the bare link (the "Sign up for home alerts" form).
"Non-Available" below means a status in FLYER_PUBLIC other than `available`.

## 1. Goal

1. A flyer link keeps working after its property stops being Available. A
   visitor sees the flyer and the same sign-up (or text-us) CTA they would have
   seen while it was Available (one difference: D3a).
2. No page WE serve says a home is "no longer available", taken or removed, and
   the flyer does not link out to the external listing of a non-Available home
   (D3a). External sites are outside our control.
3. A sign-up from such a flyer is credited to that home exactly like a sign-up
   from an Available flyer, and staff see the home's status in the lead's pin.

## 2. Today (verified 2026-10-27; both round-1 reviewers re-verified every claim)

- `SHAREABLE` = `{'available'}` (`app/src/lib/statusModel.ts:289`), re-exported
  as `SHAREABLE_STATUSES` (`app/src/repos/unitsRepo.ts:64`). Listing statuses:
  setup, available, under_application, finalizing, occupied, on_hold,
  off_market (`statusModel.ts:261-269`). A manual listing-status transition
  accepts any listing status from any status
  (`app/src/routes/statusTransition.ts:346-361`).
- Readers of that gate:
  - Flyer API: 404 `{ error: 'not_found', contact_number }` for a missing,
    soft-deleted or non-SHAREABLE unit (`public.ts:842-849`, `sendNotFound`
    ~`public.ts:450-455`). One identical body for all three.
  - Sign-up attribution (`POST /public/housing-fair`): `viaFlyer` is true only
    for a present, non-deleted, SHAREABLE unit (`public.ts:507-518`). It drives
    `capture_source` 'flyer' vs 'housing_fair' and `unit_of_interest`
    (`public.ts:609-610`), the pin label (`signupPinLabel`, `public.ts:198-211`),
    the pin's repeat-check source (`public.ts:692`), and the properties-sent
    ledger entry (`sentSkipped 'not_shareable'`, `public.ts:762-777`).
  - Broadcast send guard: 400 `unit_not_available` (`broadcasts.ts:1181-1193`),
    and its staff copy: the composer's early note "...so its flyer link won't
    work" (`BroadcastComposer.tsx:540-549`), the 400 error text
    (`RecipientPreview.tsx:416-419`) and the make-available modal body "The
    flyer link in this send only works while the property is Available"
    (`RecipientPreview.tsx:756-759`).
  - Dashboard property page: "View flyer" + "Copy public link" only when
    `unit.status === 'available'`, else "The public flyer goes live when this
    property is Available." (`ListingDetail.tsx:416-418`, `:937-958`). It does
    not check soft-delete.
  - Broadcast composer lists only Available units (`BroadcastComposer.tsx:376`).
  - Dashboard mirror constant `SHAREABLE` (`dashboard/src/api/types.ts:935-936`),
    no runtime reader.
- Flyer page: any fetch failure -> the `unavailable` stage: heading "This home
  is no longer available", "The home you're looking for has been taken or
  removed.", then per variant a "See other homes" link to `/join` (form) or an
  sms link prefilled "The home I was looking at is no longer available - I'm
  interested in similar homes." (text) (`FlyerPage.tsx:45-46`, `:264-294`).
- The flyer renders the payload's `listing_link` as "Listing - See the full
  listing" (`unitFields.ts:500`, `FlyerPage.tsx:398-406`).
- Unit photos (`/unit-media/<unitId>/<object>`, `app/src/routes/unitMediaServe.ts`)
  are not status-gated.
- `POST /public/housing-fair` refuses a `unitId` that is not a 1..MAX_UNIT_ID_LEN
  character string with the generic 400 (`public.ts:279-286`).

## 3. Decisions

### D1. Two gates, not one

Add to `app/src/lib/statusModel.ts` a second set, `FLYER_PUBLIC`: every
listing status except `setup`, written as an explicit list of the six
(available, under_application, finalizing, occupied, on_hold, off_market), so a
future status is not public until someone adds it. A stored status outside
LISTING_STATUSES is not public. Re-export it from `unitsRepo.ts` beside
`SHAREABLE_STATUSES` as `FLYER_PUBLIC_STATUSES`.

- `FLYER_PUBLIC` governs the public flyer and everything a flyer sign-up does.
- `SHAREABLE` stays `{'available'}` and keeps governing broadcasts only. Its
  doc comments (`statusModel.ts:285-288`, `unitsRepo.ts:51-56`, `:63`) are
  reworded to "the only status a property can be SENT in (broadcasts); the
  public flyer uses FLYER_PUBLIC".

The gate is on the CURRENT status (Cameron, 2026-10-27, chose "All but Setup"
from an option that listed all six by name). Accepted consequences, stated so
nobody mistakes them for bugs:
- A property moved from Setup straight to On hold or Off market is served even
  though it was never Available.
- An Off market property (often a landlord who withdrew the home) is served
  forever.
- The only durable way to take a flyer down is to delete the property
  (soft-delete, restorable - `units.ts` ~2501). Setting Setup hides it only
  until the next placement event: Setup is a baseline status that derivation
  overwrites (`statusModel.ts:321-337`; a placement create or stage move
  re-derives, and a lost placement with no other active one derives
  `available`). So Setup is NOT offered or documented as a take-down, and no
  new off switch is built (Sam wants links to live forever).

### D2. Flyer API

`GET /public/units/:unitId/flyer` serves the flyer (`toUnitFlyer(unit)` +
resolved `media` + `contact_number`) when the unit is present, not
soft-deleted, and its status is in `FLYER_PUBLIC`. Missing, soft-deleted and
setup units keep the one opaque 404, body unchanged.

- The payload gains NO status field.
- D3a: for a non-Available unit the route sets `listing_link` to `null` in the
  payload. (Its absence is a weak hint that a home is not Available; accepted.)
- What the API tells the public: the 404 is one opaque body for every cause,
  and a 200 tells the holder of an id that its property is public. Imported
  unitIds are derived from the address with a fixed namespace
  (`app/src/lib/import/ids.ts:24`, `:84-86`) that is in the PUBLIC GitHub
  repository (code review R2-1, 2026-10-28; rev 3's "private repository only"
  was false). So anyone who knows an imported property's address can compute
  its id and get its flyer in every status but Setup - including Airtable
  "Placed" homes imported as Occupied, which go live with the deploy.
  Cameron (2026-10-28, Q1 option c): "Imported properties can have their
  links stay available. We don't need to update those, I understand they'll
  go live with a deploy. i'm not sure which option that is, i believe it
  would be C." Accepted.

### D3. Flyer page - a served flyer

A served flyer renders exactly as an Available one does today, whatever the
status: photos, address heading, area, "Same-day tours available" (kept on
every flyer - Sam's marketing line, Cameron 2026-10-27), facts, details
(Same-day RTA included), and the variant's CTA. No status badge, banner or
wording. The page has no status input.

### D3a. No external listing link on a non-Available flyer

Cameron, 2026-10-27: drop the "See the full listing" link when the home is not
Available, because that outside page is likely to say it is gone. Delivered by
D2's `listing_link: null`; the page already hides the row when the link is
null (`safeHttpUrl`), so FlyerPage needs no change for it. The video tour link
stays.

### D4. Flyer page - the fallback (missing, deleted, setup, or any fetch failure)

Replace the `unavailable` stage with a neutral `fallback` stage. It never says
"no longer available", "taken" or "removed". All three 404 causes and any other
fetch failure (5xx, network, 429) render it identically.

- Form variant: heading "Find a home that fits your voucher"; line "Sign up and
  we'll text you about homes that fit your voucher. Signing up does not book a
  tour."; then the same `IntakeForm` (submit label "Sign up") inline. On
  success: heading "Thanks - you're all set!" and "We'll text you about homes
  that fit your voucher." (focus moves to the heading, as on the flyer today).
- The fallback's sign-up sends the route's `unitId` when, after trimming, it
  is 1 to 200 characters (the server's own check, `MAX_UNIT_ID_LEN`,
  `public.ts:124` and `:279-286`, applied after the app-wide body trim,
  `app.ts:146`), and no `unitId` otherwise, so the page's one button can always
  succeed. The dashboard holds its own copy of 200 with a comment citing
  `public.ts:124`. With a unitId, the server decides: missing / deleted / setup
  -> the no-property flyer sign-up (D5). Without one (only a malformed link
  gets here) the sign-up is a /join-style lead: it starts 'onboarding' and its
  pin reads "Signed up on the join page as <name>" (`public.ts:207`, `:596`).
  Accepted. Accepted consequence: when the fallback came from a
  transient failure on a PUBLIC unit, the sign-up is fully credited to that
  home although the visitor never saw it - they did follow its link.
- Text variant: heading "Find a home that fits your voucher"; with the 404
  body's `contact_number`, a tap-to-text link "I'm looking for a home - text
  us" prefilled "I'm looking for a home that fits my voucher."; without it,
  "Looking for a home? Reply to the text we sent you and we'll help you find
  one."
- The "See other homes" link and `UNAVAILABLE_PREFILL` are removed.

### D5. Sign-up attribution

`viaFlyer` (`public.ts:515`) becomes: unit present, not soft-deleted, status in
`FLYER_PUBLIC`. Everything `viaFlyer` drives follows: capture source, unit of
interest, pin source for the 24-hour repeat check, and the properties-sent
`flyer` entry (with its current-decline rule). A sign-up from an Occupied
home's flyer is credited exactly like one from an Available flyer (Cameron,
2026-10-27). Missing, deleted and setup units keep today's no-property behavior
(`Signed up from a flyer as <name>`, `sentSkipped 'not_shareable'`).

The `SignupSentSkipped` value `'not_shareable'` keeps its name (it is written
into stored audit events); its comment is reworded to "the flyer's unit is
missing, deleted or not public (FLYER_PUBLIC)".

Reach widens, and the spec says so: every non-setup unitId - including the ids
in every old Matching and broadcast text - becomes a live 24-hour pin source
and properties-sent rewrite target, where today only Available ids are. The
open issue `docs/issues/public-signup-abuse-hardening.md` (items (c), (d), and
the roster-scan note) is updated in the same change to say "public (every
status but Setup)" where it says "shareable", with this spec cited.

### D6. Pin label names a non-Available status

`signupPinLabel` adds the property's status label in parentheses after the
address when `viaFlyer` and the status is not `available`:

- `Signed up from the flyer for 12 Main St, Springfield, IL 62701 (Occupied) as Jane Doe`
- Available unchanged: `Signed up from the flyer for 12 Main St, Springfield, IL 62701 as Jane Doe`
- with no address: `Signed up from the flyer for <unitId> (On hold) as ...`
- the opt-out note still ends the label.

The text is `LISTING_STATUS_LABELS[status]` (`statusModel.ts:275-283`) at
sign-up time, stored in the pin like the rest of the label.

### D7. Dashboard property page

The flyer line (`ListingDetail.tsx` ~937-958) shows "View flyer" + "Copy public
link" when the property is not deleted and its status is in the dashboard's
mirror of `FLYER_PUBLIC`. Otherwise one note, first match wins:

1. Deleted (any status): "The public flyer is off while this property is deleted."
2. Setup: "The public flyer goes live once this property leaves Setup."
3. Any other (an unknown stored status): "The public flyer is off for this property."

`deleted` must be computed before the flyer check (today it is computed after
`flyerShareable`, `ListingDetail.tsx:418` vs `:434`). Add a `FLYER_PUBLIC`
mirror beside `SHAREABLE` in `dashboard/src/api/types.ts` and reword the
`SHAREABLE` mirror's comment as in D1.

### D8. Broadcast staff copy (the guard itself is unchanged)

The send guard, the composer's Available-only unit list and the make-available
modal's flow stay. Only the reason they give changes, because "the flyer link
won't work" is no longer true:

- Composer note (`BroadcastComposer.tsx:540-549`): "This property is
  <status>. Only Available properties can be sent - you'll be asked to make it
  Available when you send."
- 400 text (`RecipientPreview.tsx:419`): "This property isn't Available. Only
  Available properties can be sent - make it Available, then send."
- Modal body (`RecipientPreview.tsx:756-759`): "Only Available properties can
  be sent. Its status is currently <status>."
- The code comments that say the link is dead (`BroadcastComposer.tsx:540-542`,
  `broadcasts.ts:1181-1186`) are reworded to: a send means the home is open to
  apply for now.

Existing tests pinning the old strings are updated with them.

### D9. Unchanged

- The opaque 404 body, the rate limits, the `/join` page, the `IntakeForm`,
  the consent gate, the welcome text and every other sign-up step.
- `/unit-media` serving.
- Sign-ups that carry no `unitId`.
- The properties-sent row on the contact card and the property's Sent to card:
  no status is added there, and the row's Interested action keeps working on a
  non-Available home (it already does for a home that left Available after a
  send). Filed: `docs/issues/sent-row-interested-ignores-listing-status.md`.

## 4. Docs and comments

Every doc or code comment that says Available gates the public flyer, or that
a non-Available flyer link is dead, is updated. Known sites (the builder greps
for more: `shareable`, `SHAREABLE`, `no longer available`, `flyer link`):

- `documentation/STATUS-MODEL.md:308-309`: Setup "not yet public"; Available
  "the only status a property can be sent in (broadcasts)"; every status but
  Setup serves the public flyer.
- `documentation/GLOSSARY.md` ~657-673 ("flyer share entry", "signed up"):
  "shareable property" -> "public property (every status but Setup)"; the pin
  label's status suffix (D6). AGENTS.md requires GLOSSARY in the same change.
- `e2e/support/selectors.md` ~54 (sign-up pin row): the status suffix, and
  "not shareable" -> "not public".
- `docs/issues/public-signup-abuse-hardening.md` (D5).
- Code: `statusModel.ts:285-288`; `unitsRepo.ts:51-56`, `:63`; `public.ts`
  header (17-18, 30-43, 50-53), `:150-157`, `:218`, `:276-279`, `:382`,
  `:450-453`, `:501-506`, `:512-514`, `:590-593`, `:603-607`, `:676-681`,
  `:749-752`, `:787`, `:838-839`, `:846`; `broadcasts.ts:1181-1186`;
  `units.ts` ~982-983; `dashboard/src/routes/public/publicApi.ts:5-7`;
  `FlyerPage.tsx` header (14-15) and `:241-242`; `ListingDetail.tsx:416-417`,
  `:937-938`, `:82-83`; `RecipientPreview.tsx:87-89`, `:375-377`;
  `activityEventsRepo.ts:74`; `dashboard/src/api/types.ts:3048-3049`;
  `StatusBadge.tsx:46`; `app/src/lib/import/apply.ts:1622`;
  `e2e/support/steps.ts:1033`; `documentation/GLOSSARY.md:73`;
  `app/src/lib/seed/lean.ts` ~211.

## 5. Tests

- App:
  - Flyer API serves each of the six FLYER_PUBLIC statuses and 404s for setup,
    deleted and missing with the identical body; the payload has no status key;
    `listing_link` is the stored link for Available and null for each other
    public status.
  - Sign-up from an Occupied and an On hold flyer: capture source 'flyer', unit
    of interest, pin label with "(Occupied)" / "(On hold)", properties-sent
    entry written. Setup and deleted keep the no-property path. Available pin
    label unchanged.
  - Existing tests that use the non-listing status `'placed'` as the "not
    shareable" case (`publicIntake.test.ts`, `publicSignupLeads.test.ts`, and
    any other the builder finds) are pointed at `'setup'`, so the boundary is
    really tested.
  - A parity test that `FLYER_PUBLIC` equals exactly the six statuses.
- Dashboard:
  - `FlyerPage.test.tsx`: the fallback in both variants, with and without a
    contact number (no "no longer available", "taken" or "removed" text
    anywhere; inline form submits with the unitId; an over-long unitId submits
    without one; thank-you state; sms prefill).
  - `ListingDetail.test.tsx`: the flyer line for available, occupied, setup,
    deleted, and deleted + setup.
  - Broadcast tests pinning the D8 strings (and the `broadcastApi.test.ts`
    ~2162 test title that states the retired reason).
  - A parity test that the dashboard `FLYER_PUBLIC` mirror equals the same six
    statuses.
- e2e (each new test creates its own run-unique property through the API; the
  seeded units are shared by other specs and must not change status):
  - `public-pages.spec.ts` "unavailable" test becomes a fallback test: bogus id
    in both variants, plus a Setup property; no "no longer available" anywhere.
    The seeded `under_application` unit (`NON_SHAREABLE_UNIT`, line 57) is
    renamed and asserted to serve the full flyer, read-only.
  - `listing-photos.spec.ts` (~326-338): after the flip to On hold the flyer
    still shows its photos and the API answers 200.
  - `environment-identity.spec.ts:44` (`/p/missing-unit`): asserts the
    fallback heading instead of "no longer available".
  - `broadcasts.spec.ts` ~283: asserts the D8 composer note instead of "its
    flyer link won't work".
  - One sign-up from a run-unique Occupied property's flyer asserts the pin
    "Signed up from the flyer for <address> (Occupied) as <name>" on the
    contact page.

## 6. Non-goals

- Broadcasting a non-Available property.
- Any status wording on the public page.
- Status on the properties-sent rows, or a status check on their Interested
  action (filed, D9).
- Search-engine indexing rules for flyers.
- Tightening public sign-up abuse limits (the open issue, D5).
- A multi-unit "building" layer.
