# Org settings layout - verification round 3 (final gates)

Date: 2026-10-07. Tip: `aae0ccd9` (the cloud agent's fix round 2:
`47938a54` the route pin and the phone spec's real overflow check, `601a2212`
the dashboard unit-test navigation waits, `aae0ccd9` the handback). The
changes since round 2 are test files plus one comment in
`e2e/performance/routes.ts`; the product code is the build verified live in
`live-check-r2.md`. Main is `20ccdb12` on `origin` and `github`, which is the
merge base, so the main sync is a no-op.

All five completion gates, run locally from this worktree on `aae0ccd9`:

| Gate | Result |
|---|---|
| 1. `npm run typecheck` | exit 0 |
| 2. `npm test` | exit 0: app 429/429 files, dashboard 229/229, e2e workspace 22/22, plus 34/34 and 13/13; no `[dynamoAdmin]` lines |
| 3. `npm run smoke` | exit 0 |
| 4. `npm run e2e` | **330 passed (20.4m), exit 0**, including the phone-width one-pane spec |
| 5. eslint on `main...HEAD`, 14 files | exit 0 |

Verdict: merge-ready. The merge itself is Cameron's call, including its
timing relative to branch B (`feat/caseworkers`). Merge notes for B are in
`handback.md`, plus the `orgSelection.ts` `RECORD_FIELDS` item in
`code-review-r1.md`.

Open items (follow-ups, not blockers):
- `docs/issues/perf-pages-settings-organizations-surface.md` still describes
  the old three-region terminal (noted in the handback; left alone).
- `mockups.html` stays until Cameron has compared it with the built page
  (ruling 4). The live-check records already compare the two.
- The pre-existing System tab spacing (quiet-hours Save button touching the
  "System status" heading), noted in the handback.
