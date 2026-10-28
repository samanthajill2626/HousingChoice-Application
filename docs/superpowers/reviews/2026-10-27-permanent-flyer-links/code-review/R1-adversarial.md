# R1 adversarial code review - feat/permanent-flyer-links

HEAD 49d9fd24 (base main 71fb9b45). Plan-blind: read the R1 diff package, the
worktree code, tests and product docs only. Probes were throwaway
`zz-review-*` tests (and one scratch-dir mutant via resolve.alias), run singly
after the battery's `npmtest EXIT=0`; all deleted, tree clean.

Counts: 0 BLOCKER, 1 HIGH, 2 MEDIUM, 4 LOW, 1 INFO.

---

## A-1 HIGH - CONFIRMED - A served flyer for a home that is not Available still advertises it as open

Evidence
- The route now serves every FLYER_PUBLIC status (app/src/routes/public.ts:869)
  and the payload carries no status or "open" signal (public.ts:879-884), so the
  page renders the same for Under application, Finalizing, Occupied, On hold and
  Off market as for Available - only the Listing row drops (D3a).
- What that page says regardless: "Same-day tours available" on every flyer
  (dashboard/src/routes/public/FlyerPage.tsx:367); the heading falls back to
  "Home for rent" with no address/area (FlyerPage.tsx:153); a "Same-day RTA" row
  whose value is the word "Available" (FlyerPage.tsx:415-416); "Interested in
  this home?" plus a prefill "I'm interested in <line1, city>"
  (FlyerPage.tsx:445, :157-164); "We'll text you about this home and others
  that fit your voucher." before and after sign-up (FlyerPage.tsx:462, :471).
- The branch's own e2e pins this on an Occupied flyer: the term list includes
  "Same-day RTA" and the thank-you "about this home"
  (e2e/tests/dashboard-next/flyer-leads.spec.ts:770, :792).
- Lean world: unit-0001 is under_application with a string address and no area
  (app/src/lib/seed/lean.ts:222, :225), so its public h1 is "Home for rent";
  public-pages.spec.ts:625 deliberately leaves that h1 unasserted.
- The texts that carry these links said "a N-bedroom home at <address> is
  available for $X/mo. Details: [FlyerLink]"
  (dashboard/src/routes/broadcasts/resolveTemplate.ts:31); the flyer now
  corroborates that claim for as long as the property exists.
- Staff cue gap: the form sign-up's pin names the status (public.ts:220-224,
  D6), but the ?cta=text variant - the one every [FlyerLink] carries
  (app/src/lib/mergeFields.ts:10, :25) - produces a plain inbound "I'm
  interested in <address>" with no pin and no status; nothing on the inbound
  path annotates it (no interest parsing in app/src).

Proof: throwaway dashboard test rendering exactly what the route sends for an
Occupied property (listing_link null, address {}, same_day_rta true): h1 "Home
for rent", "Same-day tours available", "Same-day RTA"/"Available" and "We'll
text you about this home..." all render; with ?cta=text, "Interested in this
home?" and an sms body "I'm interested in 88 Sycamore St, Decatur". A throwaway
app test confirmed the lean unit-0001 payload is address {} / area null.

Consequence: every old Matching/broadcast link and every posted flyer becomes a
standing ad telling voucher holders (who search against a voucher expiry) that
a leased, held or withdrawn home has same-day tours, while HC keeps collecting
sign-ups on it. Staff field "I'm interested in <address>" texts with no status
cue. An Under application home draws competing interest while HC's own tenant
is in the landlord's review. Keeping stale homes up as lead magnets without a
disclosure is also a legal/reputational question that deserves an explicit
decision.

Fix: keep D3 (no status word) but stop asserting availability off Available:
send a non-status boolean beside the listing_link nulling (public.ts:883, e.g.
`open: unit.status === 'available'`); when false, hide "Same-day tours
available" and the Same-day RTA row, use a neutral heading fallback (the area,
else "Home") instead of "Home for rent", and word the CTA, thank-you and prefill
as "homes like this" ("I'm interested in homes like <address>"), which also
gives staff a cue. If the copy is to stay, record that as an accepted decision.

---

## A-2 MEDIUM - CONFIRMED - "No oracle beyond holding the id" is false for imported properties: their ids derive from the address, and D2 now serves every imported Placed (Occupied) home

Evidence
- The importer keys a unit on uuidv5("unit:" + normalizeAddress(raw cell))
  with a fixed namespace committed in source (app/src/lib/import/apply.ts:1483,
  app/src/lib/import/ids.ts:24, :84-86). normalizeAddress lowercases and strips
  commas, periods and extra spaces (app/src/lib/import/addresses.ts:85-92), so
  casual spellings of the same address collapse to the same id.
