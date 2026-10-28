# Permanent flyer links - adversarial review (plan-blind)

Reviewer: independent adversarial reviewer, blind to docs/superpowers.
Scope: `git diff main...3635160e` (excluding docs/superpowers), plus an
app-wide sweep of readers and writers of the property status and of the
flyer gate. Read-only on source. No suites were run.

Counts: blocking 0, high 1, medium 3, low 3, info 1.

---

## PA-1 (high) - deploy makes every imported "placed" property public at once; an address-to-"voucher household lives here" oracle

- `app/src/lib/import/apply.ts:1619` maps Airtable "placed" to `occupied`.
- `app/src/routes/public.ts:871` now serves `occupied` (FLYER_PUBLIC,
  `app/src/lib/statusModel.ts:67-74`).
- `app/src/routes/public.ts:885` nulls `listing_link` only off Available.

Failure scenario. Before this branch, no imported placed property was ever
served: they were all `occupied`, and the gate was Available only. On deploy,
every one of them (the whole placement history of the Airtable import) answers
200 with its full address and photos. Imported unitIds are uuidv5 of the
normalized address with a namespace in the public repo (the known D2 item).
So someone with a list of addresses (a county parcel list, say) can compute
the ids, GET `/public/units/<id>/flyer` for each, and get 200 for exactly the
addresses where HousingChoice placed a voucher holder. A 404 means not ours,
or Setup. Section 8 participation is sensitive. Before this branch the same
probe could find only Available homes, which are advertised anyway, so it
revealed nothing.

What is new beyond the escalated D2 item: D2 is framed in
`docs/issues/public-signup-abuse-hardening.md` (c)/(d) as a pin and ledger
abuse amplifier. This is a disclosure harm that only exists because
`occupied` is now public. It lands in bulk the moment the code deploys, and
these properties were never shared publicly at all. They did not "keep" a
link they already had.

Suggested fix: do not ship D2 (Occupied public) until the imported-id question
is resolved. Two ways to do that: re-key imported units to random ids with a
redirect map, or require an unguessable per-unit flyer token in the public
URL. Or keep `occupied` out of FLYER_PUBLIC for units whose id is derived from
an address (`unitIdForAddress`). At minimum, say in the D2 escalation to
Cameron that all imported `occupied` rows flip public on deploy.

## PA-2 (medium) - a non-Available flyer still advertises tours and promises texts "about this home"

- `dashboard/src/routes/public/FlyerPage.tsx:371`: static "Same-day tours
  available" on every served flyer.
- `FlyerPage.tsx:419-420`: "Same-day RTA: Available" row.
- `FlyerPage.tsx:449`: text variant "Interested in this home?" / "I'm
  interested - text us" (prefill "I'm interested in <address>").
- `FlyerPage.tsx:466` and `:475`: "We'll text you about this home and
  others...".

Failure scenario. A tenant taps a months-old broadcast link (`?cta=text`) to a
home that is now Occupied or Under application. The page is byte-for-byte the
Available page, minus the listing row. It says same-day tours are available
and invites "I'm interested - text us". The tenant texts in, and staff must
tell them it is taken. That is the job the retired page did automatically.
For the public form variant, the thank-you promises texts "about this home",
which cannot be kept. For Off market, where the landlord left, HousingChoice
keeps advertising the landlord's home as touring, and there is no take-down
short of deleting it (see PA-8). Rental-ad rules generally treat advertising
a unit that is not available as misleading. The e2e test deliberately skips
`/available/i` (`e2e/tests/dashboard-next/listing-photos.spec.ts:345-349`),
so nothing catches this.

Suggested fix: the server already treats non-Available differently (the
listing_link null, PA-3). Add one boolean such as `accepting: status ===
'available'`, and off Available render neutral copy: drop the tours
highlight, say "Interested in homes like this?", and promise texts "about
homes that fit your voucher". Or accept it explicitly and record that call
in the spec.

## PA-3 (medium) - the listing_link null is a public status oracle; "no status word" does not mean no status leak

- `app/src/routes/public.ts:885`; FlyerPage hides the Listing row on null
  (`FlyerPage.tsx:334`, `:425-434`).

Failure scenario. For any property that has a `listing_link`, an anonymous
holder of the id can poll the flyer. The `listing_link` value changes from a
URL to null exactly when the home leaves Available. Combined with PA-1, an
address-derived id that answers 200 with `listing_link: null` (where the
import carried a link) points to a placed or held home, not a for-rent one.
The comments at `public.ts:327-330` and `:866-867` claim the public learns
"nothing beyond holding the id", which is no longer true.

