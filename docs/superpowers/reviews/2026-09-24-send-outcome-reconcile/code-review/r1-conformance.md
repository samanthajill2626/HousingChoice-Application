# Code review round 1 - spec conformance (HEAD 83308e15, spec rev 11, plan rev 4)

Reviewer: spec-conformance child (Claude Opus 5.5, 1M context), read-only,
dispatched by the build orchestrator in parallel with the plan-blind
adversarial reviewer. Record note: the reviewer returned this report as TEXT
(the harness refuses report files from subagents); the orchestrator landed it
here verbatim in substance. Adjudications are in `r1-adjudications.md`.

Tracked files untouched; HEAD unchanged. One probe file, `app/test/zz-conf-1.test.ts`
(3 probes, 3 passed; cited as P1-P3), was created, run and deleted. The
untracked `app/test/zz-adv-1..4.test.ts` files seen during the review were the
other reviewer's and were left alone.

**Bottom line:** 29 decisions checked. 23 CONFORM. 6 are PARTIAL: D1, D7a, D8,
D11, D13 and D20. None is MISSING.
- Merge-blocking: C-1. F-1 is still open at HEAD, and the fix the orchestrator
  routed does not fully close it.
- MEDIUM: C-2 and C-3 (held item R-e and its fence twin). Probes P1 and P2
  confirm both: a broadcast is left `sending` forever and no sweeper can see it.
- LOW: everything else.

## A. Conformance table

### Decisions

