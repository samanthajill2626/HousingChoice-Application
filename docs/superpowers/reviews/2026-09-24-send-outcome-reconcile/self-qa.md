# Live self-QA (Task 16) - adoption, re-drive, unresolved, and the attempt-clock aging

Driven by the build orchestrator (Claude Opus 5.5), 2026-09-27 17:55-18:04 EDT,
on a FRESH hermetic lane: `npm run e2e:session` resolved lane 8 (app :9801,
dashboard :9811, fake-twilio :9821), `GET /__dev/ping` answered `appCommit
8f945800` (the code is exactly 52220729 - every later commit on the branch is
docs only), the session booted fresh so the lane's reconcile delay seam
(`E2E_SEND_RECONCILE_DELAYS_MS=2000,4000,8000`) was live, and the lane was
reseeded `lean` before the first scenario. Nothing was run against the human's
live ports.

How it was driven:

- The browser is the Playwright plugin MCP (the project MCP's bundled
  chrome-for-testing binary is not installed on this machine), authenticated as
  the lane's VA. The UI states below were read from the accessibility tree and
  screenshots, never inferred.
- Setup went through the dashboard's own API from the authenticated page
  (contacts, a property flipped Available, shares, a relay group) and through
  the fake's control routes (`/control/fail-next-send`, `/control/fail-list`,
  `/control/send-as-party`, `/control/register-number`, `/control/threads`).
  The connecting relay group was driven open exactly as the e2e fixture does:
  a founder dev-login read the warming number from `/api/pool-numbers`, and the
  fake registered it.
