# R3 conformance review - verbose evidence (gitignored, not committed)

Tip `1079bf05`, wave-2 base `ad47aec1`.

## Commands (bare, foreground, from `W:\tmp\npm-test-soundness\app`)

```
npx vitest run test/dynamoAdminRetry.test.ts   -> 22 passed (22), exit 0
npx vitest run test/staticSmoke.test.ts        -> 12 passed (12), 0 skipped, exit 0
npx vitest run test/setup/dynamoAccessKeyGuard.test.ts
  -> 1 failed | 14 passed (15), TWICE
     offender: ["app/test/__review_adv3_probe.test.ts"] on run 1,
     and the untracked file was named __review_adv3_gamed.test.ts by run 2
     -> a live concurrent reviewer's scratch file, not mine, not in the branch.
     The rot-proof case ("a suite declared as touching NO container tables
     really cannot reach one") is GREEN in both runs; the failure is the
     older creates-tables case, which is adversarial N6's declined sharp edge.
```

ASCII: `git diff ad47aec1..1079bf05` -> `added lines >126: 0`.

`git status --short` at the start of this round: clean. Mid-round it showed
`?? app/test/__review_adv3_gamed.test.ts` - left untouched (another agent's
work). I created no throwaway this round.

## Wave-2 hunk map for `app/src/lib/dynamoAdmin.ts` (5 hunks, none in ensureTable)

```
@@ -147,8 +147,20 @@ const DEFAULT_ATTEMPTS = 4;           deadline docblock
@@ -157,10 +169,24 @@ const DEFAULT_POLL_INTERVAL_MS = 100; poll-ceiling comment (N7)
@@ -231,11 +257,6 @@ retryLocalControlPlane                deadline check REMOVED from here
@@ -250,6 +271,16 @@ retryLocalControlPlane                deadline check ADDED after verify
@@ -325,6 +356,12 @@ TableNotActiveError                   poll docblock: success path keeps the SDK waiter
```

`ensureTable`, `deleteTableIfExists`, `enableTtlIfNeeded`, `pollUntilTableActive`'s
body and both public entry points are outside every hunk.

## Live order inside the catch (post-wave)

```
259  if (n >= attempts) throw err           <- attempt bound, still FIRST
260  local ??= await isLocalDynamoEndpoint  <- endpoint gate
262  if (opts.verify) { ... }               <- the hook, exactly one call
272  if (landed) return
283  if (Date.now() - startedAt >= deadlineMs) throw err   <- MOVED here
284  opts.onRetry?.()
```

Consequences walked against the four named cases:

- case 7 (`:354`): hook throws -> original rethrown, no re-send. Reaches the
  hook at `:262` and exits before `:283`. Unchanged.
- case 10 (`:393`): 4 sends, 3 hook calls, none on attempt 4. `:259` still
  precedes `:262`, so the invariant is untouched. The exact 8-element TTL
  interleave still passes.
- case 21 (`:605`): `attempts: 12`, 20ms sends, 200ms deadline, backoff 0.
  Expected shape ~10-11 sends; assertions are `>= 2` (about 180ms of slack) and
  `< 12` (proves the deadline, not the bound, stopped it), plus `rejects.toBe`
  on the fault instance.
- case 22 (`:636`): deadline 1ms, one 30ms `UpdateTimeToLive` failure, re-read
  reports ENABLED -> resolves `'created'` with 1 `UpdateTimeToLive` and 2
  `DescribeTimeToLive`. Under the pre-wave order this case would have thrown.

## NEW-1 detail

`app/src/lib/dynamoAdmin.ts:153-155` (one sentence spanning those lines) says
the effective bound is `deadlineMs` plus one attempt, on the grounds that the
clock is read only before a re-send. After this same commit's reorder the read
at `:283` also sits after the verification hook at `:262-272`, so for
`sendWithRetryVerified` callers the true worst case is deadline + one attempt +
one verify read. The verify read is a control-plane call
(`DescribeTimeToLive` for TTL, `DescribeTable` inside `indexStatus` for GSIs),
so under the ~10s lock-timeout signature the comment is short by up to ~10s.
Remedy: one clause ("plus one attempt, and for a hooked send one verification
read").

## Anchors verified live

```
dynamoAdmin      144 DEFAULT_ATTEMPTS   164 DEFAULT_DEADLINE_MS
                 145-163 deadline docblock   169-192 poll-ceiling comment
                 249 startedAt   259/260/262/272/283/284 catch order
                 359-364 success-path waiter paragraph   371 pollUntilTableActive
staticSmoke      63 fixture html   72 decoy const   90-95 explicit mkdir
                 98 the single decoy write   247 decoy rationale
                 258 Windows-only clause   301-306 the four assertions
guard            58 worktree marker   73 none marker   83 declaration-line regex
                 97-99 one-file-scan limitation   109-115 known one-hop gap
                 122-133 widened CONTAINER_REACHING   392 rot-proof case
acceptance       296 case 3   354 case 7   393 case 10   561 case 20
                 605 case 21   636 case 22
```
