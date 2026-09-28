# Share sent outcome (Branch B) - build slice 4b report (T14)

Date: 2026-09-28. Implementer: slice-4b child (Claude Opus 5.5), dispatched by
the build orchestrator. Worktree `W:\tmp\share-sent-outcome`, branch
`feat/share-sent-outcome`, base `10a2931f` (the slice-4a report). Plan:
`docs/superpowers/plans/2026-09-28-share-sent-outcome.md` v5, Task 14 only
(the end-to-end spec, the three rewritten pins, `e2e/support/selectors.md`).
No app, dashboard or repair source was touched; the repair was not run.

## Status

DONE - one feature commit, then this report. No STOP condition: every
scenario passed against the built product on the first run, and no product
defect was found.

| Commit | What |
|---|---|
| `329d136a` | T14 - `share-sent-outcome.spec.ts` (the four section-7 scenarios), the `share-skip-fix` and `send-outcome-reconcile` pins rewritten, `selectors.md:116` |

Files (all in `329d136a`, exactly the plan's `git add` list):

- created `e2e/tests/dashboard-next/share-sent-outcome.spec.ts` (729 lines;
  tests at `:409` (a), `:503` (b), `:621` (c), `:676` (d));
- modified `e2e/tests/dashboard-next/share-skip-fix.spec.ts` (header
  `:16-22`, the test at `:250` - title, its arming comment `:259-264`, the
  flipped assertion `:280-286`);
- modified `e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts` (header
  item 4 `:26`, the 21211 hint pin `:457-465`, test 4's title `:492`, its
  pill and alert pins `:532-540`);
- modified `e2e/support/selectors.md` (the one row at `:116`).

## E2E runs, in order

Every run went through the e2e workspace (`npm run e2e -- <paths>`), with a
hard outer timeout and output to a file, read after the run. No run was red.
The per-test result lines carry a non-ASCII separator, so they are given
below as `ok N <file>:<line> (<duration>)`; the summary lines are quoted
verbatim.

| # | Command (from the worktree) | Log | EXIT | Result |
|---|---|---|---|---|
| 1 | `timeout 580 npm run e2e -- e2e/tests/dashboard-next/share-sent-outcome.spec.ts > .superpowers/sdd/logs/s4b-e2e-new-1.log 2>&1; echo EXIT=$?` | `s4b-e2e-new-1.log` | 0 | "4 passed (1.4m)" |
| - | `timeout 120 npm run e2e:stop` | `s4b-e2e-stop-1.log` | 0 | "[e2e-stop] no running session found; retained state is stale or absent - nothing to stop" |
| 2 | the mission's subset command (below) | `s4b-e2e-subset.log` | 0 | "Running 23 tests using 1 worker" ... "23 passed (3.8m)" |
| - | `timeout 120 npm run e2e:stop` | `s4b-e2e-stop-2.log` | 0 | same line as above |
| 3 | the same subset command, log `s4b-e2e-subset-2.log` | `s4b-e2e-subset-2.log` | 0 | "Running 23 tests using 1 worker" ... "23 passed (3.7m)" |
| - | `timeout 120 npm run e2e:stop` | `s4b-e2e-stop-3.log` | 0 | same line as above |

The subset command (runs 2 and 3; run 3 wrote `s4b-e2e-subset-2.log`):
`cd /w/tmp/share-sent-outcome && timeout 900 npm run e2e -- e2e/tests/dashboard-next/share-sent-outcome.spec.ts e2e/tests/dashboard-next/share-skip-fix.spec.ts e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts e2e/tests/dashboard-next/broadcasts.spec.ts e2e/tests/dashboard-next/listing-activity.spec.ts e2e/tests/dashboard-next/landlord-activity.spec.ts e2e/tests/dashboard-next/retry-send-adoption.spec.ts > .superpowers/sdd/logs/s4b-e2e-subset.log 2>&1; echo EXIT=$?`

Run 1 (the new spec alone, to shake it out before the subset): ok 1
share-sent-outcome.spec.ts:410:3 (a) (16.7s); ok 2 :504:3 (b) (35.9s); ok 3
:622:3 (c) (4.9s); ok 4 :677:3 (d) (12.6s). (Line numbers moved by one when
an unused interface field was removed before run 3; see divergence 10.)

Per spec, runs 2 and 3 (Playwright ran the files alphabetically):

| Spec | Run 2 | Run 3 |
|---|---|---|
| broadcasts.spec.ts | 4/4 ok (4.4s, 2.5s, 10.5s, 2.3s) | 4/4 ok (4.7s, 2.4s, 10.3s, 2.4s) |
| landlord-activity.spec.ts | 1/1 ok (5.2s) | 1/1 ok (4.6s) |
| listing-activity.spec.ts | 4/4 ok (5.2s, 4.1s, 2.2s, 2.3s) | 4/4 ok (4.5s, 3.8s, 1.5s, 2.1s) |
| retry-send-adoption.spec.ts | 3/3 ok (15.0s, 21.1s, 21.2s) | 3/3 ok (14.9s, 21.1s, 21.1s) |
| send-outcome-reconcile.spec.ts | 4/4 ok (10.1s, 10.5s, 2.6s, 9.8s) | 4/4 ok (10.0s, 10.5s, 2.6s, 9.7s) |
| share-sent-outcome.spec.ts | 4/4 ok (a 14.9s, b 36.0s, c 4.7s, d 12.4s) | 4/4 ok (a 14.8s, b 36.2s, c 4.9s, d 11.9s) |
| share-skip-fix.spec.ts | 3/3 ok (5.9s, 3.6s, 5.1s) | 3/3 ok (6.0s, 4.1s, 5.1s) |

No `[dynamoAdmin]` line in any of the three logs (grep count 0 each).

How the subset ran: the Bash tool caps one foreground call at 10 minutes,
below the command's own `timeout 900`, so runs 2 and 3 were started detached
with the exit code also written to `.superpowers/sdd/logs/s4b-e2e-subset*.exit`,
and this session blocked on a node wait loop until that file appeared (225 s
each). Same command, same log path; nothing was committed or edited while a
run was live, and the turn never ended with one running.

## The lane, and its end state

Every run resolved lane 7 (`[e2e-session] resolved lane 7: app=http://127.0.0.1:9701
dashboard=http://127.0.0.1:9711 fake=http://127.0.0.1:9721 publicBase=http://127.0.0.1:9731`),
`tablePrefix` `hc-local-7-`, `accessKeyId` `hclane7` (`e2e/.artifacts/lane.json`
while it existed). Each run booted it cold (no session was live; each run
started with `lane.json` and `session.pid` absent).

After run 3: the recorded launcher pid (67728) was not running (`tasklist`:
no task), `npm run e2e:stop` exited 0 and removed the stale `lane.json` and
`session.pid` (`e2e/.artifacts/` now holds `html-report`, `results.json`,
`test-results` only), and `netstat -ano | grep LISTENING` shows no listener
on 9701, 9711, 9721 or 9731.

## Spec section 7 -> assertion

(a) a 30003 whose retry delivers (`share-sent-outcome.spec.ts:409`):

| Claim | Assertion |
|---|---|
| the first text fails 30003 | `setDeliveryOutcome` 30003 before the share; `expectFailureStamped` (`:288`): the stored original is undelivered 30003 WITH `retry_due_at`, less than a production rung past `provider_ts` |
| "will retry" in between (the pending state) | the ordering guard: `pollResults` (`:435-440`) right after the stamp until `stats.retry_pending === 1` and the recipient's `retryPending === true`; then the recipient is `failed` / `30003` with `retryDueAt` EQUAL to the stored row's own `retry_due_at` (`:441-445`, I5). The copy itself is DeliveryBadge's unit test's (plan) |
| the retry delivers and reaches the slot (D2) | `pollRow` for the row with `retry_of` = the original, delivered, `retry_attempt` 1, `retry_root` = the original, `broadcast_id` = the share (`:451-457`); the slot `delivered` with `tsMsgId` = the original and `latestAttempt` = the retry (`:458-467`); stats delivered 1, failed 0, retry_pending 0 (`:468`); the carrier holds `['undelivered', 'delivered']` (`:469-472`) |
| results row Delivered | `recipientRow(...)` contains `Delivered` (`:477`) |
| the share Sent | `statusPill(page, 'Sent')` (`:478`); chips Retrying 0, Delivered 1, Failed 0 (`:479-481`) |
| the tenant flagged "Already sent" | `openReviewRow` then `Already sent` visible (`:485-486`) |
| "Properties sent" lists the property | listings-sent API equals `[unitId]` (`:490-495`); the card's link named by the address, `href` `/listings/<unitId>` (`:497`) |

(b) the chain exhausts (`:503`, `test.setTimeout(120_000)`):

| Claim | Assertion |
|---|---|
| four failed texts, re-armed after each send lands | arm 1 before the share; after the stamp, `expectCreatesLanded(1)` then arm 2 (`:525-526`); `expectCreatesLanded(2)` / `(3)` then arms 3 and 4 (`:540-543`); the attempt-3 row failed 30003 with NO `retry_due_at` (the cap, `:544-555`); the stored chain is attempts `[0, 1, 2, 3]`, all undelivered 30003 (`:565-567`); the carrier holds four `undelivered` texts (`:568-573`) |
| the list, opened after the failure is stamped | the row (scoped `a[href="/broadcasts/<id>"]` inside `list[name="Property sends"]`) reads `Sending` (`:532-536`) |
| the share Not sent on the list (the row refetch), no reload | the SAME page, never reloaded: the row reads `Not sent` within 15 s of the stamped fourth failure and no longer `Sending` (`:560-561`) |
| the row Failed, "will retry" gone once the chain ends | API retry_pending 0 (`:578-579`); the row contains `Failed` and the plain `Phone unreachable (error 30003)`, not `will retry` (`:582-584`) |
| the hint (a message row, no live promise) | the row's link named `/open conversation to retry/`, count 1 (`:585`) |
| the share Not sent on the results page | `statusPill(page, 'Not sent')` (`:586`); chips Failed 1, Retrying 0 (`:587-588`) |
| the tenant NOT flagged | the review row visible, `Already sent` count 0 (`:591-593`) |
| the property gone from Properties sent | listings-sent API polled to `[]` (`:598-603`); the card shows `No properties sent yet.` and no link (`:611-613`) |
| the milestone reads "Property text failed" | the timeline API (`?kinds=milestone`) `listing_sent` labels for the unit equal `['Property text failed']` (`:604-609`); the timeline link, exact name, `href` `/listings/<unitId>` (`:614-617`); no link named `/^Property sent/` (`:618`) |

(c) a final 30007 (`:621`):

| Claim | Assertion |
|---|---|
| the row Failed | API: share finished, recipient failed 30007 (`:634-642`); the row contains `Failed` and `Carrier filtered the message (error 30007)` (`:649-651`) |
| its hint shown (a row, no promise) | API: the slot carries a `tsMsgId`, retry_pending 0 (`:644-645`); the hint link count 1 (`:652`) |
| the share Not sent | `statusPill(page, 'Not sent')` (`:653`); chip Failed 1 |
| the tenant NOT flagged | review row visible, `Already sent` count 0 (`:657-659`) |
| the property Activity "No tenants reached" | the unit activity API's `broadcast_sent` entry for the share polled to `tenantCount` 0 (`:663-668`); the Activity card's link `/No tenants reached/` with `href` `/broadcasts/<id>` (`:669-673`) |

(d) SOR's unconfirmed path (`:676`), armed as `send-outcome-reconcile.spec.ts:491` arms it (drop_before_create + fail-list x3):

| Claim | Assertion |
|---|---|
| a Not confirmed share | API: stored `failed`, recipient `send_unconfirmed`, stats.unconfirmed 1 (`:693-702`) |
| reads Not confirmed | `statusPill(page, 'Not confirmed')` (`:707`); the row `Not confirmed`, no hint (`:708-710`); chips Not confirmed 1, Failed 0 |
| no `last_error` alert | API precondition: `last_error` IS stored as the unconfirmed prose (`:701`); the alert filtered on that prose, count 0 (`:711`) |
| flags the tenant | `Already sent` visible on the review row (`:717-718`) |
| not listed under Properties sent | listings-sent API `[]` (`:722`); `No properties sent yet.` and no link (`:724-726`) |

## The rewritten pins

- `share-skip-fix.spec.ts:250`: now asserts the 30007 recipient's review row
  is visible, carries NO `Already sent` (count 0) and stays checked (seeded);
  title and header `:16-22` say the interim rule is gone (D1). The share's own
  assertions (Failed + Delivered rows, pill Sent) are unchanged and green.
- `send-outcome-reconcile.spec.ts:465`: the 21211 row's hint count is 0 (a
  synchronous rejection has no message row, D3); the comment names this
  file's new spec as the hint's positive control (a 30007 row and an
  exhausted chain both show it).