| item | verdict | implemented at | pinned by |
|---|---|---|---|
| D1 | PARTIAL (C-5) | sendOutcome.ts:69-87 (codes first :78-79; 5xx :81; 429 :82; 4xx :83; network :85; kill switch :70) | sendOutcome.test.ts, all 11 cases (incl. "HTTP 4xx is rejected except the rate limit", "a 4xx with no code ... Review Focus 1") |
| D2 | CONFORMS | sendOutcome.ts:86; broadcastFanOut.ts:976-977 (an untyped error counts as unknown) | "anything it cannot place is unknown (D2)"; bft "14 anything else thrown at the send is an UNKNOWN outcome" |
| D3 | CONFORMS | sendMessage.ts:217-289 (classes), :416-423 (`notAttempted` never wraps a refusal), :604-612, :660-671, :676-710 (post-append steps best-effort; `conversation.updated` skipped when the touch fails) | sendMessage.test.ts describe "typed send errors (spec D3)" (10 cases) |
| D3a | CONFORMS | bft :889-908 and catch :924-934; relayFanOut.ts:2027-2062 and :2114-2127 (record-phase failure -> SID to reconcile, never classified) | bft 5a/5b; relay 6/6b |
| D4 | CONFORMS | messaging.ts:650 | messaging.test.ts "fires send_throttled on a real 20429 and not on ECONNREFUSED (spec D4)" |
| D5 | CONFORMS | bft onRejected :681-748; relayFanOut.ts:2149-2192 (`sms_sending_disabled` token, relay records the code only) | bft 13/13b/13c; relay 5/17/18/19 |
| D6 | CONFORMS | bft :982-993 and deferClaimed :630-637; relayFanOut.ts:2194-2209 | bft 10/10b; relay 18 |
| D7 | CONFORMS | bft handToReconcile :608-624, handOff :572-597; relayFanOut.ts:1196-1226 and loop :1388-1401; relayRetryLeg.ts:641-669 and :905-937 | bft 1/6; relay 1/20; rung "a reconcile enqueue that throws closes the rung unresolved ..." |
| D7a | PARTIAL (C-2, C-3) | phase units: bft runRecipient :806-998; relayFanOut.ts:1848-2238; guardWrite.ts; claim placement bft :833 and relayFanOut.ts:1941 | bft 3/3b/5a-5d/10b; relay SOR 13, 6, 7, 15; guardWrite.test.ts |
| D8 | PARTIAL (C-4) | gateFor bft :256-265, relay :1663-1672, rung :395-404; closeBroadcast :443-499; closeRelay :1244-1293; closeUnlessOwned :691-729; closeRecipientIfQueued broadcastsRepo.ts:925; closeRelayRecipientIfUnsent messagesRepo.ts:3949-4013 | bft 8/8b/8c/9a-9e/11-11d; relay 4/4b/4c/9b/11a-11f/14/16; rung closeSites matrix |
| D8a | CONFORMS | sendAttemptsRepo.ts:329-352 (claim; TTL :348-349), :297-309 (index item), :377-471 (fenced transitions); relayFanOut.ts:1982-1991 (attempt clock) | sendAttemptsRepo.integration (32 cases, e.g. "a stale attempting record ... is a takeover ...", "a record holding a SID refuses every later claim"); harness parity file; relay 1/2 |
| D9 | CONFORMS | bft :1005-1035; relayFanOut.ts:1331-1440 and isUnknownOutcome :1605-1617 | bft 4a-4e; relay 8a-8h |
| D10 | CONFORMS | sendOutcome.ts:14-19; no new slot status anywhere | bft 13 (no HTTP status on a slot); mirror test |
| D11 | PARTIAL (C-8; spec-level note D-3) | sendReconcile.ts:10-17 (no marker), :386-399, conditional transitions in sendAttemptsRepo; consistent twins in messagesRepo (:2458, :3381, :4196, :4236) and broadcastsRepo.ts:644 | reconcile "registers WITHOUT the run-once marker ...", 14/14a/14b/14c/14d, 11c; integration "... COMPLETED by the redelivery ..." |
| D12 | CONFORMS (C-10 LOW note) | parser :205-219; toOwnerRef :121-140; currentPhone :490-505; digest check :735-737; no_sender :734 | reconcile 13 (RF2), 13a, 21; relay-owner 13 and 21 |
| D13 | PARTIAL (C-1; F-2 fix pending) | lookup :731-808; matches :518-522; sameFingerprint :530-533; heldBy :546-580; adoptKnown :706-718 | reconcile 1/1b/4/5/5b-5m/6/6b/6c/9/10/10b/12/13b/13c; relay 7/8/8b-8f |
| D13a | CONFORMS | reconcileDelayMs :151-153; lane seam :143-148; parser bound :213; enqueueOrClose :904-936; re-drive pass takes no rung up front (bft :526-542 and :1057-1074; relay :1304 and :1456-1478) | reconcile 4/17/17a/17b/18/20; bft 9a/9b/9f/9g; relay 9a/9c/10 |
| D14 | CONFORMS (recorded, not built) | docs/issues/send-attempt-sweeper.md | n/a |
| D15 | CONFORMS | adoptBroadcastRecipient bft :1279-1417; adoptRelay sendReconcile.ts:620-660; touchInboxForward :687-697 | reconcile 2/2a-2g/3/3c/3d/16/16b/16c/3b/3f/3g/3h; integration "an adoption never regresses a slot ..." |
| D16 | CONFORMS | runCheck switch :401-443; redrive :1029-1054; redriveRefusal :990-997; closeUnresolved :878-893 | reconcile 11/11b/15/15a/15b/15d/17 |
| D16a | CONFORMS (but C-2/C-3 can block it forever) | finalize bft :1452-1513; finalizeStatus broadcastsRepo.ts:931 | bft finalize describe (N callers; RF5; stale counter; both orderings) |
| D17 | CONFORMS (deviation 1; T4-1) | messaging.ts:1129-1174 (twilio), :1389-1403 (console), :690 and :751-755 (timeout pin) | messaging.test.ts describe "listMessages / getMessage (spec D17)" |
| D18 | CONFORMS | safeRecipientKey on every line; errors logged only under `err` | reconcile 21; relay 22; bft 12 |
| D19 | CONFORMS | fake-twilio rest.ts:50, :133-199, :201, :242; control.ts:109, :124 | fake-twilio rest/control tests; e2e specs |
| D20 | PARTIAL (C-6) | deliveryStatus.ts:101-127, :803; broadcastFormat.ts:140; BroadcastResults.tsx:55; relayRetryJoin.ts:423-427 | deliveryStatus.test.ts "send_unconfirmed - Not confirmed by code alone"; Timeline.delivery (three positions incl. rung); relayRetryJoin test; mirror test |
| D20a | CONFORMS | deliveryStatus.ts:301; api/types.ts `attemptedAt` | deliveryStatus.test.ts D20a cases; Timeline "attempt clock" describe |
| D21 | CONFORMS | deliveryStatus.ts:560, :571, :586, :661 | "counts a leg whose last rung closed send_unconfirmed under not confirmed, never failed" |
| D22 | CONFORMS | deriveBroadcastStats broadcastsRepo.ts:297; StatChips.tsx:38; skippedTotal :113; seeds matrix.ts:1228,1252 and performance.ts:1006 | deriveBroadcastStats.test; StatChips order and sum tests; BroadcastResults unconfirmed row |
| D23 | CONFORMS | deliveryStatus.ts:1044-1049, :1134 | deliveryReason D23 describe; mirror test |

