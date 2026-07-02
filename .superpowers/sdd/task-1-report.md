# Task 1 Report — Lane resolver module + unit tests

**Status:** DONE

---

## Files changed

| File | Action | Notes |
|---|---|---|
| `e2e/support/lane.mjs` | Created | Pure ESM resolver — resolveLane, defaultProbe, CLI mode, internal exports |
| `e2e/support/lane.d.ts` | Created | Hand-written TS types for all exports |
| `e2e/tsconfig.json` | Modified | Added `"allowJs": true`; expanded `include` to cover `support/**` |
| `app/test/lane.test.ts` | Created | 23 vitest unit tests (app workspace, runs in CI) |
| `app/tsconfig.test.json` | Modified | Added `"allowJs": true` + `"../e2e/support"` in `include` so the .d.ts resolves |

---

## Design decisions

- **Worktree identity:** uses `git rev-parse --absolute-git-dir` (per-worktree gitdir, not
  `--git-common-dir` which is shared). Falls back to the module's own directory.
- **Hash:** djb2 (unsigned 32-bit) → `(h % MAX_LANES) + 1` for [1..16]. No dependencies.
- **Free-probe:** `net.createServer().listen(port, host)` — real TCP bind attempt.
  Injectable via `opts.probe` for deterministic testing.
- **CLI detection:** compares `import.meta.url` to argv[1] normalized as a file URL
  (handles Windows backslash paths).
- **Test runner:** app workspace vitest (the e2e workspace has no vitest; app already has it
  and can import `../../e2e/support/lane.mjs` via a relative path).

---

## Test run (23/23 green)

```
vitest run --reporter=verbose app/test/lane.test.ts

 ✓ hash stability > djb2 is deterministic across calls for the same string
 ✓ hash stability > hashToLane always returns a value in [1, MAX_LANES]
 ✓ hash stability > hashToLane is stable across repeated calls for same identity
 ✓ hash stability > resolveLane returns the same lane on repeated calls (no env, no held ports)
 ✓ E2E_LANE override > honors E2E_LANE=3 and returns lane 3 without probing
 ✓ E2E_LANE override > returns correct ports for overridden lane
 ✓ E2E_LANE override > returns correct tablePrefix and mediaBucket for overridden lane
 ✓ E2E_LANE validation > rejects E2E_LANE=0 with a clear error mentioning lane 0 is forbidden
 ✓ E2E_LANE validation > rejects E2E_LANE=0 with a clear error
 ✓ E2E_LANE validation > rejects E2E_LANE=17 (above MAX_LANES)
 ✓ E2E_LANE validation > rejects E2E_LANE=-1 (negative)
 ✓ E2E_LANE validation > rejects E2E_LANE=abc (non-numeric)
 ✓ free-probe > bumps past a lane whose block has a held port (using a real TCP listener)
 ✓ free-probe > bumps using a real TCP listener on a computed port
 ✓ forbidden ports > lane 0 ports (8080/5174/8889/5173) never appear in any resolved block
 ✓ forbidden ports > 8000/9000 (DynamoDB/MinIO) never appear in any resolved block
 ✓ forbidden ports > no resolved block port is in the forbidden set [8080,5174,8889,5173,8000,9000]
 ✓ cap exceeded > throws a clear actionable error when all lanes are busy
 ✓ cap exceeded > error message mentions setting E2E_LANE
 ✓ portsForLane > lane 1 → 9101/9111/9121/9131
 ✓ portsForLane > lane 2 → 9201/9211/9221/9231
 ✓ portsForLane > lane 16 → 10601/10611/10621/10631
 ✓ portsForLane > all lanes produce tablePrefix and mediaBucket with lane number

Test Files: 1 passed (1)
Tests: 23 passed (23)
Duration: 663ms
```

## CLI output

```
node e2e/support/lane.mjs
{"lane":16,"ports":{"app":10601,"dashboard":10611,"fake":10621,"publicBase":10631},"tablePrefix":"hc-local-16-","mediaBucket":"hc-local-media-16"}
```

## Typecheck

```
npm run typecheck  →  all workspaces clean (0 errors)
```

---

## Concerns

None. The `app/tsconfig.test.json` change (adding `allowJs` + `../e2e/support` in `include`) is
scoped to the typecheck-only test config and does not affect the app build or src. The `.d.ts`
resolves correctly via NodeNext module resolution once `allowJs: true` is present.
