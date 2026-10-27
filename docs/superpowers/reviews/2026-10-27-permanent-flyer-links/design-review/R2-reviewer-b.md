# Design review R2 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-10-27-permanent-flyer-links-design.md` rev 2
(commit 438da8bc). Read with `adjudications.md`, `R1-reviewer-a.md` and the new
`docs/issues/sent-row-interested-ignores-listing-status.md`. Read-only review.

I re-read the code behind the rewritten sections (D1 consequences, D2/D3a, D4,
D5 widening, D7, D8, D9, section 4 and section 5). The changes for my R1 items
1, 3, 5, 6, 7, 8, 9, 11 and 12 are correct as written:
- D3a works with no page change: `safeHttpUrl(null)` returns null
  (`dashboard/src/lib/safeUrl.ts:9-10`) and the row is skipped
  (`FlyerPage.tsx:398`). `PublicFlyer.listing_link` is already
  `string | null` (`publicApi.ts:47`).
- The D8 strings keep `BroadcastComposer.test.tsx:1764`'s
  `/This property is On hold/` matching.

The new problems are in the material written to answer round 1.

---

## 1. [MEDIUM] D1's "take a flyer down" path does not work, and the D7 note it cites does not exist

**What is wrong.** D1, under accepted consequences: "The ways to take a flyer
down are: set the property to Setup, or delete it. D7's note on the property
page says so." Both halves are wrong.

**(a) Setup does not hold.** Setup is a baseline status, and derivation is free
to overwrite it. Only `on_hold` and `off_market` pin
(`app/src/lib/statusModel.ts:321-337`, `LISTING_OVERRIDE_STATES`).
`deriveListingStatus` (`app/src/services/statusTransition.ts:391-398`) skips
only those two override states and otherwise writes the derived status. It runs:
- on placement create: `deriveForStage` -> `applyDerivation`
  (`statusTransition.ts:705-711`), which derives `under_application`
  (`statusModel.ts:426`);
- on every placement stage move (`:558`);
- on a lost placement with no other active one, which derives `available`
  (`:547-556`, `statusModel.ts:415`).

So a property staff set to Setup to stop its flyer goes public again the next
time any placement on it is created or moved. Nobody is told. After a lost
placement it even reads Available, which also makes it broadcast-eligible. Using
Setup this way also overwrites the property's real lifecycle (Occupied, Under
application) with a false "being prepped" value for a display purpose.

**(b) No note says so.** D7's notes render only when the flyer is ALREADY off
(deleted / Setup / unknown status). On every public property the line shows
"View flyer" + "Copy public link" and nothing else. Nowhere in the spec tells
staff how to take a live flyer down.

**What it implies.** The only durable take-down is soft-delete. It is
reversible (`POST /api/units/:unitId/restore`, `app/src/routes/units.ts:2501`),
but it also hides the property from the dashboard lists. The spec must either:
- say exactly that (delete is the only durable off switch; Setup is undone by
  the next placement event) and drop the claim about D7; or
- add a real off switch.

The second is a decision for Cameron, not a wording fix. As written, the
"accepted consequence" an approver signs off on is a mechanism that does not do
what it says. This was my R1 item 4, adjudicated "accept as wording". The
wording that answered it is the defect.

---

## 2. [LOW] D4's unitId shape rule ignores the app-wide body trim, so "can always succeed" is false

