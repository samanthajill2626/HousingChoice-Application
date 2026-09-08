# Plan review R1 - adjudications

Round 1 on the implementation plan: two reviewers - one cold (A, 28 findings),
one continued from the four spec rounds (B, 14 findings). 42 findings, all
accepted in substance. Four are blocking and three of those were found
independently by both, which is the strongest signal this round produced.

Two findings correct the SPEC, not the plan, and are fixed there (A21, A28).

---

## Blocking - all four fixed in plan revision 2

**1. D12's leg copy has no storage field (A1, B1).** Task 1 declared five lineage
fields, none of them the leg copy, while Tasks 5 and 6 both consume one. The whole
point of D12 is that the row stores the RAW body while the LEG carries the
composed copy, so a sender renamed between attempts cannot rewrite history - and
the field that carries the second half was never created. A sixth stored value,
`relay_retry_leg_body`, server-side only.

**2. `EffectiveRelayLeg` cannot replace the slot (A3, B2).** It was declared as
`{status, errorCode?, retryState?}` and handed to consumers that need
`sentAt`, `deliveredAt`, `transportAggregationState`, `requestedTransport` and
`actualTransport` - `includedRecipientEntries` (`deliveryStatus.ts:407`),
`isStaleLeg` (`:415`), `recipientRowTime` (`Timeline.tsx:499`) and the row's
transport line (`:1118-1119`). A also notes it would break the FENCED native
group-text product. It now EXTENDS `RelayDeliverySlot` and adds `retryState`.

**3. The ordering claim is false (A4, B4).** After the claim task the server
appends real retry rows while D20's `visible` filter does not land until the
Timeline task - so in between, every relay thread renders up to three unfiltered
duplicate bubbles, and an inbound retry duplicates the member's own message,
which is the exact outcome D20 exists to prevent. The self-review asserted the
opposite and I repeated it to the founder.

Fixed by REORDERING, not by a design change: the wire fields, the join and the
render filter now land BEFORE the claim. A filter with no retry rows to filter is
a no-op, so the early tasks are safe in a way the old order was not.

**4. Legacy transport mirroring is entirely absent (A2, B5).** The word "legacy"
appeared zero times in the plan, intention 18 had no step, and Task 5 never
derived `sendOneRelayLeg`'s `transport` argument. Spec D2 requires the retry row
and slot to mirror the ORIGINAL's mode, and every relay source written before
2026-09-02 is legacy - so the first retry of any older message would throw at
`relayFanOut.ts:1436-1439`. That is the ordinary case for a retry ladder, not an
edge one.

---

## Accepted - correctness

**5. Rung chaining was never specified (A8).** `relay_retry_of` must point at the
ROOT for every rung, not at the previous retry row. Chaining to the predecessor
would orphan rungs 2-3 from the join key AND break the changed-number digest,
which is computed from the root. Stated explicitly, with a test.

**6. The backoff seam is in the wrong process (A5).** `app/src/routes/dev.ts` is
app-side; the retry job runs in the separately spawned worker
(`scripts/e2e-session.mjs:381`). The seam moves to the job's registration in the
worker, with the env var named and its read site fixed.

**7. Adding repo methods breaks typed fake literals (A10).** Both new interface
methods break eight test fakes the plan never named, failing `npm run typecheck`
at both commits. The files are now listed in the tasks that add the methods.

**8. The extraction already writes the slot and pointer (A14).** Task 5 told the
retry job to write both again. Removed; the retry job consumes the outcome.

**9. `flagPlacementAttention` is an unenumerated reader (A25, B10).** It fires at
`twilio.ts:2526` on the first 30003 and escalates to a human while the machine is
still retrying. This is the reader class the charter exists to catch. Scoped to
fire only when no retry was claimed, with a test.

**10. `presentMessageTransport`'s aggregate is a second reader (B10).** A
different function from the `:43-56` funnel the plan listed. Named.

**11. The bump's preview text was unspecified (A24, B11).** Passing the leg copy
would rewrite the inbox row to the prefixed variant of a message already
previewed raw - D12's defect arriving through the bump. The bump passes the RAW
body.