- `send-outcome-reconcile.spec.ts:537`: the pill reads `Not confirmed`;
  `:538-540`: the `last_error` alert count is 0 (shown under Not sent only).
- `selectors.md:116`: the `Retrying` chip (label list, what it counts, the
  Failed + Retrying balance), the derived pill labels and that `Failed` is no
  longer a pill, `last_error` under `Not sent` only, the hint rule ("ONLY when
  the text has a message row and no live retry promise", plain text, no
  glyph), and the list-row scoping.

## Divergences from the plan's sketch, and why

1. UID BLOCK. The spec's `uid` starts at 94 (`:83`, mints 95-98), not 90:
   `retry-send-adoption.spec.ts` already mints 91-93 from the 90 block, and
   the precedent's own reason for per-file blocks is disjointness (the fake's
   armings and thread store reset once per suite). Still the 90s block, still
   below 100 (the two-digit suffix).
2. (b)'s SECOND ARMING IS PLACED BEFORE THE LIST OPENS (`:525-526`), right
   after the stamp, instead of after it: retry 1 fires about 10 s after the
   failure, and a slow list load must not let it through unarmed. The list is
   still opened after the failure is stamped, as the plan requires.
3. `expectCreateLanded` became `expectCreatesLanded(count)` (`:312`): it
   counts the share's texts by their `/p/<unitId>` needle (a retry carries the
   same body) up to an exact count, the barrier the re-arm loop needs.
