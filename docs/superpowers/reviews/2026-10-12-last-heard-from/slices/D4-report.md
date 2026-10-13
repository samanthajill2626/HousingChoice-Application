# D4 - S3 Tasks 3.1-3.5: decisions record

Dispatch D4 of the feat/last-heard-from build (implementer, 2026-10-13).
Scope: the app-side outcome core - the pure outcome rules, tour activity,
the stored decline, the widened recipient projection and the outcome event
writer. Plan: `docs/superpowers/plans/2026-10-12-last-heard-from.md` (S3
Tasks 3.1-3.5). Binding corrections applied: F4 and F5 (3.3), F7 (3.4).
Tasks 3.6-3.8 are the next dispatch (D5).

## Commits

- 06b62220 Task 3.1 - `app/src/lib/listingSendOutcome.ts` (new) and
  `app/test/listingSendOutcome.test.ts` (new).
- 68548fc5 Task 3.2 - `deriveTourActivityAt`
  (`app/src/lib/listingSendTour.ts:106`).
- aa8975c0 Task 3.3 - `declined` + `setDeclined` / `clearDeclined`
  (`app/src/repos/listingSendsRepo.ts:109`, `:177`, `:320`, `:350`) and the
  harness fake (`app/test/helpers/twilioWebhookHarness.ts:3469`).
- cc7ffb1f Task 3.4 - the widened recipient projection and
  `requireComplete` (`app/src/repos/contactsRepo.ts:370`, `:739`, `:1043`,
  `:1314`; harness `projectRecipient` at
  `app/test/helpers/twilioWebhookHarness.ts:2227`).
- adf68954 Task 3.5 - `app/src/lib/listingOutcomeEvents.ts` (new), the
  three `ActivityEventType` members (`app/src/repos/activityEventsRepo.ts:64`,
  dashboard mirror `dashboard/src/api/types.ts:2744`) and the two
  unit-activity doc comments (`app/src/routes/units.ts:217`,
  `dashboard/src/api/types.ts:3137`).

## RED / GREEN evidence

| task | RED (reason seen) | GREEN |
|---|---|---|
| 3.1 | module not found (file did not exist) | listingSendOutcome 38/38 |
| 3.2 | 8 cases: deriveTourActivityAt is not a function (not exported); the (PIN) wire-chip case green | listingSendTour 25/25 |
| 3.3 | 7 cases: repo.setDeclined is not a function (6 repo + 1 parity) | listingSendsRepo.integration 12/12, twilioWebhookHarnessRepoAdditions.integration 24/24 |
| 3.4 | 6 cases: 4 parity toEqual mismatches (fake + DynamoDB Local; no status / reachability projected), requireComplete ignored (promise resolved), projection lacks `#status` | caseworkerRepoParity.integration + contactsBatchIncomplete 55/55 |
| 3.5 | module not found | listingOutcomeEvents 4/4 (+ tourEvents 6/6) |

Neighbour suites re-run green: listingSendsRepoShares.integration,
shareLedger, listingSendsApi, contactsBatchReads, audienceResolution,
contactCapture, scheduledSendSuppression, sendMessage. Root
`npm run typecheck` exit 0 after every commit. eslint on all touched files:
exit 0.

## Decisions and divergences

1. F4: `app/src/repos/listingSendsRepo.ts:49` imports ONLY `DeclineRecord`.
   `InterestedMode` and `ListingSendOutcome` are imported by 3.6 when
   `toListingSendRow` first uses them, so no commit carries an unused import.
2. F5: the NO-RESET header (`app/src/repos/listingSendsRepo.ts:14-25`) is the
   plan's replacement text plus one sentence naming the accepted dev-only
   exception: the seed runner's full PutCommand (seedAll's Put loop in
   `app/src/lib/seed/index.ts`) rewrites the seeded rows from `seed/cast.ts`
   and `seed/matrix.ts`, so a NON-wiping re-seed drops `declined` on those
   pairs. It also notes `/__dev/reseed` clears the tables first (verified:
   `resetLocalData` in `app/src/lib/devReset.ts` logs "cleared + reseeded").
3. F7: the fourth throwing `ContactsRepo` fake
   (`app/test/audienceResolution.test.ts`) needed no edit - typecheck exit 0
   and the suite green confirm an optional second parameter is
   assignment-compatible. The harness fake keeps its one-parameter
   `getRecipientDisplaysByIds` and ignores `requireComplete` (plan; tests
   inject an incomplete read by reassigning the method).
4. Comment citations: the `deriveTourActivityAt` doc
   (`app/src/lib/listingSendTour.ts:90-105`) and the event writer header
   (`app/src/lib/listingOutcomeEvents.ts:1-14`) cite files without the plan's
   line numbers, which rot as the tree moves; the cited text was checked
   present. Code is the plan's verbatim.
5. `deriveTourSignal` and its result (the wire `tour`) are untouched; the
   (PIN) case in `app/test/listingSendTour.test.ts` holds its key set.
6. `routes/contactTimeline.ts` LANDLORD_FEED_TYPES is NOT extended: the three
   outcome events stay off a landlord's page (no landlord copy, spec 14.3).
7. The knowing rewrite in 3.4: the existing parity case
   (`app/test/caseworkerRepoParity.integration.test.ts:377`) gains
   `status` on both `toEqual`s and the plan's new title; the new parity case
   is at `:418`; the (PIN) `getDisplaysByIds` narrower-projection case is
   unchanged and green.

## Contracts shipped (consumed by D5 and later)

- `listingSendOutcome.ts`: `ListingSendOutcome`, `InterestedMode`,
  `FOLLOW_UP_QUIET_MS`, `FOLLOW_UP_LOOKBACK_MS`, `DeclineRecord`,
  `effectiveDecline`, `deriveListingSendOutcome`, `wireDecline`,
  `isEligibleRecipient`, `interestedModeFor`, `isWaiting`, `waitingSince` -
  the plan section 3.1 signatures, plus `wireDecline` (plan W2 ADDITIONS).
- `deriveTourActivityAt(tours)` returns the stored string of the latest
  parseable qualifying instant.
- `ListingSendsRepo.setDeclined` / `clearDeclined` -> `'ok' | 'not_found'`
  (the last two interface members); `ListingSendItem.declined?`.
- `getRecipientDisplaysByIds(ids, opts?: { requireComplete?: boolean })`;
  `RecipientDisplay` gains `status`, `last_heard_from_at`, `sms_opt_out`,
  `sms_unreachable`.
- `recordListingOutcomeEvent(deps: { activityEvents, audit, logger }, input)`
  - the deps key is `logger` (TourEventDeps uses `log`); failure lines are
  `<type> contact timeline record failed (best-effort)` and
  `<type> unit audit failed (best-effort)`. The writer is unconditional; the
  route (3.7) decides whether a clear writes `listing_decline_cleared`
  (only when the row carried `declined` before the call, plan 3.4 #2).
