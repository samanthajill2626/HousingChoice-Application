> Recovered during cleanup on 2026-09-28 from `.superpowers/sdd/fw3-residue-checklist.md`. The original synthesis of review residues is preserved verbatim below; its issue-filing instructions describe the build stage, not new work. See the [closeout record](README.md) for current status.

# FW3 residue checklist (orchestrator reference - run state, not a record)

Every item below must end up in docs/issues/ (a new file from _TEMPLATE.md, or a
dated addendum section in the named existing issue). Source records live under
docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/code-review/ . Cite
code by file:line at HEAD (code = 52220729). Where a later round CORRECTED an
earlier record's claim, file the CORRECTED version (the correction is noted).

## A. Round 1 residues - r1-adjudications.md section 4 (as corrected by section 7 and r2-adjudications.md section 4)

A1. NEW `send-attempt-gate-then-close-window` (low): C-4 / R-b - the gate read and
    another writer's close are not atomic (fences, cap-closes, the suppression arm,
    refuseGate / closeTerminally); a claim between them can be recorded under the
    close; closing it needs a transactional record condition with the slot write;
    the redriven case is closed (FW2-4, c44216cd).
A2. C-11 / R-c2 -> `fanout-close-path-robustness-residues`: a known-send hand-off
    enqueue failure closes the record `unresolved` and the slot `send_unconfirmed`
    although the provider accepted the message (a double fault).
A3. D-3 -> `send-reconcile-job-residues`: two deliveries of one check reaching
    different verdicts (unresolved vs found) can leave the slot `send_unconfirmed`
    beside an appended row; needs an SQS duplicate plus a flapping provider.
A4. ADV-8 -> NEW (low): the broadcast send route's unconditional `markFailed` on an
    ambiguous enqueue failure cannot be undone by the conditional finalize.
A5. ADV-9 -> NEW (low): the recipient hashes are unkeyed sha256 over a phone
    (brute-forceable); keying needs a secret (infra - not on this branch). Note
    FW1-10 (6763d51b) already removed the hash from the not-found INFO.
A6. ADV-1 note, CORRECTED by round 2 (A-1): see C2 below - file C2, not the
    withdrawn "cannot produce a second send" wording.
A7. ADV-3 note: the non-record conditional writes (slot/stats) keep the plain
    "condition failed = someone else" reading; an SDK replay can only cost a
    progress tick there.

## B. Fix-wave residues

From fw1-report.md "New residues":
B1. C-8 remainder: heldBy's contact read and the adoption's contact read still go
    through the byPhone GSI for a phone# broadcast key; both err toward
    other_owner, unresolved or a retry.
B2. rearm cost: each send gains 1 consistent Get + 1 TransactWrite (+1 Get on a
    lost condition); a DynamoDB fault at the re-arm defers the send (fails closed)
    - merge with fw2 residue 2.
B3. Op-token re-read window (the narrow ADV-3-note class): a write that committed
    and was then overwritten by another writer's transition before the re-read
    reports false.
B4. Window TRAIL assumption: TRAIL (90 s) assumes Twilio creates the message within
    90 s of the re-arm; the Twilio timeout is an idle-socket timeout, so a request
    that trickles past TRAIL puts its orphan outside the window - never_sent and a
    re-send (a double text; extreme). Pairs with C2.
B5. The early stop and list order - SUPERSEDED by FW4-1: the early stop now runs
    only before the last check and only saves cost; never_sent needs a complete
    walk. File only the remaining truth (the order is unverified; see D1).
B6. Replay safety unproven locally: DynamoDB Local cannot show ClientRequestToken
    replay behavior; the belt covers the re-arm either way.

From fw2-report.md "New residues" (1-8), with round 2's corrections:
B7. Relay slot clock: the relay slot's D20a clock is the claim instant, not the
    re-arm; after a long pre-send stall the leg can read "Queued - not confirmed"
    up to the stall's length early (display only).
B8. Rejected recipient with a failed slot write (FW2-2): left attempting and
    carried. CORRECTED by round 2 (N-1): only a PASS-1 strand is stale by the
    broadcast cap and taken over (then reconcile rules never_sent and re-drives
    once - a second provider call for a rejected send; for 30007 it re-offers
    filtered content); a strand in pass 2/3 or any re-drive pass stays attempting
    and the share stays Sending until the sweeper (see C1). Relay: the ladder
    never clears the TTL - the sweeper's.
B9. A won record close whose slot write then throws (fence, suppression arm,
    cap-close, rung): the record ends done/refused while the slot stays open; the
    next gate SKIPs it and nothing re-applies the slot (FW1-4's re-apply covers
    only the reconcile's own closes); the broadcast then defers finalize (a
    double fault).
B10. Rung closeRedriven throw (FW2-4): a guarded throw leaves the record redriven
    and the retry leg queued (the T9-7 stranding class).
B11. Bucket wait holds the record (FW2-6), CORRECTED by round 2 (F-3): the A2P
    token bucket is shared first-come by every SMS job, so "well under 30 s" is
    NOT guaranteed under load; a takeover of an already-sent recipient is harmless
    (the adoption finds the slot moved; finishAttempt logs a lost fence) but it
    widens C2's takeover window.
