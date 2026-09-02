# S3 implementer brief - staticSmoke: split by what each assertion proves (M7)

Begin by using tools - do not reply until the work is committed.

You are the implementer for slice S3 of the "npm test soundness" mission, in
worktree `W:\tmp\npm-test-soundness` (branch `feat/npm-test-soundness`). Work
ONLY in that worktree; use ABSOLUTE paths and `cd W:\tmp\npm-test-soundness`
explicitly in EVERY shell command. Never touch
`W:\AI Projects\Housing Choice\HC Application` or any other `W:\tmp\*`
worktree.

## Read first, in this order

1. `W:\tmp\npm-test-soundness\AGENTS.md`
2. `W:\tmp\npm-test-soundness\docs\superpowers\specs\2026-08-31-npm-test-soundness-design.md`
   - section "Item 3" in full
3. `W:\tmp\npm-test-soundness\docs\superpowers\plans\2026-09-01-npm-test-soundness.md`
   - "Rules that apply to every slice" and section "S3" in full (S3.1-S3.4)
4. `W:\tmp\npm-test-soundness\.superpowers\sdd\worklist.md` - section 0 (drift
   flags 7, 8, 9, 19, 23), section 4 (precedents, `dashboard/index.html`,
   `send`, the `app.ts` static wiring), section 5 (the vitest skip API),
   section 7 (issue template + house style), section 8B (ASCII status)
5. `W:\tmp\npm-test-soundness\app\test\staticSmoke.test.ts`,
   `W:\tmp\npm-test-soundness\app\test\unitMediaServe.test.ts:165-195`,
   `W:\tmp\npm-test-soundness\docs\issues\_TEMPLATE.md`,
   `W:\tmp\npm-test-soundness\docs\issues\README.md`

The spec is a contract. If a spec point looks wrong, STOP and report.

## Scope - exactly these files

- `app/test/staticSmoke.test.ts` (rewrite in place - same filename)
- `docs/issues/built-dashboard-identity-tags-unasserted.md` (NEW Tier-2
  issue; the slug is FIXED - it is the one the SKIP message names)
- `docs/superpowers/reviews/2026-08-31-npm-test-soundness/s3-static-smoke.md`
  (NEW committed slice record, ASCII)

Nothing else. `dashboard/index.html` is read, never edited. `dashboard/dist`
is gitignored and is built/mutated/rebuilt by hand in S3.4 only.

## What the rewrite must contain - all nine existing `it`s are accounted for

| existing line | case | goes to |
|---|---|---|
| `:38` serves index.html at / | SPLIT: status + content-type to (a), with the `HousingChoice` assertion (`:42`) REPLACED by the fixture marker; the five identity assertions (`:43-47`) move to (b) and (c) |
| `:50` runtime identity before static + SPA fallback | (a) |
| `:88` legacy manifest redirect + 403 guard | (a) |
| `:105` SPA fallback | (a) |
| `:111` reserved namespaces | (a) |
| `:120` hardening headers | (a) |
| `:143` traversal probes | (a) - assertions UNCHANGED, comment `:144-147` REWRITTEN (see below) |
| `:189` AWS bucket CSP shape | (a) |
| `:204` MinIO endpoint CSP shape | (a) |

### (a) app-serving behaviour on a fixture. NEVER skips.

- `mkdtemp` fixture, FILE-SCOPED (`let distDir: string` at module or outer
  scope) - BOTH describes read it (today `:29` and `:182`).
- Create it in a `beforeAll` BEFORE any `buildApp`. The first describe today
  builds its app in the DESCRIBE BODY at collection time (`:29-36`) - that
  shape is incompatible; restructure it to the `unitMediaServe.test.ts:165-190`
  shape (fixture in `beforeAll`, app built inside a function called per test
  or in the same `beforeAll` after the fixture exists). The second describe
  (`:177-215`) already builds per test and needs only the shared `distDir`.
- Clean up with `rmSync(distDir, { recursive: true, force: true })` in
  `afterAll`.
