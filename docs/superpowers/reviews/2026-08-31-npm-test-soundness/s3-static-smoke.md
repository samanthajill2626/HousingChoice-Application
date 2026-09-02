# S3 - staticSmoke split by what each assertion proves

Slice S3 of the npm-test-soundness mission (spec section "Item 3", plan S3.1-S3.4).
Branch `feat/npm-test-soundness`, worktree `W:\tmp\npm-test-soundness`.
Implemented 2026-09-01.

Files touched: `app/test/staticSmoke.test.ts` (rewritten in place),
`docs/issues/built-dashboard-identity-tags-unasserted.md` (new), this record.
`dashboard/index.html` was read, never edited. `dashboard/dist` is gitignored
and was built / mutated / rebuilt by hand for S3.4 only.

## The problem this slice removes

The old file gated both describes on `describe.skipIf(!built)` where `built` was
an `existsSync` of `dashboard/dist/index.html` (old `:19`, `:28`, `:177`). So the
file's colour tracked an untracked build artifact: absent dist meant all nine
`it`s skipped silently (the state of this worktree - worklist 4E), and a STALE
dist meant the suite ran and failed naming a manifest path, pointing the reader
at PWA code that is fine.

## Nine-to-new mapping, as shipped

Old line numbers are from the pre-rewrite file (worklist 4C confirms all nine).
New test names are quoted from the shipped file.

| old `it` | old line | shipped as |
|---|---|---|
| serves index.html at / | `:38` | SPLIT. Status + content-type stay in (a) as `serves index.html at /`; the `HousingChoice` assertion (`:42`) is REPLACED by the fixture marker; the five identity assertions (`:43-47`) move to (b) and (c) |
| runtime identity before static + SPA fallback | `:50` | (a) `serves runtime identity before static files and the SPA fallback` - unchanged |
| legacy manifest redirect + 403 guard | `:88` | (a) `redirects the legacy root manifest to the runtime manifest without caching` - unchanged |
| SPA fallback for unknown GETs | `:105` | (a) `SPA-falls back to index.html for unknown GET paths (client-side routes)` - unchanged |
| reserved namespaces | `:111` | (a) `never swallows the reserved namespaces - /api stays 401, /auth and /webhooks stay 404` (em dash in the name replaced by a hyphen; assertions unchanged) |
| hardening headers | `:120` | (a) `serves the browser-hardening headers on the SPA fallback (and / and assets)` - unchanged assertions, ASCII comments |
| path-traversal probes | `:143` | (a) `encoded path-traversal attempts never leak file contents (%2e%2e%2f and ..%5c variants)` - probes and assertions UNCHANGED, comment rewritten |
| AWS bucket CSP shape | `:189` | (a) `real AWS shape: virtual-hosted bucket origin lands in connect-src ONLY (img-src stays self)` - unchanged |
| MinIO endpoint CSP shape | `:204` | (a) `local MinIO shape: the MEDIA_S3_ENDPOINT origin is allowed in connect-src (path-style)` - unchanged |

Two `it`s are NEW:

- (a) positive control: `serves a real asset from the dist with its own body (not the SPA shell)`.
- (b) `carries the runtime-identity link tags and none of the legacy root paths`,
  in describe `PWA identity contract in the tracked dashboard/index.html`.

And one carries the identity assertions that used to ride on `:38`:

- (c) `the built dashboard/dist/index.html agrees with the tracked source`, in
  describe `built dashboard identity tags (diagnostic: PASS or SKIP, never FAIL)`.

Net: 9 `it`s -> 12. Eleven of them can never skip; exactly one (c) can.

Removed: the module-level `existsSync` guard, the `console.warn`, and both
`describe.skipIf(!built)` wrappers. Nothing in this file skips at describe level
any more.

## Structure change (a) required

The first describe used to build its app in the DESCRIBE BODY at collection time
(old `:29-36`), which no `beforeAll` fixture can precede. It now follows
`app/test/unitMediaServe.test.ts:165-190`: a file-scoped `let distDir`, the
fixture written in a file-scoped `beforeAll`, `rmSync` in `afterAll`, and a
`fixtureApp(extraEnv)` helper called per test. The second describe already built
per test (old `:178-187`) and simply reuses the same helper - its two cases pass
their env through `extraEnv`, so there is now one app builder, not two.

`beforeAll`/`afterAll` are at FILE scope because both describes read `distDir`;
a fixture scoped to one would leave the other pointed at a path that may not
exist.

## Fixture contents - both directions, and why

