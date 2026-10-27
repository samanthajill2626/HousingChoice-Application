# Design review adjudications - permanent flyer links

## Round 1 (spec rev 1 -> rev 2), 2026-10-27

Two opus reviewers, independent: R1-reviewer-a.md (10 findings),
R1-reviewer-b.md (13 findings). Merged to 15 items below. Claims about
existing behavior were spot-checked in the code before accepting
(BroadcastComposer.tsx:540-549, RecipientPreview.tsx:416-419 / :756-759,
units.ts outcome route ~1574-1664 has no listing-status check, Card.tsx:274-276
and :351-357 signed_up row is actionable, public.ts:279-286 unitId shape check).

| # | Finding (sources) | Ruling | Decision changed? |
|---|---|---|---|
| 1 | Broadcast staff copy says a non-Available flyer link "won't work"; D8 called it unchanged (A1, B1) | ACCEPT - new D8 rewords the three strings and two comments; the guard stays | Yes (new surface) |
| 2 | Off market served forever; Setup -> On hold never-launched served; rationale says "landlord may not be signed on" (A2, B4) | ACCEPT AS WORDING ONLY - the consequences and the take-down paths are now stated in D1/D7. REJECT re-asking Cameron: his pick "All but Setup" was from an option that named Off market and On hold explicitly | No |
| 3 | "Same-day tours available" and Same-day RTA on Occupied / Off market flyers not explicitly accepted (A3) | ACCEPT AS A QUESTION - put to Cameron 2026-10-27: keep the tours line (D3) | Folded into #4 |
| 4 | Goal 2 not delivered: the flyer links to the external listing, likely saying "no longer available" (B3) | ACCEPT - Cameron 2026-10-27 "Drop listing link only": D2/D3a null listing_link for non-Available; Goal 2 scoped to pages we serve | Yes |
| 5 | environment-identity.spec.ts:44 asserts the removed heading; missing from tests (A4, B5) | ACCEPT - added to section 5 | No (precision) |
| 6 | Existing "not shareable" tests use 'placed', not a listing status (A5, B9) | ACCEPT - section 5 points them at 'setup' | No (precision) |
| 7 | Comment/doc list incomplete; GLOSSARY and selectors.md missing (A6, B8) | ACCEPT - section 4 rewritten as a rule plus the known sites | No (precision) |
| 8 | Fallback note precedence (deleted + setup, unknown status); `deleted` computed after the flyer check; text-variant copy without a contact number (A7, B11) | ACCEPT - D7 ordered list, D4 copy | No (precision) |
| 9 | Fallback form sends an id the server rejects (blank / >200 chars) (A8) | ACCEPT - D4 sends unitId only when it passes the server's own shape check | No (precision) |
| 10 | Fallback on 5xx/network/429 credits a home the visitor never saw (A9, B10) | ACCEPT AS STATED CONSEQUENCE - D4; they did follow that home's link, and the fallback stays one page for every failure (no oracle) | No |
| 11 | e2e sign-up unit unspecified; seeded units are shared (A10, B7) | ACCEPT - section 5: run-unique properties via the API | No (precision) |
| 12 | Widens the public-signup abuse surface; D5 said "follows unchanged" (B2) | ACCEPT - D5 states the widening; the issue file is updated in the same change. Tightening limits stays a non-goal | Yes (new doc surface) |
| 13 | New properties-sent rows on non-Available homes show no status and offer Interested, which books a tour (B6) | DEFER - the same row already exists for a home that left Available after a send (pre-existing reachability); filed as docs/issues/sent-row-interested-ignores-listing-status.md; D9 / non-goals say so | No |
| 14 | Dashboard FLYER_PUBLIC mirror has no parity check (B12) | ACCEPT - a parity test per side pinning the six statuses | No (precision) |
| 15 | Address-derived unitIds make the flyer an address test for occupied homes (B13, UNVERIFIED exposure) | ACCEPT AS WORDING - D2 scopes "no existence oracle" to "nothing beyond holding the id"; the namespace lives only in the private repository | No |

Round 1 changed decisions (#1, #4, #12), so round 2 runs: reviewer B is
continued (it carried the most accepted unique findings: #4, #12, #13, #15).

## Round 2 (spec rev 2 -> rev 3), 2026-10-27

Reviewer B continued (R2-reviewer-b.md, 4 findings). It conceded #10, #13 and
#15, and conceded Cameron's decision on #2 but not the wording that closed it.

| # | Finding | Ruling | Decision changed? |
|---|---|---|---|
| R2-1 | "Take a flyer down by setting Setup" does not hold: Setup is a baseline status that derivation overwrites (verified statusModel.ts:321-337); the D7 note D1 cited does not exist | ACCEPT - D1 now says soft-delete is the only durable take-down and Setup is not offered as one; no new off switch (Sam wants links forever). Raised to Cameron at the spec gate as an open item | No (a withdrawn claim; nothing built changes) |
| R2-2 | D4 unitId rule ignores the app-wide trim; MAX_UNIT_ID_LEN is private; the no-unitId branch is a /join-style lead | ACCEPT - D4 trims, cites the constant, states the /join-style outcome | No (precision) |
| R2-3 | broadcasts.spec.ts ~283 and a broadcastApi.test.ts title pin the retired reason | ACCEPT - section 5 | No (precision) |
| R2-4 | More comment sites state the old rule | ACCEPT - section 4 list extended (the grep rule stands) | No (precision) |

Round 2 changed no decision: the review closes (terminal round, 2 of the
4-round cap). Spec rev 3 goes to Cameron's spec gate.
