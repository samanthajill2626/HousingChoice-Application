# Fix wave 2 - record (M7 npm test soundness)

Base `ad47aec1`, code commit `0eaa20a3`. Scope is the six items adjudicated in
`r2-adjudications.md` (adversarial N1-N5, N7-N9; conformance N1-N3, N5-N7). No
DECLINE row was touched: no single deadline threaded through `ensureTable`, no
waiter replacement on the success path, no poll behaviour change, no `__`
basename exemption in the guard. Every item below is a change to
`app/src/lib/dynamoAdmin.ts`, `app/test/dynamoAdminRetry.test.ts`,
`app/test/setup/dynamoAccessKeyGuard.test.ts` or `app/test/staticSmoke.test.ts`
and nothing else.

Verbose transcripts, log names and the throwaway reproductions are in the
gitignored `.superpowers/review/r2-fix-wave-evidence.md`.

---

## W1 - the deadline moved AFTER the verify hook (adversarial N1, must-fix)

**Test first.** Case 22, `dynamoAdminRetry.test.ts:636-665`: local endpoint, TTL
spec, `UpdateTimeToLive` scripted to take 30ms and throw `InternalFailure`,
`DescribeTimeToLive` scripted DISABLED (the pre-send guard) then ENABLED (the
hook's re-read), schedule `deadlineMs: 1` with zero backoff. It asserts
`ensureTable` RESOLVES `'created'`, one `UpdateTimeToLive` and two
`DescribeTimeToLive`.

**RED** on `ad47aec1`: `promise rejected "InternalFailure: ..." instead of
resolving` - the call dies before either count assertion, which is the finding
exactly (the deadline throws the container fault without ever asking whether the
mutation landed).

**Code.** `dynamoAdmin.ts:274-283`: the elapsed-time check now sits after the
verify block and immediately before `onRetry`. The order in
`retryLocalControlPlane` is retryable? -> attempt bound -> endpoint gate ->
verify (true: return / throws: rethrow the original / false: continue) ->
DEADLINE -> `onRetry` -> sleep -> re-send. The comment says what the reorder
buys: the deadline stops RE-SENDS only, every non-final failed attempt still
asks "did it land?", and the deadline reaches that blind spot earlier than the
attempt bound does.

**GREEN**: 22/22, with cases 7 (verify throws -> rethrow the original), 10 (the
hook runs three times, never on the final attempt) and 21 green in the same run.

This also dissolves conformance N4: the hook contract is back to "not called on
the final attempt only".

## W2 - case 21 made load-robust (adversarial N5 / conformance N1)

`dynamoAdminRetry.test.ts:605-634`. The old shape slept 30ms per send against a
50ms deadline, leaving 20ms of timer accuracy protecting the `>= 2` lower bound -
a load-sensitive false red inside the mission's own acceptance suite, and both
reviewers reproduced it going red. Now: `attempts: 12`, every `CreateTable` step
20ms and throwing `InternalFailure` via `fallback`, zero backoff,
`deadlineMs: 200`. It asserts the ORIGINAL fault BY IDENTITY (the same error
object the stub was given, not just a matching name) and `2 <= sends < 12`. The
comment states both margins: attempt 1 finishes at ~20ms against a 200ms budget,
so ~180ms of slack has to be lost before the lower bound can fail; the upper
bound is what proves the deadline fired at all.

**RED-then-GREEN, by mutation.** GREEN as written (22/22). Then the deadline
check was scratch-disabled in `dynamoAdmin.ts` and case 21 failed with
`expected 12 to be less than 12` - exactly the attempt bound, no deadline. The
scratch edit was reverted and the file re-verified clean before anything was
committed.

## W3 - case 20 pins its interleaving (adversarial N9)

`StubClient` gained `recordInto(timeline, label)`
(`dynamoAdminRetry.test.ts:150-165`), which pushes `<label>:<CommandName>` onto
an array SHARED between clients; the push sits after the scripted delay
(`:206`), so the shared log is ANSWER-ordered while `sent` / `count()` keep issue
order and are unchanged.

Answer order is the ordering with the meaning. What decides whether a concurrent
call could inherit another call's `retried` flag is where its CATCH runs, and
both `ensureTable` calls issue their first send synchronously under
`Promise.all` - an issue-ordered log would have recorded the plain client first
and pinned nothing.

Case 20 (`:561-603`) now shares one timeline between the two stubs and asserts
that the plain client's first `CreateTable` entry falls after the retried
client's SECOND, with the whole timeline in the failure message. The existing
zero-`DescribeTable` assertion is untouched.

## W4 - three comment corrections in `dynamoAdmin.ts` (adv N3/N4, conf N2/N7, A5 challenge)

- `DEFAULT_DEADLINE_MS`, `:145-164`. The "a 22-table loop cannot lose more than
  ~20s to any one contended table" sentence is DELETED; the rationale for 20s
  (one full lock-timeout retry fits) is kept. Added: what it bounds is one
  retried SEND, checked before a re-send, so the effective bound is the deadline
  plus one attempt; one `ensureTable` on a TTL-bearing spec makes up to three
  retried sends (CreateTable, the pre-send `DescribeTimeToLive`,
  `UpdateTimeToLive`) each with its own clock, plus up to 10s in the poll on the
  retried-conflict path; the success path's 60s SDK waiter is outside all of
  them; and under `npm test` the TTL legs do not run at all
  (`DYNAMO_DISABLE_TTL`), while `db:create` and the e2e lanes do reach them.
- `DEFAULT_POLL_CEILING_MS`, `:166-190` (the A5 comment). The exclusivity claim
  is narrowed to what the vitest key scheme actually gives - per-run-random
  prefixes or worktree-derived keys, across worktrees - and explicitly NOT to
  `app/scripts/db-create.ts` on the human's ambient database or an e2e lane
  mid-`db:update-gsis`, where a table can legitimately be UPDATING for minutes.
  What those callers lose is bounded and stated: only a RETRIED conflict reaches
  the poll, and it then fails after 10s naming the observed status where the base
  code failed immediately on the `InternalFailure` - a slower failure, not a lost
  success. Also stated: a read that FAILS inside the poll counts as not-ACTIVE by
  design and is not retried.
- `pollUntilTableActive` docblock, `:359-364`. One added sentence: the SUCCESS
  path of `ensureTable` deliberately keeps `waitUntilTableExists` unchanged (its
  first poll is immediate, so a fresh empty table normally returns on the first
  check; the flat-20s second tick bites only when the create itself is slow), and
  this mission changed only the retried-conflict path.

## W5 - the guard's rot-proof list widened (adversarial N2, conformance N3)

`dynamoAccessKeyGuard.test.ts`. `CONTAINER_REACHING` (`:122-136`) gained four
import-specifier alternatives in the same shape as the existing one -
`/db-create.js`, `/db-seed.js`, `/globalSetup.js`, `/globalTeardown.js` - and one
call alternative covering
`createAllTables|dropAllTables|ensureKeyedLocalTables|dropKeyedLocalTables`.

The docblock (`:93-121`) is rewritten. "The ONLY thing that reaches the
container" is gone. It now leads with the limitation: this is a ONE-FILE SOURCE
SCAN that does not follow imports, so a helper module that builds a client on the
suite's behalf is invisible to it; it is a statement about the declaring file's
text, not its module graph. It then names both halves of what it does catch (the
app's client factory and its constructors; the table-creating script/setup
modules and their helpers, because `createAllTables` builds its own client and
creates all 22 specs under FIXED names). The rot-proof case's own comment
(`:399-404`) and its failure message (`:416-421`) were updated to match.

The KNOWN ONE-HOP GAP is written into the docblock rather than left implicit:
`dynamoAdminRetry.test.ts` imports `scripts/db-update-gsis.js`, which imports the
client factory. That module is deliberately NOT in the list - listing it would
flag the tree's one legitimate `none` suite - and it is harmless because that
file's client construction sits behind its CLI argv guard and never runs under
vitest. It is the concrete measure of what a text scan cannot see.

**Gaming probe, RED then GREEN.** Throwaway `app/test/__fixwave2_gamed.test.ts`
carrying a bare declaration line plus an import of `createAllTables` from
`../scripts/db-create.js`: the rot-proof case failed with that file as its sole
offender (`1 failed | 14 passed`), while the creates-tables case correctly did
not flag it - the marker exempts it there, which is the whole point of the
finding. Under the pre-wave list the same file appeared in NEITHER list. Deleted;
guard back to 15/15 and `git status --short` clean of it. The real
`dynamoAdminRetry.test.ts` is still not an offender.

## W6 - staticSmoke fixture tidy (adv N7/N8, conf N5/N6)

`staticSmoke.test.ts`.

- The `<root>/site/package.json` decoy write is REMOVED (`:98` deleted) along
  with the comment lines that presented it as covering a depth "for a future
  probe". No probe ever resolved to it - the v2 decoy mistake the spec itself
  records. The decoy comment (`:67-71`) and the fixture-tree diagram (`:79`) now
  describe one decoy at the one depth the probes reach.
- One explicit recursive `mkdirSync` for the assets directory is the first
  filesystem statement after `mkdtempSync` (`:90-95`, the call at `:95`), with a
  comment that this is what makes the writes order-independent: with the dead
  decoy gone that single call covers the whole tree, so reordering the writes
  cannot ENOENT.
- The traversal comment (`:258-264`) and the inline probe note (`:292-294`) now
  say that the `..%5c` probe's decoy target exists on WINDOWS only - on POSIX the
  backslashes are one filename inside dist, where no decoy exists, so the probe
  degrades to a shape probe - and that falsifiability is therefore 4 of 6 on
  Windows and 3 of 6 on Linux. The measured figure is dated and labelled Windows.

**Leaky-layer re-run.** Wave 1's evidence-E3 reproduction was rebuilt as a
throwaway against the CHANGED fixture: **4 of 6 probes still leak**, and the same
four (`/%2e%2e%2f%2e%2e%2f`, `/..%2f..%2f`, `/..%5c..%5c`, `/assets/...`) as
wave 1 measured. Removing the unreachable decoy cost the fixture nothing.
Throwaway deleted.

---

## Verify

Bare and foreground from `W:\tmp\npm-test-soundness\app` (last two from the
worktree root), each captured to a file and read back.

| command | exit | result |
|---|---|---|
| `npx vitest run test/dynamoAdminRetry.test.ts` | 0 | 22 passed (22) |
| `npx vitest run test/setup/dynamoAccessKeyGuard.test.ts` | 0 | 15 passed (15) |
| `npx vitest run test/staticSmoke.test.ts` | 0 | 12 passed (12), 0 skipped |
| `npx vitest run test/dynamo.integration.test.ts` | 0 | 2 passed (2) |
| `npx vitest run test/globalSetupEnsure.test.ts` | 0 | 5 passed (5) |
| `npx vitest run test/unreadIndexRepo.integration.test.ts` | 0 | 23 passed (23) |
| `npm run typecheck` | 0 | clean |
| `npx eslint <the 4 touched files>` | 0 | no output |

ASCII scan of every added line in the wave diff: 0 bytes above 0x7E.

Not run, per the brief: full `npm test`, `npm run e2e`, `npm run smoke`. The
DynamoDB Local container was never restarted, `E2E_CHILD_LOG_DIR` was never set,
nothing was left running in the background, and both `__fixwave2_*` throwaways
were deleted with `git status --short` confirmed clean of them.

## Seen and not fixed

- **Adversarial N6 (untracked scratch test reds the guard)** - DECLINED in the
  adjudication and left alone. This wave hit it deliberately twice and it behaved
  as designed both times. Known sharp edge for the handback.
- **A6's residue** - `CreateTable` still has no verification hook. W1's reorder
  removes the widening the deadline introduced, but the residue is a human item,
  and the deadline still reduces the number of attempts that could draw the
  `ResourceInUseException` recovery on the lock-timeout signature.
- **A8** - `ensureTable` still returns `'exists'` for a table it created on the
  retried path; case 2 pins it. Unchanged, as adjudicated.
- **The guard does not detect a contradictory pair of dynamo-lane markers.** Not
  reachable today (no file carries two), noted by the round-2 sweep, and out of
  scope for a targeted wave; worth knowing if a fourth answer is ever added.
- **`waitUntilTableExists` on the success path** is now explained rather than
  changed - the DECLINE stands, and the 60s waiter remains the largest single
  hook cost on the path every caller takes.
