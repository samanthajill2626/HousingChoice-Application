# Task 5 Relay fix-wave 1 cold re-review

Reviewed correction: `439621a4 fix: preserve Relay preflight exclusions`.

## Fresh sweep

- The execution now keeps two deliberately different sets at
  `app/src/jobs/relayFanOut.ts:597-613`: `currentRoster` is the complete
  sender-excluded membership snapshot, while `recipients` is the optional
  continuation-filtered send set. Preflight uses the latter only to create and
  plan/send legs (`:851-884`) and the former only to reconcile departed slots
  (`:887-905`). Thus a Bob-only continuation cannot classify current Carol as
  departed. The new deterministic regression at
  `app/test/relayFanOut.test.ts:302-334` proves the provider sees only Bob and
  Carol remains `planned`.
- Stale reconciliation still cannot exclude an `attempted` slot: its predicate
  permits only absent or `planned` aggregation state (`relayFanOut.ts:887-896`).
  The repository transition additionally refuses `attempted -> excluded`
  (`app/src/repos/messagesRepo.ts:3089-3095`). Sender slots are outside
  `currentRoster` as before, so a stale sender source-time slot is reconciled
  without ever entering the send loop.
- `canReopenExcludedSlot` now requires an excluded, non-failed,
  non-`contact_opted_out` slot with no SID, send timestamp, or actual evidence
  (`relayFanOut.ts:909-917`). That is the valid never-attempted rejoin shape.
  The non-suppressed rejoin regression at
  `app/test/relayFanOut.test.ts:367-394` reaches the provider and ends
  `attempted`; it does not weaken the no-provider rule for suppressed legs.
- A durable suppressed slot remains excluded. The production suppression path
  writes `failed/contact_opted_out` (`relayFanOut.ts:643-676`); on a later
  continuation `canReopenExcludedSlot` rejects it and the terminal guard at
  `:638-641` prevents the suppression/send branches from rewriting it. The
  regression at `app/test/relayFanOut.test.ts:336-365` proves no provider send
  and unchanged status/error/request/state.
- I traced the apparent `undelivered` terminal edge rather than treating it as
  a latent finding. `isTerminal` predates this correction and continuation jobs
  are produced only from immediate transient send failures (`relayFanOut.ts:747-765,
  820-838`), not receipt callbacks. A v1 `excluded` slot is created before any
  provider call, whereas a receipt needs the SID pointer written after a call
  (`relayFanOut.ts:770-787`). Therefore normal v1 execution cannot reach an
  `excluded/undelivered` continuation slot. The correction's protected
  suppressed shape is the reachable `failed/contact_opted_out` one; no new
  terminal-state regression is established.
- The schema discriminator and immediate legacy return are unchanged at
  `relayFanOut.ts:415-419`; no new preflight, classification, preparation, or
  transport write becomes reachable for schema-absent sources. The existing
  continuation boundary proof remains at `app/test/relayFanOut.test.ts:166-191`.

## Prior findings

| Finding | Result | Evidence |
| --- | --- | --- |
| M1: continuation subset excluded a current member | Closed | Full `currentRoster` now drives stale reconciliation; the Carol/Bob regression proves the split. |
| M2: suppressed excluded slot reopened to planned | Closed | Reopen predicate excludes the stored suppression diagnostic and terminal guard prevents provider handling; the focused regression proves it. |

## Verification

I ran only the permitted focused command:

```text
npm run test -w @housingchoice/app -- test/relayFanOut.test.ts
EXIT 1 before test discovery: Vite EPERM opening app/node_modules/.vite-temp/vitest.config.ts.timestamp-1788295894715-9f337aa9b22138.mjs
```

This is the documented sandbox temp-file failure, not a test failure. The
implementer recorded the allowed-environment green result for this exact command
on this commit: `1 passed`, `44 passed` in
`.superpowers/sdd/task-5-fix-wave-1-report.md`.

No required finding remains. The correction changes only the intended Relay
preflight behavior and its focused deterministic tests.

CONFORMS/PASS
