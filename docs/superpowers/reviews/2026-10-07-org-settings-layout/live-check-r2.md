# Org settings layout - verification round 2 (after fix round 1)

Date: 2026-10-07. Tip: `c738055f` (the cloud agent's fix round 1:
`65c865e3` source and unit tests, `1a44e4ec` e2e, `c738055f` handback). Main
is `20ccdb12` on `origin` and `github` alike, which is the branch's merge base,
so the pre-merge main sync is a no-op.

## Code read

- F1: one page-level settle slot (`SettleGate`) is claimed synchronously
  through a ref, so a second request cannot slip in before a re-render. Every
  settle group locks while it is held, with a visible reason. `leaveForList`
  only runs while the settled value is still the one shown. A late failure
  goes to the page notice through `onFailedAway`.
- F2: `justAdded` holds only while `list.version` is still the version the
  entry was added to. It is cleared on Delete and Merge.
- F3: the row-focus fallback is the list heading, and a segment click keeps
  focus on its button. The post-action exit uses `replace: true` (M1).

## Live (hermetic lane 5, full profile, admin)

- **F2 fixed.** Add "Zeta Review Agency", Delete it, browser Back: no live
  panel and no "Delete Zeta Review Agency" button. A dead entry URL
  (`/settings/organizations/does-not-exist-123`) shows "Name not found".
- **F1 fixed.** With `POST /api/organizations/not-on-list/resolve` held 4s by
  a Playwright route:
  - Clear on "Partners for Home", then a forced second click, sent exactly
    one POST.
  - The radios and the confirm button were disabled, under "Settling this
    value - waiting for the answer."
  - Moving to "AHA" during the wait showed its radios disabled too (one
    settle at a time, across values).
  - When the late answer landed, the page stayed on AHA: no navigation away
    from the admin's new selection.

## Gates on c738055f (local)

| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | **exit 1**: app 429/429 files, dashboard 229/229, e2e-workspace unit tests 2 failed / 20 passed (below); no `[dynamoAdmin]` lines |
| `npm run smoke` | exit 0 (1612 specifiers, 281 files) |
| `npm run e2e` | 329 passed, 1 failed (19.7m); see below |
| gate 5 eslint, `main...HEAD`, 12 files | exit 0 |

**The e2e failure is not this branch's.** It was
`scheduled-visibility.spec.ts:226` (c): a contact page that never loaded (a
blank screenshot, and no app request for the page for the 10s wait). That
file passed alone twice (5/5). The previous full run at `9715c677` passed
329/329, and the only difference is org Settings code and `org-lists.spec.ts`.
The sighting is logged in
`docs/issues/e2e-scenario-specs-rotate-failures-full-suite.md` (open).
The new phone-width spec and the reload-race fix passed in that run.

## Gate 2 failures (this branch's, both small)

The cloud agent ran only the dashboard workspace's tests, so it missed these.
The e2e workspace's unit tests need no Docker.

1. `e2e/performance/routes.test.ts` "route registry completeness": the route
   pin in that test maps only the exact `/organizations` child to
   `/settings/organizations` (and excludes it from the profiler, issue
   `perf-pages-settings-organizations-surface`). The route is now
   `organizations/:orgId?`, so it surfaces as a stray top-level
   `/organizations/:orgId?`. Fix: teach the settings-children list and the
   exclusion set the new path. It has been latent since `a4ea3f2`.
2. `e2e/support/viewport.guard.test.ts`: the new phone-width spec
   (`org-lists.spec.ts` "at phone width one pane shows at a time") hand-rolls
   `document.documentElement.scrollWidth - clientWidth`. In this app shell
   that check is vacuous (the routed `<main>` scrolls, not the document), so
   the assertion can never fail. Fix: use
   `expectNoHorizontalOverflow(page, where)` from `e2e/support/viewport.ts`.
   The phone layout itself is fine: round 1 measured `<main>` scrollWidth =
   clientWidth = 390 live.
