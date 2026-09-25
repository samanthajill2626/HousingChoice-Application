# Plan review R1 - reviewer B (adversarial)

Plan: `docs/superpowers/plans/2026-09-25-inbox-rows-timestamps.md` (v1 @d74bea0e)
Spec: `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md` (DRAFT 8)
Method: read-only. Every claim about existing behavior cites a file:line I read in
this worktree or in the shared `node_modules` of the main checkout (the worktree
has none installed). Nothing was run except one `node -e` locale probe.

Question asked: if a builder with no context executes this plan LITERALLY, do
they produce the spec? No. Three tasks cannot reach green as written (5, 7, 9),
and the final perf gate cannot pass by construction (11).

---

## 1. [BLOCKING] Task 7's scroll-container resolution crashes every row-rendering Inbox test in jsdom

**What is wrong.** `scrollParentOf` (plan lines 2843-2853) walks ancestors for
`overflowY: auto|scroll` and otherwise returns `document.scrollingElement`. jsdom
25.0.1 does not implement `document.scrollingElement`:

- `grep -rl scrollingElement node_modules/jsdom/` returns nothing (jsdom 25.0.1,
  main checkout `node_modules/jsdom/package.json`).
- The repo's own test shims it by hand:
  `dashboard/src/ui/imageViewer/scroll.test.ts:4-11` (`Object.defineProperty(document, 'scrollingElement', ...)`).
- `dashboard/vite.config.ts` test block sets `css: false`, so no ancestor ever
  computes `overflow-y: auto` in unit tests; the walk always falls through.

So in every unit render that has rows, `setScrollRoot(undefined)` runs (plan line
2908). The passive listener effect (plan lines 2911-2916) guards only
`scrollRoot === null`; `undefined` passes the guard and
`scrollRoot.addEventListener(...)` throws a TypeError inside an effect, which
unmounts the tree.

**Blast radius.**
- Every existing `Inbox.test.tsx` case that renders rows: lines 234-253, the six
  group-truncation cases 299-373, and six of the eight Unread-notice cases
  387-477. Roughly 14 of the 36 existing cases.
- `useInbox.test.tsx:860-888` (COMPOSED, renders the real `Inbox` with rows).
- The new Task 7 tests that render rows (banner, sentinel, groups link, scroll).
- The new scroll test itself throws before rendering:
  `const scroller = document.scrollingElement as HTMLElement; scroller.scrollTop = 999;`
  (plan line 2759-2760) is `undefined.scrollTop = 999`.

The plan's own "Known judgment calls (a)" (plan lines 4176-4179) states the test
"asserts against the document's scrolling element" - the premise is false in this
repo's jsdom.

**Implies.** Task 7 Step 5 ("PASS ... then exit 0, exit 0") cannot be reached. The
fix needs both a code guard (`?? null`, or resolve the container differently) and
a test-side shim of `document.scrollingElement` the way `scroll.test.ts` does.

---

## 2. [BLOCKING] Task 9 finds rows by the fake persona label, but a fake persona never becomes an app name

