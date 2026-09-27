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

---

## Re-review of cec46afd

Scope: the fix commit cec46afd, reviewed cold at branch head c8aef474. The
commits after it (25d025d6, c8aef474) touch records only (`git show --stat`).
Still plan-blind: the adjudications are taken from the coordinator's summary.
One incidental `git grep` hit printed a single line of the adjudications file;
it matched the summary and nothing else from `docs/superpowers/` was read.
No app vitest suite and no e2e was run. The fix's dashboard side is comments
plus one pin test, so no dashboard probe was needed.

### A. The fix, reviewed cold

**Every caller of the send wrapper's `recipient`.** There are exactly three
(grep over `app/src`): `app/src/jobs/broadcastFanOut.ts:471`,
`app/src/jobs/retrySend.ts:323` and `app/src/routes/api.ts:1683`. Every other
`sendMessage` caller (tour reminders, placement nudges, the missed-call text,
the welcome text, the composer send) passes none.
- Property sends: the thread is resolved from the recipient's OWN number
  (`broadcastFanOut.ts:451`, `createOrGetByParticipantPhone(contact.phone, ...)`).
  That repo call queries and creates on that exact string
  (`app/src/repos/conversationsRepo.ts:1252-1269`). The recipient item is read
  whole (`getById`, or pointer-aware `findByPhone` for a `phone#` key,
  `broadcastFanOut.ts:691-699`). So `contactHoldsPhone` is always true there:
  share-skip-fix I8 is unchanged, and the new WARN cannot fire.
- The retry job and the manual Retry route read the recorded recipient by id
  just before the send, so the `phones` the check sees are current.
- `recipient_contact_id` has three readers: the 30003 decision (through
  `previewSendRefusal`, which now takes a REQUIRED `participantPhone`,
  `oneToOneRetryDecision.ts:117`), the job and the route. The last two go
  through the wrapper (`sendMessage.ts:363-374`). None bypasses the check.

**The phone comparison (exact E.164 equality over `contactPhones`) is sound for
every shape the repo writes.**
- Create normalizes (`app/src/routes/contacts.ts:797-805`).
- The phone routes normalize before `addPhone` / `setPhone` / `removePhone`
  (`contacts.ts:2407`, `:2480`, `:2513`).
- `persistPhones` writes `phones[]` and the scalar in one `UpdateCommand`
  (`contactsRepo.ts:921`). `setPhone`'s promote ordering keeps the scalar
  inside `phones[]`.
- The importer writes both together (`app/src/lib/import/apply.ts:968-978`).
- The contact PATCH parser accepts no `phone`.
- `participant_phone` is the exact string from `createOrGetByParticipantPhone`,
  or Twilio's E.164 `From`.
- Precedent: the same predicate is already used at
  `app/src/services/extraction/apply.ts:605`.

**The WARN's PII.** It logs IDs only: `conversationId`, `recipientContactId`
and `phoneContactId` (`sendMessage.ts:365-369`). Contact ids are UUIDs; imported
ones are UUIDv5 hashes (`app/src/lib/import/ids.ts`). It is WARN, not ERROR,
so it feeds no alarm.

**Ignoring a moved recipient for the OPT-OUT gate too: right.**
- The model is number-scoped. A STOP from a number is always written to that
  number's own 1:1 conversation: `applyNumberSuppression` sets the conversation
  flag unconditionally (`app/src/services/numberSuppression.ts:137-149`), and
  the keyword path uses it (`app/src/routes/webhooks/twilio.ts:1186`). The
  wrapper still reads that flag and the current holder's flag.
- It restores main's behavior on both retry paths; main passed no recipient
  there.
- The only thing given up relative to the pre-fix branch is a CONTACT-ONLY
  flag on the moved recipient:
  - the manual Do-Not-Contact toggle (`contacts.ts:1961`), or
  - a one-to-one 21610 receipt, which flags only the contact
    (`twilio.ts:3775-3783`).

  In the 21610 case, Twilio's own opt-out list blocks the send anyway. In the
  toggle case, by our records the person at the number is no longer that
  contact, and a fresh composer send to the number is judged the same way.
- Caveat, pre-existing on main, not raised: a retry re-sends a body written for
  the recorded recipient (share bodies render their first name,
  `broadcastFanOut.ts:452`). After a reassignment it goes to the number's new
  holder. The automatic path cannot realistically reach this inside its
  15-minute window; the manual path is a staff press on a bubble whose text
  staff can see.

