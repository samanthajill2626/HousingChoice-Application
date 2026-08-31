# RE-REVIEW - error-surface-detail fix wave

Branch `feat/error-surface-detail` @ `305123e5`, worktree `W:\tmp\error-surface-detail`,
`git status` clean. READ-ONLY: nothing edited, no commits, no docker, no e2e.
Date: 2026-08-25.

Inputs read in full: `adjudication.md` (incl. the PLANNER RULING), both round-1
reports, `sdd/fix-wave-report.md`, and the whole `03a3e2ed..305123e5` diff (14
files) against the CURRENT tree.

---

## Gate outputs (re-run by me, bare)

| Gate | Result |
|---|---|
| `cd app && npx vitest run test/cloudwatch.adapter.test.ts test/systemStatus.service.test.ts test/system.routes.test.ts test/expressErrorHandler.test.ts` | **4 files, 108 tests PASSED**, 0 failed (expressErrorHandler 4, systemStatus.service 42, cloudwatch.adapter 40, system.routes 22). Duration 4.39s, exit 0 |
| `cd dashboard && npx vitest run src/routes/settings/` | **16 files, 163 tests PASSED**, 0 failed (RecentErrors 26, ErrorTrace 9). Duration 6.74s, exit 0 |
| `npm run typecheck` (root, bare) | **GREEN**, all 5 workspaces (app x3 tsconfigs, dashboard, e2e, fake-twilio, fake-twilio-web), exit 0 |
| ASCII scan of every added line, `03a3e2ed..305123e5` | **0 non-ASCII** (perl `[^\x00-\x7F]` over `+` lines) |

Every count in the fix-wave report reproduces exactly. Not run (out of brief):
`npm test`, `npm run smoke`, `npm run e2e`.

---

## Verdict per FW item

| Item | Verdict |
|---|---|
| FW-A enforceBound convergence + many-field test | **CLOSED-WITH-CAVEAT** (see NEW-1, NEW-2) |
| FW-B bare-err JSON-object guard + docblock scope | **CLOSED** |
| FW-C URIError `(unrouted)` test | **CLOSED** |
| FW-D dedup test rework | **CLOSED-WITH-CAVEAT** (see NEW-6) |
| FW-E composite row key + test | **CLOSED-WITH-CAVEAT** (see NEW-3, NEW-4) |
| FW-F hook unmount aborts + docblock truth + tests | **CLOSED-WITH-CAVEAT** (see NEW-5) |
| FW-G `@ptr` on trace rows, end to end | **CLOSED-WITH-CAVEAT** (see NEW-7, NEW-8) |
| FW-H `at` ISO tightening + test | **CLOSED** |
| FW-I trace boundary measurement comment | **CLOSED** |
| FW-J `@log` measurement comment + host-metadata note | **CLOSED** |
| FW-K routeLabel baseUrl invariant | **CLOSED** |
| FW-L AJ71 superseding annotation | **CLOSED** |

Nothing from the REJECTED/OUT lists leaked in: no service dedup-key change
(`app/src/services/systemStatus.ts:309` untouched), no trace-window overlap
change, no rate limiting, no `docs/issues/system-trace-insights-spend-*.md`
filed, and `RecentErrors.test.tsx:87` still reads "... correlationId ONLY" as
the planner directed. The diff touches exactly the 14 files the report declares.

### Are the fixes REAL, not merely plausible?

I checked, for each item, whether the closing test actually discriminates.

- **FW-A REAL, measured.** I re-ran the PRE-FIX algorithm against the new test's
  exact fixture (200 x 2000 chars + `@log`): it returns `true` with a final
  payload of **105,114 bytes** against a 65,536 bound, so
  `cloudwatch.adapter.test.ts:508`'s byteLength assertion fails pre-fix. The new
  loop also terminates by construction (`cap` 512 -> ... -> 1 -> `Math.floor(1/2)
  === 0` ends the loop) and I confirmed the post-condition holds on three shapes
  by execution, including the drop path (3000 tiny fields -> 1276 dropped, final
  65,513 bytes, within bound). Key order is deterministic: `longestFirst()` is
  evaluated once per cap level, `Array#sort` is stable, and ties fall back to
  `Object.keys` insertion order.
- **FW-B REAL.** Pre-fix `isAllowedKey('err')` returned `true` unconditionally,
  so `out.fields['err']` would hold the object string and both assertions at
  `cloudwatch.adapter.test.ts:519` fail. No other key's handling changed:
  `isAllowedKey` reads `value` only in the `err` branch, and the call site's
  `String(value)` hoist (`cloudwatch.ts:711`) is behaviour-identical.
