<!--
  HISTORICAL RECORD, preserved 2026-08-24. The adversarial review handback for
  `fix/test-suite-hardening` (merged to main 2026-08-23 @2294fc92). Committed
  because review handbacks die with their worktrees (a recorded loss - see the
  gitignored-.superpowers trap) and this one is load-bearing three ways: it is
  the repo's reference example of the review method (refute rather than
  confirm; mutation-probe every check; trust no single green run), it holds
  primary measurements cited by several issue resolutions (the 116-leaked-table
  clean-key experiment), and its "attacked and found nothing" section is the
  only record that those paths were tested rather than skipped.

  DISPOSITION: all 12 items of its action list are landed in main as of
  2026-08-24 - items 1-2 and 10-12 on fix/test-suite-hardening itself and
  fix/test-hardening-wave2, item 7's sweep + rewrite across wave2/wave3 and
  fix/dynamo-per-file-keys, items 3-6, 8 and 9 verified individually today.
  Nothing in here is open work.
-->

# Adversarial review handback - `fix/test-suite-hardening`

Reviewer: independent Claude session, 2026-08-23.
Branch reviewed: `fix/test-suite-hardening` @ `50fa76b5` (21 commits ahead of `main`).
Worktree: `W:\tmp\e2e-harness-determinism`.
Method: read the diff before the commit messages; refute rather than confirm;
mutation-probe every check the branch ADDS; no single green run trusted.

Nothing was committed, pushed, or left modified. Every probe below was reverted
and the worktree was verified clean at `50fa76b5` afterwards.

---

## Verdict

The engineering is sound and the branch is VINDICATED on the gate it appears to
fail. Three things need action before merge:

1. one real correctness defect (the UpdateTable retry),
2. one proven test gap (two surviving mutations in the sw.js mirror check),
3. one measurement error that invalidates the central conclusion of the issue
   this branch reopened.

Everything else is documentation drift and small residuals.

---

## Gates, run bare from the worktree

| gate | result |
|---|---|
| `npm run typecheck` | exit 0, all five workspaces |
| `npm test` | **exit 1** - app 9 failed / 313 passed / 1 skipped (323 files); dashboard 168, e2e 19, fake-twilio 33, fake-twilio-web 13 all green. Duration 607.66s wall, 5023.14s test time |
| `npm run smoke` | exit 0 - 1325 import specifiers across 232 emitted files |
| `npm run e2e` run 1 | **exit 1** - 1 failed / 250 passed (19.1m) |
| `npm run e2e` run 2 | **exit 1** - 202 failed / 26 passed (20.9m), cascading from `POST /__dev/reseed` timing out at 30s |

One run is not evidence, so the control below was run.

---

## The controlled experiment - read this first

Same commit, same machine, same container. The ONLY variable is the DynamoDB
Local access key, and therefore which database inside the container is used.

```
# red
cd app && npx vitest run
# green
cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run
```

| database | app suite | wall | test time |
|---|---|---|---|
| worktree key `hctestij3dce` | **9 files failed** | 607.66s | 5023s |
| brand-new key (empty db) | **322 passed / 1 skipped, 0 failed** (5693 tests) | **65.46s** | 305s |

9.3x wall, 16.5x test time, and the gate flips red to green.

Cause, measured directly against the container:

```
hctestij3dce: 116 tables
    50  hc-test-<uuid>-   (leaked per-suite)
    44  hc-local-<lane>-  (leaked per-suite)
    22  hc-hist-<uuid>-   (leaked per-suite)
```

`app/test/globalTeardown.ts` drops exactly the 23 plain `hc-local-` tables. The
other three prefix families - minted by the ~38 suites that use
`hc-test-${randomUUID()}`, plus `performanceSeed.integration.test.ts:215`
(`hc-local-<lane>-`) and `seedHistory.test.ts:730` (`hc-hist-<uuid>-`) - are
invisible to it and accumulate permanently. The count was 116 before the full
run and 116 after, so a run that COMPLETES cleans up after itself; the backlog
is historical, from interrupted runs.

Single-file confirmation with nothing else running:

| run | key | duration |
|---|---|---|
| A | worktree | 59.26s |
| B | brand-new | **2.34s** |
| C | worktree | 80.96s |

