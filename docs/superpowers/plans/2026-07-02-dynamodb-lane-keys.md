# DynamoDB Local Per-Lane Write Isolation (drop `-sharedDb` + per-lane access keys) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every e2e lane and every worktree's Vitest run its own DynamoDB Local *database* (not just its own table prefix) so concurrent suites stop serializing through one SQLite write lock.

**Architecture:** Drop `-sharedDb` from the `hc-dynamodb-local` container. Without it, DynamoDB Local keys each in-memory store by **(accessKeyId, region)** — so injecting a per-lane `AWS_ACCESS_KEY_ID` (`hclane<L>`, next to the `TABLE_PREFIX` the launcher already injects) gives each lane its own database and its own write lock. Vitest integration suites get a per-worktree key (`hctest<hash>`) the same way. Lane 0 (`npm run dev -- --local`) keeps working unchanged on the existing `'local'` credential fallback in `app/src/lib/dynamo.ts`.

**Tech Stack:** Node ESM scripts (`scripts/*.mjs`, `e2e/support/lane.mjs`), Vitest, Playwright, Docker (amazon/dynamodb-local), AWS SDK v3.

## Context — decision + empirical validation (2026-07-02)

- **Decision (founder-approved, do not relitigate):** all worktrees share ONE container started with `-sharedDb -inMemory`; `-sharedDb` puts every lane in one SQLite database → one writer at a time → container pins ~105% CPU (one core) under two concurrent suites and 5s-budget integration tests + heavy e2e queries time out. Fix = drop `-sharedDb` + per-lane keys. Registry issue: `docs/issues/dynamodb-local-cross-worktree-test-contention.md` (lands on main with the `feat/tours-sequence` merge — see Task 7).
- **Validated on a throwaway container** (`:8102`, `-inMemory`, no `-sharedDb`, then removed — the shared container was never touched):
  - Tables created under key A are invisible under key B (ListTables under B = `[]`; same-name CreateTable under B succeeds; scans see only each key's own items).
  - Concurrent write bursts under two keys both complete fully (2×200 puts in ~790ms).
  - **Key format is validated once `-sharedDb` is off:** `hc-lane-1` and `hc_lane_1` are REJECTED (`UnrecognizedClientException`); alphanumeric keys (`hclane1`, `local`, `HcLane1`) are accepted. Hence `hclane<L>`, not the originally-suggested `hc-lane-<L>`.
  - **Region is part of the store identity:** the same key under a different region is a separate, empty store. All in-repo clients default to `us-east-1` (`config.awsRegion` ← `AWS_REGION ?? 'us-east-1'`), and the e2e launcher pins it explicitly (Task 3) so an ambient `AWS_REGION` can't split a lane's data.

## Audit summary (who talks to DynamoDB Local, and with what creds)

- **Single client factory:** `app/src/lib/dynamo.ts` — when `DYNAMODB_ENDPOINT` is set, creds = `process.env.AWS_ACCESS_KEY_ID ?? 'local'` / `AWS_SECRET_ACCESS_KEY ?? 'local'`. App, worker, `app/scripts/db-create.ts`, `db-seed.ts`, `backfillConsentMethod.ts`, and every integration suite go through it. Setting env vars on a process is sufficient; no call-site changes needed.
- **e2e specs/fixtures never touch DynamoDB directly** (verified by grep — `e2e/` has zero aws-sdk/dynamo imports); they drive HTTP (`/api`, `/__dev/*`, fake-twilio). Only the session launcher's children (app, worker, db-create, db-seed) need the key.
- **MinIO is unaffected:** `mediaStore.ts` / `s3-create.ts` pin their own fixed `LOCAL_S3_ACCESS_KEY` credentials explicitly — injecting `AWS_ACCESS_KEY_ID` does not leak into S3 clients.
- **Nothing depends on cross-key visibility:** no tool scans another lane's tables; `db.mjs` readiness probe is a bare HTTP fetch (key-agnostic); `e2e/support/preflight.ts` is HTTP-only; `scripts/wipe-dev-data.mjs`/`hcAws.mjs` target real AWS via named profile (no `DYNAMODB_ENDPOINT`), untouched.
- **Live modes untouched:** `npm run dev` (live) and deployed envs have no `DYNAMODB_ENDPOINT`, so `dynamo.ts` uses the SDK default chain — none of this plan's env injection reaches them.
- **Docs that mention `-sharedDb` / local inspection:** `README.md:159` + the `README.md:163-170` PowerShell snippet; `e2e/README.md` lane section. RUNBOOK.md has no local-DynamoDB inspection content (verified).

## Global Constraints

- Access keys must be **alphanumeric only** (DynamoDB Local rejects `-`/`_` in keys once `-sharedDb` is off): lane key = `hclane<L>`, Vitest key = `hctest<base36hash>`, lane-0/dev key = existing `'local'` fallback.
- Container name (`hc-dynamodb-local`), port (`:8000`), and `-inMemory` are unchanged. Only `-sharedDb` is dropped.
- **Recreating the container wipes every lane's in-memory tables.** Execution (any step that runs `ensureDbStarted` after Task 2 — i.e. any `npm run e2e*` / `npm run dev -- --local`) must happen at a coordinated quiet moment: every active worktree runs `npm run e2e:stop` first, and each stack reseeds afterward. `npm test` does NOT bounce the container (it only connects to whatever is running).
- Env injection is **forced** (no `??` fallback) in the e2e launcher — ambient shell `AWS_*` vars would silently merge lanes back into one database. The hermetic stack touches no real AWS, so forcing is safe there. Vitest injection is respect-if-set (repo convention: an externally-set value still wins).
- Keep the `testTimeout: 15_000` mitigation (arrives on main with `feat/tours-sequence`) — belt-and-braces, not superseded by this fix.
- Branch: `feat/dynamodb-lane-keys`, worktree `w:/tmp/hc-lane-keys`. Never touch the main checkout; never merge to main without explicit human approval. Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `lane.mjs` — per-lane + per-worktree access keys (TDD)

**Files:**
- Modify: `e2e/support/lane.mjs` (add `laneAccessKeyId`, `testAccessKeyId`, `accessKeyId` in both `resolveLane` return objects)
- Modify: `e2e/support/lane.d.ts` (type the new field + functions)
- Test: `app/test/lane.test.ts` (extend the existing suite)

**Interfaces:**
- Consumes: existing `djb2(s)`, `worktreeIdentity()` internals of `lane.mjs`.
- Produces: `LaneResult` gains `accessKeyId: string` (e.g. `"hclane3"`); new exports `laneAccessKeyId(lane: number): string` and `testAccessKeyId(): string` (e.g. `"hctest1a2b3c"`, deterministic per worktree). Task 3 reads `laneJson.accessKeyId`; Task 4 imports `testAccessKeyId`.

- [ ] **Step 1: Write the failing tests** — append to the end of the top-level `describe('lane.mjs', …)` block in `app/test/lane.test.ts`:

```ts
  // -------------------------------------------------------------------------
  // 9. Per-lane / per-worktree DynamoDB Local access keys
  // -------------------------------------------------------------------------

  describe('access keys (per-lane DynamoDB Local databases)', () => {
    it('laneAccessKeyId is hclane<L> — alphanumeric only (DynamoDB Local rejects - and _)', async () => {
      const { laneAccessKeyId, MAX_LANES } = await getLane();
      for (let l = 1; l <= MAX_LANES; l++) {
        const key = laneAccessKeyId(l);
        expect(key).toBe(`hclane${l}`);
        expect(key).toMatch(/^[A-Za-z0-9]+$/);
      }
    });

    it('resolveLane returns accessKeyId matching the lane (E2E_LANE override branch)', async () => {
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = '4';
      const result = await resolveLane({ probe: allFreeProbe });
      expect(result.accessKeyId).toBe('hclane4');
    });

    it('resolveLane returns accessKeyId matching the lane (free-probe branch)', async () => {
      const { resolveLane } = await getLane();
      delete process.env['E2E_LANE'];
      const result = await resolveLane({ probe: allFreeProbe });
      expect(result.accessKeyId).toBe(`hclane${result.lane}`);
    });

    it('testAccessKeyId is deterministic, alphanumeric, and never collides with a lane key', async () => {
      const { testAccessKeyId } = await getLane();
      const key = testAccessKeyId();
      expect(testAccessKeyId()).toBe(key); // stable across calls
      expect(key).toMatch(/^hctest[a-z0-9]+$/);
      expect(key.startsWith('hclane')).toBe(false);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `w:/tmp/hc-lane-keys`): `npx vitest run test/lane.test.ts -w @housingchoice/app` — if workspace flag routing is awkward, `cd app && npx vitest run test/lane.test.ts`.
Expected: the 4 new tests FAIL (`laneAccessKeyId is not a function` / `accessKeyId` undefined); all pre-existing lane tests still PASS.

- [ ] **Step 3: Implement in `e2e/support/lane.mjs`** — insert after the `hashToLane` function (before the Free-probe section):

```js
// ---------------------------------------------------------------------------
// Per-lane / per-worktree DynamoDB Local access keys
// ---------------------------------------------------------------------------
// Without -sharedDb, DynamoDB Local keeps a SEPARATE database (and SQLite
// write lock) per (accessKeyId, region) pair — that is the whole isolation
// mechanism (docs/issues/dynamodb-local-cross-worktree-test-contention.md).
// Keys MUST be alphanumeric: once -sharedDb is off the key is validated and
// '-' or '_' raise UnrecognizedClientException (verified 2026-07-02 against a
// throwaway container). Lane 0 (npm run dev -- --local) is NOT named here —
// it rides the 'local' credential fallback in app/src/lib/dynamo.ts.

/**
 * The DynamoDB Local access key for an e2e lane — its own local database.
 * @param {number} lane
 * @returns {string} e.g. "hclane3"
 */
export function laneAccessKeyId(lane) {
  return `hclane${lane}`;
}

/**
 * The DynamoDB Local access key for THIS worktree's Vitest integration runs —
 * isolated from every e2e lane (different prefix) and from other worktrees
 * (identity-hashed). Deterministic per worktree, alphanumeric (base36).
 * @returns {string} e.g. "hctest1a2b3c"
 */
export function testAccessKeyId() {
  return `hctest${djb2(worktreeIdentity()).toString(36)}`;
}
```

Then add `accessKeyId` to BOTH `resolveLane` return objects:

```js
    // E2E_LANE override branch:
    return {
      lane: n,
      ports,
      tablePrefix: `hc-local-${n}-`,
      mediaBucket: `hc-local-media-${n}`,
      accessKeyId: laneAccessKeyId(n),
    };
```

```js
      // free-probe branch:
      return {
        lane,
        ports,
        tablePrefix: `hc-local-${lane}-`,
        mediaBucket: `hc-local-media-${lane}`,
        accessKeyId: laneAccessKeyId(lane),
      };
```

Update the `LaneResult` typedef comment above `resolveLane`:

```js
/**
 * @typedef {{ lane: number, ports: { app: number, dashboard: number, fake: number, publicBase: number }, tablePrefix: string, mediaBucket: string, accessKeyId: string }} LaneResult
 */
```

- [ ] **Step 4: Update `e2e/support/lane.d.ts`** — in `LaneResult` add after `mediaBucket`:

```ts
  /** DynamoDB Local access key = this lane's own local database, e.g. "hclane3" */
  accessKeyId: string;
```

and at the bottom (internal exports section):

```ts
/** Per-lane DynamoDB Local access key: "hclane<L>" (alphanumeric only). */
export function laneAccessKeyId(lane: number): string;

/** Per-worktree DynamoDB Local access key for Vitest runs: "hctest<base36>". */
export function testAccessKeyId(): string;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd app && npx vitest run test/lane.test.ts`
Expected: ALL lane tests PASS (old + 4 new).

- [ ] **Step 6: Typecheck** — `npm run typecheck -w @housingchoice/app`. Expected: clean. (The repo has a known `.d.mts`-sync foot-gun for `.mjs` declarations; `lane.d.ts` already typechecks today for `lane.test.ts`, so extending both files keeps the working pattern. If the new exports are invisible to TS, mirror the two signatures the same way the file already declares `portsForLane`.)

- [ ] **Step 7: Commit**

```bash
git add e2e/support/lane.mjs e2e/support/lane.d.ts app/test/lane.test.ts
git commit -m "feat(e2e): per-lane + per-worktree DynamoDB Local access keys in lane resolver

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `scripts/db.mjs` — drop `-sharedDb` + auto-recreate a stale container (TDD for the pure check)

**Files:**
- Modify: `scripts/db.mjs`
- Test: `app/test/dbArgs.test.ts` (new — tiny, pure)

**Interfaces:**
- Produces: `containerArgsAreStale(args: string[]): boolean` exported from `scripts/db.mjs` (pure, unit-testable); `ensureDbStarted()` behavior change — a container created with `-sharedDb` is removed and recreated (LOUD log) instead of reused.

- [ ] **Step 1: Write the failing test** — create `app/test/dbArgs.test.ts`:

```ts
// Unit test for the pure stale-container check in scripts/db.mjs.
// (The docker lifecycle itself is exercised by the boot verification gates.)
import { describe, expect, it } from 'vitest';
import { containerArgsAreStale } from '../../scripts/db.mjs';

describe('containerArgsAreStale', () => {
  it('flags the legacy -sharedDb container for recreation', () => {
    expect(containerArgsAreStale(['-jar', 'DynamoDBLocal.jar', '-sharedDb', '-inMemory'])).toBe(true);
  });

  it('accepts the new per-key container args', () => {
    expect(containerArgsAreStale(['-jar', 'DynamoDBLocal.jar', '-inMemory'])).toBe(false);
  });

  it('tolerates empty/unknown args (docker inspect edge cases)', () => {
    expect(containerArgsAreStale([])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/dbArgs.test.ts`
Expected: FAIL — `containerArgsAreStale` is not exported.

(If vitest/TS balks at importing `../../scripts/db.mjs` without a declaration: add `scripts/db.d.mts` — NOT `.d.ts` — declaring `export function containerArgsAreStale(args: string[]): boolean; export function ensureDbStarted(): Promise<void>; export function stopDb(): Promise<void>; export declare const CONTAINER_NAME: string; export declare const LOCAL_ENDPOINT: string;`, mirroring the repo's existing `secretsCore.d.mts` pattern, and keep it in sync.)

- [ ] **Step 3: Implement in `scripts/db.mjs`**

Add the pure check + an args inspector, and rework `ensureDbStarted`:

```js
/**
 * True when an existing container was created with the legacy -sharedDb flag
 * (one SQLite database + ONE write lock shared by every lane — the structural
 * contention fixed by per-lane access keys; see
 * docs/issues/dynamodb-local-cross-worktree-test-contention.md). Such a
 * container must be recreated: docker start would resurrect the old args.
 * @param {string[]} args
 */
export function containerArgsAreStale(args) {
  return args.includes('-sharedDb');
}

/** JVM args the container was created with (docker inspect .Args). */
async function containerArgs() {
  const { stdout } = await docker('inspect', '--format', '{{json .Args}}', CONTAINER_NAME);
  return JSON.parse(stdout.trim());
}
```

Replace the body of `ensureDbStarted` (keep `assertDaemonUp`/`waitForEndpoint` as-is):

```js
/** Idempotent start: running -> no-op; stopped -> start; absent -> run.
 *  A legacy -sharedDb container is removed + recreated (WIPES its in-memory
 *  tables — every lane/dev stack must reseed; sequenced in the rollout note of
 *  docs/superpowers/plans/2026-07-02-dynamodb-lane-keys.md). */
export async function ensureDbStarted() {
  await assertDaemonUp();
  let state = await containerState();
  if (state !== 'absent' && containerArgsAreStale(await containerArgs())) {
    console.warn(
      `db:start — ${CONTAINER_NAME} was created with the legacy -sharedDb flag; ` +
        'recreating it WITHOUT -sharedDb (per-access-key databases). ' +
        'ALL in-memory tables are wiped — every lane/dev stack must reseed.',
    );
    await docker('rm', '-f', CONTAINER_NAME);
    state = 'absent';
  }
  if (state === 'running') {
    console.log(`db:start — ${CONTAINER_NAME} already running`);
  } else if (state === 'stopped') {
    console.log(`db:start — starting existing container ${CONTAINER_NAME}`);
    await docker('start', CONTAINER_NAME);
  } else {
    console.log(`db:start — creating container ${CONTAINER_NAME} (in-memory; data resets on stop)`);
    await docker(
      'run', '-d', '--name', CONTAINER_NAME, '-p', '8000:8000',
      'amazon/dynamodb-local', '-jar', 'DynamoDBLocal.jar', '-inMemory',
    );
  }
  await waitForEndpoint(LOCAL_ENDPOINT);
  console.log(`db:start — DynamoDB Local ready at ${LOCAL_ENDPOINT}`);
}
```

Also update the file-top comment block: `-sharedDb` is gone; each (accessKeyId, region) pair now gets its own database — lanes inject `hclane<L>`, Vitest injects `hctest<hash>`, dev rides `'local'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run test/dbArgs.test.ts`
Expected: PASS (3/3). **Do NOT run anything that calls `ensureDbStarted` yet** — that bounces the shared container (rollout-gated; see Verification, Task 6).

- [ ] **Step 5: Commit**

```bash
git add scripts/db.mjs app/test/dbArgs.test.ts
git commit -m "feat(db): drop -sharedDb — per-access-key DynamoDB Local databases; auto-recreate legacy container

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Include `scripts/db.d.mts` in the add if Step 2's fallback was needed.)

---

### Task 3: `scripts/e2e-session.mjs` + `e2e/playwright.config.ts` — inject the lane key into ALL children

**Files:**
- Modify: `scripts/e2e-session.mjs` (destructure `accessKeyId`; force `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` in `childEnv`; write `accessKeyId` into `lane.json`)
- Modify: `e2e/playwright.config.ts` (extend the inline `laneJson` type)

**Interfaces:**
- Consumes: `laneJson.accessKeyId` from Task 1 (the launcher already runs `lane.mjs` via `execFileSync` and parses JSON).
- Produces: every child (app, worker, db-create, db-seed via `runOnce`, fake-twilio, Vite — all spawn with `childEnv`) sees the lane's key; `e2e/.artifacts/lane.json` gains `"accessKeyId"` for humans/tools inspecting a lane's data.

- [ ] **Step 1: Destructure the key** — in `scripts/e2e-session.mjs` change:

```js
const { lane, ports, tablePrefix, mediaBucket } = laneJson;
```

to:

```js
const { lane, ports, tablePrefix, mediaBucket, accessKeyId } = laneJson;
```

- [ ] **Step 2: Persist it in the lane state file** — in the `writeFileSync(laneFile, …)` object, after `mediaBucket`:

```js
      mediaBucket,
      accessKeyId,
```

- [ ] **Step 3: Force the creds into `childEnv`** — insert directly after the `TABLE_PREFIX: tablePrefix,` line:

```js
  // Per-lane DynamoDB Local DATABASE (not just table prefix): without
  // -sharedDb the store is keyed by (accessKeyId, region), so this key is
  // what gives the lane its own SQLite write lock — see
  // docs/issues/dynamodb-local-cross-worktree-test-contention.md.
  // FORCED, no ?? fallback: an ambient shell AWS_ACCESS_KEY_ID would silently
  // merge every lane back into ONE database. Safe to force — the hermetic
  // stack never touches real AWS (MinIO clients pin their own fixed creds,
  // and DynamoDB Local ignores the secret's value). AWS_REGION is pinned
  // because the region is part of the store identity: a drifting region
  // would silently point the same key at a different, empty database.
  AWS_ACCESS_KEY_ID: accessKeyId,
  AWS_SECRET_ACCESS_KEY: 'local',
  AWS_REGION: 'us-east-1',
```

- [ ] **Step 4: Log it** — extend the existing lane log line in `main()`:

```js
  log(`tablePrefix=${tablePrefix} mediaBucket=${mediaBucket} accessKeyId=${accessKeyId}`);
```

- [ ] **Step 5: Type the new field in `e2e/playwright.config.ts`** — extend the inline cast:

```ts
const laneJson = JSON.parse(execFileSync(process.execPath, [laneMjs], { encoding: 'utf8' }).trim()) as {
  lane: number;
  ports: { app: number; dashboard: number; fake: number; publicBase: number };
  tablePrefix: string;
  mediaBucket: string;
  accessKeyId: string;
};
```

(No further config change: the webServer passes `E2E_LANE`, the session re-resolves the lane — key included — via `resolveLane`'s env-override branch, so config and session cannot disagree. Specs never touch DynamoDB directly.)

- [ ] **Step 6: Static checks** — `npm run typecheck -w @housingchoice/app` (and `node --check scripts/e2e-session.mjs` for a cheap syntax gate). Expected: clean. Do NOT boot the stack yet (container bounce is rollout-gated).

- [ ] **Step 7: Commit**

```bash
git add scripts/e2e-session.mjs e2e/playwright.config.ts
git commit -m "feat(e2e): inject per-lane AWS access key into every session child

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `app/vitest.config.ts` — per-worktree key for `npm test`

**Files:**
- Create: `app/vitest.config.ts` (does not exist on this base; `feat/tours-sequence` adds one with `testTimeout: 15_000` — we include the same setting so the eventual merge is trivial and the mitigation is kept either way)

**Interfaces:**
- Consumes: `testAccessKeyId()` from Task 1 (`../e2e/support/lane.mjs` relative to `app/`).
- Produces: every Vitest worker (unit + integration suites — they all read creds via `app/src/lib/dynamo.ts` → `process.env`) runs under `hctest<hash>`, isolated from every e2e lane (`hclane*`), from the dev loop (`local`), and from other worktrees (identity hash). Respect-if-set: an explicitly exported `AWS_ACCESS_KEY_ID` still wins (repo convention), which also lets a human point vitest at a specific store deliberately.

**Why per-worktree (not per-run):** the suites already use throwaway `hc-test-<uuid>-` table prefixes per run and drop their tables in `afterAll`, so per-run DATA isolation exists today; the missing piece is the per-worktree write lock. A per-run key would also strand every crashed run's tables in an unreachable store until the next container bounce; a per-worktree key reuses one store whose leftovers stay inspectable (you know the key) and bounded. Two simultaneous `npm test` runs in the SAME worktree sharing one lock is the rare, acceptable case.

- [ ] **Step 1: Create `app/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import { testAccessKeyId } from '../e2e/support/lane.mjs';

// DynamoDB Local integration isolation. The shared local container serves a
// SEPARATE database (and SQLite write lock) per (accessKeyId, region) — see
// docs/issues/dynamodb-local-cross-worktree-test-contention.md. This config
// gives THIS worktree's vitest runs their own key (hctest<hash>), so `npm
// test` no longer serializes behind a neighboring worktree's e2e run (nor
// behind the dev loop's 'local' store). Respect-if-set: an explicitly
// exported AWS_ACCESS_KEY_ID still wins.
export default defineConfig({
  test: {
    // Timeouts under cross-worktree load are contention, never hangs — keep a
    // generous budget (belt-and-braces alongside the per-key isolation; this
    // mirrors the feat/tours-sequence mitigation and must survive the merge).
    testTimeout: 15_000,
    env: {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? testAccessKeyId(),
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
    },
  },
});
```

- [ ] **Step 2: Verify vitest picks it up and the app suite is green**

Run: `npm run test -w @housingchoice/app`
Expected: PASS. Integration suites behave per the CURRENT container state: against the still-running legacy `-sharedDb` container the key is simply ignored (creds unvalidated), so this is green both before and after the bounce — no broken mid-state. If no container is up, the suites self-skip (also green).

- [ ] **Step 3: Typecheck** — `npm run typecheck -w @housingchoice/app`. Expected: clean (the config imports `lane.mjs`, typed by `lane.d.ts` from Task 1; if TS refuses the `.mjs` import in this config context, the fallback is a `lane.d.mts` mirror per the repo's `secretsCore.d.mts` pattern — keep both in sync).

- [ ] **Step 4: Commit**

```bash
git add app/vitest.config.ts
git commit -m "feat(test): per-worktree DynamoDB Local access key + 15s budget for app vitest runs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Docs — README + e2e/README (inspection now needs the right key)

**Files:**
- Modify: `README.md` (hermetic-mode paragraph ~line 159; PowerShell inspection snippet ~lines 163-170)
- Modify: `e2e/README.md` (lanes table ~line 78; `lane.json` example ~line 115)

**Interfaces:** none (docs only). RUNBOOK.md verified to have no local-DynamoDB inspection content — no change there.

- [ ] **Step 1: README.md hermetic-mode paragraph** — replace line 159's container description:

Old:
```
**Hermetic mode** (`-- --local`, or whenever `DYNAMODB_ENDPOINT` is set) needs **Docker Desktop running** and (1) starts (or creates) the `hc-dynamodb-local` container (`amazon/dynamodb-local`, port 8000, `-sharedDb -inMemory`), (2) creates the 9 tables (`hc-local-*`), (3) writes idempotent seed data, then runs the same three processes. The integration test suite always uses DynamoDB Local.
```

New:
```
**Hermetic mode** (`-- --local`, or whenever `DYNAMODB_ENDPOINT` is set) needs **Docker Desktop running** and (1) starts (or creates) the `hc-dynamodb-local` container (`amazon/dynamodb-local`, port 8000, `-inMemory`), (2) creates the 9 tables (`hc-local-*`), (3) writes idempotent seed data, then runs the same three processes. The integration test suite always uses DynamoDB Local. The container runs **without `-sharedDb`**: each **(access key, region)** pair gets its own isolated database (and its own write lock) — the dev loop uses the `local` key, each e2e lane injects `hclane<L>`, and each worktree's vitest run injects `hctest<hash>`, so concurrent suites don't contend (see `docs/issues/dynamodb-local-cross-worktree-test-contention.md`).
```

- [ ] **Step 2: README.md inspection snippet** — replace lines 163-170:

Old:
```
Query DynamoDB Local from PowerShell (DynamoDB Local accepts any credentials — dummy values satisfy the CLI):

```powershell
$env:AWS_ACCESS_KEY_ID = 'local'; $env:AWS_SECRET_ACCESS_KEY = 'local'
aws dynamodb scan --table-name hc-local-contacts --endpoint-url http://localhost:8000 --region us-east-1 --no-cli-pager
```

(Or use a configured `--profile` instead of the env vars; the values never matter locally.)
```

New:
```
Query DynamoDB Local from PowerShell. **The access key selects WHICH database you see** (no `-sharedDb`): `local` = the `npm run dev -- --local` loop; `hclane<L>` = e2e lane L (find your lane's key in `e2e/.artifacts/lane.json` under `accessKeyId`); a vitest store uses that worktree's `hctest<hash>` key. The secret's value never matters; the region must stay `us-east-1` (it is part of the store identity).

```powershell
$env:AWS_ACCESS_KEY_ID = 'local'; $env:AWS_SECRET_ACCESS_KEY = 'local'   # dev loop; use 'hclane<L>' for an e2e lane
aws dynamodb scan --table-name hc-local-contacts --endpoint-url http://localhost:8000 --region us-east-1 --no-cli-pager
```

(A configured `--profile` also works, but remember: whatever key it carries picks the database — the wrong key shows an empty store, not an error.)
```

- [ ] **Step 3: e2e/README.md lane section** — replace line 78-79:

Old:
```
Each lane gets its own DynamoDB table prefix (`hc-local-<L>-`) and S3 bucket
(`hc-local-media-<L>`) — data never crosses between lanes.
```

New:
```
Each lane gets its own DynamoDB table prefix (`hc-local-<L>-`), its own S3 bucket
(`hc-local-media-<L>`), **and its own DynamoDB Local *database* via a per-lane
access key (`hclane<L>`)** — the shared container (no `-sharedDb`) keeps a
separate store + write lock per (access key, region) pair, so lanes never share
data OR write throughput. To inspect a lane's tables with the AWS CLI you must
use ITS key (see `accessKeyId` in `e2e/.artifacts/lane.json`); the `local` key
shows only the dev loop's store.
```

- [ ] **Step 4: e2e/README.md `lane.json` example** — add the field to the JSON sample (~line 115), after `"mediaBucket"` (read the file for the exact existing block and keep the surrounding lines intact):

```json
  "tablePrefix": "hc-local-1-",
  "mediaBucket": "hc-local-media-1",
  "accessKeyId": "hclane1"
```

- [ ] **Step 5: Commit**

```bash
git add README.md e2e/README.md
git commit -m "docs: per-access-key DynamoDB Local databases — inspection needs the lane's key

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Verification gates (THE CONTAINER BOUNCE HAPPENS HERE — coordinated quiet moment only)

**Files:** none created (a second throwaway worktree at `w:/tmp/hc-lane-keys-b` is added and removed).

**Rollout sequencing — do these IN ORDER, only after the operator confirms all in-flight e2e work is done:**

- [ ] **Step 1: Quiesce every consumer of the shared container.** In EVERY active worktree: `npm run e2e:stop`. Stop any running `npm run dev -- --local`. Confirm nothing is listening on lane ports (`docker stats` shows the dynamo container near-idle). The first `ensureDbStarted` after this point recreates the container and **wipes every lane's + dev's in-memory tables** (MinIO is untouched).

- [ ] **Step 2: Full app suite (also proves the vitest key path)** — `npm test` from the worktree root. Expected: all workspaces green.

- [ ] **Step 3: Single-lane full e2e** — `npm run e2e` in `w:/tmp/hc-lane-keys`. This triggers the legacy-container detection (watch for the LOUD `recreating it WITHOUT -sharedDb` warning on first boot), recreates the container, creates tables + seeds under `hclane<L>`, and runs the suite. Expected: green. Then `npm run e2e:stop`.

- [ ] **Step 4: Verify per-key stores exist as designed** — with the session from a fresh `npm run e2e:session` up (or right before the Step-3 stop):

```powershell
$env:AWS_SECRET_ACCESS_KEY = 'x'; $env:AWS_ACCESS_KEY_ID = (Get-Content e2e/.artifacts/lane.json | ConvertFrom-Json).accessKeyId
aws dynamodb list-tables --endpoint-url http://localhost:8000 --region us-east-1 --no-cli-pager
$env:AWS_ACCESS_KEY_ID = 'local'
aws dynamodb list-tables --endpoint-url http://localhost:8000 --region us-east-1 --no-cli-pager
```

Expected: the lane key lists `hc-local-<L>-*` tables; the `local` key lists a DIFFERENT (possibly empty) set — proof the stores are split. Stop the session after.

- [ ] **Step 5: Lane 0 still works** — confirm lane-0 ports (8080/5174) are free/coordinated first, then `npm run dev -- --local --seeded` from this worktree; wait for boot, then `curl http://127.0.0.1:8080/__dev/ping` → 200, open the dashboard, Ctrl-C. Expected: tables create + seed + serve under the `local` key with zero changes to the dev flow.

- [ ] **Step 6: THE DECISIVE GATE — two worktrees head-to-head.** Create a second throwaway worktree at the same commit (same branch can't be checked out twice, so detach):

```bash
git worktree add --detach /w/tmp/hc-lane-keys-b feat/dynamodb-lane-keys
cd /w/tmp/hc-lane-keys-b && npm install --no-audit --no-fund
```

Then run `npm run e2e` in BOTH worktrees **simultaneously** (two shells / background tasks) while watching `docker stats hc-dynamodb-local`. Expected: **both suites fully green, zero timeout flakes**; container CPU free to exceed ~100% during overlapping write bursts (two independent write locks — the old ceiling was a hard one-core pin). Optionally also run `npm test` in both concurrently: green. Afterward: `npm run e2e:stop` in both, then remove the throwaway:

```bash
git worktree remove /w/tmp/hc-lane-keys-b --force
```

- [ ] **Step 7: Notify neighbors to reseed.** Any worktree that had a live session before Step 1 must reboot its stack (`npm run e2e:session` reseeds itself); the dev loop reseeds via `npm run dev -- --local [--seeded]`. Report this in the completion summary.

---

### Task 7: Merge latest `main`, close out the registry issue, final green

**Files:**
- Modify: `docs/issues/dynamodb-local-cross-worktree-test-contention.md` (IF present on the merged base — it lands with `feat/tours-sequence`; do NOT create it if absent)
- Possibly merge-resolve: `app/vitest.config.ts` (tours adds the `testTimeout`-only version; keep OUR file — it contains both intents: `testTimeout: 15_000` AND the env injection)

- [ ] **Step 1: Merge main** — `git merge main` in the worktree. If `app/vitest.config.ts` conflicts, resolve to this branch's version (it is a superset: same `testTimeout` value + the key injection). Keep both sides' intent everywhere else. If deps changed on main, run `npm install`.

- [ ] **Step 2: Close the issue (if it merged in).** If `docs/issues/dynamodb-local-cross-worktree-test-contention.md` now exists: set frontmatter `status: resolved`, and append:

```markdown
**Resolution (2026-07-02, feat/dynamodb-lane-keys).** `-sharedDb` dropped from
`scripts/db.mjs` (legacy containers are detected via `docker inspect` args and
recreated with a loud warning). Each e2e lane now injects its own alphanumeric
access key (`hclane<L>`, from `e2e/support/lane.mjs` → `scripts/e2e-session.mjs`
childEnv, forced so ambient AWS_* can't re-merge lanes) and each worktree's
vitest run injects `hctest<hash>` (`app/vitest.config.ts`) — DynamoDB Local
keeps a separate database + SQLite write lock per (access key, region) pair,
validated empirically before implementation (including: keys must be
alphanumeric — `hc-lane-1` is rejected once `-sharedDb` is off — and region is
part of the store identity, so the launcher pins `AWS_REGION=us-east-1`).
Verified with two worktrees' full `npm run e2e` running head-to-head: zero
timeout flakes. The `testTimeout: 15_000` vitest budget is retained as
belt-and-braces. Inspection docs updated (README + e2e/README): the access key
now selects WHICH database you see.
```

If the file is NOT on the merged base, skip and hand this resolution note to the operator in the final report instead.

- [ ] **Step 3: Re-green on the updated base** — `npm test` and `npm run e2e` (full suite) both green against current main. "Green" only counts here.

- [ ] **Step 4: Commit + final report**

```bash
git add -A
git commit -m "docs(issues): resolve dynamodb-local-cross-worktree-test-contention — per-key databases shipped

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Report completion per branch-hygiene rules. **NEVER merge into `main` without explicit human approval.**
