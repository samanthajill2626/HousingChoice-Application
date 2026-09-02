---
id: built-dashboard-identity-tags-unasserted
title: "Nothing asserts the BUILT dashboard's PWA identity tags: staticSmoke's dist check can only PASS or SKIP"
type: debt
severity: med
status: open
area: app/test-infra
created: 2026-09-01
refs: app/test/staticSmoke.test.ts, dashboard/index.html
---

**Problem.** `app/test/staticSmoke.test.ts` now splits its assertions by what
each one proves: app-serving behaviour runs against a temp fixture and never
skips, the five PWA identity conditions are asserted against the tracked
`dashboard/index.html` and never skip, and the check against the real
`dashboard/dist/index.html` is a diagnostic that can only PASS or SKIP - never
FAIL. That last property is deliberate (see
`docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md`, section
"Item 3", subsection (c)): `dashboard/dist` is a gitignored build artifact, so
a test that FAILS on it makes a branch's colour track whether somebody happened
to run `npm run build -w dashboard` in that worktree, which is exactly the
defect this mission removed.

The honest cost, recorded here rather than hidden: with that check unable to
fail, **nothing anywhere asserts the identity tags in the BUILT dashboard**. A
`vite build` regression that dropped `link rel="manifest"` /
`rel="icon"` / `rel="apple-touch-icon"` - or reintroduced the pre-`2210f671`
root-relative `/manifest.webmanifest` and `/icons/icon-192.png` hrefs - would
be invisible to `npm test` indefinitely. The tracked-source assertions would
stay green, because the source is not what broke. The skip message on the
dist diagnostic is written to distinguish the two causes (a stale dist versus a
build that drops the tags), so an operator who does hit it is not sent round a
rebuild loop; but nothing makes an operator look.

The gap is bounded: `dashboard/index.html` is the only input, Vite copies those
link tags through untransformed, and a deployed environment would surface a
broken install prompt quickly. It is still real coverage that used to exist by
accident (on any worktree where the dashboard happened to be built) and now
exists nowhere.

**Suggested fix.** Wire `npm run build -w dashboard` into the app workspace's
`pretest` or vitest `globalSetup`, then promote the dist check from a skip to a
hard assertion. That is the only way to recover the coverage: the built
artifact has to exist for a gate to read it.

The reason it was considered and not chosen by the npm-test-soundness mission:
the build costs roughly 15-40s and would be paid on EVERY `npm test`, on EVERY
branch, including the large majority that never touch `dashboard/`. The mission
whose subject was `npm test` being slow and untrustworthy was not the right
place to add an unconditional 15-40s to it. A future change could scope the
build to branches that touch `dashboard/**`, or move the assertion into the e2e
harness, which already builds the dashboard.

Mission records: `docs/superpowers/reviews/2026-08-31-npm-test-soundness/`
(slice record `s3-static-smoke.md`). Related:
[`static-smoke-fails-on-stale-dashboard-dist`](./static-smoke-fails-on-stale-dashboard-dist.md).
