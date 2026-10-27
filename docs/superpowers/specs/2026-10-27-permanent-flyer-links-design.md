# Permanent flyer links - design

Status: DRAFT revision 1 (2026-10-27), before design review.

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

## 1. Goal

1. A flyer link keeps working after its property stops being Available. A
   visitor sees the same full flyer and the same sign-up (or text-us) CTA they
   would have seen while it was Available.
2. No public page says a home is "no longer available", taken or removed.
3. A sign-up from such a flyer is credited to that home exactly like a sign-up
   from an Available flyer, and staff can see the home's status in the lead's
   pin.

## 2. Today (verified 2026-10-27)

- `SHAREABLE` = `{'available'}` (`app/src/lib/statusModel.ts:289`), re-exported
  as `SHAREABLE_STATUSES` (`app/src/repos/unitsRepo.ts:64`). Listing statuses:
  setup, available, under_application, finalizing, occupied, on_hold,
  off_market (`statusModel.ts:261-269`).
- Readers of that gate:
  - Flyer API: 404 `{ error: 'not_found', contact_number }` for a missing,
    soft-deleted or non-SHAREABLE unit (`public.ts:842-849`, `sendNotFound`
    ~`public.ts:450-455`). One identical body for all three (no existence
    oracle).
  - Sign-up attribution (`POST /public/housing-fair`): `viaFlyer` is true only
    for a present, non-deleted, SHAREABLE unit (`public.ts:507-518`). It drives
    `capture_source` 'flyer' vs 'housing_fair' and `unit_of_interest`
    (`public.ts:609-610`), the pin label (`signupPinLabel`, `public.ts:198-211`),
    the pin's repeat-check source (`public.ts:692`), and the properties-sent
    ledger entry (`sentSkipped 'not_shareable'`, `public.ts:762-777`).
  - Broadcast send guard: 400 `unit_not_available` (`broadcasts.ts:1181-1193`).
  - Dashboard property page: "View flyer" + "Copy public link" only when
    `unit.status === 'available'`, else "The public flyer goes live when this
    property is Available." (`ListingDetail.tsx:416-418`, `:937-958`). It does
    not check soft-delete.
  - Broadcast composer lists only Available units
    (`BroadcastComposer.tsx:376`).
  - Dashboard mirror constant `SHAREABLE` (`dashboard/src/api/types.ts:935-936`),
    no runtime reader found.
- Flyer page: any fetch failure -> the `unavailable` stage: heading "This home
  is no longer available", "The home you're looking for has been taken or
  removed.", then per variant a "See other homes" link to `/join` (form) or an
  sms link prefilled "The home I was looking at is no longer available - I'm
  interested in similar homes." (text) (`FlyerPage.tsx:45-46`, `:264-294`).
- Unit photos (`/unit-media/<unitId>/<object>`, `app/src/routes/unitMediaServe.ts`)
  are not status-gated; the flyer payload's `media` already resolves for any
  status.

## 3. Decisions

### D1. Two gates, not one

Add to `app/src/lib/statusModel.ts` a second set, `FLYER_PUBLIC`: every
listing status except `setup`. It is re-exported from `unitsRepo.ts` beside
`SHAREABLE_STATUSES` as `FLYER_PUBLIC_STATUSES`.