### Sec 2a carry-overs

| item | verdict | implemented at | pinned by |
|---|---|---|---|
| RSW #1 | CONFORMS | relayRetryLeg.ts:799-821; re-drive is plain `enqueue` of the same rung, sendReconcile.ts:972-979 | rung "a re-driven rung declined by the window gate ... (RSW #1, D8)"; reconcile 15b |
| RSW #5 | CONFORMS | relayFanOut.ts:1927-1932; relayRetryLeg.ts:1037-1058 | rung "... deadline expires during the acquire ... (RSW #5)"; relay "SOR deadline_exceeded returns before any claim" |
| RSW #6 | CONFORMS | window checks (:799-821) run before the unit's claim (:843); window closes are gated (:808, :1000, :1047) | closeSites matrix rows "the window gate" and "the send deadline" |
| RSW #7 | CONFORMS | relayRetryJoin.ts:424; deliveryStatus.ts:803 | relayRetryJoin "projects a rung closed send_unconfirmed ..."; RSW mirror test unchanged |

The rest of Sec 2a also conforms: claim-time decline (the fenced file is
untouched); `deadline_exceeded` returns before any write and the fan-out passes
no deadline (relayFanOut.ts:1918); no new `sendMessage` gate
(`sendRefusalCases.ts` untouched); nothing relies on webhook redelivery; the RSW
seam is reused and the new `E2E_SEND_RECONCILE_DELAYS_MS` seam is
topology-guarded (S5b proved a fresh lane); Branch A items (`skippedTotal`
excludes `unconfirmed`; the internal-map entry in place; `created_via` read by
the pass (bft :876) and by adoption (bft :1297); the switched-off tenant 0002
never used (spec :58-59)).

### Sec 1 guarantees, Sec 9, Sec 10

- Guarantee 1 is PARTIAL (C-1).
- Guarantee 2 is PARTIAL: the residue it records has the wrong shape (C-2, C-3).
- Guarantee 3 CONFORMS.
- Sec 9 CONFORMS: every listed issue is filed, and the anchor issue's
  `retrySend` claim is corrected at throw-for-redelivery...md:112.
- Sec 10 CONFORMS: no infra, dependency or schema change (tables.ts comment
  only); the post-merge checks belong in T17.

### Sec 8 test intentions

| # | verdict | tests |
|---|---|---|
| 1 | CONFORMS | sendOutcome.test.ts |
| 2 | CONFORMS | sendMessage.test.ts D3 describe |
| 3 | CONFORMS | bft 1; relay 1 (both row kinds); rung "an unknown send on the real unit ...". Fail-on-main recorded in S2a/S2b/S2c |
| 4 | CONFORMS | bft 3/10b/5a/5b; relay SOR 13, 6; repo "recordRecipientOutcome writes the slot and bumps stats in ONE conditional write" |
| 5 | CONFORMS | bft 7a/7b; relay 1/2/4d/11e; sendAttemptsRepo integration fence and takeover cases |
| 6 | CONFORMS | bft 8/8b/8c/7d/4a; relay 4/4b/4c; reconcile 14d/14e. Two clauses do not apply: the "batch read" clause (no batch read exists, D-1), and "redriven untouched", which D8 rev 11 supersedes (D-2) |
| 7 | CONFORMS | bft 4a-4e; relay 8a-8h |
| 8 | CONFORMS as specified (C-1 open) | reconcile 1-13, 19; relay 7/8 |
| 9 | CONFORMS | reconcile marker test, 11, 11c, 14, 14b; integration cases |
| 10 | CONFORMS | parser rejects checkNo 3; bft 9b; relay 10; rung second unknown; reconcile 17/17b; bft 9a/9f/9g |
| 11 | CONFORMS | bft finalize describe; relay 9e; reconcile 15, 11b, 15b |
| 12 | CONFORMS | rung RSW tests and closeSites matrix; `retrySend.ts` diff is empty |
| 13 | CONFORMS | messaging.test.ts D4 test |
| 14 | CONFORMS (C-6 note) | dashboard describes listed under D20-D23 |
| 15 | CONFORMS | deriveBroadcastStats.test; performanceSeed.test |
| 16 | CONFORMS | bft "decides from the recipients map when the persisted failed counter is stale"; bft 6; e2e spec 4 |

