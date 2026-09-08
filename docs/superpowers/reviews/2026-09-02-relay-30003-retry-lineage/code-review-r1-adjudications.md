# Code review R1 - adjudications

Orchestrator adjudication of `code-review-r1-conformance.md` (C1-C7) and
`code-review-r1-adversarial.md` (A1-A15) against the branch at `17bf49a7`.
Every finding is decided below: FIX (goes to the fix wave), FILE (out of scope
by the spec's own ruling - tracked as an issue), OPEN (a product question the
spec answers one way and the reviewer argues the other - the human decides;
the code follows the spec until then), RECORD (noted, no change).

The rule applied throughout: the approved spec is the contract. Where a
reviewer's proposed fix contradicts a spec decision (D1-D23), the finding is
OPEN or FILE, never a silent deviation. Where the spec is silent or the finding
is a defect inside its stated intent, it is FIX.

## Fix wave (11 items)

- **F1 (C1, MUST-FIX) `slot_ineligible` is WARN, not ERROR.** The founder
  approved ERROR for "every fan-out or team leg that ends terminally on 30003".
  A leg whose slot already reads `delivered` did not end on 30003, and a leg
  whose slot reads 30007 ended on 30007 - and was logged at 30007's own
  severity when it did. A later contradictory or duplicate 30003 changes
  nothing and is not a new dead end. `isTerminalRelayLegFailure` keeps
  `slot_ineligible` in the WARN arm beside `claimed`, `already_claimed` and
  `fenced_announcement`; research adjudication S2a's severity table is
  corrected accordingly. Tests: a 30003 replayed onto a delivered slot -> WARN;
  onto a 30007 slot -> WARN. (S2a amended: WARN outcomes are `claimed`,
  `already_claimed`, `fenced_announcement`, `slot_ineligible`.)
- **F2 (C2, SHOULD-FIX) a throw inside the claim must not skip the tail.**
  `claimRelayRetry` is wrapped in one try/catch at its single call site; a
  throw logs ERROR with the error attached and yields a twelfth outcome value,
  `claim_failed` (ERROR; its own message; an internal fault, diagnosable as
  one), so the failure log, the existing SSE and the placement escalation
  always run. `RelayRetryClaimOutcome` gains the value; the union test moves
  to twelve. Test: `append` rejected -> the failure line carries
  `retryClaim: 'claim_failed'`, `flagPlacementAttention` still fires.
- **F3 (C3, SHOULD-FIX) intention 14's missing halves.** Add a native
  group-text 30003 receipt case asserting no ERROR and no `retryClaim`, and
  the delivered-slot replay case from F1.
- **F4 (C5, NOTE promoted) media without a store.** The retry job logs the
  fan-out's media-without-store ERROR twin (`relayFanOut.ts:1015-1024`) when
  the row carries attachments and no `MediaStore` is configured, instead of
  silently downgrading an MMS retry to text.
- **F5 (A4, MEDIUM) the backoff override must resolve the same way in both
  topologies.** The app process never registers handlers when
  `JOBS_QUEUE_URL` is set, so the module-scope store is empty exactly where
  `enqueueRelayRetryLeg` runs in production. One helper resolves the override
  (`deps?.backoffMs ?? registered ?? env override ?? relayRetryBackoffMs`) and
  is used by BOTH the registration and the free enqueue; the docblock states
  the two topologies truthfully. Test: nothing registered + env set -> the
  enqueue uses the override; nothing registered + env unset -> 60/120/240.
- **F6 (A6, MEDIUM) the e2e retrying window.** `E2E_RELAY_RETRY_BACKOFF_MS`
  becomes `'10000'`; the `1 retrying` observation window is then an order of
  magnitude wider than the SSE round trip it races. Assertion 2's 60s budget
  is unchanged. The spec is re-run twice green after the change.
- **F7 (A7, LOW) a retry row's slot never carries `contact_opted_out`.** On a
  `suppressed` outcome from `sendOneRelayLeg` (the suppression answer flipped
  between the gate and the send), the job re-persists the slot as
  `retry_opted_out` through the transport-aware path - the one exception to
  S2's "write nothing", because `contact_opted_out` on a retry row deletes the
  whole rollup (`deliveryStatus.ts:408`). Test: a `suppressed` outcome leaves
  `retry_opted_out` on the slot.
- **F8 (A8, LOW) docblocks that claim two fields "do not cross the wire".**
  `GET /conversations/:id/messages` returns rows as-is (spec D11 says so);
  the digest and the leg body are not PROJECTED by the client, which is a
  different claim. Correct the comments in `dashboard/src/api/types.ts`,
  `useRelayThread.ts` and wherever else the phrase appears.
- **F9 (A9, LOW) the harness fake's media index.** The fake's
  `listMediaPointers` derivation skips rows carrying `relay_retry_of`, with a
  comment pointing at the real guard.
- **F10 (A15, NOTE) over-claimed consumers.** `deliveryStatus.ts` comments
  that name "the broadcasts routes" as consumers of `presentRelayDelivery` /
  `presentLegDelivery` are corrected: those routes import only
  `presentDeliveryStatus` and `deliveryReason`; the other consumer is the
  same Timeline in native group-text mode.
