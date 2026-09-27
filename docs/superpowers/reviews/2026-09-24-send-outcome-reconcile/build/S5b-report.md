# S5b report - Task 12 (Slice D, part 2): the lane seam and the four e2e specs

Dispatch S5b of the SOR Stage 1 build: the lane's reconcile delay seam and the
four send-outcome-reconcile Playwright specs. Implementer: Claude Opus 5.5 (1M
context). Worktree `W:\tmp\send-outcome-reconcile`, base faf9a146, HEAD
430ff8a7. Tree clean, no lane running.

Record note: the implementer returned this report as TEXT (the harness refuses
report-file writes from implementer subagents); the orchestrator landed it
here with its own checkpoint and one adjudication appended, per AGENTS.md.

## Commits

- `b8d46e67 test(e2e): lane seam for the send-outcome reconcile checks (2 s / 4 s / 8 s)` - only `scripts/e2e-session.mjs`; committed before any run, so the launch commit carried the seam.
- `430ff8a7 test(e2e): prove adoption, re-drive, rejection and an unresolved send end to end through the fake's seams` - new `e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts`, new `e2e/support/broadcastSelectors.ts`, `e2e/tests/dashboard-next/broadcasts.spec.ts`, `e2e/support/selectors.md`, `fake-twilio/README.md`.

Both commits: bare `git status` read first; MERGE_HEAD absent; explicit paths
only; 0 non-ASCII bytes in the staged added lines; `npm run typecheck` EXIT=0
with 0 `error TS` lines; Co-Authored-By trailer present.

## The seam

`scripts/e2e-session.mjs`, in childEnv right after `E2E_SEND_RETRY_BACKOFF_MS`:
adds `E2E_SEND_RECONCILE_DELAYS_MS: '2000,4000,8000'`. Its comment names
feat/send-outcome-reconcile and D13a and the production 5/30/240 s window;
says `reconcileCheckDelaysMs` ignores the value whenever JOBS_QUEUE_URL is set,
and ignores anything that is not three non-negative integers; and says a value
here only reaches a freshly booted lane. The T12-9 sentence now reads:
"share-skip-fix Branch B and send-outcome-reconcile's later retrySend adoption
(its Stage 1b) are to reuse it; the reconcile checks themselves have their own
seam, below."

## The four tests

