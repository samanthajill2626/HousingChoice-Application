# Plan review R1 - reviewer A (adversarial)

Plan: `docs/superpowers/plans/2026-09-25-inbox-rows-timestamps.md` (v1)
Spec: `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md` (DRAFT 8)
Repo: `W:\tmp\inbox-rows-timestamps` @ `d74bea0e` (read-only; nothing run)

Question asked: if a builder with no context executes this plan literally, do
they produce the spec? No. Four defects stop the build outright (the perf gate
cannot pass, the Playwright spec matches rows that never exist, the Inbox page
crashes every jsdom render that has rows, and auto-load fires two pages per
scroll), and several tasks' "Expected: PASS" lines are false as written.

Evidence note: the worktree has no `node_modules`. jsdom facts below were read
from the main checkout's `node_modules/jsdom` (25.0.1), which the lockfile
shares. Browser/React timing claims are reasoned from the IntersectionObserver
and React scheduling models and are marked where not empirically verified.

---

## 1. [BLOCKING] The perf harness rejects every `limit=100` inbox request as a contract mismatch; the plan forbids the fix

**What is wrong.** The spec (5.11, 4.1) and the plan (Task 11 step 3) treat
`e2e/performance/` as a reader that needs no change. It is not. The collector's
inbox classifier only recognizes page reads at `limit === '30'` and classifies
anything else as an endpoint contract mismatch:

- `e2e/performance/collect.ts:183-190` - four arms, all `limit === '30'`; the
  comment reads "A page read at limit 100 now falls through to the contract
  mismatch below ... the dashboard only ever asks this endpoint for 30."
- `e2e/performance/collect.test.ts:299-305` pins `filter=unread&limit=100` as a
  CONTRACT MISMATCH.
- A mismatch makes the sample `status: 'failed'` (`cli.ts:958-963`), so
  `surfaceEvidence` is null, and `selfQa.ts:344-350`
  (`initialInboxPageRequestCount === 1`, keyed on `inboxRequestClass`) fails
  for every inbox surface; `cli.ts:615-621` counts only requests whose class
  is the `inbox_page_*` class, which a limit-100 request never gets.

After Task 5 the dashboard sends `limit=100` on every inbox read, so
`npm run perf:pages` (a mission gate, spec 5.11 / 7.4, plan Task 11 step 3)
fails on all four inbox surfaces. Task 11 step 3 tells the builder a violation
means "a harness flow visited /inbox twice: report it rather than editing the
harness" - the wrong diagnosis and a prohibition on the only fix.

**Implies.** The plan needs a task that updates the classifier (and
`collect.test.ts:273/289/299-305/320/442`) to the new page size, and the spec's
"no change expected" in 4.1 / 5.11 is false. Until then the build cannot pass
its own gate.

## 2. [BLOCKING] Task 9's Playwright spec locates rows by a fake-twilio persona label that never becomes a row name

**What is wrong.** `seedParties`, test 4's long-name party and test 5's party
are minted with `registerParty` + `sendAsParty`, and then located with
`getByRole('link', { name: new RegExp(label) })` or `rows.find(r => r.name === label)`.

- `registerParty` only registers an ad-hoc persona in the fake Twilio
  (`e2e/fixtures/fakeTwilio.ts:220-231` -> `fake-twilio/src/routes/control.ts:44-51`,
  `engine.addAdHoc`). It never creates an app contact.
- An inbound from a number with no app contact is an UNKNOWN row whose name is
  the formatted phone (`app/src/routes/inbox.ts:1101-1114`); even a
  contact-backed row with no name falls back to the phone
  (`inbox.ts:1033-1039`). The label appears nowhere in the app.
- The existing spec that needs a named row creates the contact through the API
  first (`e2e/tests/dashboard-next/inbox-mark-unread-header.spec.ts:80-94`,
  `createContact` -> `POST /api/contacts`), then calls `registerParty` for the
  fake side only (`:144`).

So test 1 (`expect(apiRow).toBeDefined()` and the `fresh` link), test 2 (`label4`,
`label5` links), test 4 (the long name - which becomes a short phone, so the
tightest-band case is never exercised - and `plainName`), and test 5 (`label2`
link) all fail or time out. Counts happen to survive (unknown rows are rows on
All), which is why the arithmetic in the plan looks right.

**Implies.** The spec file must mint fresh CONTACTS (API create with a
run-unique name and number) and register the same number with the fake. As
written, Task 9 cannot pass.