- **F11 (A1, HIGH) the claim-to-enqueue crash window - FILE.** The spec
  records this window explicitly (Sec 9, paragraph 1: "A crash between the
  claim and the enqueue strands a retry ... Closing this needs the
  reconciliation sweep the issue puts out of scope. Recorded, not fixed.") and
  the closed issue's scope excludes any reconciliation mechanism. The
  reviewer's proposal (a `dueRow` in the append transaction, dispatched by a
  due sweeper) is a sound design for that sweep and is captured in a NEW issue,
  `docs/issues/relay-retry-stranded-claim-window.md` (severity med), linked
  from the lineage issue's residuals. Not fixed on this branch. The reviewer's
  warning is carried into the issue: never fix it by re-enqueueing on
  `already_claimed` (a delayed rung would send twice).

## Open questions for the human (the code follows the spec until answered)

- **Q1 (A2) gate refusals log at ERROR.** Spec D9/D23 and the founder's
  approved set explicitly include "was refused at a gate". The reviewer argues
  a group the operator closed, a member the operator removed, or a member who
  sent STOP are human actions, not faults - the 21610 carve-out's own
  precedent - and that `error-logs-sustained` pages at threshold 1 over three
  buckets. A one-line change (`log.warn` for the four `gate_refused` closes)
  if the founder agrees; left at ERROR because that is what was approved.
- **Q2 (A3) an `unconfirmed` leg loses its carrier code everywhere.** D19's
  table moves an unconfirmed leg out of `failed` into `not confirmed` and gives
  the row "today's not-confirmed copy" - the branch does exactly that, and the
  reviewer reproduced the consequence: no position names 30003 any more for a
  leg whose retry never sent. Keeping D19's label and adding the original's
  carrier reason as the presentation's `reason` is a small copy change the
  founder has not seen. Left as specified.
- **Q3 (A5) the destination digest is an unkeyed truncated SHA-256 over a
  public salt.** D3/D5 specify exactly that construction; the reviewer shows a
  NANP pre-image is recoverable in under a second, so "no phone number in a
  sort key" is only nominally met (the spec itself calls the protection
  partial). `createHmac` with a per-environment secret is a one-line change
  plus a secret both the app and the worker load. Left as specified; the
  human should decide whether the invariant is meant literally.
- **Q4 (A13) alarm volume.** One permanently dead handset in an active group
  now produces one `cap_exhausted` ERROR per relayed message. The per-leg
  taxonomy was approved; the per-message volume was not shown. Worth a look
  before prod.
- **Q5 (C6) the rendered retry bubble's own row.** Its chip reads
  `delivered 1/1 on retry` (D19/D22) while its own per-recipient row reads
  plain `Delivered`. D21's agreement rule is about the original bubble's three
  positions, which agree. Cosmetic; left.

## Recorded, no change

- **A10** rung-1's leg copy is composed at claim time from the current roster
  (a rename inside the seconds between the send and the callback drifts the
  prefix). The proposed fix - persist the composed copy at send time - is what
  D12 rejects. Recorded; window is seconds.
- **A11** an unclassified send error in the retry job loses the rung with no
  close code because the execution marker is written first (D4). The fan-out
  has the same marker-first shape. Recorded.
- **A12** the D16 bump reorders the inbox with the stored preview and emits no
  `conversation.updated`. Both follow from S3 (ordering only). Recorded.
- **A14** one contact on two handsets mints two ladders and one dies
  `retry_number_changed` - the member-key collapse the open issue
  `relay-member-key-collapses-two-phones-one-contact` already records.
- **C4** spec Sec 2 still names `routes/dev.ts` for the seam; the tree uses
  `registerHandlers.ts` per adjudication E1. The spec text trails the plan.
- **C7** `isRetryRungLive`'s clockless corner on an imported row is
  unreachable today.

## Both reviewers' challenge of the build-time rulings

B3 (suffix order) and B5 (clockless rung) were challenged by the conformance
reviewer and upheld with reasoning in its file; the adversarial reviewer,
plan-blind, independently found B5's construction correct and B1's overlay
the source of Q2. No build-time ruling is reversed.

## Gate 4 adjudication - `outbound-mms.spec.ts:517` (a) is NOT this branch's

Two different reds on the same case, on two different trees, both tracked on
main and neither reachable from this branch:

- **Checkpoint run (pre-sync base `bb54fdaa` + our commits, 22:15):** the
  scroll-OFFSET signature (`timeline.top` 146 vs 112; alone 512 vs 500). Fails
  identically DETACHED at the base with our commits absent (512 vs 500). Main
  closed it the same day (`e2e-image-viewer-scroll-flake`, `e06b133c`); the
  branch's single main sync carried the fix and the file then passed 6/6.
- **Gate 4 run (synced `17bf49a7`, 00:21):** the trigger-VISIBILITY signature
  (`locator.evaluate: Error: trigger is not visible` at `:591`), byte-identical
  to main's OPEN `e2e-outbound-mms-viewer-trigger-not-visible`, which records
  "fails in EVERY full-suite run ... main alone reproduces it, 3/3 full runs,
  0/1 isolated". Our run makes it 4/4 full runs on three trees and, with two
  isolated passes on this commit (`6 passed (59.9s)`, `6 passed (41.0s)`),
  0/3 isolated - the pass-alone / fail-in-suite class, not a regression.
- **Reachability:** every hunk this branch adds to the shared presenter and
  Timeline is gated on relay-only state (`relay_retry_of`, `isRelayLeg` /
  `rosterKind === 'relay'`), and the media-pointer suppression on
  `relayRetryOf !== undefined` - none of which a 1:1 composer send sets. Our
  lane's ports were free before the run (no orphaned stack to adopt).

Both main-filed issues received this sighting as a data point; neither is
closed. The fix wave's final battery is reported as a further run either way.
