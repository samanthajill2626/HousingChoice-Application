# Fix-wave report - error-surface-detail (2026-08-25)

Worktree `W:\tmp\error-surface-detail`, branch `feat/error-surface-detail`.
Base `03a3e2ed`. Three commits, working tree clean, nothing else touched.

## Commits

| SHA | Message |
|---|---|
| `958b4409` | fix(observability): close review findings on the detail and trace read paths |
| `bebe35db` | fix(observability): row-key collision, hook unmount aborts, ptr-exact trace anchor |
| `305123e5` | docs(review): annotate AJ71 as superseded by the amended spec |

## Verification actually run

| Gate | Result |
|---|---|
| After commit 1: `cd app && npx vitest run test/cloudwatch.adapter.test.ts test/systemStatus.service.test.ts test/system.routes.test.ts test/expressErrorHandler.test.ts` | 4 files, **107 tests PASSED** |
| After commit 1: `npm run typecheck` (root, bare) | **GREEN**, all 5 projects |
| After commit 2 (app, seam type changed): same four files | 4 files, **108 tests PASSED** (expressErrorHandler 4, systemStatus 42, cloudwatch.adapter 40, system.routes 22) |
| After commit 2: `cd dashboard && npx vitest run src/routes/settings/` | 16 files, **163 tests PASSED** (ErrorTrace 9, RecentErrors 26) |
| After commit 2: `npm run typecheck` (root, bare) | **GREEN** (one intermediate failure, self-caused and fixed - see divergence 2) |
| ASCII scan of every added line, all three commits | **0 non-ASCII** |
| `git status` bare before every commit; `.git/MERGE_HEAD` absent | clean, explicit paths staged |

Not run per the brief: `npm test` (full), `npm run smoke`, `npm run e2e`, docker,
db:start, terraform.

## How each item was closed

### Commit 1 - app backend

- **FW-A** `app/src/adapters/cloudwatch.ts:230` - `enforceBound` now converges:
  a halving cap (512 -> 1) re-runs the longest-first pass, then a last-resort
  loop DROPS the longest-named remaining fields, so
  `Buffer.byteLength(JSON.stringify(fields),'utf8') <= RESPONSE_BOUND_BYTES`
  holds on return. Flag is true whenever anything was trimmed or dropped.
  Docblock (`:216-229`) also records the two adv-C6 facts: it mutates in place
  on purpose (single caller) and `rawText` rides outside the budget, so the true
  ceiling is bound + 4000. New test
  `app/test/cloudwatch.adapter.test.ts:508` (200 fields x 2000 chars ->
  `responseTruncated === true` AND final byteLength within bound). The existing
  single-field test is untouched.
- **FW-B** `app/src/adapters/cloudwatch.ts:196` - `isAllowedKey(key, value)` now
  reads the value for exactly one key: bare `err` survives only when it does not
  parse to a JSON object (`isJsonObject`, `:205`). Call site `:715-719` passes
  the coerced string once. ERR_ALLOWLIST docblock rewritten at `:147-160` with
  the REAL scope (err.* subtree + object-valued bare err closed by construction;
  non-err fields pass through BY DESIGN and are owned by write-time redaction +
  call-site discipline, zero live cases in the 2026-08-25 sweep). Test
  `cloudwatch.adapter.test.ts:519` asserts the object-valued bare err is dropped
  and `JSON.stringify(out)` has no `Authorization`; the pre-existing scalar-err
  test still passes.
- **FW-C** `app/test/expressErrorHandler.test.ts:73` - URIError on an unrouted
  request logs a msg containing `(unrouted)` that starts with
  `malformed URI in request - rejected as 400`.
