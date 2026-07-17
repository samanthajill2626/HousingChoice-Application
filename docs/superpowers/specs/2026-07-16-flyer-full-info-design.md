<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-16).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Flyer full-info page (design)

Date: 2026-07-16
Status: Approved design, pre-implementation
Branch: feat/flyer-full-info (worktree w:/tmp/flyer-full-info, cut from main @b937d1c)

## 1. Problem and decision

The public flyer at /p/:unitId is a three-stage conversion funnel: a minimal
teaser, then an intake form gating a "full details" reveal. Cameron's verdict:
the gate is not worth it, and it actively confuses tenants we have ALREADY
onboarded (we text them the flyer link ourselves; asking them to sign up again
reads as a broken experience).

Decision: one public page showing ALL tenant-useful information upfront, with
a call to action at the bottom. The CTA has two variants selected by a query
param, because the flyer reaches two audiences:

1. Known tenant (we texted them the link): no signup form anywhere. The CTA is
   "I'm interested - text us" - a tap-to-text (sms:) link to our main business
   number with a prefilled message, landing on their existing 1:1 thread.
2. Public visitor (bare link, copied/posted/forwarded): the CTA is the existing
   inline intake form (name / phone / consent) - full capture funnel, but with
   no information gated behind it.

Auto-sent [FlyerLink] tokens get the known-tenant variant; the bare link is the
public variant. A known tenant forwarding their link to a friend shows the
friend the text-us CTA instead of the form - acceptable soft edge (the friend
texts us; we capture them on that thread).

## 2. Field scope (the line between public and internal)

Approved scope: "public + tenant-useful". The single public projection contains:

Already public today (teaser + reveal merged):
- unitId, media (photos), beds, baths, rent_min, rent_max, area, subzone,
  voucher_size (derived from beds), accepted_programs, listing_link,
  address (structured), utilities (tenant-paid), video_url, application_fee,
  same_day_rta

Newly public (tenant-useful facts, staff-authored):
- pets (string | boolean at rest; projection passes through, null when absent)
- accessibility (free text)
- deposit (dollars, number)
- lease_terms (free text)

Config-sourced (not a unit field):
- contact_number: config.ourPhoneNumbers[0] (the SAME main number all 1:1
  Twilio operations use - the established businessCallerId convention), or
  null when the list is empty (unconfigured dev). Added by the route, exactly
  like media resolution - it is NOT part of the unit-record projection.

NEVER public (unchanged, and the allowlist comments must keep saying so):
- notes, landlordId, primary_voice_contact, payment_standard, lif, priority,
  tour_process, tour_type, application_process, status/status_source,
  propertyId, jurisdiction, final_rent, voucher_size_accepted, created/updated
  timestamps.

The projection stays a strict build-UP allowlist (never strip-down): a future
internal field on UnitItem can never leak because it is simply not copied.

Note for staff discipline (not enforced in code): accessibility and lease_terms
are free text now rendered publicly; they must not be used to stash landlord
contact info. The fields' dashboard edit-form helper text should say "shown on
the public flyer".

## 3. Backend changes (app)

### 3.1 lib/unitFields.ts
- Collapse UnitFlyer + UnitFlyerDetails into ONE interface, `UnitFlyer`, with
  the section-2 field set (everything except contact_number). Delete
  `UnitFlyerDetails` and `toUnitFlyerDetails`.
- `toUnitFlyer(unit)` returns the merged projection. Address goes through the
  same validateAddress re-validation the details projection uses today
  (allowlisted sub-fields only; legacy string blobs become {}).
- pets: copied when `typeof === 'string' || typeof === 'boolean'`, else null.
- accessibility / lease_terms: string or null. deposit: finite number >= 0 or
  null (same isFiniteNumber guard as the other money fields).
- Update the stale comments on WRITABLE_FIELDS entries (lease_terms, pets,
  notes) that say "NEVER on the flyer projections": lease_terms and pets ARE
  now on it; notes stays never-public.

### 3.2 routes/public.ts
- GET /public/units/:unitId/flyer: unchanged gate (missing, soft-deleted, or
  non-shareable status all return the same opaque 404), unchanged rate
  limiting. Response becomes
  `{ flyer: { ...toUnitFlyer(unit), media, contact_number } }` where media is
  the existing presign-resolved list and contact_number is
  `config.ourPhoneNumbers[0] ?? null`.
