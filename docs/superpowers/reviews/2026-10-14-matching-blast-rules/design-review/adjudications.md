# Matching blast rules - design review adjudications

Spec: `docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md`.
Planner adjudicates every finding: ACCEPT (doc edited), REJECT (why), DEFER
(filed). Severity is the reviewer's; "decision changed" is the planner's.

## Spec round 1 (rev 1 @002a34ce -> rev 2)

Two independent opus reviewers, same brief. Reports:
`spec-r1-reviewer-a.md` (13 findings), `spec-r1-reviewer-b.md` (13 findings).
Overlap was large: 9 of A's findings have a B counterpart.

| # | Finding | Ruling | Decision changed? |
|---|---|---|---|
| A1 / B1 | Prefilled authority silently drops tenants with no housing authority; spec called it "unchanged"; the /join sentence is wrong | ACCEPT. Put to Cameron 2026-10-14 (three options). Ruling: LEAVE THEM OUT AND SAY SO - the D8 caption gains a sentence; section 4 states it; the /join and flyer consequences corrected (/join "Not sure" stores no authority; a flyer sign-up starts Needs review with none). | YES (new rule + caption) |
| A2 / B5 | Section 7 inventory misses the specs and fakes the prefill and holds break (review-recipients-heard-from, a2p 8.3 test 1, broadcasts.spec test 1 and Warnme, org-lists composer tests, selectors.md contracts, the prefill unit test, the harness fake toursRepo, truncation-copy units) | ACCEPT. Section 7 rewritten with every named surface. Ruling on HOW the e2e specs are fixed: their tenants get an explicit on-list authority and an explicit status; no spec may depend on tenants another spec left in the lane (the Warnme order dependence). | no (inventory) |
| A3 / B2 | Fail closed on a seeds-only preview blocks every 1:1 and caseworker send though neither read can change a default | ACCEPT. Fail closed only when the draft resolves filter rows (`audience_mode !== 'seeds_only'`); a seeds-only preview serves its rows with no tour or decline labels and `audienceRulesUnavailable: true`, shown as a notice. | YES |
| A4 / B3 | Path (c) "exactly the rows the preview would check by default" contradicts its mechanism and the a2p e2e | ACCEPT. Slogan deleted. Mechanism stated: resolved audience minus holds minus effective declines; already-sent and no-consent are NOT subtracted (today's behavior; the fan-out skips no-consent and counts it). Truncation is refused on the resolved read as today; the recipient cap compares the final recipient count. | YES (stated set) |
| A5 | Dashboard truncation copy tells staff to narrow the filter, which no longer narrows the read | ACCEPT. Both dashboard lines and the server message drop the "narrow" advice. | no |
| A6 | Available-only picker also removes non-Available properties from the tenant-page and caseworker-page entry | ACCEPT with a ruling: Available-only applies to EVERY picker entry (Cameron's rule "only available properties can be picked for a blast", and every send already requires Available). Only a property preselected by `?unitId=` keeps the banner + Make Available path. Stated in D9 and section 4. | YES (stated) |
| A7a | Interested creates no tour when the pair already has an older request, so that tenant is not held | ACCEPT the correction (sentence fixed, gap stated). REJECT redesigning the hold clock to the latest Interested click: the request is still visible under Needs booking, and the rule Cameron set measures from the request. | no |
| A7b | needs_placement never expires; tours on a soft-deleted property keep holding | ACCEPT as stated exposures in section 4. The Past tab already lists Needs placement for staff to resolve; a deleted property's open tour closes on the two-week sweep. REJECT adding a units read to the hold (cost and scope). | no |
| A8 / B8 | "Page cap hit" names no cap; the toured partition also never shrinks | ACCEPT. The tour reads are unbounded like the sweep's (`listByStatus` walks every page); only a thrown error is a failed read. The false "only partition that never closes" claim is corrected. | YES (no cap) |
| B6 | Decline read cannot detect incompleteness (queryAll returns a prefix) | ACCEPT. D5 narrowed to a thrown error. | (folded into A8) |
| A9 / B11 | Joined checkbox name and Add-a-tenant annotation unspecified while e2e pins strings | ACCEPT. Literal formats given; a no-consent row keeps its consent-only name (today's rule). | no |
| A10 / B4 | Prefill depends on an org list the composer does not hold: loading, failure, all-off-list, 422 removal, more than 25 | ACCEPT. Specified: the composer reads the list; Preview waits until the prefill settles; a failed list read shows a notice and prefills nothing; all-off-list shows the not-used note plus "not limited by housing authority"; a 422 removal counts as an edit; the member cap is 100 (a shape guard - the prefill only ever uses listed names). Prefill also resolves a unique spelling to its entry name, as the server does. | YES (prefill edges) |
| A11 / B5 | "3-day-old tour request" needs a backdating seam no route has | ACCEPT the reviewer's alternative: the e2e uses a fresh request (same hold); the 14-day boundary is unit-tested. No new dev seam. | no |
| A12 | Caption "Add anyone else" over-promises (search is tenants only) | ACCEPT: "any other tenant". | no |
| A13 / B13 | "ONE normalizer" plus a dashboard twin; wire shape of a legacy filter unstated | ACCEPT. The SERVER normalizes on the wire: create echo, results and list projections always send `housing_authorities` and never `housing_authority`; the dashboard has no twin. | YES (wire shape) |
| B7 | "Existing notice naming it" names no authority | ACCEPT: new copy carries the name. | no |
| B9 | needs_placement hand-off to `placing` is best effort | ACCEPT as a stated rare exposure. REJECT reading active placements in the hold (scope). | no |
| B10 | D10 overstates the caseworker path | ACCEPT: reworded to "only as a seed or an explicitly checked row". | no |
| B12 | /join consequence half true (flyer leads) | ACCEPT (folded into A1). | no |
| B13 | audienceSummary list format; path (c) cap before/after | ACCEPT: names joined with ", "; cap after exclusions (folded into A4). | no |

Also folded into rev 2 (Cameron, 2026-10-14, not a review finding): the
"Reaches N recipients" count must equal the number of rows that start
checked. Rev 1 left it as "every match plus seeds". Rev 2: ONE server
function builds the review rows with `checkedByDefault`; POST create counts
them for `estimatedCount`; the dashboard uses the server flag instead of its
own copy of the rule. A throwing rules read at create omits the estimate
(draft still created). DECISION CHANGED.

Round 1 changed decisions (seeds-only availability, path (c) set, no read
cap, wire normalization, prefill edges, the no-authority rule), so round 2
runs: ONE reviewer, the same agent continued, with the re-review charge.

## Spec round 2 (rev 2 @31930df2 -> rev 3)

Reviewer A continued with the re-review charge (B's report handed over).
Report: `spec-r2-reviewer-a.md` (8 findings: 2 MEDIUM, 6 LOW). A conceded
A7a and A7b; it judged the other round-1 fixes correct except A2 (inventory,
still incomplete) and A10 (the settle gate).

| # | Finding | Ruling | Decision changed? |
|---|---|---|---|
| R2-1 | Select all on the server flag unchecks a row PROMOTED by Add a tenant (`RecipientPreview.tsx:294-301`), contradicting D4 and the kept note; pinned by `RecipientPreview.test.tsx:315-360` | ACCEPT. A row that becomes a hand pick on the review step (added or promoted) takes `checkedByDefault = hasConsent`; the pinned test must keep passing. | YES (client rule) |
| R2-2 | The prefill settle gate has no exit on a failed property load and is unscoped (resumed drafts, seeds-only) | ACCEPT. Gate only with a property attached and filters on; a failed property load settles with a notice; resumed drafts and seeds-only sends are never gated. | YES (gate) |
| R2-3 | Reach-at-create repeats the rules reads on every debounced message edit; moves the attempt-record read beyond preview; seeds-only creates read for nothing; equality only at create and below 1000 rows | ACCEPT: seeds-only creates make no rules read (count = seeds with consent); the per-keystroke cost is stated and accepted at today's volume (same reads as one Preview click); the ALONE comments are updated; goal 5 worded "equal when computed"; the 1000-row preview cap noted. REJECT a separate reach endpoint or skip-on-body-change protocol: more API for no measured cost. | YES (seeds-only) |
| R2-4 | Draft `stats.audience` changes meaning for unlisted readers; "To 0 recipients" cases | ACCEPT: readers listed; the meaning (default-checked) stated; "To 0" for a no-consent 1:1 draft is true; a create during a read failure stores 0 until recreated - stated. | no |
| R2-5 | Inventory: org-lists `:361`/`:477` count no-consent tenants; "explicit on-list authority" is not lane-independent unless run-unique; harness fake already filters status but has no order | ACCEPT all three: e2e tenants get consent and run-unique authorities where counts are asserted; the order test lives on `contactsPartitionFake.ts`. | no |
| R2-6 | The already-sent input fails open (partial set) while two inputs fail closed | ACCEPT as a stated exposure (today's soft-hint behavior, kept). | no |
| R2-7 | Edited filters silently carry over to a new property, while an edited message is reset | ACCEPT with a planner ruling: the prefill belongs to the property; changing the property applies the new property's prefill fresh and drops edits, no confirm (the filters are visible; mirrors the message reset rationale). | YES (behavior) |
| R2-8 | The caption names only blank authorities; off-list values are also left out | ACCEPT: "whose housing authority is missing or not on the organization list". | no |

Round 2 changed decisions (R2-1, R2-2, R2-3, R2-7), so round 3 runs with the
same reviewer continued. Hard cap is 4.