## 3. [BLOCKING] Task 7's scroll-container fallback is `document.scrollingElement`, which jsdom 25 does not implement: every jsdom render with rows crashes

**What is wrong.** Plan Task 7 `scrollParentOf` (plan lines ~2843-2853) walks
`getComputedStyle(...).overflowY` and falls back to `document.scrollingElement`.
In jsdom there is no computed `overflow-y: auto` anywhere (vitest `css: false`,
`dashboard/vite.config.ts` test block), so the walk always falls through to the
fallback, and jsdom 25.0.1 has no `scrollingElement` at all (grep of the whole
package finds none). The repo already knows this: `dashboard/src/ui/imageViewer/scroll.test.ts:4-11`
stubs `document.scrollingElement` with `defineProperty`, and `scroll.ts:35`
guards it with `instanceof HTMLElement`.

Consequence chain in the plan's code: `setScrollRoot(undefined)`; the listener
effect's guard is `if (scrollRoot === null) return;` (plan ~2912), `undefined`
passes it, and `scrollRoot.addEventListener(...)` throws a TypeError in a
passive effect. That fires on every render of the real `Inbox` that has rows:

- about 20 existing `Inbox.test.tsx` cases render `rows: [mkRow()]`
  (e.g. `Inbox.test.tsx:235, 249, 388, 394, 418`);
- the two COMPOSED cases in `useInbox.test.tsx:860-902` render the real `Inbox`;
- the new Task 7 tests for the banner, the sentinel, and the groups link.

The new scroll-restore test (plan ~2758-2787) also does
`const scroller = document.scrollingElement as HTMLElement; scroller.scrollTop = 999`,
a TypeError on its first line. The plan's self-review ("jsdom reports no
computed overflow, so the unit test asserts against the document's scrolling
element") rests on a property that does not exist.

**Implies.** Task 7 step 5 ("PASS (36 existing + 16 new)") is false. The code
needs a null/undefined-safe fallback, and the tests need an explicit scroller
(or a stubbed `scrollingElement`, as `scroll.test.ts` does).

## 4. [BLOCKING] The epoch arm reads a stale `intersecting` after a page commits, so auto-load loads two pages per scroll

**What is wrong.** Spec 5.2 claims "after a full page the sentinel is outside
the margin and the epoch-driven re-check finds `intersecting` false." The plan
implements exactly that rule (plan `useAutoLoad` ~2588-2596). But `intersecting`
is React state written ONLY by the IntersectionObserver callback, and IO
notifications are delivered asynchronously, in a task queued after the next
rendering update. The sequence after a scroll-triggered load:

1. `loadMore` resolves: `.then` -> `commitList(appendPage(...))` (epoch N+1),
   `.finally` -> `setLoadingMore(false)` (plan ~1885-1895). Both run as
   microtasks of one promise chain, so React batches them into one render.
2. That render has `epoch = N+1`, `enabled = true`, and `intersecting = true`,
   still the value from BEFORE the 12/100 appended rows pushed the sentinel
   away. The IO has not observed the new layout yet.
3. The passive effect runs (a scheduler task, before the next frame's IO
   notification): `began` is false, `epoch !== lastFiredEpochRef` -> it fires
   `onLoad()` again.
4. Only after that does the IO report `false`, which is too late to stop the
   second request.

Result: every scroll-to-bottom issues two cursor requests (two pages). The same
double fire follows a restore's first reload and any reconcile that re-arms at
the bottom. This breaks invariant 3 ("never chains past one page per commit
unless the committed page was short in pixels"), and Playwright test 6 (plan
~3874-3884: exactly one cursor request per scroll, `toHaveCount(26)`) fails.
The unit tests cannot see it because they inject a hand-driven observer.

UNVERIFIED empirically (nothing was run), but it follows from the IO spec's
async delivery and React's batching of the `.then`/`.finally` updates. Neither
has a path where the observer's report lands before the passive effect.

**Implies.** A design change is needed before Task 6. For example, on an epoch
change reset `intersecting` and re-observe so the next report is fresh, or
measure the sentinel's rect against the root synchronously when the epoch
changes. The plan gives the builder no remedy when test 6 goes red.

## 5. [HIGH] An existing hook test pins the behavior the spec removes, and the plan tells the builder to "fix the hook"

