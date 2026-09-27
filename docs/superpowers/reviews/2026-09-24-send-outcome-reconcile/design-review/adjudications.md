# Design-review adjudications - send-outcome reconcile

Spec: `docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md`.
Reviewer reports: `spec-r1-reviewer-a.md` (26 findings), `spec-r1-reviewer-b.md`
(24 findings). Findings are CLAIMS; each is ACCEPT (the spec changed), REJECT
(with why), or DEFER (filed). Where A and B found the same thing the row names
both. Severity is the reviewer's; "decision changed" is the planner's.

## Spec round 1 (2026-09-24) - both reviewers, independent

| # | finding | ruling | what changed |
|---|---|---|---|
| A1, B3 | reconcile enqueues (next check, re-drive, retry rung) are not idempotent, so a redelivered reconcile duplicates the chain and double-texts | ACCEPT, decision changed | D11 now REQUIRES a conditional verdict write BEFORE any enqueue: the slot's code flips `send_unconfirmed` -> `send_redrive` (or the terminal code) under a condition on the current code, and only the writer that wins the condition enqueues. Check continuations are made idempotent the same way: each check number is recorded on the slot before its successor is enqueued. |
| A2, B1 | a failure in the fan-out's own post-send bookkeeping (slot write, stats bump, pointer) is classified `unknown`; the lookup then drops the held SID and rules `never_sent`; double text | ACCEPT, decision changed (BLOCKING) | New D3a: classification applies ONLY to the provider call and to `sendMessage`'s typed errors. Post-send bookkeeping failures are a separate class, `sent_unrecorded`: logged at ERROR with the SID, never reconciled, never re-driven (D7a). The lookup also no longer drops a held SID blindly: a held SID whose pointer resolves to THIS owner+recipient is `found` (repair), one held by another owner is excluded (D13). |
| A3, B5 | `MAX_HOP_COUNT` (10) never budgeted; a long check chain plus a re-drive can hit it; the enqueue then throws with no verdict | ACCEPT, decision changed | D13a budgets hops: at most THREE checks (about 5s, 30s, 4m), at most ONE re-drive per recipient (a second `unknown` on a re-driven slot goes straight to `unresolved`), worst-case chain depth 7 of 10 - shown in the spec. Any enqueue that throws inside the reconcile job (hop limit or the queue) is caught and the recipient closes `unresolved` on the spot. |
| A4, B7 | known-SID adoption does no status read; queued adoptions strand broadcast slots; no body for the broadcast row | ACCEPT, decision changed | D13: a known SID is FETCHED by SID (new `getMessage(sid)` on the port) - same status/body/creation read as the list path. D15: adoption maps a non-terminal provider status to the slot's `sent` (as the success path does), a terminal one to delivered/failed with its code. |
| A5, B16 | payload carries digests but the lookup needs clear numbers; where do they come from; `phone#E164` keys leak anyway | ACCEPT, decision changed | D12: the payload carries the OWNER reference and a digest of the recipient number; the job re-reads the recipient's current number from the owner (contact / roster / retry row) and compares the digest; a mismatch is `unresolved` (the text, if any, went to a number we can no longer look up). The sender is a pool or business number, not PII, and rides in the clear. Owner keys that are already `phone#E164` are the existing key shape and are not new exposure. |
| A6, B2 (first half) | D8 says continuations never list `send_unconfirmed` slots but the re-drive lists one; the spec never says what the verdict writes first | ACCEPT, decision changed | D16: the `never_sent` handler flips the slot to `queued` / `send_redrive` conditionally, THEN enqueues; a `send_redrive` slot is an ordinary queued slot to every send site and every close. D8 unchanged in substance. |
| A7, B6 | finalize can be skipped by both writers (eventually consistent reads) or run N times (unconditional flip, duplicate audit rows) | ACCEPT, decision changed | New D16a: `finalize` becomes idempotent (the status flip is conditional on `status = sending`; only the winner writes the audit row and emits); every "is anything still open" decision is made on a STRONGLY CONSISTENT read taken AFTER the deciding write, by every writer (pass end, continuation end, verdict handler). |
| A8, B8 | per-recipient database calls outside the provider-call try still throw out of the loop; Sec 9 mislabels them | ACCEPT, decision changed | D7a: the per-recipient unit is split into three phases - PREPARE (reads before the send: nothing sent; a failure defers the recipient as `retryable`), SEND (classified per D1), RECORD (writes after the send: never classified; a failure is `sent_unrecorded`, ERROR with the SID, loop continues). Sec 9 residue reworded: what remains outside is the per-PASS setup before any recipient (unit read, snapshot read, preflight). |
| A9, B17, A19 | `retrySend` adoption undefined; `never_sent` distrusted only there; wrong cross-reference | ACCEPT, decision changed | D16 gains a full `retrySend` row: `rejected` -> ERROR, chain ends; `retryable` and `never_sent` -> re-enqueue the same rung ONCE (a `deferred` flag in the payload), then ERROR; `unknown` -> reconcile; `found` -> adopt; `unresolved` -> ERROR, chain ends. Cross-references fixed. The stale "will retry" copy after an `unresolved` 1:1 retry is DEFERRED (filed): it needs the 1:1 timeline presentation, which is outside this branch. |
| A10, B12 | `relayRetryJoin.ts` projects an unresolved rung onto the root leg as a terminal failure with a Retry offered | ACCEPT | D20 names the join as a render position that must key on the code. |
| A11, B9 | adoption skips the webhook's failure side effects and the success path's bookkeeping | ACCEPT (partly) | D15: adoption performs every write the OWNER's success path performs (broadcast: message row, milestone, listing-send row, inbox touch, audit, SSE; relay: slot + pointer) and applies the fan-out's OWN failure arms (30005/30006 -> unreachable flag). Webhook-only effects (the 30003 retry ladder, 21610 suppression bookkeeping, placement attention, the delivery-failed metric) are RESIDUE: the webhook is fenced; adoption logs a WARN naming the code. Sec 2 says so. |
| A12 | broadcast adopt omits milestone / listing row / touch / audit / SSE | ACCEPT | Folded into D15 above. |
| A13, B2 (second half) | a re-drive spends the shared pass budget; after an outage it is capped on arrival and closes `transient_cap` without a send | REJECT | The cap bounds retries per broadcast on purpose (retry-counter D3: passes are lockstep). A re-drive that finds the ladder spent closes `transient_cap` - an honest terminal state ("gave up after temporary errors") for a recipient the outage prevented us from ever reaching. The alternative (a re-drive outside the cap) is an unbounded retry. The pre-existing weakness this exposes - the ladder's 5/10/20s backoff spans ~35s, so any outage longer than that spends the whole ladder - is an interaction with retry-counter D7/D11 and is recorded in Sec 2, not changed here. With A6's fix the slot can no longer be stranded under D8. |
| A14 | a relay re-drive silently no-ops if the group closed, the member left or the source is gone; the slot never becomes terminal | ACCEPT | D16: the relay `never_sent` handler pre-checks sendability (group open, member on roster, source present) and, when it fails, closes the slot `failed` / `redrive_refused` (new code, copy in D23) instead of enqueueing. The same early-return hole exists for the pre-existing transient continuation and is filed separately. |
| A15, B15 | body-hash matching unverified against the stored body (Smart Encoding); the spike compared a 24-char prefix | ACCEPT | D13: the body hash is a TIE-BREAKER among multiple candidates, never a requirement. The match key is recipient + sender + created-at window + SID not held by another owner. |
| A16, B13 | D11 (throw = retry) vs D13 (every check threw = unresolved) | ACCEPT | D13: a provider error INSIDE a check is caught and counted as that check's result; only the job's OWN writes throw (a genuine retry). The in-process lane never redelivers, so the redelivery property is proven at integration level, not e2e (Sec 8). |
| A17 | `accepted-send-lost-when-append-fails` cannot be closed: its production path is not adopted; relay legs get no typed error | ACCEPT | Header table: "piece 1 built; piece 2 built for the adopted callers; `missedCallAutoText` is Stage 2". Relay legs' post-send failures are `sent_unrecorded` (D7a), which is the same honesty without a typed error. |
| A18, B4 | "any 4xx" needs the HTTP status; `errorCodeOf` ignores status when a code is present; Sec 11 implies a closed list | ACCEPT | D1: the classifier is NEW code that reads status AND code: 5xx by status is `unknown` regardless of code; 4xx by status is `rejected` unless the code is 20429 / the status is 429; no status -> the code/network table. Sec 11 reworded. |
| A20 | D20 copy tells staff to check a conversation that has no record; D22's reason is suppressed on the broadcast badge when `isFailure` is false | ACCEPT | Copy: "Twilio couldn't be reached to confirm whether this text went out." D22: the badge renders the reason for this code. |
| A21, B23 | D4 would fire `send_throttled` on network faults | ACCEPT | D4 names 429 / 20429 / 30022 only. |
| A22 | a send-time 21610 is a generic failure with no suppression bookkeeping | DEFER (filed) | Recorded `rejected` with the code; suppression bookkeeping for send-time 21610 is filed as its own issue (the webhook's 21610 arm is fenced and the fan-out never saw the code before). |
| A23, B21 (first half) | dropped-callback ERRORs for SIDs awaiting adoption feed the error-log alarm | ACCEPT as residue | Sec 2 states it: up to three ERROR lines per orphan until adoption; a burst of orphans can trip the burst alarm. The webhook is fenced; the sweeper/passive-match follow-up is the fix. |
| A24, B11 | `sentAt` is a provider timestamp; D7 wrote the attempt start into it; broadcast slots have no such field | ACCEPT | D7: the slot gets the CODE only; the attempt start lives in the reconcile payload. Nothing writes `sentAt` until adoption. |
| A25, B24 | loose claims and broken references | ACCEPT | All fixed: D11's "only path" claim dropped (media.mirror, voice transcripts, relay warm also retry genuinely); D13/D16 and Sec 6/7 references; test 3 rewritten per owner; D3 now states the send route's post-append behavior change (201 instead of 500) as intended; D20 says "minutes"; Sec 1's code list corrected; the review directory now exists. |
| A26, B24 | readers of the new stats bucket (SSE event type, StatChips balance rule, seeds); no lane override for the window | ACCEPT | D22 enumerates the readers; D13a adds a lane-only, topology-guarded window override on the `E2E_RELAY_RETRY_BACKOFF_MS` precedent. |
| B10 | neither send site enforces reconcile ownership; a duplicate pass in the window re-sends | ACCEPT | D8: every send site skips a `send_unconfirmed` slot exactly as it skips a terminal one. |
| B14 | `date_created` has one-second resolution; a sub-second allowance discards the real orphan | ACCEPT | D13: the window opens 60 seconds before the attempt start (clock skew + resolution); the SID-not-held and owner rules carry the discrimination. |
| B18 | braking on `retryable` closes most of the audience on a short throttle burst | ACCEPT | D9: the brake counts `unknown` only - the slow, ambiguous class. `retryable` outcomes are fast and already deferred one by one. |
| B19 | an outage broadcast with zero confirmed sends finalizes `sent` | ACCEPT | D16a: `finalize` marks the broadcast `failed` when no recipient reached sent/delivered and every recipient is failed or unconfirmed (`last_error` says which). |
| B20 | Sec 1 is a slogan | ACCEPT | Sec 1 now states each guarantee with its scope and names the recorded residues (crash window, per-pass setup, `sent_unrecorded`, webhook side effects). |
| B21 (second half) | the e2e `accept_then_drop` "receipt routed" cannot happen - the fake fires callbacks within 300ms, before adoption | ACCEPT | Sec 8: the expectation is that the leg ends adopted with the status the provider reports (delivered), the early callbacks having been dropped. A late receipt after adoption routing is proven at integration level with an injected fake. |
| B22 | two `SmsSendingDisabledError` classes; the broadcast path already marks it `skipped`; the code exists | ACCEPT | D5: the broadcast path is unchanged (`SendRefusedError` -> skipped); the ADAPTER-level class reaches only the raw-adapter callers (relay) and is `rejected` there with the existing token `sms_sending_disabled`, which D23 adds to the delivery-reason map rather than inventing. |

**Round 1 outcome:** 30 distinct findings (A and B overlapped on 12). ACCEPT
27, REJECT 1 (A13/B2 second half), DEFER 2 (A19 second half, A22). Decisions
changed: yes (D3a, D7a, D11, D13, D13a, D15, D16, D16a among others) -> round
2 required.

## Spec round 2 (2026-09-24) - reviewer A continued, with B's round-1 report

Between rounds the planner ran two more read-only/one-send probes against the
real dev account (outputs in `../research/`): the dev Messaging Service has
`smart_encoding: true`, and a body sent with U+2019 / U+2014 / U+2026 is
STORED (fetch and list alike) as `'` / `-` / `...` while the create response
echoes the submitted body. That settles finding 2's body-match question with
evidence rather than a rule.

| # | finding | ruling | what changed |
|---|---|---|---|
| 1 | once a reconcile job wins a conditional write, a later throw or crash is not a real retry; resuming would double-text because no send site claims the recipient before sending | ACCEPT, decision changed (BLOCKING) | New D8a: a per-recipient SEND CLAIM - every send site conditionally marks the slot `send_attempting` with an `attemptedAt` clock before the provider call and loses gracefully. With the claim in place D11 is rewritten to AT-LEAST-ONCE enqueues with idempotent verdict writes: adoption is a set of individually idempotent writes re-runnable as a whole; the check chain tolerates a duplicate (bounded by three checks); a re-drive may be enqueued twice and the claim makes the second continuation a no-op. Nothing in the chain depends on being the single winner any more. |
| 2 | a single survivor is adopted whatever its body: another owner's orphan on a multiplexed number, a Twilio STOP/HELP auto-reply from our own number, a `syssid#` system send | ACCEPT, decision changed (BLOCKING) | D13: a body match is REQUIRED, on a lossy normalization the spike justifies (NFKC, letters and digits only) because Smart Encoding rewrites punctuation; SIDs held by ANY other owner or by the `syssid#` marker are excluded; candidates that exist but match nothing yield `unresolved` (never adopt, never re-drive) with a named log cause. A normalized body shorter than three characters cannot match and yields `unresolved`. |
| 3 | `retrySend` has no slot, so nothing conditions its writes; a duplicate reconcile double-texts on the 1:1 path | ACCEPT, decision changed | D12/D16: the 1:1 owner's durable record is the ORIGINAL message row; its deferral and reconcile state are conditional attributes on that row, and its re-send goes through the same claim shape (a conditional `retry_deferred_at`). |
| 4 | the re-drive pass reads its snapshot eventually consistently right after the flip and can skip its own `send_redrive` recipient | ACCEPT | D16: a continuation that carries `recipientKeys` reads its snapshot strongly consistently. |
| 5 | `never_sent` is inferred from one page whose order and bound are unverified; queued orphans have a null `DateSent`; guarantee 1 still says "none accepted" | ACCEPT | D13: the job walks EVERY page of the `To`+`From` list until a whole page is older than the window (a single recipient/sender pair has few messages). Guarantee 1 now records the residue: an orphan the provider lists outside that walk is ruled `never_sent`; the walk is asserted against the fake and verified on the first hosted-dev run. |
| 6 | `sent_unrecorded` leaves a known-sent recipient non-terminal for ever, though the known-SID reconcile would repair it | ACCEPT, decision changed | D7a: a record-phase failure hands the recipient to reconcile WITH the known SID (a repair, not a lookup); D3a's rule is narrowed to "never classified as unknown". |
| 7 | `SendAcceptedNotRecordedError` has no arm in Sec 4; D3a and D12 disagree | ACCEPT | Same resolution as 6: known SID -> reconcile -> adoption. A failed fetch of a known SID is a job failure (a genuine retry to the DLQ), never `unresolved`. |
| 8 | one `unresolved` copy for six causes, five of them not "Twilio unreachable" | ACCEPT (copy), REJECT (multiplicity) | The copy becomes "Couldn't confirm whether this text went out." - true for every cause, since in each one the platform does not know. The causes are distinguished in the log line, not in the code: staff need one honest state, operators need the cause. A recipient ruled `never_sent` that cannot be re-driven closes with `transient_cap` or `redrive_refused`, both of which keep the Retry offer. |
| 9 | an adopted broadcast slot with provider status `sent` never gets `carrierSentAt` | ACCEPT | D15: adoption sets `carrierSentAt` (broadcast) / `sentAt` (relay) from the provider's `date_sent` when present. |
| 10 | the inbox touch on adoption reopens a closed thread, overwrites a newer preview, moves `last_activity_at` back | ACCEPT | D15: the status-preserving touch with no preview, never moving `last_activity_at` backwards - the relay retry job's shape. |
| 11 | the 30005/30006 unreachable flag applied to an adopted relay MMS leg recreates the prod false positive | ACCEPT | D15: that arm applies to the broadcast owner only (SMS by construction). |
| 12 | any `skipped` recipient defeats the all-failed finalize rule | ACCEPT | D16a: `failed` when no recipient reached `sent`/`delivered` AND at least one is `failed` or unconfirmed; skipped recipients count for neither side. |
| 13 | contests the A13 rejection: re-drives are already capped at one, so the "unbounded" premise is gone; a re-drive should not spend the shared ladder | CONCEDE, decision changed | D13a/D16: a re-drive continuation does not claim a pass (the single-re-drive cap bounds it); its own transient outcome, if any, joins the ladder as usual. |
| 14 | the failure-arm writes (D5-D7, D9) can fail too; a failed `send_unconfirmed` write strands the chain | ACCEPT (partly) | D7: the reconcile is enqueued BEFORE the slot write and its verdict conditions tolerate a slot that never received the code; other failure-arm write failures are logged at ERROR and left for the sweeper (the D7a record-phase rule), which Sec 1 records. |
| 15 | with no `sentAt`, a stranded relay leg never ages into "not confirmed" | ACCEPT | D8a's `attemptedAt` is the non-provider attempt clock; D20a: the dashboard ages a `queued` leg from `attemptedAt` when it has no `sentAt`. |
| 16 | `closeBroadcast` calls finalize unconditionally, so the open-check must live inside finalize | ACCEPT | D16a. |
| 17 | the relay retry job's outcome switch routes the new kinds through its catch-all | ACCEPT | D16: the retry rung handles `handed_to_reconcile` and the record-phase kind explicitly. |
| 18 | Sec 8 still expects a later receipt routed after adoption | ACCEPT | Sec 8 reworded; the routing of a post-adoption receipt is proven at integration level. |
| 19 | worst-case hop depth is 8 | ACCEPT | D13a. |
| 20 | smaller inaccuracies (success-path status mapping, the digest's home, D20/D21 keying, the D7a phase table, `retrySend`'s leftover throws) | ACCEPT | All fixed; `retrySend`'s prepare-phase throws (the original read, the presign) take its single deferral. |

Contested adjudications: A13 conceded (above); A17 conceded by the reviewer
after 6/7. Reviewer conceded A5, A19 (second half), A22, A23.

**Round 2 outcome:** 20 findings, 19 accepted (one in part), 1 rejected in
part. Decisions changed: yes (D8a, D11, D13, D7a, D16a) -> round 3 required.

## Spec round 3 (2026-09-24) - reviewer A continued

Planner's reading of the round as a whole: findings 1-4, 6, 8-10 all come from
ONE structural choice - using the slot's `errorCode` as a state machine that
six writers share, two of which (`setRecipient` on broadcast, `markRecipient`
on legacy relay) rewrite the slot wholesale. Revision 4 moves every piece of
coordination state OUT of the slot into a per-recipient send-attempt RECORD
(new D8a) - the same reasoning that put the retry-counter mission's pass
counter outside the wholesale-written slot (its D2) - and the slot goes back
to being a presentation record. Most rows below are accepted by that one
change rather than by a patch each.

| # | finding | ruling | what changed |
|---|---|---|---|
| 1 | a relay success leaves the slot `queued` with a SID, which the claim accepts; a twice-enqueued re-drive texts again | ACCEPT, decision changed (BLOCKING) | The claim lives on the attempt record, not the slot; a record that holds a SID, or is in any non-claimable state, refuses the claim regardless of slot status (D8a). |
| 2 | `send_unconfirmed` marks both a pending and a closed slot; finalize, the flip and the chip read only the code | ACCEPT, decision changed | Pending is a record STATE (`reconciling`); the slot carries `send_unconfirmed` only when CLOSED (`failed`). Finalize consults records for open attempts (D16a); the re-drive flip is a record transition (D11); the chip counts closed unresolved legs only (D21). |
| 3 | D7 vs D11 disagree on a slot that never got the code; the safe rule keys on the attempt start | ACCEPT | Every record transition is conditioned on the record's `attemptedAt` equalling the payload's (D11); the reconcile is recorded on the record BEFORE the enqueue, so there is no "never got the code" state (D7). |
| 4 | cap-closes, the brake, the relay opt-out arm and the retry gates can overwrite a slot another pass is sending | ACCEPT, decision changed | D8: every close this branch owns (the two cap-closes, `redrive_refused`, `unresolved`) reads the recipient's attempt record consistently first and refuses an open attempt; the retry gates and the opt-out arm run BEFORE that job's own claim and a foreign open attempt refuses their claim next (D8a); the brake defers only recipients that have no attempt. |
| 5 | identical bodies (media-only legs, emoji-only) defeat identification; "earliest" lets two reconciles adopt one SID | ACCEPT, decision changed | D13: adoption CLAIMS the SID (a conditional SID-pointer put); a loser takes the next unclaimed matching candidate; none left is `never_sent`. With that, identical-body orphans may be ASSIGNED swapped between two legs of the same body to the same member, which changes no delivery and no count, and never produce one-text-twice plus one-never. Media-only bodies match on media count (D13). |
| 6 | `retrySend` has no send claim | ACCEPT, decision changed | The attempt record is owner-agnostic: the 1:1 retry keys its record on the original message and the rung (D8a, D12). |
| 7 | the page walk assumes newest-first, which D17 marks UNVERIFIED; "few messages per pair" is false for shared pool numbers | ACCEPT | D13: walk every page up to a bound (20 pages); exceeded is `unresolved`. |
| 8 | contests round-2 #14: with a claim, a failed deferral write leaves `attempting`; the continuation loses and skips for good | CONCEDE, decision changed | D8a: a FRESH foreign claim makes the continuation DEFER the recipient again (it stays in the transient set), and a STALE one (older than the claim TTL) is taken over and handed to reconcile - never a silent skip. |
| 9 | D7's unconditional slot write after the enqueue races an early adoption | ACCEPT | D7: the record is written first (`reconciling`), then the enqueue; no slot write happens while reconciling, so nothing can regress an adoption. |
| 10 | a re-drive's claim overwrites `send_redrive`; a stale hand-off re-arms a second re-drive | ACCEPT | `redriveCount` is a record attribute the claim never touches (D8a, D13a). |
| 11 | "unmatched candidate -> unresolved" has no timing rule | ACCEPT | D13: unmatched candidates decide only at the FINAL check; earlier checks continue. |
| 12 | re-running the adoption duplicates the milestone and audit writes; a record-phase stats-bump failure is never repaired | ACCEPT | D15: the best-effort rows and the stats bump are written only by the adoption that WINS the slot transition; D7a: the record phase writes the slot LAST and bumps stats in the same conditional, so "slot moved" implies "stats moved". |
| 13 | contests round-2 #8 for one cause: a `never_sent` whose re-drive enqueue throws should close `enqueue_failed`, keeping the Retry | CONCEDE | D16: that case closes `enqueue_failed`. |
| 14 | smaller defects (digest check on the known-SID path; claim TTL shorter than a `sendMessage` call; absent legacy slots fail the claim; media-only 1:1 retry; re-drive vs the close-on-no-claim branch; relay retry adoption's inbox touch) | ACCEPT | D12 (digest check only on the lookup path); D8a (claim TTL = the provider timeout plus the send service's own budget, 90 seconds; the record is created on first claim so an absent slot is not consulted); D13 (media count); D13a (a re-drive pass claims a ladder rung only when it has transient remainder to defer); D15 (the relay retry adoption touches the inbox the preserving way). |

**Round 3 outcome:** 14 findings, all accepted (two as conceded contests).
Decisions changed: yes (the attempt record) -> round 4, the LAST round under
the cap. If round 4 still changes a decision, the open findings go to Cameron
as a decision rather than a fifth round.

## Spec round 4 (2026-09-25) - reviewer A continued; the cap round

The reviewer reported the record mechanics it was asked to test - D7's
record-first order, D11's `attemptedAt` conditions, D16a, D13a's late rung
claim, D20a - as sound. The ten findings below each tighten an existing rule;
none adds a mechanism, a surface or moves an invariant, so the planner rules
this the TERMINAL round: fold in and stop.

| # | finding | ruling | what changed |
|---|---|---|---|
| 1 | the close gate lets any `done` record through (a delivered relay leg is `done/sent` with a `queued` slot); the retry gates and the opt-out arm write the slot BEFORE their claim | ACCEPT | D8: a close proceeds only when the record is absent or `done` / `retryable`; the slot write requires `queued` with no SID; the retry gates and the opt-out arm read the record too. |
| 2 | identical-body MEDIA legs carry different photos; with one orphan and two attempts, the loser re-drives: photo B twice, photo A never | ACCEPT | D13: `never_sent` is withheld - `unresolved` - while another attempt for the same recipient and sender with the same fingerprint (body hash + media count) is open or adopted in the window. |
| 3 | the reconcile job's own closes cannot satisfy D8 (reads its own record) and D11 (record `done` first strands the slot on a crash) at once | ACCEPT | D8: own closes are exempt from the gate, write the slot first, then the record; a redelivered close re-applies the slot write. |
| 4 | contests the round-3 #8 concession: a 90s takeover TTL outlives both ladders, so a stuck attempt is deferred to the cap and then skipped | CONCEDE | D8a: TTL = the provider's 30-second timeout (a premature takeover of a live call is repaired by the lookup); D8: a cap-close takes over a stale `attempting` record instead of skipping it. |
| 5 | 20 pages at the default page size caps a pair at ~1000 messages; active members and long-running tenants exceed it | ACCEPT | D13: the provider's maximum page size (1000), asserted by the driver, and a bound of 5 pages. |
| 6 | "the brake defers only recipients that have no attempt yet" drops a continuation's deferred remainder | ACCEPT | D8: "not yet attempted in this pass". |
| 7 | D8a both allows and refuses a claim from `redriven`; no rule for `never_sent` with `redriveCount` 1; "deferred again" is meaningless for `retrySend` | ACCEPT | D8a and D13a reworded; a `retrySend` refusal is a duplicate rung and a skip. |
| 8 | D15 gates the row append on the slot write while D11 makes it the SID claim; `putRelaySidPointer` swallows its conditional failure | ACCEPT | D15: the order is SID claim, slot, then the gated best-effort writes; the pointer put must report a lost claim. |
| 9 | the record key can carry a phone; no TTL horizon | ACCEPT | D8a: phone-bearing recipient keys are hashed into the key (the relay retry claim's rule); a 30-day cleanup `expires_at`. |
| 10 | a BatchGet's unprocessed keys read as "absent = no attempt" and would close in-flight recipients | ACCEPT | D8: per-key consistent reads, or a completeness check that re-reads unprocessed keys. |

**Round 4 outcome:** 10 findings, all accepted (one as a conceded contest).
No decision changed - precision edits folded into revision 5. Review closed
at the cap. The one adjudication that stands REJECTED across all four rounds:
round 2 #8's multiplicity - `unresolved` is ONE state on screen ("Couldn't
confirm whether this text went out."), and its cause lives in the log line,
because in every cause the platform genuinely does not know.

Totals across rounds: 74 findings adjudicated (R1 30 distinct of 50 raw, R2
20, R3 14, R4 10); ACCEPT 71 (5 as conceded contests), REJECT 1 (in part),
DEFER 2 (filed in Sec 9).

## Plan round 1 (2026-09-26) - two reviewers, independent

Plan `docs/superpowers/plans/2026-09-26-send-outcome-reconcile.md` @df0b5353.
Reports: `plan-r1-reviewer-a.md` (23), `plan-r1-reviewer-b.md` (26). Overlap
was heavy; rows name both where they met. Plan revision 2 carries every
ACCEPT.

| # | finding | ruling | plan change |
|---|---|---|---|
| A3, B1 | Task 5's transition helper passes all nine name aliases to every UpdateCommand; DynamoDB rejects unused aliases; Task 6's close has the same trap | ACCEPT (BLOCKING) | The helper takes the exact names each expression uses; every expression in Tasks 5 and 6 lists its own names and values. A DynamoDB Local test per transition pins it. |
| A5, B4 | the sendOutcome <-> messaging cycle hits the TDZ (messaging reads SEND_CLAIM_TTL_MS at module init); the leaf module was "optional"; the dashboard mirror test drags the adapter in | ACCEPT | `app/src/adapters/messagingErrors.ts` is MANDATORY (Task 1 creates it, moving SmsSendingDisabledError there and re-exporting from messaging.ts); sendOutcome.ts imports only from that leaf; the dashboard mirror imports sendOutcome.ts, which then has no adapter import. |
| B2 | ProviderSendFailedError hides the provider code/status: the broadcast arms stop matching between Task 3 and Task 7 | ACCEPT | The class exposes own `code` and `status` mirroring the cause, so errorCodeOf keeps working; Task 3 also moves to sit immediately before Task 7 in the order (T1, T2, T4, T5, T6, then T3, T7, T8, T9). |
| A1, B3 | a second unknown after a re-drive is never closed unresolved; the record strands | ACCEPT | Send sites: when the claimed record's redriveCount >= 1 and the outcome is unknown, close directly - slot failed/send_unconfirmed, finishAttempt(ref, { outcome: 'unresolved', cause: 'second_unknown' }), no reconcile (D13a). Task 10 also closes unresolved when markRedriven returns false on a redriveCount >= 1 record. Sec 8 test 10's clause gets its test. |
| A2, B9 | never_sent whose re-drive enqueue then throws cannot close enqueue_failed with the interface as typed | ACCEPT | closeRedriven widens to refused / redrive_refused / enqueue_failed / unresolved; Task 10 case 17 uses it, then the slot close and finalize. |
| A8, B5 | Task 8 adds required unit args before Task 9 wires the rung: typecheck red between tasks | ACCEPT | Task 8 adds sendAttempts / owner as OPTIONAL with the rule "absent = the pre-claim legacy path"; Task 9 wires the rung and makes them required in the same commit. |
| A9, B6 | slices are not stoppable between (a job enqueued with no handler; Task 7 tests need Task 10; Slice E needed for honest rendering) | ACCEPT | The plan says so: the branch is ONE deliverable; slice boundaries are commit/review checkpoints, never shippable states. Task 7's "finalizes when the verdict lands" test moves to Task 10; the chip-dependent e2e is ordered after Task 14 (slice D after E). |
| A4, B7 | PREPARE-phase throws (pre-claim reads, fence writes, the relay suppression read and acquire) and failure-arm write throws still exit the loop | ACCEPT | Both loops get an explicit outer try/catch per recipient: a pre-claim throw defers the recipient as retryable (slot queued/send_retryable, no record); a post-claim pre-send throw releases the record done/retryable and defers; a record-phase throw is sent_unrecorded; anything else is ERROR + continue. Tests for each. |
| B8 | 14 test files register the adopted handlers but only 3 inject the record repo; the lazy default is a real DynamoDB repo | ACCEPT | Task 5 lists the registration sites (grep the four register functions under app/test) and each passes sendAttemptsRepo: world.sendAttemptsRepo; RegisterJobHandlersDeps gains the field. |
| B10 | owner carries raw phone# keys into payloads and log lines | ACCEPT | The reconcile payload carries recipientKeyHash (Task 2's hashRecipientKey), never the raw key; handlers resolve the raw key from the owner's map/roster by hashing each key. Log lines use logSafeMemberKey / a safeRecipientKey helper. |
| B11, A20 | no page-size assertion; createdAfter dropped silently; UNVERIFIED note unbuilt | ACCEPT (partly) | ListMessagesArgs has no createdAfter by design (the job filters); the plan states the deviation from D17's wording. The driver WARNs when a page exceeds the requested size, and the handback records list order and page bound as UNVERIFIED until the first hosted-dev run (Sec 10). |
| A15, B12 | the relay suppression arm and the rung's refuseGate/window close are not D8-gated | ACCEPT | Before those pre-claim terminal writes, read the record consistently and skip (defer) when a FOREIGN open attempt exists; a re-drive pass owns its redriven record (unchanged). RSW's pinned slot shapes are preserved because the writes themselves are unchanged. |
| A12, B13 | test seams: world.sent has no SID/providerTs; unit tests have no sender; Task 1/3 sketches name APIs that do not exist | ACCEPT | The harness adapter records { params, sid, providerTs } on world.sent (additive); reconcile-related unit tests wire a config with BUSINESS_PHONE_NUMBER; sketches corrected to the files' real fixture names, and every sketch says "use the file's fixtures". |
| A6, B14 | the e2e sketches do not match the repo (helper names, createGroupOpen's shape, the 21211 copy, the reveal click, the intro, Task 14's chip) | ACCEPT | Task 12 rewritten as intent plus the real helpers the builder must read first; 21211 renders "Delivery failed (error 21211)" (no carrier-map entry) and the spec asserts that; rows need the bubble reveal; the intro is settled before arming the seam; ordered after Task 14. |
| A10, B15 | readers that go red are not listed (AppendResult exact-shape pins, the setRecipient spy at broadcastFanOut.test.ts:1075-1109, the registerHandlers job-set test, StatChips order) | ACCEPT | Each task lists them. |
| A17, B16 | Sec 8 clauses with no test anywhere (8.4 prepare-phase; cap-close with fresh/redriven/stale; three retryable; syssid#; known-SID fetch throws; unresolved twice; verdict-then-pass; RSW foreign-attempt window close; 8.12 rung cases) | ACCEPT | Tests added by name to Tasks 7, 8, 9, 10; the self-review mapping rewritten to cite test names. |
| B17 | Task 10's lookup contradicts itself for broadcast adoption | ACCEPT | For the broadcast owner the SID claim IS the row append, so adoptBroadcastRecipient runs inside the candidate loop and its other_owner result continues the loop. |
| A13, B18 | relay mediaCount computed before the presign is always 0 | ACCEPT | mediaCount = hasMedia and mediaStore ? sourceMedia.length : 0. |
| A19, B19 | carrierSentAt only on provider sent contradicts case 2; broadcast adoption omits the inbox touch | ACCEPT | carrierSentAt / sentAt from m.sentAt whenever present; the broadcast adoption touches the inbox the preserving way. |
| A11, B20 | the schedule wording is ambiguous | ACCEPT | Offsets from the attempt: check k runs at attemptedAt + DELAYS[k]; the enqueue delay is max(0, that - now). |
| B21, A20 | the sibling rule adds sent; 20429 in the code-first set | ACCEPT | Rule per spec (open or adopted); 20429 leaves the code-first set (status 429 decides). |
| A22, B22 | registry drift and the re-drive early-return residue text | ACCEPT | Task 15 lists the exact issues; Task 8's early-return handling closes redriven records only, and the issue text says so. |
| B23 | twilio-node's default code 0 treated as a real code | ACCEPT | codeOf ignores 0. |
| B24 | takeover edge cases | ACCEPT (partly) | A takeover does not count toward the brake; a takeOver returning false skips the recipient with an INFO; slot writes stay on their existing guards (the record fence decides) - stated as accepted. |
| A14, B25 | legacy-row relay adoption writes the slot wholesale after the pointer claim | ACCEPT | Task 6 adds adoptRelayRecipientIfUnsent (child-field conditional write from queued on legacy rows; applyRecipientSendResult on versioned); adoption never uses markRecipient. |
| A18 | timeout 1500 npm run e2e in PowerShell runs timeout.exe | ACCEPT | The gate block is bash (the Bash tool), matching AGENTS.md. |
| A22, B26 | self-QA scenarios 3-4 cannot be run as written | ACCEPT | The fake gains a fail-list control mode (list/fetch answer 500 for a party, N times) so unresolved is driven deterministically; scenario 4 uses the pinned dashboard clock rather than waiting. |
| B23 (console log) | unbounded console-driver send log | ACCEPT | Capped at 1000 entries. |
| A21 | interface loose ends (takeover vs unknown indistinguishable; deferredByClaim/attemptRef missing from Produces; exhaustive-switch test; export ownership; redrive on a transient re-enqueue) | ACCEPT | handed_to_reconcile carries reason: unknown / takeover / sent_unrecorded; Produces lists both fields; the exhaustive switch is a compile-time never only; Task 7 exports, Task 10 consumes; the transient re-enqueue strips redrive. |

**Round 1 outcome:** 49 raw findings, 32 distinct; ACCEPT 32 (3 partly), REJECT
0, DEFER 0. Decisions changed: none in the SPEC; the plan's task order and
several mechanisms changed, so plan round 2 runs with one continued reviewer.

## Plan round 2 (2026-09-26) - reviewer B continued, with A's round-1 report

Plan revision 2 @16dd3dda. Report: `plan-r2-reviewer-b.md` (19 findings).
Two findings are SPEC rulings (folded into spec revision 10); the rest are
plan mechanics. Plan revision 3 carries every ACCEPT and is SELF-CONTAINED
(finding 3): no task cites an earlier revision.

| # | finding | ruling | change |
|---|---|---|---|
| 1 | Task 8's outer catch decides "did the send happen" by whether `result` was assigned; an `unknown` whose `handToReconcile` write throws is released as retryable and re-sent | ACCEPT (HIGH) | Both units track an explicit `phase` ('prepare' -> 'sending' set BEFORE the provider call -> 'record'); a throw at phase 'sending' or later is NEVER released as retryable: it is logged at ERROR, the record is left `attempting` (the stale-claim takeover or the sweeper resolves it), and the unit returns the terminal-for-the-pass kind `stranded` (slot untouched; counts as closed for the pass; not toward the brake). |
| 2 | Task 7's catch arms do their own writes unprotected; a DB blip throws out of the loop; `outcome` is not hoisted | ACCEPT (HIGH) | Every failure-arm write goes through `guardWrite(label, fn)` which catches, logs ERROR with the owner and recipient, and never throws (D7a); `outcome` is hoisted above the try; the outer catch's last arm can therefore never rethrow. |
| 3 | revision 2 cites "revision 1" content no longer in the file (18 places); the D3 tests and the repo-primitive tests are listed nowhere | ACCEPT (HIGH) | Revision 3 restores every test list and every code block in place; the word "revision" appears only in the header. |
| 4 | Task 5 wires `sendAttemptsRepo` into the handlers' deps before the field exists | ACCEPT | Task 5 adds the optional field to the three deps interfaces (unused until Tasks 7-9) and lists the three job files. |
| 5 | `heldBy` excludes only pointer-held SIDs; a same-body sibling can adopt first; the known-SID reconcile then gets `other` with no arm | ACCEPT - SPEC RULING (D13, revision 10) | A known SID whose pointer resolves to another owner is `unresolved` cause `sid_held_elsewhere` (never re-sent); the lookup also excludes candidates whose SID appears on a sibling record from the index Query. Task 10 gains both. |
| 6 | `setRelayRecipientAttemptedAt` gives one names list for two statements | ACCEPT | Per-statement names/values. |
| 7 | legacy relay adoption's `status IN (queued, sent)` overwrites a callback-advanced `sent` with `queued`; no create-if-absent | CONCEDE (contest of A14/B25 upheld) | The legacy adoption write uses the file's own `allowedPriorStatuses(patch.status)` plus same-status idempotence, and seeds an absent slot first (`if_not_exists`). |
| 8 | the new D8 gates skip only on "foreign open"; D8 allows a close only when absent or done/retryable; a `done/sent` queued+sid leg or a stale attempting record gets overwritten | ACCEPT | Every pre-claim decline (broadcast fences, relay suppression arm, the rung's refuseGate and window close) proceeds only when the record is ABSENT, `done/retryable`, or the pass's OWN `redriven`; a stale `attempting` is taken over into reconcile; anything else defers/skips. |
| 9 | the page-size guard warns when a page is larger than requested, which cannot happen; a provider cap returns SMALLER pages | CONCEDE (contest of B11/A20 upheld) | The driver reads the page payload's `page_size` and WARNs when it differs from the requested size. |
| 10 | adding `sid`/`providerTs` to `world.sent` entries breaks an exact `toEqual` at twilioStatusWebhook.test.ts:1275 | ACCEPT | `world.sent` keeps its shape; a parallel `world.sentDetails` carries `{ params, sid, providerTs }`. |
| 11 | a re-drive pass that defers before its claim and then hits the cap skips its own `redriven` record in the cap-close | ACCEPT | On a re-drive pass the cap-close treats the pass's own `redriven` record as closable (`closeRedriven(refused, transient_cap)`). |
| 12 | broadcast fences are ungated though the deferral puts foreign-owned keys through them; D8's enumeration omits them | ACCEPT - SPEC RULING (D8, revision 10) | The fences join D8's list; Task 7 gates them exactly as the relay suppression arm. |
| 13 | case 21's "no phone# in any payload" conflicts with the continuation payloads' raw `recipientKeys` and `senderKey`; Task 7 logs the raw owner | ACCEPT (narrowed) | The continuation payloads' shapes are pre-existing (`recipientKeys` carries `phone#` keys today) and out of scope; the assertion is scoped to the `send.reconcile` payload; every log line uses `safeRecipientKey`. |
| 14 | three seam descriptions still wrong (log capture lines are parsed objects; `atLevel` takes a number; `createGroupOpen` returns no member data) | ACCEPT | Wording fixed; Task 12 tells the builder to read the helper for the member numbers it needs and to register ad-hoc parties itself. |
| 15 | `reconcileDelayMs` must read the lane-overridable delays | ACCEPT | It calls `reconcileCheckDelaysMs()`. |
| 16 | the B24 takeover slot-write deviation is stated nowhere | ACCEPT | Added to the plan's declared deviations. |
| 17 | Task 15 omits `accepted-send-lost-when-append-fails` and `exactly-once-send-intent` | ACCEPT | Both get dated sections. |
| 18 | two contacts sharing a phone in one broadcast can both adopt the same message | ACCEPT | "mine" for a broadcast = `broadcast_id` matches AND (the row's `recipient_contact_id` equals the owner's contact, or the owner's slot already carries that `tsMsgId`); otherwise `other`. |
| 19 | the D9 streak is not reset by fence skips or refused-!fresh skips | ACCEPT | Any outcome other than an unknown hand-off resets the streak, skips included. |

**Round 2 outcome:** 19 findings, ACCEPT 19 (2 as conceded contests, 2 as spec
rulings). Plan mechanics changed -> plan round 3 with the same reviewer.

## Plan round 3 (2026-09-26) - reviewer B continued (re-review charge)

Plan revision 3 @b25d7807 against spec revision 10. Report:
`plan-r3-reviewer-b.md` (20 findings: 0 blocking, 1 high, 5 medium, 14 low;
one a SPEC finding). Plan revision 4 carries every ACCEPT; the spec moves to
revision 11 (D8 gate list and the `redriven` ownership sentence; D8a's TTL
sentence). Every claim about existing code was re-checked by the reviewer at
b25d7807 with file:line; I verified the load-bearing ones (jobs.ts:91-93
`EnqueueOptions = { runAt }`; relayFanOut.ts:99-101 backoff 5 s / 10 s;
messagesRepo.ts:3481 `legacy_noop`; broadcastsRepo.ts:680-707 blind
`setRecipient`; sendMessage.test.ts:41-55, :68).

| # | finding | ruling | change |
|---|---|---|---|
| 1 | Task 10's relay_rung `never_sent` never calls `markRedriven`; the re-driven rung meets `reconciling` and strands; an enqueue failure mis-closes `unresolved` | ACCEPT (HIGH) | Every owner runs `markRedriven` (with the `redriveCount >= 1` -> `second_unknown` branch) before its re-drive enqueue; the rung gets the same pre-check as the leg; case 15b delivers the re-driven rung through Task 9's handler and asserts a claim from `redriven` and ONE send. An omission carried since revision 1, restored to what D16 already decided. |
| 2 | Task 5's eleven integration cases share one owner, one index partition and one table with no per-test reset; from case 5 on they fail against a correct repo | ACCEPT | `beforeEach` gives each case its own `broadcastId` and its own `recipientDigest`; case 9's per-outcome owners carry the case sequence. |
| 3 | the relay unit's `gateFor` hands off inside the gate AND the unit returns `handed_to_reconcile` for the loop to hand off again; `rec` is out of scope; the unit has no `senderKey` | ACCEPT | `gateFor` is redesigned for ALL THREE files: it never enqueues; it returns `{ proceed, record? } | { skip } | { defer } | { taken_over, record }`, and the CALLER hands off exactly once - the relay loop (which holds `payload.senderKey`) for the unit's takeover, `closeRelay` for the cap-close, the rung for its own. The spec's D8 paragraph now says so. |
| 4 | a relay pre-claim throw (suppression read, gate, token acquire, claim) leaves the unit and the loop drops the member for good | ACCEPT | The relay unit's outer try now wraps EVERYTHING after the terminal skip; `phase === 'prepare' && ref === undefined` defers with the transient slot write, exactly as broadcast; the loop's own catch defers rather than drops; case 15 (`isMemberSuppressed` throws once -> carried and SENT on the continuation). |
| 5 | both sibling filters compare `ownerKey` (no recipient), so same-broadcast siblings are invisible and case 5e contradicts the code; the record-held-SID swap stays open | ACCEPT (contest of R2 #18 as applied UPHELD) | New `attemptKey(owner)` = ownerKey + hashed recipient key, exported from the repo; both filters compare it. Case 5e's verdict (`unresolved` `same_fingerprint_sibling`) now follows from the code. |
| 6 | the claim TTL (30 s) is LONGER than the relay ladder (5 s + 10 s); D8a claims the opposite; a stranded relay member is never taken over by a continuation | ACCEPT - SPEC RULING (D8a, revision 11) | D8a now states the truth: the TTL equals the provider timeout and is not tuned to the ladders; broadcast's 10 s + 20 s clears it, relay's does not; a relay strand is deferred at the cap and left for the sweeper (D14). The plan's Global Constraints and Task 15's sweeper section say the same. No double send follows; the residue is "no verdict until the sweeper". |
| 7 | the stub passes `{ delaySeconds }`, which `EnqueueOptions` does not have (`{ runAt }` only, jobs.ts:91-93): TS2353 and the delay ignored | ACCEPT | `enqueue(SEND_RECONCILE_JOB, payload, { runAt: new Date(Date.now() + delayMs) })` with the `enqueue` named import broadcastFanOut.ts:88 uses; the tests assert the delay in whatever field the harness exposes for `runAt`. |
| 8 | `BRAKE`'s bare `break` inside a switch inside a catch leaves the switch, not the loop | ACCEPT | The brake is a `braked` flag read at the top of each iteration (which is also how "every key not yet attempted is deferred" is implemented); the WARN follows the loop. Both loops. |
| 9 | the pre-claim deferral `setRecipient` is blind and can revert a fence's `skipped` or a foreign attempt's `sent` | ACCEPT | The deferral is `recordRecipientOutcome(..., { status: 'queued', errorCode: send_retryable }, {}, ['queued'])`; Task 6's write supports an EMPTY delta (no `ADD` clause) with its own test; Task 7 test 3c pins that a `skipped` slot is never reverted. |
| 10 | `gateFor` has no "skip" result, so a terminal `done` record is carried to the cap | ACCEPT | `skip` for `done` with any outcome but `retryable`; broadcast continues without deferring; the relay unit returns `skipped_terminal`; Task 8 case 11 widened. |
| 11 | deviation 4 is inaccurate: the reconcile payload's `continuation.senderKey` is a raw member key | ACCEPT (contest of R2 #13 UPHELD) | Deviation 4 now declares it (carried verbatim because the re-drive envelope must repeat it); case 21 is scoped to the OWNER field. Hashing and re-resolving the sender was rejected as surface the branch does not need. |
| 12 | deviation 3 describes a skip the plan does not do: every arm writes the slot BEFORE the fenced `finishAttempt` | ACCEPT (contest of R2 #16 UPHELD) | Deviation 3 reworded to what is built: the slot keeps its own guards, a lost fence after the slot write is WARNed and not rolled back, and the takeover's reconcile repairs through the pointer. |
| 13 | the rejected arms write an HTTP status (e.g. `'400'`) as the slot code - a fake carrier number D10/D23 exclude | ACCEPT | A code-less rejection writes NO slot `errorCode` (badge `Delivery failed`); the record's `cause` keeps `String(status)`; `sms_sending_disabled` stays a slot code (it has prose). Global Constraint added; Task 7 test 13, Task 8 case 17; Review Focus 1 now has a slot-level pin too. |
| 14 | Task 3's sketch uses `f.env` and `f.sent[0].sid`, which do not exist, digests the wrong phone (`+15550100001`), and cites `errorCodeOf` at the wrong file | ACCEPT | Sketch fixed: the configured BUSINESS_PHONE_NUMBER and the fake adapter's SID are named as "read makeFakes"; the phone corrected; `errorCodeOf` cited at broadcastFanOut.ts:176-185. |
| 15 | test 5c's "zero sends" is vacuous (the override records nothing); tests 5c/7b/8 would drain a `send.reconcile` envelope with no handler and die on `MalformedJobEnvelopeError` | ACCEPT | The override counts its own calls (`sends[]`); every test that produces a reconcile envelope drains ONLY the `broadcast.send` envelopes it needs (the file's shift idiom) and asserts the reconcile envelope by inspection; the same instruction in Task 8. |
| 16 | the D9 streak treats `stranded` inconsistently; a joint outage (provider + DynamoDB) never brakes | ACCEPT (reverses my R2 #1 note) | A stranded UNKNOWN counts toward the streak in both loops; a lost hand-off after a KNOWN send (`sent_unrecorded`'s stranded variant, `stranded.afterSend`) resets it - the provider answered. Task 7 test 4e; Task 8 case 7. |
| 17 | a re-drive deferral whose continuation drops the marker strands the `redriven` record if a fence then trips | ACCEPT - SPEC PRECISION (D8, revision 11) | A `redriven` record is closable by ANY pass's decline (it is claimable by any pass already, and the decline would apply to the re-drive pass equally). The gate no longer takes a `redrive` flag; the unit drops its `redrive` arg. Task 7 test 9d; Task 8 case 16. |
| 18 | `adoptRelayRecipientIfUnsent` does not say how it tells legacy from versioned; delegating first maps `legacy_noop` to `missing` and the job DLQs | ACCEPT | Delegate first; `legacy_noop` IS the discriminator and routes to the legacy branch. |
| 19 | the `sid_held_elsewhere` ERROR names only the current owner; the lookup's `mine` path returns `adopt()`'s `other` unfiltered | ACCEPT | `heldBy` returns `{ kind, holder }`; the ERROR carries `heldBy`; the `mine` path maps `other` to `unresolved` `sid_held_elsewhere` as `adoptKnown` does; case 15c. |
| 20 | "the dashboard's pinned clock" does not exist at lane level | ACCEPT | Task 16 seeds a wall-clock `attemptedAt` 16 minutes old. |

**Round 3 outcome:** 20 findings, ACCEPT 20 (3 as upheld contests of round-2
rulings, 2 as spec edits). **Decision test:** no accepted finding added or
removed a surface or moved what gets built - #1 restores a D16 decision the
plan had dropped; #3/#10/#17 restructure the gate helper and align D8's
`redriven` wording with the claim rule D8a already had; #6 corrects a false
sentence about a mechanism (nothing built changes; the sweeper residue was
already filed); #16 flips one line of streak bookkeeping. This is a round of
precision and omission fixes: TERMINAL under the stop rule. Plan review
closed at round 3 (cap 4 not reached). The orchestrator's own review and the
planner's independent review on handback remain downstream.