**What is wrong.** `seedParties` (plan lines 3622-3634) calls `registerParty` +
`sendAsParty`. `registerParty` only posts to the FAKE's
`/control/personas/ad-hoc` (`e2e/fixtures/fakeTwilio.ts:220-231`,
`fake-twilio/src/routes/control.ts:44-51`); the app never learns the label. An
inbound from a number with no app contact is rendered as an UNKNOWN row whose name
is the formatted phone: `app/src/routes/inbox.ts:1101-1114`
(`kind: 'unknown', name: formatPhoneForDisplay(phone) ?? phone`). The suite already
records this: `e2e/tests/dashboard-next/inbox-nav-badge.spec.ts` ("The derived
title falls back to formatted numbers for members with no name, so the button is
matched by shape").

Every lookup by `label` therefore matches nothing:
- test 1: `getByRole('link', { name: new RegExp(label) })` and
  `body.rows.find((r) => r.name === label)` (plan lines 3676-3685);
- test 2: `label4`, `label5` lookups (plan lines 3722, 3740-3742);
- test 4: `longLabel` and `plain` lookups (plan lines 3802-3837);
- test 5: `label2` lookups (plan lines 3853, 3858).

Test 4 is worse than a selector bug: the row it exists to test ("a seeded row with
a long name and a placement tag", spec 7.3 test 4) cannot be produced by a fake
persona at all - the name will be a 14-character phone - and the plan silently
drops the placement tag the spec names. The 768px "tightest band" proof it
carries is therefore vacuous even once the selector is fixed.

**Implies.** Four of six Playwright tests fail on their first data-dependent
assertion. Task 9 needs app-side contacts (a real name, optionally a placement)
or phone-shaped selectors; test 4 specifically needs a contact with a long name and
a placement context to prove what spec 5.4 promises.

---

## 3. [HIGH] Test 2 (and test 3's limit=2 half) assert a pre-scroll state that auto-load erases on load

**What is wrong.** Test 2 opens `/inbox?limit=2` in the project default viewport
(`devices['Desktop Chrome']`, 1280x720, `e2e/playwright.config.ts` projects) and
asserts `toHaveCount(4)` then `loadMore toBeVisible()` BEFORE scrolling (plan lines
3704-3708). Page one at limit 2 is 2 paged + 2 multi-party rows, roughly 380px
including the header - the sentinel is inside the 720px scroller even before the
400px root margin. Per Task 6 the first observer report sets `intersecting`, the
head commit armed the list and bumped the epoch, so `useAutoLoad` fires at once and
the epoch rule chains to the end (the spec's own words: "at limit=2 every page is
short in pixels, so the epoch rule chains to the end"). `toHaveCount(4)` races the
chain and `loadMore(page).toBeVisible()` fails once the chain has emptied the
cursor.

Test 3's second half has the same shape at 1280x400 (plan lines 3780-3781:
`toHaveCount(4)` right after `goto ?limit=2`).

**Implies.** Even with finding 2 fixed, test 2 is deterministic-red on the
Load-more assertion and the 4-count is a race. The pre-scroll state needs a
viewport/limit where page one is taller than viewport + 400px, or the assertion
must be dropped.

---

## 4. [BLOCKING] The perf harness classifies inbox page requests by `limit === '30'`; the mission gate cannot pass and the plan forbids the fix

**What is wrong.** `e2e/performance/collect.ts:183-189` classifies an inbox page
request only when `limit === '30'`; the inline comment says "A page read at limit
100 now falls through to the contract mismatch below ... the dashboard only ever
asks this endpoint for 30". Any `limit=100` read returns
`endpointContractMismatch: true`. Consequences:
- `e2e/performance/cli.ts:958-996`: every inbox sample (all four inbox surfaces,
  cold and warm, and the conversation-detail sample whose source is `/inbox`)
  becomes `status: 'failed'`, `reason: 'endpoint_contract_mismatch'`.
- `e2e/performance/selfQa.ts:341-350`: `requestClassesMatch` requires
  `request.inboxRequestClass === INBOX_PAGE_CLASSES[...]`, which is now `null`.

Spec 5.11 enumerates the harness as a reader and concludes "no change expected";
this classifier is the surface it missed. Plan Task 11 Step 3 (plan lines
4110-4119) then instructs: "A violation on a warm inbox sample means a harness flow
visited /inbox twice: report it rather than editing the harness" - the wrong
diagnosis, and a prohibition on the only fix. The harness unit tests pin the old
value too (`e2e/performance/collect.test.ts:273,289,306,320,442`,
`routes.test.ts:716`), and they run under gate 2 (`npm test` includes the e2e
workspace, root `package.json` "test").

**Implies.** `npm run perf:pages` fails deterministically. Fixing it is a harness
change (classifier + tests + ledger citations) that the spec says is not expected
and the plan forbids, so this needs a planner/spec decision before the build, not
at the last gate. If it merged unfixed, the perf harness would be broken on main
for every inbox surface.

---

## 5. [BLOCKING] An existing useInbox test pins the exact behavior the spec abolishes, and the plan forbids editing it

**What is wrong.** Task 5 Step 2 (plan lines 2033-2042) expects all 36 existing
`useInbox.test.tsx` cases to pass, and Step 4 (plan lines 2363-2364) says "A
failing existing test named in the output is a regression in the rewrite, not a
test to edit: fix the hook."

`useInbox.test.tsx:781-829` ("a mark-read committing under RETRY does not strand
the tab on a spinner") drives a background reconcile to FAIL while one row is
rendered and then waits for `status: 'error'` (line 802). Under spec decision 7 /
5.7 that exact situation must keep `status: 'ready'` and raise `refreshFailed`, and
the plan's rewritten `fetchHead` does so (plan lines 1795-1799). The plan's own new
test (plan lines 2287-2302) asserts the opposite of line 802. The old case will
time out at its `waitFor`.

**Implies.** A literal builder is told to "fix the hook" to satisfy a test that
contradicts the spec. The plan must name this case and say how it is rewritten
(its real subject - a Retry from a no-rows error state racing a mark-read commit -
is still worth pinning, starting from an initial-load failure instead of a
background one).

---

## 6. [MEDIUM] A Task 6 test cannot pass against the Task 6 code

**What is wrong.** Test "does not fire while disabled, and does not fire when only
enabled changes" (plan lines 2456-2463): render `enabled={false} epoch={1}`,
`fire(true)`, rerender `enabled epoch={1}`, expect no call. The hook initializes
`lastFiredEpochRef = useRef(-1)` (plan line 2570) and fires when
`began || epoch !== lastFiredEpochRef.current` (plan line 2592). On the rerender
`began` is false but `1 !== -1`, so `onLoad` IS called once. Step 4's "Expected:
PASS, 6 tests" (plan line 2606) is wrong.

**Implies.** The builder hits a red with no guidance on which side is right. The
test models the failed-page case without a prior fire; the code's -1 sentinel means
"never fired" also counts as "epoch changed". Initializing the ref to the mount
epoch satisfies the test and still fires on the first head-read and restore
commits (both bump the epoch) - but the plan must decide, not the builder.

---

## 7. [MEDIUM] Task 5 claims a green typecheck that depends on Task 7's test edits

**What is wrong.** Task 5 Step 5 (plan lines 2366-2374) expects `npm run typecheck`
to exit 0 and says `Inbox.test.tsx` "pass[es] unchanged until Task 7". The
dashboard tsconfig includes `src` (`dashboard/tsconfig.json` "include": ["src", ...]),
so test files are typechecked. `Inbox.test.tsx:20-36` declares
`function baseState(...): InboxState` returning an object without the five fields
Task 5 makes required (`refreshFailed`, `autoLoadArmed`, `pageEpoch`,
`restoredScrollTop`, `noteScrollTop`) - a TS2739 error until Task 7 Step 1(a).

**Implies.** False independence between Tasks 5 and 7; the per-task gate the plan
advertises ("each self-gating with ... npm run typecheck", plan lines 138-141)
fails at Task 5.

---

## 8. [MEDIUM] Task 8's equivalence fixture calls a function that is out of scope

**What is wrong.** The new top-level `describe('aggregateInbox - prefetch
equivalence ...')` (plan lines 3189-3296) calls `splitSeed()` in `mixedSeed()`.
`splitSeed` is a LOCAL function declared inside
`describe('aggregateInbox — cursor paging (split-proof)')` at
`app/test/inboxFeed.test.ts:885`, whose block closes at line 993. Appended at module
scope, every test in the new block throws `ReferenceError: splitSeed is not
defined`. (The app tsconfig includes only `src`, so `npm run typecheck` will not
catch it; it fails at runtime.) The plan's "judgment call (b)" (plan lines
4180-4181) asks the builder to check `ContactItem` fields but not this.

**Implies.** Task 8's tests cannot run as written; hoist or copy the fixture.

---

## 9. [LOW] Task 8's red step is not red, and its "no DynamoDB needed" claim is false

**What is wrong.**
- Step 3 (plan lines 3302-3315) admits the equivalence tests "PASS trivially" before
  implementation, and predicts a TypeScript complaint about `inboxPrefetch` - but
  vitest does not typecheck, and an extra property on a deps object is inert at
  runtime. The stop-flag test also passes pre-implementation (one latest-message
  read <= 9). Nothing goes red; the TDD step proves nothing.
- "inboxFeed.test.ts is in-memory and runs without it": `app/vitest.config.ts`
  wires `globalSetup: './test/globalSetup.ts'`, which THROWS when DynamoDB Local is
  unreachable unless `ALLOW_SKIP_DYNAMO_TESTS=1` (`app/test/globalSetup.ts:72-86`).
  The plan never says to start it before Task 8.

**Implies.** A builder without Docker running sees a globalSetup failure the plan
says cannot happen. Low because the fix is obvious once seen.

---

## 10. [LOW] The 404 path saves an empty snapshot while the inline comment says it cannot

**What is wrong.** In the rewritten `fetchHead` catch (plan lines 1800-1806), when no
rows are rendered but `status` is already `'ready'` (an empty tab), a 404 runs
`commitList(emptyListState())` BEFORE `applyStatus('pending')`. `commitList` saves
whenever `statusRef === 'ready'` and alive, so an empty snapshot IS written - the
comment "status is not ready: nothing is saved" is false for this path. The existing
case `useInbox.test.tsx:834-851` (empty truncated Unread page, then a 404 reconcile)
walks exactly this path. A later return to that key restores `'ready'` with the
empty copy instead of `'pending'`.

**Implies.** Violates spec invariant 7's spirit ("no snapshot ... from a reset");
swap the two lines.

---

## 11. [LOW] The reset changes `pageEpoch`, which the spec and the plan's own constraint forbid

**What is wrong.** Spec 5.2 and plan Global Constraints (plan lines 54-55): the epoch
is bumped ONLY by committed head reads and pages, "never by ... the reset". The
reset commits `emptyListState()` (plan lines 1823-1831), whose `pageEpoch` is 0, so
every filter/limit change moves the epoch (back to 0). It is harmless today only
because the sentinel is gated on `status === 'ready'` and unmounts during
`'loading'`, resetting `intersecting`. Spec 7.1 asks for a test that the epoch does
not move on a reset; the plan's epoch test (plan lines 2274-2285) covers mark-read
and failure but not reset.

**Implies.** An unenforced invariant that holds by accident of an unrelated render
gate. Carry the epoch through the reset or state why it may reset.

---

## 12. [LOW] Spec-required tests are missing or deviated

**What is wrong.**
- Spec 7.1: "`Inbox.test.tsx` additions: ... the page root has
  `overflow-anchor: none`." The plan has no such test (its "16 new" count at plan
  line 3123 is 15 by enumeration: 10 `it.each` rows + 5 cases). With `css: false`
  in the dashboard test config, a computed-style check is impossible; it needs a
  CSS-text assertion. The only other guard is e2e test 6.
- Spec 5.8 seeds `scrollTopRef` with the restored value at mount on a POP arrival,
  and spec 7.1 asks for a test that "the unmount save ... writes the seeded
  scrollTop when no scroll event happened". The plan starts `scrollTopRef` at 0
  (plan line 1729) and relies on `Inbox.tsx` calling `noteScrollTop` after a
  re-render (plan lines 2923-2930). Under StrictMode (dev and the e2e harness, per
  spec 2) the simulated unmount's layout-cleanup save therefore rewrites the
  restored key's snapshot with `scrollTop: 0` before the restore runs. Nothing
  visible breaks today (the `restored` state keeps the real value and the next
  ready save corrects the store), but the invariant the spec specified is not the
  one built, and its test is absent.

---

## 13. [LOW] Unenumerated reader: the manual inbox profiler still models 30-row pages

**What is wrong.** `app/src/lib/inboxDiagnostics.ts:58-72` (`npm run perf:inbox`)
states "Dashboard pages request 30 rows" and profiles `limit: 30` for all four tabs;
`app/test/inboxDiagnostics.test.ts:16` pins it. After this change the tool profiles
a workload the dashboard no longer issues - and it is the tool that would measure
whether 5.10's prefetch (or `?limit=50`, spec 8) is needed at 100. Neither spec
section 6 nor the plan names it; no issue is filed.

---

## 14. [LOW] Task 8 changes the unread and unknown branches that the spec says are untouched

**What is wrong.** Spec 5.10: "The unread and unknown branches are not touched."
Task 8 Step 4(f) (plan lines 3437-3440) re-routes `latestMessageOf` through the new
per-request `latestRaw` memo, and both branches call `latestMessageOf`
(`app/src/routes/inbox.ts:1492`, and the unknown branch's hydration). Within one
request a second read of the same conversation now returns the memoized first
answer. I found no current path where that changes a result, but the equivalence
test cannot see it either way: both of its arms run the new caches (only the
prefetch pass is switched), so it proves prefetch on == prefetch off, not
"new == main".

---

## 15. [LOW] Whole-file replacements delete the load-bearing rationale comments

**What is wrong.** Task 5 replaces `useInbox.ts` whole and Task 7 replaces
`Inbox.tsx` whole. The replacements drop the adversarial-review reasoning that
guards non-obvious code, for example `useInbox.ts:160-171` (why an identity and not
a generation counter), `:224-236` (the "HONEST STATUS" note that ends "Delete it
only together with that argument"), `:437-455` (epoch vs identity for mutations),
and `Inbox.tsx:29-63`, `156-196`, `257-283` (the serverRowCount doctrine, the S8
notice gate, the M1 Load-more gate). The plan gives no instruction to carry them.

---

## 16. [LOW] Commit trailer hardcodes a model the overlay says should not be building

**What is wrong.** Every commit step uses
`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (plan line 80 and each
task). `.claude/CLAUDE.md` directs implementation fan-outs to `opus` and reserves
Fable for the orchestrator; AGENTS.md requires the trailer to name the AUTHORING
model. Child-authored commits will be misattributed if copied literally.