- **FW-C** is a missing-guard item, not a defect fix; the test correctly passes
  both before and after. It asserts what the spec named (`(unrouted)` plus the
  malformed-URI prefix on the URIError branch). Fine as written.
- **FW-D** is test-only by design. Half (b) (`systemStatus.service.test.ts:452`)
  is a real pin - remove `ref` from the service key and it goes red. Half (a) is
  weak; see NEW-6.
- **FW-E** code fix is right, but the test does not discriminate; see NEW-3.
- **FW-F REAL.** Pre-fix neither hook had an unmount cleanup, so
  `signal.aborted` is `false` after `unmount()` and both new tests
  (`ErrorTrace.test.tsx:114`, `RecentErrors.test.tsx:279`) fail.
- **FW-G REAL.** Pre-fix `ErrorTrace` marked by `l.timestamp === at`, so the two
  same-millisecond lines in `ErrorTrace.test.tsx:94` would both carry the chip
  and `toHaveLength(1)` fails (and the prop did not exist, so it fails to compile
  first). The whole approach is grounded, not assumed: spec measured fact 9
  (`docs/superpowers/specs/2026-08-24-error-surface-detail-design.md:103`) says
  two independent Insights queries returned a BYTE-IDENTICAL `@ptr` for one
  event, which is exactly the property the cross-query anchor match needs.
- **FW-H REAL.** Pre-fix, `Date.parse('1 Jan 2020')` is a number, so the route
  falls through to the service and answers **200** `unavailable_local`;
  `system.routes.test.ts:281` expects 400 and fails. Sole caller of the route is
  `ErrorTrace` -> `getSystemTrace(kind, id, at)` with `at = event.timestamp`,
  which is `new Date(ms).toISOString()` from the adapter - always matches
  `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/`. Swept `e2e/` (no hits), `RUNBOOK.md` and
  `docs/` (only plan/spec prose). No caller sends a non-ISO `at`.
- **FW-I / FW-J / FW-K / FW-L** are comment/doc items; I verified each landed at
  the cited site with the cited content, and that the AJ71 annotation is appended
  INSIDE the entry with the original resolution text unaltered
  (`docs/superpowers/reviews/2026-08-24-error-surface-detail-design-review.md:917`).

### Declared divergences

- **Divergence 1 (FW-D half (a) rewritten): SOUND, and the implementer's
  reasoning is correct.** I verified the mechanism at
  `app/src/services/systemStatus.ts:297` (`relabeledV8` rewrites `message`) and
  `:309` (the dedup key includes `message`). A single log event matched by both
  the pino and V8-OOM queries therefore yields TWO distinct keys and both copies
  survive. The brief's requested assertion would have been false against the
  shipped service, and changing the service key was explicitly rejected. Writing
  the honest version was the right call.
- **Divergence 2 (extra `queryTrace` fixture line): SOUND.**
  `app/test/systemStatus.service.test.ts:607` builds a real `TraceLineView` and
  could not compile once `ref` became required; `ref: 'TPTR-1'` is the minimal
  change. Root typecheck green confirms nothing else needed it. I re-ran the seam
  sweep: `CloudWatchClientSeam` has exactly ONE implementation
  (`cloudwatch.ts:600`) and ONE fake (`systemStatus.service.test.ts:41-62`); no
  e2e fake, no dev stub. `TraceLineView`/`SystemTraceLine` construction sites are
  `traceLine` (both branches), that one service-test fixture, and the dashboard
  test helpers - all updated.

---

## NEW findings (round 1 missed these, or the fix wave introduced them)

### NEW-1 - SHOULD-FIX (introduced by this wave): the rewritten `enforceBound` is ~10x costlier and can block the event loop for double-digit seconds

`app/src/adapters/cloudwatch.ts:236-241`

```ts
for (let cap = 512; cap >= 1; cap = Math.floor(cap / 2)) {
  for (const key of longestFirst()) {
    if (size() <= RESPONSE_BOUND_BYTES) return true;      // <-- per KEY, per CAP
    if (fields[key]!.length > cap) fields[key] = fields[key]!.slice(0, cap);
  }
}
```

`size()` re-serialises the WHOLE object once per key per cap level, so the call
count went from `N` (old) to up to `11N` (10 cap levels + the drop pass). On a
record whose weight is in KEY NAMES - where no value is longer than `cap`, so the
pass trims nothing and every `size()` is pure waste - this is quadratic work with
a large constant. Measured on this machine (Node, `enforceBound` extracted
verbatim, values 1 char, 30-char key names):

