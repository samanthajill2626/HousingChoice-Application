# Slice S7 report - dashboard API layer + gate-2 static catalogs (plan Task 7)

2026-09-27, `feat/voicemail-greeting`, implementer Claude Opus 5.5 (1M context). Commit `fb58551a`:
`VoicemailGreeting` mirror + `OrgSettings.voicemailGreeting?` (SettingsPatch Omits it), an additive
`rawBody`/`headers` option on the ONE `requestWithStatus` fetch, the three greeting helpers, and the
perf catalogs (2 mutations, count 110; Voice-tab GETs; 2 templates; 2 citations). Only the 9 named files.

## Gates (run bare from the worktree)

- RED (new file): `Test Files  1 failed (1)` / `Tests  5 failed (5)`. x4 `TypeError: (0 ,
  uploadVoicemailGreeting) is not a function` (and remove/audioUrl); guard: `expected [Function] to
  throw error including 'mutually exclusive' but got 'Network request failed'`. Gate-2 RED after the
  API, before the catalog edit: `expected [ Array(110) ] to have a length of 108 but got 110` - the scan
  did NOT throw, so the rewritten fetch is still the recognized delegated one (N12).
- GREEN dashboard `npx vitest run src/api`: `Test Files  10 passed (10)` / `Tests  125 passed (125)`.
- GREEN e2e `mutationCatalog.test.ts routes.test.ts`: `Test Files  2 passed (2)` / `Tests  28 passed
  (28)` (non-delegated mutations = 110). Whole `npx vitest run performance` (every importer of
  routes/templates/mutationCatalog: cli, collect, firewall, redact, report, selfQa; no `support/**`
  importer): `Test Files  17 passed (17)` / `Tests  471 passed (471)` = the pre-edit baseline.
- Root `npm run typecheck` exit 0 (5 workspaces). eslint on the 9 files: exit 0, no output (nothing new,
  nothing pre-existing). ASCII: 0 non-ASCII bytes in the 80 added diff lines; new test file 0.

## Deviations from plan Task 7 (otherwise the plan's code)

1. SettingsPatch JSDoc: kept the existing text (its pre-existing em-dash line untouched) and APPENDED
   the plan's `voicemailGreeting` sentence instead of replacing the comment, which would have dropped
   "revert to the built-in default ... Every other field keeps its OrgSettings type" (types.ts is
   additive-only). The type expression is exactly the plan's.
2. F5 applied (VoicemailGreeting between the banner and OrgSettings' JSDoc); F6 applied - the added
   count-comment line is wrapped over two lines to match its neighbours (text unchanged).
3. N13: `dashboard/src/api/index.ts` untouched (`export *` barrel) and dropped from the `git add`.
4. noteServerDate: the plan's `vi.spyOn(serverClock, 'noteServerDate')` form WORKS as written (vitest
   3.2.6 spies the SSR export getter; client.ts reads the binding at call time); N14's fallback unused.
   The spy calls through; the offset it leaves is file-local (default per-file isolation).
5. Plan silent: `VoicemailGreeting` goes after `SettingsResponse` in endpoints.ts' type import list.

## Surprising / worth knowing (for S8/S9)

6. Until S8 lands, VOICE_GETS requires `/api/settings`, which the Voice tab does not fetch yet, and both
   citations name `useVoicemailGreeting.ts`, not yet created; the static gates check format only, so
   they are green. Only a human-invoked `perf:pages` run could see the gap.
7. VOICE_TERMINAL's populated alternative is `[text 'Your cell', status role_only]`: after S8 the
   block's role="status" lines can satisfy the `status` half at load. Harmless to static gates.
