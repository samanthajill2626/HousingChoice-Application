# Handback - permanent flyer links (build orchestrator, AUTO)

Branch `feat/permanent-flyer-links`, worktree `W:\tmp\permanent-flyer-links`.
Base main d0e2c2d8; ONE main sync at 49d9fd24 (main 71fb9b45 - WP1 B1 landed;
clean merge). Spec rev 3 (APPROVED), plan v2. Records:
`docs/superpowers/reviews/2026-10-27-permanent-flyer-links/`.

## VERDICT

BLOCKED ON ONE CAMERON DECISION (Q1) - otherwise complete: every work-map
item shipped, three gate batteries green (final on 3635160e), two review
rounds closed, live self-QA clean.

**Q1 (from code review R2-1, verified by the orchestrator):** spec D2 accepted
that an IMPORTED property's unitId is derived from its address because "the
namespace is in the private repository only". That premise is FALSE: the
`github` remote `samanthajill2626/HousingChoice-Application` is PUBLIC
(anonymous `GET api.github.com/repos/samanthajill2626/HousingChoice-Application`
-> HTTP 200, `"private": false`, `"visibility": "public"`), and the namespace
(`app/src/lib/import/ids.ts:24`) has been on its main since c4d9e069
(2026-08-05). So, with this branch, ANYONE who knows an address can compute
an imported property's id and get its flyer in every status but Setup -
including Airtable "Placed" homes imported as Occupied (homes where a
voucher household was placed), which were never Available in the app, so no
link to them was ever sent: for them the change buys no marketing, only
exposure (housing authority, voucher sizes, facts, interior photos). On main
these answered 404. Dashboard-created properties use random ids and are not
affected. Options (pick one):
- (a) Imported properties keep main's Available-only rule (`imported_from`
  set) in the flyer gate, the sign-up credit and the D7 line. Cost: an
  imported home's old links die when it leaves Available, as today.
- (b) A non-Available imported property is served only once it has been
  Available in the app (stamp on the move to available + a backfill from the
  listing-status audits). Keeps every link HC actually sent; closes the
  never-listed Placed book. Cost: a field, a backfill script + RUNBOOK
  entry, one more review round.