- App log lines come from the session launcher's own stdout (captured to the
  worktree's gitignored `.superpowers/sdd/selfqa/session.log`), so INFO lines
  (the reconcile's `found`) are visible, not only the WARN+ ring buffer.
- Per-run-unique numbers in the +1 555 890 exchange; arming only numbers this
  run minted; the lean seed's switched-off tenant was never touched.
- Screenshots: `W:\tmp\send-outcome-reconcile\.playwright-mcp\sor-selfqa-*.png`
  (gitignored). The plugin MCP may only write inside the main checkout's
  `.playwright-mcp\`, so they were written there and then moved, with the
  page/console snapshots of this run, into the worktree's ignored folder; the
  main checkout was left clean.

## Scenario 1 - relay `accept_then_drop`: adopted, Delivered live, sent once - PASS

- A two-member relay group ("QA Author 0171", "QA Member 0172") was created;
  it landed `connecting`, was driven open on pool +1 404 019 0001, and both
  create-time intros were confirmed delivered at the fake BEFORE arming.
- The thread was opened FIRST (so every change had to arrive live), then the
  fake was armed `accept_then_drop` for the member and the author texted the
  pool at 21:57:15Z.
- Send site: one WARN `relayFanOut: unknown send outcome - member handed to
  reconcile`.
- Reconcile: one INFO at 21:57:18.446Z - check 0, verdict `found`, path
  `lookup`, SID SM...8956 ("the message the provider holds is adopted"); no
  WARN or ERROR verdict for the leg. The fake's early status callbacks were then
  applied (sent 21:57:19.061Z, delivered 21:57:19.219Z) - no "unknown provider
  SID" ERROR.
- UI, no reload: the bubble's group reads "Delivery by recipient. QA Member
  0172: Delivered, SMS, 5:57p."; after the reveal click the row reads "QA Member
  0172 - Delivered - SMS - 5:57p"; no "Not confirmed" anywhere.
  (`sor-selfqa-s1-relay-adopted-delivered.png`)
- The fake holds exactly ONE copy for the member (SM...8956, delivered) and
  none for the author.

## Scenario 2 - share `drop_before_create`: never_sent, one re-drive, Sent - PASS

- A fresh property (flipped Available) and a consented tenant ("Redrive
  Reconcile", +1 555 890 0281); the fake armed `drop_before_create` for the
  tenant; the share was sent at 21:58:11Z and its results page opened.
- At +3 s the page read: pill "Sending", Queued 1, the row "Sending...".
- Log: one WARN `broadcastFanOut: unknown send outcome - recipient handed to
  reconcile` (21:58:11.174Z); `finalize deferred - recipients still open`;
  check 0 `continue` (21:58:13.2Z), check 1 `continue` (21:58:15.2Z), check 2
  WARN `never_sent` (21:58:19.257Z) - the recipient re-driven; the share
  finalized at 21:58:20.3Z.
- UI after the checks: pill "Sent"; Delivered 1, Not confirmed 0, Queued 0,
  Failed 0; the row "Delivered". (`sor-selfqa-s2-share-redriven-sent.png`)
- The fake holds exactly ONE copy for the tenant (created 21:58:19.285Z, the
  re-drive's, delivered).

## Scenario 3 - share `drop_before_create` + `fail-list` x3: Not confirmed, never re-sent - PASS

- A consented tenant ("Unconfirmed Reconcile", +1 555 890 0391); the fake armed
  `drop_before_create` AND `fail-list` count 3 for the tenant; the share was
  sent at 21:58:58Z.
- Log: the send site's hand-off WARN; check 0 and check 1 each a WARN "the
  provider lookup failed at this check - the next check tries again" (plus an
  INFO, see the observations); check 2 at 21:59:06.500Z the ONE ERROR:
  `send.reconcile: unresolved - the platform cannot tell whether this text went
  out; closed send_unconfirmed, never re-sent`, cause `provider_unreachable`.
  That is the only ERROR line in the window from the arming to the close.
- UI: pill "Failed" with the prose alert "Couldn't confirm any text went out"
  (it was the only recipient); chips Not confirmed 1, Failed 0, Queued 0; the
  row "Not confirmed" with the reason "Couldn't confirm whether this text went
  out"; NO "open conversation to retry" hint (a control row in the same lane - a
  30007 rejection - shows that hint, so its absence here is the D23 behavior,
  not a missing element). (`sor-selfqa-s3-share-not-confirmed-failed.png`)
- The fake holds ZERO copies for the tenant: nothing recorded, nothing re-sent.

## Scenario 4 - a relay leg stranded mid-send reads "Queued - not confirmed" at once - PASS

- Per build ruling A2 (no change to `routes/dev.ts`): the author sent an
  ordinary text to the open group (the member's leg delivered normally), then
  ONE scratch `UpdateCommand` on the lane table (`hc-local-8-messages`, the
  lane's own access key `hclane8`) set that leg's slot
  (`delivery_recipients["phone#+15558900172"]`) to `status: queued`,
  `attemptedAt` = 16 minutes before now (21:47:01.998Z, wall clock), and
  REMOVED `sentAt`, `sid` and `deliveredAt` - the claimed-but-never-sent shape.
  (The slot read before the edit already carried the relay site's D20a clock,
  `attemptedAt` 22:02:25.934Z, next to its `sentAt`.)
- UI on a plain page load: the bubble's group reads "Delivery by recipient. QA
  Member 0172: Queued, not confirmed, SMS."; after the reveal click the row
  reads "QA Member 0172 - Queued - not confirmed - SMS", in the danger tone.
  (`sor-selfqa-s4-relay-leg-queued-not-confirmed.png`)
- CONTROL (the boundary the D20a change sits on): a second scratch update
  removed only `attemptedAt`, leaving the same queued leg with no clock at all -
  the never-claimed shape. On reload the leg reads "Sending..., SMS" - silent,
  exactly as the staleness table says. So the attempt clock alone turns the
  stranded leg red.

## Measured at phone width (375 x 812) - a PRE-EXISTING row overflow, filed

- Scenario 3's results page at 375 px: the recipient row's badge is 344 px wide
  and never shrinks (`DeliveryBadge.module.css`: `white-space: nowrap`,
  `flex: 0 0 auto`), so the row overflows its box (scrollWidth 364 vs
  clientWidth 327), the badge runs to x = 388 past the 375 px viewport, and it
  covers the recipient's name. (`sor-selfqa-s3-375px.png`)
- CONTROL, same lane: a share recipient rejected with 30007 ("Failed" with
  "Carrier filtered the message (error 30007)") overflows worse - scrollWidth 485
  vs 327, the name's box collapsed to 0 px, the retry hint cut off.
  (`sor-selfqa-control-failed-30007-375px.png`)
- So the defect is the badge's layout, which predates this branch (the badge
  primitive 5004dce4; reasons on failed/skipped rows e4fb6085, both on main);
  the new "Not confirmed" row inherits it. The page itself does not scroll
  sideways (document scrollWidth 375). Filed as
  `docs/issues/share-results-recipient-row-overflows-at-phone-width.md`; not
  fixed here (out of scope; the code is final and gated).
- Same cause, cosmetic: the badge is a flex container, so the reason span's
  leading space collapses and every reason row shows its label ("Not
  confirmed", "Failed") run straight into the em dash that opens the reason
  (measured: the reason span's text begins with a space, then the em dash; the
  badge computes `display: flex`). Recorded in the same issue.

## Observations

- Scenario 3's checks 0 and 1 each log a WARN (the lookup failed) AND an INFO
  "nothing adoptable yet - the next check is scheduled" (verdict `continue`,
  reason `provider_error`) - the INFO's wording is generic and wrong for a
  provider error (`app/src/jobs/sendReconcile.ts:447-460`). Log wording only;
  added to `docs/issues/send-reconcile-job-residues.md` (item 16).
- The run's three ERROR lines, all accounted for: 21:56:37Z the lean seed's
  own relay group "stuck connecting past the max wait" (the lean-world noise
  every e2e run also shows); 21:59:06Z scenario 3's expected `unresolved`;
  22:01:50Z the 30007 control's own "carrier filtering (30007) - recipient
  failed, NOT retried" (its slot write resolved, so the FW4-2 gate logs it).
- The relay intro reads "connected with QA and QA" because both test members'
  first names are "QA" - test data, not a defect.

## Teardown

`npm run e2e:stop` (EXIT 0): "dropped lane 8 tables (hc-local-8-*)", "released
lane 8 lease"; no listener on :9801/:9811/:9821/:9831 afterwards. The session
launcher's background task ended non-zero because the stop killed it. The MCP
browser page was closed.
