# Task 1 report — Wire otel.ts to OTLP exporters (gated on endpoint env)

**Branch:** `feat/otlp-exporter-wiring` (worktree `w:/tmp/otlp-wiring`)
**Commit:** `e5a7690` — feat(observability): wire OTLP/HTTP trace + metric exporters, gated on OTEL_EXPORTER_OTLP_ENDPOINT
**Status:** DONE (one path deviation flagged below — justified, not a defect)

> Note: the previous contents of this file were a stale report from a different
> task (flexible-phone-entry) that reused this SDD filename. Overwritten with the
> OTLP-wiring report.

## What I implemented

`app/src/lib/otel.ts`:
- Extracted `buildOtelSdkConfig(env: NodeJS.ProcessEnv): Promise<Partial<NodeSDKConfiguration>>`
  — async, takes env as a parameter, does the dynamic imports, returns the NodeSDK
  options WITHOUT starting the SDK or touching the network. `startOtel()` now consumes it.
- **Endpoint SET (non-empty, trimmed):** config gains `traceExporter = new OTLPTraceExporter()`
  and `metricReader = new metrics.PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })`.
  Both exporters constructed with NO explicit url → they honor `OTEL_EXPORTER_OTLP_ENDPOINT`
  and append `/v1/traces` / `/v1/metrics` themselves.
- **Endpoint UNSET / empty / whitespace:** `endpointOf()` trims and coalesces to `undefined`;
  early `return config` before the exporter branch → neither `traceExporter` nor `metricReader`
  key is present. Exactly today's no-op export.
- **Malformed endpoint value** (e.g. `not a url`): guarded with `new URL(endpoint)` at the top of
  the try block. On throw we `console.error(...)` (pre-logger module) and fall back to the
  no-exporter config — boot never crashes. (A merely wrong/unreachable endpoint like
  `http://127.0.0.1:1` is a valid URL, constructs fine, and fails async inside the exporter — I
  verified the OTLP/HTTP exporters do NOT throw on construction for either malformed or unreachable
  values, so an explicit URL guard is what makes the fallback real and testable.)
- **`OTEL_SDK_DISABLED=true`:** unchanged early return in `startOtel()` before any dynamic import.
- `PeriodicExportingMetricReader` comes from `sdk-node`'s re-exported `metrics` namespace
  (`export * as metrics from '@opentelemetry/sdk-metrics'` — verified in the installed d.ts). No
  direct `@opentelemetry/sdk-metrics` dependency added.
- Lazy imports preserved: exporter packages are dynamically imported ONLY inside the endpoint-set
  branch. Verified the EMITTED JS has zero top-level `@opentelemetry` imports (the
  `import type { NodeSDKConfiguration }` is erased) → disabled path loads zero OTel packages.
- Removed both `TODO(otlp-exporter-wiring)` markers; rewrote the module header to describe the new
  behavior; added the sampler comment (default sampler kept; `OTEL_TRACES_SAMPLER` is the standard
  env seam, no sampling code).
- `serviceName` logic unchanged: `housingchoice-worker` if `HC_PROCESS === 'worker'` else
  `housingchoice-app`. Did not touch `app/src/index.ts` / `app/src/worker.ts`.

`app/package.json`: added `@opentelemetry/exporter-trace-otlp-http` and
`@opentelemetry/exporter-metrics-otlp-http` at `^0.219.0` (version-matched to `@opentelemetry/sdk-node`).
`package-lock.json` updated via root `npm install` (both now recorded as direct app deps).

## Tests

`app/test/otel.test.ts` (10 tests) + `app/test/helpers/otelBootChild.ts` (boot smoke child):
- endpoint SET → `traceExporter instanceof OTLPTraceExporter` AND `metricReader instanceof
  metrics.PeriodicExportingMetricReader` (reader `.shutdown()`ed to avoid a lingering timer).
- endpoint UNSET / EMPTY / WHITESPACE → no `traceExporter` / `metricReader` keys.
- endpoint MALFORMED → does not throw, logs (console.error spied + asserted `toHaveBeenCalledOnce`,
  which also keeps output pristine), falls back to no exporters.
- serviceName app vs worker per `HC_PROCESS`.
- `OTEL_SDK_DISABLED=true` → `startOtel()` resolves without starting the SDK.
- **Boots-in-both-modes child-process smoke test:** spawns `node --import tsx otelBootChild.ts`
  (cross-platform; a `.bin/tsx.cmd` shim is EINVAL under `spawnSync` on Windows), which awaits the
  REAL `startOtel()`, prints `OTEL_BOOT_OK`, exits 0 — once with the endpoint at an unreachable
  port (`http://127.0.0.1:1`) and once unset. Proves a bad endpoint fails async, never at boot,
  and the vitest process is never patched.

Tests build config only; none calls `sdk.start()` in-process.