Positive:

- `<div id="root">` - asserted by the SPA-fallback case and by the traversal
  probes' 200 branch (old `:108`, `:165`). The two `not.toContain` sites (old
  `:85`, `:99`) constrain the fixture in no direction; drift flag 8 in the
  worklist called out the plan's mixed-direction list.
- A distinctive marker `static-smoke-fixture-marker`. The old `HousingChoice`
  assertion becomes a tautology the moment the test writes its own fixture - it
  asserts our own string back at us. The marker instead proves the served bytes
  came from THIS fixture. The real title is covered by (b)/(c) against tracked
  source.

Negative - the fixture MUST NOT contain `"version"`, `"private"` or `root:`.
This is load-bearing, not cosmetic: with no decoy files, the traversal probes
assert against whatever the SPA fallback returns, which IS this fixture. A
fixture carrying any of the three would fail the traversal assertions for a
reason with nothing to do with traversal.

## Positive control

`assets/app-fixture.js` is written into the fixture dist, fetched, and asserted
on its BODY plus a `javascript` content-type - and asserted NOT to contain the
SPA marker. A status-only check would be vacuous: `express.static` at
`app/src/app.ts:284` misses fall through to the SPA handler at `:285-296`, which
answers 200 with `index.html`. So "200 OK" is exactly what the regression this
control exists to catch (a `distDir` pointed somewhere wrong) would also return.
The file had no such control before.

## Traversal probes

The six probes and every assertion carry over UNCHANGED. Only the comment (old
`:144-147`) is rewritten, because its claim - that
`dashboard/dist/../../package.json` is "the realistic exfiltration target on this
exact tree" - is untrue under a temp fixture.

There are no decoys and no reason for any. Installed `send` is **1.2.1**
(single copy in the tree; `express` declares `^1.1.0` and `serve-static` `^1.2.0`
and both dedupe onto it - worklist 4F). It decodes the request path and tests it
with `UP_PATH_REGEXP` at two sites, the rooted branch BEFORE the join, so the
filesystem is never touched and there is no depth at which a decoy could be
read. What the probes actually pin is OUR COMPOSITION: given this app's stack of
static serving, SPA fallback and reserved namespaces, no encoded `..` yields
anything but the SPA shell or a 4xx. That is a property of how we wired it and a
future static-serving change could lose it, which is why they are kept.

[Note added 2026-09-01: the no-decoys statements in this section were true as of
796b8632 and were superseded by fix wave 1 (b81ceb23) - decoys were added inside
the fixture root after a review reproduction proved the probes unfalsifiable
without a target. See code-review/r1-adjudications.md A3.]

## (c) - the diagnostic, and its three live branches OBSERVED

Mechanism: `ctx.skip(note)` inside the `it` (vitest 3.2.6). `it.skipIf` takes a
condition only and cannot carry a message, so it cannot express this. No mtime
predicate of any kind - git does not preserve mtimes, so a fresh clone, a new
worktree or this mission's own mandated `main` sync would flip a genuine failure
into a skip. Only the five conditions are compared; a build also injects hashed
asset tags and, under e2e, an `x-app-commit` meta.

All three branches were run by hand, not reasoned about:

1. **ABSENT** (before any build; `dashboard/dist` did not exist in this worktree
   - worklist 4E). SKIP; the reporter printed this note beside the test name:

   ```
   [no built dashboard; run `npm run build -w dashboard`]
   ```

   Run: 11 passed | 1 skipped (12), exit 0.
2. **FRESH BUILD** (`npm run build -w dashboard`, exit 0, "built in 3.27s").
   PASS - 12 passed (12), exit 0. The fresh build satisfies all five conditions,
   so no STOP condition fired.
3. **BROKEN IN PLACE** - the built `dashboard/dist/index.html`'s
   `rel="icon"` href edited from `/app-identity/icon-192.png` to
   `/icons/icon-192.png` (breaks one PRESENT condition and trips one ABSENT
   condition at once). SKIP, never a failing `expect`. Note printed verbatim
   (captured output, wrapped here for width):

   ```
   [dashboard/dist disagrees with dashboard/index.html. Most likely the dist
   is stale - run `npm run build -w dashboard`. If a fresh build still reports
   this, the dashboard BUILD is dropping the identity tags, which is a real
   regression - see docs/issues/built-dashboard-identity-tags-unasserted.md]
   ```

   Run: 11 passed | 1 skipped (12), exit 0.