- Fixture `index.html`: MUST contain `<div id="root">` (positive sites `:108`,
  `:165`; the negatives at `:85` and `:99` constrain nothing) and a
  DISTINCTIVE marker string (e.g. `static-smoke-fixture-marker`) that the
  `serves index.html at /` case asserts on INSTEAD of `HousingChoice` - the
  served bytes must be proven to come from THIS fixture. It MUST NOT contain
  `"version"`, `"private"`, or `root:` (the traversal assertions read whatever
  the SPA fallback returns, which IS this fixture).
- POSITIVE CONTROL (new): write a real asset into the fixture dist (e.g.
  `assets/app-fixture.js` with a distinctive body), fetch it, assert its BODY
  (and content-type). A status-only check is vacuous: `express.static` misses
  fall through to a 200 SPA shell (`app/src/app.ts:284-296`).
- Traversal probes: the six probes and their assertions carry over UNCHANGED.
  The COMMENT at `:144-147` is rewritten (ASCII) to state what the probes now
  pin: that no encoded `..` yields anything but the SPA shell or a 4xx, given
  this app's stack of static serving, SPA fallback and reserved namespaces;
  and that `send` (installed 1.2.1) rejects any normalized `..` segment
  (`UP_PATH_REGEXP`) before touching the filesystem, so no decoy file could
  ever be read. NO decoy files.

### (b) the identity contract against TRACKED source. NEVER skips.

One `it` reading `W:\tmp\npm-test-soundness\dashboard\index.html` (resolve it
relative to the test file: `../../dashboard/index.html`) and asserting exactly
these five:
- contains `href="/app-identity/manifest.webmanifest"`
- contains `rel="icon" href="/app-identity/icon-192.png"`
- contains `rel="apple-touch-icon" href="/app-identity/icon-192.png"`
- does NOT contain `href="/manifest.webmanifest"`
- does NOT contain `href="/icons/icon-192.png"`
(All five hold today - worklist 4D.)

### (c) the REAL build: PASS or SKIP, never FAIL

One `it` using the test context's `ctx.skip(note)` (vitest 3.2.6 -
`it('...', (ctx) => { ... ctx.skip('message') ... })`; `it.skipIf` takes no
message, so it cannot express this). Read `dashboard/dist/index.html`:

| dist state | outcome |
|---|---|
| absent | `ctx.skip("no built dashboard; run `npm run build -w dashboard`")` |
| present, all five hold | PASS (assert them) |
| present, any fails | `ctx.skip(<message below>)` - it must NOT reach an `expect` that fails |

The message, verbatim (one string, ASCII):
"dashboard/dist disagrees with dashboard/index.html. Most likely the dist is
stale - run `npm run build -w dashboard`. If a fresh build still reports
this, the dashboard BUILD is dropping the identity tags, which is a real
regression - see docs/issues/built-dashboard-identity-tags-unasserted.md"

No literal `<slug>` may reach the shipped string. NO mtime predicate of any
kind. Compare only the five conditions (a build adds hashed asset tags and,
under e2e, an `x-app-commit` meta - not compared).

Remove the module-level `existsSync` guard and the `console.warn` at `:19-26`
and both `describe.skipIf(!built)` wrappers - nothing in this file skips at
the describe level any more.

## FILE THE ISSUE FIRST (before writing the SKIP string)

`docs/issues/built-dashboard-identity-tags-unasserted.md`, from
`docs/issues/_TEMPLATE.md` - but the template carries two EM DASHES (`:13`,
`:23`); do not import them, the new file is ASCII. Frontmatter: `id:` equals
the slug, `title:` (double-quote it if it contains a colon), `type: debt`,
`severity: med`, `status: open`, `area: app/test-infra`, `created: 2026-09-01`,
`refs: app/test/staticSmoke.test.ts, dashboard/index.html`. Body (`**Problem.**`
/ `**Suggested fix.**`): with (c) unable to FAIL, nothing anywhere asserts the
BUILT dashboard's identity tags - a `vite build` regression that dropped them
would go undetected indefinitely; the remedy is `npm run build -w dashboard`
wired into the app workspace's pretest or `globalSetup`, at ~15-40s on every
`npm test` on every branch, including the many that never touch the
dashboard - considered and not chosen by this mission. Reference the spec
section ("Item 3 (c)") and this mission's records path. Validate with
`cd W:\tmp\npm-test-soundness; npm run issues` (it prints WARNINGS for bad
frontmatter and regenerates the gitignored INDEX.md - do not commit INDEX.md).