- The 404 body becomes `{ error: 'not_found', contact_number }` - the SAME
  body for missing, deleted, and not-shareable (still no existence oracle;
  the number is config, identical on every 404). This feeds the
  unavailable-state text-us CTA (section 4.1), which otherwise has no flyer
  payload to read the number from.
- DELETE the GET /public/units/:unitId/details route entirely (no vestigial
  endpoint, no alias). The dashboard is the only client.
- POST /public/housing-fair: completely unchanged (consent gate, dedupe,
  idempotent welcome text, flyer attribution via unitId, no-PII logging).

### 3.3 lib/mergeFields.ts
- `flyerUrl(publicBaseUrl, unitId)` now returns
  `${base}/p/${unitId}?cta=text`. Every auto-sent [FlyerLink] (1:1 sends,
  broadcast/matching sends via routes/broadcasts.ts which calls the same
  function) therefore carries the known-tenant variant. Existing tests assert
  the exact URL string - update them byte-for-byte deliberately.

## 4. Frontend changes (dashboard)

### 4.1 FlyerFunnel -> FlyerPage
Rename dashboard/src/routes/public/FlyerFunnel.tsx (+ .module.css + test) to
FlyerPage.*. Route path /p/:unitId in App.tsx is unchanged; PublicLayout is
unchanged. The stage machine shrinks to: loading | unavailable | ready. The
intake/reveal stages are deleted.

Page layout (single scroll, mobile-first - these links arrive by SMS):
1. Photo gallery (unchanged markup).
2. Title: neighborhood (subzone, area) or "A home for you".
3. Key facts row: beds, baths, rent range, voucher size, accepted programs.
4. Details list (dl, null fields simply not rendered):
   address, deposit, application fee, tenant-paid utilities, pets,
   accessibility, lease terms, same-day RTA, video tour link, external
   listing link. (Rent lives in the key-facts row only.)
   - pets rendering: boolean true -> "Allowed", false -> "Not allowed",
     string verbatim.
   - video_url AND listing_link hrefs go through safeHttpUrl (public
     unauthenticated page; never render javascript:/data: links).
5. CTA section at the bottom, by variant (see 4.2).

Tenant-facing copy: the dwelling is always "home" (never unit/property/
listing) - GLOSSARY rule, unchanged.