4. BUDGETS. Every `expect.poll` is 30 s, including the copied
   `expectFailureStamped` (20 s in its precedent); the list-pill wait is 15 s;
   (b) is `test.setTimeout(120_000)`. (a) and (d) also carry `test.slow()`
   (the plan names only (b)'s timeout), as `send-outcome-reconcile.spec.ts`
   does for its reconcile tests; (c) keeps the 60 s default. Measured: (a) about
   15 s, (b) about 36 s, (c) about 5 s, (d) about 12 s.
5. ASSERTIONS BEYOND THE SKETCH (each cheap, each an API or stored-row fact
   that makes a screen read meaningful): (a) `retryDueAt` equals the stored
   row's own stamp, the slot's `latestAttempt` / `tsMsgId` pointer pair, the
   carrier's two texts; (b) the list reads `Sending` before it flips, the
   chain's shape (stored and carrier), the capped row's missing promise, no
   `Property sent...` link; (c) the slot's `tsMsgId` precondition for the
   hint; (d) the stored `last_error` precondition for the alert's absence, the
   chips.
6. LOCATORS NOT BY ROLE, each a precedent: the list row by
   `a[href="/broadcasts/<id>"]` inside the named list (`share-skip-fix.spec.ts:238`
   - a share row's accessible name is pill + reach + counts + date, not
   unique); the "Properties sent" and "Activity" cards as `section` filtered
   by their heading (`matching-entry-points.spec.ts`, `listing-activity.spec.ts`
   - a Card is an unnamed section); the review row by `li` text (the copied
   `openReviewRow`).
7. PIN EDITS BEYOND THE NAMED LINES, each only the pin's own words:
   `send-outcome-reconcile.spec.ts` test 4's title (`:492`, it said "the share
   reads Failed with the unconfirmed prose") and header item 4 (`:26`, "share
   Failed"); `share-skip-fix.spec.ts` test 3's title and its arming comment
   (`:259-264`, it cited the retired "excluded whole" rule). No other line of
   either file changed.
8. NOT ASSERTED, by design: the pill TONE (danger for Not sent / Not
   confirmed - a CSS-module class; `broadcastFormat.test.ts` pins it), and the
   "will retry" COPY on the results row (the plan gives it to
   `DeliveryBadge.test.tsx`; (a) asserts the pending state through the API).
9. The subset ran detached with a foreground wait (see "E2E runs"), because
   of the tool's 10-minute foreground cap.
10. THREE RUNS, NOT ONE: the new spec alone first; then the subset; then,
    after removing one unused field from a file-local interface (type-only:
    the spec's `ResultsRecipient.retryOutcome`), the subset again, so the
    committed bytes are the ones that ran green. The e2e typecheck and lint
    were re-run after that edit (both exit 0).

## Observed in the product (not spec failures)

1. THE MID-CHAIN "SENT" FLASH, measured. In run 3's app log, (b)'s share
   (`bcast-fc667907-...`) moved failed -> sent on each retry's carrier `sent`
   and sent -> failed on its 30003 148-150 ms later (rungs at 19:19:13.612 /
   .760, 23.977 / 24.127, 34.338 / 34.487; the original's failure rolled up at
   19:19:03.404, so the chain ran 31.1 s). Per D1 a carrier-accepted slot
   counts as reached, so the list and results pills read `Sent` for about
   150 ms per rung (plus the render), and the ledger entry is counted by
   acceptance for the same beat (so listings-sent can list the property
   transiently mid-chain). The plan's self-review names this; the spec asserts
   the end state. Worth a note for the self-QA eyeball, not a defect.
2. THE PENDING WINDOW in (a) measured 10.2 s (the original's failure rollup
   19:18:48.448, the retry's `sent` 19:18:58.656). The API poll hit it on its
   first samples.
3. An exhausted chain logs, once, the pre-existing one-to-one ERROR
   `transient delivery failure exhausted retries - terminal, giving up`
   (`app/src/routes/webhooks/twilio.ts:3619`, retry-send-window; it carries a
   U+2014 in source, paraphrased here). Expected for the cap; untouched.
4. After every Playwright-managed run on this Windows host, `e2e/.artifacts/session.pid`
   and `lane.json` outlive the killed launcher (pid gone, ports free);
   `npm run e2e:stop` reports "no running session found; retained state is
   stale or absent - nothing to stop" and removes both. Harmless (the next
   run boots cold), but a "session.pid absent" gate check needs that stop.
5. Both subset runs log one `relay_connecting_stuck` ERROR ("relay group stuck
   connecting past the max wait - its warm number never registered (manual
   attention)") inside `send-outcome-reconcile.spec.ts`'s relay test window
   (between result lines 12 and 13), which passes. Not this branch's surface
   and not in this spec; named so it is not re-diagnosed as ours.
6. No other WARN+ app line was unexpected: no `no matching recipient slot`,
   no `unrouted`, no `broadcast delivery rollup failed`, no share-ledger ERROR
   in any run. Browser console output is not captured for passing tests, so
   no console-error claim is made.

## Other checks

- `npm run typecheck` (repo root, all workspaces): EXIT=0 before the commit
  (`s4b-typecheck.log`) and again on the committed tree with a clean
  `git status` (`s4b-typecheck-2.log`). `npm run typecheck -w @housingchoice/e2e`:
  EXIT=0 before run 1 and after the type-only edit.
- `npx eslint` on the three touched spec files (informational; gate 5 stays
  the orchestrator's): EXIT=0 twice (`s4b-lint.log`, `s4b-lint-2.log`).
- ASCII: 0 non-ASCII bytes in the new spec
  (`LC_ALL=C tr -d '\11\12\15\40-\176'`); 0 in the added lines of
  `share-skip-fix.spec.ts`, `send-outcome-reconcile.spec.ts` and
  `selectors.md`; 0 in this report.
- Not run, per the mission: `npm test`, `npm run smoke`, the full `npm run e2e`,
  the repair script.
