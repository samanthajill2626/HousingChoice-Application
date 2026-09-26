# Planner independent review - adjudications

Branch: `feat/inbox-rows-timestamps`, reviewed at 967ef4ab (handback commit;
code tip d9339c08, final build gates on b242b7d6).
Reviewers: spec-conformance (`planner-review-conformance.md`, 12 findings,
94 spec items: 86 delivered / 8 deviated / 0 missing) and plan-blind
adversarial (`planner-review-adversarial.md`, 11 findings). Both read-only.
Adjudicator: the planner (this session), 2026-09-26. A finding is a claim;
each ruling below names what was checked.

## Counts

- Conformance: 12 findings - 9 accept, 2 to the human (product calls, not
  defects), 1 note. Adversarial: 11 findings - 6 accept, 2 reject
  (deliberate, ruled trade-offs the plan-blind reviewer could not see),
  3 already filed by the build. Decisions changed: 0. Runtime code changed
  by the fix wave: 0 (one comment).

## Conformance findings

1. MEDIUM, the row CSS Sam approved "as drawn" changed in overflow cases by
   build-review adjudication (R2-1 head never yields; R3-1 placement tag and
   Needs triage yield to a 4em floor; SQ-1 phone-named row never shrinks)
   with no Sam or Cameron ruling. TO THE HUMAN. Not a code defect; the
   handback already flags it with the one-rule revert. Live QA measured the
   shipped rule at 1280, 768 and 360 (`planner-live-qa.md`): at 1280 nothing
   clips; at 768 with the sidebar open the rows are about 370px of content
   and long names ellipsize, a relay row carrying a rigid Closed chip keeps
   three letters of its name; at 360 the two-line layout shows names and
   chips both ellipsized but readable. Verdict item for Cameron.
2. MEDIUM, the placement, Closed and Deleted chip geometry was never
   measured in a browser on the shipped tree. ACCEPT, CLOSED BY LIVE QA:
   lane 16, full profile plus two DB-seeded rows (a placement-tagged tenant,
   a soft-deleted contact with a fresh inbound) and a DOM-injected Closed
   chip on a relay row, measured at 1280, 768 and 360. Numbers in
   `planner-live-qa.md`. No row overflows at any width; the time column is
   straight (17px right offset on every row).
3. LOW, 5.3 not written back (module-level formatters, AD-1). ACCEPT. Spec
   DRAFT 8.6.
4. LOW, 5.10 key not written back (`JSON.stringify` pair). ACCEPT. DRAFT 8.6.
5. LOW, no branch-I test on the Groups filter. ACCEPT. Added to
   `inboxListMerge.test.ts` (fix wave).
6. LOW, the perf command differs from the spec's bare form and ran before
   e2e run 2. ACCEPT the write-back (DRAFT 8.6 names the command that runs
   and "on the final code commit"); same commit, no overlap, so the order is
   immaterial.
7. LOW, handback counts off (15 issue files not 16; +10186 excludes review
   records; 45 branch commits after a554dcd5 not 96; the relay re-run reused
   lane 16 at 23:32 on dc0390e4, not a fresh lane at HEAD). ACCEPT. A
   "Planner corrections" section is appended to the handback rather than
   rewriting the builder's text.
8. LOW, `handback.md` still reads MERGE-READY-PLACEHOLDER. ACCEPT. Filled
   with the verdict pointer in the verdict commit.
9. LOW, the overlay issue cites stale lines. ACCEPT. Refs updated to
   `InboxRow.tsx:147`, `InboxRow.module.css:201` and `:217`.
10. LOW, five spec wording errors the builder reported. ACCEPT. DRAFT 8.6:
    the nav badge's NavLink navigates, not the badge; 5.8's PUSH list adds
    the two QuickReply links; section 2 names `useOptionalAuth()?.me?.userId`
    (not `useMe`); 5.11's reason is "short page, no cursor, no sentinel";
    the `filtered` drop count is written in the loop.
11. LOW, one non-ASCII added line in `plan-r1-reviewer-b.md` (a quoted
    describe title with an em dash). NOTE, left as is: it is a verbatim
    quotation of existing source, which the ASCII rule exempts.
12. LOW, the planner's diff-read note sat in the ignored tree. ACCEPT. Folded
    into `planner-review-verdict.md` (section "The planner's own read").

## Adversarial findings

1. MEDIUM, `overflow-anchor: none` on the page root disables scroll
   anchoring for every live update, so rows slide under a scrolled operator
   and a mis-click can open and mark read the wrong row. REJECT AS A DEFECT,
   SURFACE TO THE HUMAN. This is spec 5.2 and section 8, chosen on purpose
   and re-argued at build review AD-2: on the All tab an appended page sorts
   ABOVE the old group rows at the bottom of page one, so with a visible
   group row as the anchor the browser would raise `scrollTop`, keep the
   sentinel inside the margin and chain auto-load (e2e test 6 pins against
   that). The reviewer's mis-click consequence is real and not previously
   written down; it is now in the verdict for Cameron, with the alternative
   (scope the rule to the sentinel and button and accept possible chaining at
   the group wall).