The loading state is unchanged. The unavailable state ("This home is no
longer available") becomes variant-aware so neither path dead-ends:
- Public variant: unchanged - the existing "See other homes" link to /join
  is its CTA.
- Known-tenant variant: a tap-to-text button (same sms: mechanics as 4.2)
  with prefill "The home I was looking at is no longer available - I'm
  interested in similar homes."; when contact_number is null, the same
  reply-prompt degrade copy as 4.2. The number comes from the 404 body
  (section 3.2) since there is no flyer payload in this state.

### 4.2 CTA variants
Variant selection: `?cta=text` query param. Any other value or absence =
public variant.

Flag stripping + persistence: on mount, read the param, persist the variant
in sessionStorage (key includes the unitId), then strip the param from the
URL (react-router setSearchParams with replace: true - no history entry, no
remount loop). Copying the URL from the address bar or the native share
sheet therefore never propagates the flag to a friend. A refresh in the same
tab KEEPS the known-tenant variant via sessionStorage (without this, a
reload would dump the known tenant onto the signup form - the exact
confusion this feature removes). Known limitation, accepted: forwarding the
original SMS forwards the flagged link; the friend sees the text-us CTA and
reaches us on the thread anyway.

Public variant (bare /p/:unitId):
- Heading: "Interested in this home?" + the existing IntakeForm component
  (name / phone / optional voucher size / required SMS-consent checkbox),
  submitLabel "I'm interested".
- Submit: POST /public/housing-fair with unitId (attribution + welcome text
  behavior unchanged). On success, ONLY the CTA section swaps to a thank-you
  ("We've got your info - a team member will be in touch."); all the info
  above stays on screen. There is no details fetch anymore (getFlyerDetails
  is deleted from publicApi.ts).
- Keep the focus-management pattern: on swap to the thank-you, move focus to
  its heading (tabIndex -1) so the change is announced to screen readers.

Known-tenant variant (?cta=text):
- No form anywhere on the page.
- contact_number present: a prominent link-button "I'm interested - text us"
  with href `sms:<E164>?&body=<encoded prefill>`. The `?&body=` form is the
  deliberate cross-platform quirk (iOS takes &body / modern iOS ?body,
  Android takes ?body; `?&body=` satisfies both) - keep it exactly.
- Prefill body: "I'm interested in <X>" where X = "line1, city" when address
  line1 exists, else the neighborhood string, else "this home".
- contact_number null (unconfigured dev): degrade to plain copy - "Interested?
  Reply to the text we sent you and we'll help you take the next step." - no
  dead button.

### 4.3 publicApi.ts
- PublicFlyer type gains: address, utilities, video_url, application_fee,
  same_day_rta, pets (string | boolean | null), accessibility, deposit,
  lease_terms, contact_number. Delete PublicFlyerDetails + getFlyerDetails.

### 4.4 Dashboard link wart (fold-in fix)
dashboard/src/routes/listing/listingLinks.ts flyerPath currently returns
`/public/units/:unitId/flyer` - the JSON API path - so "View flyer" and
"Copy public link" on the property page open raw JSON. Fix: return
`/p/${encodeURIComponent(unitId)}` (the actual page; bare = public variant,
correct for a copy-to-clipboard link). Update listingLinks.test.ts.

### 4.5 Untouched
/join (HousingFairIntake), IntakeForm itself (still shared by /join and the
public variant), PublicLayout, the consent copy, rate limiting, and all
dashboard-internal listing pages (beyond 4.4).

## 5. Testing

App (vitest):
- unitFields.test.ts: merged projection carries every section-2 field;
  never-public fields (notes, landlordId, payment_standard, lif, priority,
  tour_process, tour_type, application_process, primary_voice_contact,
  propertyId, jurisdiction, status, status_source, final_rent,
  voucher_size_accepted) are ABSENT from the projection of a
  fully-populated unit; pets passes through string and
  boolean; legacy string address -> {}.
- publicIntake.test.ts / apiRoutes.test.ts: /flyer returns the full payload
  incl. contact_number from config; /details now 404s at the router level
  (route gone - assert 404 for the path); shareability gate unchanged; the
  flyer 404 body carries contact_number and is byte-identical across
  missing / deleted / not-shareable units.
- mergeFields.test.ts: [FlyerLink] resolves to `${base}/p/<id>?cta=text`.

Dashboard (vitest):
- FlyerPage.test.tsx (renamed): public variant renders all detail rows +
  form, submit swaps ONLY the CTA to thank-you, info remains; known variant
  renders sms: link with encoded prefill and NO form; contact_number-null
  known variant renders the reply-prompt copy; javascript: video/listing
  URLs are not rendered as links; ?cta=text is stripped from the URL on
  mount and the variant survives a remount via sessionStorage; unavailable
  state renders the /join link (public) vs the text-us CTA fed by the 404
  body (known).
- listingLinks.test.ts: flyerPath -> /p/:unitId.

E2e (playwright, e2e/tests/dashboard-next/public-pages.spec.ts):
- Rework: bare flyer link shows address/deposit/fee/etc with NO gate; form
  submit produces thank-you + dev-outbox welcome text (existing helpers);
  ?cta=text shows the text-us CTA (assert href, do NOT click - sms: has no
  page to land on), asserts the form is absent, and asserts the URL was
  stripped clean of the cta param after load. Accessibility-first
  selectors per e2e/support/selectors.md.

Gates: npm run typecheck + npm test + npm run e2e, bare, from the worktree.

## 6. Non-goals

- No per-recipient tokens or click tracking in flyer links.
- No changes to /join, the welcome-text pipeline, or A2P consent copy.
- No new env/config (reuses ourPhoneNumbers[0]); no infra.
- tour_process / tour_type / application_process stay internal (tour
  scheduling on the flyer is a possible future slice, not this one).
- No dashboard edit-form redesign; at most helper-text tweaks noting which
  fields are publicly shown (see section 2 note).

## 7. Watch items for the build

- mergeFields tests assert exact URL strings - update deliberately,
  byte-for-byte, including the broadcasts.ts flyer_url path.
- The sms: href `?&body=` quirk - do not "clean it up" to `?body=`.
- publicIntake.test.ts covers the deleted /details route extensively - those
  tests are REWORKED (flyer now carries the payload), not deleted wholesale;
  the never-leak assertions must survive on the merged projection.
- FlyerFunnel.module.css class names are referenced by tests/e2e selectors
  in places - prefer role/label selectors when touching them.
- The e2e dev stack's OUR_PHONE_NUMBERS is set, so contact_number is
  non-null there; the null-degrade branch is unit-test-only.
