# Plan review r3 - reviewer A (launch-gate delta only)

Scope: spec r8 and plan v4 as changed since f3f85451 (PR102-PR106 and their
write-through). Read-only; no tests run.

## 1. [MEDIUM] `system_copy` does not survive the automatic retry or the reconcile adoption, so a staff Retry later in such a chain still stamps

What is wrong. Spec r8 7.2 says a staff Retry of anything that was automated
from its first send "and any later Retry of one" never counts. The W2 row
claims "a Retry of a Retry is judged by the first send". PR104 delivers this
by INHERITANCE: only the manual Retry route writes the marker (`api.ts`
~1872, S2.2 3c), and only Send now writes it at the start (3c2). Two other
writers append retry rows for the same chain and copy `automated` but not
the marker:
- the automatic 30003 retry, `app/src/jobs/retrySend.ts:551-566`
  (`automated: retried.automated ?? true`, no system-copy field);
- the reconcile's retry adoption, `app/src/jobs/sendReconcile.ts:923-943`
  (`automated` from the retried row, no system-copy field).
A Send-now row is stored `automated: false` (the S2.2 3c2 edit). Take a
Send now that hits 30003: the automatic ladder appends rows with
`automated: false` and no `system_copy`. The dashboard offers Retry only on
the newest row of a chain (the R6 comment, `api.ts:1746-1752`). That newest
row is the automatic retry row, so W2's gate (`broadcast_id`, `automated`
and `system_copy` all absent) passes and the staff Retry stamps. The same
happens after a manual Retry of an automated text (marked) is retried by the
ladder. Automated originals are safe only because `automated: true`
survives the hop.

Evidence that the backfill disagrees: PR105 judges the chain root
(`retry_root`, which both writers do set: `retrySend.ts:563`,
`sendReconcile.ts:941`), so it would exclude this row. But the writer is
forward-only, so the backfill cannot undo a live stamp.

Implication. The rule Cameron set at the launch gate leaks on the most
likely failure path of a Send now (a 30003). No S2 test covers it: the 1e/1f
cases press Retry only on rows the test seeded or that the Retry route
wrote. Fix: carry the marker in both writers
(`...(retried.system_copy === true && { systemCopy: true })`, which the
adoption's `NewMessage` accepts after S2.1a), each with a pin in
`retrySendAttempt.test.ts` / `sendReconcile.test.ts`. Alternatively, have W2
also judge the chain root the route already resolves (`api.ts` ~1771-1783),
which mirrors PR105. Either way, correct the spec's "judged by the first
send" sentence to match.

## 2. [LOW] The work map still says S6 depends on S1 only; S6.1 now needs S2.1a

What is wrong. Plan section 2 (row S6, line 123) lists S6's dependency as
`S1`. PR105's backfill code reads `row.system_copy` (`isSystemCopy`, and the
`system_copy` skip in `planOneToOneRow`), and `MessageItem.system_copy` only
exists after S2.1a. The S6 scope line says so; the work map does not.

Implication. Harmless while the slices are built in order (S2 before S6, as
section 2 also says). A builder reading the table as "S6 can start after S1"
would get a typecheck failure at S6.1.

---

## Checked in the delta and found sound

- `system_copy` writers: the only message-row builders are
  `messagesRepo.append` (one item literal, `messagesRepo.ts:2583-2650`;
  the S2.1a 3c anchor at :2641-2644 is unique) and the harness fake (the
  3c2 anchor at `twilioWebhookHarness.ts:1303-1306`). No other path builds a
  message row: the PutCommands in `messagesRepo.ts` write pointers, markers
  and media. Every `append` caller in app/src was listed; besides the two
  retry writers in finding 1, none re-sends an existing row's copy.
- Send now origins: `forceSendReminder` and `forceSendNudge` are the only
  `automated: false` sends in their files; the 3c2 anchors exist once each
  (`tourReminders.ts:2003-2005`, `placementNudges.ts:859-861`). The
  manual-only hold-back pauses send through the same `forceSendReminder`
  (`tourReminders.test.ts:4371`). Group-route reminders go out as relay
  announcements, which W2 cannot reach (sendMessage refuses relay
  threads).
- Existing Send-now job tests check single fields, so adding `systemCopy`
  breaks none (`tourReminders.test.ts:3335-3341`,
  `placementNudges.test.ts:1010`). The 1n anchors exist
  (`tourRemindersApi.test.ts:1743-1744`, `placementNudgesApi.test.ts:682-683`),
  and so does the 1k anchor (`tourRemindersApi.test.ts:1757`).
- S2.1a helpers exist: `appendOutbound`, `T0` / `T1`
  (`messagesRepoRetryLineage.integration.test.ts:291-311`); `outbound` and
  `CONV` (`twilioWebhookHarnessRetryFields.test.ts:19-22`); `makeFakes`
  with an automated-capable conversation (`ai_mode: 'auto'`,
  `sendMessage.test.ts:82-89`), plus S2.1's `reachedOutTouches`. Each
  stated RED is real: an untyped extra field is dropped at runtime, and the
  fake's allowlist drops it too.
- The S2.2 1e Retry-of-Retry case reads a stored `retry_root`, and
  `resolveRetryRoot` returns it with no parent read (`retryChain.ts:34-44`).
  1f's `retryRowOf` keys on `retry_of`, which the route sets to the pressed
  row's tsMsgId.
- The PR105 backfill case traces to the stated totals:
  `{ automated: 2, excluded_nudge_body: 1, system_copy: 1, retry_of_system_copy: 5, text: 4 }`,
  residue 1, latest 13:05. The `system_copy` skip runs before the retry
  check, and AR3 is excluded through its root.
- Heading counts and `people`: no residual `people` field, `built.people`,
  `quiet_share_people` or heading-count assertion remains in the plan.
  Every remaining "N people" is the property-line summary, which spec 6.3
  keeps. The e2e helpers select lists by exact name and Show all by
  `/^Show all \d+/`. `relay-number-lifecycle.spec.ts` matches its heading by
  regex. Spec r8 has no residual heading-count text.