**Do the parity rows exercise the new rule? Yes.**
- The three moved-off rows (`app/test/helpers/sendRefusalCases.ts:184-194`)
  each flip between the pre-fix and post-fix rule:
  - row 1: pre-fix sends on the consenting recipient; post-fix refuses on the
    holder with no consent;
  - rows 2 and 3: pre-fix refuses on the recipient's opt-out or deletion;
    post-fix sends.
- The secondary-phone row (`:195`) fails for an implementation that compares
  only the scalar `phone`.
- All three harnesses put the thread on the rows' number: the preview through
  `SEND_REFUSAL_PHONE`, the wrapper fake (`app/test/sendMessage.test.ts:69`) and
  the decision's `thread()` (`app/test/oneToOneRetryDecision.test.ts:20,43`).
  (The last two couple by literal rather than by the exported constant. That is
  test-only fragility, not a finding.)
- The focused test (`sendMessage.test.ts:1008`) pins the WARN and the
  unrecorded `recipientContactId`.

**Verdict on the fix: correct, not merely plausible.** Its one gap is
documentary (R1 below).

### B. New findings

#### R1. [LOW] The comments that define the `recipient` contract still say the recorded recipient is always judged

**What is wrong.** The rule is now conditional (the recipient counts only while
it holds the thread's number), but the contract comments were not touched.
- `app/src/services/sendMessage.ts:264-275`, the `recipient` input doc, says:
  "When set, the deleted and JIT-consent gates judge THIS contact ... the
  opt-out gate refuses on EITHER contact's flag. Absent on every other send
  ... a retry of the row can judge the SAME contact". "Absent on every other
  send" was already false once this branch added two callers.
- `app/src/repos/messagesRepo.ts:755-758` (`NewMessage.recipientContactId`)
  says "so a retry judges that same contact. Absent when the phone lookup
  decided". It is now also absent when the named recipient did not hold the
  number.
- `app/src/jobs/retrySend.ts:142-145` and `:184-188`,
  `app/src/routes/api.ts:1609-1614` and
  `app/src/services/oneToOneRetryDecision.ts:20-21` describe only the "no
  longer exists" fallback.
- `docs/issues/ai-mode-switch-gates-all-automation.md` (its 2026-09-26 block)
  says the retry "is sent with the original's flag and recipient" and "the
  manual Retry route passes the recorded recipient too".

**Failure scenario.** The next caller of `recipient` (send-outcome-reconcile's
`retrySend` adoption, or share-skip-fix Branch B) builds on the input doc and
assumes the named contact is always the one judged.

**Suggested fix.** One sentence at each site: "counts only while it holds the
thread's number (`contactHoldsPhone`); otherwise the phone-matched contact is
judged and nothing is recorded".

#### R2. [LOW] ADV-4 contested: Twilio's documented default does NOT redeliver a 5xx

**Evidence.**
- Twilio's "Webhook connection overrides" documentation (fetched this pass)
  sets the default retry policy `rp` to `ct` (connection/TLS failures only) and
  the default retry count `rc` to 1. A 5xx response is retried only when the
  URL carries `rp=5xx` or `rp=all`.
- This app's delivery-status callback is the Messaging Service's
  console-configured URL (`app/src/adapters/messaging.ts:12-17`). Nothing in
  the repo sets a `#rp=` override (grep over code, infra, scripts and docs).

**Why it matters.** The claim's fail-closed recovery is written as if a 5xx
IS redelivered (`twilio.ts:2839-2840`, `:3155-3160`, `:3312-3313`, and
`:3364-3367`: "Twilio redelivers on ANY 5xx"). The repo's own inbound path
says the opposite (`twilio.ts:2521-2525`: "Twilio's redelivery is best-effort
backup, not the recovery plan").

Unless the console URL carries an override nobody has recorded,
`claim_failed` is terminal. No rung is created, nothing redelivers, and the
member's ladder is lost; the only trace is one ERROR marker. This branch adds
throwable reads to that path: the conversation read plus `isMemberSuppressed`'s
one or two contact reads and a participant-phone GSI query
(`twilio.ts:2841-2848`). Meanwhile the one-to-one decision fails OPEN on the
same class of read (`app/src/services/oneToOneRetryDecision.ts:28-37`).

"Deliberate, recorded" shows the choice was made. It does not show that its
premise holds.

**Suggested fix (cheapest first).**
1. Read the console URL and record the answer next to the claim comment. If it
   already carries `rp=5xx`, I concede.
2. Otherwise either add the override (a Twilio console change, for the human),
   or make the new preview reads fail open (append the rung open and let the
   job's gate decide), matching the one-to-one ruling.
3. Either way, correct the four comments.

### C. The adjudications

- ADV-1 FIX: verified (section A).
- ADV-2 FIX (comments only): conceded; `api.ts:1600-1602` and
  `retryPromise.ts:5-10` now name the one-tick bound.
- ADV-3 NOTE: conceded; the follow-up owns the share results row.
- ADV-4 NOTE: contested (R2).
- ADV-5 NOTE: conceded; the product owner ruled on the thresholds.
- ADV-6 FIX: verified; `dashboard/src/routes/contact/deliveryStatus.test.ts:824`
  fails on any one-sided edit to the 30003 copy.

### D. Swept again and cleared

- Every writer and reader of the new fields is unchanged since the first pass
  except the fix's own. `recipient_contact_id` is now written only for a held
  recipient (`sendMessage.ts:513`).
- The fix touches only the app, so a deploy with mixed versions changes nothing
  (the wrapper, the preview and the decision ship together).
- Noticed in passing, pre-existing on main and NOT introduced here: a Retry
  press refused with `contact_no_consent` shows nothing. `Timeline.tsx:91-95`
  maps that code to an empty message and expects the parent to open the
  consent modal. `ContactCommsPane` does that for sends only (`:228-242`); its
  `onRetry` (`:304-308`) does not. The branch makes this LESS reachable for
  shares (a consenting recipient who still holds the number is judged rather
  than a first-hit duplicate). Worth filing separately.

---

## Re-review of 03609cde

**Scope.** The fix commit 03609cde, reviewed cold at branch head 1db4b77e.
- bc66bd9f touches records only.
- 1db4b77e (the main merge) brings in 30 code files (inbox rows and timestamps,
  AuthGate, e2e performance). None overlaps a file this branch changes (`comm`
  over the two name lists is empty).
- I read `docs/issues/relay-retry-claim-assumes-5xx-redelivery.md`, as allowed;
  nothing else under `docs/superpowers/`.
- I ran no app vitest suite, no e2e run and no dashboard probe.

### A. The fail-open wrap itself

**Scope of the try.** The try (`app/src/routes/webhooks/twilio.ts:2848-2868`)
covers two things only: the conversation read, and `evaluateRelayRetryGates`,
whose only I/O is `isSuppressed` (a contact get or phone query plus a
participant-phone query). The window check, the slot build and the append all
stay outside it. So a throw from them is still `claim_failed`, as the new issue
records.

It does swallow EVERY throw, including a deterministic one. For example,
`normalizeToE164` calls `raw.trim()` (`app/src/lib/phone.ts:33`), which throws
a TypeError for a roster member whose `phone` is not a string. Such a fault is
not lost, though:
- the retry job runs the same evaluator after its execution marker
  (`app/src/jobs/relayRetryLeg.ts:532-541`) and throws again;
- the result is the job's own ERROR plus a rung stranded at `queued`, where
  before it was one `claim_failed` ERROR and a plain failure;
- it is reachable only on malformed roster data, which the fan-out would
  already have choked on.

Acceptable. Optional hardening: rethrow anything without an AWS `$metadata`,
so a code defect stays `claim_failed`.

**The WARN's PII.** It carries `conversationId`, `rootTsMsgId`, `attempt`, the
log-safe member key (`logSafeStoredRelayMemberKey`) and `err`, which goes
through the logger's Error serializer. There is no phone and no body. It is the
same shape as the one-to-one decision's accepted fail-open WARN
(`twilio.ts:3613-3617`, `failOpen: 'read_failed'`).

**The `gate !== undefined && gate.refused` narrowing.** It is type-correct: the
union narrows on `refused: true`, so `gate.code` is safe. With `gate`
undefined, the chain falls through to the D5 origin gap and then the window
check. A failed preview can therefore still end in a window decline and a
CLOSED rung. That is right on the data, and it is what R4 below turns on.
Nothing else in the claim reads `gate`.

**Is a rung claimed open after a failed preview safe?** Yes.
- The job re-runs all four gates and the window with fresh reads, after its
  execution marker (`relayRetryLeg.ts:532-606`).
- It passes `suppressionChecked: true` with its OWN suppression answer.
- If the job's reads also fail, it throws after the marker: the rung is
  stranded, and nothing is sent.
- There is no double-send path: one append wins the SID claim, one job runs per
  rung, and the marker stops redeliveries.
- The only cost is D3's "at once" display for that rung: it reads `Retrying`
  until the job refuses.
- The rewritten test cannot pass vacuously. It requires `failed === true`, a
  200, one open `queued` rung, one scheduled job, and the fail-open WARN text,
  which only this catch emits (`app/test/relayRetryClaim.webhook.test.ts`, the
  "(planner review)" case).

**Verdict: the wrap is correct.** Its log line and its neighboring comment are
not (R4, R5).

### B. What else was missed

- Does the new "Twilio does not redeliver" fact expose anything else in this
  branch? No. The one-to-one decision already failed open. The 30003 arm
  catches the enqueue failure and answers 200. The retry job depends on SQS
  redelivery, not Twilio's, and SQS does redeliver.
- The remaining 5xx paths predate this branch and are filed: the claim's
  re-read, roster read and append (the new issue), and the one-to-one status
  write and SID lookups (named at the end of that issue).
- The merge's inbox feature reads its own inbox endpoints and bumps nothing this
  branch reads. Automatic retries moving `last_activity_at` (and so the new inbox
  row time) predate this branch.

### C. New findings

#### R4. [LOW] The fail-open WARN announces "rung claimed open" before the window check and the append have decided

**What is wrong.** The catch logs 'relay retry claim: gate preview read failed -
rung claimed open; the retry job re-checks every gate (fail open)'
(`twilio.ts:2857-2868`). It does so BEFORE the window check (`:2883-2898`) and
the append. The line can then contradict the outcome in two ways:
- A late callback (outside the window's scheduling edge) makes the window
  decline. The rung is appended CLOSED with `retry_window_closed`, and the
  marker logs ERROR `window_closed`, next to a WARN saying it was claimed open.
- A duplicate callback (undelivered and failed for one SID) whose append
  dedupes claimed nothing, yet still logs "rung claimed open". The D5 origin-gap
  WARN avoids exactly this by logging only after the append wins
  (`twilio.ts:2996-3011`).

**Failure scenario.** During a DynamoDB degradation, an operator reads a
"claimed open" WARN and a `window_closed` ERROR for the same leg, and cannot
tell which one is true.

**Suggested fix.** Keep the error in a local in the catch. Log it after the
append, with the real outcome, as the originGap WARN does. Or reword it to
"gate preview skipped (read failed) - the retry job re-checks every gate".

#### R5. [LOW] Comments and the new issue's suggested fix still contradict the code

- `twilio.ts:2838-2840`: the fix left the old sentence "A read that THROWS here
  is the existing `claim_failed` (ERROR, a 5xx, and Twilio's redelivery re-runs
  the claim), like every read above." directly above the new comment that says
  the opposite. Delete it.
- RR-1 residue:
  - `app/src/services/sendMessage.ts:270` still says "Absent on every other
    send"; the retry job and the manual Retry route pass it too.
  - `app/src/repos/messagesRepo.ts:755-758` (`NewMessage.recipientContactId`)
    still says "so a retry judges that same contact. Absent when the phone
    lookup decided". It is also absent when the named recipient did not hold
    the number.
- `docs/issues/relay-retry-claim-assumes-5xx-redelivery.md`, "Suggested fix",
  says to add `rp=5xx` "to the status callback URLs the app builds ... and pin
  it with a test". For messaging the app builds no status callback URL: the
  Messaging Service's console-configured Delivery Status Callback serves every
  message, and the adapter passes no per-message `statusCallback`
  (`app/src/adapters/messaging.ts:12-17`, `:681-683`). No Terraform manages the
  Messaging Service. The override is either a console change (for the human)
  or a new per-message `statusCallback` in the adapter; only the second can be
  pinned by a test. As written, the fix points at code that does not exist.

### D. The adjudications

- RR-1 FIX: accepted, with the residue in R5.
- RR-2 FIX: verified (section A). The pre-existing reliance is filed as its own
  issue, which I accept; its wording is corrected in R5.
- Nothing else to contest.
