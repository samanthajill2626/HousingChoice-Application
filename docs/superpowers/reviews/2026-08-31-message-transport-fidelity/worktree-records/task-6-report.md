# Task 6 report: persisted Relay announcement transport

## Commit

- `e26226b350e8d5613fa07cb2359df4c27b922ecb` - `feat: track transport on relay announcements`

## Shipped contract

- Persisted announcements classify SMS intent once before append and store schema
  version 1 plus requested SMS on the source and every queued recipient slot.
- Slots begin `planned`. Suppressed recipients transition to `excluded` before
  provider handling and retain the existing `failed` / `contact_opted_out` result
  without actual transport.
- Provider-bound recipients transition to `attempted` immediately before the
  prepared send. Results use `applyRecipientSendResult`, record first SID and
  timestamp plus normalized actual transport, clear transient queued errors, and
  preserve concurrent child fields on duplicate execution.
- The source has no fabricated actual transport; its attempted/excluded recipient
  slots are compatible with the normal aggregate contract.
- `persist: false` remains on `adapter.sendMessage`, creates no message or transport
  aggregation state, and keeps the existing system-SID marker behavior.
- Contact-less logging continues through `logSafeMemberKey`; the focused test proves
  no raw phone or `phone#<E164>` key reaches captured logs.

## TDD proof

- Initial sandboxed focused run exited 1 before discovery with the documented Vite
  `.vite-temp` EPERM. The allowed-environment rerun supplied the product red proof.
- RED: `npm run test -w @housingchoice/app -- test/relayAnnouncements.test.ts`
  exited 1 with 4 expected transport-contract failures and 12 passes.
- GREEN: the same focused command exited 0 with 1 file and 16/16 tests passed.
- Final app typecheck: `npm run typecheck -w @housingchoice/app` exited 0 after all
  three TypeScript projects completed.
- `git diff --check` exited 0 and the added-lines ASCII check passed before commit.

## Files and scope

- `app/src/services/relayAnnouncements.ts`
- `app/test/relayAnnouncements.test.ts`
- `app/src/jobs/tourReminders.ts`
- `app/src/routes/relayGroups.ts`
- `app/src/routes/tourReminders.ts`
- `app/test/tourReminders.test.ts`

The last four paths are the minimal typecheck-required announcement caller/fake
carrier contract updates. Widening `RelayAnnouncementDeps.adapter` to the Task 2
`MessagingAdapter & CarrierMessageSender` contract first exposed the two direct
production callers, the tour-reminder router that constructs the reminder deps,
and the one group-announcement adapter spy. The production edits are type-only; the
test fake adds the same classify/prepare/prepared-send behavior as the shared fake.
No Relay fan-out, direct/webhook, Group MMS, seed, projection, or UI behavior was
changed.

No unexpected importer, cycle, or approved-contract conflict was found.