B12. Adoption half unbuilt (FW2-6): if the process dies between the slot write and
    the follow-ups, the adoption finds the slot moved and the property rows are
    lost; needs an idempotent milestone write (activityEvents.record Puts a random
    evt-<uuid> row; a deterministic eventId would make it idempotent).
B13. Asymmetry: on relay a stranded rejection or refusal counts toward the D9
    brake (a double fault), although D9 says a rejection resets it; the broadcast
    twin does not count. Also the S2a label list is stale (`fenceWrite` no longer
    exists).

From fw4-report.md "New residues":
B14. Spec text twin: spec D8a rev 11 (design.md about :444-445) says "the broadcast
    ladder (10 s + 20 s) clears it, so a stuck broadcast attempt is taken over at
    the cap" - true only for a pass-1 strand (N-1). The spec is the approved
    contract and is NOT edited on this branch; name the erratum in the sweeper
    issue.
B15. Rule (c)'s cost: a recipient with more than 5 pages (5000 messages) from one
    sender and nothing adoptable closes unresolved page_bound at the last check
    instead of never_sent - "Not confirmed", never re-sent automatically. This is
    the spec's design (D13 "a walk that exhausts the bound is unresolved",
    design.md:589; D16 "page bound exceeded"). The last check makes up to 4 more
    list calls.
B16. On the throw path of the 30005/30006 arm no line says the contact was flagged
    (the flag write still runs; its failure logs its own ERROR; the carry WARN
    carries the errorCode).

From fw5-report.md and r4-review.md:
B17. The provider_unreachable ERROR carries no page count, AND (round 4 F-1) a list
    error mid-walk that precedes an adoption or the judging's own
    sid_held_elsewhere is logged nowhere (the found INFO carries no error); walks
    that adopt nothing still log it, so a systematic next-page failure is
    undercounted. Designed fix (log-only): put `pages` and the list error on the
    found line, the sid_held_elsewhere line and the error verdicts' extra.
B18. Unpinned order (round 4, deviation 2): on an error-ended walk the judging's
    own sid_held_elsewhere outranks the error; no committed test pins it
    (harmless - a flip gives continue provider_error and the next check meets the
    same candidate).

## C. Round 2 residues - r2-adjudications.md section 2

C1. N-1 / R2C-3 / A-3 / F-2 -> `send-attempt-sweeper` (and the close-path issue
    if it fits better): the stuck-Sending double fault in broadcast pass 2/3 or a
    re-drive pass (pre-existing hand-off strand + FW2-2's three arms); relay
    concedes the same (relayFanOut.ts about :1400-1408); the reviewer's fix
    directions (hand to reconcile directly; let the cap close take over records
    this pass abandoned) recorded as declined under the human's ruling.
C2. A-1 -> the ADV-1 residue, CORRECTED: the re-arm NARROWS the double-text window
    to its own two DynamoDB calls (consistent Get + TransactWrite,
    sendAttemptsRepo.ts about :379-420) on a client with no request timeout; the
    sites stamp the re-arm before the call; a stall of about 90 s or more inside
    the re-arm (a Get stall committing a stale stamp, or a response stall after
    the commit) plus a concurrent taker (an SQS redelivery) can still send twice.
    Designed fixes: a client request timeout (+ throwOnRequestTimeout); or stamp
    inside the re-arm after its Get and re-check the elapsed time after the
    TransactWrite, failing closed. Held by the human's ruling (a double text is
    annoying, not critical; no new machinery). Put it where the sweeper / send
    residues live, or a NEW issue if cleaner.
C3. R2C-6 (with C2): a re-arm that commits and then throws defers on the
    pre-re-arm ref; the release fences out; record attempting on the re-armed
    clock, slot queued/send_retryable - the sweeper's; nothing sent.
C4. R2C-7 (with C2): the automated-send breaker counts before the re-arm hook
    (sendMessage.ts about :549-573 before :615) - a lost or thrown re-arm spends a
    count for a text never sent (bounded).
C5. R2C-5 -> `send-attempt-sweeper`: the broadcast known arms write slot + stats in
    ONE guardWrite (broadcastFanOut.ts about :696-705); a stats-only failure
    carries the recipient and keeps the record attempting beside a terminal slot
    (a false open record); the sweeper must read the slot before any re-drive.
C6. The rung's stranded arms emit no root close (relayRetryLeg.ts about :930-952) ->
    `relay-fanout-closes-emit-nothing` (the emit-nothing class).

## D. Notes that also belong in the registry

D1. R2C-2 + spec Sec 10 + D-4 -> NEW `send-reconcile-hosted-dev-checks` (the
    verification owed at the first hosted-dev run): the list walk's order and page
    bound against real Twilio; whether the Messages list shows a queued/accepted
    message at all and where rows with a null date_sent sort (the spike's B1 step
    saw a just-created message absent and present 2 s later; if unsent messages
    are unlisted, a message held in Twilio's queue past +240 s is ruled never_sent
    and re-driven - a double text - whatever FW4-1 does); whether the PROD
    Messaging Service has Smart Encoding on; link shortening and Advanced Opt-Out
    (D-4). Severity: med (a possible double text rides on it) unless the evidence
    says otherwise.
