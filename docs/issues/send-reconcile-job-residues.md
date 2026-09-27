---
id: send-reconcile-job-residues
title: The send.reconcile job's own residues as built - a lost audit row, an adoption filed under a changed number, three accepted ordering windows, noisy or permanent failures
type: bug
severity: low
status: open
area: app/messaging
created: 2026-09-27
updated: 2026-09-27
refs: app/src/jobs/sendReconcile.ts:205, app/src/jobs/sendReconcile.ts:459, app/src/jobs/sendReconcile.ts:490, app/src/jobs/sendReconcile.ts:628, app/src/jobs/sendReconcile.ts:639, app/src/jobs/sendReconcile.ts:642, app/src/jobs/sendReconcile.ts:687, app/src/jobs/sendReconcile.ts:886, app/src/jobs/broadcastFanOut.ts:1295, app/src/jobs/broadcastFanOut.ts:1361, app/src/jobs/broadcastFanOut.ts:1381, app/src/repos/messagesRepo.ts:4016
---

**Problem.** `feat/send-outcome-reconcile` built the `send.reconcile` job
(`app/src/jobs/sendReconcile.ts`) and the broadcast adoption it calls
(`adoptBroadcastRecipient`, `app/src/jobs/broadcastFanOut.ts:1279-1417`). The
build recorded these residues of the job itself (build S3a residues 1-3 and
6-10, with the S3b mutant pass's note on residue 6; line numbers at the
branch's HEAD). None can text anyone twice; each is bookkeeping, ordering,
presentation or noise. Grouped because they share one job and one fix surface.

1. **A lost audit row.** An adoption that dies between its row append
   (`broadcastFanOut.ts:1304-1319`) and its slot write (`:1341-1353`) loses
   the conversation's `message_sent` audit row: the retry's append dedupes on
   the SID, and the audit row is written only for a fresh append
   (`:1358-1371`).
2. **An adoption filed under a changed number.** A known-SID broadcast
   adoption whose row was never appended (a `SendAcceptedNotRecordedError`)
   files the row by the contact's CURRENT phone (`:1289-1295`), and the
   known-SID path skips the digest check (spec D12), so a number change between
   the send and the adoption puts the row in the new number's 1:1
   conversation. The only wrong-conversation risk the build found; it needs a
   number change inside the reconcile window (checks at about 5 s, 30 s and 4
   minutes after the attempt) on a send that landed unrecorded.
3. **A legacy relay re-run reports `adopted`.** The legacy adoption statement
   accepts the target status as its own prior
   (`app/src/repos/messagesRepo.ts:4016-4076`, the priors at `:4056`), so it
   cannot tell a same-status rewrite from a move; a redelivered adoption
   re-emits `message.persisted` and re-WARNs a terminal failure
   (`sendReconcile.ts:642-657`). Harmless: the writes are idempotent and the
   dashboard only refetches.
4. **A contact member off the roster is ruled `digest_mismatch`.** The
   lookup's current number is the roster member's phone, else a `phone#` key's
   own number (`sendReconcile.ts:490-505`); a contact member who has left the
   roster has neither, so the check closes `unresolved` with cause
   `digest_mismatch` (`:735-738`) rather than reading the contact. The
   conservative direction - never a re-send; only the logged cause is
   imprecise.
5. **Three ordering windows, accepted (build ruling A10).**
   - The inbox touch is read-then-write: the adoption compares
     `last_activity_at` and then writes it with an unconditional SET
     (`broadcastFanOut.ts:1375-1386`; the rung's `touchInboxForward`,
     `sendReconcile.ts:687-697`), so an inbound touch landing in between can be
     moved backwards and the inbox order regresses (build finding T10-12).
   - A relay receipt that lands after the adoption's pointer claim
     (`sendReconcile.ts:628`) and before its slot write (`:633-638`) finds the
     pointer and is applied by the webhook; the adoption then reports
     `skipped` (still `found`) and the slot ends without the adopted `sid` and
     `sentAt`. Spec D15 accepts only the window between the status read and
     the pointer write; this second one is accepted too (build finding T10-13).
   - The roster read behind the digest check and the re-drive pre-check is
     eventually consistent: `conversationsRepo.getById` has no consistent
     variant (`sendReconcile.ts:459`), so the member phone the digest compares
     and the group status and membership the pre-check reads (`:990-997`) can
     be stale - safe for the pre-check (the re-drive pass re-reads and
     re-filters), weaker for the digest (build finding T10-7).
6. **Duplicate chains, duplicate ERRORs.** Two duplicate check chains that
   both pass the state check before either closes each log their own
   `unresolved` ERROR (`sendReconcile.ts:886-891`). Only one record close lands
   (the other line carries `recordClosed: false`), but one recipient can put
   two ERROR lines toward the error-log alarm.
7. **A relay adoption onto a missing row or slot throws**
   (`sendReconcile.ts:639-641`). On SQS that is a genuine retry that ends in
   the DLQ with the record still `reconciling`; on the hermetic lane, or any
   stack without `JOBS_QUEUE_URL`, the in-process dispatch is never
   redelivered, so the chain dies at once (build finding T10-11). The pointer
   claim (`:628`) lands before the throw, so every retry re-finds its own
   pointer and throws again, leaving a `relaysid#` pointer to a row that does
   not exist (build S3b note). Unreachable in practice: relay rows are never
   deleted. The record it leaves is
   [send-attempt-sweeper](./send-attempt-sweeper.md)'s to find.
8. **A malformed payload is retried, not dropped.**
   `parseSendReconcilePayload` throws (`sendReconcile.ts:205-219`), so a
   malformed envelope fails five times and reaches the DLQ instead of being
   deleted as poison - the same as the other handlers' parse throws.

**Suggested fix.** Optional, and each separate: write the audit row
idempotently, keyed on the SID, so a retry can re-attempt it without a
duplicate - a row the send wrapper appended was already audited (1); file a
known-SID
adoption's row by the number the provider sent to rather than the contact's
current phone (2); an atomic inbox guard needs a conditional touch in the
conversations repo (5, first bullet); log the `unresolved` ERROR only from the
chain whose record close landed (6). The rest are accepted as they stand.

**Related.** [send-attempt-sweeper](./send-attempt-sweeper.md),
[accepted-send-lost-when-append-fails](./accepted-send-lost-when-append-fails.md),
[status-callback-passive-match-for-pending-reconcile](./status-callback-passive-match-for-pending-reconcile.md),
[relay-fanout-closes-emit-nothing](./relay-fanout-closes-emit-nothing.md).

## Addendum 2026-09-27 - code review rounds 1-4

The branch's four code review rounds and five fix waves left the residues
below in the job and its broadcast adoption (records under
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/code-review/`:
`r1-adjudications.md` sections 4-7, `fw1-report.md` and `fw2-report.md`
"New residues", `r2-adjudications.md` sections 2-4, `fw4-report.md`,
`r3-adjudications.md`, `fw5-report.md`, `r4-review.md`,
`r4-adjudications.md`). Anchors are at the code-final commit `52220729`; the
anchors in items 1-8 above predate the review, so re-derive them by reading.
None of these was fixed on the branch: each is LOW, a double fault or
logging, and falls under the human's standing ruling there (Cameron,
2026-09-27, `r1-adjudications.md` section 6): a double text is annoying, not
critical; no new machinery or failure points on a double-fault path.

**Item 6 above is closed by FW1-4.** The job's own closes now write the
RECORD first and log the `unresolved` ERROR only after that close won
(`closeUnresolved`, `app/src/jobs/sendReconcile.ts:1003-1024`); a chain whose
record close lost logs INFO and writes nothing, and the `recordClosed: false`
field is gone from those lines (FW1 deviation 3). The intro's "none can text
anyone twice" covers items 1-8; item 10 below carries a narrow exception.
Severity stays `low`: every new item is LOW in the review, and item 10's path
needs a crash and a number change together.

9. **Two deliveries of one check reaching different verdicts (round 1
   conformance D-3, shape as of FW1-4).** A duplicate delivery of one check
   passes `recordCheck`, which tolerates its own duplicate
   (`app/src/repos/sendAttemptsRepo.ts:541-548`). If the provider fails for
   one delivery (A: `unresolved` / `provider_unreachable`) and answers the
   other (B: `found`), and A's record close wins first, A logs its ERROR and
   closes the slot `send_unconfirmed` (`sendReconcile.ts:1011-1022`). When
   that slot write lands before B's adoption writes the slot, B appends the
   1:1 row (the SID claim) but its slot write, from `queued` only, does not
   move (`app/src/jobs/broadcastFanOut.ts:1403-1416`, answered `skipped`),
   and B's `adopted` close loses (the found INFO carries `recordClosed:
   false`, `sendReconcile.ts:429-441`). The share row then reads "Not
   confirmed" beside a row in the tenant's thread that shows the text went
   out; the relay twin leaves the leg `send_unconfirmed` with its
   `relaysid#` pointer claimed. Other orders are benign: B's slot first gives
   a correct slot under a record that says `unresolved`; B's record close
   first makes A write nothing. Needs an SQS duplicate plus a flapping
   provider. (Round 1's wording had the record ending `adopted`; FW1-4's
   record-first closes changed that. The finding's second half - a
   redelivery after a record close that THREW re-runs the lookup - is now a
   fresh judgment: a close that did land is completed by the superseded
   exit's re-apply, `:405-421`.)
10. **A phone-keyed broadcast recipient's two remaining contact reads go
    through the byPhone GSI (round 1 C-8 remainder, FW1 residue 1).** FW1-9
    removed the third (the current-number read now takes a `phone#` key's
    own number, `sendReconcile.ts:519-522`). Left: `heldBy`'s contact read
    (`contactOf`, `:510-513`, called at `:596` - only when a candidate SID
    has a `sid#` row, `:593-594`) and the adoption's
    (`broadcastFanOut.ts:1351`); both go through `resolveContact`, which
    reads a `phone#` key with `contacts.findByPhone` (`:1192-1200`), a byPhone
    GSI query (`app/src/repos/contactsRepo.ts:1022-1031`) - against spec
    D11's "no coordination read through a GSI". The review recorded that both
    err toward `other_owner`, `unresolved` or a retry: a missing contact in
    the adoption throws (`broadcastFanOut.ts:1352-1356`), a genuine retry;
    in `heldBy` a stale or moved answer reads our own row as another
    owner's. Filer's reading (FW3, code reading only, not reproduced):
    `other` is not always the safe direction - such a candidate is skipped
    without counting as unmatched (`sendReconcile.ts:862-869`), so on a
    complete last walk with nothing else in the window it ends `never_sent`
    and one re-drive (`:899-906`), a double text. That needs the lookup
    path to meet our own appended row with no SID on the record and no
    `tsMsgId` on the slot - a crash between the pass's append and its slot
    write, the record later taken over - AND the number to move to another
    contact inside the reconcile window. It matters most once
    [send-attempt-sweeper](./send-attempt-sweeper.md) hands crashed attempts
    to this lookup. No fix was designed for these two reads; round 1's
    direction (use a `phone#` key's own number, as the relay branch does)
    fits only the current-number read, which FW1-9 fixed.
11. **A crash between the broadcast pass's slot write and its follow-ups
    loses the property rows (FW2 residue 7: the unbuilt adoption half of
    FW2-6).** FW2-6 runs `afterSend` - the A2P token, the `listing_sent`
    milestone and the listing-send row - after the slot write and before the
    record's `done`/`sent` (`broadcastFanOut.ts:941-950`), so a record write
    that THROWS keeps the rows. A process that DIES between the slot write
    and `afterSend` leaves the record `attempting`; its later reconcile
    adopts the message, but the adoption finds the slot already moved,
    answers `skipped` and never reaches step 3 (`:1416`; the rows at
    `:1456-1463`). The tenant's timeline misses "Property sent" and the
    unit's "Sent to tenants" list misses the tenant. Designed fix: make the
    milestone write idempotent - `activityEvents.record` Puts a new row with
    a random `evt-<uuid>` key every call
    (`app/src/repos/activityEventsRepo.ts:125-127`), so a deterministic
    event id is needed; `listingSends.recordSend` is already an idempotent
    upsert - and then let the adoption write both rows when the slot already
    carries THIS row's `tsMsgId` with status `sent` or `delivered`.
12. **Rule (c)'s cost: a heavy-history recipient closes page-bound (FW4
    residue 2; round 3 and round 4 wording).** Since FW4-1, `never_sent`
    needs a COMPLETE walk, so a recipient with more than 5 pages (5000
    messages at the requested page size) from one sender and nothing
    adoptable closes `unresolved` / `page_bound` at the last check
    (`sendReconcile.ts:854-857`, `:898`) - "Not confirmed", never re-sent
    automatically, even when the send was genuinely lost. This is the spec's
    design, not a change against it: D13 "a walk that exhausts the bound is
    `unresolved`" (design `:588-590`) and D16's "page bound exceeded" cause
    (`:730`). Round 4 corrected round 3's "NOT a behavior change against the
    spec or main": main has no reconcile, so the ground is the spec alone.
    The last check now also makes up to 4 more list calls (it never stops
    early). Pinned by `app/test/sendReconcile.test.ts:912`. The real page
    size decides where the bound falls
    ([send-reconcile-hosted-dev-checks](./send-reconcile-hosted-dev-checks.md),
    item 2).
13. **A list error mid-walk before an adoption is logged nowhere, and the
    error lines carry no page count (FW5 residue; round 4 F-1, CONFIRMED by
    its probe P9).** Since FW5-1 a failed list call ends the walk and the
    candidates already read are still judged (`sendReconcile.ts:839-842`).
    When that judging adopts (`:871`) or returns its own
    `sid_held_elsewhere` (`:872-880`), the list error is dropped: the found
    INFO carries no error (`:429-441`). Before FW5 the same failure always
    left the `provider_error` WARN (`:448-450`) or the `provider_unreachable`
    ERROR. Walks that adopt nothing still log it, so a systematic failure of
    the next-page call - the path spec Sec 10 lists as unverified,
    `app/src/adapters/messaging.ts:1139-1140` - is undercounted, not hidden.
    Separately, the error verdicts carry `err` but no `pages`
    (`sendReconcile.ts:892-896`), so an operator cannot tell a page-1 failure
    from a mid-walk one. Round 4 also corrected round 3's "an added call can
    only ADD evidence": true for verdicts, not for logs. Designed fix,
    log-only: put `pages` and the list error on the found line, the
    `sid_held_elsewhere` line and the error verdicts' extra. Not a fix wave:
    round 4's ledger rule opens one only for a confirmed MEDIUM or worse or
    a double-send or lost-send path (`r4-adjudications.md`).
14. **Unpinned order: the judging's own `sid_held_elsewhere` outranks a list
    error (round 4; FW5 deviation 2, accepted).** On a walk a list error
    ended, the loop's `sid_held_elsewhere` return (`sendReconcile.ts:872-880`)
    comes before the error verdict (`:892-896`) - the message exists and is
    never re-sent, as it already outranks the cut rule. Round 4's throwaway
    probe P8 held it at `52220729`; no committed test pins it, so a mutant
    gating `:872` on `listFailure === undefined` would survive. Harmless
    either way: the flip gives `continue` / `provider_error` before the last
    check (the next check meets the same candidate) or `unresolved` with
    cause `provider_unreachable` instead of `sid_held_elsewhere` at it. Fix:
    pin it in `app/test/sendReconcile.test.ts`, or name it in the lookup's
    comment.
15. **The non-record conditional writes and the SDK's replay (round 1 ADV-3
    note, corrected here).** FW1-5's op token makes every fenced RECORD
    transition safe against the SDK replaying a write that committed; the
    slot and stats writes keep the plain reading "condition failed = someone
    else moved it". The note said such a replay "can only cost a progress
    tick", which holds for the pass's success write
    (`broadcastFanOut.ts:941-948`) and the closes' `closeRecipientIfQueued`
    (the emit is gated on `moved`), but not everywhere. Filer's reading (FW3,
    code reading only): the adoption's slot write
    (`recordRecipientOutcome` from `queued`, `broadcastFanOut.ts:1403-1416`)
    replayed after it committed fails its own condition, answers `moved:
    false`, and the adoption returns `skipped` before step 3 - the same loss
    as item 11 (the audit row, the inbox touch, the emits, the property
    rows) by another road. The relay pointer claim reads back and answers
    `mine` on a replay (`app/src/repos/messagesRepo.ts:4156-4190`); the
    versioned relay slot writer's answer to a replay was not checked. See
    also [send-attempt-sweeper](./send-attempt-sweeper.md), Addendum
    2026-09-27, on the op token's own narrow re-read window.
16. **A provider-error check logs a generic "nothing adoptable yet" INFO
    after its WARN (live self-QA, 2026-09-27).** A check whose lookup failed
    logs the WARN "the provider lookup failed at this check - the next check
    tries again" (`app/src/jobs/sendReconcile.ts:448-450`) and then, once the
    next check is enqueued, the INFO "nothing adoptable yet - the next check
    is scheduled" (`:456-459`) - which carries `reason: provider_error` but
    says something that was never found out: the lookup never ran to
    judging. Log wording only; seen on the lane in self-QA scenario 3
    (`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/self-qa.md`).
    Fix: word the INFO by its reason ("the next check is scheduled" alone, or
    one line per reason).