**What is wrong.** D4: send the route's unitId "when it is 1 to MAX_UNIT_ID_LEN
characters (the server's own check, public.ts:279-286) ... so the page's one
button can always succeed." The server's check runs AFTER `trimJsonBody`
(`app/src/app.ts:146`; `app/src/middleware/trimStrings.ts:22-48` trims every
string value). A route param that is all whitespace (`/p/%20`: `useParams`
decodes it to `' '`) passes the client rule as written. The server trims it to
`''` and answers the generic 400 (`public.ts:283`). The form then shows its
error forever.

Two further gaps in the same rule:
- `MAX_UNIT_ID_LEN` (200) is a module-private constant (`public.ts:124`). The
  dashboard will hard-code a second copy. Section 5 adds parity tests for
  FLYER_PUBLIC but none for this number.
- The "no unitId" branch is a /join sign-up as far as the server knows. The new
  contact starts `onboarding`, not `needs_review` (`public.ts:596-598`). The pin
  reads "Signed up on the join page as ..." (`public.ts:207`), although the
  person came from a `/p/` link. That may be acceptable, but D4 should state it,
  as D4 already does for the transient-failure case.

**Fix.** Measure the TRIMMED id (`id.trim().length` in 1..200). Export or
mirror the 200 with a parity assertion. State the /join-shaped outcome of the
no-id branch.

---

## 3. [LOW] Section 5's enumerated e2e list omits the broadcast spec that pins the old string

`e2e/tests/dashboard-next/broadcasts.spec.ts:283` asserts
`getByText(/its flyer link won't work/i)`, which D8 removes. D8's catch-all
("Existing tests pinning the old strings are updated with them") covers it in
principle. But section 5's e2e bullets are the scheduled work, and that list
names only public-pages, listing-photos and environment-identity. Add it, so
gate 4 does not find it first. The app test title
`app/test/broadcastApi.test.ts:2162` ("flyer link would be dead") states the
retired reason too. It is cosmetic but still in a reader's path.

---

## 4. [LOW] Section 4's "known sites" still misses readers of the old rule

The grep rule in section 4 (`shareable`, `SHAREABLE`, `no longer available`,
`flyer link`) should catch these. I list them so the builder's sweep can be
checked against something:
- `dashboard/src/routes/broadcasts/RecipientPreview.tsx:87-89` ("a
  non-Available unit's flyer link is dead") and `:375-377` ("the flyer link
  only resolves while the property is Available"). D8 rewords the composer and
  broadcasts.ts comments but not these.
- `app/src/repos/activityEventsRepo.ts:74`; `dashboard/src/api/types.ts:3048-3049`.
- `dashboard/src/ui/StatusBadge.tsx:46`; `dashboard/src/routes/listing/ListingDetail.tsx:82-83`.
- `documentation/GLOSSARY.md:73` ("The shareable flyer") - outside the ~657-673
  range section 4 names.
- `app/src/lib/import/apply.ts:1622`; `e2e/scenarios/steps.ts:1033`.

---

## Adjudications contested

- **#2 (off market served forever).** I concede the decision: Cameron picked
  from an option that named the statuses. I do not concede the wording that
  closed it. See finding 1: the stated take-down path is false.
- **#13 (Interested on non-Available rows), deferred.** Concede. The same
  row is reachable today from a send to a home that later left Available, and
  the issue file states the new path accurately.
- **#15 (address-derived ids).** Concede. D2 now scopes the claim correctly.
- **#10 (transient failure credits the home).** Concede. Stating it as a
  consequence is enough.

## Fresh-eyes sweep: checked, nothing found

- `capture_source 'flyer'` / `unit_of_interest`: no dashboard or app reader
  beyond the consent mapping (`app/src/lib/smsCompliance.ts:112-123`, which
  treats flyer and housing_fair alike).
- Every property send goes through the broadcast guard. `INDIVIDUAL_SHARE_KEY`
  is legacy-seed only (`app/src/services/shareLedger.ts:83`), so D8's "Only
  Available properties can be sent" is true.
- The fallback's IntakeForm makes no fetch (`IntakeForm.tsx`), so
  `environment-identity.spec.ts`'s request counts still hold.
- No e2e asserts `listing_link` on a non-Available flyer. The two that read it
  use Available properties (`flyer-leads.spec.ts:183`, `:384`).
- The A2P resubmission text (`docs/a2p/campaign-resubmission.md`) does not tie
  the web-form opt-in to Available homes.
