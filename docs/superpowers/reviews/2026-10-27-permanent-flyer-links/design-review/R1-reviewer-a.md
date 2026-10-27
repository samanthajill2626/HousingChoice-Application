# Design review R1 - reviewer A - permanent flyer links

Spec: `docs/superpowers/specs/2026-10-27-permanent-flyer-links-design.md` (rev 1).
Repo read at the worktree head (991dca7d, main @d0e2c2d8 + the spec commit).
Read-only review; every code claim below cites a line I read.

Verified as stated (no finding): SHAREABLE = {'available'} (statusModel.ts:289),
re-export (unitsRepo.ts:64); flyer 404 gate (public.ts:845) and sendNotFound
(public.ts:450-455); viaFlyer (public.ts:515) and everything it drives
(capture_source/unit_of_interest public.ts:609-610, signupPinLabel
public.ts:198-211, sourceRefId public.ts:689, sentSkipped 'not_shareable'
public.ts:762-765); broadcast send guard (broadcasts.ts:1187-1193); composer
unit list (BroadcastComposer.tsx:376); ListingDetail flyer line with no
soft-delete check (ListingDetail.tsx:418, :939-957); the dashboard SHAREABLE
mirror has no runtime reader (types.ts:936, no other reference); FlyerPage has
no status input and its unavailable stage is as described (FlyerPage.tsx:38-46,
:264-294); /unit-media is not status-gated (unitMediaServe.ts:44-55);
/public/* is caching_disabled at CloudFront (infra/modules/cloudfront/main.tf:158-166),
so no stale 404 is cached at the edge; unit ids are `unit-<uuid>`
(unitsRepo.ts:1239), so serving more statuses adds no enumeration risk.

---

## 1. [HIGH] Staff-facing broadcast copy becomes false, and D8 says it is "unchanged"

What is wrong. Three strings shown to staff in the send flow state the old rule
as fact - that a non-Available property's flyer link does not work:

- `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:540-549` - the early
  note: "This property is <status>, so its flyer link won't work. You'll be
  asked to make it Available when you send."
- `dashboard/src/routes/broadcasts/RecipientPreview.tsx:756-759` - the
  make-available dialog body: "The flyer link in this send only works while
  the property is Available."
- `dashboard/src/routes/broadcasts/RecipientPreview.tsx:416-419` - the
  `unit_not_available` race error: "This property isn't Available, so its
  flyer link won't work."

After D1/D2 the link works for five of the six non-Setup statuses. D8 lists
"the make-available dialog" as Unchanged, and section 4 does not list any of
these files. The same staff member would see "Copy public link" on an Occupied
property page (D7) and then be told by the composer, for the same property,
that its flyer link won't work. For Setup the sentence stays true; for
under_application/finalizing/occupied/on_hold/off_market it becomes false.

The guard's only stated rationale is the dead link (broadcasts.ts:1181-1186
"the flyer link ... only resolves while the unit is SHAREABLE";
RecipientPreview.tsx:87-89, :375-376). D1 rewords SHAREABLE's doc to "the only
status a property can be SENT in" but gives the guard no reason of its own and
leaves its UI explanation in place.

Evidence also pinned by tests that will keep passing on the false copy:
`BroadcastComposer.test.tsx:576-592, :1764` (On hold case asserts "flyer link
won't work") and `e2e/tests/dashboard-next/broadcasts.spec.ts:283` (Setup unit -
still true there).

Implies. Either the spec rewords these three strings (a reason that is true for
every non-Available status - e.g. that sends go out only for Available
properties) and their tests, or it explicitly decides to leave false copy in
place. "Unchanged" cannot stand as written. Broadcast behavior (the guard) can
stay unchanged; its explanation cannot.

## 2. [MEDIUM] "Setup is excluded" is a current-status gate; it does not deliver the stated reason

What is wrong. D1 excludes Setup because "details may be half-entered and the
landlord may not be signed on yet". The mechanism gates on the CURRENT status
only. A manual listing-status transition accepts any listing status from any
status (`app/src/routes/statusTransition.ts:346-361` validates only
`isListingStatus`), so a property parked On hold, or marked Off market, straight
from Setup - never launched, details half-entered - becomes publicly served,
and D7 starts offering "Copy public link" for it.

Off market is the terminal exit (STATUS-MODEL.md:305, :312; "replaces today's
inactive") - typically a landlord who withdrew the home. "The landlord may not
be signed on" is at least as true there as in Setup, yet the spec serves it
forever with "Sign up for home alerts ... about this home" and "Same-day tours
available". The intent record (intent.md "Assumptions") shows Cameron accepted
Occupied staying public; Off market and never-launched On hold were bundled
into "All but Setup" without being weighed separately.

Implies. The spec should either (a) state plainly that a Setup -> On hold / Off
market property is served, and that Off market (landlord withdrew) is served,
as accepted consequences, or (b) narrow the set. As written the rationale
promises something the gate does not do.

## 3. [MEDIUM] "Same-day tours available" and the Same-day RTA row are rendered on Occupied / Off market homes

What is wrong. D3 renders the served flyer "exactly as an Available one does
today, whatever the status", explicitly including "Same-day tours available"
(FlyerPage.tsx:336, static on every flyer) and the details, which include a
"Same-day RTA: Available" row (FlyerPage.tsx:382-386). Together with the
address-as-Maps-link heading (FlyerPage.tsx:320-326), an Occupied home's public
page now advertises same-day tours at an address where a placed household
lives. The recorded acceptance (spec line 12-14, intent.md) covers "street
address, Maps link and photos" - not a standing same-day-tours claim on an
occupied residence. Goal 2 bans status wording; it does not require keeping a
claim that is false for that status.

Implies. Not scope creep: this is a decision the spec makes implicitly in D3
and should make explicitly (keep, with Sam/Cameron's acceptance recorded, or
drop the line for non-Available without adding status wording). The page has
no status input (D2), so "drop it" would need a payload flag the spec forbids -
which is exactly why the trade-off needs to be on the record.

## 4. [LOW] Unenumerated e2e that asserts the old fallback heading

`e2e/tests/dashboard-next/environment-identity.spec.ts:40-45` visits
`/p/missing-unit` and asserts a heading matching /no longer available/. D4
removes that heading; section 5 names only public-pages.spec.ts and
listing-photos.spec.ts. Gate 4 will fail on it. Add it to section 5 (the new
assertion should be the fallback heading "Find a home that fits your voucher").

## 5. [LOW] Existing "not shareable" unit tests use a non-listing status and will pass vacuously

The app tests that pin the no-property path use `status: 'placed'` - a TENANT
status, not a LISTING_STATUSES value (statusModel.ts:261-269):
`app/test/publicIntake.test.ts:503-516, :571-590`,
`app/test/publicSignupLeads.test.ts:287, :469, :727, :858, :1048, :1166`.
Under the explicit FLYER_PUBLIC list 'placed' stays non-public, so these stay
green while no longer exercising a real "not public" status. Section 5 says
"Setup and deleted keep the no-property path" but does not say to re-point
these fixtures at 'setup'; without that, the only real non-public listing
status (Setup) has no sign-up attribution test on the existing suites. (The
'on_hold' 404 cases at publicIntake.test.ts:649-669 and :713-718 will fail
loudly and are covered by section 5.)

## 6. [LOW] Section 4's comment list is incomplete

Comments stating the old rule that section 4 does not list:

- `app/src/repos/unitsRepo.ts:51-56` ("also gates the public flyer ...
  `available` is the only publicly shareable status") and `:63` ("Statuses
  whose unit may be exposed by the public flyer endpoint (only `available`)").
- `app/src/routes/public.ts:31, :38, :150, :218, :278, :306, :382, :450-452,
  :592, :606` (section 4 lists 17-18, 50-53, 501-506, 512-514, 603-607,
  676-681, 749-752, 838-839 only).
- `app/src/routes/broadcasts.ts:1181-1186` (guard rationale = dead link; see 1).
- `app/src/routes/units.ts:982-983` ("only 'available' is shareable").
- `dashboard/src/routes/public/publicApi.ts:5-7` ("maps that to a friendly
  'no longer available' state").
- `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:540-541`,
  `RecipientPreview.tsx:87-89, :375-376`.

## 7. [LOW] D7 leaves two flyer-line cases unspecified

D7 defines the links for "not deleted and in FLYER_PUBLIC" and one note each
for Setup and Deleted. Unspecified: (a) a property that is deleted AND in Setup
- which note wins; (b) a stored status outside LISTING_STATUSES (the dashboard
reads `unit.status` as stored; the FLYER_PUBLIC list is explicit by design, D1)
- neither links nor either note applies. One sentence fixes both (e.g. deleted
first; any other non-public status shows the Setup-style note or a generic
one).

## 8. [LOW] D4's "the server already treats a non-public unit as a flyer sign-up with no property" is not true for every id the fallback can be reached with

The fallback form submits the route's unitId. `parseHousingFairBody` refuses a
unitId that is empty after the app-wide body trim or longer than 200 chars
with the generic 400 (`public.ts:279-286`, `MAX_UNIT_ID_LEN` public.ts:124).
A link like `/p/%20` or an over-long garbage id renders the fallback whose only
CTA can never succeed. Rare, but the fallback's entire purpose is that sign-up.
Either omit unitId when it would fail the shape check, or accept the edge
explicitly.

## 9. [LOW] Fallback on a transient failure credits a home the visitor never saw

D4 renders the fallback (generic "Find a home that fits your voucher") for ANY
fetch failure, including a 5xx/network blip or a 429 on a public unit. The
inline form then submits that unitId, and D5 credits it in full (capture_source
'flyer', unit_of_interest, a pin naming the address, a properties-sent entry)
although the visitor saw no home. Probably acceptable (better than losing the
lead), but the spec's framing ("a flyer sign-up with no property") is wrong for
this case; say which behavior is intended.

## 10. [LOW] The new e2e sign-up's unit is unspecified; the seeded units are shared

Section 5: "One e2e sign-up from a non-available flyer asserts the '(...)' pin
label". The natural candidate, the renamed seeded `unit-0001`
(under_application), is used by at least nine other specs
(broadcasts, caseworkers, flyer-leads, matching-entry-points, placement-create,
today-past-tours, tour-auto-close, tours-all, tours-page). A sign-up writes a
pin, an unread mark and a properties-sent row on it - the shared-state hazard
flyer-leads.spec.ts:30-36 already documents. The spec should require a
run-unique unit (create, then flip to e.g. On hold) for that sign-up, as
listing-photos.spec.ts already does for its On hold flip.
