# Spec review r3 - retry send window, DRAFT 3 (reviewer B, continued)

Reviewer: adversarial spec reviewer B, round 3, 2026-09-25.

Spec under review: `docs/superpowers/specs/2026-09-24-retry-send-window-design.md`
at `feat/retry-send-window` @`613752d1` (DRAFT 3), diffed against `d4446de0`.
Also read: `spec-review-r2-adjudications.md`, the two new issue files
(`docs/issues/manual-retry-double-send-residual-windows.md`,
`docs/issues/relay-retry-send-throttle-past-window.md`), and the concurrent
specs at their current heads: `feat/share-skip-fix` @`3a6a1a06` (v5, unchanged
since round 2), and `feat/send-outcome-reconcile` @`bf2c5bf2` (revision 4,
committed; its working tree has further uncommitted edits, so it is still
moving).

Method. Every claim about code cites a `file:line` read this round. Read-only;
only read-only git commands were run.

**Stop signal: NOT yet.** This round changed five decisions (R2-1, R2-3, R2-5,
R2-8, R2-12). Three rest on something that does not hold in the code or in the
math:

- R2-8's partial remedy rests on a roster read that exists on almost no path
  (R3-1).
- R2-5's skew bound is checked against a moving clock (R3-3).
- The throttle "allowance" can be closed with an API the repo already ships
  (R3-7).

If the next draft's changes are precision-only, that round should be the stop.

| # | sev | finding |
| --- | --- | --- |
| R3-1 | MEDIUM | D3 step 2 rests on a roster read that happens only at rung 1 and only for a member sender; the partial remedy for R2-8 loses its reason, and the full remedy is cheap |
| R3-2 | LOW | D3 step 2's WARN has no outcome value: `gate_refused` routes to ERROR, and section 4 still counts fourteen; the step also changes today's on-screen copy for those refusals |
| R3-3 | LOW | The new skew bound is checked against a moving clock: a slow clock still stretches the promise, and a very slow one brings it back minutes after the due time |
| R3-4 | LOW | The bound's constant is unmirrored, and section 5 requirement 3's refresh can legitimately exceed it |
| R3-5 | LOW | Requirement 3 omits D7's emit, and it keeps "will retry" copy on a retry that may already have gone out |
| R3-6 | LOW | D3a's fail-open contradicts D11's "UNCONDITIONALLY", and "schedule as today" does not say whether to stamp |
| R3-7 | LOW | The throttle residual is closable today with the bucket's bounded acquire; section 1's "one allowance" against a literal ruling is unnecessary |
| R3-8 | LOW | The two new issue files: a second, unrelated item filed under the throttle slug with a wrong premise; a server-side gap described as a screen gap; a missed coupling to reconcile revision 4 |
| R3-9 | LOW | `retry_window_closed` becomes the only relay close code with no internal copy; one defensive entry closes the A16 hole for any future direct render |
| R3-10 | LOW | Removing the relay 30003 entry leaves an empty map and a dead `relay` option, and falsifies comments D12 does not list |
| R3-11 | LOW | Section 4 misses the new public consistent pointer read, its harness twin, and the claim-side conversation read |

What checked out cold is listed at the end.

---

# Part 1 - findings

## R3-1 [MEDIUM] D3 step 2 rests on a roster read that exists only at rung 1 for a member sender

**What is wrong.** D3 step 2: "The claim reads the roster (`twilio.ts:2780`). If
the group is closed or the member is no longer on it, log WARN." The
adjudication chose this partial remedy for R2-8 because those two gates are
visible "from the roster it already reads". That read is not there on most
paths:

- `twilio.ts:2775-2780`: the leg body is composed only when the source row
  carries no stored copy. Rungs 2 and 3 reuse `src.relay_retry_leg_body`
  verbatim, so there is no read at rungs 2-3 at all.
- Even at rung 1, `composeRelayLegCopy` reads the conversation only for a member
  sender. A team send takes `TEAM_SENDER_LABEL` with no read
  (`twilio.ts:597-603`). Every staff message to a relay group is a team send.
- The read returns only the composed string. Nothing hands the conversation's
  `status` or `participants` back to the claim.

So step 2 needs a new conversation read on the past-window branch for every team
send and every rung 2-3. Rungs 2-3 are the normal way a late-ish ladder ends: a
rung-2 failure near minute 13 declines rung 3 at the claim. Built from the spec's
premise, step 2 would fire only at rung 1 of member-originated relays. Every
other late closed-group or removed-member case would still log `window_closed` at
ERROR, contradicting D9, the Q1 ruling and test intention 2.

**Defending the full remedy (as asked).** With the conversation read the
partial remedy needs anyway, the other two gates cost little or nothing:

- **Changed number: no extra read.** The job's gate compares
  `relayRetryDigest(rootTsMsgId, normalizeToE164(member.phone))` with the row's
  digest (`relayRetryLeg.ts:538-546`). At the claim, the equivalent test is
  `normalizeToE164(member.phone) !== toE164`, using the callback's own `To`
  (`twilio.ts:2720-2723`). That is pure computation on the roster member. The
  adjudication's "not visible at the claim without extra reads" is false for
  this gate, and so are section 9 bullet 2 and the throttle issue's second
  paragraph.
- **Opted out: two reads, on a rare branch.** It is the job's own helper,
  `isMemberSuppressed` - a contact read and one GSI query
  (`app/src/services/relayAnnouncements.ts:64-99`) - and it runs only after the
  window check has already failed.

The full remedy therefore costs about three reads, only on late 30003s. It
removes a residual and half of an issue file, and gives the two paths one
severity rule.

**What it implies.** Correct D3 step 2's premise. Specify the claim-side
conversation read on the past-window branch, with its failure semantics (a
throw is `claim_failed`, 5xx and redelivery, like the other claim reads). Then
either take the full remedy (all four gates) or record why opt-out alone stays
ERROR.

## R3-2 [LOW] D3 step 2's WARN has no outcome value, and it changes today's copy

- **Severity.** The claim does not log for itself. The per-callback marker does,
  at the severity `isTerminalRelayLegFailure` returns for the claim's outcome
  (`twilio.ts:3087-3090`). Only `claimed`, `already_claimed`,
  `fenced_announcement` and `slot_settled` are WARN (`:439-444`). The existing
  `gate_refused` (`relayRetryClaim.ts:51`) is logged today only by the JOB's own
  WARN lines (`relayRetryLeg.ts:502`) and never passes the marker; returned from
  the claim, it would log ERROR. D9's "a relay claim that finds a closed group or
  a removed member" at WARN therefore needs named outcome values in the WARN set.
  Section 4 still says the union "moves from thirteen values to fourteen" (spec
  lines 324-329); with step 2 it is at least fifteen, or `gate_refused` changes
  meaning.
- **Copy.** Today a late 30003 in a closed group claims a rung, the job refuses
  it, and the join shows "Not retried - group closed". With step 2 no rung is
  created, so the leg reads plain "Phone unreachable (error 30003)". The same
  situation inside the window still shows "Not retried - group closed". The
  ruling's "plain failed attempt" covers window declines, not human-action
  refusals. Say which copy is intended; the current wording renders one
  situation two ways, depending on lateness.

## R3-3 [LOW] The new skew bound is checked against a moving clock

**What is wrong.** D8 (spec lines 202-207): the promise is live while
(A) bubble clock < `retry_due_at` + 120 s AND (B) `retry_due_at` - bubble clock <=
360 s. Take a browser clock S behind the server and a due time D on server time;
the bubble clock at real time T is T - S. Then (A) holds for T < D + 120 + S, and
(B) holds for T >= D + S - 360. So the promise is live over
**[D + S - 360 s, D + 120 s + S)**, evaluated every render:

- **Inside the bound, a slow clock still stretches the promise by S.** At rung 1,
  (B) passes at first render for S up to 300 s, so the promise and the hidden
  Retry button outlive the due time plus grace by up to 5 minutes, while the
  server would already accept a retry. Section 1's "stops promising it within
  `RETRY_PROMISE_GRACE_MS` plus one ticker interval ... on a browser clock within
  D8's skew bound" is false for any S well above zero.
- **Beyond the bound, the promise comes back late.** For S = 10 minutes the
  window is [D + 4 min, D + 12 min): not live at first render, then live from 4
  minutes AFTER the retry was due until 12 minutes after. It comes back as soon
  as anything advances the bubble clock: another tickable bubble, or a refetch
  that changes `visible` (`Timeline.tsx:2095-2100`). If the retry was refused at
  send time (breaker, soft-deleted contact), no replacement row hides the
  original, so a stale "will retry" and a hidden Retry button reappear for about
  8 minutes. Test intention 7's "a browser clock 10 minutes slow shows no promise
  at all" holds only at first render.

**What it implies.** A lead bound on a moving clock cannot hold the promise to
its horizon. Anchor it to server time instead: the timeline response carries the
server's now (or the dashboard uses the response's `Date` header), and the
promise lasts from receipt for `retry_due_at - serverNow + grace`. That removes
skew outright. Failing that, latch "skewed, not live" per bubble at first sight.
Impact is small (the server's 409 still prevents a double send; minute-scale
browser skew is rare), which is why this is LOW. It is a design flaw, though, not
a precision edit, and section 1 and test 7 encode it.

## R3-4 [LOW] The bound's constant is unmirrored, and requirement 3 can exceed it

