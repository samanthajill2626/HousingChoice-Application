# Share sent outcome (Branch B) - live self-QA (orchestrator-driven)

Date: 2026-09-28, 18:49-18:56 local. Driver: the build orchestrator (Claude
Fable 5.1), by hand - never delegated. Tree `feat/share-sent-outcome` at the
fix-wave-2 report commit (0002fbbc; code final e824a452). Harness: the
hermetic e2e lane 7 booted fresh with `npm run e2e:session` (app :9701,
dashboard :9711, fake carrier :9721; `E2E_SEND_RETRY_BACKOFF_MS` 10 s and the
2/4/8 s reconcile delays), the plugin Playwright MCP on the Chrome channel for
the eyeball (the project MCP's bundled Chromium build was not installed and
installing one is a download), curl against the lane's API for the setup and
the reads (dev-login as the seeded VA). Every unit and tenant was created
fresh through the API on per-run numbers (ids below; no phone in this record).
Screenshots: the worktree's gitignored `.playwright-mcp/share-sent-outcome-selfqa-*.png`
(six). The lane was stopped after the walk (`npm run e2e:stop` exit 0, no
listener on 9701/9711/9721/9731, `session.pid` gone).

Ids: units A `unit-67443b5e`, B `unit-7a2d1068`, C `unit-7f17bee7`, D
`unit-18b51a40`, E `unit-8726cdb2` (all owned by the seeded landlord
`contact-landlord-0001`); tenants Ava `contact-90648bb9`, Ben `contact-13fa9878`,
Cal `contact-5eadf8a9`, Dee `contact-39d742ec`, Eli `contact-967b1549`; shares
A `bcast-043d1fee`, B `bcast-132cfb3c`, C `bcast-fe4dba48`, D `bcast-350829fc`,
E `bcast-8a5148cb`.

## H1 - the pending window ON SCREEN (spec 7(a) / G4) - PASS

