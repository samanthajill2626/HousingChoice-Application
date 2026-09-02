# Task 9 report - authenticated projection and dashboard mapping

## Outcome

Implemented the approved Task 9 projection slice without changing presentation,
delivery behavior, writers, seeds, or e2e flows.

- Contact timeline copies schema version, requested transport, actual transport,
  and recipient transport facts only when present.
- The fixed-conversation endpoint remains raw message passthrough. A regression
  test proves its persisted transport fields survive unchanged; `api.ts` needed no
  production edit.
- Dashboard wire types mirror `sms | mms | rcs` locally and add the three optional
  message facts plus the three optional recipient facts.
- Contact fallback and relay/native-group thread mapping preserve all transport
  facts. Newest-page, older-page, and SSE merges retain the mapped objects.
- Contact, relay, and native-group optimistic carrier rows carry only
  `optimistic: true`; resolve retains the marker until a server refetch replaces
  the row with provider-backed transport facts.
- Email and call projection behavior is unchanged.

## TDD evidence

RED:

- App focused run exited 1: `contactTimeline.test.ts` failed because the contact
  projection omitted all three message-level transport fields. The raw
  conversation test already passed, proving raw passthrough.
- Dashboard focused run exited 1 with three expected failures: the local transport
  tuple was absent, contact fallback dropped transport facts, and relay mapping
  dropped transport facts.

GREEN on the final tree:

- `npm run test -w @housingchoice/app -- test/contactTimeline.test.ts test/conversationHubApi.test.ts`
  - exit 0; 2 files, 71 tests passed.
- `npm run test -w @housingchoice/dashboard -- src/api/types.test.ts src/routes/contact/buildTimelineFallback.test.ts src/routes/contact/useContactTimeline.test.tsx src/routes/conversation/useRelayThread.test.tsx src/routes/conversation/useGroupThread.test.tsx`
  - exit 0; 5 files, 86 tests passed, no stderr warnings.
- `npm run typecheck -w @housingchoice/app`
  - exit 0.
- `npm run typecheck -w @housingchoice/dashboard`
  - exit 0.
- `git diff --check`
  - exit 0.

No broad gates or e2e were run, per the Task 9 brief.

## Files

Production:

- `app/src/routes/contactTimeline.ts`
- `dashboard/src/api/types.ts`
- `dashboard/src/routes/contact/buildTimelineFallback.ts`
- `dashboard/src/routes/contact/useContactTimeline.ts`
- `dashboard/src/routes/conversation/useRelayThread.ts`
- `dashboard/src/routes/conversation/useGroupThread.ts`

Tests:

- `app/test/contactTimeline.test.ts`
- `app/test/conversationHubApi.test.ts`
- `dashboard/src/api/types.test.ts`
- `dashboard/src/routes/contact/buildTimelineFallback.test.ts`
- `dashboard/src/routes/contact/useContactTimeline.test.tsx`
- `dashboard/src/routes/conversation/useRelayThread.test.tsx`
- `dashboard/src/routes/conversation/useGroupThread.test.tsx`

## Commit

`6c176c33 feat: project message transport to the dashboard`