## S3.4 - observe BOTH live branches of (c), by hand

1. `cd W:\tmp\npm-test-soundness; npm run build -w dashboard` once.
2. `cd W:\tmp\npm-test-soundness\app; npx vitest run test/staticSmoke.test.ts`
   - record the PASS branch. If a FRESH build does NOT satisfy the five
   conditions, STOP and report - that is a discovery about the build, not a
   reason to tune the assertions.
3. Edit the built `dashboard/dist/index.html` IN PLACE to break one tag (e.g.
   change `rel="icon" href="/app-identity/icon-192.png"` to
   `href="/icons/icon-192.png"`), run again - record the SKIP branch and the
   exact note the reporter prints (`[<note>]` beside the test name).
4. Also record the ABSENT branch: you observed it before step 1 (dist does not
   exist in this worktree today - worklist 4E) - run the file once BEFORE
   building and record that skip note too.
5. Restore by rebuilding (`npm run build -w dashboard`). Leave the fresh dist
   in place and SAY SO in the record (the orchestrator's later `npm test`
   will then exercise the PASS branch of (c)).

## Verify

From `W:\tmp\npm-test-soundness\app`, bare, foreground, output to a file then
read: `npx vitest run test/staticSmoke.test.ts` (final state: all cases pass,
(c) PASS with the fresh dist). Record the test count and note the file no
longer reports skipped `it`s for (a)/(b). Then from the root:
`npm run typecheck` and `npx eslint app/test/staticSmoke.test.ts` (fix only
errors YOU introduced).

DO NOT run the full `npm test`, `npm run e2e`, or `npm run smoke`. Do NOT
touch the DynamoDB Local container. Never end your turn with a background
command running.

## Encoding / edit rules

- The existing file has 8 non-ASCII lines (em dashes in comments). Every line
  you ADD or TOUCH must be ASCII - since this is a rewrite, make the whole new
  file ASCII (replace em dashes with `-`). The issue file and the record are
  ASCII.
- Never rewrite a source file with a PowerShell `Get-Content | -replace |
  Set-Content` pipeline. Use the Edit/Write tools.
- `app/test/**` is linted under `**/*.ts` (`eslint.config.mjs:15`).

## Commit discipline (verbatim repo rules)

- Bare `git status` before EVERY commit; check `.git/MERGE_HEAD` is absent.
  Stage EXPLICIT PATHS only - never `git add -A`. Other files may be dirty
  from the orchestrator's own work - leave them alone. `dashboard/dist` is
  gitignored and must not appear in `git status`.
- Two commits minimum: (1) the issue file + the test rewrite, (2) the record.
- Trailer on every commit:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## The record - `s3-static-smoke.md` (ASCII, committed)

The nine-to-new mapping as shipped (test names); the three observed (c)
branches with the exact skip notes; the installed `send` version; the fixture
contents' positive and negative constraints and why; the positive control;
the issue slug and that the shipped string matches the filename; verify
results (counts + exit codes); the state `dashboard/dist` was left in;
anything you saw that looks wrong elsewhere (not fixed). `file:line` cites;
no byte-exact code quotation in the record.

## STOP conditions

- A fresh `npm run build -w dashboard` output fails any of the five.
- `ctx.skip(note)` does not behave as worklist section 5 says.
- You find a reason the traversal assertions cannot carry over unchanged.
- Low on context: commit what is green, report the next step.

## Return

Reply with ONLY: commit hashes + one-liners; the final test count for the
file; the three (c) skip/pass observations (one line each, with the note);
the issue path; the record path; open findings for the orchestrator (one line
each). No narration.
