# Retry send window build - Slice 5 report (Tasks 19-20)

Branch `feat/retry-send-window`, worktree `W:\tmp\retry-send-window`, base `822ec2e3`.
Written 2026-09-26. Task 21 (final gates, handback) is the orchestrator's and was
not started here.

## Commits

- `693dd7ec` test(e2e): one-to-one 30003 promises its retry with the failure, hides Retry, then the retry replaces it (retry-send-window) - Task 19.
- `3a82e690` docs(retry-send-window): close the group-text 30003 promise issue; annotate quiet-hours and ai-mode; reconcile the double-send residuals; selectors prose family and one-to-one row - Task 20.
- `152d3120` docs(retry-send-window): two comment corrections carried from slices 3b and 4 - the retry_due_at doc and the 30005/30006 group-text arm - the orchestrator's two carried comment fixes, as ONE SMALL SEPARATE COMMIT right after Task 20 (not folded into it), plus the R1 confirm.

Every command below ran from the worktree root with its output redirected to a
log under the gitignored `.superpowers/gates/`; each count and exit code was read
from the run itself, never through a pipe. No e2e run was in flight at any commit.

## Task 19

### Step 1 - probes (Git Bash, worktree root)

- `rg -n "E2E_SEND_RETRY_BACKOFF_MS" scripts/e2e-session.mjs app/src/jobs/retrySend.ts`:
  `scripts/e2e-session.mjs:282: E2E_SEND_RETRY_BACKOFF_MS: '10000',` (directly
  below `E2E_RELAY_RETRY_BACKOFF_MS: '10000'` at :272), and
  `app/src/jobs/retrySend.ts:88` (`SEND_RETRY_BACKOFF_ENV_KEY`) / `:92` (the
  `resolveSendRetryBackoffMs` doc); the function reads it under the
  `JOBS_QUEUE_URL`-unset guard.
- `rg -n "Phone unreachable - will retry" dashboard/src/routes/contact/deliveryStatus.ts`:
  `837: '30003': 'Phone unreachable - will retry',`.
- F1 probe, `rg -n "Phone unreachable \x{2014}" dashboard/src`: NO hit (rg exit 1).
  For the record, the plan's original probe `rg -n "unreachable \x{2014}" dashboard/src`
  hits exactly one line, `deliveryStatus.ts:409` (the unrelated docblock F1 names).
- `rg -n "Retry sending this message" dashboard/src/routes/contact/Timeline.tsx`:
  `1429: aria-label="Retry sending this message"`.
