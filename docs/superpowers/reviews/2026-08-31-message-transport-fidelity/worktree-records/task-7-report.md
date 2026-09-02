# Task 7 report - authoritative native Group MMS propagation

## Commit

- `d5a4657de53a871c56d9fd7b3454f6283c55c71f` - `feat: record native group MMS transport`

## Shipped

- Native group sends now use the group adapter's classify, prepare, and execute
  contract. The persisted source row stores schema version 1 plus the adapter's
  requested and actual transport while retaining legacy `type: 'sms'` for
  existing content behavior.
- Every nonsuppressed recipient slot stores the adapter request/result with
  `attempted`; a known-suppressed slot stores requested transport with
  `excluded` and no actual transport.
- Group receipts propagate only the source row's adapter-authoritative actual
  transport to a recipient slot. A channel SID can corroborate or produce a
  safe conflict warning through the Twilio adapter normalizer, but it cannot
  originate or overwrite transport.
- Receipt delivery status, channel SID, and actual transport remain independent.
  The existing SSE event fires once when status or actual transport changes and
  does not fire when both are no-ops.
- Provisioning, author verification and repair, participant snapshot matching,
  suppression, delivery rollup, audit, sender attribution, due-row persistence,
  and media refusal behavior remain unchanged.

## TDD and verification

Initial sandboxed focused run:

`npm run test -w @housingchoice/app -- test/groupSend.test.ts test/groupReceipts.test.ts test/groupConversationsWebhook.test.ts test/groupSendRepo.integration.test.ts`

- Exit 1 before test execution on the documented Vite `.vite-temp` EPERM.
- Rerun with worktree write permission; this environmental startup failure is
  reported separately from the product red proof.

Focused red proof:

- Exit 1.
- 4 files ran; 2 failed and 2 passed.
- 7 tests failed and 115 passed.
- Failures named missing source/slot transport persistence, missing transport-
  only receipt mutation/SSE, and missing safe receipt conflict warning.

Review-discovered SID independence regression:

- Targeted receipt test exited 1 with 1 failing and 45 skipped because an
  actual-only update returned before the established sid-if-absent write.
- After moving the SID write ahead of the single SSE return, the same targeted
  test exited 0 with 1 passing and 45 skipped.

Final focused command:

- Exit 0.
- 4 files passed; 122 tests passed and 0 failed.

Final app typecheck:

`npm run typecheck -w @housingchoice/app`

- Exit 0 after `tsconfig.json`, `tsconfig.scripts.json`, and
  `tsconfig.test.json` completed.

Focused ESLint:

`npx eslint app/src/services/groupSend.ts app/src/services/groupReceipts.ts app/test/groupSend.test.ts app/test/groupReceipts.test.ts app/test/groupSendRepo.integration.test.ts`

- Exit 0.

Hygiene:

- `git diff --check`: exit 0.
- Added-line ASCII check: clean.
- `MERGE_HEAD`: absent before commit.

## Files changed

- `app/src/services/groupSend.ts`
- `app/src/services/groupReceipts.ts`
- `app/test/groupSend.test.ts`
- `app/test/groupReceipts.test.ts`
- `app/test/groupSendRepo.integration.test.ts`

## Scope and drift

- `app/src/routes/webhooks/twilio.ts` required no Task 7 edit: Task 4 already
  stamps native inbound rows with schema version 1 and adapter-owned actual MMS,
  with no requested transport. The required focused webhook suite remained
  green.
- `app/test/groupConversationsWebhook.test.ts` required no edit; its exact
  payload assertion already pins verbatim `ChannelMessageSid` forwarding into
  the receipt service without route-level transport inference.
- No projection, dashboard, non-live, import, seed, dev-fixture, dependency, or
  infrastructure work was included.
- No unexpected importer, cycle, contract mismatch, or unresolved concern was
  found.
