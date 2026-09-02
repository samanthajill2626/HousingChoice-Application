# Live self-QA - phase 5 (hermetic lane 1, full demo profile, branch build)

Stack: `npm run e2e:session`, lane 1, `appCommit 381a14e2` then hot-reloaded to
`245f4bfe` for the re-verify. Driven by the orchestrator with the Playwright
MCP; every claim below is a MEASURED number from `browser_evaluate`, not an
eyeball. Screenshot: `.playwright-mcp/qa-360-upcoming-block.png` (gitignored).

## What was walked

1. **Scheduled matrix tour panel** (`tour-mx-scheduled-01`): one generation -
   sent `confirmation` + pending `day_before` (NEXT, Send now + Cancel), no
   disclosure. Seed pointer wiring correct end to end.
2. **Live reschedule** (dialog, new time Sep 10): fresh 3-rung ladder armed
   (day_before NEXT / 4-hours-before / en_route), the old pending rung ABSENT -
   deleted, not rendered canceled - and `Earlier reminders (1)` renders
   COLLAPSED holding the old generation's sent confirmation with NO buttons and
   NO body (seed rows carry no `sentBody` - acceptance 11's cell). Acceptances
   1 (read side), 9, 10-adjacent, D2 verified live.
3. **Terminal tour panel** (`tour-mx-canceled-01`): "No reminders armed." AND
   the collapsed disclosure render together (acceptance 10 / T7.3), sent row
   only, zero actions.
4. **Phone walk, 360x800** on a message-overflowing contact thread
   (Terrence, ContactCommsPane -> Timeline):
   - OPEN: pinned with the sentinel EXACTLY at the viewport bottom (delta 0),
     586px of Upcoming block below the fold, no pill, no horizontal scroll -
     acceptances 13 + 14 at rest.
   - Scroll to true bottom: block revealed.
   - STANDING ON THE BLOCK + real inbound (signed webhook): stream grew
     1641 -> 1709, scrollTop auto-compensated 1358 -> 1426 (+68 = exactly the
     growth), block viewport-position pixel-stable (52 -> 53), NO pill, no
     yank - acceptance 15.
   - SCROLLED UP (300) + real inbound: scrollTop unmoved, pill lit -
     acceptance 16's contact-thread half, live (the relay-thread half is the
     e2e spec's assertion).
   - PILL CLICK: sentinel delta 0, newest message visible, block back below
     the fold, pill gone - the W1 rect-delta target.
   - Short-thread case (`conv-live-relay-group` at 360x800): messages fit the
     viewport, block visible at rest - the spec's accepted parenthetical in
     acceptance 14.
5. **Visual (O9)**: at 360px the block reads as the stream's tail - full-width
   cards, single scrollbar, composer below. Accepted.

## The catch (live QA earning its keep)

**Fix-wave-1's m2 fix regressed first-mount pinning.** On the tour page the
thread OPENED at scrollTop 0 with the pill lit and no auto-scroll (measured:
distanceFromBottom 655, pill visible, zero user interaction). Root cause: the
m2 re-derive ran on EVERY block-presence flip including the initial
false -> true mount; when messages and the Upcoming block arrive in the same
commit, it re-derived from unpinned first-paint geometry (sentinel 221px below
the viewport -> `null`) and ate the default `'sentinel'` anchor - so the first
growth lit the pill instead of pinning. Acceptance 13 broken for any view
mounting both together (TourConversation does), timing-flaky elsewhere; the
re-pointed unit tests missed it because none of the five covers first mount
with a block, and the e2e host's fetches happen to order messages first.

Fixed @245f4bfe (the same agent that wrote m2): re-derive on the UNMOUNT flip
only - a block mounting below the sentinel cannot invalidate the current
anchor. RED test: first render carrying both clusters and `upcoming` ->
pinned, no pill (failed `expected +0 to be 200` pre-fix). The m2 unmount test
still passes. Re-verified LIVE post-fix: sentinel delta 0 on open, no pill.

## Not covered live (and why that is fine)

- Fixture A's sweep-miss surfaces (superseded chip on all three previews, 409
  copy) - not manufacturable through the UI by design; proven at unit/route
  level and in the reviews.
- Concurrency (transactional sweep) - proven against DynamoDB Local at the
  repo/route layer; not a UI phenomenon.
- The relay-group pill (acceptance 16 second half) - the
  `upcoming-in-stream.spec.ts` e2e assertion, green in the gate run.
