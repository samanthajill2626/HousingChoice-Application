# S3 slice report - flyer-leads (Tasks 3.1-3.5 and worklist OR-11..OR-13)

Branch feat/flyer-leads. Commits, oldest first: da4c9ade (Task 3.1, with
OR-11's ledgerEntryCounts doc), e09d3e66 (Task 3.2, with OR-11's harness
comment), d9fd6455 (Task 3.3), 1a046615 (Task 3.4, with OR-12), 2c3bb0e7
(Task 3.5). They sit directly on S2's report commit 2ba316d4. Findings only;
code cited by `file:line` at 2c3bb0e7.

## Contract deviations

None. Every plan 2.1-2.4 name, signature and plan 1.1 log string is as
written:
- app/src/lib/shareLedgerKeys.ts:14 `INDIVIDUAL_SHARE_KEY`, :17
  `FLYER_SHARE_KEY`, :25 `flyerAttemptKey`, :37 `latestCountedShareKey`
  (greatest string countedAt among `counted` entries, strict `>` over
  Object.entries, keys never sorted).
- app/src/services/shareLedger.ts:
  - :125 `summarize` picks its entry with latestCountedShareKey and maps
    both `individual` and `flyer` to no broadcastId;
  - :239 `FlyerShareResult`; :258 `applyFlyerShareEntry(deps, { unitId,
    contactId, signedUpAt })`; its veto `effectiveDecline(row ?? {},
    undefined)` (:267) runs on each round's consistent read inside the
    private loop (:195, AR7's names `veto` / `lostIds`), flyer key only;
  - :222 `applyShareLedgerEntry` keeps its signature, its results and its
    ERROR line; the fields stay `{ unitId, contactId, broadcastId, attempt,
    state }` in that order (`lostIds` :231). No line carries
    `broadcastId: 'flyer'`; the flyer ERROR carries `shareKey` (:270);
  - the INFO line (:274) and the flyer ERROR line are plan 1.1's strings;
    `ledgerWouldChange` and `putShareMemory` are unchanged.
- app/src/repos/listingSendsRepo.ts:388 and :423: setDeclined /
  clearDeclined add `#op = :op` (a fresh randomUUID, :401, :435) and
  nothing else; conditions and return values are unchanged.
- app/src/lib/listingSendOutcome.ts:22 the union adds `signed_up`; :88 is
  the last rung (decline > tour > replied > signed_up / no_reply);
  `isWaiting` keeps its rule.
- The helper S4 calls next is `seedFlyerSignUp(repo, { unitId, contactId,
  signedUpAt })` in app/test/helpers/listingSendSeed.ts, as plan 7 E names
  it (throws unless 'written').

## Plan corrections

- `npm run db:start` (plan 7 C, Task 3.2 Step 2, exit check step 1) was
  NOT run: the rules file says DynamoDB Local is running and db:start can
  prune or recreate it. Every DynamoDB suite ran for real - no
  `SKIPPED - no DynamoDB Local` line in any RED, GREEN or exit run.
- Task 3.3 Step 2 expects every shareLedgerFlyer case to fail RED; 9 of 10
  did. The '(PIN) the refusal is flyer-only' case
  (app/test/shareLedgerFlyer.test.ts:113) calls only applyShareLedgerEntry
  and setDeclined, so it was green before the implementation, as a PIN
  should be. RED total: 11 failed / 89 passed, each failure
  `applyFlyerShareEntry is not a function`.
- OR-12 is in Task 3.4's commit (app/test/followUps.test.ts:356, inside the
  new D8 describe). It needs imports the plan's step 1d does not list:
  `seedFlyerSignUp`, and `createFakeWorld` (the harness fake stores the row
  the real service writes; the builder's array world then reads it).
  `latestCountedShareKey` was added to the plan's shareLedgerKeys import
  line. The PIN was green at RED: replied outranks signed_up before and
  after.
- OR-11: the ledgerEntryCounts doc (app/src/services/shareLedger.ts:97-102)
  is in Task 3.1's commit; the harness putShareMemory comment
  (app/test/helpers/twilioWebhookHarness.ts:3612-3615) is in Task 3.2's
  commit. Both commit bodies name OR-11.
- OR-1: the five blocks it names were used at the target indent. One block
  it does not name is also at the target indent though nested under a
  bullet: Task 3.2 step 1b's array-end anchor and replacement (6/4/2/0
  spaces, `];` at column 0); used as written. Inline anchors with escaped
  backticks (Task 3.2 3a, Task 3.3 3b) were stripped. Every quoted anchor
  matched exactly once; no anchor, count or compile fix was needed.
- Counts, each RED for the stated reason:

  | Task | RED | GREEN |
  |---|---|---|
  | 3.1 | keys leaf unresolvable; shareLedger 1 failed / 16 passed | 5 files, 56 tests |
  | 3.2 | 3 failed / 38 passed | 6 files, 134 tests |
  | 3.3 | 11 failed / 89 passed | 8 files, 328 tests |
  | 3.4 | 7 failed / 307 passed | 8 files, 403 tests |
  | 3.5 | 4 failed / 25 passed | 4 files, 89 tests |

