# Task 3 persistence slice report

## Shipped contract

Task 3 adds versioned message and recipient transport persistence with narrow,
conditional DynamoDB mutations. The repository exposes message/recipient actual
transport writes, aggregation-state transitions, no-overwrite recipient
initialization, and a composite recipient send-result patch that preserves
independent status, SID, timestamp, error, and transport evidence.

Legacy schema rows return quiet `legacy_noop`; missing messages/slots remain
distinct. Existing caller paths are intentionally unchanged for later slices.

## Commits

- `52a924d7 feat: persist versioned message transport facts`
- `5296694a fix: preserve concurrent transport evidence`
- `8bbb0f8f fix: clear queued transport retry errors`

## Focused proof

The initial implementation demonstrated red 19/19 then focused green 19/19.
Fix wave 1 demonstrated three intended red failures then focused green 22/22.
The queued-success correction demonstrated red `1 failed | 22 passed` and focused
green 23/23. Each focused run used
`npm run test -w @housingchoice/app -- test/messagesRepo.transport.test.ts`.
App workspace typecheck exited 0 after every committed implementation/fix wave.
Initial sandbox executions that could not create Vite's `.vite-temp` config were
pre-execution EPERM environment failures; allowed-environment reruns supplied the
red/green evidence.

## Review and resolutions

- Independent first review identified terminal diagnostic loss, missing final
  conditional-race reclassification, and silent expected stale-RCS callbacks.
  All accepted and fixed in `5296694a`.
- Fresh cold re-review found that a same-status queued successful Twilio accepted
  callback retained a transient error. Accepted and fixed in `8bbb0f8f`.
- Final cold re-review reported a duplicate delivered callback clearing an existing
  error. Rejected: delivered is a successful result and the approved contract
  requires successful same-status cleanup; only failed/undelivered diagnostics
  are terminal delivery error data. The record is in
  `task-3-fixwave-2-rereview-adjudications.md`.

No scope deviation remains. The two full-interface test fakes received only the
additive stubs typecheck required, and the shared webhook fake now shares the
repository success-classification helper.