2. MEDIUM, the back-button restore only survives a reconcile inside page one.
   REJECT AS A DEFECT. This is Option B, Cameron's 2026-09-25 gate ruling,
   with the deferred design and the boundary-page cost recorded in
   `docs/issues/inbox-loaded-pages-survive-refresh.md`. The reviewer was
   plan-blind by rule.
3. MEDIUM (magnitude unverified), head reads grew from 30 to 100 rows on
   paths the prefetch does not cover: Unread hydration is sequential and the
   All-tab placement label is read in the loop. ACCEPT AS DEBT, no change.
   Unread was filed by the build (`inbox-unread-page-hydration-sequential`);
   the placement-label read is now a paragraph on that issue. The All-tab
   magnitude WAS measured for the prefetched reads: `perf:pages` self-QA
   passed on b242b7d6 (62 samples). The seed carries no placement-tagged
   inbox rows, so that read's cost is unmeasured, and the issue says so.
4. LOW, the stop-flag test cannot fail without the stop flag (mutant
   reproduced). ACCEPT, FIXED. The test now waits for the read count to be
   stable before judging it. Proven both ways on 2026-09-26: with both
   `prefetch?.stop()` calls deleted the test fails ("expected 25 to be less
   than or equal to 9"); with the shipped code it passes.
5. LOW, the prefetch reads past the fill point, WARNs after the assembled
   line for off-page rows, and the equivalence "off" arm reads through the
   caches rather than main's uncached path. ACCEPT AS NOTED. Spec 5.10 now
   states all three. No code change: the overshoot is bounded by
   `HYDRATE_CONCURRENCY`, the WARNs fire only on failed best-effort reads,
   and the seam's job is to switch the PASS off, which is what the suite
   proves.
6. LOW, an incomplete head read keeps a restored list unarmed and rows read
   elsewhere at stale counts; on Unread a full page with an unresolved
   lag-drop is truncated, so this is common right after an inbound on a busy
   inbox. ACCEPT AS DESIGNED RESIDUE, FILED:
   `docs/issues/inbox-incomplete-head-read-keeps-stale-rows.md` (low).
   Verified the truncation rule at `app/src/routes/inbox.ts:1749`
   (`unresolvedDrops > 0` sets `truncated`).
7. LOW, stale `SEEN_SET_MAX` comment ("~4 pages, 120+ rows"). ACCEPT, FIXED
   (comment only): the cap trips once more than 100 ids sit behind the
   cursor, the end of page two at the 100-row page, about 200 rows.
8. LOW, the action overlay covers the time on hover and focus-within.
   ALREADY FILED by the build (`inbox-time-title-unreachable-under-actions-overlay`,
   AD-3). Note only.
9. LOW, no midnight timer. ALREADY FILED
   (`inbox-labels-do-not-roll-over-at-midnight`). Note only.
10. LOW, `isPhoneName` matches NANP formatting only; a non-US number can lose
    digits. ACCEPT AS NOTED, NOT FIXED HERE: the server formats only NANP
    numbers (`formatPhoneForDisplay` returns others unchanged as E.164), the
    product is US-only, and widening the regex is a runtime change that
    would re-open the e2e gate for a case with no current instance. Noted in
    the verdict; a one-line follow-up if a non-NANP contact ever appears.
11. LOW, the CSS tests check stylesheet text, not layout; the overlay test
    does not pin `.row { position: relative }`; e2e test 6's counts rest on a
    measured row height. ACCEPT the pin (added to `InboxRow.styles.test.ts`);
    the rest is the stated limit of source-reading pins (the file's own
    header says the live self-QA measures geometry, which this review did).

## Fix wave (planner, 2026-09-26)

Test and comment changes only; no runtime behavior changed:

- `app/test/inboxFeed.test.ts` - stop-flag test settles the read count
  before judging it (adversarial 4; mutant-proven red, shipped code green).
- `app/src/routes/inbox.ts` - `SEEN_SET_MAX` comment (adversarial 7).
- `dashboard/src/routes/inbox/InboxRow.styles.test.ts` - `.row` positioning
  pin (adversarial 11).
- `dashboard/src/routes/inbox/inboxListMerge.test.ts` - Groups-filter
  branch-I case (conformance 5).
- Spec DRAFT 8.6 write-backs (conformance 3, 4, 6, 10; adversarial 5).
- Issues: refs fixed on the overlay issue (conformance 9); placement-label
  paragraph on the hydration issue (adversarial 3); new
  `inbox-incomplete-head-read-keeps-stale-rows` (adversarial 6).
- Handback: "Planner corrections" section (conformance 7); verdict pointer
  (conformance 8).

All five gates re-run on the fix-wave commit; exit codes in
`planner-review-verdict.md`.