- "Longest backoff plus the grace (240 + 120 seconds)" hard-codes the server's
  ladder in the dashboard (`app/src/jobs/retrySend.ts:37-42`: three attempts,
  60/120/240 s). D10 mirrors and pins `RETRY_PROMISE_GRACE_MS`; this bound gets
  neither. A future change to the ladder would silently turn real schedules into
  "skew": no promise, and a visible Retry button that 409s.
- The lane seam only SHORTENS rungs, so it is safe. Section 5 requirement 3 is
  not. It refreshes `retry_due_at` "to cover the pending schedule", and reconcile
  checks run to about 4 minutes after the attempt, with a possible re-drive after
  that (reconcile revision 4, D7 at lines 213-214, and the D16 one-to-one row at
  line 477). A refreshed due time more than 360 s ahead is a legitimate schedule
  that the bound misreads as a slow clock. Size the bound from the largest
  legitimate horizon, requirement 3 included, and pin it. Or adopt R3-3's
  server-anchored rule, which needs no bound at all.

## R3-5 [LOW] Requirement 3 omits D7's emit, and it keeps a promise that may already be false

- D7 requires a `message.persisted` emit after the stamp, because otherwise "an
  open screen would learn of the stamp only by luck". Requirement 3's refresh
  (spec lines 370-375) says nothing about an emit. A refresh from the reconcile
  job (worker process; the emit reaches the app through the event bridge) with
  no emit lets the screen's old promise expire on schedule. The Retry button then
  returns into a 409 whose message ("A retry is already scheduled") contradicts
  the screen.
- During an `unknown` outcome the retry's text may already be out. Keeping the
  GUARD up is right. Keeping the PROMISE ("will retry") up says "will" about
  something that may have happened, and the ruling promises "will retry" only
  when a retry is scheduled. Because D8 and D10 key both on the one field, the
  spec cannot keep the guard while dropping the copy. Either accept that
  explicitly as a rare residual, or give the guard its own horizon.

## R3-6 [LOW] D3a's fail-open contradicts D11, and "schedule as today" is ambiguous

- D11 (spec lines 254-256): the arm refuses a `group_text` conversation
  "UNCONDITIONALLY". D3a's failure semantics (lines 136-141): a failed
  conversation read "FAILS OPEN ... schedule as today", which skips that guard.
  The fail-open is the right call (the job's `sendMessage` refuses `group_text`,
  `sendMessage.ts:297-300`), but D11's word is now false. Say "unless the read
  fails".
- "Schedule as today" does not say whether the fail-open path STAMPS
  `retry_due_at`. Today's scheduling has no stamp; D3a's step 5 stamps. With the
  stamp, a read failure on a manual-mode thread re-creates round 1's harm for
  about 3 minutes (a false promise, a hidden Retry button, a 409). Without it, an
  auto thread loses D10's guard for the whole wait. Both are rare, and either is
  defensible. Pick one and put it in test intention 4.

## R3-7 [LOW] The throttle residual can be closed with the bucket's existing bounded acquire

Section 1 grants "the one allowance" (a relay send may wait on the throttle past
the window) and files it as `relay-retry-send-throttle-past-window`, whose
suggested fix is "Bound the acquire (a deadline equal to the window's end)". The
shared bucket already has exactly that:

- `acquire(count, { timeoutMs })` bounds the total wait, queue time included,
  and throws `TokenBucketBusyError` (`app/src/lib/tokenBucket.ts:106-110`,
  `:136`, `:219`).
- It is in production use at `app/src/services/groupSend.ts:504-506`.