Scenario (b)'s first rung, `/broadcasts/<B>` opened ~6 s after the send
(18:51:38, the promise due 18:51:42.5): the header pill read **Sending**, the
Delivery stats read Failed **0** / Retrying **1** / Not confirmed 0, and the
recipient row read `Failed - Phone unreachable - will retry (error 30003)`
(the badge's accessible name; the separator glyph is the pre-existing one).
Screenshot `selfqa-b-pending.png`. The API at the same moment (scenario (a)'s
send, 2.5 s after it): `stats.retry_pending: 1`, the recipient
`retryPending: true`, `retryDueAt` = the row's own stamp 10.3 s past the send.

## Scenario (a) - a retry that delivers - PASS

Send 18:50:02.8; the original failed 30003 at +0.3 s with its promise
(18:50:13.289); the retry landed at 18:50:13 and delivered. API end state:
the slot `delivered` with `tsMsgId` = the original and `latestAttempt` = the
retry's key, `carrierSentAt` the retry's instant, `stats.delivered 1,
failed 0, retry_pending 0`; the retry row carries `retry_of`, `retry_attempt 1`,
`retry_root` = the original and `broadcast_id` = the share; Properties sent
lists unit A with `sentAt` = the RETRY's provider instant (22:50:13.000Z, spec
deviation 9); the milestone reads `Property sent`; the property Activity
`tenantCount` 1; a fresh draft's preview flags Ava (`alreadySentThisProperty:
true`). On screen (`/broadcasts/<A>`, `selfqa-a-delivered.png`): pill **Sent**,
Delivered 1, Failed 0, Retrying 0, the row `Ava SelfQA ... Delivered`. The
tenant's file (`/contacts/<Ava>`): the timeline pin **Property sent** (a link
to unit A) beside the delivered bubble; the Properties sent card lists unit A.

## Scenario (b) - a chain that exhausts (four 30003 failures) - PASS

Send 18:51:32.2; creates landed at +0.3 s, +11.1 s, +21.0 s, +31.6 s (the
lane's 10 s rung; the fake re-armed after each landed create). The share list
(`/broadcasts`) was opened at 18:51:53 with the row reading **Sending**; the
row flipped to **Not sent** at 18:52:04 with NO reload (`browser_wait_for`
resolved on the text), and the page's network panel shows the flip's read:
`GET /api/broadcasts/<B>/results?view=stats => 200` right after the fourth
failure's count-less event (the stats-only read Cameron ruled on; the
boundary proof). Screenshot `selfqa-b-list-not-sent.png`. API end state: the
slot `failed 30003` with `latestAttempt` = the fourth attempt (no promise on
the capped rung), `retry_pending 0`, four rows each with `retry_root` and
`broadcast_id`, the promises on rows 1-3 each one rung out. Results page
(`selfqa-b-results-not-sent.png`): pill **Not sent**, the `last_error` alert
`all recipients failed` (shown under Not sent only), Failed 1 / Retrying 0,
the row `Failed - Phone unreachable (error 30003)` + `open conversation to
retry`. A fresh draft's preview does NOT flag Ben; Properties sent is empty;
the milestone reads `Property text failed`; the Activity count 0.

## Scenario (c) - a final failure (30007) - PASS

Send 18:52:58; failed 30007 at +1 s (no promise, no row read). API: the slot
`failed 30007`, `retry_pending 0`; preview NOT flagged; Properties sent
empty; the milestone `Property text failed`; the Activity count 0. Results
page (`selfqa-c-results-30007.png`): pill **Not sent**, the alert, Failed 1,
the row `Failed - Carrier filtered the message (error 30007)` + `open
conversation to retry`. The property page (`/listings/<C>`): the Activity card
reads **No tenants reached** (a link to the share); the Sent to tenants card
reads `Not sent to anyone yet.`.

## Scenario (d) - a Not-confirmed share (SOR's unconfirmed path) - PASS

`drop_before_create` + `failList x3` on the original's create; sent 18:52:58;
the reconcile's three checks failed and the share's own unresolved close
landed by 18:53:25: the slot `failed send_unconfirmed` (no pointer - the text
was never recorded), `stats.unconfirmed 1`, `last_error` "Couldn't confirm
any text went out". Preview: FLAGGED (Not confirmed keeps flagging, D1's safe
reading); Properties sent empty; NO milestone (never accepted); Activity 0.
Results page (`selfqa-d-results-not-confirmed.png`): pill **Not confirmed**,
NO `last_error` alert, Not confirmed 1, the row `Not confirmed - Couldn't
confirm whether this text went out`, no retry hint.

## H2 - a share RETRY reaching the reconcile's unresolved close (sites 1-2) - PASS

Unit E / Eli: 30003 armed on the original (sent 18:53:51.3, failed at +0.2 s
with the promise 18:54:01.6), then `drop_before_create` + `failList x3` armed
for the RETRY's create. By 18:54:10: the ORIGINAL slot `failed
send_unconfirmed` with `latestAttempt` = the row-less marker
(`<original tsMsgId>~`), `stats.unconfirmed 1, failed 0, retry_pending 0`; the
original row carries 1b's WITHDRAW (`retry_due_at` = the 1970 sentinel,
`retry_outcome: unconfirmed`); preview FLAGGED; Properties sent empty; the
milestone reads **Property sent - not confirmed** (D6 through the ledger's
`unconfirmed` entry written by the D2 caller at the reconcile's close). The
job's two arms and every crash/redelivery re-apply stay unit-only by
construction (lane jobs run in process; a delayed dispatch is never
redelivered).

## H3 - the mid-chain "Sent" flash - not observed, named

Slice 4b measured about 150 ms of `Sent` per rung (between a retry's carrier
`sent` confirmation and its failure). My snapshots every few seconds never
caught it (the list read Sending at 18:51:53 and Not sent at 18:52:04). D1-
conformant (a carrier-accepted attempt reached); named in the handback.

## H4 - the landlord timeline recount - PASS

`GET /api/contacts/contact-landlord-0001/timeline?kinds=milestone` after the
four shares: the `broadcast_sent` pins read `Sent to 1 tenant` (A), `No
tenants reached` (B), `No tenants reached` (C), `No tenants reached` (D) - the
share's reached count at read time, the singular form included.

## H5 - the repair rehearsal on the lane - PASS (converges, all zero)

`npx tsx app/scripts/repair-share-outcomes.ts --env local --lane 7` (census):
exit 0, `sharesWalked 10` (the five sent shares plus five drafts made for the
preview checks - unit-targeted, no slots), `slotsWalked 4` (share D's slot
has no message pointer - never recorded - and is skipped by design), every
`*To*` counter 0, `slotsFailed 0`, every `unjudgeable` 0, no WARN/ERROR line.
`--apply`: exit 0, every past-tense counter 0, no WARN/ERROR. The census
again: identical zeros. The live writers (the webhook's retry routing, the
reconcile's unresolved close, the pass's entry) left nothing for the repair
to move or stamp - the RUNBOOK's expectation for a lane.

## Not proven here (unit-only, or production-scale)

Deviation 13's withdrawal re-emit (needs an SQS enqueue failure); the results
ticker's recount on a lapse with no event (the 60 s ticker is visibility-
gated and the pane was driven headless); the list keeping a count for a share
stored `sending`; the job's two arms (sites 3-4); the crash/redelivery
re-applies; the composer flag's cost over a long share history; a legacy share
near the old 1500 cap; the repair on real history (dev/prod are Cameron's).
