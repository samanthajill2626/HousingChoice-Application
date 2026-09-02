# Planner fix wave - verbose evidence (gitignored)

Raw logs live beside this file's siblings under
`W:\tmp\npm-test-soundness\.superpowers\sdd\reports\`:

| log | what |
|---|---|
| `w1-red.log` | cases 23 + 24 RED before `pollUntilTableGone` existed (2 failed / 22 passed of 24) |
| `w1-green.log` | after W1 + W3 + the case 4 update: 24 passed |
| `w2-red.log` | cases 10 + 25 RED before the catch reorder (2 failed / 23 passed of 25) |
| `w2-green.log` | after the reorder: 25 passed |
| `w7-check.log` | retry + staticSmoke after the case 21 reshape and the dead-loop deletion: 37 passed |
| `guard.log` | `test/setup/dynamoAccessKeyGuard.test.ts` 15 passed |
| `globalsetup.log` | `test/globalSetupEnsure.test.ts` 5 passed |
| `dynamo-integration.log` | `test/dynamo.integration.test.ts` 2 passed |
| `importapply.log` | `test/importApply.integration.test.ts` 31 passed |
| `typecheck.log`, `typecheck-final.log` | root `npm run typecheck`, exit 0 |
| `eslint.log`, `eslint-final.log` | the three touched files, exit 0, no output |
| `final-retry.log`, `final-static.log` | final committed state: 25 and 12 passed |

## RED excerpts

Case 23, before W1 (`w1-red.log`): the assertion that failed was
`expect(stub.count('DescribeTable')).toBe(3)` - received 0. Not one read: the
tolerated path returned with no poll at all, so none of the three scripted
DELETING/DELETING/gone answers was ever consumed.

Case 24, before W1 (`w1-red.log`): `expect(failure).toBe(conflict)` received
`undefined` - `deleteTableIfExists` RESOLVED where the fix makes it reject.

Case 25, before W2 (`w2-red.log`): `ensureTable` rejected with
`InternalFailure`; the hook ran 3 times, so the 5th scripted
`DescribeTimeToLive` (the ENABLED one) was never consumed.

Case 10, before W2 (`w2-red.log`): the 9-element expectation received the
8-element interleave - no trailing `DescribeTimeToLive`.

## The one intermediate failure worth recording

The first post-W1 run (`w1-green.log`, first attempt) failed case 4 with
`ResourceInUseException: Table already exists: stub (table stub is still ACTIVE
after 10000ms)`. Case 4 injected no `poll` and scripted no `DescribeTable`, so
the new poll met the stub's default ACTIVE answer and ran the full default
ceiling. Diagnosis and fix are in the committed record's "RED then GREEN"
section; nothing about the implementation changed as a result.

## Backoff arithmetic checked by hand

`pollDelay(base, reads) = base * min(2^(reads-1), 8)`.

- defaults: 100, 200, 400, 800, 800, ... - ~16 reads inside the unchanged
  10_000ms ceiling (sum of the first 16 delays is 10_100), against ~100 before.
- `intervalMs: 1` (cases 2, 17, 19, 23, 24): 1, 2, 4, 8, 8, ... - case 17's
  25ms ceiling still admits 6 reads before the throw, and every one of those
  cases asserts script-driven counts or messages rather than read counts, so
  none of them moved.

## Case 21 determinism argument, long form

The deadline is read ONLY in the catch, never during a send.

- Lower bound: send 1 answers at ~5ms. The catch then compares elapsed (~5ms)
  against 2000ms. For the deadline to fire there, the process would have to
  lose ~1995ms between the send resolving and the very next statement. So a
  premature stop is not merely unlikely, it is off the scale of the scheduling
  jitter that made the old 20ms/200ms shape a load-sensitive ratio.
- Upper bound: send 2 alone sleeps 2500ms, so at its catch elapsed is >= 2505ms
  on any machine, which is > 2000ms unconditionally. There is no machine speed
  at which a third send happens.
- Teeth: the attempt bound is 12 and backoff is 0, so with the deadline removed
  the stub answers 12 sends; and the fallback step is a DIFFERENT
  `InternalFailure` instance, so a third send also breaks the identity
  assertion. Two independent failures guard the same property.
