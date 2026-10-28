# R2 code review - permanent flyer links (fresh reviewer, round 2)

- Reviewer: R2 (fresh; read the spec, R1 reports and rulings, FW1, self-QA,
  the R2 and FW1 diff packages and the repo), 2026-10-28.
- Tree: `W:\tmp\permanent-flyer-links`, `feat/permanent-flyer-links`, HEAD
  d9ce3c56 (main 71fb9b45 merged at 49d9fd24). Line numbers are this tree.
- Battery 2 at this HEAD (`.superpowers/sdd/battery-2/summary.txt`):
  typecheck 0, smoke 0, npm test 0, e2e 0, lint 1 = the four pre-existing
  react-hooks errors (BroadcastComposer.tsx:426, :445; FlyerPage.tsx:223, :241).
- Probes: two throwaway `app/test/zz-review-r2-*.test.ts` files, created after
  `npmtest EXIT=0`, each run alone, then deleted; one mutation harness in the
  scratchpad (an in-memory transform of ONE module, never on disk, throws if
  its anchor is missing; `[r2-mutant] <name> APPLIED` printed on every run).
  No repo file was edited.

Result: BLOCKER 1, HIGH 0, MEDIUM 0, LOW 2, INFO 2.

## Findings

### R2-1 BLOCKER (decision-gated) - CONFIRMED - REGRESSION
The "private namespace" premise is false: the GitHub remote is public, so an
imported property's flyer - now served in every status but Setup - is open to
anyone who knows its address. Spec D2's acceptance and R1's A-2 REJECT both
rest on that premise.

Evidence
- `git remote -v`: `github` = github.com/samanthajill2626/HousingChoice-Application.
  An anonymous GET of api.github.com/repos/samanthajill2626/HousingChoice-Application
  (2026-10-28) answers 200 with `"private": false, "visibility": "public"`.
  An anonymous fetch of that repo's main `app/src/lib/import/ids.ts` returns
  the namespace line (:24) and `unitIdForAddress` (:84). Locally,
  `github/main` has carried ids.ts:24 since c4d9e069 (2026-08-05).
  README.md:33 records the original plan as a private GitHub repo.