- Exit check:
  - the 21 slice files: 736 tests, EXIT:0;
  - `npm run typecheck` (all workspaces): EXIT:0 after every task and at
    the exit;
  - eslint on the 20 S3 code files (exactly `git diff --name-only
    --diff-filter=d 2ba316d4..HEAD` filtered to code, which is plan 7's
    list): exit 0, no output;
  - the FULL app suite (AR15, OR-4; background, `timeout 1500`, log
    `.superpowers/sdd/S3-app-suite.log`): `Test Files 524 passed (524)`,
    `Tests 10952 passed | 1 skipped (10953)`, `EXIT:0`, 50 s. No
    `[dynamoAdmin]` line, no `SKIPPED` line, no failure. The one skip is
    the pre-existing diagnostic 'built dashboard identity tags (PASS or
    SKIP, never FAIL)' (no built dashboard). `env | grep '^AWS_'` printed
    nothing.

## Risks and residuals

- OR-13, the broadcasts.ts caller: its case
  (app/test/broadcastApi.test.ts:3510) is the D5-default PIN, green before
  and after Task 3.4. It cannot observe `signed_up`, because
  app/src/routes/broadcasts.ts:619 reads only `=== 'not_interested'`. Four
  callers carry a real `signed_up` wire pin:
  - app/src/routes/contacts.ts:1324, app/src/routes/units.ts:259 (missing
    recipient) and :279 (resolved) - app/test/listingSendsApi.test.ts:591;
  - the outcome route's re-projection through units.ts:279 -
    app/test/listingSendOutcomeApi.test.ts:711;
  - app/src/services/followUps.ts:168 - app/test/followUps.test.ts:335.
- OR-13 residual (i), the decline-click vs in-flight flyer write window. O1
  closes the decline-then-flyer race only. The outcome route takes its
  decline instant BEFORE its write (app/src/routes/units.ts:1596
  `const at = new Date().toISOString();`, setDeclined at :1690). A flyer
  write landing inside that window with `signedUpAt > at` moves sentAt past
  `at`. The new decline is then superseded at birth
  (app/src/lib/listingSendOutcome.ts:57) and the route's own re-projection
  (units.ts:1762) answers `signed_up`: a public request undoing a staff
  click, which D7 says never happens. Staff see it, and a second click (a
  later `at`) sticks. Clock skew between app instances widens the window.
  For the orchestrator to adjudicate at review (fix or file an issue).
- OR-13 residual (ii), DynamoDB map-order ties. DynamoDB promises no Map key
  order, so on an EXACT countedAt tie the write-time summary (summarize,
  in-memory insertion order) and the read-time derivation (the unmarshalled
  map) can pick different keys - a wire row could carry a broadcast's
  `broadcastId` with outcome `signed_up`. It needs an exact-millisecond tie
  between the app clock and a whole-second Twilio instant: the spec's
  cosmetic class. The tie rule is pinned in memory only
  (app/test/shareLedgerKeys.test.ts, the tie case).
- AR13 reaches every nameless RESOLVED recipient on the units recipients
  read, not only an unknown sign-up: a nameless tenant row now carries its
  phone as `tenantName` (the two exact-shape pins in
  app/test/listingSendsApi.test.ts were updated as planned).
  dashboard/src/routes/listing/ListingDetail.tsx:1343
  (`row.tenantName ?? row.contactId`) shows it; S3 made no dashboard change.
  S5 may mirror the wire comment (app/src/repos/listingSendsRepo.ts:137-144).
- Two nameless-contact labels now differ by surface: the Sent to card shows
  the FORMATTED phone (app/src/routes/units.ts:207 recipientLabelOf), while
  Follow up's `name` is the RAW stored phone
  (app/src/services/followUps.ts:87-91; pre-existing, pinned at
  app/test/followUps.test.ts:187-201 and again by the OR-12 PIN). Cosmetic;
  S5 and S6 should not assume one rule.
- OR-12 behavior, now pinned: after ANY later inbound a flyer pair returns
  to Follow up as `replied` once quiet, unknown contacts included - Follow
  up never listed an unknown contact before this branch (R5 F5). The
  GLOSSARY line is S6's (OR-23).
- O1 strands nothing: the decline writers' only callers are the outcome
  route (app/src/routes/units.ts:1675, :1690, :1719), which never reads the
  token, and every ledger write re-reads it. A legacy row gains a token from
  its first decline (pinned in the conformance suite's new O1 case).
- Pre-existing test-helper doc mismatch: `createLogCapture().atLevel(n)` is
  documented "at or above" (app/test/helpers/logCapture.ts:10) but filters
  `level === n` (:36). S3's lost-write case relies on the exact level
  (app/test/shareLedgerFlyer.test.ts:179, `atLevel(50)[1]`). Not changed.
- D10: no untrimmed typed-input path in S3's surfaces. S3 stores no new
  typed input; the new label reads the stored E.164 phone and the existing
  part-wise trimmed name (app/src/routes/units.ts:184-194).

## Pre-existing lint

None: eslint on the 20 S3 code files exits 0 with no output.
