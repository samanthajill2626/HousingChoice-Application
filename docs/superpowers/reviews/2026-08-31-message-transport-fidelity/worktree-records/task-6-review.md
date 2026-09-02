# Task 6 independent review - persisted relay announcements

**Reviewed commit:** `e26226b3` (`db9f1219..e26226b3`)

**Scope:** `relayAnnouncements.ts`, its Task 6 tests, all live
`sendRelayAnnouncement` callers, their injected adapter/fake shapes, and the
Task 2/3/5 message/transport contracts. This was a read-only review; no source
or test changes were made.

## Result: CONFORMS / PASS

No confirmed correctness, compatibility, race, or log-hygiene defect found.

## Contract evidence

- The source append writes schema `1` and its adapter-owned requested transport
  at `app/src/services/relayAnnouncements.ts:193-220`; every seeded recipient
  slot has `status: 'queued'`, the same requested value, and `planned` state at
  `:198-205`. The source deliberately has no synthetic actual transport.
- Suppression transitions a persisted slot to `excluded` before the result
  write and before any provider work (`:247-269`). The result preserves the
  existing failed/contact-opted-out outcome and contributes no actual transport.
- A provider-bound persisted leg is prepared with the already-classified intent,
  then changed to `attempted` immediately before `sendPreparedMessage`
  (`:275-296`). The non-persisted replay still takes the original `sendMessage`
  path and has no transport persistence branch (`:293-316`).
- Result writes use Task 3's child-field, first-writer-safe
  `applyRecipientSendResult` contract (`:318-334`, `:382-397`), rather than
  replacing a whole recipient slot. The repository keeps the first SID/sentAt,
  protects actual-transport precedence, preserves concurrent fields, and retries
  conditional races (`app/src/repos/messagesRepo.ts:3209-3348`). The duplicate
  member regression test exercises that exact shape at
  `app/test/relayAnnouncements.test.ts:194-249`.
- The `planned -> attempted/excluded` transitions use Task 5's guarded
  aggregation mutator (`app/src/services/relayAnnouncements.ts:365-380`; repo
  contract at `app/src/repos/messagesRepo.ts:3068-3137`). Consequently existing
  aggregate projections can evaluate slots without a special announcement state
  machine.
- `logSafeMemberKey` remains the correct boundary for contact-less roster
  members: the service logs it at each new member-key site
  (`app/src/services/relayAnnouncements.ts:265-267,311-313,345-353`) instead of
  the `phone#<E164>` storage key. The focused suppression test proves neither
  raw number nor fallback storage key reaches captured logs
  (`app/test/relayAnnouncements.test.ts:113-169`).

## Caller/fake sweep

- The two job callers (`app/src/jobs/relayFanOut.ts:463-478,509-519`), tour
  reminder handoff (`app/src/jobs/tourReminders.ts:1261-1286`), and close route
  (`app/src/routes/relayGroups.ts:601-609`) all provide the shared adapter made
  by `createMessagingAdapter`, which implements `CarrierMessageSender`.
- The changed public injection points correctly demand the expanded surface:
  `RunDueTourRemindersDeps` at `app/src/jobs/tourReminders.ts:536`,
  `RelayGroupsRouterDeps` at `app/src/routes/relayGroups.ts:120`, and
  `TourRemindersRouterDeps` at `app/src/routes/tourReminders.ts:130`. The test
  fakes were updated to `MessagingAdapter & CarrierMessageSender`, including the
  harness and tour-reminder spy, so no legacy fake can silently take a runtime
  path without prepare/sendPrepared.
- `persist: false` is only a legs-only replay seam and remains intentionally
  schema-absent: no append, classification, preparation, aggregation mutation,
  or result mutation (`app/test/relayAnnouncements.test.ts:251-275`). It still
  writes system-SID markers after actual sends, as before.

## Verification

- `npm run test -w @housingchoice/app -- test/relayAnnouncements.test.ts`
  (focused): **exit 0**, 1 file / 16 tests passed.
- `npm run typecheck -w @housingchoice/app`: **exit 0**.

The first sandboxed focused-test attempt could not create Vite's transient
`app/node_modules/.vite-temp` file (`EPERM`); the permitted worktree run above
completed normally. No aggregate suite or E2E run was performed.

## Review disposition

**CONFORMS / PASS.**