**12. Retry `unconfirmed` and staleness "not confirmed" share one label slot
(A26).** Their arithmetic is now stated so the two counts stay disjoint.

---

## Accepted - testability

**13. `tickerArmed` was invented; a working harness already exists (A9, A18,
B7).** `Timeline.ticker.test.tsx:98-119,157-203` establishes
`window.setInterval`/`clearInterval` spies with a captured id, and documents why
`vi.getTimerCount()` is unusable. The plan now points at that harness instead of
inventing an observable. A9's related point stands too: `hasTickableLeg`'s new
clause needs a defined input, since D20 removes retry rows from `visible`.

**14. Missing tests for four intentions (A13, A15, A16, B5, B6, B9).** Intention 6
(enqueue failure to a terminal `enqueue_failed`), 11's server half (the retry row
carries NO `retry_of` - the one field that would delete the original bubble), 18
(legacy), and the `fenced_announcement` and `source_unreadable` cause values.
All added.

**15. The e2e snippet contradicts itself (A6).** `page.getByText(token)` is used
as a single element for `toBeVisible`, `xpath=..` and `.click()` in the file being
edited, so asserting count 2 on the same locator throws on strict mode. Rewritten
with distinct locators.

**16. The rename leaves the old spec running (A7, B3).** Staging only the new path
under a no-`git add -A` rule leaves the old file tracked, with assertions the new
copy contradicts - gate 4 red on the branch's own leftover. The `git rm` is now
explicit.

**17. The e2e run command is wrong twice (A22).** It contradicts its own
repo-root caveat and `--grep "relay-30003"` matches no test TITLE.

**18. Task 12 was a no-op with a fake red state (A11).** All three hosts already
feed the same shared `<Timeline>`, so nothing needs implementing. It becomes a
VERIFICATION task - which is still worth its own gate, because the tour host feeds
a milestone-merged list and the filter must be correct against it.

**19. A named test file does not exist (A12).** `app/test/conversationsRepo.integration.test.ts`
was cited as an existing harness to follow.

**20. `RelayRetryRow` was used and never defined (A19).** Defined now.

**21. Task 8 staged a file with no instruction (A20).**

**22. Hardcoded budget instead of the exported constant (B12).** `STALE_SENT_AFTER_MS`
is exported (`deliveryStatus.ts:58`) and D18 reuses it precisely so two horizons
cannot drift; the test hardcoded `15 * 60 * 1000`.

**23. Thin proofs (B8, B9, A17, A27).** The bump assertion cannot distinguish the
status-preserving method from `touchLastActivity`; "no duplicate send on every
rung" is proven once. Both sharpened.

**24. Minor (A23, B13, B14).** The media-pointer snippet dropped the `{ Put: ... }`
wrapper; `RelayTransportMode` is not exported and the extraction's
"mechanical edits only" rule did not permit exporting it; Task 14's issue-filing
step and Task 7's order-dependent log collector.

---

## Two SPEC corrections (not plan findings)

**A21.** The spec says to extend `hasTickableLeg`'s docblock "from four
non-terminations to five". The docblock in this worktree already enumerates five,
and the cited range is off by about fifty lines. The instruction as written would
have a builder mis-edit a docblock that records five shipped bugs.

**A28.** D19 says the failure reason is derived in FOUR places and the fifth
`recipientSummaryName` call at `Timeline.tsx:978-989` is omitted. Round 4 had me
DELETE that site from the list as unreachable for retry states, which is true for
the message-level chip - but the count sentence was left saying four while the
enumeration and the projection both need to cover every site that reads a raw
slot. Corrected to name it and say why it is inert.

Both are fixed in the spec, not the plan, and the spec is re-stamped.

---

## Round verdict

42 findings, all accepted. Four blocking, three of them found independently by
both reviewers. This round changed the plan's task ORDER, added a storage field,
corrected a type that would have broken a fenced product, and supplied an entire
missing dimension (legacy transport). Round 2 is required.
