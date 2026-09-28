# S5 report - retry-send adoption, plan Task 8 (the e2e proof, spec items 17-19)

Implementer: Claude Opus 5.5 (1M context), 2026-09-28. Worktree
`W:\tmp\retry-send-adoption`, branch `feat/retry-send-adoption`, on top of
`3b32fb95` (the S4 checkpoint). Scope: plan Task 8 Steps 1 and 3, and the
spec-alone half of Step 2, with build worklist items 22-23. The full suite
(Step 2's second half) is NOT run here - the orchestrator runs it on a quiet
tree. Status: DONE. Line numbers below are at `597faa72`.

## Commits

| hash | subject |
|---|---|
| `597faa72` | test(e2e): a 30003 retry adopted, re-driven once, and closed unresolved with 'retry not confirmed' - end to end through the fake's seams (retry-send-adoption T8) |
| (this file) | docs commit, recorded by its own hash in git log |

`597faa72` touches exactly two files: the new
`e2e/tests/dashboard-next/retry-send-adoption.spec.ts` (642 lines) and ONE
line of `e2e/support/selectors.md` (the one-to-one row, `:50`). No app,
dashboard, fake or harness source was touched; the fences are untouched.

## The spec as built (`e2e/tests/dashboard-next/retry-send-adoption.spec.ts`)

Header `:7-68` states the design (the three verdicts, the lane seams, the four
kinds of evidence, the arming trap, the log scope, the recipients).

Helpers, all file-local (copied and adapted from
`send-outcome-reconcile.spec.ts` and `one-to-one-30003-retry.spec.ts`):
- `uniquePhone` `:96-100` - uid starts at **90** (disjoint from the relay
  specs' 0 / 40 and SOR's 70); three numbers per run (91-93).
- `StoredMessage` `:103-118` - the one-to-one spec's shape plus `retry_root`,
  `retry_outcome`, `broadcast_id`; `StampedFailure` `:121`.
- `reseedLean` `:129`, `devLogin` `:138` (SOR's), `createConsentedTenant`
  `:147` (SOR's; lastName `Adoption`, `verbal_in_person` consent).
- `conversationFor` `:163` - POST `/api/contacts/:id/conversation` -> 200
  `{ conversation }` (worklist 22).
- `sendStaffText` `:172` - POST `/api/conversations/:id/messages` `{ body }`
  -> 201 `{ conversationId, providerSid, tsMsgId, status }` (worklist 22); the
  original is then picked by that `tsMsgId`, never by body text.
- `storedRows` `:184` - GET `.../messages?limit=100` -> `{ messages }`,
  newest first (worklist 22; the one-to-one spec's parse, not its
  Tasha-bound helper - worklist 23).
- `pollRow` `:192` - `expect.poll` every 500 ms until `pick` accepts a row;
  every call names its budget and its failure message.
- `expectCreateLanded` `:215` - the happens-after barrier: the fake's thread
  store holds the original's create before any fail seam is armed.
- `expectFailureStamped` `:233` - the original reads undelivered / 30003 WITH
  `retry_due_at`, and the captured stamp is less than a production rung
  (60 s) past `provider_ts`: it is the failure's own +10 s stamp (pre-refresh)
  and the lane has the backoff seam.
- `retryOwnerLines` `:257` / `verdictLines` `:279` - SOR's `reconcileLines`,
  with the scope FIXED: `readLogTail({ since, event: 'send_reconcile' })`
  filtered to `owner.kind === 'retry_send' && owner.conversationId ===` this
  test's thread. No call site can widen it.
- `expectRetryOwnerContract` `:295` - R9's log shape on every tail line for
  the owner: `owner` = `{ kind, conversationId, retriedTsMsgId, attempt: '1'
  (a string), retryRoot }`, `recipientKey` `phone#redacted`, and no line
  carries the tenant's number (digits, so a URL-encoded form counts) or the
  body.
- `bubblesWithBody` `:320` (the one-to-one spec's), `openContact` `:325`,
  `expectDeliveredRetryBubble` `:334` (exact `Delivered` chip text, ONE
  bubble for the body - the retry collapse - no `Undelivered` / `Phone
  unreachable`, no Retry on it, no `will retry` anywhere on the page).
- `beforeEach` reseed `:344`, `afterAll` reseed `:349` (SOR's hooks).
- Each test calls `test.slow()` and builds one fresh consented tenant. Every
  app API call goes through `page.request` (the devLogin session); the bare
  `request` fixture only touches the fake and the log tail.

### The arming order as built (all three tests)

1. `setDeliveryOutcome(fail / undelivered / 30003)` BEFORE the staff send
   (`:365`, `:452`, `:533`); `since` is taken right after it.
2. `sendStaffText` - its 201 already proves the create passed the fake.
3. `expectCreateLanded` (`:376`, `:464`, `:545`) - the plan's "poll
   getOutboundTo for the body" barrier.
4. ARM: `failNextSend(accept_then_drop)` `:377` / `failNextSend(drop_before_create)`
   `:465` / `failNextSend(drop_before_create)` + `failList(count 3)` `:546-547`.
5. `expectFailureStamped` (`:378`, `:466`, `:548`) - the failure and its
   promise, captured before the retry runs 10 s later.

Arming at step 4 happens within ~0.1 s of the create - about 10 s before the
retry's create on every run (the failure lands ~0.3 s after the create, the
retry ~10.02-10.04 s after the failure).

### What each test asserts

- **17** (`:353`) accept_then_drop: the retry row (retry_of = the original,
  delivered, 40 s budget) carries `retry_attempt 1`, `retry_root` = the
  original's tsMsgId, `retry_window_start` = the original's `provider_ts`,
  `automated false`, no `broadcast_id`; exactly two stored rows with the body;
  the original's `retry_due_at` REFRESHED more than 60 s past the captured
  failure stamp (polled, 10 s) with no `retry_outcome`; ZERO WARN+ reconcile
  lines for the owner (`:425`); the fake holds the body with states
  `['undelivered', 'delivered']`; the screen shows one Delivered bubble and no
  `will retry`.
- **18** (`:441`) drop_before_create: the same retry-row lineage (the
  re-driven job's own append, 45 s budget), two stored rows, the owner's lines
  exactly `[{ level: 40, checkNo: 2, verdict: 'never_sent', cause: null }]`
  (polled 10 s) plus the R9 contract, states `['undelivered', 'delivered']`,
  the same screen.
- **19** (`:522`) drop_before_create + fail-list x3: the original reads
  `retry_outcome 'unconfirmed'` with `retry_due_at '1970-01-01T00:00:00.000Z'`
  (45 s budget), still undelivered / 30003; the owner's lines exactly WARN at
  checks 0 and 1 and ONE ERROR `unresolved` / `provider_unreachable` at check
  2, plus the R9 contract; `page.request.post(.../messages/<provider_sid>/retry)`
  -> 409 `{ error: 'retry_unresolved' }` (exact `toEqual`); states
  `['undelivered']` and one stored row; the bubble reads
  `Undelivered - Phone unreachable - retry not confirmed (error 30003)` with no
  Retry, taken in ONE locator (chip + `hasNot` the button); no `will retry`;
  then the POSITIVE CONTROL: a 30007 staff text on the same tenant renders
  `Undelivered - Carrier filtered the message (error 30007)` WITH the Retry
  button (visible), and on that same page the unconfirmed bubble still has
  none (`:620-641`).

## Acceptance runs (the committed bytes, alone, each on a freshly booted lane)

Command (from the worktree, bash): `timeout 590 npm run e2e -w e2e --
tests/dashboard-next/retry-send-adoption.spec.ts > .superpowers/sdd/s5-e2e-runN.log 2>&1`.
Before EVERY run: `git hash-object` of the spec = `git rev-parse
HEAD:<spec>` = `c83602a5` (HEAD `597faa72`), `npm run e2e:stop` (it reported
nothing running each time), and `netstat -ano | grep LISTENING` for
`:10201|:10211|:10221|:10231` -> nothing. After every run: the same stop and
the same port proof -> nothing listening.

| run | start (UTC) | exit | wall | suite | 17 | 18 | 19 |
|---|---|---|---|---|---|---|---|
| 1 | 07:27:37 | 0 | 71 s | 69.0 s, 3 passed | 14.5 s | 21.1 s | 21.0 s |
| 2 | 07:29:19 | 0 | 70 s | 69.2 s, 3 passed | 14.9 s | 21.1 s | 21.1 s |
| 3 | 07:30:46 | 0 | 70 s | 68.9 s, 3 passed | 14.5 s | 21.1 s | 21.1 s |

Lane 12 on every run: app `:10201`, dashboard `:10211`, fake `:10221`,
publicBase `:10231`, tables `hc-local-12-*`, key `hclane12`. Fresh-lane proof
in each log: Playwright's own webServer (`[WebServer]` prefix) printed
`[e2e-session] resolved lane 12`, `clean-slate reseed (hermetic session
start)` and `[e2e-session] ready`, and no `reusing the live e2e:session`
line; the seams show in the timings (retry at failure + ~10.03 s, checks at
attempt + ~2.03 / ~4.05 / ~8.07-8.09 s in every run) and
`expectFailureStamped`'s guard held.
Logs (gitignored run state): `.superpowers/sdd/s5-e2e-run{1,2,3}.log`.

An EXPLORATORY run 0 (`.superpowers/sdd/s5-e2e-run0-diag.log`, 07:22:37,
exit 0, 71 s, 3 passed: 14.4 / 21.1 / 21.1 s) ran the same spec with a
temporary dump of the stored rows and the log tail (lines tagged `TEMP-DIAG`);
the dump was removed before the commit (the file's sha256 restored to the
pre-dump value and checked) and run 0 is not counted.

No flake, no retry of a run, and no timing adjustment was needed. Observed
margins: 17's retry row is adopted delivered ~12.1 s after the failure
(budget 40 s); 18's re-driven retry is sent ~18.1 s after the failure and
delivered ~0.3 s later, and 19's withdrawal lands ~18.1 s after the failure
(budgets 45 s); every per-test wall is 14-21 s against the 180 s
`test.slow()` cap.

## What the live runs showed about the product

Everything followed the design; nothing surprised. The app's own log lines
(the webServer output is in each run log) give the full trail - the numbers
below are run 1's; runs 2 and 3 are identical in shape and to the
millisecond in their offsets.

- **17 (found).** Failure WARN `twilio delivery failed` 07:27:52.487 ->
  `retrySend: retry outcome unknown - handed to reconcile` (INFO,
  `attemptedAt` 07:28:02.514) -> `retry promise annotated` to
  07:30:10.514Z = attemptedAt + 128.000 s (`retrySend.ts:784-790`: the lane's
  last check 8 s + `RETRY_PROMISE_GRACE_MS` 120 s) -> check 0 at +2.06 s:
  `send.reconcile: found - the message the provider holds is adopted`
  (INFO, `path lookup`, `adoption adopted`, `deliveryStatus delivered`,
  `sendReconcile.ts:543-554`). The refreshed stamp sat ~128 s past the
  failure's (the assertion's margin is 60 s). The fake's early status
  callbacks for the dropped create were processed after the adoption landed
  (the status webhook's 2.5 s re-look found the adopted row): NO
  `status callback for unknown provider SID` line (`twilio.ts:3419`) in any
  of the four runs.
- **18 (never_sent).** Hand-off REFRESH to attemptedAt + 128 s; checks 0 and 1
  `continue` / `nothing_adoptable` (INFO) - the original, same body, in the
  window, was skipped as `other` (Review Focus 2 holds end to end); check 2
  (+8.07 s) the one WARN `never_sent ... re-driven once`
  (`sendReconcile.ts:1615-1618`), then `retry promise annotated` to check-2
  time + 180.000 s (the re-drive REFRESH, `sendReconcile.ts:1624-1631`), and
  the re-driven job logged `retrySend: message re-sent` 35 ms later. The final
  stamp on the original was that re-drive refresh (e.g. run 0: 07:26:25.169Z
  = 07:23:25.169 + 180 s); no REFRESH race was lost.
- **19 (unresolved).** Hand-off REFRESH as above; checks 0 and 1 each one WARN
  `send.reconcile: the provider lookup failed at this check` with `err`
  `{ type: 'RestException', message: 'fail-list: provider unavailable', code:
  '20500', status: 500, moreInfo }` (`sendReconcile.ts:562`); check 2 (+8.05
  s) ONE ERROR `send.reconcile: unresolved - ... closed send_unconfirmed,
  never re-sent` with `verdict unresolved`, `cause provider_unreachable`
  (`sendReconcile.ts:1405-1408`), then the WITHDRAW 2 ms later (`retry promise
  annotated` to 1970-01-01T00:00:00.000Z, `sendReconcile.ts:1318-1320`).
- Real reconcile line shape (run 0, test 19, check 2; ids shortened):
  `{"level":50, "event":"send_reconcile", "owner":{"kind":"retry_send",
  "conversationId":"conv-b9db...", "retriedTsMsgId":"2026-09-28T07:23:27.000Z#SM...726c",
  "attempt":"1", "retryRoot":"2026-09-28T07:23:27.000Z#SM...726c"},
  "recipientKey":"phone#redacted", "checkNo":2, "verdict":"unresolved",
  "cause":"provider_unreachable", "err":{...}, "hopCount":4, ...}`. Every
  job line (INFO) carries `recipientKey: 'phone#redacted'` and the retried
  row's `providerSid`; the re-sent line adds `newProviderSid`.
- WARN+ census, identical in all three acceptance runs: boot WARNs
  (in-memory scheduler, in-process jobs) x2 each; `no group-origin inbound
  in seven days while group threads are active` x2 (the lean seed's guardrail,
  unrelated); `twilio delivery failed` 30003 x3 (WARN); the owner's lines
  (never_sent x1, provider lookup failed x2, unresolved ERROR x1); and the
  positive control's 30007: one ERROR `twilio delivery failed` (the webhook's
  designed severity for a terminal code, `twilio.ts:3504`, pre-existing) plus
  one WARN `carrier filtering (30007)`. Both control lines land inside test
  19's own window (the test waits on the stored 30007 row and then renders the
  page), so no later spec's `since` window can inherit them.
- The dropped create surfaces in the job as `ProviderSendFailedError:
  provider send failed (unknown): socket hang up` (INFO hand-off line).

## Deviations from the plan / worklist (all deliberate)

1. The original is identified by the send route's own 201 `tsMsgId`, not by
   filtering on the body (worklist 22 gives the 201 shape) - exact identity.
2. Arming order: the plan's sketch polled the stored failure and then armed;
   as built the fail seams are armed right after the create LANDED
   (`expectCreateLanded`, the plan's own getOutboundTo barrier) and the
   failure is polled after. Strictly earlier inside the same 10 s window, so
   more margin; the create that consumes the arming is still the retry's.
3. `expectFailureStamped` adds the <60 s guard on the captured stamp (the
   one-to-one spec's seam check), so item 17's "refreshed past the failure's
   stamp" compares against a stamp proven to be the failure's own.
4. Item 17's refreshed read POLLS the same condition (10 s) instead of one
   read: the job awaits the REFRESH right after the check-0 enqueue, so on a
   slow box the adoption could land first. Same assertion, not weaker.
5. SOR's predicate-parameterized `reconcileLines` became
   `retryOwnerLines` + `verdictLines` with the scope fixed to event
   `send_reconcile` + `retry_send` + this conversation (the brief's rule).
6. Assertions beyond the plan's sketch, each a real contract: 17's zero owner
   lines (SOR's test-1 form); `broadcast_id` absent and the stored-row counts
   (2 / 2 / 1); 18's retry-row lineage (the re-driven append); the fake's
   texts by STATE sequence rather than a bare count (the one-to-one spec's
   form); `expectRetryOwnerContract` (R9) in 18 and 19; 19's failure fields
   unchanged and the positive control. The control follows selectors.md's own
   rule for this button ("keep a positive control"); it costs one extra send
   and ~3 s.
7. The screen check uses the exact `Delivered` text and a count of one bubble;
   the plan's `filter({ hasText: 'Delivered' })` is a case-insensitive
   substring that also matches `Undelivered`.
8. `NEXT = dashboardUrl` from `support/urls.ts` (SOR's form).
9. Runs used `timeout 590`, not the brief's `timeout 900`, so the hard
   ceiling fires inside the Bash tool's own 600 s cap and the exit code is
   never lost (each run took 70-71 s).
10. A side effect to name: to read the lane before the first run I executed
    `node e2e/support/lane.mjs` once (07:14:13Z). That resolver RESERVES the
    lane it prints: it wrote a `reserved` lease for lane 12 with its own
    (already exited) pid, reclaimable after its 240 s grace. It expired at
    07:18:13Z, before any run, and run 0 (07:22:37Z) took lane 12 normally.
    Harmless, but do not run the resolver to "look up" a lane.

## selectors.md (`e2e/support/selectors.md:50`, the one-to-one row)

ONE line, ASCII (the added line has 0 non-ASCII bytes). Added: the third chip
reading - `Undelivered - Phone unreachable - retry not confirmed (error
30003)` with NO Retry, for good, when the row carries `retry_outcome:
'unconfirmed'` - keyed on `retry_outcome`, never on the withdrawn stamp alone
(RSW's enqueue-failure withdrawal writes the same stamp with no outcome and
keeps offering Retry); the two 409 sentences in the composer's
`role="alert"` slot (`superseded` -> `A newer attempt already exists for
this message.`, `retry_unresolved` -> `This retry couldn't be confirmed -
send a new message instead.`), rendered only after a UI press (a stale tab),
while a `page.request` press gets the JSON alone; the lane timing (checks at
2 / 4 / 8 s, "retry not confirmed" ~18 s after the failure) and the REFRESHes
that let `will retry` outlive the 10 s backoff.

## Verification

- `npm run typecheck` (root, all five workspaces: app, dashboard, e2e,
  fake-twilio, fake-twilio-web) -> exit 0, 49 s, on the committed bytes.
- `npx eslint e2e/tests/dashboard-next/retry-send-adoption.spec.ts` -> exit
  0, no output. The config DOES lint e2e files: `eslint.config.mjs`'s
  `**/*.ts` block applies typescript-eslint `recommended` (46 rules resolved
  for this file by `--print-config`, `no-unused-vars` and `no-explicit-any`
  among them) - a real pass, not the `.mjs` hole.
- ASCII: `tr -d '\11\12\15\40-\176' < <spec> | wc -c` -> 0; the
  selectors.md added line -> 0; this report -> 0.
- NOT run (per the brief): `npm run e2e` without a spec path, `npm test`,
  `npm run smoke`.
- Left running: nothing. After run 3, `npm run e2e:stop` reported nothing
  running and no listener remained on `:10201/:10211/:10221/:10231`.

## For the orchestrator's full-suite run

- The file adds ~57 s of test time (14.5 + 21.1 + 21.1 s) plus four lean
  reseeds (three `beforeEach`, one `afterAll`).
- It sorts after `relay-open-stop.spec.ts` and before `roster-paging.spec.ts`;
  it leaves no job pending (every chain ends inside its test: found, re-sent,
  or closed at the last check) and no arming unconsumed on the passing path.
  Its numbers are per-run (uid 91-93) and never a seed number.
- The positive control's 30007 ERROR (`twilio delivery failed`, terminal-code
  severity) is logged inside test 19; a later spec asserting "no ERROR" must
  keep scoping by its own `since`, as the harness already requires.