- Airtable "Placed" maps to occupied (apply.ts:1619), and occupied is now in
  FLYER_PUBLIC (app/src/lib/statusModel.ts:298-305; gate public.ts:869). On
  main the same request answered the opaque 404 (SHAREABLE only).
- The new comments rest on the premise (public.ts:465-468, :870-871).
  Dashboard-created units use `unit-${randomUUID()}`
  (app/src/repos/unitsRepo.ts:1257) and are unaffected.

Proof: throwaway app test. Seeded a unit under the id the importer mints for
"742 Evergreen Ter., Atlanta, GA 30303", status occupied, with an authority and
a photo; an "outsider" recomputed the id from "742 evergreen ter atlanta ga
30303" - identical - and GET /public/units/<id>/flyer answered 200 with
accepted_authorities, voucher_sizes and the photo URL; a neighboring address
answered 404.

Consequence: anyone holding the namespace (any present or former collaborator;
it sits in the history of both remotes) and an address can confirm that a home
is in HC's voucher book and not in Setup, and pull its photos - including homes
HC placed a voucher household in, which main never served. The same
derivability lets an attacker MINT valid public unitIds, each its own 24-hour
pin source and properties-sent rewrite target
(docs/issues/public-signup-abuse-hardening.md points (c), (d) and 3); the
issue's updated text does not mention this.

Fix: keep main's Available-only gate for units whose id is derivable
(`imported_from` set), or give each unit a random public token and require it
(not a derivable id) on /public for non-Available units; note the namespace as
sensitive and add the minting angle to public-signup-abuse-hardening.

---

## A-3 MEDIUM - CONFIRMED - No durable, non-destructive way to take one flyer down, and the staff copy implies Setup is one

Evidence
- Setup is the only status the flyer does not serve (statusModel.ts:298-305),
  but it does not pin against derivation; only on_hold and off_market do
  (statusModel.ts:350-353) and both are public. deriveListingStatus overwrites
  any non-override status on every placement event
  (app/src/services/statusTransition.ts:391-404; deriveStatuses
  statusModel.ts:426-443: open stages -> under_application/finalizing,
  moved_in -> occupied, lost -> available).
- The property page tells staff "The public flyer goes live once this property
  leaves Setup." (dashboard/src/routes/listing/ListingDetail.tsx:433) with no
  hint that leaving Setup happens without them. The only durable take-down is
  delete (documentation/STATUS-MODEL.md section 6, new bullet), which hides the
  property from every staff list (app/src/routes/units.ts:2479-2499).
- off_market is the terminal status: a property HC no longer represents
  (landlord left, home sold) keeps a live ad with "Accepts: <authority>" and the
  A-1 copy.
- A property that was never Available becomes public the moment a placement
  opens on it (setup -> under_application); on main it stayed private.
- Photos are served unauthenticated with a 7-day cache
  (app/src/routes/unitMediaServe.ts:31; infra/modules/cloudfront/main.tf:42-80)
  and /p/ carries no noindex/robots anywhere (dashboard/index.html,
  dashboard/public, app/src), so a publicly posted link stays indexable as a
  live ad for as long as the property exists.

Proof: throwaway app test through the real routes: create a unit (setup), a
tenant and a placement -> the unit reads under_application and its flyer 200s
(never Available); PATCH listing-status setup (manual) -> 404; one placement
transition (awaiting_approval) -> under_application, status_source derived,
flyer 200 again with no staff action.

Consequence: when a landlord, a new owner or the household now living in the
home asks HC to take the listing and its interior photos down, staff can only
delete a live property mid-placement or make a Setup move the next placement
step silently undoes - while the page tells them Setup keeps it off.

Fix: an explicit, derivation-proof flyer switch (e.g. a `flyer_off` flag read
beside the gate at public.ts:869 and ListingDetail.tsx:429), or at minimum drop
off_market from FLYER_PUBLIC and reword the Setup note (a placement step can
move the property out of Setup; delete it to keep the flyer off). Consider
noindex on /p/.

---

## A-4 LOW - CONFIRMED - The neutral fallback replaced the /join funnel and drops the housing-authority question; its leads start in Needs review with no authority