```
n=1000  38,001 B   OLD    1ms   NEW     1ms
n=2000  76,001 B   OLD  717ms   NEW  6745ms   (9.4x)
n=3000 114,001 B   OLD 1678ms   NEW 16106ms   (9.6x)   31,278 size() calls
n=20000            OLD  slow    NEW  did not finish in 4.7 minutes
```

This is a synchronous block inside the `/api/system/errors/detail` handler, so it
freezes the entire single-process Node server - webhooks, health checks, job
polling - for its duration. The route is admin-only, so it is not
anonymously reachable; the trigger is one admin clicking "Show all" on a row
whose flattened record is a few thousand keys wide (GetLogRecord dot-flattens
nested JSON, spec fact 4, and a log event may be up to 256 KB).

The old code was already O(N) `size()` calls and slow at this shape - this is an
amplification, not a brand-new class - but the wave turned "slow" into "wedged",
and it is new, unreviewed code.

Cheap fix: move the `size()` check OUT of the inner loop (check once per cap
pass, and once per K deletions in the drop loop). That is 10 serialisations
instead of 10N, and the only behavioural cost is that a pass trims every
over-cap field rather than stopping at the first fitting moment - immaterial,
since `responseTruncated` already says the payload was trimmed.

### NEW-2 - CONSIDER (test coverage): the last-resort drop loop and every cap below 256 are unexercised

`app/src/adapters/cloudwatch.ts:244-247`, test at
`app/test/cloudwatch.adapter.test.ts:508`

I instrumented the new function against the new test's exact fixture: it
converges at **cap 256 with zero fields dropped**. So the shipped test does not
reach the halving below 256, and never enters the drop loop at all - the two
genuinely new, genuinely tricky branches of the rewrite have no coverage. A
second case (many fields whose NAMES are the weight, e.g. 3000 keys x 1 char)
would exercise both; I verified it converges correctly (1276 dropped, 65,513
bytes final, flag true). Given NEW-1, such a test should also be sized to stay
fast.

### NEW-3 - CONSIDER (test quality): FW-E's closing test does not fail against the pre-fix code

`dashboard/src/routes/settings/RecentErrors.test.tsx:262`

The test renders two rows sharing `ref`, clicks the second expander, and asserts
the first stayed closed. React's duplicate-key misbinding does NOT arise on first
mount - both children mount normally (DEV logs a warning, which this suite does
not escalate: `dashboard/src/test/setup.ts` has no console guard). It arises when
the KEYED LIST re-reconciles, because `mapRemainingChildren` keys existing fibers
by `key` and a duplicate entry keeps only the last one. Expanding a row sets
state inside `ErrorRow` (`RecentErrors.tsx:146-147`), which re-renders that row
only - `RecentErrors` itself never re-renders, and it has no polling refresh
(`useSystemStatus.ts` `useSystemErrors` fetches on mount / window / warnings /
explicit refresh). So the test almost certainly passes with `key={ev.ref}` too.

The code fix (`RecentErrors.tsx:291`) is right and I am not disputing it. The
test just does not pin it. Strengthening is one line: after opening row 2, click
"Refresh recent errors" (re-resolving the same two rows) and assert the open
state is still on row 2. That forces the list reconciliation the defect lives in.

Reasoned, not executed - proving it would have required editing the worktree,
which this review is not permitted to do.

### NEW-4 - NIT: the new row key is not a superset of the service's uniqueness key

`dashboard/src/routes/settings/RecentErrors.tsx:291` uses
`` `${ev.ref}|${ev.timestamp}|${ev.message}` `` while the service guarantees
uniqueness only on `` `${ref}|${timestamp}|${message}|${errorCode ?? ''}` ``
(`app/src/services/systemStatus.ts:309`). Two rows differing ONLY in `errorCode`
survive the merge and collide on the React key. I could not construct a live path
to it (the OOM relabel rewrites `message`, not `errorCode`), so reachability is
effectively nil - but appending `|${ev.errorCode ?? ''}` makes the key
collision-free BY CONSTRUCTION instead of by argument, which is the whole point
of FW-E.

### NEW-5 - CONSIDER (comment truth, same class as round-1 C2): the new abort comment overclaims what an abort cancels

`dashboard/src/routes/settings/useSystemStatus.ts:329-330`

> "Mount-scoped: hiding a trace unmounts ErrorTrace, and its two Insights queries
> should not outlive the view nobody is waiting on any more."

