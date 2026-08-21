---
id: unread-index-integration-coverage-requires-local-dynamo
title: A green npm test does not prove byUnread index semantics - that suite self-skips without DynamoDB Local
type: debt
severity: med
status: resolved
area: app/test-infra
created: 2026-08-16
resolved: 2026-08-21
refs: app/test/globalSetup.ts, app/test/unreadIndexRepo.integration.test.ts:42, app/test/helpers/unreadIndexFake.ts, app/src/lib/unreadFeed.ts:19
---

**Resolution (2026-08-21, `fix/test-suite-hardening`).** Took option 2/3 from
the list below, at the one place that covers everything: `app/test/globalSetup.ts`
now THROWS when DynamoDB Local is unreachable, instead of warning and
continuing.

**The problem was much larger than this issue's title.** It is not one suite.
**46 suites carry `describe.skipIf(!reachable)`, totalling ~631 tests.** With
Docker down, all of them silently do not run and `npm test` still exits 0 - a
required completion gate quietly omitting roughly a third of the app suite.
That is the exact shape that lets a real regression through while everything
looks green.

`globalSetup` was the right lever precisely because it is ONE choke point for
all 46 - the same reasoning as the `DYNAMO_DISABLE_TTL` flag: fix the class at
the seam rather than edit 46 files and hope the 47th remembers.

Deliberately an opt-OUT. `ALLOW_SKIP_DYNAMO_TESTS=1` still allows a focused
unit-only pass, but it prints exactly what is being given up. The default is to
tell the truth. This costs nobody anything they did not already have: Docker is
already a hard requirement of this repo (`AGENTS.md`, and e2e needs it).

Verified both branches:

```
no hatch:    exit 1  "DynamoDB Local is not reachable ... 46 suites (~631 tests)
                      would silently skip and this gate would still report green.
                        Fix:  npm run db:start"
with hatch:  exit 0  "SKIPPING the integration lane: 631 tests across 46 suites
                      will NOT run, and a green result does not cover them."
```

NOT addressed here, and still true: the byUnread FAKE can still drift from the
service (it modelled `LastEvaluatedKey` wrongly until 2026-08-16). This change
guarantees the real-DynamoDB suite RUNS; it does not make the fake faithful.
That half belongs with the C11 fake-fidelity work.

**Problem.** The only suite that exercises the sparse `byUnread` GSI against real
DynamoDB semantics, `app/test/unreadIndexRepo.integration.test.ts`, self-skips
when nothing answers at `DYNAMODB_ENDPOINT` (`describe.skipIf(!reachable)`).
Everything else on the unread path runs against
`app/test/helpers/unreadIndexFake.ts`, an in-memory model.

So `npm test` can be green on a machine with no Docker while proving nothing
about:

- `LastEvaluatedKey` behavior at the Query `Limit` (the fake modelled this
  wrongly until the 2026-08-16 review fix wave - it returned a key only when
  items remained, so every `queryUnreadPage` call-count assertion was calibrated
  one round trip short of production);
- tie ordering across rows sharing one `last_activity_at`;
- `ExclusiveStartKey` validation (an empty key attribute is a
  `ValidationException`, reasoned from the service contract rather than run -
  see the A4 fix in the same wave);
- sparse-index membership, i.e. that a row leaves the index when
  `unread_flag` is REMOVEd.

The exposure is structural, not hypothetical: `app/src/lib/unreadFeed.ts` states
as a design rule that "the unit tests assert on the NUMBER of queryUnreadPage
CALLS", which makes those assertions only as good as the fake's fidelity to the
service.

**Suggested fix.** Options, in increasing cost:

1. Make the skip LOUD - print a prominent line naming the coverage that was not
   run, so a green suite cannot be silently mistaken for a proven index.
2. Fail rather than skip when an env var (e.g. `REQUIRE_DYNAMO_TESTS=1`) is set,
   and set it in whatever runs the completion gates.
3. Have the gate itself boot DynamoDB Local (`npm run db:start`) so the
   integration lane always runs.

Deliberately NOT done in `feat/inbox-unread-index`: the reviewer's remedy
suggested amending `AGENTS.md`'s gates section, which is shared project law and
out of scope for a feature branch's fix wave. Filed here for the human to rule
on.

Related: [`dynamodb-local-cross-worktree-test-contention`](./dynamodb-local-cross-worktree-test-contention.md),
[`npm-test-dynamodb-local-contention`](./npm-test-dynamodb-local-contention.md)
(which absorbed the separately filed `db-update-gsis-integration-flake-under-load`
on 2026-08-21).