- (c) Accept with the true premise; re-record D2 (and reword the "no
  existence oracle beyond holding the id" comments, public.ts ~468 / ~873).
Making the repository private now cannot recall what has been public since
2026-08-05, and changing the namespace would re-mint every imported id
(breaking import idempotency and every link already sent).

**SEPARATE, LOUD (not this branch's to fix):** the whole repository is public
on GitHub (README.md:33 records the plan as a private repo).

When Q1 is answered: (c) = wording only (spec D2 + two comments + the abuse
issue's severity re-weigh) and a re-gate; (a) / (b) = a code follow-up on
this branch with tests, a fresh review and a battery.

## Work map

| Item | Result |
|---|---|
| T1 FLYER_PUBLIC + FLYER_PUBLIC_STATUSES (D1) | SHIPPED 1506ff7c |
| T2 flyer API serves FLYER_PUBLIC; listing_link null off Available, in the route (D2, D3a) | SHIPPED 579bc642 |
| T3 sign-up credit + pin ` (<Status>)` suffix; unused SHAREABLE import dropped (D5, D6) | SHIPPED dfb0bf50 (label via `isListingStatus` guard, WL-11) |
| T4 dashboard FLYER_PUBLIC mirror + cross-workspace test | SHIPPED 3f944265 |
| T5 FlyerPage neutral fallback (D4) | SHIPPED ed5d8848 (spec copy verbatim) |
| T6 property page flyer line (D7) | SHIPPED 7632e720 |
| T7 broadcast staff copy only; guard unchanged (D8) | SHIPPED 0459a08c |
| T8 docs + comment sweep incl. selectors.md fallback row | SHIPPED 9a5ef80b (+ FW1 8eebb336 for two lines the main merge brought) |
| T9 e2e (public-pages, listing-photos, environment-identity, broadcasts, Occupied sign-up in flyer-leads) | SHIPPED 98051455 (+ a fallback sign-up e2e, WL-38) |
| T10 main sync once, gates, self-QA, records | DONE (sync 49d9fd24, early - see below) |

Deviations (all recorded in the worklist / slice reports): the main sync ran
EARLY (after the slices, before review and self-QA) because main had moved
137 commits with WP1 B1 touching five of this plan's files - review and
self-QA saw the integrated code; extra tests beyond spec section 5 (an
off-list `placed` status at the route, the 200/201 unitId boundary on the
server, whole-payload equality across statuses, a fallback sign-up e2e).

## Gates on the FINAL code commit 3635160e (battery 3, bare, real exit codes)

Run 2026-10-28 04:24-04:45Z (`.superpowers/sdd/battery-3/summary.txt`):

| Gate | EXIT | Counts |
|---|---|---|
| 1 `npm run typecheck` | 0 | - |
| 2 `npm test` | 0 | app 545 files, 11798 passed + 1 skipped; dashboard 273 files, 5658 passed; e2e unit 22 files, 509; fake-twilio 34 files, 275; fake-twilio-web 13 files, 111 |
| 3 `npm run smoke` | 0 | - |
| 4 `npm run e2e` | 0 | 385 passed (17.2m) |
| 5 `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` | 1 | 37 files; 4 errors, all pre-existing (below) - no new error |

Earlier batteries: battery 1 on 49d9fd24 (all green, e2e 385 passed in
16.4m); battery 2 on d9ce3c56 (all green). Commits after 3635160e are
records-only (`docs/superpowers/`).

Gate 5 attribution (baseline = the same files at main via `git show main:<f>
| eslint --stdin`, normalized relpath|rule|message): the 4 errors are
PRE-EXISTING and baseline-identical - `react-hooks/set-state-in-effect` x2 in
dashboard/src/routes/public/FlyerPage.tsx (the variant effect, and the
`unitId === undefined` setStage - T5 renamed its kind literal only) and x2 in
dashboard/src/routes/broadcasts/BroadcastComposer.tsx (the prefill effects).
No new lint error; the new test file lints clean.

## Commits (code; records commits omitted)

1506ff7c T1 / 579bc642 T2 / dfb0bf50 T3 / 3f944265 T4 / ed5d8848 T5 /
7632e720 T6 / 0459a08c T7 / 9a5ef80b T8 / 98051455 T9 / 49d9fd24 main sync /
81a7bfd2 + 8eebb336 FW1 / 22ae56b2 + 78a553ef FW2.
Net vs main (excluding docs/superpowers/): 45 files, +1544 / -378.

## Review

- R1 conformance (spec-anchored, 30 mutants, 29 killed): conforms on every
  work-map item and D1-D9; C-1 MEDIUM (two old-rule lines arrived with the
  main merge), C-2 LOW (status label under another key survived), C-3/C-4
  INFO. All fixed in FW1.
- R1 adversarial (PLAN-BLIND): A-1 HIGH, A-2/A-3 MEDIUM, A-4..A-7 LOW, A-8
  INFO. Rulings in code-review/R1-adjudications.md: A-1, A-3, A-4, A-7
  REJECTED as code changes (spec-decided D1/D2/D3/D4); A-5 filed as an issue
  (pre-existing); A-6 fixed (server boundary test); A-8 fixed. A-2's REJECT
  was later WITHDRAWN as reasoned (R2-1 -> Q1).
- R2 (fresh, re-review of FW1 + what R1 missed + ruling challenge): R2-1
  BLOCKER decision-gated (Q1), R2-2/R2-3 LOW (fix-wave regressions, fixed in
  FW2), R2-4/R2-5 INFO (fixed / applied below). Upheld A-3, A-4, A-7, A-5,
  A-6, A-8d, C-5.
- FW2 is a tests + comments micro wave, verified by hand (diff read,
  publicIntake 74/74; its RED evidence against mutants vals2 / vals / facts5
  / lists1 is in code-review/FW2.md), then battery 3.

## Your eye (not blocking unless you say so)

1. (A-1, with R2-5) A served non-Available flyer is word for word the
   Available flyer minus the Listing row (spec D3): "Same-day tours
   available", the Same-day RTA row reading "Available", and two items you
   were NOT asked about separately - the thank-you "We'll text you about this
   home and others that fit your voucher." on an Occupied home, and the
   ?cta=text inbound "I'm interested in <address>" reaching staff with no
   status cue (every [FlyerLink] carries ?cta=text). "Home for rent" shows
   only for an addressless unit (the lean seed; imported units store parsed
   addresses).
2. (A-4) Fallback sign-ups carry no housing authority and start in Needs
   review (the spec's recorded assumption: the fallback sends the route
   unitId rather than becoming a /join-style sign-up), so an
   authority-filtered blast misses them until staff fill the authority in.
3. (R4-10) On an Occupied property's Sent to card and the contact's
   Properties sent row a sign-up shows the Signed up chip with Interested /
   Not interested, exactly as on an Available one (D9; screenshots
   qa-07 / qa-08). The sign-up itself creates no tour and no follow-up
   (verified across Today, Follow up and the tours routes).
4. (R1-14) The property forms tag "Public listing link" as On flyer; since
   D3a it shows on the flyer only while Available.
5. (R4-2) At deploy every imported "Placed" (Occupied) property starts
   serving its flyer and crediting sign-ups - the privacy side is Q1.
6. (C-5) WP1 B1's extraction PROPERTIES SENT block now also lists homes
   signed up from while Occupied / On hold ("signed up <date>") - D5's reach.
7. (A-3, A-7) Spec-accepted and recorded: the only durable take-down is
   delete; any failed flyer load shows the fallback (a 429 used to read "no
   longer available", so that is an improvement).

## Self-QA (live, lane 11) - self-qa.md

13 scenarios, no defect: Occupied flyer both variants at 375 / 1280 (photo,
address, no Listing row, no status word, no overflow); API key sets identical
across statuses, listing_link null off Available; fallback for a bogus id,
a Setup and a deleted property (identical opaque 404 body, both variants, no
retired words); a fallback sign-up (unitId sent, focused thank-you,
needs_review / housing_fair lead); credited sign-ups from Occupied and Under
application flyers; worst-case pin label ("(Under application)" + long
address + long name) wraps with no overflow at 375 / 1024 / 1280 / 1440 and
Send stays in view; property-page flyer line for Available / Occupied /
Setup / deleted; the D8 composer note; a 500 on the flyer API shows the
fallback. Screenshots: `W:\tmp\permanent-flyer-links\.playwright-mcp\qa-*.png`.

## Issues

- Filed: `docs/issues/broadcast-send-refusal-deleted-unit-copy.md` (bug,
  low, open; pre-existing on main).
- Updated: `docs/issues/public-signup-abuse-hardening.md` (D5 widening; the
  public namespace; refs refreshed; severity left for Q1),
  `docs/issues/unit-media-dangling-reference-race.md` (reach).
- Filed during design (planner): `sent-row-interested-ignores-listing-status.md`.

## Flakes, recoveries

No flake in any run. 14 children (4 readers, 5 slices, 3 reviewers, 2 fix
waves): 0 misfires, 0 recoveries.

## Merge state

NOT MERGE-READY until Q1 is answered. Branch tip at handback is a
records-only commit on top of the gated 3635160e; 0 behind main (71fb9b45).
UNMERGED (human gate). NO infra, no backfill, no new dependency, no env var
for the branch as built - option (b) of Q1 would add a backfill. Deploy is
Cameron's call.