Evidence: main's unavailable page linked "See other homes" to /join
(main:dashboard/src/routes/public/FlyerPage.tsx:287-288), which asks the
authority and starts the lead in onboarding (public.ts:614, :622). The fallback's
inline IntakeForm (FlyerPage.tsx:320) has no authority select and always sends
the route unitId when it is 1..200 characters (FlyerPage.tsx:273-280); the
server refuses unitId plus authority together (public.ts:318-324) and starts any
request carrying a unitId in needs_review (public.ts:614). After a 404 the
unitId buys no credit (public.ts:533). Pinned by
e2e/tests/dashboard-next/public-pages.spec.ts:639-669.

Consequence: every dead link (setup, deleted or made-up id) now yields a lead
with no housing authority - which an authority-filtered property blast never
reaches (RUNBOOK.md:456, the gap the join-housing-authority work closed) - and
in Needs review rather than Onboarding.

Fix: after a 404, render the /join semantics (authority select through
IntakeForm's extraField seam, no unitId); send the unitId only after a non-404
failure, where D5 credit can still apply.

---

## A-5 LOW - CONFIRMED - The rewritten send refusal (D8) tells staff to make a soft-deleted Available property Available

Evidence: the send guard refuses a deleted unit with the same code as a
non-Available one (app/src/routes/broadcasts.ts:1189-1190); the pre-flight reads
only the status (dashboard/src/routes/broadcasts/RecipientPreview.tsx:384, :391)
and GET /api/units/:id returns deleted units with their status
(app/src/routes/units.ts:1025-1038). So the pre-flight passes, the server 400s,
and staff read "This property isn't Available. Only Available properties can be
sent - make it Available, then send." (RecipientPreview.tsx:420) about a property
whose pill reads Available.

Proof: throwaway app test: draft with unit-1 (available), DELETE
/api/units/unit-1; GET still reads status available with deleted_at set; POST
send answers 400 unit_not_available.

Fix: a distinct code for deleted or missing (e.g. unit_deleted), or check
deleted_at in the pre-flight, with copy such as "This property was deleted -
restore it to send."

---

## A-6 LOW - CONFIRMED - The fallback's copy of the server's unitId cap has no drift guard

Evidence: FlyerPage.tsx:52-57 hand-copies MAX_UNIT_ID_LEN = 200 from
app/src/routes/public.ts:129 so the fallback's one button "can always succeed";
FlyerPage.test.tsx pins only the client copy (and mocks submitHousingFair), and
no app test sends a unitId near the cap.

Proof: mutant copy of public.ts with MAX_UNIT_ID_LEN = 64, swapped in by
resolve.alias (load proven by a marker line): publicIntake.test.ts plus
publicSignupLeads.test.ts, 152/152 pass.

Consequence: a later change to the server cap silently breaks the fallback for
route ids between the new cap and 200 ("Sorry, we couldn't send that") - the
drift flyerPublicMirror.test.ts exists to stop for FLYER_PUBLIC. Low impact
today (real ids are 36-41 characters).

Fix: move the cap to a leaf module, add it to the mirror test, and add a server
test at 200/201.

---

## A-7 LOW - CONFIRMED - A transient load failure hides an Available home behind the fallback, with no retry, and the text variant loses the number

Evidence: FlyerPage.tsx:250-255 maps every non-abort failure to the fallback,
pinned by FlyerPage.test.tsx:731 (a 500, a 429, a network failure, a TypeError).
5xx and 429 bodies carry no contact_number (contactFromError,
FlyerPage.tsx:167-173), so a known tenant on ?cta=text gets "Looking for a home?
Reply to the text we sent you" instead of the home. There is no retry control.

Consequence: a tenant opening a Matching link to an Available home during a
blip - or many visitors behind one IP tripping the 5-per-minute /public limiter
(a housing fair's Wi-Fi) - lands on a generic page, with nothing saying the load
failed.

Fix: after a non-404 failure, show the fallback with a "Try again" control (or
a line saying the home could not load).

---

## A-8 INFO - CONFIRMED - Documentation drift left by the branch

- e2e/support/selectors.md:145 (the Priority row, merged from main) still says
  every status but Available "answers the unavailable page"; since this branch
  every status but Setup serves the flyer, so that advice rests on a false
  premise.
- docs/issues/public-signup-abuse-hardening.md: the branch edited the body and
  `updated:` but left `refs:` citing public.ts:690-747, 760-777 and 541-578,
  which this branch shifted by about 18-20 lines (repeat check now
  public.ts:715, pin :754, ledger :790, deleted path :559). It also dates the
  change "2026-10-28" while the other docs say 2026-10-27.
- dashboard/src/routes/public/publicApi.ts:5-8 and the public.ts route header
  list the 404 causes as missing, deleted or Setup, omitting a stored status
  outside the list (which public.ts:861-862 includes).

Fix: refresh the row, the refs and the cause lists.