`groupCrossCheck.test.ts` specifically:

* clean database: **30 passed / 0 failed of 30**
* degraded database: **12 passed / 2 failed of 14**
* in the full gate run its one failure was
  `InternalServerError: This action timed out because it too long waiting for a lock`
  on "twenty concurrent event/classic pairs", file duration 365s.

All 11 failures in the bare `npm test` run were plain 60s timeouts or that lock.
**Zero assertion failures.** The branch's own suites did not fail on their logic.

The shared `hc-dynamodb-local` container was NOT restarted (831 MiB resident,
three other worktrees live, and the repo's docs make that an operator decision).
Restarting it is the recommended next step; both gates are expected green after.

---

## Findings, ranked by severity

### 1. HIGH - the UpdateTable retry is unsafe under partial success, and its stated justification does not describe its own code path

File: `app/scripts/db-update-gsis.ts`

The docstring on `sendWithInternalFailureRetry` says retrying is safe "because
`ensureGsis` re-reads the live index set and only creates what is missing, so a
retry of a call that actually succeeded finds the index present and does
nothing."

It does not. `liveIndexNames()` is read ONCE PER TABLE, above the
`for (const gsi of missing)` loop. The retry helper re-sends the IDENTICAL
`UpdateTableCommand` with no re-read.

So when attempt 1 is accepted by the server and only its RESPONSE fails with
`InternalFailure` / `InternalServerError` - the exact scenario the retry exists
for - attempt 2 hits an index that is already being created. Verified against
the running container:

```
attempt 1: ACCEPTED
attempt 2 (the RETRY): THREW ResourceInUseException - Attempt to change a
                       resource which is still in use: Index is being created.
index status: byGk=CREATING
```

`ResourceInUseException` is not in the retry allow-list, so the helper rethrows
it. A run whose GSI was created successfully fails anyway, with a misleading
error naming a resource conflict.

Suggested fix: on a retryable error, `DescribeTable` and return if the index is
now `CREATING` or `ACTIVE`, before re-sending.

Sub-questions that DO survive attack:

* `err.name` is the right discriminator. `InternalServerError` is exactly the
  lock signature the container emits under load, and permanent configuration
  errors surface as `ValidationException`, so a genuine hard failure cannot be
  swallowed. Backoff total is 1.5s - the "4x-slower hard failure" worry is
  negligible.
* The localhost hard-gate is effectively unbypassable for the CLI path.
  `ensureGsis` itself is exported ungated, but its only importers are
  `unreadIndexRepo.integration.test.ts` and the gated CLI.

Related observation worth acting on: the same `InternalServerError` is what
kills DATA-PLANE writes in the suites that actually fail. The retry only wraps
GSI creation, so it does not help the failure mode that is currently red.

---

### 2. HIGH - the sw.js behavioural comparison misses two branches, one of which its own source comment calls load-bearing

File: `dashboard/src/sw/mirror.test.ts`

Seven mutations applied to `dashboard/public/sw.js`, each run as
`cd dashboard && npx vitest run src/sw/mirror.test.ts`:

| mutation to the mirror | caught? |
|---|---|
| drop `\x7f` from `isPlausibleId` (the historical DEL drift) | CAUGHT (2 failures) |
| `/email` exact match -> `startsWith('/email')` | CAUGHT |
| change the fallback title | CAUGHT |
| drop the `voicemail` arm of `staleTagsFor` | CAUGHT |
| swap `callId` / `conversationId` precedence in `notificationTag` | CAUGHT |
| `renotify: alerting && Boolean(tag)` -> `renotify: alerting` | **MISSED, exit 0** |
| `actions: Array.isArray(d.actions) ? d.actions.slice(0,2) : undefined` -> `actions: d.actions` | **MISSED, exit 0** |

Why: no payload in `displayPayloads` has an alerting `kind` with NO id
(`kind: 'message'` with no `conversationId`/`callId`), and no payload carries
`actions` at all. The `renotify` guard is the one `public/sw.js:123-124`
describes as "REQUIRES a tag - setting it tagless throws".

Verified fix. Adding these three payloads to `displayPayloads` makes BOTH
mutations fail, and leaves the unmutated file green:

```js
{ kind: 'message' },
{ kind: 'message', conversationId: 'c', actions: [{ action: 'a' }, { action: 'b' }, { action: 'c' }] },
{ kind: 'message', conversationId: 'c', actions: 'not-an-array' },
```

This is a DIFFERENT problem from the filed
`sw-mirror-function-list-hand-maintained`. That issue is about which functions
are compared; this is about which inputs they are compared over. The `MIRRORED`
list itself was checked and is complete today - it exactly matches the six
exported functions of `src/sw/route.ts` and `src/sw/display.ts`.

---

### 3. HIGH - the reopened contention issue's key measurement was taken on the degraded database, and its conclusion does not follow

File: `docs/issues/npm-test-dynamodb-local-contention.md`

The issue states "the 46 integration files account for **1990s of the 2350s**
total test time", concludes that serializing them costs ">= 33 MINUTES wall",
and therefore declares "**option 1 is no longer viable**", leaving per-FILE
access keys as "the only scalable fix".

On a clean database the ENTIRE app suite is 305s of test time. The 2350s figure
is an artefact of 116 leaked tables, not of suite count. The >= 33 minute
estimate is inflated by roughly the same factor, and "no longer viable" is not
supported by the evidence given.

More usefully: the actual root cause is cheaper to fix than either option the
issue lists. A teardown-time or `db:start`-time sweep of `hc-test-*`,
`hc-local-<lane>-*` and `hc-hist-*` under the worktree key recovers the ~9x and
turns the gate green WITHOUT the 53-file per-file-key refactor. Per-file keys
remain a good idea for lock isolation; they are no longer the only lever.

Severity challenge: `med` understates this. `npm test` is a required completion
gate that is currently red for environmental reasons, and AGENTS.md's
known-flake list does NOT mention it - so an agent who hits this has no
sanctioned re-run and will either mis-blame their own change or re-run
informally. The branch's own experience ("green on the SECOND run") is exactly
that pattern. Recommend `high`, and add it to the AGENTS.md known-flake list
with the clean-database diagnostic as the first thing to check.

---

### 4. MEDIUM - `DYNAMO_DISABLE_TTL=1` does not disable TTL; it only declines to enable it

File: `app/src/lib/dynamoAdmin.ts:117`

`ensureTable` skips `enableTtlIfNeeded` when the flag is set. On a table that
ALREADY has TTL enabled, that is a no-op - the reaper keeps running. Verified
against the container: pre-enable TTL, then call
`ensureTable(client, spec, name, { DYNAMO_DISABLE_TTL: '1' })`:

```
A: after simulated prior run, TTL = ENABLED
A: ensureTable with DYNAMO_DISABLE_TTL=1 -> exists
A: TTL is now = ENABLED   <-- the flag did NOT disable it
```

DynamoDB Local reaps a born-expired row in about **2 seconds** (measured), and
`globalTeardown.ts` documents that a hard kill skips teardown. The 116 leaked
tables are proof that interrupted runs are routine on this machine.

So `app/vitest.config.ts`'s claim that this "immunises every integration suite,
including the ones nobody has written yet" is overstated.

Scope, stated accurately rather than dramatically:

* `groupCrossCheck.test.ts` is independently safe - `cleanupMs` is injected.
* `aiRunsRepo.integration.test.ts` mints a fresh `hc-airuns-<uuid>-` table per
  run, so its 2026-11-04 fuse IS defused.
* The residual is a FUTURE suite that uses the shared `hc-local-*` tables and
  pins a past clock, on a machine carrying residue. Self-healing after one
  clean run.

Suggested fix: either soften the comment, or make the flag actively DISABLE TTL
rather than skip the enable.

Two sub-questions attacked and NOT broken:

* The variable CANNOT reach a deployed environment. Absent from every `.env`
  template, terraform, CI and the container entrypoint; the app request path
  never calls `ensureTable`; Terraform owns the AWS tables. The one residual
  path is `createAllTables` having no localhost gate (only `--reset`/`--drop`
  do), so `DYNAMODB_ENDPOINT=<aws> npm run db:create` with the variable
  exported would create tables without TTL - but that gate gap pre-dates this
  branch.
* NO test depends on rows expiring. Every `expires_at` assertion under
  `app/test/` is on the attribute VALUE or on the `tables.ts` spec, never on
  the reaper. Nothing waits out a TTL. The branch's claim here is correct.

---

### 5. MEDIUM - README.md documents the behaviour this branch removed

`README.md:83` still reads:

> `npm test` | Vitest across all workspaces (DynamoDB integration suite
> auto-skips when DynamoDB Local isn't running)

That is precisely the behaviour `app/test/globalSetup.ts` now removes. AGENTS.md
was updated; the human-facing setup doc was not, and now actively misinstructs.

Also missing from README's command table: `npm run smoke`, despite it being
required gate 3.

`ALLOW_SKIP_DYNAMO_TESTS` appears only in AGENTS.md and the source comment - not
in README.md and not in e2e/README.md.

---

### 6. MEDIUM - a resolved issue tells the next reader the smoke gate is optional, because the correction landed on the wrong file

`docs/issues/compiled-dist-boot-unverified.md:51` still says:

> **Open for the human:** `AGENTS.md` lists three required completion gates
> (typecheck / test / e2e). This should arguably be the fourth ... Editing that
> list is shared project law, so it is flagged rather than done.

The very next commit, `aaa9e2fc`, made smoke required gate 3 of 4 (with
"Cameron approved adding it (2026-08-21)"). That commit's message says it
"Dropped the now-stale 'three required completion gates' phrasing from the
contention issue" - and it did edit
`docs/issues/npm-test-dynamodb-local-contention.md`. But the actual stale claim
lives in `compiled-dist-boot-unverified.md`, and a repo-wide grep finds exactly
one remaining occurrence: that one.

---

### 7. MEDIUM - the quiet-hours timezone pin is provably inert on a clean lane

File: `e2e/tests/roster-quiet-hours.spec.ts`

`windowAroundNow()` now PUTs `timezone: ORG_TZ`, where
`ORG_TZ = 'America/New_York'`. But `app/src/repos/settingsRepo.ts:149` sets
`DEFAULT_ORG_SETTINGS.timezone = 'America/New_York'`, and NOTHING in `e2e/` or
`app/src/lib/seed/` writes that field (repo-wide grep). The Settings UI shows it
as fixed copy, not a control (`e2e/support/selectors.md:60`).

So on a clean lane the PUT writes the value the system already had. It cannot
have caused the observed ~2h skew to stop. The issue is marked `resolved` on a
change that only defends against a pre-polluted settings row - which may be
worth doing, but the skew's cause remains unexplained and the flake is not
demonstrably closed.

On restoration: `afterAll` calls `putQuietHours(api, QUIET_OFF)`, `QUIET_OFF`
carries no `timezone`, and the settings route is a patch (`if ('timezone' in b)`),
so the value is never restored. Harmless ONLY because it equals the default. If
anyone changes `ORG_TZ` to reproduce a bug it silently overwrites lane state for
every later spec in the run. Recommend adding `timezone` to `QUIET_OFF`.

---

### 8. LOW - three stale comments and one broken link, all introduced by this branch

* `e2e/tests/dashboard-next/contact-create-relay-group.spec.ts:131` - the
  comment above `afterAll` still says "then drop the retained log lines the
  create's stuck-sweep wrote (see the header)". The `clearLogTail(request)` call
  it describes was deleted by this branch.
* `e2e/support/viewport.ts:12` -
  `TODO(e2e-documentelement-overflow-check-vacuous): the outbound-mms copy still
  hand-rolls it; migrate it onto these two.` That issue is now
  `status: resolved` and the migration was done in this same branch.
* `app/test/contactTimeline.test.ts` - "The fake NOW compares lexically too
  (twilioWebhookHarness.ts, `listByEntity`)". That fix pre-dates the branch. The
  issue doc says so honestly; the code comment implies otherwise.
* `docs/issues/_CLUSTERS.md:275` links
  `./today-heading-locator-substring-collision.md`, which this branch deleted.
  It is the ONLY broken link in that file, and `_CLUSTERS.md` is tracked and
  untouched by the branch.

---

### 9. LOW - the groupCrossCheck drain exits on the wrong signal

File: `app/test/groupCrossCheck.test.ts`

The comment says the loop "keeps going until a sweep comes back empty", but the
code tests `outcome.alarms.length === 0`. `sweepCrossCheckDeadlines` returns
`{ scanned, alarms }`, and its `reconciledBy` branch RESOLVES rows and
`continue`s without pushing an alarm - so `scanned > 0 && alarms.length === 0`
is reachable and the drain can return with rows still in the partition.

Harmless today: no test in the file approaches `SWEEP_BATCH = 50` in the
cross-check partition. The one-word fix is `outcome.scanned === 0`.

The other two questions about the drain were attacked and found clean: it cannot
consume state a later test needs (every test calls `harness()` for a fresh rail
and rebuilds its own rows - the `'...and the stale credits'` title is narrative,
not carry-over), and it masks no assertion, because nothing asserts the
partition is empty.

---

### 10. LOW - three residual weaknesses in otherwise-good new checks

* `e2e/support/viewport.guard.test.ts` scans only `*.ts`. Confirmed it CATCHES
  the idiom added to a real spec (fails, naming the file) and MISSES the same
  idiom in a new `.mjs` or `.tsx`. Harmless today - `e2e/` contains exactly two
  `.mjs` files (`lane.mjs`, `laneLease.mjs`) and no `.tsx`. One-line fix.
* `scripts/smoke-dist.mjs` - the regex misses a specifier when a quote appears
  inside the import statement. `import { aaa } /* it's here */ from './missing.js';`
  is silently not checked (the specifier count stayed at 1325). Multiline
  imports, `export * from`, `export * as ns from` and side-effect imports are
  all handled correctly - verified by injection. Separately there is no floor
  assertion on `checked`, so a build emitting import-free output would report
  OK.
* `dashboard/src/sw/mirror.test.ts`'s brace matcher is fooled by an unbalanced
  brace in a string or a comment - but both constructed cases fail LOUDLY
  (`SyntaxError: Invalid or unexpected token`, and
  `Error: unbalanced braces while extracting staleTagsFor`), never vacuously
  green. Fragile, fail-safe. Note it means a CORRECT mirror edit containing e.g.
  `// closes the } above` reds the test spuriously.

---

### 11. Worth filing - the e2e failure is the same class this branch just fixed

`e2e/tests/dashboard-next/call-inbox-unread.spec.ts:155` failed run 1 with:

```
locator.click: Test timeout of 30000ms exceeded.
  - waiting for getByRole('button', { name: 'Mark Caller Tester as unread' })
  - locator resolved to <button ...>Mark unread</button>
  - attempting click action
  - element was detached from the DOM, retrying
```

The inbox row re-renders and swaps the button node out from under the click.
That is precisely the detached-node mechanism this branch diagnosed and fixed in
`ScheduleTourForm.test.tsx`. The spec is untouched by this branch and is not on
the known-flake list. Recommend filing it, referencing the ScheduleTourForm
diagnosis as prior art.

---

## Where I attacked and found nothing

Recorded explicitly so the next reader knows these were tested, not skipped.

**The relay fixture change is correct.** Traced every writer that can produce
`type: 'relay_group'`: `conversationsRepo.ts:1875` (single atomic Put, stamps
both fields) and `app/src/lib/import/apply.ts:1086` (stamps `relay_status`, and
explicitly guards the already-converted group_text case at :1146-1154).
`setType` has no callers. `closeRelayGroup`, reopen and `attachPoolNumber` all
move `status` and `relay_status` in one expression. There IS a legacy window -
relay groups created between 2026-06-13 (`2d6e6504`) and 2026-07-22
(`cc4211c3`) carry no `relay_status` - but production went live 2026-08-17 and
its rows come from the importer, which stamps it. The fake now agrees with
production, not with a bug.

Mutation-probed both directions:

* reverting `listRelayGroups` to `type`+`status` fails
  `relayPartitionFidelity.test.ts` (2 of 3 cases),
* reverting `listByEntity`'s `before` bound to `seqOf(e) < Number(before)` fails
  the new `contactTimeline` paging test.

**The log windowing does not weaken the assertion.** The original assertion sat
under a comment already scoped to the second pass, so `since` matches its stated
claim. `flagStuckConnecting` is fired ONLY opportunistically from
`provisionForGroup` (`poolNumbers.ts:521`), never on a timer, so nothing inside
the spec can emit that line mid-test. Every other `readLogTail` caller filters
by `event:` name or a run-unique `msg`/sid and is immune to the retired
`clearLogTail`; the ring is 500 lines and evicts oldest-first, so presence
assertions cannot be starved. The `since` plumbing is not unproven - it is
unit-covered at `app/test/devLogtail.test.ts:134`.

**The smoke gate is not vacuous.** It resolves identically to plain Node on
exports maps and conditional exports - four subpaths compared against real
`import()`: `body-parser/lib/read.js`, `axios/lib/adapters/http.js` and
`pino/lib/tools.js` all load in both; `call-bound/index.js` gives
`ERR_PACKAGE_PATH_NOT_EXPORTED` in both. It walks ALL 232 emitted files, not
just entrypoints - `index.js`, `worker.js` and every module. The self-check
cannot pass vacuously: without the flag the parent is ignored and `./index.js`
resolves to `<root>/scripts/index.js`, which never equals the dist path. And it
catches the real historical regression - injecting
`import 'nodemailer/lib/mail-composer'` yields `ERR_UNSUPPORTED_DIR_IMPORT`, the
same code plain Node gives.

**The fail-loud globalSetup breaks no legitimate workflow.** Simulated with
`DYNAMODB_ENDPOINT=http://127.0.0.1:9 npm test` -> exit 1, clear message naming
the hatch. I predicted it would block the other workspaces and I was WRONG:
`npm run test --workspaces` does not stop at the first failure - dashboard
(168), e2e (19) and both fake-twilio suites all still ran. Only the
documentation gap in finding 5 stands.

**The ConversationDetail mock defaults lose nothing.** Could not construct a
test that now passes and should fail. Deleting the `getConversationMembers`
arrangement from `beforeEach` still fails the file. Deleting one test's
`getConversation` arrangement still fails with
`TypeError: Cannot read properties of undefined (reading 'type')`. The only
default that silently substitutes is `getConversationScheduled`, whose default
is byte-identical to the arrangement it replaces. On the type question:
`mockResolvedValue(42)` typechecks clean under `AnyAsyncMock` - but it ALSO
typechecks clean under main's bare `vi.fn()`, verified by reverting the
declaration and re-running `tsc`. No type safety was given up; the chance to
type these to the real API signatures was simply not taken.

**The dashboard flake fixes hold.** 5 consecutive full dashboard suites, 168
files each, all green, run under concurrent load from the groupCrossCheck loop.

**The viewport helper is not a second vacuous check.**
`expectNoHorizontalOverflow` measures the routed `<main>` as well as the
document, and `.content` is a real x-scroll container, so it CAN be non-zero.

---

## Suggested action list

Before merge:

1. Fix the retry in `db-update-gsis.ts` (finding 1) - re-read before re-sending.
2. Add the three payloads to `mirror.test.ts` (finding 2) - verified to close
   both gaps.
3. Fix `README.md:83`, add a `npm run smoke` row, and name
   `ALLOW_SKIP_DYNAMO_TESTS` where a Docker-less contributor will look
   (finding 5).
4. Remove the stale "flagged rather than done" paragraph from
   `compiled-dist-boot-unverified.md` (finding 6).
5. Clear the three stale comments and the `_CLUSTERS.md` link (finding 8).

Before re-running the gates:

6. Restart the shared `hc-dynamodb-local` container (operator decision - three
   other worktrees are live). Expect `npm test` and `npm run e2e` green
   afterwards; the clean-key run already demonstrates the app suite is 0-failure
   on this commit.

Follow-ups, not merge blockers:

7. Rewrite the remedy section of `npm-test-dynamodb-local-contention.md` on
   clean-database numbers, raise it to `high`, and add a teardown sweep for the
   three leaked prefix families (finding 3).
8. Soften or strengthen the `DYNAMO_DISABLE_TTL` claim (finding 4).
9. Add `timezone` to `QUIET_OFF` (finding 7).
10. `outcome.scanned === 0` in the drain (finding 9).
11. Widen the viewport guard to `.tsx`/`.mjs`; add a floor assertion to
    smoke-dist (finding 10).
12. File the `call-inbox-unread` detached-node flake (finding 11).