Aborting the browser fetch does not stop the server's work. `app/src/routes/system.ts`
has no `req.on('close')` / `AbortSignal` plumbing (grepped: zero hits), and
`CloudWatchClientSeam.queryTrace` (`cloudwatch.ts:362`) takes no signal, so the
handler keeps polling `GetQueryResults` to completion after the client
disconnects. The abort saves client state and a socket - not the Insights spend.
FW-F existed partly to retire two overclaiming comments; this one replaces them
with a third. One clause ("the client stops waiting; the server-side queries
still run to completion") makes it true.

Related and worth stating: `ErrorTrace`'s load lives in an effect
(`ErrorTrace.tsx:36-38`) and `main.tsx:15` wraps the app in `StrictMode`, so in
DEV every trace open now fires the request pair twice (first aborted). I traced
the ordering and it is SAFE - `useErrorTrace()` is called at `ErrorTrace.tsx:35`,
before the load effect, so on StrictMode's simulated unmount the hook's cleanup
aborts controller #1 and the re-run of the load effect installs controller #2;
the new cleanup can never abort the live controller. No fix needed, but the DEV
double-spend is real given the server does not honour the abort.

### NEW-6 - CONSIDER (test quality): FW-D half (a) does not pin the property its own title claims

`app/test/systemStatus.service.test.ts:429` - "collapses ONE log event that
reaches the merge twice - the shared ref decides". The fixture is
`[same, { ...same }]`, i.e. two byte-identical events. Every component of the
dedup key matches, so they collapse whether or not `ref` is in the key - this
test passes against the PRE-`ref` key too. It shows that dedup exists, not that
ref decides. Half (b) at `:452` is the honest pin and does discriminate. Not
worth blocking on, but the title promises more than the fixture delivers; either
rename it ("collapses byte-identical copies") or drop it in favour of (b) plus
the pre-existing "keeps two same-instant rows from different log groups apart".

### NEW-7 - CONSIDER (regression introduced by FW-G): `ErrorTrace`'s new `li` key reintroduces the degenerate `@ptr` case the wave fixed next door

`dashboard/src/routes/settings/ErrorTrace.tsx:60`

```tsx
<li key={l.ref} className={l.ref === anchorRef ? styles.traceAnchor : styles.traceLine}>
```

The old key was `` `${l.timestamp}-${i}` `` - collision-free by construction.
The new one is the bare pointer, and `traceLine` defaults `ptr = ''`
(`cloudwatch.ts:499`, used on both branches at `:514` and `:531`) when a row
carries no `@ptr` cell. In that degenerate case EVERY trace line takes the key
`''` - the exact failure the sibling comment at `RecentErrors.tsx:289-290` calls
out and guards against. Worse, if the anchor row's `ref` is also `''`, every line
in the timeline renders "this failure", which is a stronger lie than the
over-marking C5 complained about. `key={`${l.ref}|${i}`}` plus
`anchorRef.length > 0 && l.ref === anchorRef` closes both for two tokens. Same
asymmetry, same argument the wave already accepted one file over.

### NEW-8 - NIT: the prop name `anchorRef` collides with the codebase's meaning of `*Ref`

`dashboard/src/routes/settings/ErrorTrace.tsx:31`. Elsewhere in this dashboard
`anchorRef` is literally a React ref handle
(`dashboard/src/routes/tours/RemindersPanel.tsx:163`,
`dashboard/src/routes/placements/usePlacementNudges.ts:68`). Here it is a string
log-event pointer. `anchorPtr` (or `anchorEventRef`) would not have to be read
twice.

### NEW-9 - NIT: an object-shaped scalar `err` is now dropped with no trace in the response

`app/src/adapters/cloudwatch.ts:197`. FW-B is right to refuse it, but the refusal
is silent: the record is JSON, so `rawText` is not returned either
(`cloudwatch.ts:718`), and `responseTruncated` does not cover allowlist drops. An
error whose message text happens to be a JSON body (a vendor error body logged as
`err: e.message` is a plausible shape) vanishes from the detail view with no
indication. The LIST row still shows it via the nested-`err` path, so nobody is
blind - but substituting a placeholder value (`err: '(object value withheld)'`)
would make the decision visible where it happens. Note also the docblock at
`:194` says "JSON OBJECT" while `isJsonObject` at `:205` also returns true for
arrays; the helper's own comment says so, the caller's does not.

---

## Adjudication challenges

### I AGREE with the S1 rejection - and the FW-I comment states it correctly

Taking the measurement as fact (an event at epoch ms 1787022602554 returned by a
query with `startTime == endTime == 1787022602`), Insights treats a second-
granularity bound as covering the whole second. That single measurement settles
BOTH bounds: `endTime: T` reaching `T.554` proves inclusivity, and `startTime: T`
admitting `T.554` proves the start bound also opens at `T.000`. So BEFORE
`[startSec.000, floor.999]` and AFTER `[(floor+1).000, endSec.999]` are disjoint
AND gapless - no hole, no double-return. `cloudwatch.ts:740-757` now says exactly
that, and the `queryInsights`-uses-`ceil` non-contradiction note is right (its
window ends at "now"; rounding up merely admits the current partial second).
Round 1 asked the right question; the answer really was in evidence it could not
see. Nothing to challenge.

### CHALLENGE - dropping adv C3 entirely leaves NO durable record of it

The orchestrator accepted C3 as FW10 (file a Tier-2 issue). The PLANNER RULING
took it out completely: "do not fix AND do not file", to be raised with the human
instead. The problem is where the finding now lives: `.superpowers/` is
gitignored (`.gitignore:52`, confirmed with `git check-ignore -v`), so the
adversarial report is the ONLY record and it dies with the worktree - the exact
trap this project has already been bitten by (memory: "handbacks/review reports
are invisible to `git status` and die with the worktree"). AGENTS.md's own rule
is that anything "important, cross-cutting, or triage-worthy" goes in
`docs/issues/<slug>.md`, and an unmetered per-click multi-query CloudWatch
Insights spend that a `sameSite: lax` top-level cross-site GET can trigger
qualifies on its face - there is even a sibling precedent already in the registry
(`docs/issues/manual-extraction-route-has-no-spend-fence.md`).

I am not asking for a code fix - the planner's judgement that this is a product
call is defensible. I am asking that the record survive the worktree: either file
the low-severity issue as originally adjudicated, or have the human decision
land somewhere tracked before this branch is cleaned up.

### Minor: the `RecentErrors.test.tsx:87` "ONLY" title is still false

The planner ruled the rename OUT (D2 leave) and the implementer correctly did not
touch it. Recording only that the inaccuracy is real and now permanent: the row
renders a source chip, a jobName/event chip and an errType chip
(`RecentErrors.tsx:160-162`) in addition to the four things the title says are
rendered "ONLY". Cosmetic; no action requested.

---

## Sweeps performed for charge item 1 (so absence of findings is evidence)

| Target | Covered | Result |
|---|---|---|
| `CloudWatchClientSeam` | every implementer/fake of the seam | ONE impl (`cloudwatch.ts:600`), ONE fake (`systemStatus.service.test.ts:41`). No e2e fake, no dev stub. The required `ref` cannot break an unseen implementer |
| `TraceLineView` / `SystemTraceLine` | every construction site of the widened type | `traceLine` both branches, `systemStatus.service.test.ts:607`, `ErrorTrace.test.tsx` helper. `RecentErrors.test.tsx` builds NO trace lines (its `getSystemTrace` mock resolves the degraded shape at `:47`), which is why it needed no update |
| `ErrorTrace` render sites | every caller that must now pass `anchorRef` | exactly one production site (`RecentErrors.tsx:210`) + 10 test renders. All pass it |
| `/api/system/trace`, `getSystemTrace` | every caller that could send a non-ISO `at` | one production caller (ErrorTrace -> endpoints), zero in `e2e/`, zero in `RUNBOOK.md`, docs mentions are plan/spec prose only. `at` is always `toISOString()` |
| `ev.ref` / `event.ref` / `l.ref` across `dashboard/src` | every consumer of the pointer | 4 sites, all in the two components; no other module keys or compares on it |
| `req.on(` / `aborted` / `AbortSignal` in `app/src/routes/system.ts` | whether a client abort cancels server work | zero hits - basis for NEW-5 |
| `.superpowers` in `.gitignore` | durability of the review record | line 52, ignored - basis for the C3 challenge |
| non-ASCII on added lines, all 3 commits | AGENTS.md ASCII rule | 0 hits |
| diff file list vs. the report's declared list | undeclared collateral edits | 14 files, exact match, nothing extra |

---

## Bottom line

The wave is real work, not theatre: 10 of 12 items are cleanly closed, the two
substantive code fixes (FW-A convergence, FW-B bare-err guard) are proven by
tests that genuinely fail against the pre-fix code, and both declared divergences
are sound - divergence 1 in particular caught a false premise in its own brief
and handled it honestly.

One item should be dealt with before merge: **NEW-1**, the `enforceBound` cost
regression, because it is new code in a request path that can block the whole
process for double-digit seconds, and the remedy is to move one line out of a
loop. **NEW-7** (the `ErrorTrace` li key) is a two-token fix that closes a
regression the wave itself introduced while fixing the identical problem in the
neighbouring file, and is worth taking in the same pass. NEW-2/NEW-3/NEW-6 are
test-strength items - worth doing, none of them blocking. The rest are nits.