E2E specs: `accept_then_drop` on a relay leg (spec :265) CONFORMS, subject to the
adjudicated lane-timing difference; `drop_before_create` on a broadcast
recipient (:362) CONFORMS; `reject` 21211 (:420) CONFORMS; the extra fail-list
spec (:491) is built; "routing of a post-adoption receipt proven at integration
level": MISSING (C-7).

### Review Focus

All five CONFORM: 1. sendOutcome.ts:83, the RF1 test. 2. sendReconcile.ts:735-737,
reconcile 13 (both owners). 3. bft :936-959, bft 2. 4. sendReconcile.ts:739
and :768, 13b and 13c. 5. bft :1470-1475, the finalize RF5 test.

### Plan tasks

- CONFORMS: T1, T2, T3, T4 (deviation 1 and T4-1), T5, T6, T11, T12 (C-7),
  T13 (C-6), T14, T15. Held item R-e is not yet filed.
- PARTIAL: T7 (C-2, C-3, C-4); T8 (C-2, C-4); T9 (C-2 in `handOff`, C-4 in
  `refuseGate` / `closeTerminally`); T10 (C-1, plus the F-2 tightening still
  pending).
- PENDING: T16, T17.

## B. Findings

**C-1 (BLOCKING - Guarantee 1; this is S3b F-1, still open at HEAD).**
- Spec: D13, "open or was adopted inside the window".
- Code: sendReconcile.ts:739-746 and :804. The sibling query is bounded by each
  sibling's CLAIM time: the index sort key is claim time (sendAttemptsRepo.ts:301,
  queried at :480).
- How it goes wrong: S3b's interleaving (S claims at t=0; O claims at t=238; S
  adopts O's message at t=240; O rules `never_sent` at t=478) double-sends O's
  photo and never sends S's. It is realistic: every media-only relay leg from
  one sender has the same body ("{name} sent an attachment.", catalog.ts:465)
  and usually the same media count.
- Why the routed fix is not enough: the routed fix lowers the sibling bound to
  "window start minus the last check delay". That assumes each sibling's final
  check runs on schedule. But the lookup window has no upper end (:768 filters
  only the lower bound). A check that throws is redelivered by SQS up to 5
  times at the 120 s visibility timeout (D11, D13a), and a backlogged worker
  also runs late. Either way a late S still adopts messages created well after
  S's attempt.
- Smallest fix: make the candidate window two-sided. Keep only candidates with
  `createdAt <= attemptedAt + TWILIO_REQUEST_TIMEOUT_MS + margin` (for example
  30 s + 60 s of clock skew + a prepare margin); our own message can only be
  created while our request is in flight. Then widen the sibling lower bound by
  the same constant. Pin it with S3b's interleaving.

