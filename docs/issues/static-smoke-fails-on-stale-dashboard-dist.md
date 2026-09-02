---
id: static-smoke-fails-on-stale-dashboard-dist
title: staticSmoke skips on an ABSENT dashboard/dist but fails on a STALE one, blaming manifest paths instead of the build
type: bug
severity: med
status: resolved
area: app/test-infra
refs: app/test/staticSmoke.test.ts:19, app/test/staticSmoke.test.ts:28, dashboard/index.html:11
created: 2026-08-25
resolved: 2026-09-01
updated: 2026-09-01
---

**Problem.** `staticSmoke.test.ts` asserts the BUILT dashboard's `index.html`
contains the current PWA identity paths. Its guard checks only that the file
EXISTS:

```ts
const built = existsSync(path.join(distDir, 'index.html'));
describe.skipIf(!built)(...)
```

Absent dist -> clean skip, with a console warning telling you to build. **Stale
dist -> the suite runs and fails**, and the failure names the manifest path
rather than the build, so it reads as a product regression.

**Sighting (2026-08-25).** A `npm test` run went red with no captured output.
Recovered from vitest's on-disk cache
(`app/node_modules/.vite/vitest/*/results.json`, which records per-file
`failed`) - the file was `staticSmoke.test.ts`. The checkout's
`dashboard/dist/index.html` dated 2026-08-15 21:49:

| assertion | stale dist holds |
|---|---|
| `href="/app-identity/manifest.webmanifest"` | `href="/manifest.webmanifest"` |
| `rel="icon" href="/app-identity/icon-192.png"` | `href="/icons/icon-192.png"` |

Those paths moved in `2210f671` ("feat(pwa): ship runtime HC identity artwork",
2026-08-21) - six days AFTER that dist was built. The test was asserting today's
contract against a build that predates the change.

**Not load, not a flake.** It was found while the box carried two e2e suites, a
third from the main checkout, a `npm test`, and six synthetic CPU workers, which
made "intermittent, environmental" the tempting reading - and it is neither. It
fails deterministically on any checkout whose `dashboard/dist` predates
`dashboard/index.html`, and passes on any checkout whose dist is current. That
is also why it appears on no flake list.

The cost is misattribution: the visible failure is about manifest paths, so the
natural first move is to go looking at PWA code that is fine. `npm test` also
does not surface which FILE failed once output scrolls past, which is what made
this expensive - see the recovery trick above, it generalises.

**Suggested fix.** Make the guard freshness-aware rather than existence-aware:
compare the mtime of `dashboard/dist/index.html` against `dashboard/index.html`
(and ideally `dashboard/src`), and when the dist is older either skip with a
message that SAYS stale, or fail with "your dashboard/dist is stale - run
`npm run build -w dashboard`". Either is fine; what matters is that the message
names the build rather than the manifest.

Clearing it by hand today: `npm run build -w dashboard`.

Worth noting the guard's existing instinct is right - self-skipping on a
gitignored build artifact is the correct pattern, matching the DynamoDB Local
suites. This is a gap in the predicate, not in the approach.

**Resolution (2026-09-01).** Fixed structurally on the npm-test-soundness
mission (`a9b7124d` plus the review fix waves; records:
`docs/superpowers/reviews/2026-08-31-npm-test-soundness/s3-static-smoke.md`) -
and NOT by the mtime predicate suggested above, which git defeats: git does
not preserve mtimes, so a fresh clone, a new worktree, or a routine main sync
would rewrite the tracked file's mtime and silently flip a genuine failure
into a skip. Instead the file was split by what each assertion proves:
app-serving behaviour runs against a temp fixture this file writes and never
skips; the five PWA identity conditions are asserted against the TRACKED
`dashboard/index.html` and never skip; and the check against the built
`dashboard/dist` is a diagnostic that can only PASS or SKIP - a stale or
broken dist now skips with a message naming both causes (most likely stale ->
rebuild; a fresh build still failing -> the BUILD is dropping the identity
tags) instead of failing on manifest paths. All three branches were observed
live, under the default reporter. The coverage this gives up - nothing can
FAIL on the built dist any more - is tracked in
[`built-dashboard-identity-tags-unasserted`](./built-dashboard-identity-tags-unasserted.md).