- The premise, as written: spec :133-136 ("the namespace is in the private
  repository only. Accepted."). Design-review adjudications.md:28 (#15) says
  "the namespace lives only in the private repository". That ruling closed
  reviewer B's finding 13 (R1-reviewer-b.md:296-306), which was explicitly
  "UNVERIFIED: whether the repository (and so the namespace) is ever exposed.
  If it is not, this is moot". R1-adjudications.md:23 (A-2 REJECT) cites the
  same spec line. Nobody verified it.
- Code:
  - The importer's id is uuidv5("unit:" + normalizeAddress(cell)): apply.ts:1483,
    ids.ts:24 and :84-86. addresses.ts:84-91 only lowercases and strips
    commas, periods and extra spaces, so casual spellings collide.
  - Airtable "Placed" maps to `occupied` (apply.ts:1616-1619).
  - The branch serves occupied: public.ts:870 and statusModel.ts:298-305.
    Main answered the opaque 404 (SHAREABLE only).
  - Dashboard-created ids are random (unitsRepo.ts:1259) and are not affected.
- Proof: the throwaway test `zz-review-r2-namespace.test.ts` (deleted).
  - It has its own uuidv5, written from the namespace string alone. Fed
    "742 evergreen ter  atlanta GA 30303", it gives the same id as the
    importer's for the cell "742 Evergreen Ter., Atlanta, GA 30303".
  - GET `/public/units/<that id>/flyer` on an occupied unit answers 200, with
    the address, `accepted_authorities` ['Atlanta Housing Authority'] and the
    photo URL.
  - The id computed for the house next door answers 404.
  - `SHAREABLE_STATUSES.has('occupied')` is false, so main would 404 this unit.

Consequence
- For an imported property, "holding the id" is the same as knowing the address.
- Anyone with the public source and a list of addresses can test them at
  5 a minute per IP (config.ts:1041, app.ts:185-191). Each hit tells them the
  home is in HC's book in some status other than Setup - including Occupied
  homes where HC placed a voucher household.
- It also returns the home's housing authority, voucher sizes, facts and
  staff-uploaded photos, often of the interior.
- Imported "Placed" homes were never Available in the app, so no flyer link to
  them was ever sent. For them the change buys no marketing, only exposure.
- Cameron accepted "the occupied home staying public" (intent.md:36) for
  people who hold a link. D2 accepted the address case only because the
  namespace was private.
- The number of such properties in prod was not measured (the live-stack rule).
- The same computed ids feed the sign-up abuse surface; see R2-2.

Fix
- Put D2 back to Cameron, with the true premise, before merge. Options:
  - (a) Keep main's Available-only rule for units with `imported_from` set
    (apply.ts:1495), in the flyer gate (public.ts:870), the credit
    (public.ts:534) and D7 (ListingDetail.tsx:429). Cost: an imported home's
    old links die when it leaves Available, as they do today.
  - (b) Serve a non-Available imported unit only after it has been Available
    in the app: stamp the unit on its move to available, and backfill from the
    `listing_status_changed` audits. This keeps every link HC actually sent
    and closes the never-listed Placed book.
  - (c) Accept with the true premise and re-record D2.
- Whichever he picks, reword public.ts:466-467 and :871-872 ("no existence
  oracle beyond holding the id") to match.
- Separately from this branch, the repository itself is public. Making it
  private now cannot recall what has been public since 2026-08-05.

### R2-2 LOW - CONFIRMED - REGRESSION (fix wave)
FW1's new sentence in `docs/issues/public-signup-abuse-hardening.md` treats the
namespace as a secret.

Evidence
- Point (d), :147-150: "so anyone holding the namespace can compute a public
  unitId from an address". The namespace is public (R2-1), so the condition
  limits nothing: anyone can mint a public unitId for an imported property and
  use it for (c) and (d).
- The same file, :103-104, still quotes the pin as "Signed up from the flyer
  for `<address>` as `<typed first last>`". It does not show the D6 status
  suffix (" (<Status>)" before " as").

Consequence: the issue understates its own reach. Whoever triages the open
`med` issue reads the minting angle as needing an insider.

Fix: "so anyone can compute ... (the namespace is in the public GitHub
repository, ids.ts:24)". Add the optional status suffix to the quoted label.
Re-weigh the issue's severity when R2-1 is decided.

### R2-3 LOW - CONFIRMED (unit layer; e2e by reading) - REGRESSION (fix wave comment)
FW1's six-status test says it pins "nothing status-derived under any other
key". It does not.

Evidence
- What the test claims: app/test/publicIntake.test.ts:540-543.
- What it checks:
  - the key set and the top-level keys (:571-572);
  - the raw status and its label as strings (:575-582);
  - `listing_link`, `media` and `contact_number` (:584-586).
- Its fixture, `seedFullUnit` (:338-372), records no `video_url`,
  `same_day_rta`, `application_fee`, `washer_dryer` or `utilities`, so those
  keys are null for every status.
- Mutant `vals2`, at public.ts:885: off Available it sends
  `accepted_authorities: []`, `voucher_sizes: []` and `voucher_size: null`.
  Same keys, no status word. It passes publicIntake, publicSignupLeads,
  propertyFormFlyerParity and unitFields (249/249).
- Mutant `vals` (vals2 plus `same_day_rta: null` and `video_url: null`) passes
  254/254.
- By reading, no e2e checks the "Accepts:" line or the voucher line on a
  non-Available flyer: flyer-leads.spec.ts:730-822, listing-photos.spec.ts:309-350
  and public-pages.spec.ts:621-637. So `vals2` survives the whole suite.
- R1's M16 is still killed: `m16` fails 5 tests (:572), as FW1 reported.

Consequence
- Spec D3 ("renders exactly as an Available one does today, whatever the
  status") has no check on these values.
- A later change that strips facts off Available would be both a D3 breach and
  a status signal under existing keys, and it would ship green.
- The comment tells the next reader the opposite.

Fix
- In the it.each, seed every public field: `video_url`, `same_day_rta`,
  `application_fee`, `washer_dryer` and `utilities`.
- Assert that `{ ...res.body.flyer, listing_link: null }` deep-equals the
  Available run's payload with `listing_link` null, or a literal expected
  object.
- Or reword :540-543 to say what the test actually pins.

### R2-4 INFO - CONFIRMED - NOT A REGRESSION
The new issue `docs/issues/broadcast-send-refusal-deleted-unit-copy.md` leaves
one path "Not checked". It reaches the same misleading copy, and it also writes
to a deleted property.

Evidence
- `setListingStatus` (app/src/services/statusTransition.ts:684-703) never looks
  at `deleted_at`.
- Throwaway test `zz-review-r2-deleted-gate.test.ts` (deleted):
  - a draft for an On hold unit-1;
  - `DELETE /api/units/unit-1` answers 200;
  - the dialog's `PATCH .../listing-status {available}` answers 200: the
    stored status is now available and `deleted_at` is still set;
  - the send answers 400 `unit_not_available`.
- That 400 is the code the dashboard words as "make it Available, then send"
  (RecipientPreview.tsx:420).
- The same flow ran on main with the old copy.

Consequence
- "Make Available & send" on a property deleted while not Available changes
  the deleted property's status, with an audit row, and still fails.
- Staff then read "make it Available" about a property that now reads
  Available. A later restore brings it back as Available.

Fix
- Replace the issue's "Not checked" paragraph with this trace.
- The issue's suggested fix (a `deleted_at` pre-flight check, or a distinct
  refusal code) covers both paths. Optionally refuse `setListingStatus` on a
  deleted unit.

### R2-5 INFO - CONFIRMED - NOT A REGRESSION (records)
R1's A-1 ruling says more than was actually put to Cameron.

Evidence
- R1-adjudications.md:22 says design review "R1 #3/#4 put exactly this to
  Cameron".
- #3 (design-review adjudications.md:16; R1-reviewer-a.md:86-103) asked only
  about the tours line and the Same-day RTA row. #4 asked about the listing
  link (intent.md decision 4).
- Two parts of A-1 were not put to him on their own:
  - the thank-you promise "We'll text you about this home and others that fit
    your voucher." (FlyerPage.tsx:462, :471) on an Occupied home;
  - the staff-cue gap: every [FlyerLink] carries `?cta=text`, and those inbound
    texts read "I'm interested in <address>" (FlyerPage.tsx:156-163, :445-446)
    with no status.
- Both rest only on D3's general "the variant's CTA". The ruling still stands
  on D3, which Cameron approved.

Fix: the handback's "your eye" line for A-1 should name those two items, so
the decision covers them explicitly.

## 1. What round 1 missed (the sweep)

Found: R2-1, by checking the premise the A-2 ruling rested on. Checked with
nothing found:
- Flyer gate and credit: public.ts:534 and :870 match each other and FLYER_PUBLIC.
  `toUnitFlyer` has one caller (public.ts:880). The repeat-check source
  (:712), the pin (:755-761) and the ledger branch (:782-798) all follow
  viaFlyer. The welcome text does not depend on the unit (:664-690).
- Credit readers:
  - `unit_of_interest` has no product reader.
  - `capture_source` 'flyer' maps to web_form like 'housing_fair'
    (smsCompliance.ts:106-123).
  - The join-authority backfill only touches pre-v2 contacts; it is DONE
    (RUNBOOK.md:452).
- Ledger readers:
  - Follow up and Today's quiet shares walk Available units only
    (followUps.ts:4-5).
  - Audience "already sent" reads broadcasts, not the ledger
    (shareRecipientState.ts:249). Declines use outcomes (broadcasts.ts:595-622).
  - Timeline "Property sent" words read each pin's own share
    (contactTimeline.ts:725-754).
  - The WP1 B1 PROPERTIES SENT block (C-5) needs no change.
  - B1's tenantMatchingInputs and propertyLabel read no unit status.
  - `priority` stays off the flyer: the FW1 key-set test now pins it for every
    status.
- "Never create or say a tour" (intent decision 6):
  - A sign-up writes no tour.
  - signed_up files under Interested (listingFormat.ts:353), but only a staff
    click acts.
  - "Request a tour" is offered on partner rows only (ListingDetail.tsx:1372-1378),
    and flyer entries are written for tenant or unknown contacts only.
  - Tours to book lists requested tours only (today.ts:733).
- Status and soft-delete writers:
  - `setListingStatus` takes any listing status (statusTransition.ts:684-703).
  - Derivation never yields Setup (statusModel.ts:426-443).
  - The import writes status `if_not_exists` (apply.ts:1493) and never touches
    `deleted_at`, so deletion survives a re-import.
  - softDelete and restore change only `deleted_at` (unitsRepo.ts:1397-1427).
  - `isDeleted` is the same predicate on both sides (unitsRepo.ts:598-600;
    ListingDetail.tsx:422).
- Caching and other surfaces:
  - /public/* is not cached at the edge (infra/modules/cloudfront/main.tf:158-166).
  - Perf excludes /p/ (e2e/performance/routes.ts:117).
  - No server-side meta tags exist for /p/.
  - Scripts and seeds hold no flyer-status assumption.
- e2e:
  - No other spec relies on a non-Available 404.
  - unit-0001 and unit-0002 are only read. Every status derivation can give
    unit-0001 is served, so public-pages (d) holds whatever other specs do to
    placement-0001.
- Old-rule wording, swept again: nothing new outside the R1 and FW1 LEAVE
  lists. RUNBOOK.md:456 is backfill history.
- A-4's consequence is true: authority-filtered blasts leave out leads with no
  authority (audienceResolution.ts:203-208).

## 2. The fix-wave diff, cold

- Tests:
  - The key-set and label checks are real (m16 is killed). The comment
    overclaims (R2-3).
  - The A-6 boundary tests are real: re-checked with `cap100`, both accepts
    rows fail.
  - The C-3 titles are fine.
  - No FW1 assertion passes vacuously. `not.toHaveProperty('status')` is now
    redundant with the key set but harmless.
- Comments:
  - unitsRepo.ts:477-479, public.ts:56-58, publicApi.ts:5-9 and the e2e
    reasons (broadcasts.spec.ts:85-87, :135-139, :354-357;
    matching-entry-points.spec.ts:22-23, :59-61) are accurate.
  - selectors.md:145 and property-priority.spec.ts:142-145 state the new rule
    correctly.
- Issue files:
  - public-signup-abuse-hardening.md: every public.ts and test citation I
    sampled matches this tree (:209-226, :256, :268-275, :442-445, :560-597,
    :613, :656, :710-767, :781-798, :791; test :840-851). The namespace
    sentence is wrong (R2-2).
  - broadcast-send-refusal-deleted-unit-copy.md: its stated evidence matches
    the code (broadcasts.ts:1187-1193, RecipientPreview.tsx:374-397 and :420,
    units.ts:1025-1038). Its unchecked path is traced in R2-4.

## 3. Round-1 rulings challenged

- A-2: rests on a false fact - R2-1.
- A-1: overstates what Cameron was asked; the ruling itself stands on D3 - R2-5.
- A-3: holds.
  - D1 states the take-down consequences in full.
  - Cameron's spec-gate words are recorded (intent.md decision 5).
  - Indexing is a section 6 non-goal.
  - The D7 Setup note is the spec's exact string.
- A-4: holds. The intent record (Assumptions) says the fallback sends the route
  unitId rather than becoming a /join-style sign-up. Its consequence is true
  (section 1). It goes to the handback.
- A-7: holds. D4 says "any other fetch failure (5xx, network, 429) render it
  identically", and design review #10 accepted one page for every failure.
  Noted: before the branch a 429 read "no longer available", so the branch is
  an improvement there.
- A-5 (pre-existing; main's copy had the same shape), A-6 (spec D4 chose a
  cited copy), A-8d and C-5: hold.

## 4. Are the FW1 fixes real?

- C-1: real.
- C-2: real at the key and string level, not at the value level (R2-3).
- C-3, C-4a, C-4b, C-4c: real.
- A-2 doc line: present but wrong (R2-2).
- A-5 filing: accurate but incomplete (R2-4).
- A-6: real (cap100).
- A-8c: done for the two headers named. Four sibling comments still list three
  404 causes (public.ts:466-467 and :871-872, publicApi.ts:80-81,
  FlyerPage.tsx:16 and :252). FW1 itself flagged them; they are comments only.