Branch 3 was observed under BOTH the verbose reporter and the DEFAULT reporter.
The default reporter prints the skipped test and its note as an indented line
under the file's summary line, so an operator sees the message without opting
into anything. `app/vitest.config.ts` sets neither `hideSkippedTests` nor a
custom `reporters` list, which is what would have suppressed it.

The dist was restored by rebuilding after branch 3 (twice - once after the
verbose observation, once after the default-reporter observation), and the final
verify was re-run against the restored build.

## The issue

`docs/issues/built-dashboard-identity-tags-unasserted.md` - filed BEFORE the skip
string was written, so no literal `<slug>` could reach the shipped message. The
shipped string ends `see docs/issues/built-dashboard-identity-tags-unasserted.md`,
which matches the filename exactly (checked character by character against the
committed path).

Frontmatter: `id` equal to the slug, `type: debt`, `severity: med`,
`status: open`, `area: app/test-infra`, `created: 2026-09-01`,
`refs: app/test/staticSmoke.test.ts, dashboard/index.html`. The `title` contains
a colon and is double-quoted per house style. The two em dashes in
`docs/issues/_TEMPLATE.md` (`:13`, `:23`) were NOT imported - the new file is
pure ASCII.

Its body states the cost this slice accepts (with (c) unable to fail, nothing
anywhere asserts the BUILT dashboard's identity tags, so a `vite build`
regression that dropped them would go undetected indefinitely), names the remedy
(`npm run build -w dashboard` wired into the app workspace's `pretest` or
`globalSetup`, then promote (c) to a hard assertion) and its cost (~15-40s on
every `npm test`, on every branch, including the many that never touch the
dashboard), and records that this mission considered and did not choose it.

`npm run issues` printed no warning for the new file. The one warning it prints
is pre-existing and belongs to another file (see "Seen elsewhere" below).
`docs/issues/INDEX.md` is gitignored and was not committed.

## Verify

All commands run bare and in the foreground from the paths named, output
captured to a file and read.

| command | cwd | result |
|---|---|---|
| `npx vitest run test/staticSmoke.test.ts` (dist absent) | `app` | 11 passed, 1 skipped (12), exit 0 |
| `npm run build -w dashboard` | root | exit 0 |
| `npx vitest run test/staticSmoke.test.ts` (fresh dist) | `app` | 12 passed (12), exit 0 |
| `npx vitest run test/staticSmoke.test.ts` (broken dist) | `app` | 11 passed, 1 skipped (12), exit 0 |
| `npx vitest run test/staticSmoke.test.ts` (restored dist, FINAL) | `app` | 12 passed (12), exit 0 |
| `npm run typecheck` | root | exit 0 |
| `npx eslint app/test/staticSmoke.test.ts` | root | exit 0, no output |

The file no longer reports skipped `it`s for (a) or (b) in any state: the only
skippable case in the file is (c). On this worktree BEFORE the slice, all nine
`it`s skipped; after it, eleven always execute.

Not run, per the brief: the full `npm test`, `npm run e2e`, `npm run smoke`. The
DynamoDB Local container was not touched (the runs above use the per-file key
`hctestcdb4fe` and its `globalTeardown` dropped its own 23 tables each time). No
background command is left running.

## State `dashboard/dist` was left in

**Left present and FRESH**, rebuilt from the current tracked source after the
last mutation; its `index.html` carries all three `/app-identity/` link tags and
neither legacy path. The orchestrator's later `npm test` will therefore exercise
the PASS branch of (c), not the absent-skip. It is gitignored and does not appear
in `git status`. Deleting `dashboard/dist` is safe at any time - the file simply
reverts to the absent-skip branch.

## Seen elsewhere, NOT fixed

- `docs/issues/perf-selfqa-route-contract-drift.md` carries `severity: medium`,
  which is not in the allowed set (`high | med | low`). `npm run issues` warns on
  it and the row's severity is unusable for filtering. Pre-existing, unrelated to
  this slice, and a one-word fix for whoever owns that file.
- `app/test/staticSmoke.test.ts`'s hardening-headers case uses `path` as its loop
  variable, shadowing the `node:path` import. Carried over unchanged from the old
  file (it doubles as the `expect` message); harmless today, and eslint does not
  flag it, but it is a trap for the next editor of that block.
- `dashboard/index.html:7` holds the file's one non-ASCII byte sequence (an em
  dash in the description meta). Untouched by this slice; noted because (b) reads
  that file and a future ASCII sweep of it would not disturb any assertion here -
  none of the five conditions involve that line.
