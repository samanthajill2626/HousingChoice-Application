---
id: remove-dev-outbox-proof-of-send
title: Remove the deprecated /__dev/outbox proof-of-send log + RecordingMessagingDriver
type: debt
severity: low
status: resolved
area: app/dev-harness
created: 2026-06-18
updated: 2026-08-24
refs: app/src/routes/dev.ts, app/src/adapters/messaging.ts, e2e/fixtures/fakeTwilio.ts
---

**RESOLVED 2026-08-24 (branch `feat/remove-dev-outbox`).** Every consumer now
asserts against the fake-twilio thread store, and the whole outbox surface is
deleted:

- New `getOutboundTo(request, { to, since })` in `e2e/fixtures/outbox.ts`'s
  replacement home `e2e/fixtures/fakeTwilio.ts` - same ergonomics as the old
  `getOutbox` (including the `createdAt >= since` filter), wire-level source.
- Migrated: 9 spec files (relay x4, voice x2, contact-create-relay-group,
  public-pages, flows/outbox -> flows/proof-of-send), the `voiceSetup` fixture,
  the perf self-QA snapshot (`reduceSelfQaSnapshot` now takes the thread-store
  URL; the `outbox` surface key and `outboxUnchanged` report field keep their
  names), and the e2e preflight (no `recordOutbox` expectation).
- Deleted: the `/__dev/outbox` route, `RecordingMessagingDriver` + its
  `messaging.ts` wiring, `config.recordOutbox` + the `MESSAGING_RECORD_OUTBOX`
  env + its prod guard, the outbox entry in `devReset`'s clear set, and the
  `devOutbox.integration` / `recordingMessaging.integration` suites.
- `db-create.ts` keeps a legacy-cleanup drop of the literal `dev-outbox` table
  so stacks that predate the removal still tear down completely.

Original issue text below, kept for history.

**SCOPE CORRECTION (2026-08-23): "three specs" is badly stale - reliance has
roughly QUINTUPLED since filing, despite the do-not-extend marker.** Measured by
grep, not memory. Current consumers of `/__dev/outbox` / `getOutbox`:

- 14 e2e spec files: 11 under dashboard-next (relay x4, voice x2,
  contact-create-relay-group, public-pages, group-text-reply-all, settings,
  tour-comms-pane), `flows/outbox.spec.ts`, `roster-quiet-hours.spec.ts`,
  `scenarios/quiet-hours.spec.ts` - most via the shared
  `e2e/fixtures/outbox.ts` fixture.
- The performance self-QA lane (`e2e/performance/selfQa.ts` + `templates.ts`).
- 2 app suites (`devOutbox.integration`, `recordingMessaging.integration` -
  the latter now isolated on its own throwaway prefix, 2026-08-23).

Whoever picks this up should plan a MIGRATION MISSION, not an afternoon: the
work is porting `e2e/fixtures/outbox.ts` call sites to the fake-twilio thread
store (`GET /control/threads`), which remains the right target - it captures
both directions plus delivery-status progression, strictly more than the
outbox. The deletion at the end is the easy part.

Also relevant since filing: the latent devOutbox/recordingMessaging same-table
race was closed on 2026-08-23 by isolating recordingMessaging (see
`fix/test-suite-wave3`), which removes the scheduling pressure this issue
briefly had. It is back to pure debt.

**Problem.** The dev-only `/__dev/outbox` proof-of-send log and its
`RecordingMessagingDriver` decorator are deprecated. They only capture **outbound**
messages, whereas the fake-twilio thread store (`GET /control/threads`) captures **both
directions + delivery-status progression**. They're retained solely so three pre-existing
green specs (outbox / intake-to-reply / boards) don't churn; the code is marked "do not
extend / do not add new reliance."

**Suggested fix.** Migrate those three specs to assert against the fake-twilio thread
store, then delete: the `/__dev/outbox` route (`dev.ts`), the `RecordingMessagingDriver`
(`recordingMessaging.ts`), its wiring in `messaging.ts`, and the lazily-created outbox
table. Dev/hermetic-only — no prod impact (never in terraform).

Graduated 2026-06-18 from `@deprecated` / `DEPRECATED` markers on the code above (found in
a sweep for non-TODO flags). Inline marker: `TODO(remove-dev-outbox-proof-of-send)` in `dev.ts`.
