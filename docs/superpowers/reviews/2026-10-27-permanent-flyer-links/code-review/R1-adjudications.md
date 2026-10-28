# Code review round 1 - adjudications (orchestrator)

Branch feat/permanent-flyer-links @ 49d9fd24 (main 71fb9b45 merged in). Two
parallel reviewers: `R1-conformance.md` (spec + plan + worklist anchored; 30
in-memory mutants, 29 killed) and `R1-adversarial.md` (plan-blind by mandate).
Battery 1 at the same HEAD: typecheck 0, smoke 0, npm test 0, e2e 0 (385
passed), lint 1 = the four pre-existing react-hooks errors only (baseline
comparison against main: identical rule/message rows; the new test file
lints clean).

Every load-bearing claim below was checked in the code by the orchestrator.

| # | Finding | Ruling | Why |
|---|---|---|---|
| C-1 | Two old-rule statements arrived with the main sync: e2e/support/selectors.md:145 (Priority row: "any other status answers the unavailable page") and property-priority.spec.ts:142-143 ("the flyer answers only for an Available property") | FIX (FW1) | spec section 4: every comment/doc saying Available gates the flyer is updated; the sweeps ran before the sync. Re-run both WL-35 regexes plus a wrap-tolerant one after the fix |
| C-2 | Off Available the "no status field" test checks only the `status` key and the raw value; a label under another key survives (M16) | FIX (FW1) | D2 "the payload gains NO status field" is a public-oracle rule; assert the exact key set for every status and that neither the raw value nor the label appears (case-insensitive) |
| C-3 | it.each titles read "a occupied" | FIX (FW1) | cosmetic, one line each |
| C-4a | e2e comments still give "unit-0001 MUST stay under_application for public-pages.spec.ts" as the reason (broadcasts.spec.ts, matching-entry-points.spec.ts) | FIX (FW1) | the rule (never move a seeded unit) stands, the reason is stale; reword the reason only |
| C-4b | unitsRepo.ts `/** Public flyer link. */` labels `listing_link`, the EXTERNAL listing URL | FIX (FW1) | pre-existing mislabel made more misleading by D3a; one comment line |
| C-4c / A-8b | public-signup-abuse-hardening.md `refs:` and body cite public.ts ranges this branch shifted | FIX (FW1) | refresh to the live ranges (cite symbols where possible) |
| C-5 | WP1 B1's PROPERTIES SENT extraction block (merged from main) lists flyer rows with no status filter, so homes signed up from while Occupied / On hold now reach the prompt | NO CHANGE - handback line | D5's stated reach; D9 keeps the rows status-free; the reader postdates the spec |
| A-1 (HIGH) | A served non-Available flyer still reads as open: "Same-day tours available", the Same-day RTA row, "Interested in this home?", "We'll text you about this home", the "Home for rent" heading when no address; the ?cta=text inbound gives staff no status cue | REJECT as a code change - spec-decided; HANDBACK "your eye" | Spec D3 ("renders exactly as an Available one does today ... 'Same-day tours available' kept on every flyer ... The page has no status input") and D2 ("no status field"); design review R1 #3/#4 put exactly this to Cameron, who chose "Drop listing link only" and to keep the tours line; Sam asked for the links "as a marketing method". The reviewer's proposed `open` boolean is a status input D2/D3 rule out. "Home for rent" shows only for an addressless unit: imported units store a parsed address (apply.ts:1487), so it is the lean seed's case, not prod's |
| A-2 | Imported unitIds are uuidv5(address) with the namespace in source, so "no oracle beyond holding the id" is false for them; occupied imports are now served; ids can be minted for the abuse surface | REJECT the gate change (spec D2 accepted it: "Imported unitIds are derived from the address ... the namespace is in the private repository only. Accepted." - design review R1 #15). FIX (FW1) the doc: public-signup-abuse-hardening.md gains one line that imported ids are computable from an address by anyone holding the namespace, so they count as known ids for points (c)/(d) | the minting angle is new to the issue text and costs one sentence |
| A-3 | No non-destructive durable take-down; the D7 Setup note "implies staff control"; Off market served forever; a never-Available property goes public on its first placement; no noindex | REJECT - spec D1 accepted consequences verbatim; Cameron at the spec gate: "We don't need to turn this off"; indexing is a spec section 6 non-goal; the D7 copy is the spec's exact string and claims no staff control. Handback: one line | |
| A-4 | The fallback form replaced main's /join link: no housing authority asked, leads start in Needs review | REJECT as a code change - spec D4 + intent "Assumptions made on Cameron's behalf" (the fallback still sends the route unitId rather than becoming a /join-style sign-up). HANDBACK "your eye": the stated consequence (no authority on these leads, so an authority-filtered blast misses them until staff fill it in) | it was an assumption, not an explicit Cameron answer |
| A-5 | The D8 400 copy tells staff to "make it Available" for a soft-deleted unit that reads Available (pre-flight reads status only; the server refuses deleted with the same code) | FILE as an issue (FW1) - PRE-EXISTING: main's copy had the same shape ("This property isn't Available, so its flyer link won't work. Make it Available, then send."); D8 changed only the reason. Out of scope | |
| A-6 | The fallback's copy of the 200 cap has no drift guard; a server cap mutant (64) passes every app test | FIX (FW1) the server half: app test - a 200-character unitId is accepted, 201 refused with the generic 400, and a 200-character id with surrounding spaces is accepted (the app-wide trim). REJECT moving the constant to a leaf module (spec D4 chose a cited copy) | the dashboard copy is pinned by FlyerPage tests; the server side was unpinned |
| A-7 | Any 5xx / 429 / network failure renders the fallback with no retry; the text variant loses the number | REJECT - spec D4: "All three 404 causes and any other fetch failure (5xx, network, 429) render it identically"; design review R1 #10 accepted it | |
| A-8a | selectors.md:145 | = C-1 | |
| A-8c | The 404-cause lists (publicApi.ts header, public.ts route header) omit a stored status outside the listing statuses | FIX (FW1) - comment only | the route comment already says it |
| A-8d | The abuse issue dates the change 2026-10-28 | LEAVE | `updated:` is the edit date |

Fix wave FW1 = C-1, C-2, C-3, C-4a, C-4b, C-4c, A-2 (doc line), A-5 (issue
filing), A-6 (server boundary test), A-8c, plus any live self-QA findings.
One fresh child; then a FRESH re-review of the fix diff; then battery 2.