**C-2 (MEDIUM - held item R-e; spec D7a "the record keeps attempting and the
slot keeps whatever it held"; Sec 1 residue shape).**
- Problem: the terminal failure arms write the slot and then the record as two
  independent `guardWrite`s. If the slot write throws, the record still goes
  terminal.
- Verified by P1: a 21211 rejection whose reject-slot write throws ends with
  slot `queued`, record `done/rejected`, the share `sending` forever and
  nothing carried. A sweeper that scans open records never sees it.
- Sites: broadcastFanOut.ts :691-698 and :727-736 then :744-746; :946-956;
  :759-770; :580-591. relayFanOut.ts :2132-2137, :2153-2158, :2174-2187,
  :2218-2226, :1212-1220. relayRetryLeg.ts :648-656.
- Fix: write the record transition only after the slot write succeeded. When
  the slot write fails, leave the record open (`attempting` or `reconciling`)
  and carry the recipient as stranded. Never release it `retryable` on the
  unknown-class arms: a later pass would re-send.

**C-3 (MEDIUM - D7a PREPARE: a pre-claim failure means nothing was sent, so
defer).**
- Problem: the broadcast fence write is inside `guardWrite`
  (broadcastFanOut.ts:661-668). A failed fence write is swallowed: no record, no
  deferral, not carried. The slot stays `queued`, so finalize defers forever
  (:1464-1469).
- Verified by P2.
- The relay twin already does this right: its suppression write
  (relayFanOut.ts:1875-1881) is unguarded, falls into the pre-claim catch
  (:2064-2073) and is carried.
- Fix: let the fence write's throw reach the unit's prepare catch (deferSlot
  plus carry).

**C-4 (LOW - held items R-b and R-a; D8 "the close's slot write is itself
conditional, per slot type").**
- What is built: the conditional write exists for the cap and enqueue closes
  and for the reconcile's own closes.
- What is not: the broadcast fences use a wholesale `setRecipient` plus a
  separate `bumpStats` (bft :661-668 via :1426-1433); the relay suppression arm
  uses `persistRelayRecipientResult` (relayFanOut.ts:1878-1881); the rung's
  `refuseGate` / `closeTerminally` (relayRetryLeg.ts:584-615) take the
  wholesale `markRecipient` on legacy rows.
- Ordering problem (R-a): the redriven-gate closes write the slot BEFORE
  `closeRedriven` (bft :464-473, relay :1263-1274, rung :699-707). Suppose a
  re-drive pass claims the record between the gate read and the slot write,
  then sends. Its send is then recorded under a `failed/transient_cap` slot. On
  a broadcast that slot shows the retry hint over a delivered text.
- Why LOW: it needs two concurrent passes on one key inside one DynamoDB round
  trip. D7a's "as today" also muddies the spec here (D-2).
- Fix: for a redriven gate, run `closeRedriven` first and write the slot only
  when it won (the T8-9 / T10-14 order). Use the conditional writes for fences,
  the suppression arm and `refuseGate`.

**C-5 (LOW - D1 "HTTP 429 or code 20429").**
- Problem: there is no standalone code-20429 rule (sendOutcome.ts:78-86; the
  plan dropped it).
- Verified by P3: `{code: 20429}` classifies `unknown`; `{status: 400, code:
  20429}` classifies `rejected`.
- Why LOW: unreachable with twilio-node, which always pairs 20429 with a 429
  status.
- Fix: after the 5xx check, return `retryable` when `code === '20429'`.

**C-6 (LOW - held item R-d; D20 "the rollup chip carries it as its reason
too").**
- Problem: when a real failure sits beside an unconfirmed leg, the chip takes
  branch 1 (deliveryStatus.ts:613-627) and shows only the failed legs' reason.
- Pinned that way by "beside a real failure, counts both and keeps the failed
  legs reason".
- Fix: add the D20 sentence to that reason, or record the gap as accepted.

**C-7 (LOW, test coverage - Sec 8 e2e paragraph).**
- Problem: "the routing of a post-adoption receipt [is] proven at integration
  level" has no test. Plan T10 step 2 and the self-review omit it; the lane
  only shows it incidentally (S5b).
- Fix: add one integration case: adopt, then deliver a status callback for that
  SID and assert the slot moves.

**C-8 (LOW - D11 "No coordination read may go through a GSI").**
- Problem: for a `phone#`-keyed broadcast recipient, three reads use the
  `byPhone` GSI through `resolveContact`/`findByPhone` (bft :1134-1136): the
  current-number read (sendReconcile.ts:493); `heldBy`'s contact read (:565);
  the adoption's contact read (bft :1289).
- Why LOW: every failure errs toward `unresolved` or a retry.
- Fix: for a `phone#` key, use the key's own number, as the relay branch does
  (:502).

**C-9 (LOW - undeclared deviations).** All are JUSTIFIED; the handback must
declare them: the Sec 2 fence says "the close loops stay unwrapped", but G7 /
T7-9 / T8-6 wrap each key (bft :454-476, relay :1253-1277); T10-14 closes the
record first on the re-drive enqueue failure, against D8's "slot FIRST" for the
job's own closes; T4-1: `TwilioClientLike` is not widened (D17 wording); the S3a
match rule and the pending F-2 tightening.

**C-10 (LOW - D12).** A contact member who has left the roster is ruled
`digest_mismatch` without reading the contact (sendReconcile.ts:496-503),
although D12 names "the contact" as a source. An orphan delivered just before
the removal then reads "Not confirmed". This is the safe direction.

**C-11 (LOW - held item R-c2).**
- Problem: a hand-off enqueue failure after a KNOWN send (`sent_unrecorded`, SID
  in hand) closes the record `unresolved`. On a broadcast it also closes the
  slot `send_unconfirmed` (bft :579-596 via :932; relay :1211-1224; rung
  :647-668).
- Status against the spec: this follows D7's letter. But D20's premise ("in
  each [cause] the platform does not know") is false here.
- Fix: close known-SID cases as sent, or accept and record.

## C. Judgment of declared deviations and adjudications

Plan deviations - all JUSTIFIED:
1. `createdAfter` dropped from the port: D17 itself says the filter runs
   client-side; the provider's `DateSent` filter is the wrong clock.
2. Mirrored dashboard constants: exactly the mirror-test precedent D20 names.
3. Slot not fenced on the record: a cross-item fence would need a transaction
   on every send, and the takeover's reconcile repairs through `heldBy` 'mine'
   with no fingerprint needed (sendReconcile.ts:780-787). Caveat: the same
   non-atomic slot-then-record order is what produces C-2.
4. `senderKey` carried verbatim: the re-drive envelope needs it
   (sendReconcile.ts:963); the owner field is hashed (:121-140).

Worklist rulings - all JUSTIFIED: A1 (D15 names "the SSE emits", and the relay
thread refetches only on SSE); A2 (self-QA mechanics only; the unit tests carry
D20a); A3 (no record state exists to condition on, and a legacy slot's only
writer is wholesale; carrying the member retries it - relay 15/15b); A4
(`deferredByClaim` proves a foreign owner, so D8 applies); A5, A6 (scope and
documentation only); A7 (finalize is conditional and the emits idempotent); A8
(a pre-existing class, now filed); A9 (registry bookkeeping); A10 (accepted
residue - R3 is the weakest: a consistent `conversations.getById` would close
it, and a just-removed member could still receive a re-driven leg within the
replication lag, a pre-existing fan-out class); A11 (plumbs the pinned timeout
to the lane).

Other build-time choices: T8-9 JUSTIFIED (the re-drive early returns now close
`redrive_refused`, which improves on Sec 9's "strand"); T10-14 JUSTIFIED (its
cost: a slot write that throws after the record close leaves a queued slot
that A7 cannot finish).

Adjudications:
- S3a stricter match rule (ACCEPTED): agree. Its `sameFingerprint` is equal to
  or looser than the spec's hash-plus-media rule, so it withholds `never_sent`
  at least as often. Keep it the exact mirror of `matches` when F-2 lands.
- S3b F-1 (defect, routed to the fix wave): agree it is a defect; the routed
  fix is incomplete (see C-1).
- S3b F-2 (tighten to hash and media for every body): agree. It moves outcomes
  only toward `unresolved`: an unmatched own orphan ends `unresolved`, never
  `never_sent`, and NFKC plus the letters/digits filter already absorbs Smart
  Encoding. Declare it as a spec-text deviation.
- S5b lane timing: agree. The adoption reading the current status is what is
  proven.

## D. Required by the spec, but built by no task and named in no record

- D-1: Sec 8 item 6's "batch read with an unprocessed key re-reads it" does not
  apply: every gate uses a per-key consistent Get (sendAttemptsRepo.ts:256-259).
  The handback should say so.
- D-2: spec text has drifted from its own decisions; correct it in the
  handback: Sec 8 item 6 still says a cap-close leaves a `redriven` record
  untouched, but D8 rev 11 closes it (the build follows D8: bft 9c, relay 14);
  Sec 2 lists "attemptedAt on the slot (D8a)" under broadcastsRepo, but D8a
  says broadcast slots do not get it (correctly not built); D7a's "as today"
  contradicts D8's conditional close (see C-4).
- D-3: D11's promise that two chains converge on one outcome is not guaranteed
  when duplicate chains reach DIFFERENT verdicts. Spec-level gap, narrow
  (needs an SQS redelivery). Example: one chain rules `unresolved
  provider_unreachable`, the other `found` after the provider recovers; the
  result can be slot `failed/send_unconfirmed`, record `adopted` and an
  appended row, because `closeSlot` runs before the record fence
  (sendReconcile.ts:886 vs :403). Also, a redelivery after
  `closeFromReconcile` throws re-runs the lookup instead of re-applying the
  same close.
- D-4: the Sec 10 hosted-dev check should also cover Messaging Service link
  shortening, and Advanced Opt-Out (already in worklist 2a). Either rewrites
  stored bodies; every share body carries a URL, so every broadcast reconcile
  would end `unresolved` - safe, but adoption would never happen.
- D-5: D3's staff-route change (201 where it answered 500) has no route-level
  test (S2a concern 4, not filed).
- D-6: T16 and T17 are pending; their handback must carry the Sec 10 checks
  (the list walk's order and page bound, and whether the prod Messaging Service
  has Smart Encoding on).
