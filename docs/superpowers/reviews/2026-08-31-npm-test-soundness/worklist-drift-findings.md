> **FINDINGS HALF ONLY.** Extracted 2026-09-02 from `sdd/worklist.md`, which was 88%
> byte-exact quotation of the live tree at `file:line` (its own header says so). Only
> the DRIFT FLAGS section is kept. The reference half was not committed.

## 0. DRIFT FLAGS (read this section first)

### 0A. Plan/spec line cites that do NOT match the live tree

1. **`db-update-gsis.ts:188-191` is the wrong anchor for case 16.** Plan S1.1
   says "`ensureGsis`'s FIRST `DescribeTable` (inside `liveIndexNames`,
   `db-update-gsis.ts:188-191`)". Live, that send is at **:182**; `:188-191` is
   `liveIndexNames`' catch block:
   ```
   188:  } catch (err) {
   189:    if (err instanceof ResourceNotFoundException) return undefined;
   190:    throw err;
   191:  }
   ```
   The send is `182:    const { Table } = await client.send(new DescribeTableCommand({ TableName: physicalName }));`

2. **`logCallSiteGuard.test.ts:152` is not where the health `it` starts.** Plan
   S2.1 (and spec item 2) say `ts.getPreEmitDiagnostics` "runs in the first `it`
   at `:152`". Live the `it` opens at **:145**; the call is split over :152-153:
   ```
   145:  it('the real program is healthy: files resolved, no unresolved-module diagnostics', () => {
   152:    const unresolved = ts
   153:      .getPreEmitDiagnostics(gp.program)
   ```

3. **`testRunRegistry.ts:104` is the wrong line for the all-digit filter.** Plan
   S0 step 3.1 cites `:104`; live:
   ```
   103:    if (!/^\d+$/.test(name)) continue;
   104:    const pid = Number(name);
   ```

4. **The backstop filter is `:107-112`, not `:110-115`.** Plan S0 step 3.3 cites
   `:42-48`, `:110-115`. `:42-48` is right (docblock :43-47, const at :48). The
   age test is:
   ```
   107:    let expired = false;
   108:    try {
   109:      expired = nowMs - statSync(path.join(dir, name)).mtimeMs > MARKER_BACKSTOP_MS;
   110:    } catch {
   111:      continue; // Vanished between readdir and stat - a clean exit. Not live.
   112:    }
   114:    if (!expired && pidAlive(pid)) {
   ```

5. **`otherLiveRuns` is `:93-125`, not `:93-122`.** `93: export function
   otherLiveRuns(dir: string = RUN_REGISTRY_DIR, nowMs: number = Date.now()): number {`
   ... `124:  return live;` / `125: }`. The prune is `:117-121`.

6. **"the filename IS the pid (`:66`)" is one line off.** `:66` is
   `export function registerRun(dir: string = RUN_REGISTRY_DIR): () => void {`;
   the pid-named marker is `67:  const marker = path.join(dir, String(process.pid));`

7. **Spec item 3 cites the `HousingChoice` assertion at `staticSmoke.test.ts:41`;
   it is at `:42`.** (The PLAN says `:42` and is correct. Only the spec drifts.)

8. **Plan S3.1's `<div id="root">` site list mixes directions.** It says the
   fixture "MUST contain `<div id="root">` (`:108`, `:165`, `:85`)". Live, `:108`
   and `:165` are `toContain`; `:85` is `expect(unknown.text).not.toContain('<div id="root">')`
   and there is a FOURTH site, `:99`, also `not.toContain`, named nowhere in the
   plan or spec. The fixture must still carry the div (for :108/:165), but the
   two negatives constrain nothing about the fixture.

9. **`send`'s `UP_PATH_REGEXP` is tested at TWO sites, not one.** Spec cites
   `node_modules/send/index.js:61`, "tested at `:431`". Live: `:431` (rooted
   path) AND `:444` (unrooted). Installed version **1.2.1**, exactly ONE copy at
   `W:\tmp\npm-test-soundness\node_modules\send` (express declares `"send": "^1.1.0"`,
   serve-static `"send": "^1.2.0"`; both dedupe onto it).

10. **"~75 call sites" for `ensureTable` overstates the lexical count.** Live
    count of `ensureTable(` call sites (excluding the definition and all import
    lines) is **71, across 47 files, ALL under `app/`** - **0 in `e2e/`, 0 in the
    root `scripts/`**. `app/vitest.config.ts:101` says "~60". The RUNTIME count is
    much higher because 13 of the 71 are inside `for (const t of TABLES)` loops.
    The plan's ARGUMENT (do not tax the hot path) is unaffected; the NUMBER is not
    the one to ship in a comment.