### Commands + exit codes
- `npx vitest run test/otel.test.ts --root app` → **EXIT=0**, 10 passed.
- `npm run typecheck` (worktree root) → **EXIT=0** (all workspaces; app's build/scripts/test tsconfigs).
- `npm test -w app` → **EXIT=0**, **128 test files passed / 1 skipped; 1695 tests passed / 5 skipped; 0 failed** (my `test/otel.test.ts` included).

## TDD evidence

**RED** — `npx vitest run test/otel.test.ts --root app` before implementing `buildOtelSdkConfig`:
EXIT=1, 9 failed / 1 passed. Failing reason (expected): `TypeError: (0 , buildOtelSdkConfig) is not
a function` on every config test, and the boot tests failed because the tsx spawn was not yet
wired. This is the right failure — the function under test did not exist. (The `OTEL_SDK_DISABLED`
disabled-mode test already passed against the pre-existing `startOtel`.)

**GREEN** — after implementing: EXIT=0, 10 passed. (First GREEN attempt: 8/10 — the two boot tests
failed with `spawnSync ... tsx.cmd EINVAL`; diagnosed the Windows `.cmd` spawn issue and switched to
`node --import tsx <child.ts>` → 10/10. Then replaced the malformed-endpoint test's real
console.error with a spy for pristine output; still 10/10.)

## Files changed
- `app/src/lib/otel.ts` (wiring + `buildOtelSdkConfig`)
- `app/test/otel.test.ts` (new)
- `app/test/helpers/otelBootChild.ts` (new — boot smoke child)
- `app/package.json` (+2 exporter deps)
- `package-lock.json` (lockfile)

## Installed versions verified (no skew)
Resolved from `node_modules/@opentelemetry/*/package.json`:
- `@opentelemetry/sdk-node` = **0.219.0**
- `@opentelemetry/exporter-trace-otlp-http` = **0.219.0**
- `@opentelemetry/exporter-metrics-otlp-http` = **0.219.0**
- `@opentelemetry/instrumentation-http` = **0.219.0**
- `@opentelemetry/api` = **1.9.1**
- `@opentelemetry/sdk-metrics` = **2.8.0** (single copy; the stable line the 0.219.0 experimental
  packages all depend on — the exporters, sdk-node, and the re-exported `metrics` namespace all
  resolve to this one copy → no version skew)
- `@opentelemetry/core` = **2.8.0**

Both new exporter packages were already present as transitive deps of `sdk-node@0.219.0`, so adding
them as direct app deps introduced no new resolution and no duplicate copies.

## Self-review findings (fixed before commit)
- Boot smoke test originally spawned `.bin/tsx.cmd` → EINVAL on Windows `spawnSync`. Switched to
  `node --import tsx`. Fixed.
- Malformed-endpoint test emitted a real `console.error` line to suite output. Replaced with a
  `vi.spyOn(console,'error')` that both silences it and asserts the log fires. Output now pristine.
- Header comment referenced a non-existent `otel.boot.test.ts`; corrected to point at the smoke test
  at the bottom of the same file.
- Confirmed emitted JS has no top-level OTel import (disabled path loads zero packages).
- Confirmed the SET-mode test's `PeriodicExportingMetricReader.shutdown()` does not touch the
  network and clears the periodic timer (no open handle / no hang).

## Concerns / notes
1. **Test path deviation (justified).** The brief names `app/src/lib/otel.test.ts`, but ALL 128
   existing app tests live in `app/test/`, and `app/tsconfig.json` (the BUILD config) has
   `include: ["src"]` with `rootDir: "src"` — I verified empirically that a `src/lib/*.test.ts`
   file EMITS `dist/lib/*.test.js` on a real `npm run build`, shipping test code + a `vitest`
   runtime import into the production artifact. `app/tsconfig.test.json` exists specifically to
   typecheck `app/test/**` against `src`. Brief requirement 8 itself says "follow neighboring test
   file conventions" — every neighbor is in `app/test/`. So I placed the test at
   `app/test/otel.test.ts` (+ its child helper in `app/test/helpers/`). This is the correct reading
   of the conventions requirement; flagging it because the literal path differs.
2. **Dep change ⇒ `npm install` after merge** (already noted in the commit body and matches the
   design spec's callout). The lockfile is committed, but `node_modules` must be refreshed on merge.
3. `NodeSDKConfiguration.metricReader` carries a `@deprecated` JSDoc tag (favoring `metricReaders`),
   but the brief explicitly specifies `metricReader` and the installed NodeSDK still accepts it. No
   compile error; used as specified.
4. Stayed strictly inside the task file list — no touches to `.env*`, `infra/`, `docker-compose.yml`,
   RUNBOOK, or `docs/issues/` (Tasks 2 & 3). No deploy/secrets/terraform commands run.
