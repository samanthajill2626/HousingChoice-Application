# Live self-QA - retry-send adoption (plan Task 9 Step 2)

Driver: the build orchestrator, 2026-09-28 09:58-10:05 UTC. Branch
`feat/retry-send-adoption`, app commit `c998412b` (code final `1b5ddb01`, the
rest docs), on a FRESH hermetic `npm run e2e:session` lane: lane 12 (app
:10201, dashboard :10211, fake Twilio :10221, tables `hc-local-12-*`, key
`hclane12`), the lane seams live (retry backoff 10 s, reconcile checks
2/4/8 s). `/__dev/ping` answered `dev: true`, `tablePrefix hc-local-12-`,
`appCommit c998412b`. Logged in with `POST /auth/dev-login` (va@example.com).
Never the live ports :5174 / :8080.

Browser: the project Playwright MCP (bundled chromium) could not start - its
`@playwright/mcp@latest` now expects `chromium-1246`, which is not installed,
and installing it is a download the human approves. The Claude plugin
Playwright MCP (Chrome channel, installed) drove the pages instead. Its
artifacts land in the MAIN checkout's `.playwright-mcp/`; this run's own files
were moved into the worktree's gitignored `.playwright-mcp/` (screenshots
`qa-rsa-*.png`, MCP snapshots and console logs under `qa-rsa-mcp/`).

Every recipient was a FRESH consented tenant on a per-run `+155589...` number
(never a seed contact); the API calls went through the dashboard origin with
the dev session; the fake's control endpoints were driven directly.

## Item 19 - unresolved: "retry not confirmed", no Retry, 409, one text

Tenant `Qa19 Selfqa`, thread `conv-4ea1e61b...`. The 30003 profile armed
before the staff send (`POST /api/conversations/:id/messages` -> 201 at
09:59:10); the create landed at the fake at 09:59:10; `fail-next-send
drop_before_create` and `fail-list count 3` armed the same second.

The retried row, polled every second (the stored row, `GET
/api/conversations/:id/messages`):

| time (UTC) | delivery | retry_due_at | retry_outcome | children |
|---|---|---|---|---|
| 09:59:20 | undelivered / 30003 | 10:01:28.390 (REFRESHED by the unknown hand-off: attemptedAt 09:59:20.390 + 8 s + 120 s) | - | 0 |
| 09:59:29 | undelivered / 30003 | 1970-01-01T00:00:00.000Z (WITHDRAWN) | unconfirmed | 0 |

The app log tail (`/__dev/logtail?event=send_reconcile`, `capturing: true`),
scoped to `owner.kind === 'retry_send'` and this conversation - exactly three
lines, `recipientKey: 'phone#redacted'`, `attempt: '1'`, root = the retried
row:
- 09:59:22.426 WARN checkNo 0 - provider lookup failed, the next check tries again
- 09:59:24.442 WARN checkNo 1 - the same
- 09:59:28.465 ERROR checkNo 2 - verdict `unresolved`, cause `provider_unreachable`

(checks at attempt + 2.04 / 4.05 / 8.08 s). No line in the whole tail carried
the tenant's phone or the message body.

The fake's thread for the number: ONE outbound text (the original,
`undelivered`) - nothing was re-sent.

The contact page (desktop 929 px and 1280 px), read from the DOM: one bubble;
its chip reads exactly `Undelivered - Phone unreachable - retry not confirmed
(error 30003)` in the danger tone; `will retry` appears nowhere; ZERO buttons
named `Retry sending this message`. Screenshot `qa-rsa-19-unconfirmed-desktop.png`.

The press a stale tab would make (`POST
/api/conversations/:id/messages/:sid/retry` from the page's own fetch): 409
`{"error":"retry_unresolved"}`. (The composer's alert sentence cannot be
reached live on this row - the Retry button is withheld - and is pinned by the
dashboard suite, `Timeline.test.tsx`.) The page's console held one error: that
deliberate 409.

Phone width (360 x 800, reloaded), MEASURED on the chip and its eight
ancestors up to the comms pane: the chip is 204 px wide and wraps to 2 lines
inside the 230 px bubble; `scrollWidth <= clientWidth` at every level (no
horizontal overflow anywhere in the chain); the chip lies inside the viewport
(106..310 of 360); still no Retry button. Screenshot
`qa-rsa-19-unconfirmed-360.png`.

## Item 19b - the OPEN page re-renders live (the WITHDRAW's emit)

A third tenant (`Qa19b Live`): its contact page was OPEN before the staff send
and a 150 ms DOM recorder watched the bubble while the same arming ran (send
10:02:24, armed the same second). No reload. Recorded states:

| time (UTC) | bubble state |
|---|---|
| 10:02:13.501 | no bubble yet |
| 10:02:24.893 | `Undelivered - Phone unreachable - will retry (error 30003)`, no Retry button |
| 10:02:42.888 | `Undelivered - Phone unreachable - retry not confirmed (error 30003)`, no Retry button |

The page moved from the promise straight to "retry not confirmed" within about
0.5 s of the WITHDRAW (attempt ~10:02:34 + 8 s): `message.persisted` reached
the open dashboard over SSE. At no instant did the bubble offer Retry or read
the plain failure.

## Item 17 - adopted: one retry text, lineage, the promise refreshed

Tenant `Qa17 Selfqa`, thread `conv-1921f1b4...`: the 30003 profile, the staff
send (10:00:59), the create landed, `fail-next-send accept_then_drop` armed.

| time (UTC) | retried row retry_due_at | children |
|---|---|---|
| 10:01:08 | 10:01:09.372 (the failure's stamp: +10 s) | 0 |
| 10:01:09 | 10:03:17.407 (REFRESHED: attemptedAt 10:01:09.407 + 8 s + 120 s) | 0 |
| 10:01:12 | 10:03:17.407 | 1: `delivered`, `retry_attempt 1`, `retry_root` = the original's tsMsgId, `retry_window_start` = the original's `provider_ts`, `automated false`, no `broadcast_id` |

The adoption came at check 0 (INFO): the tail held ZERO WARN+ `send_reconcile`
lines for this owner and ZERO ERROR lines at all since the test began (no
unknown-SID ERROR from the webhook in this run). The fake's thread: exactly
TWO outbound texts with the body - the original (`undelivered`) and one retry
(`delivered`). The contact page: ONE bubble (the original collapsed under its
retry) reading `Delivered`, no Retry, no promise copy. Screenshot
`qa-rsa-17-adopted-desktop.png`.

## The manual Retry route on the superseded original - the guard order live

Pressing Retry on item 17's ORIGINAL (which now has a child):
- at 10:01:30, while the REFRESHED promise was live: 409
  `{"error":"retry_pending"}` - RSW's time guard answers before the new
  `superseded` check, as the route's guard order says (and as round 2's
  worklist-26 correction states);
- at 10:05:23, after the promise expired (10:03:17.4 + 2 min grace): 409
  `{"error":"superseded"}` - one `retrychild#` Query found the child.
The fake still held two texts afterwards: neither press sent anything.

## Teardown

`npm run e2e:stop` -> exit 0 (lane 12 tables dropped, lease released, state
cleaned); lane 12's four ports verified free. The session launcher's
background task ended non-zero because the stop killed it (expected).

## Verdict

PASS. Spec section 4 items 17 and 19 hold live with the numbers the design
predicts (the hand-off refresh at attempt + 128 s; checks at +2/+4/+8 s; the
WITHDRAW at the check-2 ERROR), the open page re-renders over SSE without a
reload, the new chip copy stays inside a 360 px screen, and the route's
guards answer in the stated order. Nothing here disagrees with the automated
suites; nothing new to file.