- `rg -n "retry_pending" app/src/routes/api.ts dashboard/src/routes/contact/Timeline.tsx`:
  `api.ts:1606` (the 409), `Timeline.tsx:134` (the `sendFailureMessage` case) and
  `Timeline.tsx:1420` (the Retry gate's comment).
- `rg -n "will retry|Phone unreachable" e2e/tests e2e/scenarios`: only
  `relay-30003-retry.spec.ts` (the header comment at :20-21, the recital string
  at :41 and :243, and the `not.toContain('will retry')` guards).

Before writing the spec, every selector and field it uses was checked against
the tree: the region `Communications and activity` (`Timeline.tsx:2565`); the
bubble body is a bare text node inside `div.body` (`LinkifiedText` renders plain
text without a wrapper), so `getByText(body, { exact: true }).locator('xpath=..')`
is the bubble div; the chip is `{delivery.label}{' - ' + reason}` in one span;
labels `Delivered` / `Undelivered` (`deliveryStatus.ts:54-55`); `'30007': 'Carrier
filtered the message'` (`:785`); `GET /api/conversations/:id/messages` accepts
`limit=100` (`MAX_PAGE_LIMIT = 100`, `api.ts:231`) and returns raw `MessageItem`
rows whose field names match the spec's `StoredMessage`; the CSRF origin check
(`app/src/middleware/csrfOrigin.ts`) passes the spec's `page.request.post` - an
absent `Origin` and a `127.0.0.1` origin are both allowed; `ContactCommsPane` wires
`onRetry`; the retry collapse hides a row whose `tsMsgId` is named by a later
`retry_of` (`Timeline.tsx:2061-2070`).

### Step 2 - the spec

`e2e/tests/dashboard-next/one-to-one-30003-retry.spec.ts` is BYTE-IDENTICAL to the
plan's code block (plan lines 9365-9654): `diff` of the extracted block against the
file printed nothing. LF line endings (the repo's `* text=auto eol=lf`).

### Step 3 - ASCII, typecheck, lint

- `tr -d '\11\12\15\40-\176' < e2e/tests/dashboard-next/one-to-one-30003-retry.spec.ts | wc -c` -> `0`.
- `npm run typecheck -w @housingchoice/e2e` -> exit 0 (log `s5-typecheck-e2e.log`: only the `tsc -p tsconfig.json` banner).
- `npm run typecheck` (root, every workspace) -> exit 0, 0 `error TS` lines (`s5-typecheck-root.log`).
- `npx eslint e2e/tests/dashboard-next/one-to-one-30003-retry.spec.ts` -> exit 0, empty log (`s5-eslint-spec.log`, 0 bytes).

### Step 4 - the spec alone on a fresh hermetic lane

- Pre-state: `e2e/.artifacts` did not exist. No lane-range listener existed on the
  machine (netstat showed nothing on any `9x01/9x11/9x21/9x31` port).
  `npm run e2e:stop` -> `[e2e-stop] no running session found; retained state is stale or absent - nothing to stop`, EXIT=0.
- Command (Bash `run_in_background`, then in-turn polls until the EXIT line):
  `timeout 900 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/one-to-one-30003-retry.spec.ts > .superpowers/gates/e2e-one-to-one.log 2>&1; echo "EXIT=$?" >> .superpowers/gates/e2e-one-to-one.log`
- LANE 7, booted fresh by this run: `[e2e-session] resolved lane 7: app=http://127.0.0.1:9701 dashboard=http://127.0.0.1:9711 fake=http://127.0.0.1:9721 publicBase=http://127.0.0.1:9731`, `tablePrefix=hc-local-7-`, `accessKeyId=hclane7`.
- Result, quoted from `.superpowers/gates/e2e-one-to-one.log` (Playwright's U+203A
  separators are written here as `>` to keep this file ASCII):
  - `ok 1 [chromium] > tests\dashboard-next\one-to-one-30003-retry.spec.ts:147:1 > a one-to-one 30003 promises its retry with the failure and hides Retry, then the retry replaces the failed bubble (15.2s)`
  - `1 passed (29.1s)`
  - `EXIT=0`
- The app's own lines in that log agree with every assert:
  - WARN `twilio delivery failed (undelivered/failed)`, errorCode 30003 (the per-callback marker, unchanged);
  - INFO `one-to-one 30003 retry scheduled`, attempt 1, `runAt` 2026-09-26T05:28:00.342Z (10 s after the failure);
  - the spec's Retry press: `POST /conversations/conv-0001/messages/<sid>/retry`, statusCode 409, 0.43 s after the stamp;
  - `retrySend: message re-sent`, attempt 1, 10.03 s after scheduling;
  - the control: level-50 `twilio delivery failed`, errorCode 30007 (never retried).
- The `[WebServer] Error: connect ECONNREFUSED 127.0.0.1:9701` lines at log :106
  and :113 are Vite's proxy failing `/__dev/ping` while the app was still booting
  (`[vite] http proxy error: /__dev/ping`), before readiness. Boot noise, not a failure.
- No `[dynamoAdmin]` line in the log.
- Port-free check after the run (the plan's Task 21 Step 5 node probe over
  `e2e/.artifacts/lane.json`): `free app 9701`, `free dashboard 9711`,
  `free fake 9721`, `free publicBase 9731`. netstat: 0 LISTENING lines on
  9701/9711/9721/9731. The recorded launcher pid 64020 was dead (ESRCH).

### Step 5 - with the two specs it must not break

- The run left its stale routing record (`lane.json`, `session.pid`) behind after
  the ports were proven free, so `npm run e2e:stop` ran first: `no running session found; retained state is stale or absent - nothing to stop`, EXIT=0, and both
  files were gone afterwards. Step 5 therefore booted its OWN fresh lane too (it
  did not reuse anything).
- Command (same background + poll form):
  `timeout 1200 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/one-to-one-30003-retry.spec.ts tests/dashboard-next/relay-30003-retry.spec.ts tests/dashboard-next/share-skip-fix.spec.ts > .superpowers/gates/e2e-neighbours.log 2>&1; echo "EXIT=$?" >> .superpowers/gates/e2e-neighbours.log`
- LANE 7 again (same four ports), freshly booted.
- Result, quoted from `.superpowers/gates/e2e-neighbours.log` (`>` for U+203A):
  - `ok 1 [chromium] > tests\dashboard-next\one-to-one-30003-retry.spec.ts:147:1 > a one-to-one 30003 promises its retry with the failure and hides Retry, then the retry replaces the failed bubble (14.1s)`
  - `ok 2 [chromium] > tests\dashboard-next\relay-30003-retry.spec.ts:131:1 > a failed relay leg retries to delivered without duplicating: chip, accessible name, row and send counts (18.6s)`
  - `ok 3 [chromium] > tests\dashboard-next\share-skip-fix.spec.ts:156:3 > share-skip-fix - one-to-one shares > a share to a switched-off conversation: address + link default, the text lands, the next share flags him and keeps him checked (5.9s)`
  - `ok 4 [chromium] > tests\dashboard-next\share-skip-fix.spec.ts:215:3 > share-skip-fix - one-to-one shares > a share whose only recipient was SKIPPED reads Not sent and says why; after consent is recorded they are NOT "Already sent" (3.5s)`
  - `ok 5 [chromium] > tests\dashboard-next\share-skip-fix.spec.ts:250:3 > share-skip-fix - one-to-one shares > a recipient whose text FAILED, in a share that still finalized sent, stays "Already sent" (the interim rule, pinned) (5.0s)`
  - `5 passed (59.8s)`
  - `EXIT=0`
- The plan's expectation was exactly `5 passed` (1 + 1 + 3). The one-to-one test's
  app lines repeat Step 4's shape: scheduled, 409 on the retry POST 0.38 s later,
  re-sent 10.03 s after scheduling. The log's only other 409 is share-skip-fix's
  own `DELETE /broadcasts/<id>` (its test passed). No `[dynamoAdmin]` line.
- Port-free check after the run: `free app 9701`, `free dashboard 9711`,
  `free fake 9721`, `free publicBase 9731`; netstat 0 LISTENING lines on the four
  ports; launcher pid 65400 dead (ESRCH). `npm run e2e:stop` then cleared the stale
  record again (`nothing to stop`, EXIT=0), so the worktree is left with no lane
  state for Task 21.

### Step 6 - commit

`git status` before the add showed only the new spec, untracked; no MERGE_HEAD
(`git rev-parse --git-path MERGE_HEAD` absent). Committed as `693dd7ec`.

## Task 20

Every date this task added is `2026-09-26` (`date +%F` on the day it ran), in every
frontmatter `updated:` / `resolved:` value and every bold date - the plan's
`2026-09-25` was the day the plan was written, as its Dates note allows.

- Step 1, `docs/issues/group-text-30003-leg-retry-promise-unverified.md`: `status: resolved`,
  `updated: 2026-09-26`, new `resolved: 2026-09-26`, refs gain
  `app/src/services/oneToOneRetryDecision.ts` and the spec path; the plan's
  Resolution paragraph inserted above **Problem**. Its claims were re-checked in the
  tree: `ERROR_CODE_REASONS['30003'] = 'Phone unreachable'` (`deliveryStatus.ts:782`),
  the decision's `group_text` decline at WARN (`oneToOneRetryDecision.ts:86-87`),
  `GroupTextSendNotSupportedError` (`sendMessage.ts:183`, thrown at `:347`), and the
  inverted tests (`deliveryStatus.test.ts:421`, `:743`;
  `Timeline.delivery.test.tsx:511`).
- Step 2, `docs/issues/quiet-hours-ungated-automated-paths.md`: `updated: 2026-09-26`,
  refs gain `app/src/lib/retrySendWindow.ts`; the dated item-3 annotation inserted
  after the relay paragraph. Checked: `RETRY_SEND_WINDOW_MS = 15 * 60_000`,
  `RETRY_JOB_GRACE_MS = 60_000` (the minute of grace), and `retrySend.ts:316`
  `automated: original.automated ?? true`.
- Step 3, `docs/issues/ai-mode-switch-gates-all-automation.md`: `updated: 2026-09-26`
  added under `created:`, refs gain `app/src/jobs/retrySend.ts` and
  `app/src/services/oneToOneRetryDecision.ts`; the "Delivered for the one-to-one
  30003 retry" paragraph appended to item 3. Status stays `deferred` (the plan
  changes no status here).
- Step 4, `docs/issues/relay-retry-stranded-claim-window.md` untouched (F4 form):
  `git diff --stat main...HEAD -- docs/issues/relay-retry-stranded-claim-window.md`
  -> empty, and `git status --short -- docs/issues/relay-retry-stranded-claim-window.md`
  -> empty.
- Step 5, `docs/issues/manual-retry-double-send-residual-windows.md`: `updated: 2026-09-26`
  added; refs become paths (the plan's list; every path exists); gap 2 gains "once
  the promise has expired" and the 409 `retry_pending` qualifier; **Suggested fix**
  names `feat/send-outcome-reconcile` "(revision 6, @`b93ab376`)" (F2). Checked
  from git objects only (the other worktree was not touched): `b93ab376` is that
  branch's HEAD, its spec header reads "Revision 6", and revision 6 still has the
  per-recipient send-attempt record claimed before every provider call and the
  `retrySend` record "keyed on the original message and the rung" (its Stage 1b),
  so the rest of the Suggested-fix sentence stays true.
- Step 6, `e2e/support/selectors.md`, all five edits by exact unique-substring
  match: (a) row 48 no longer says the reveal discloses the Retry action; (b) row 49
  gains the claim-time "AT ONCE" sentence and the `retry_window_closed` /
  `Not retried - message too old` sentences; (c) "capped, refused or
  window-declined ladder"; (d) the native group text promises nothing (D11) and
  `will retry` appears only on a one-to-one bubble; (e) a new row, `Thread
  (one-to-one bubble) | failure chip, retry promise, Retry action`, between row 49
  and `Contact (AI extraction) | AI provenance badge`. A word diff showed exactly
  those changes. Checked: the 409 copy (`Timeline.tsx:134-135`), `.retry` has no
  display rule in `Timeline.module.css` (only :349, :362 hover, :367 focus), and
  `retry_window_closed: 'Not retried - message too old'` (`deliveryStatus.ts:956`).
- Step 7, `e2e/tests/dashboard-next/relay-30003-retry.spec.ts`: the header comment
  (old :20-23) replaced by the plan's eight lines. Comment-only: filtering the diff
  for changed lines that are not `//` comments prints nothing.
- Step 8:
  - `npm run issues` -> `[issues] 297 open, 180 closed, 477 total -> docs/issues/INDEX.md`
    and `open by severity: 6 high . 129 med . 162 low` (the tool prints a U+2192
    arrow and U+00B7 dots, written here in ASCII); no warning line. `INDEX.md` lists
    `group-text-30003-leg-retry-promise-unverified` as `resolved` at :421, below
    `## Closed` (:308). `INDEX.md` is gitignored (`.gitignore:62`) and was not staged.
  - ASCII, whole file: group-text 0, quiet-hours 0, ai-mode 0, manual-retry 0,
    relay spec 0. `selectors.md` added lines 0 (its whole-file count is 30 before
    and after - the pre-existing non-ASCII was not touched). All six files,
    diff-scoped added lines: 0.
  - `npx eslint e2e/tests/dashboard-next/relay-30003-retry.spec.ts` -> exit 0, empty log.
  - American-spelling scan of every added line: no -ise/-our form.
- Step 9: `git status` listed exactly SIX modified files (F3) and no MERGE_HEAD.
  Committed as `3a82e690` (6 files, 82 insertions, 16 deletions).

### The carried comment fixes and R1 (commit `152d3120`)

- R1 confirm: `MessageItem` has exactly seven `relay_retry_*` fields
  (`relay_retry_of`, `_member_key`, `_attempt`, `_dest_digest`,
  `_origin_direction`, `_leg_body`, `_window_start`). `types.ts:2301-2308`
  ("Only these FOUR of the seven stored values are DECLARED ... all three arrive in
  the JSON") and `:2510-2524` at `152d3120` (`:2506-2520` before the (a) edit
  below; "The four of the seven stored lineage values this client PROJECTS ... all
  three are in the JSON") read right. No dashboard code
  reads `relay_retry_window_start` (the only hits are those two comments). No edit.
- (a) `dashboard/src/api/types.ts`, the `TimelineMessage.retry_due_at` doc. It
  now ends: "Absent when no retry was scheduled (declined or exhausted). A relay
  row never carries one; a native group-text row can (a failed read fails open,
  D3a), but no screen renders it - the contact timeline skips group_text
  conversations (app/src/routes/contactTimeline.ts), and the group view's fixed
  field list drops the field (routes/conversation/useRelayThread.ts)." Checked
  before writing it:
  - "A relay row never carries one": the stamp is written only on the status
    webhook's MESSAGE path (`updateDeliveryStatus` with `retryDueAt`, and the
    withdrawal's `annotateMessage`), which resolves a row by the callback's real
    Twilio SID (`getByProviderSid`, `twilio.ts:3326`). Relay rows carry synthetic
    SIDs - `team-<uuid>` (`api.ts:1743`, `:1835`), `system-<uuid>`
    (`relayAnnouncements.ts:228`), `relayretry-<digest>-<n>`
    (`relayRetryClaim.ts:33-35`) - or an inbound SID, so a relay leg's callback
    resolves through the relaysid pointer (`twilio.ts:3327`, `:3351-3376`) and
    returns before the decision.
  - "no screen renders it": `contactTimeline.ts:1242`
    (`if (conv.type === 'relay_group' || conv.type === 'group_text') continue;`),
    and `useRelayThread.ts`'s `toTimelineMessage` carries `retry_of` (:101, :124)
    but no `retry_due_at`.
- (b) `app/src/routes/webhooks/twilio.ts`, the 30005/30006 arm's "NATIVE GROUP TEXTS
  MAY REACH THIS ARM - UNVERIFIED (retry-send-window D11)" comment. The clause "so
  the lookup below finds no contact and the whole case degrades to a log line" now
  reads "so there is no member phone to look up: the branch below breaks before the
  lookup, and the case degrades to one log line" - the `group_text` branch
  (:3705-3713) `break`s before `contacts.findByPhone` (:3715). The rest of the
  comment is unchanged. The 21610 twin's comment makes no lookup claim and was left
  alone.
- Both edits are comment-only (filtering the diff for non-comment lines prints
  nothing). Added-line non-ASCII: 0. Whole-file non-ASCII unchanged: `types.ts`
  458 -> 458, `twilio.ts` 284 -> 284 (only ASCII lines were selected and replaced).
  `npm run typecheck` (root) exit 0, 0 `error TS` (`s5-typecheck-root-2.log`);
  `npx eslint dashboard/src/api/types.ts app/src/routes/webhooks/twilio.ts` exit 0,
  empty log. `git status` showed exactly these two files; no MERGE_HEAD.

## Worklist items - how each landed

- F1 (must-fix, Task 19 Step 1): the em-dash probe ran as
  `rg -n "Phone unreachable \x{2014}" dashboard/src` - no hit. The plan's form was
  also run once, for the record: it hits only `deliveryStatus.ts:409`.
- F2 (must-fix, Task 20 Step 5(a)): the issue says "(revision 6, @`b93ab376`)".
- F3 (Task 20 Step 9): six modified files, and `INDEX.md` regenerated by
  `npm run issues`, never staged.
- F4 (Task 20 Step 4): both F4 commands printed nothing.
- D7 residual: no issue this task edits carries accepted residuals (the plan's
  section-9 table sends every accepted residual to the handback, and the only
  issue-recorded residual, the manual double send, is a different defect - the
  jitter can only hide the Retry button a little longer, never offer it early).
  So it is recorded below under "Residuals for the handback", in the worklist's
  wording.
- R1: confirmed, no edit (above). Plus the two carried comment fixes, done as ONE
  SEPARATE commit right after Task 20 (`152d3120`), not in Task 20's commit.
- The binding constraints: the recipient was the lean seed's `conv-0001` /
  `contact-tenant-0001` (Tasha) throughout; nothing touched `conv-0002` /
  `contact-tenant-0002`. Only the two targeted e2e runs ran (no re-runs were
  needed); no `npm test`, `npm run smoke` or full e2e suite. Nothing touched
  :5174 / :8080. No dependency, seed, infra or `.env` change.

## Deviations from the plan

1. Worklist-directed (above): F1's probe string; F2's revision; F3's file count;
   F4's check commands; the D7 residual's placement (this report, since no edited
   issue carries accepted residuals).
2. Dates: `2026-09-26` everywhere the plan wrote `2026-09-25` (the plan's own
   Dates rule).
3. How the e2e runs were driven: each ran in the background with
   `; echo "EXIT=$?" >> <log>` after it, and the verdict was read from the EXIT line
   in the log (the orchestrator's instruction for runs longer than a tool call's
   ten minutes), instead of the plan's "one foreground command per call". The
   commands themselves are the plan's, verbatim.
4. Extra, beyond the plan's steps (coverage and hygiene only; no code differs):
   the root `npm run typecheck` in addition to the e2e workspace one (Task 19) and
   after the comment fixes; the pre-writing selector/field verification listed in
   Step 1; a port-free proof after BOTH runs (the plan asks for it only after an
   aborted run); `npm run e2e:stop` before Step 5 and after it, each run only
   after the four ports were proven free, to clear the dead launcher's retained
   `lane.json` / `session.pid`.
5. Commit messages: Tasks 19 and 20 each carry one extra paragraph (the runs'
   results; the worklist items applied), the slice 2-4 precedent. Every trailer
   names `Claude Opus 5.5`, this session's attribution.
6. The `retry_due_at` doc's wording differs from the orchestrator's example
   ("... but never reaches this projection"): the dashboard `TimelineMessage` type
   is ALSO what the group view builds (`useRelayThread.ts` `toTimelineMessage`), so
   a group-text row does reach a `TimelineMessage` there, just without the field.
   The comment therefore states the orchestrator's other framing exactly - no
   screen renders it - and names both reasons.
7. Nothing else. The spec is byte-identical to the plan's block; every quoted old
   text in Task 20 matched the live file exactly once; no importer, cycle,
   contract mismatch or product defect appeared.

## Residuals for the handback

- (Accepted, worklist D7, spec D8's stated error bound; no code change.) The
  dashboard's server-clock estimate can step back about a second between
  responses, so a refetch landing right after the tick that expired a promise can
  re-show 'will retry' for up to one more 60-second tick - the spec's stated error
  bound (D8).

## Observations (no change made)

- Task 21's handback template still says "revision 5 @616d120d" in its Issues
  bullet; the worklist's orchestrator item F2 already covers it (revision 6
  @b93ab376).
- `e2e/.artifacts/` holds the last run's `html-report`, `results.json` and
  `test-results` (all gitignored); no lane state remains.
