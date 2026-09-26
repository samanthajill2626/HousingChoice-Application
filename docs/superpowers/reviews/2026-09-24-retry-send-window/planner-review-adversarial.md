# Planner review - adversarial, plan-blind - feat/retry-send-window @ 56085389

Reviewer: independent adversarial reviewer, PLAN-BLIND (nothing under
`docs/superpowers/` was opened; only this output file was written there).
Inputs: `.superpowers/planner-review/diff-package-code.md` (main...HEAD, code
paths), the worktree source at 56085389, `AGENTS.md`, `docs/issues/*`, `RUNBOOK.md`,
`infra/modules/observability/main.tf`.

Method: every changed function and field was walked against its readers and
writers across the repo (app, dashboard, e2e, scripts, seeds, fake Twilio, infra
metric filters). App vitest suites and every e2e run were NOT executed (the
planner's gates own DynamoDB Local). One throwaway dashboard test was run
(`cd dashboard; npx vitest run <file>`) and then deleted; the tree is clean of it.

Deliberately NOT re-reported, because the branch already files them in
`docs/issues/`: the five time-based double-send gaps
(`manual-retry-double-send-residual-windows`), the promise that outlives a job
decline (`one-to-one-retry-promise-outlives-job-decline`), and the stale-bundle
effects of already-open tabs (`optional-call-outcome-breaks-already-loaded-bundles`,
2026-09-26 update).

Summary: no BLOCKING and no HIGH finding. One MEDIUM (a consent-gate bypass on
retries whose recorded recipient no longer owns the thread's phone) and five LOW.

---

## 1. [MEDIUM] Retries judge the RECORDED recipient even after it no longer owns the thread's phone - the JIT consent gate is judged on the wrong contact

**What is wrong.** This branch persists the send wrapper's `recipient` as
`recipient_contact_id` and makes every retry path judge that recorded contact:
the manual Retry route (new), the automatic retry job (new) and the webhook's
retry decision (new). The send wrapper's rule for `recipient` (share-skip-fix
I8) judges the deleted and JIT-consent gates on the recipient INSTEAD of the
phone-matched contact. I8's premise is "duplicate contacts on one phone" - both
contacts own the phone at send time, which the broadcast fan-out guarantees
(`createOrGetByParticipantPhone(contact.phone, ...)`). A retry can happen long
after the send (the manual Retry has no time limit), when the recorded contact
may no longer own the conversation's phone at all. Nothing on any retry path
re-checks ownership, so consent and deletion are judged on a contact whose
number the text is not going to.

**Evidence.**
- Manual route, new on this branch (main passes no recipient - verified with
  `git show main:app/src/routes/api.ts`): `app/src/routes/api.ts:1615-1625`
  reads `original.recipient_contact_id` by id; `:1683` passes it as `recipient`.
- Automatic job: `app/src/jobs/retrySend.ts:189-200` (read), `:323` (passed).
- Decision: `app/src/services/oneToOneRetryDecision.ts:102-104` (read) and the
  preview `app/src/services/sendRefusalPreview.ts:62,66`
  (`judged = recipient ?? phoneContact`; consent judged on `judged` only).
- Send wrapper: `app/src/services/sendMessage.ts:355-404` - `contact = recipient
  ?? phoneContact`; the consent gate (`:398`) and the deleted gate (`:384`) never
  look at the phone-matched contact when a recipient is named; the text goes to
  `conversation.participant_phone` (`:449`).
- The parity table that pins this behavior states its own precondition:
  `app/test/helpers/sendRefusalCases.ts` header, "an optional caller-resolved
  recipient on the SAME phone"; row "duplicate contacts: no-consent phone
  contact, consenting recipient: a person send sends".
- The number can change owner through ordinary curation: `setPhone` promotion
  keeps the old primary as a pointer, and `removePhone` then deletes it
  (`app/src/repos/contactsRepo.ts:1421-1440`, `deletePointer` at `:1437`), after
  which another contact can hold that number.
- A contact's page shows every conversation of its CURRENT phones
  (`app/src/lib/contactThreads.ts:38-54`), so the old failed share bubble renders,
  with its Retry button (`dashboard/src/routes/contact/Timeline.tsx:1423`), on
  the page of whoever owns the number now.

**Failure scenario (the I8 cleanup path).** Tenant A (consent `web_form`) and
landlord record C (no `consent_method`) share phone P. A property share fenced
to A fails (30003 past the window, or 30005). Staff clean up the duplicate by
removing P from A. The share's bubble now shows on C's page with Retry. A staff
member presses it: the route passes recipient A, the wrapper judges A's consent
(present) and sends A's share - addressed "Hi <A's first name>" - to P, a person's
send to C, who has no recorded consent. On main the same press judged
`findByPhone(P)` = C and was refused `contact_no_consent` (and opened the
consent-capture flow). The reverse also holds: if A is later opted out or
soft-deleted, a Retry on C's page is refused with A's reason ("This contact is on
the Do-Not-Contact list" / "This contact is deleted - restore them to reply")
although C is live and consenting.

**Suggested fix.** On the three retry paths, use the recorded recipient only
while it still owns the thread's number (its current phones - primary or
secondary - include `conversation.participant_phone`); otherwise fall back to the
phone-matched contact and WARN, exactly as the "recorded recipient no longer
exists" fallback already does. Stricter alternative: on retries, judge consent
and deletion on BOTH contacts and refuse if either fails. Add a parity row whose
recipient is on a DIFFERENT phone.

**Status.** Proven by code reading at the cited lines; not executed (app suites
were off-limits).

---

## 2. [LOW] The promise and the hidden Retry outlive the server's guard by up to one ticker period; the comments say "the same window" and the ticker test is built so it cannot see the gap

**What is wrong.** The bubble judges the promise against `promiseNowMs`, a
snapshot taken only when the `tickerArmed` memo recomputes
(`dashboard/src/routes/contact/Timeline.tsx:2200-2208`): on a rendered-set
change or a tick. The tick period is `STALE_TICK_MS = 60 s` (`:749`,
interval at `:2224-2226`). So after `retry_due_at + RETRY_PROMISE_GRACE_MS`
passes, "will retry" stays on screen and Retry stays hidden until the NEXT
tick - up to 60 s after the server (`app/src/routes/api.ts:1605`) already
accepts a press. The comments claim otherwise: `retryPromise.ts:5-6` ("hidden for
exactly as long ... over the same window") and `api.ts:1600` ("the dashboard
hides the button over the same window"). The issue file
`one-to-one-retry-promise-outlives-job-decline` states the true bound ("plus up
to one 60-second tick"), so the code comments and the issue disagree.

The ticker test cannot catch it: `Timeline.ticker.test.tsx:992-994` uses
`PROMISE_LIFE_MS = 60 s + 120 s = 180 s`, exactly three tick periods from mount,
so the expiry always lands ON a tick and "one millisecond either side of the edge"
holds only by construction. In production the bubble mounts at an arbitrary
offset from the failure (SSE plus the debounced refetch).

**Reproduced** with a throwaway dashboard test (deleted after): failure 30 s
before mount, due at mount + 30 s, promise ends at mount + 150 s on the server
clock; sampling every 5 s gave `... 145:- 150:- 155:- ... 175:- 180:R` (Retry
absent until the 180 s tick; one `setInterval` of 60000 ms).

**Failure scenario.** Staff watching a declined-at-send retry (group (b) in the
issue file) or a merely expired promise see "will retry" and no button for up
to an extra minute after the server would honor a press. Safe direction (no
double send), but the copy asserts a promise the server no longer holds.

**Suggested fix.** Correct the two comments to name the bound, and make one
ticker test mount at a non-aligned offset. Optionally schedule a one-shot timer
for the earliest live promise's expiry, so the edge is crossed on time.

---

## 3. [LOW] Property-send results now read a definitive failure for recipients whose automatic retry is scheduled or already delivered

**What is wrong.** A share recipient's slot is rolled up only from a message
carrying `broadcast_id` (`app/src/routes/webhooks/twilio.ts:3511`). The automatic
retry "follows the original send" for `automated` and the recipient, but not for
`broadcastId` (`app/src/jobs/retrySend.ts:316-327` passes none), so a retry's
delivery never reaches the share's slot or stats - pre-existing. What this branch
changes is the only hedge that surface had: the results row
(`dashboard/src/routes/broadcasts/broadcastFormat.ts:158`) now renders the base
30003 copy "Phone unreachable (error 30003)"
(`dashboard/src/routes/contact/deliveryStatus.ts:777` onward) instead of "...
will retry".

**Failure scenario.** A share to 200 tenants; a handset is briefly off; the
first retry delivers 60 s later. The results page shows that tenant as
"Failed - Phone unreachable (error 30003)" for good, with no hint a retry
exists. Staff re-share the property or text the tenant by hand - a duplicate the
tenant has already received.

**Suggested fix.** Either carry the broadcast linkage onto the retry (and teach
`rollIntoBroadcast` to resolve a retry row to its original's slot through
`retry_of`), or have the results row ask the same question the bubble asks
(project the message's live `retry_due_at` to the results API). At minimum,
record the gap in `docs/issues` beside the share-sent-outcome work.

---

## 4. [LOW] The relay claim's new gate-preview reads fail CLOSED, the opposite of the one-to-one decision's fail-open ruling

**What is wrong.** The claim now performs a conversation read and the member
suppression reads (`isMemberSuppressed`: a contact get or a phone query, plus a
participant-phone GSI query) before it appends the rung
(`app/src/routes/webhooks/twilio.ts:2841-2848`). A throw from any of them is
`claim_failed`: no rung, an ERROR marker, a 500 (`:3174-3181`, `:3320-3323`,
`:3372-3374`). The one-to-one decision makes the opposite choice for the same kind
of read, citing Cameron's "attempt rather than risk a text never delivered"
(`app/src/services/oneToOneRetryDecision.ts:28-37`: a failed read schedules the
retry anyway). Recovery on the relay side rests on Twilio re-delivering the
status callback after a 5xx. Twilio's documented default webhook retry policy
retries connect failures, not 5xx, unless the callback URL carries a connection
override (`#rp=...`); the service-level Delivery Status Callback URL is set in
the Twilio console, not in this repo, so this is UNVERIFIED either way.

**Failure scenario.** One DynamoDB throttle on the new suppression read while a
30003 lands: before this branch that read ran in the job and a failure stranded
a visible rung ("not confirmed"); now no rung exists, and if Twilio does not
redeliver, that member's ladder never starts, visible only as one ERROR line.

**Suggested fix.** Wrap the preview reads and fail OPEN: append the rung open
and let the job's own gate re-run decide, with a WARN naming the gap - the same
posture as the one-to-one decision. Separately, confirm and document the status
callback's retry policy.

---

## 5. [LOW] Late 30003s now ERROR on arrival; nobody has measured what that does to the ErrorLogs alarms

**What is wrong.** A 30003 that lands after the window's scheduling edge
(about 13 minutes after the send for rung 1) now logs ERROR at once: the
one-to-one decline `one-to-one 30003 retry not scheduled: window_closed`
(`app/src/routes/webhooks/twilio.ts:3567-3582`, level from
`oneToOneRetryDecision.ts`), and the relay marker for `window_closed`
(`isTerminalRelayLegFailure`). Late 30003s are exactly the case the window exists
for (a carrier holding a message for an off handset), so they are expected, not
rare. Per dead chain the ERROR count is roughly unchanged (main logged the cap
ERROR after three more sends), but chains whose late retry would have delivered
now ERROR where main logged none, and the ERROR now lands at the late failure's
arrival. `hc-<env>-error-logs` pages at 5 in one 5-minute bucket and
`error-logs-sustained` at 1 per bucket for 3 buckets
(`infra/modules/observability/main.tf:150-202`).

**Failure scenario.** An evening share to a large audience; overnight a carrier
releases held 30003s for switched-off handsets in batches. The share recipients
each ERROR as they arrive, and a batch of five in five minutes pages on-call for
behavior the product now handles by design.

**Suggested fix.** Measure: count 30003 callbacks by delay since `provider_ts`
from prod logs before merge. If late 30003s are common, log the window decline
at WARN with a distinct field (like the relay `gate_refused` carve-out) and keep
ERROR for the cap and for the job-time closes, which mean our own lateness.

**Status.** Volume UNVERIFIED (no prod data read).

---

## 6. [LOW] `RELAY_ERROR_CODE_REASONS` is now dead, and it traps the next edit to the 30003 copy

**What is wrong.** The relay map's only entry, "Phone unreachable"
(`dashboard/src/routes/contact/deliveryStatus.ts:864`), is now identical to the
base entry (`:777`). The fence that keeps a relay leg away from the one-to-one
promise is the `opts.relay !== true` condition in `deliveryReason` (`:1034`),
not the map; the comment above the map says the map "stays because `relay` is
what fences a relay leg off", which conflates the flag with the map. Dropping the
map changes no output today.

**Failure scenario.** Someone later edits the base 30003 wording (say, to add a
hint). Relay legs silently keep the old string through the shadowing map, and the
two surfaces diverge - the drift the comment block says the ordering exists to
prevent.

**Suggested fix.** Delete the map and its branch (keep the `relay !== true`
guard on the promise), or add a test pinning it equal to the base entry while it
must be.

---

## Checked and cleared (walked as concrete interleavings; no finding)

- One-to-one atomicity: the decision runs before the write, and `retry_due_at`
  rides the same conditional `UpdateCommand` as the status
  (`app/src/repos/messagesRepo.ts:2633-2673`). With `failed`/`undelivered`
  reachable only from `queued`/`sent` (`:133-142`), concurrent or redelivered
  30003 callbacks stamp and enqueue at most once, and no reader can see the
  failure without its stamp. The manual route's read gets both fields from one
  item version.
- Every decision read is caught (fail-open), so the decision adds no new throw
  before the status write; the only unguarded arithmetic is `runAt.toISOString()`,
  unreachable without an absurd lane env value.
- Preview parity: `previewSendRefusal` and `sendMessage` use the same predicates
  in the same order (`sendRefusalPreview.ts` vs `sendMessage.ts:334-427`); the
  only unpreviewed gate is the live breaker.
- The relay claim's closed-rung append: the SID-derived claim key makes a
  duplicate callback a dedupe regardless of its own preview; the versioned closed
  slot passes `assertTransportPersistenceShape` (`messagesRepo.ts:996-1000`
  accepts `excluded`); the dashboard join treats the closed rung as terminal and
  strips `retry_window_closed` (`relayRetryJoin.ts:410-426`).
- `sendOneRelayLeg`'s bounded acquire returns `deadline_exceeded` before any write;
  `TokenBucket.acquire` with `timeoutMs` 0 refuses at once, and a timed-out waiter
  keeps FIFO order (`app/src/lib/tokenBucket.ts`). The fan-out never passes a
  deadline.
- The rung-1 origin `slot.sentAt` survives status callbacks: they are
  child-field writes (`messagesRepo.ts:3714-3731`), and legacy slots get
  `sentAt` in the whole-slot send write (`relayFanOut.ts:1495-1507`).
- Server-clock estimate: every API call goes through `requestWithStatus` (the
  only other `fetch` is a cross-origin S3 upload); `/api` JSON carries no
  `Cache-Control`/`Last-Modified` (only the media and recording routes set
  `max-age`, and they are element sources); the service worker has no fetch
  handler. The estimate can only lag, which errs toward hiding Retry.
- Every `sendMessage` caller passes `automated` explicitly; the send wrapper is
  the only outbound one-to-one SMS writer (other `append` callers write relay,
  group, email, call or inbound rows), so absent `automated` means "before
  deploy" only.
- The mirror constants (`RETRY_PROMISE_GRACE_MS`, `retry_window_closed`) are
  pinned by the two cross-workspace tests, with precedent in
  `mediaTypeMirror.test.ts`; `lib/retrySendWindow.ts` is import-free.
- Metric filters key on `event` and `level` only (`observability/main.tf:40-111`);
  no new line carries `event: delivery_failed`, and every new line is inside a
  request or job context, so there are no new OrphanLogs.
- Logs and wire: new log fields are IDs, codes and timestamps (member keys pass
  through the log-safe helpers); the new raw-row fields (`automated`,
  `recipient_contact_id`, `retry_window_start`, `retry_due_at`,
  `relay_retry_window_start`) carry no phone or body. The manual Retry route
  keeps its auth, rate limiter and conversation-ownership check; `retry_pending`
  leaks nothing.
- No other e2e spec arms a 30003 or presses Retry, so the lane-wide
  `E2E_SEND_RETRY_BACKOFF_MS` touches only the new spec; the fake Twilio has no
  default 30003.
- All added lines are ASCII.