File order; every one calls `test.slow()` (180 s each). The file reseeds the
lean world before each test and once after all of them; each test does its
own `devLogin`. Every number is minted `+15558<last4 of Date.now()><uid>`,
uid starting at 70 (the other relay specs start at 0 and 40, so no arming can
land on another spec's number); tenants use the same scheme.

1. `:265` "accept_then_drop on a relay leg: adopted by the reconcile,
   Delivered on the open thread without a reload, and sent once".
   `createGroupOpen` with two ad-hoc members; both intros settled (15 s poll
   each) before arming; the thread `/conversations/<id>` opened BEFORE the
   send, composer enabled (15 s); then `failNextSend(member,
   'accept_then_drop')` and `sendAsParty(author -> pool, token)`. Bubble:
   `getByText(token).first()` visible (15 s), its parent is the bubble; the
   'Delivery by recipient' list absent before the click; after clicking the
   body the member's row reads `Delivered` (20 s) and not `Not confirmed`. Log
   tail: exactly 1 WARN "member handed to reconcile" for this conversation (10
   s poll) and no WARN or ERROR `send_reconcile` line for it. Fake: the member
   holds exactly one copy containing the token, in state `['delivered']`; the
   author holds 0. Never reloads.
2. `:362` "drop_before_create on a share recipient: the provider holds
   nothing, the recipient is re-driven exactly once, and the share finishes
   Sent". A fresh Available unit and a fresh consented tenant
   (`verbal_in_person` + `consent_at`); arm `drop_before_create`, then the
   seeds-only share API sequence. Screen: `statValue('Delivered')` polls to 1
   (40 s); `statusPill('Sent')` (15 s); Failed 0; Not confirmed 0; the
   Recipients row reads Delivered. Log tail: 1 hand-off WARN for this
   broadcastId; the reconcile lines equal exactly `[{level 40, checkNo 2,
   verdict never_sent}]` (10 s poll). Fake: exactly 1 text containing
   `/p/<unitId>`.
3. `:420` "reject 21211 on one share recipient: that recipient fails with the
   code and never reaches the reconcile, and the other is sent". Two consented
   tenants; the first armed with `reject` code 21211. Screen: chips poll to
   {Failed 1, Delivered 1} (30 s); the `Not confirmed` chip is visible with
   value 0; the pill reads Sent; the rejected row reads `Failed` and `Delivery
   failed (error 21211)` and has exactly 1 link named `/open conversation to
   retry/` (the positive control for test 4); the other row reads Delivered.
   Log tail: the "send rejected by the provider" WARN equals `[{errorCode
   '21211', status 400}]` (10 s poll), and 0 hand-offs. Fake: 0 texts to the
   rejected tenant, 1 to the other.
4. `:491` "fail-list for the whole window: the recipient closes Not
   confirmed, is never re-sent, and the share reads Failed with the unconfirmed
   prose". One tenant armed with `drop_before_create` plus `failList(count 3)`.
   Screen: `statValue('Not confirmed')` polls to 1 (40 s); Failed 0; Delivered
   0; the row (scoped to the Recipients list, per T14-10) reads `Not confirmed`
   and `Couldn't confirm whether this text went out` and not `Failed`; the pill
   reads Failed (15 s); an alert shows `Couldn't confirm any text went out` (15
   s); 0 links named `/open conversation to retry/`. Log tail: 1 hand-off; the
   reconcile lines equal exactly `[WARN c0, WARN c1, ERROR c2 unresolved
   provider_unreachable]` (10 s poll). Fake: 0 texts.

No fixed sleeps anywhere; every wait is a poll or a web-first assertion on
durable state.

## Deviations, and why

- Log-tail assertions added to all four tests (not in the plan): on screen a
  re-driven recipient looks the same as a first-try send, and every unresolved
  cause reads the same; without the hand-off line an arming that silently
  missed would let tests 1 and 2 pass vacuously.
- The bubble uses `.first()`, as finding T12-3 directs; the relay list is
  'Delivery by recipient', scoped to the bubble.
- `test.slow()` on all four tests (the dispatch asked for it on every test;
  T12-6 named three).
- The file-unique number scheme replaces share-skip-fix's random numbers,
  because an arming is keyed on the destination number and survives until the
  suite's reset.
- Lean reseed before each test and after all, following the
  relay-30003-retry.spec.ts precedent.
- `statValue` and `statusPill` extracted unchanged into
  `e2e/support/broadcastSelectors.ts` (the plan allows it); broadcasts.spec.ts
  now imports them; broadcasts.spec.ts ran once on a fresh lane: EXIT=0, 4
  passed (34.0s).
- selectors.md gains one row for the results-page chips and pill, including
  the new `Not confirmed` chip-versus-row collision.
- fake-twilio/README.md gets one entry each for `POST /control/fail-next-send`
  and `POST /control/fail-list`.
- The spec takes the dashboard URL from `dashboardUrl` in support/urls.ts
  instead of writing out a `:5174` fallback of its own.

## Runs (all on lane 8: 9801 / 9811 / 9821 / 9831; each boots its own stack)

The reported three, on the committed bytes (spec blob 700a0971):

| Run | Exit | Result |
|---|---|---|
| gate1 | 0 | 4 passed (46.0s) |
| gate2 | 0 | 4 passed (45.7s) |
| gate3 | 0 | 4 passed (46.5s) |

Per-test times about 10.1 s, 10.5 s, 2.6 s and 9.7 s. Six earlier runs, whose
bytes differ only in comments, all passed too (run1 47.7s, run2 46.0s, run3
45.8s, final1 46.5s, final2 46.7s, final3 45.8s): 9 of 9 green, no flakes, no
retries.

## Fresh-lane proof

- `npm run e2e:stop` reported nothing running, and e2e/.artifacts did not exist.
- Before every run, `netstat` showed no listener on the four lane ports.
- The seam is live: in gate3 the fail-list share was handed off at
  13:54:44.354, and its checks ran at 46.376, 48.398 and 52.425 - +2.0 s /
  +4.0 s / +8.0 s, which only 2000,4000,8000 produces.
- At the end `e2e:stop` was clean and the ports were free.

## App-log evidence

`E2E_CHILD_LOG_DIR` was not needed: the Playwright stdout carried every app
line with a `[WebServer]` prefix, because `webServer.stdout` is `'pipe'`
(playwright.config.ts:205); parsed with a scratch script (session scratchpad
`S5b\`). Test 1, every run: the relay hand-off WARN is followed about 2.04 s
later by INFO `found, checkNo 0, path lookup, adoption adopted, deliveryStatus
delivered`. The Delivered row was on screen before the webhook's deferred
callbacks were processed (the first log-tail request came 2 to 34 ms after
them); the thread's refetch debounce is 300 ms, so the open thread was updated
by the adoption's own `message.persisted` (ruling A1).

## Concerns

1. The lane does not produce the "early callbacks dropped" timing that spec
   Sec 8 / D19 describe. The first check at 2 s beats the webhook's single
   unknown-SID re-lookup at 2.5 s (`STATUS_UNKNOWN_SID_RETRY_DELAY_MS`), so the
   fake's callbacks are deferred and land after the adoption as no-ops
   ("transition skipped (would regress)"). The adoption itself carries
   Delivered in every run. In 1 of 9 runs (final1) the next test's reseed wiped
   the pointer before the second re-lookup, which logged one `status callback
   for unknown provider SID after retry` ERROR - the expected artifact (T16-4),
   harmless; keeping the relay test first confines that line to this file (the
   spec header says so). Proving the dropped-callback timing on the lane would
   need a first check delay above about 2.8 s - a plan change not made.
2. Pre-existing lint error, not this dispatch's: broadcasts.spec.ts
   `'request' is defined but never used` at :270 (it was :291 at the merge
   base; the deleted lines above shifted it). The two new .ts files lint clean.
3. AGENTS.md is stale on log capture: it says a failing spec keeps only
   browser artifacts because the webServer's stdout is not captured, but with
   `stdout: 'pipe'` a redirected run log does carry the app log. Not edited
   (out of scope).

The full suite was not run (the orchestrator's gate).

## Orchestrator checkpoint and adjudication

Verified at 430ff8a7: the six in-scope files only; 0 non-ASCII bytes in the
added lines; no listener on the lane-8 ports; the seam commit precedes the
spec commit.

Concern 1 adjudicated: ACCEPTED as a lane-timing difference, not a gap. D19's
"callbacks dropped" sentence describes one interleaving; the property the spec
needs - the adoption reads the provider's CURRENT status, so the leg ends
Delivered whatever happened to the early receipts - is proven on the lane (the
row turns Delivered from the adoption's own emit before the deferred callbacks
run, and those land as regress-skipped no-ops). The webhook's unknown-SID drop
is fenced, pre-existing code. The plan's lane delays stay 2000,4000,8000.
Concern 2 is attributed at gate 5 by baseline comparison; concern 3 goes to
the handback as an observation for the human.
