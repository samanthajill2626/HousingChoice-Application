# Slice 5 report - Task 6 (the backfill script)

Branch `feat/media-content-type-fidelity`, worktree `W:\tmp\media-content-type-fidelity`.
Base for this slice: `ff7e4d73` (end of slice 4). Working tree clean at handback.

## Commit

| Hash | Message |
|---|---|
| `9102f63c` | `feat(scripts): backfill inbound media content types from Twilio` |

2 files changed, 768 insertions(+), 0 deletions. Both NEW. Staged by explicit
path (no `git add -A`), bare `git status` read before the commit, `MERGE_HEAD`
confirmed absent in the worktree's REAL git dir
(`W:\AI Projects\Housing Choice\HC Application\.git\worktrees\media-content-type-fidelity\`
- the `.git` in the worktree root is a FILE). Carries the
`Co-Authored-By: Claude Opus 5 (1M context)` trailer, and the commit BODY records
the C1 guard deviation in full.

NO npm script was added, as instructed and as verified again on this tree.

| File | Lines | Note |
|---|---|---|
| `app/scripts/backfill-media-content-types.ts` | 563 | the script + the CLI wrapper |
| `app/test/backfillMediaContentTypes.test.ts` | 207 | plan Step 1 verbatim, 15 tests |

## TDD sequence actually followed

| Step | Command (from `app/`) | Result |
|---|---|---|
| 1-2 (red) | `npx vitest run test/backfillMediaContentTypes.test.ts` | `1 failed`, exit **1** - `Cannot find module '../scripts/backfill-media-content-types.js'` |
| 3-4 (green) | same | `15 passed (15)`, exit **0** |

The test file is the plan's Step 1 block verbatim - the fixtures/harness and all
15 cases, unedited. Nothing in it was adjusted to fit the implementation.

## Verification (every command run BARE, never piped into a filter)

| Command (from) | Result |
|---|---|
| `npx vitest run test/backfillMediaContentTypes.test.ts` (app) | `15 passed (15)`, exit **0** |
| `npm run typecheck` (worktree root) | all workspaces clean, exit **0** (redirected to a log with `>`, exit read from `$?`) |
| `npx eslint app/scripts/backfill-media-content-types.ts app/test/backfillMediaContentTypes.test.ts` (worktree root) | **0 errors, 0 warnings**, exit **0** |
| ASCII scan (Node, whole of both new files) | 558 + 207 lines scanned, **0** non-ASCII |

Both gate commands were re-run AFTER the one post-green edit (renaming a log
field `attachments` -> `attachmentCount`, since it holds a count) and were green
again.

Not run, by instruction: full `npm test`, `npm run smoke`, `npm run e2e`. The
script itself was NEVER executed - no live AWS or Twilio call was made at any
point in this slice.

One ERROR log line appears in the vitest output. It is the intended one: the
"leaves everything repairable when the row write fails" case exercising the
per-row try/catch.

## THE C1 DEVIATION, as shipped

The plan's step 9b guard predicate is wrong on this tree and was replaced.

**Why the plan's version fails.** `createMessagingAdapter`
(`app/src/adapters/messaging.ts:1162-1193`) selects the driver on
`config.messagingDriver === 'console'` vs else - a discriminator STRING, not the
presence of credentials. `loadConfig` (`app/src/lib/config.ts:618`) defaults that
discriminator to `'console'` whenever `MESSAGING_DRIVER` is unset and
`nodeEnv !== 'production'`, EVEN IF every `twilio*` field is populated. An
operator shell with credentials exported but `MESSAGING_DRIVER` unset therefore
passes a credentials-only guard, gets the CONSOLE driver, reads `undefined` for
every attachment, and exits green reporting "all aged out" - which is
indistinguishable from a completed repair and is exactly the catastrophe the
guard exists to prevent.

**What shipped** (`messagingMisconfiguration(config)`, called from `main` BEFORE
the account guard and before any client is constructed):

```ts
function messagingMisconfiguration(config: AppConfig): string | undefined {
  if (config.messagingDriver !== 'twilio') {
    return 'MESSAGING_DRIVER is not "twilio", so this process would use the CONSOLE driver and read undefined for every attachment';
  }
  if (!config.twilioAccountSid || !config.twilioApiKeySid || !config.twilioApiKeySecret) {
    return 'MESSAGING_DRIVER=twilio but TWILIO_ACCOUNT_SID / TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET are not all set';
  }
  return undefined;
}
```

The driver check is FIRST and is the load-bearing half; the three fields stay as
belt-and-braces (`loadConfig` already fail-fasts them plus `TWILIO_AUTH_TOKEN`
and `TWILIO_MESSAGING_SERVICE_SID` when the driver is twilio,
`config.ts:623-629`). On failure `main` logs ERROR naming the cause AND the fix
(`HOW_TO_FIX`: set `MESSAGING_DRIVER=twilio` plus the `TWILIO_*` vars, plus
`MEDIA_BUCKET` and `TABLE_PREFIX`, for the TARGET environment), sets
`process.exitCode = 1`, and returns having scanned nothing.

`loadConfig()` is called INSIDE `main`, never at module load, so importing the
module from the test suite costs nothing and needs no env. Its throw is caught
and reported with the same `HOW_TO_FIX` guidance rather than escaping as a stack
trace.

`createMediaStore` returns `undefined` when `MEDIA_BUCKET` is unset, so `main`
carries a third refusal for that case (there would be no bucket to repair). Also
before the scan, also exit 1.

Per the plan, the "recovered is empty" condition is a WARN in the final report,
never an exit code: a fully repaired environment legitimately recovers nothing
forever.

## How the guarded clients are constructed

All three are built explicitly in `main` and INJECTED; nothing comes from the
ambient default credential chain, which on this machine is an unrelated account.

```ts
const identity = await assertHousingChoiceAccount();
logger.info({ profile: HC_PROFILE, account: identity.Account }, '... account guard OK');

const credentials = hcCredentials();
const doc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: HC_REGION, credentials }),
  { marshallOptions: { removeUndefinedValues: true } },   // must match lib/dynamo.ts
);
const mediaStore = createMediaStore({ config, credentials });   // slice 4's passthrough
const adapter = createMessagingAdapter({ config });
const messagesRepo = createMessagesRepo({ doc });               // over the GUARDED doc
```

`createMessagesRepo({ doc })` is the same constructor
`backfill-media-pointers.ts:51` uses (`RepoDeps` from `conversationsRepo.ts:530`:
`{ doc?, env?, logger? }`), so nothing new was needed to satisfy it - it takes
the guarded doc client directly, and resolves its physical table through
`tableName('messages', process.env)` exactly as the scan does.

Vendor-SDK rule respected: the script imports `@aws-sdk/client-dynamodb` and
`@aws-sdk/lib-dynamodb` (the doc client, precedent `import-apply.ts:27-28`) and
the adapters' own factories/interfaces. There is NO `@aws-sdk/client-s3` import
and no `twilio` import.

## Implementation notes a reviewer should check deliberately

- **Index derivation.** `parseMediaIndexFromKey` matches
  `^media/[^/]+/[^/]+/(\d+)$`; `parseMediaSid` matches
  `/\/Media\/(ME[0-9a-fA-F]{32})/`. Neither ever guesses. Both are exported so a
  future test can reach them directly.
- **Positional identity.** `merged` is `row.attachments.map(...)` - same array,
  same order, only `contentType` changed on repaired positions. Never filtered,
  reordered or appended. `staged` is a parallel array indexed by POSITION, and
  the media index parsed from the key indexes `mediaUrls` - the two are
  deliberately separate and can differ (a compacted successes-only attachment
  list is exactly why the first test exists).
- **Concurrency.** An index-cursor pool of 4 (`drain`): the cursor advances
  synchronously before the first await, so no two workers claim an index. Bounded
  by `Math.min(4, candidates.length)`. Candidates are gathered across the whole
  page; the per-ROW writes then run sequentially AFTER the drain, which is what
  makes the two-attachment row produce exactly one `annotateMessage`.
- **429 detection** uses the plan's string-tolerant compare verbatim
  (`Number(e.code)`, `e.status === 429 || code === 20429`). Backoff 1s/2s/4s
  through the injected `sleep`; a fourth throttle yields `skippedThrottled` and
  continues. Every OTHER thrown error propagates and aborts the run.
- **`vendorCalls` counts ATTEMPTS**, throttled ones included - it is "Twilio
  reads performed". The dry-run test pins the single-attempt case at 1.
- **`setContentType` sits inside the `dryRun` guard**; staging and the
  `recovered` histogram happen either way, so a dry run reports the full picture.

## Deviations beyond C1

Three judgement calls the plan left open. None changes a test.

1. **The four injected clients are REQUIRED parameters, not optional-with-
   defaults.** `backfill-media-pointers.ts` makes its `doc`/`messagesRepo`
   optional and falls back to `getDocumentClient()`. This script must not: the
   whole point of the account guard is that the writes go through clients bound
   to `hcCredentials()`, and an optional parameter with a default-chain fallback
   is precisely the "guard passes on one account while the writes go to another"
   failure the plan calls out as worse than no guard. `dryRun`, `env` and `sleep`
   stay optional.

2. **A `setContentType` failure PROPAGATES and aborts the run.** The counter list
   is closed and has no bucket for it, and by that point the account guard and
   the bucket resolution have already succeeded - so a failure there is systemic
   (credentials, bucket, permissions) far more often than per-object, and should
   stop the run loudly. It is safe to abort: no row write has happened for that
   page yet, an already-copied object is harmless while its row still says
   octet-stream, and re-copying is idempotent. Documented at the call site.

3. **A media URL that parses to no `ME<32 hex>` SID counts as `skippedNoUrl`.**
   The counter list has no "unparseable URL" bucket, and `skippedNoUrl`'s
   semantics - "no usable Twilio media URL at that index" - covers absent,
   out-of-range and malformed identically. Documented on the counter.

Two row-level ordering choices, both matching the plan's item 6 ordering, worth
naming because they are visible in the histogram:

- A legacy row (`media_s3_keys`, no `media_attachments`) is counted
  `skippedLegacyRow` REGARDLESS of direction: it names an unrepairable storage
  shape, not a rejected candidate.
- `direction` is checked BEFORE `mediaUrls`, so an OUTBOUND row with attachments
  and no `mediaUrls` (the normal outbound shape) is a plain skip and does NOT
  inflate `skippedEmailRow`.

## Surprises

**None.** Every anchor in the brief and the worklist held byte-exact:
`backfill-media-pointers.ts`'s opts bag (`:40-47`), scan loop (`:55-75`) and CLI
tail (`:80-97`); `import-apply.ts`'s hcAws import (`:29-34`) and guarded doc
client (`:248-257`); `messagesRepo`'s `annotateMessage` best-effort pointer
try/catch (`:2544-2550`); `createMessagesRepo`'s `RepoDeps`. The C1 correction
was confirmed independently against `messaging.ts:1162-1193` and
`config.ts:618,623-629` before being implemented.

The `messagesRepo` constructor needed no deps I could not satisfy - `{ doc }` is
sufficient and is the existing sibling backfill's exact call.

## What the next slice needs to know

- The operator env requirements (worklist C7) are now WRITTEN INTO THE SCRIPT in
  two places: the module docblock's run section and the `HOW_TO_FIX` string the
  guard prints. Task 8's RUNBOOK entry should match them:
  `MESSAGING_DRIVER=twilio` + `TWILIO_ACCOUNT_SID` / `TWILIO_API_KEY_SID` /
  `TWILIO_API_KEY_SECRET` / `TWILIO_AUTH_TOKEN` / `TWILIO_MESSAGING_SERVICE_SID`
  + `MEDIA_BUCKET` + `TABLE_PREFIX` for the target env, plus the `housingchoice`
  AWS profile.
- Invocation is `npx tsx app/scripts/backfill-media-content-types.ts [--dry-run]`
  - no npm script, matching every other backfill.
- `--dry-run` still READS the live Twilio account (one metadata fetch per
  candidate). The done-line says so and the report carries `vendorCalls`.
- The three refusal paths all exit non-zero BEFORE scanning: bad
  `MESSAGING_DRIVER`/credentials, a `loadConfig` throw, and an unset
  `MEDIA_BUCKET`. "Nothing recovered" is a WARN, not an exit code.