The job would pass `origin + window - now` down to `sendOneRelayLeg`'s acquire
(`relayFanOut.ts:1360`) and close with `retry_window_closed` on the timeout.
Against a literal ruling ("nothing re-sends a text more than 15 minutes after the
original went out"), an allowance the code can already prevent should either be
closed or be put to Cameron explicitly. Note the coupling: reconcile revision 4
also restructures `sendOneRelayLeg`'s phases. Separately, the issue file says the
overrun is something "the invariant forbids", while section 1 allows it; one of
them is wrong.

## R3-8 [LOW] Defects in the two new issue files

`relay-retry-send-throttle-past-window.md`:

- **Two issues under one slug.** It carries a second, unrelated residual - the
  late-decline severity at the claim - under a throttle title and slug.
  `docs/issues/README.md` is one file per item, and nobody searching for the
  severity question will open a throttle issue.
- **A wrong premise.** That second paragraph's "those two gates are not visible
  at the claim without extra reads" is wrong for the changed-number gate (R3-1).

`manual-retry-double-send-residual-windows.md`:

- **Item 1 places the gap on the screen; it is server-side.** A double send needs
  the press to reach the route before the stamp is WRITTEN. A press during the
  on-screen lag after the write gets the 409. The real gap is the arm's reads
  plus the enqueue.
- **The suggested fix misses a coupling.** Reconcile revision 4 introduces a
  per-recipient send-attempt record with a conditional claim before every
  provider call, and keys `retrySend`'s record on the original message and the
  rung (revision 4, D8a at lines 252-291 and lines 362-364). That is most of the
  "conditional retry-claimed attribute" the issue proposes; the manual route
  would only need to claim against it. Worth a line under Related.

## R3-9 [LOW] `retry_window_closed` becomes the only relay close code with no internal copy

The join change is sufficient for every current reader:

- The join's step 4 is the only reader of a rung's code (`relayRetryJoin.ts:410-413`).
- The rung predicates are status-based (`:175-179`, `:224-236`).
- The rollup, the recital or spoken name and the rows all read the projected legs
  (`Timeline.tsx:1057-1080`, `:1083`, `:1099-1110`, `:1246-1319`).
- The tour and placement hosts render the same Timeline.
- A retry row's own bubble is hidden unless delivered (`:2004-2019`).

But every sibling close code has an `INTERNAL_CODE_REASONS` entry, and this one
would not. Any future direct render - a new host, a relaxed `visible` rule, a
details drawer - would print "Delivery failed (error retry_window_closed)",
which is the A16 defect itself (`deliveryStatus.ts:878-882`). A no-tail entry
(for example "Not retried - message too old") is a fallback only. The join still
renders the plain 30003, so it does not touch the ruling. Cheap, and it keeps the
map's rule intact.

## R3-10 [LOW] Removing the relay 30003 entry leaves dead code and more lying comments

- With `'30003'` gone, `RELAY_ERROR_CODE_REASONS` is empty and the `relay` option
  of `deliveryReason` does nothing, yet it is still passed at six call sites.
  Decide whether to keep an empty seam or remove the option and its call sites.
- The removal also falsifies comments D12 does not list:
  - `deliveryReason`'s own ORDER comment: "media holds 30005/30006, relay holds
    30003" (`deliveryStatus.ts:959-969`);
  - the `DeliveryReasonOptions.relay` doc (`:863-876`);
  - the order-test comments (`deliveryStatus.test.ts:744-751`, `:762-763`).

The `retryScheduled` precedence itself is sound. INTERNAL codes are never 30003,
and ahead of the media map an MMS one-to-one bubble keeps its promise.

## R3-11 [LOW] Section 4 misses the new repository surface D3 needs

- D3 step 1 says "the repository exposes its consistent pointer read", but today
  that read is closure-private (`messagesRepo.ts:1960-1974`, reached only through
  the append's dedupe). Exposing it adds a `MessagesRepo` interface method, which
  the webhook harness's fake repo must implement too. Section 4's test-doubles
  line lists only the harness `annotateMessage` and `append`.
- The claim-side conversation read R3-1 requires is on no list either.

---

# Part 2 - contesting the adjudications

- **R2-8 (partial remedy).** Contested; defended in R3-1. The partial remedy's
  stated reason (a roster the claim "already reads") holds only at rung 1 of a
  member-originated relay. The changed-number gate needs no read beyond the
  roster. Opt-out is two reads on a rare branch. The full remedy is cheap, and
  it removes section 9 bullet 2 and half of an issue file.
- **R2-5 (skew bound).** Accepted in intent. The chosen rule is checked against
  a moving clock (R3-3) and cannot hold section 1's bound. Server anchoring is
  the durable fix.
- **R2-14 (issue files).** Accepted; defects in R3-8.
- **R2-12 (reason API).** Accepted; loose ends in R3-10.
- **R2-3 (fail-open).** Accepted; two precision gaps in R3-6.
- **R2-1 (join treats the close code as no display code).** Accepted; verified
  sufficient (R3-9 lists every reader); one defensive entry suggested.
- **R2-2 (requirement 3).** Accepted; two gaps in R3-4 and R3-5.

# Part 3 - what checked out cold

- The join change, R2-1: every dashboard reader of a closed rung goes through
  `projectOneLeg`'s step 4, and the terminal projection keeps the root slot's
  status, so the job-time decline and the claim-time decline read the same
  words.
- The `retryScheduled` precedence (ahead of the media, relay and base maps;
  internal codes never collide).
- Reconcile revision 4's move to a separate send-attempt record is compatible
  with section 5 as rewritten: the requirements no longer depend on its
  mechanics.
- The consistent pointer read the probe needs exists and supports
  `ConsistentRead` (`messagesRepo.ts:1960-1974`); only its visibility changes.
- D13's floor now includes the grace; section 4 lists the one-to-one lane value.
- The two issue files have valid frontmatter per `docs/issues/README.md`'s
  schema.

UNVERIFIED: how often production relay 30003s are late enough to decline at
rungs 2-3 versus rung 1 (it decides how much R3-1 bites); no production counts
are in the repo.