**What is wrong.** `useInbox.test.tsx:781-829` ("a mark-read committing under
RETRY does not strand the tab on a spinner") starts with a background reconcile
that fails while a row is rendered and waits for `status === 'error'` (`:802`).
Under spec 5.7, and under the plan's hook (plan ~1795-1799: rows rendered ->
`setRefreshFailed(true); return;`), status stays `ready`, so this `waitFor`
times out.

Task 5 step 2 claims "the existing 36 tests PASS", and step 4 says: "A failing
existing test named in the output is a regression in the rewrite, not a test to
edit: fix the hook." For this test that instruction pushes the builder to
reintroduce the blank-to-error behavior that spec 5.7 and decision 7 remove, or
to stall.

**Implies.** The plan must name this test as superseded and say what replaces
it. Its real subject, a Retry whose page lands after a mark-read commit, must
still not strand. Under the new rules that only applies to the no-rows Retry,
so the scenario has to be rebuilt without rows rendered. Any other existing
test that encodes the old wholesale-replace semantics also needs to be listed.

## 6. [HIGH] The useAutoLoad unit test and implementation disagree: "does not fire when only enabled changes" fails

**What is wrong.** The implementation initializes `lastFiredEpochRef = useRef(-1)`
(plan ~2570), and its fire test is `began || epoch !== lastFiredEpochRef.current`
(~2592). Test 2 (plan ~2456-2463) renders `enabled={false} epoch={1}`, fires
intersection `true` (no fire, disabled), then rerenders `enabled epoch={1}`:
`began` is false, but `1 !== -1` is true, so `onLoad` fires. The test expects
`not.toHaveBeenCalled()`, so Task 6 step 4 ("PASS, 6 tests") is false.

**Implies.** The builder must choose a semantic the plan never states.
Initializing to the mount-time epoch satisfies the test and still fires the
restore's first reload (epoch 0 -> 1). Keeping -1 means an `enabled` flip fires
whenever no fire has happened yet. Pick one, and pin it.

## 7. [MEDIUM] InboxRow test expects "Jun 30" for an instant that is "Yesterday" in every real time zone

**What is wrong.** The test setup pins now to `2026-07-01T12:00:00Z`
(`dashboard/src/test/setup.ts:34`). The plan's relay-row fixture is
`2026-06-30T10:00:00.000Z` (plan ~382), 26 hours earlier, and asserts
`toHaveTextContent(/^Jun 30$/)` (~385). For any offset from UTC-10 to UTC+11,
now is local Jul 1 and the fixture is local Jun 30, so `formatInboxTime`
correctly returns `Yesterday`. The test cannot pass as written.

**Implies.** Change the fixture date (for example, Jun 28 -> "Jun 28"). Step 5's
"16 existing plus 5 new" PASS is false until then.

## 8. [MEDIUM] Task 8's tests call `splitSeed()`, which is scoped inside another `describe`

**What is wrong.** `splitSeed` is declared inside
the "aggregateInbox ... cursor paging (split-proof)" `describe` block
(`app/test/inboxFeed.test.ts:881-906`). The plan appends a new top-level
`describe` whose `mixedSeed()` calls `splitSeed()` (plan ~3214-3216). That is
a ReferenceError at run time and a `Cannot find name` error under
`npm run typecheck`, because `app/tsconfig.test.json` includes `test/`.

**Implies.** Hoist `splitSeed` to module scope, or duplicate it. Task 8 step 6
("every existing case plus the 6 new" PASS, typecheck exit 0) is false as
written.

## 9. [HIGH] Tests 2 and 3 (second half) assume auto-load waits for a scroll; at `?limit=2` it fires on load

**What is wrong.** Test 2 (plan ~3704-3708) opens `/inbox?limit=2` at the
default 1280x720 viewport and asserts `rows toHaveCount(4)`, then
`loadMore toBeVisible()`, BEFORE scrolling. Four rows plus the page header put
the sentinel about 370px down `main.content`: inside the viewport, and far
inside the `400px 0px` root margin. The first IO report is `intersecting: true`
while armed, so auto-load fires immediately and chains to the end, and Load
more disappears. Test 3's second half (plan ~3780-3781) does the same at
1280x400, where the margin still covers it.

Both assertions race the chain: `toHaveCount(4)` passes only if a poll catches
the transient 4-row state, and `toBeVisible()` on Load more fails whenever the
chain has already finished. Spec 7.3 test 2 carries the same premise, and the
plan copies it without checking. The "scroll to the bottom" step then
exercises nothing.

**Implies.** Assert page one before arming is possible (for example, a
viewport or page size where the sentinel starts outside the margin), or drop
the pre-scroll assertions and assert the chain instead.