11. **globalSetup's "test.env applies to workers" comment is `:90-92`, not
    `:90-91`.** Line 92 carries the operative half:
    ```
    90:  // Set the credentials so createDynamoClient() (called by createAllTables)
    91:  // picks up the right key. vitest test.env applies to workers, not globalSetup,
    92:  // so we must set process.env ourselves here (respect-if-set pattern).
    ```

12. **`vitest.config.ts`'s immunity comment is `:89-118`, not `:92-118`.** It
    opens `89:      // NO TTL REAPER IN TESTS. Services derive \`expires_at\` from their`.
    `:119` (`DYNAMO_DISABLE_TTL: '1',`) is correct.

13. **`ensureTable`'s catch is `:90-93`, not `:87-93`.** `:87` is `try {`.

14. **`accessKeyForTestFile`'s explicit-key return is `:120` alone.** `:118-119`
    are its comment. Its precondition is BOTH `!== undefined` and `!== ''`.

### 0B. Things the plan/spec do not mention that an implementer needs

15. **The SDK DOES export a constructible `InternalServerError` class**
    (`dist-types/models/errors.d.ts:33`, runtime `dist-es/models/errors.js:26-37`)
    with `name = "InternalServerError"`. **There is NO `InternalFailure` class
    anywhere in the SDK.** So case 8 can throw a REAL instance; every
    `InternalFailure` in the acceptance suite must be a hand-built object/Error
    whose `.name` is `'InternalFailure'`. The plan's "throws REAL exception
    INSTANCES" bullet names only `ResourceInUseException` /
    `ResourceNotFoundException`, so this asymmetry is undocumented.

16. **`client.config.endpoint` can be populated LAZILY, at command dispatch, from
    `AWS_ENDPOINT_URL` / `endpoint_url`** -
    `node_modules/@smithy/core/dist-cjs/submodules/endpoints/index.js:153-157`
    sets `clientConfig.endpoint = () => Promise.resolve(toEndpointV1(endpointFromConfig))`
    inside `getEndpointFromInstructions`, i.e. AFTER construction. A region-only
    client therefore reads `config.endpoint === undefined` at construction even on
    a box with `AWS_ENDPOINT_URL` set. Fail-closed handles it correctly, but case
    12 ("no endpoint provider") is the shape produced by BOTH a plain region-only
    client and an env-endpoint one, so the case does not distinguish them.

17. **`app/src/**/*.ts` carries an eslint `no-restricted-syntax` ban on
    `readFileSync`** (`eslint.config.mjs:74-91`, both `fs.readFileSync` and the
    named import). Anything added to `app/src/lib/dynamoAdmin.ts` must avoid it.

18. **`globalSetup` does not call `sweepLedgerResidue` directly.** It calls a
    local wrapper: `211:  await sweepPerFileResidue('globalSetup');` and the
    returned teardown is `213:  return async () => {` / `214:    await dropKeyedLocalTables();`
    / `215:    await sweepPerFileResidue('globalTeardown');`. The import at
    `globalSetup.ts:25` is `{ dropKeyedLocalTables, sweepLedgerResidue }`.

19. **`W:\tmp\npm-test-soundness\dashboard\dist` DOES NOT EXIST** (glob
    `dashboard/dist/**` returns nothing; `dashboard/` holds only `index.html`,
    `package.json`, `public`, `src`, `tsconfig.json`, `vite.config.ts`). So all
    **nine** `staticSmoke` `it`s currently skip. The plan's "~9" is exactly 9.

20. **`hookTimeout: 60_000` is set globally** (`app/vitest.config.ts:71`), which
    is why `logCallSiteGuard`'s `beforeAll` must pass its own `180_000`
    (`:143`). Any new budget must be an explicit third argument, not a config
    change.

21. **`app/test/dynamo.integration.test.ts:45-50` asserts `result` is `'created'`
    for EVERY spec in `TABLES`.** S1.3 must leave the fresh-table return value
    exactly `'created'`, or this beforeAll fails for all 22 tables.

22. **Exactly ONE concurrent `ensureTable` call site exists.** The plan's cite
    (`todayUnmatchedNonRegression.test.ts:107`) is CONFIRMED and is the only one -
    a multiline scan for `Promise.all(...ensureTable` across all `.ts` in the
    worktree returns that site alone.

23. **`unreadIndexRepo.integration.test.ts:729` also calls `waitUntilTableExists`**
    right after the `:728` `CreateTable` the plan says not to touch. Leave both.

---