Suggested fix: either accept it and correct the comments and the spec's
no-oracle claim, or make the decision not depend on status. For example,
always serve the link and let staff clear it, or never serve external links
on the flyer.

## PA-4 (medium) - the fallback sign-up loses the /join path's housing authority and lifecycle

- `dashboard/src/routes/public/FlyerPage.tsx:1086-1092` (diff;
  `handleFallbackSubmit`) and `:324`: the fallback renders the IntakeForm
  with no authority slot and sends the route unitId.
- `app/src/routes/public.ts:616` and `:624`: any request WITH a unitId
  creates `needs_review` and stores no housing authority.

Failure scenario. Before the branch, a 404 flyer (deleted, Setup, made up, or
a transient failure) linked to `/join`. A sign-up there was created as
`onboarding` and asked for the housing authority (join-housing-authority
D3/D5). Now the same visitor signs up inline. The request carries the unitId,
so the contact is created as `needs_review` with `capture_source:
'housing_fair'` and no authority. `housing_fair_signup_v2` is set, so
`app/scripts/backfill-join-housing-authority.ts` will never fill the authority
in later. Every dead-link lead (deleted homes, and imported homes moved back
to Setup) now enters triage without the one field `/join` was built to
capture, and in a different lifecycle state from an identical `/join`
sign-up.

Suggested fix: when the fallback renders after a 404, send no unitId, which
makes it a /join-equivalent sign-up with `onboarding`. Also render the
authority select, reusing HousingFairIntake's slot. Keep the unitId only for
non-404 failures (5xx, network, 429), where the home may well be public. Or
document the trade-off in the spec.

## PA-5 (low) - photos added during or after occupancy are now public, with no staff cue

- `app/src/routes/public.ts:880` (`resolvePublicMedia`) on every FLYER_PUBLIC
  status. Unit media is served unauthenticated
  (`app/src/routes/unitMediaServe.ts:8-13`).
- The Photos gallery in `dashboard/src/routes/listing/ListingDetail.tsx`
  carries no "shown on the public flyer" hint (the field tags in
  `routes/listing/requirements.ts` cover form fields, not photos).

Failure scenario. Staff attach move-in, inspection or damage photos to an
Occupied property's gallery, showing the household's belongings. Before this
branch the gallery was public only while the home was Available, which in
practice meant vacant. Now those photos are on the public flyer with the
address, for as long as the property exists.

Suggested fix: add a one-line cue on the Photos card ("Photos appear on the
public flyer"). Or gate photos on the public payload to Available. Or add a
per-photo "staff only" flag later.

## PA-6 (low) - staff "On flyer" tag for the listing link is now only sometimes true

- `dashboard/src/routes/listing/requirements.ts:273` tags "Public listing
  link" as `on_flyer`, and the legend reads "tenants see it on the public
  flyer". Since D3a it is shown only while Available (`public.ts:885`).

Scenario: staff fill the link on an Occupied property to "fix" the flyer. The
form says it is on the flyer, but it never appears there. Suggested fix: a
conditional tag, or the label "On flyer while Available".

## PA-7 (low) - status literal `'available'` duplicated beside the SHAREABLE set

- `app/src/routes/public.ts:224` (pin suffix) and `:885` (listing_link) test
  `=== 'available'`, while broadcasts use `SHAREABLE_STATUSES`
  (`app/src/routes/broadcasts.ts:1189`).
- Dashboard: `BroadcastComposer.tsx:376`, `:545` and `RecipientPreview.tsx:391`
  also use the literal.

Scenario: if a second sendable status is ever added to SHAREABLE, the
flyer's listing link and the pin suffix keep the old rule, so a sendable home
shows "(<Status>)" in pins and loses its listing link. Suggested fix: use
`SHAREABLE.has(...)` (or a named `isOpenToApply`) at both server sites.

## PA-8 (info) - no durable take-down short of delete; the Setup note invites a trap

- `dashboard/src/routes/listing/ListingDetail.tsx:430-434`: off Setup the
  note reads "The public flyer goes live once this property leaves Setup."
  `documentation/STATUS-MODEL.md` (diff) says derivation overwrites Setup on
  the next placement event.

Scenario: a landlord asks HousingChoice to stop advertising their home. Staff
move it to Setup, and later placement activity derives it out of Setup, which
silently republishes it. The only durable lever is delete, which also drops
the property from staff views. "No off switch" was Cameron's call (commit
95268619), so this is noted only so the landlord-request case is a conscious
part of that decision.