- `FLYER_PUBLIC` governs the public flyer and everything a flyer sign-up does.
- `SHAREABLE` stays `{'available'}` and keeps governing broadcasts only (the
  send guard and the composer's unit list). Its doc comment is reworded from
  "the only publicly-shareable status (gates the public flyer)" to "the only
  status a property can be SENT in (broadcasts); the public flyer uses
  FLYER_PUBLIC".
- Defined as an explicit list of the six statuses, not as "all minus setup",
  so a future status is a deliberate choice (a new status is not public until
  someone adds it).

Setup is excluded because it is the only pre-launch status: details may be
half-entered and the landlord may not be signed on yet (Cameron, 2026-10-27).

### D2. Flyer API

`GET /public/units/:unitId/flyer` serves the full flyer (the same
`toUnitFlyer(unit)` + resolved `media` + `contact_number`) when the unit is
present, not soft-deleted, and its status is in `FLYER_PUBLIC`. Missing,
soft-deleted and setup units keep the one opaque 404, body unchanged.

- The payload gains NO status field. The public never learns a home's status
  from the API, and the page has nothing to render it from.
- Nothing else in the payload changes.

### D3. Flyer page - a non-available home

A served flyer renders exactly as an Available one does today, whatever the
status: photos, address heading, area, "Same-day tours available", facts,
details, and the variant's CTA ("Sign up for home alerts" form / "I'm
interested - text us"). No status badge, banner or wording. This is the whole
change for served flyers: the page already has no status input.

### D4. Flyer page - the fallback (missing, deleted, setup, or any fetch failure)

Replace the `unavailable` stage with a neutral `fallback` stage. It never says
"no longer available", "taken" or "removed". All three 404 causes and any
other fetch failure render it identically (no existence oracle).

- Form variant: heading "Find a home that fits your voucher"; line "Sign up and
  we'll text you about homes that fit your voucher. Signing up does not book a
  tour."; then the same `IntakeForm` (submit label "Sign up") inline on the
  page. The submit still sends the route's `unitId` - the server already
  treats a non-public unit as a flyer sign-up with no property (D5). On
  success: heading "Thanks - you're all set!" and "We'll text you about homes
  that fit your voucher." (focus moves to the heading, as on the flyer today).
- Text variant: heading "Find a home that fits your voucher"; a tap-to-text
  link "I'm looking for a home - text us" prefilled "I'm looking for a home
  that fits my voucher." when the 404 body carries `contact_number`; else the
  existing "Reply to the text we sent you" line with "homes" wording.
- The "See other homes" link and `UNAVAILABLE_PREFILL` are removed.

### D5. Sign-up attribution

`viaFlyer` (`public.ts:515`) becomes: unit present, not soft-deleted, status in
`FLYER_PUBLIC`. Everything `viaFlyer` drives follows unchanged: capture source,
unit of interest, pin source for the 24-hour repeat check, and the
properties-sent `flyer` entry (with its current-decline rule). A sign-up from an
Occupied home's flyer is therefore credited exactly like one from an Available
flyer (Cameron, 2026-10-27). Missing, deleted and setup units keep today's
no-property behavior (`Signed up from a flyer as <name>`, `sentSkipped
'not_shareable'`).

The `SignupSentSkipped` value `'not_shareable'` keeps its name (it is written
into stored audit events); its comment is reworded to "the flyer's unit is
missing, deleted or not public (FLYER_PUBLIC)".

### D6. Pin label names a non-available status

`signupPinLabel` adds the property's status label in parentheses after the
address when `viaFlyer` and the status is not `available`:

- `Signed up from the flyer for 12 Main St, Springfield (Occupied) as Jane Doe`
- unchanged for Available: `Signed up from the flyer for 12 Main St, Springfield as Jane Doe`
- with no address: `Signed up from the flyer for <unitId> (On hold) as ...`
- the opt-out note still ends the label.

The label text is `LISTING_STATUS_LABELS[status]` (`statusModel.ts:275-283`).
It is the status at sign-up time and is stored in the pin like the rest of the
label (never re-rendered).

### D7. Dashboard property page

The flyer line (`ListingDetail.tsx` ~937-958) shows "View flyer" + "Copy public
link" when the property is not deleted and its status is in the dashboard's
mirror of `FLYER_PUBLIC`. Otherwise one note:

- Setup: "The public flyer goes live once this property leaves Setup."
- Deleted: "The public flyer is off while this property is deleted."

The dashboard `SHAREABLE` mirror's comment is reworded like D1, and a
`FLYER_PUBLIC` mirror is added beside it in `dashboard/src/api/types.ts`.

### D8. Unchanged

- Broadcasts: send guard, composer unit list, the make-available dialog.
- The opaque 404 body, the rate limits, the `/join` page, the `IntakeForm`,
  the consent gate, the welcome text and every other sign-up step.
- `/unit-media` serving.
- Sign-ups that carry no `unitId`.

## 4. Docs

- `documentation/STATUS-MODEL.md:308-309`: Setup "not yet public"; Available
  "the only status a property can be sent in (broadcasts)"; add that every
  status but Setup serves the public flyer.
- Code comments that state the old rule: `public.ts` header (lines 17-18,
  50-53) and the route comment (838-839), `public.ts:501-506`, `:512-514`,
  `:603-607`, `:676-681`, `:749-752`; `app/src/lib/seed/lean.ts` ~211;
  `FlyerPage.tsx` header (14-15).

## 5. Tests

- App: flyer API serves each of the six public statuses and 404s for setup,
  deleted and missing with the identical body; the payload has no status key.
  Sign-up from an Occupied (and an On hold) flyer: capture source 'flyer', unit
  of interest, pin label with "(Occupied)", properties-sent entry written.
  Setup and deleted keep the no-property path. Available pin label unchanged.
- Dashboard: `FlyerPage.test.tsx` - the fallback in both variants (no "no
  longer available" text anywhere; inline form submits with the unitId;
  thank-you state; sms prefill); `ListingDetail.test.tsx` - the flyer line for
  available, occupied, setup and deleted.
- e2e: `public-pages.spec.ts` "unavailable" test becomes a fallback test (bogus
  id in both variants, plus a setup unit) and a new assertion that the seeded
  `under_application` unit (`NON_SHAREABLE_UNIT`, line 57, renamed) serves the
  full flyer; `listing-photos.spec.ts` (~326-338): after the flip to On hold
  the flyer still shows its photos and the API answers 200. One e2e sign-up
  from a non-available flyer asserts the "(...)" pin label on the contact page.

## 6. Non-goals

- Broadcasting a non-available property.
- Any status wording on the public page.
- Search-engine indexing rules for flyers.
- A multi-unit "building" layer.