## 10. [MEDIUM] Task 5's typecheck gate fails because `Inbox.test.tsx` is not updated until Task 7

**What is wrong.** Task 5 adds five REQUIRED fields to `InboxState`
(`refreshFailed`, `autoLoadArmed`, `pageEpoch`, `restoredScrollTop`,
`noteScrollTop`). `Inbox.test.tsx:20-36` `baseState()` returns an `InboxState`
literal without them. `dashboard/tsconfig.json` includes `src`, test files
included. Task 5 step 5 runs `npm run typecheck` and expects exit 0, which
fails with TS2739 until Task 7 step 1(a) extends `baseState`.

**Implies.** Task 5 is not self-gating as the header claims ("each self-gating
with ... `npm run typecheck`"). Either move the `baseState` edit into Task 5 or
make the new fields optional there.

## 11. [MEDIUM] The stop-flag test's `<= 9` bound is a microtask race, not a property of the code, and it is green before implementation

**What is wrong.** Test "the stop flag ends scheduling..." (plan ~3281-3295)
asserts `listByConversation <= 9` at `limit: 1` over a 25-item chunk. The
stated reasoning ("at most HYDRATE_CONCURRENCY chains were in flight ... so
1 + 8") does not match the worker (plan ~3479-3497):

- all 8 first-wave chains complete their `latestRaw` in lockstep with the loop's
  own chain for conv-0, so the count is at least 8 before `stop()`;
- each worker then immediately starts a second chain. Whether any second chain
  reaches `latestRaw` before `stop()` runs (after `rowForConversation` returns,
  the push, and the boundary re-query await) depends on exact microtask depth.

So the result is 8 or 16 depending on promise-tick counts. A correct
implementation can fail it, and a small refactor can flip it. Separately,
step 3's "expected red" is wrong: without prefetch the count is 1 (passes);
the equivalence tests compare two sequential arms (pass); and vitest does not
typecheck, so "TypeScript complains" produces no red.

**Implies.** Assert something structural instead (for example, count chains
started after `stop()`, via a spy on the worker's scheduling or a deferred repo
that holds reads). Correct step 3's expectations.

## 12. [MEDIUM] The strict "exactly one head read" windows in e2e tests 2 and 3 are open to any extra `conversation.updated`

**What is wrong.** Test 2 (plan ~3727-3732) requires exactly one non-cursor
request after an inbound. Test 3 (~3772-3774, 3794-3797) requires exactly one
after a return. The hook's debounce only coalesces events that arrive within
300ms of each other. Any event later than that yields a second head read and
fails the assertion: a second write from the inbound path, the debounced
extraction run the Twilio webhook schedules (`app/src/routes/webhooks/twilio.ts:268-272`),
or a mark-read from the clicked row.

UNVERIFIED whether the hermetic lane emits a second event for these flows. The
spec (7.3) asks for these counts, but the plan adds no quiescence step, such
as waiting until no inbox request has been seen for N ms before taking `mark`.

**Implies.** Add a settle step before each `mark` and bound the window. If the
lane does emit a second event, the tests flake, and AGENTS.md makes every
flake a regression to diagnose.

## 13. [MEDIUM] No unit pin for the load-bearing `overflow-anchor: none` rule (spec 7.1)

**What is wrong.** Spec 7.1 lists "the page root has `overflow-anchor: none`"
among the `Inbox.test.tsx` additions. The plan's Task 7 tests omit it. Spec 5.2
makes this rule the guard against auto-load chaining through scroll anchoring,
and only the (flawed, see 4) e2e test 6 exercises it. jsdom with `css: false`
cannot see it, but the repo has a precedent for asserting CSS-module source:
`dashboard/src/app/AppFrame.styles.test.ts:1-30`.

**Implies.** Add a source-level CSS assertion, as AppFrame does, for
`.page { overflow-anchor: none }`. The same approach can pin the InboxRow media
query value `767.98px`.

## 14. [MEDIUM] E2E test 4 drops the spec's placement tag, so the tightest one-line band never exercises chips that do not shrink

**What is wrong.** Spec 7.3 test 4: at 768x720, "on a seeded row with a long
name AND a placement tag". The plan's test 4 (~3800-3806) seeds only a long
label, and per finding 2 that label never renders, so the row carries a short
phone name. The 45% head cap versus non-shrinking chips (spec 5.4) is exactly
what the 768 band was chosen to test. The plan's self-review does not record
the deviation.

**Implies.** Seed a real contact with a long name and a placement (the lean
seed's placement-backed row, or an API-created placement). Otherwise record the
deviation for adjudication.

## 15. [MEDIUM] The whole-file replacements delete the load-bearing rationale comments in `useInbox.ts` and `Inbox.tsx`

**What is wrong.** Task 5 step 1 and Task 7 step 3 replace both files wholesale.
Among the reasoning they drop, each block explaining why a guard exists and
which adversarial finding added it:

- `useInbox.ts:144-186`: why `filterGenRef` is an epoch and `activeFilterRef`
  an identity, and the A-to-B-to-A trap;
- `useInbox.ts:207-237`: "THE GENERATION GUARD PROTECTS A LIST, NOT A SPINNER",
  including the "HONEST STATUS" note that no test fails if the filter guard is
  deleted;
- `useInbox.ts:437-455`: the mutation epoch;
- `Inbox.tsx:29-66`: the three-state empty-copy doctrine;
- `Inbox.tsx:156-196`: the truncation notice's gating;
- `Inbox.tsx:257-283`: Load more gated on `hasMore` alone.

The guards survive; the reasons do not. The next reader will re-litigate them
or remove a guard that "no test covers" (the file says so itself).

**Implies.** Edit these files in place, or carry the rationale blocks forward
verbatim where their code survives.

## 16. [LOW] Task 8 says `inboxFeed.test.ts` runs without DynamoDB Local; the app `globalSetup` throws

`app/test/globalSetup.ts:69-87` throws when DynamoDB Local is unreachable unless
`ALLOW_SKIP_DYNAMO_TESTS=1` is set, for every file including in-memory ones
(`app/vitest.config.ts:129`). Plan Task 8 step 3 (~3314-3315) claims otherwise.
The builder needs `npm run db:start` or the opt-out for the focused run.

## 17. [LOW] Several new tests do not discriminate what their names claim

- "a failed background head read ... a 404 does the same" (plan ~2296-2301)
  waits only for the THIRD call to be made, then asserts `ready` and
  `refreshFailed: true`. Both were already true from the 500, so a 404 path
  that set `pending` would still pass if the rejection is processed after the
  assertions.
- "pageEpoch bumps ... not on ... a reset" (plan ~2274-2285) never performs a
  reset.
- Spec 7.2's "degraded-fallback memoization test" (two callers of a failing
  key share one read, and the fallback is memoized, never a rejection) is not
  written. The equivalence tests compare outputs, not read counts for the
  failing key.

## 18. [LOW] The reset and the no-rows 404 path diverge slightly from the stated epoch and save rules

- The reset commits `emptyListState()` (plan ~1826), which sets `pageEpoch`
  back to 0. Spec 5.2 says the reset never bumps the epoch. A move to 0 is a
  change the epoch arm compares against, harmless only because the sentinel
  unmounts during `loading`.
- The 404 arm with no rows rendered calls `commitList(emptyListState())` BEFORE
  `applyStatus('pending')` (plan ~1800-1805). When the current status is
  `ready` with an empty list, this saves an empty `ready` snapshot. The next
  mount then restores "No conversations yet" instead of the pending copy until
  its reconcile 404s.

## 19. [LOW] Commit trailer hard-codes "Claude Fable 5.1"

Plan global constraints (line ~80) and every commit step use
`Co-Authored-By: Claude Fable 5.1`. `.claude/CLAUDE.md` routes implementation
fan-outs to `opus`, and AGENTS.md requires the trailer to name the AUTHORING
model. A builder following the plan literally will misattribute.

## 20. [LOW] Task 11's perf-harness guidance misdescribes the harness's flows

Spec 5.11 and plan Task 11 step 3 say warm samples `goto` their source, so
`/inbox` is reached once per page session. `prepareWarmSource`
(`e2e/performance/cli.ts:653-670`) calls `goto` only for the FIRST source.
Later sources are reached by clicking `a[href="<source>"]` in the live page, as
`cli.test.ts:339-341` shows: `goto:/inbox`, `tab:Unread`, `link:/inbox`, ...
So the Inbox IS re-mounted from the store within one page session, for
example as the source for `/conversations/:id` (`routes.ts:576, 609`).

Counts stay clean today for a different reason: the NetworkCollector drops any
request that began before `beginSample` (`collect.ts:347-368, 404-406`). The
plan's "report it rather than editing the harness" advice rests on the wrong
model; finding 1 is the real failure the builder will meet.