- **FW-D** `app/test/systemStatus.service.test.ts:429` and `:452` - the old
  "deduplicates OOM events that have the same timestamp+label" test is replaced
  by the two halves of the contract: one event reaching the merge twice collapses
  on its shared ref, and two DISTINCT refs sharing timestamp AND the V8 label
  both survive. Decision stated in the commit body ("ref is the identity; no
  timestamp+message fallback"). Service dedup key NOT changed. See divergence 1.
- **FW-H** `app/src/routes/system.ts:117,130` - `at` must now match
  `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/` AND parse, so the "at must be an ISO 8601
  timestamp" 400 is true. Test `app/test/system.routes.test.ts:281`
  (`at=1 Jan 2020` -> 400 naming ISO 8601); the existing `at=nonsense` and
  missing-`at` tests still pass.
- **FW-I** `app/src/adapters/cloudwatch.ts:742-757` - the queryTrace boundary
  comment now cites the measurement: a real event at epoch ms 1787022602554 was
  returned by a query with startTime == endTime == 1787022602, which is why
  BEFORE `endTime = floor(atMs/1000)` is inclusive-and-gapless and AFTER
  `startTime = floor+1` stays disjoint; plus the note that queryInsights' ceil'd
  live endTime is not a contradiction (it ends at "now").
- **FW-J** `app/src/adapters/cloudwatch.ts:695-702` - the `record['@log']` read
  cites real GetLogRecord responses from BOTH `/hc/dev/app` and `/hc/prod/system`
  carrying `@log` valued `<accountId>:<logGroupName>`, and states it fails CLOSED
  (`out_of_scope`) if AWS ever omitted it. `:174-182` records that
  `@log`/`@logStream`/`@ingestionTime` are deliberately passed as host metadata,
  account id visible, admin-only.
- **FW-K** `app/src/lib/errors.ts:144-153` - routeLabel docblock states the
  literal-mount invariant (swept 2026-08-25, zero parameterised mounts) and that
  Express substitutes actual values into `baseUrl`, so a parameterised mount
  would put concrete ids back into `msg`.

### Commit 2 - dashboard + trace ref

- **FW-E** `dashboard/src/routes/settings/RecentErrors.tsx:291` - row key is
  `` `${ev.ref}|${ev.timestamp}|${ev.message}` `` with the comment placing ref as
  the leading identity and naming the two disambiguated cases. Test
  `RecentErrors.test.tsx:262` renders two rows sharing ref+timestamp with
  different messages and proves the expanders are independent.
- **FW-F** `dashboard/src/routes/settings/useSystemStatus.ts:292` and `:331` -
  `useEffect(() => () => abortRef.current?.abort(), [])` in BOTH hooks. The
  header claim at `:13-16` is now true and was kept; `:245-257` rewritten - the
  abortRef is PER HOOK INSTANCE and each row creates its own, so a new load
  supersedes the previous load of that instance only. Tests:
  `ErrorTrace.test.tsx:114` (never-resolving `getSystemTrace`, capture the
  signal, unmount, `aborted === true`) and `RecentErrors.test.tsx:279`
  (`renderHook(() => useErrorDetail())`, load, unmount, same assertion).
- **FW-G** ptr-exact anchor, end to end:
  - `app/src/adapters/cloudwatch.ts:758` - trace fields clause is now
    `fields @timestamp, @message, @log, @ptr`; `traceLine` reads `@ptr`
    (`:504-513`) and sets `ref` on BOTH the parsed (`:531`) and unparseable
    (`:514`) branches; `TraceLineView.ref` is REQUIRED (`:298-305`).
  - `dashboard/src/api/types.ts:394` - `SystemTraceLine.ref: string`.
  - `dashboard/src/routes/settings/ErrorTrace.tsx:31,60,64` - required
    `anchorRef` prop; both timestamp-equality sites are now `l.ref === anchorRef`;
    the li key is `l.ref` (the timestamp-index composite is gone).
  - `dashboard/src/routes/settings/RecentErrors.tsx:210` - passes
    `anchorRef={event.ref}`.
  - Tests: adapter traceSeam rows carry an `@ptr` cell, both query strings are
    asserted to contain the widened fields clause
    (`cloudwatch.adapter.test.ts:597`), lines carry ref (`:707`), and both
    `toEqual` fixtures gained `ref`. `ErrorTrace.test.tsx:94` proves two
    same-millisecond lines with different refs yield exactly ONE "this failure".
    `RecentErrors.test.tsx` trace tests pass unchanged.
- FetchStatus/hook shapes otherwise unchanged; `SystemStatusSection.*` untouched.

### Commit 3 - docs

- **FW-L** `docs/superpowers/reviews/2026-08-24-error-surface-detail-design-review.md:917`
  - the SUPERSEDED (2026-08-25) note appended INSIDE the AJ71 entry, original
  entry text unaltered.

## Divergences (2)

1. **FW-D half (a) could not be written as briefed, and was written honestly
   instead.** The brief asked for "the SAME log event returned by both the pino
   and OOM queries shares one ref and collapses to ONE row". That is FALSE
   against the shipped service: the dedup key is
   `` `${ref}|${timestamp}|${message}|${errorCode ?? ''}` `` and the OOM relabel
   (`systemStatus.ts:297`) rewrites `message`, so a pino+OOM double match on one
   ref produces TWO keys and BOTH rows survive - which is exactly the adversarial
   C1 case FW-E's composite row key exists to tolerate. Changing the service
   dedup key was explicitly rejected, so half (a) is instead
   "collapses ONE log event that reaches the merge twice - the shared ref
   decides" (identical copies, `:429`), and its comment states in full that the
   relabel case deliberately does NOT collapse and points at the row key. Half
   (b) is exactly as briefed (`:452`). No behavior changed either way.
2. **One extra file line touched beyond the brief's list.**
   `app/test/systemStatus.service.test.ts:607` had a second `queryTrace` fixture
   (a real trace line, not the `lines: []` stub the brief mentioned) which stopped
   compiling once `TraceLineView.ref` became required. It gained
   `ref: 'TPTR-1'`. Caught by root typecheck between the dashboard run and the
   commit; re-verified green.

## Notes for the next step

- Nothing from the REJECTED/defer lists was implemented: no overlap/dedup change
  to the trace windows, no service dedup-key change, no rate limiting, no issue
  filed for the Insights spend, no `RecentErrors.test.tsx:86` title rename.
- No pre-existing red was encountered. The only failure seen in the whole wave
  was the self-caused typecheck error in divergence 2.
- Remaining gates for the branch (out of this wave's brief): main sync, then
  bare `npm run typecheck`, `npm test`, `npm run smoke`, `npm run e2e`.

## Micro-closure pass

Four re-review findings (NEW-1, NEW-2, NEW-5, NEW-7) closed in ONE commit,
`bd1c5a26`, on top of `305123e5` (5 files, +87/-26). No behavior changed except NEW-1's cost profile and NEW-7's
degenerate-case guard; no infra, no `npm test` / `smoke` / `e2e` run.

Files: `app/src/adapters/cloudwatch.ts`, `app/test/cloudwatch.adapter.test.ts`,
`dashboard/src/routes/settings/ErrorTrace.tsx`,
`dashboard/src/routes/settings/ErrorTrace.test.tsx`,
`dashboard/src/routes/settings/useSystemStatus.ts`. (`RecentErrors.test.tsx`
needed no edit and was not touched.)

### How each finding closed

- **NEW-1 (enforceBound cost) - FIXED.** `size()` now runs ONCE PER CAP PASS
  instead of once per key per cap: each pass clips every over-cap field, then
  measures once. Clipping a whole pass is order-independent, so `longestFirst()`
  is gone from the cap loop (the drop loop keeps its longest-NAME sort). The drop
  loop now deletes first and measures after, so it costs one serialisation per
  actual removal - safe because we only reach it having just measured OVER the
  bound. Guarantee unchanged: on return
  `Buffer.byteLength(JSON.stringify(fields),'utf8') <= RESPONSE_BOUND_BYTES`, and
  `responseTruncated` semantics are untouched. A/B measured on this machine with
  both versions extracted verbatim:

  | shape | OLD | NEW |
  |---|---|---|
  | 3000 fields, 30-char names, 1-char values | 16,251ms, 31,231 `size()` | 521ms, 1,240 `size()` |
  | 3000 fields, 40-char names, 8-char values | 21,093ms, 31,608 `size()` | 706ms, 1,617 `size()` |
  | 200 fields x 2000 chars (shipped test) | 108ms, 357 `size()` | 2ms, 3 `size()` |

  Both key-heavy shapes produce a BYTE-IDENTICAL result (65,528B / 1,771 keys and
  65,519B / 1,394 keys). The 200x2000 shape ends smaller (53,891B vs 65,411B)
  because a pass no longer stops at the first fitting moment - the immaterial
  cost the fix trades for, and the payload is still bounded and still flagged.

- **NEW-2 (drop-path coverage) - ADDED.** `cloudwatch.adapter.test.ts` gained
  "DROPS fields when the weight is in the KEY NAMES, not the values": 3000 keys
  of 40 chars with 8-char values (~162 KB of names), asserting
  `responseTruncated === true`, final byteLength <= bound, and
  `Object.keys(fields).length < inputCount` (fields actually LEFT, which only the
  drop loop can do). It reaches every cap level AND the drop loop. Runtime 697ms
  with the NEW-1 restructure, so 3000 keys stayed affordable and the brief's
  fallback to a smaller count was not needed - the same fixture costs 21s against
  the pre-fix function.

- **NEW-5 (comment overclaim) - CORRECTED.** `useSystemStatus.ts:329` now says
  the unmount abort is CLIENT-SIDE CANCELLATION ONLY - the route plumbs no abort
  signal, so the two Insights queries still run (and still bill) to completion on
  the server. The same overclaim in the sibling test comment
  (`ErrorTrace.test.tsx`, the abort test) was corrected to match; leaving it would
  have re-stated the falsehood one file over. No behavior change.

- **NEW-7 (degenerate `@ptr`) - FIXED.** `ErrorTrace.tsx` keys each `li`
  `` `${l.ref}|${i}` `` (unique by construction) and gates BOTH anchor sites -
  the row class and the "this failure" chip - on
  `l.ref !== '' && l.ref === anchorRef`. New test "an ABSENT @ptr marks nothing,
  and every line still gets its own key": three lines with `ref: ''` and
  `anchorRef=''` render three list items, ZERO "this failure" markers, and no
  React duplicate-key `console.error`.

### Verification (bare, from the worktree)

| Gate | Result |
|---|---|
| `cd app && npx vitest run test/cloudwatch.adapter.test.ts` | 1 file, **41 tests passed** (was 40), 0 failed, 2.29s |
| `cd dashboard && npx vitest run src/routes/settings/ErrorTrace.test.tsx src/routes/settings/RecentErrors.test.tsx` | 2 files, **36 tests passed** (ErrorTrace 10, was 9; RecentErrors 26), 0 failed, 3.54s |
| `npm run typecheck` (root) | **GREEN**, all 5 workspaces |
| non-ASCII scan of added lines | 0 hits |

Both halves of the NEW-7 test were proven to DISCRIMINATE by temporarily
restoring the old expressions: with the bare compare it fails on 3 "this failure"
markers; with the guard restored but the bare `key={l.ref}`, it fails on React's
"Encountered two children with the same key" console.error. The fix was restored
and re-verified green.

### Divergences

1. **One test TITLE renamed beyond the brief's list.**
   `cloudwatch.adapter.test.ts:496` read "trims the longest field first when the
   response exceeds the byte bound". NEW-1 removed longest-first ordering from
   the cap loop, so the title asserted an ordering the code no longer has. It is
   now "trims an oversized field to the cap and leaves the small ones whole",
   which is what its assertions actually check. No assertion changed.
2. **NEW-3, NEW-4, NEW-6, NEW-8, NEW-9 and the C3 durability challenge were NOT
   touched** - out of this pass's brief. NEW-3 (RecentErrors dedup test does not
   re-reconcile) and the C3 record-durability challenge are the two worth a
   decision before the branch is cleaned up, since `.superpowers/` is gitignored.
