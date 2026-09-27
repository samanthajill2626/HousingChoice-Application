# Plan review R2 - reviewer A (adversarial)

Plan: `docs/superpowers/plans/2026-09-25-inbox-rows-timestamps.md` (v2 @41159963)
Spec: `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md` (DRAFT 8.1)
Also read: `plan-r1-adjudications.md`, `plan-r1-reviewer-b.md`.
Repo: `W:\tmp\inbox-rows-timestamps`. Read-only; nothing was run. Plan line
numbers below are v2's.

Labels: DECISION = a task's mechanism must change to deliver the spec;
PRECISION = a sentence, a test case, or a factual slip.

Headline: the auto-load rewrite fixes the scroll path I reported in round 1,
but it does not remove the stale-report hazard. That hazard now lives on the
paths where a commit ARMS auto-load. Those include the restore path, which is
the heart of Option B. The rewrite also still fails the same unit test it
failed in round 1, for a different reason. No test in the plan can see either
problem, because the hand-driven observer reports synchronously and real
IntersectionObserver never does.

---

## 1. [HIGH][DECISION] Auto-load still loads two pages when the commit that arms it finds a held, unfired "intersecting" report

**Mechanism, as written (plan 2736-2776).** The fire effect runs over
`[report, enabled, onLoad]` and fires when `enabled && report.intersecting &&
report.seq !== lastFiredSeqRef`. A report that arrives while the hook is
DISABLED is not consumed; it stays eligible. The epoch effect calls
`reobserve`, and nothing marks the held report stale. The effects run in
declaration order: observer, then epoch, then fire (plan 2742-2776).

**Real IntersectionObserver semantics.** `observe()` only registers the
target. The entry, including the one `unobserve`+`observe` forces, is computed
during the next rendering update ("run the update intersection observations
steps"). It is delivered in a task queued after that update: never
synchronously, and never before the passive effects of the commit that caused
the reobserve. So in the render where the epoch changes, the fire effect sees
the OLD held report.

The main scroll path is safe, because the report that fired is consumed
(`lastFiredSeqRef === report.seq` at the page commit). Every path where
`enabled` turns true IN THE SAME RENDER as an epoch bump, while an unfired
intersecting report is held, fires twice. The restore path, step by step:

1. POP to the bottom of a restored list that has a cursor. The mount is
   unarmed (spec 5.2; `listFromSnapshot` sets `autoLoadArmed: false`, plan
   ~1690). The observer's initial report says intersecting (seq 1). The hook
   is disabled, so seq 1 is held and unfired.
2. The reconcile head read commits: armed, epoch 0 -> 1. In that render the
   epoch effect reobserves, then the fire effect sees `enabled` flip with
   seq 1 held -> FIRE (load A). This report predates the head read.
3. The reobserve report (seq 2) arrives while A is in flight. Page one is
   short after the clamp, so it says intersecting. The hook is disabled, so
   seq 2 is held.
4. A commits: epoch 1 -> 2, `loadingMore` false. The fire effect sees seq 2
   (`!== lastFired` 1) -> FIRE (load B). Seq 2 describes the geometry BEFORE
   A's 100 rows were appended.

Result: two pages. This violates invariant 3 and spec 5.2's own restore claim
that the head read's epoch bump "fires the one wanted load" (spec 379-384).
The same shape follows:

- a manual Load more click after an Unknown-tab budget exit disarmed the list
  (spec 370-373: the click re-arms and bumps the epoch);
- any head read that re-arms after a no-new-rows page;
- any report that arrives mid-load because the operator scrolled across the
  margin edge.

The plan's self-review (d), "a page commit can never fire from the stale
intersection state the effect holds at that moment" (plan 4566-4569), is
false.

**Why no test sees it.** The only restore e2e (test 3, second half) leaves
the list at `cursor: null`, so no sentinel exists before the head read. Test 6
never restores. The unit fake reports synchronously (finding 3).

**Implies.** Invalidate held reports on every epoch change: in the epoch
effect, set `lastFiredSeqRef.current = seqRef.current` BEFORE `reobserve`, so
only reports taken after the reobserve can fire. Keep disabled-time reports
eligible otherwise. Spec 5.2 needs "held reports are superseded by an epoch
change" in its rule, and Task 6 needs a test in which `enabled` and `epoch`
change in the same render with an intersecting report held.

## 2. [HIGH][DECISION] Task 6's "does not fire when only enabled changes" test still fails against the v2 hook

The adjudication (theme 4) says the rewrite "also settles A6/B6 ... there is
no epoch comparison any more." It does not. Trace of plan 2592-2599 against
plan 2736-2776:

- render with `enabled={false}`: `observe()` reports `false` (seq 1);
- `cross(true)`: seq 2, disabled, so no fire and `lastFiredSeqRef` stays 0;
- rerender with `enabled`: the fire effect runs on the `enabled` change and
  sees `report.intersecting` true with `2 !== 0`, so it calls `onLoad()`.

The test expects `not.toHaveBeenCalled()`, so Task 6 step 4's "PASS, 7
tests" (plan 2785) is false.

This is a rule conflict, not a typo. The test's scenario (a report arrives
while disabled, then `enabled` flips with no epoch change) is the one spec 5.2
says never fires (spec 335-339). But the discard case (spec 377-378) needs
exactly that shape to fire: the reobserve report after a head read arrives
while the discarded `loadMore` still holds `loadingMore`. Consuming
disabled-time reports breaks the discard re-issue; keeping them fails this
test.

The failed-page case the test's comment names is really fired-then-failed,
and the v2 code already handles that (the fired seq is consumed).

**Implies.** Pick the rule with finding 1's fix: disabled reports stay
eligible and epoch changes invalidate. Then rewrite the test to the real
failed-page shape: fire, disable, re-enable, and assert no second fire.
Correct spec 5.2's "never fires otherwise" sentence to match.

## 3. [MEDIUM][PRECISION] The hand-driven observer reports synchronously, so the unit tests cannot model the effect-ordering hazard

The fake's `observe: () => onReport(current)` and `reobserve` both report
inside the calling effect (plan 2543-2548), so the fresh report is always
scheduled before the next render. Real IO reports after the next rendering
update, in a later task. That window, in which the epoch render's fire effect
evaluates the held report, is where findings 1 and 2 live.

The test "an epoch change re-observes and fires only from the fresh report"
(plan ~2606-2623) never changes `enabled` alongside the epoch. The production
page-commit render always does: `.then` commit plus `.finally`
`setLoadingMore(false)` are batched.

**Implies.** Make the fake queue reports and flush them explicitly
(`flushReports()` inside `act`). Add the same-render `enabled` + `epoch` case,
with and without a held intersecting report.

## 4. [MEDIUM][PRECISION] Task 7's scroll test still dereferences `document.scrollingElement`

The code block is unchanged: `const scroller = document.scrollingElement as
HTMLElement; scroller.scrollTop = 999;` (plan 2919-2920). The prose after it
(plan 2954-2958) says to assign through
`document.scrollingElement ?? document.documentElement`. jsdom 25 has no
`scrollingElement`: the repo's own shim is at
`dashboard/src/ui/imageViewer/scroll.test.ts:4-11`, and the adjudication
(theme 1) confirms it. A builder who pastes the block gets a TypeError on the
test's first line.

**Implies.** Fix the code block itself; the prose note does not change what
gets pasted.

## 5. [MEDIUM][PRECISION] The replacement for the line-781 test cannot reach the guard it claims to pin

The rewrite (plan 2084-2126) marks read on All, switches to Unread, lets the
POST commit, then releases the Unread page. `markRead`'s commit bumps
`genRef` only when `filterGenRef.current === mutationGen` (plan 1978). After
the switch the filter epoch has moved, so `genRef` never changes and
`fetchHead`'s first guard (`gen !== genRef.current && statusRef.current ===
'ready'`) is never evaluated with a stale `gen`.

The test would pass with the `&& statusRef.current === 'ready'` escape
deleted. It also duplicates the existing epoch test at
`useInbox.test.tsx:717-769`.

The escape the original test existed for is still reachable on ONE filter:

1. mark a row read (the POST hangs);
2. a reconcile commits an empty page, so `base` is empty;
3. the next reconcile fails, with no rows rendered, so status goes `error`;
4. Retry sets `loading`;
5. the POST commits, bumping `genRef` in the same filter epoch;
6. Retry's page must still install.

**Implies.** Rebuild the test on that same-filter path, or state that the
escape clause is now covered by nothing.

## 6. [MEDIUM][PRECISION] Task 5 edits `Inbox.test.tsx` but neither lists nor stages it

Step 3(e) (plan 2213-2223) adds the five fields to `Inbox.test.tsx`'s
`baseState`. Task 5's Files list (plan 1525-1527) omits that file, and its
commit stages only `useInbox.ts` and `useInbox.test.tsx` (plan 2488). Under
the global rule "stage only the explicit paths named by the task", the fix
stays uncommitted. Task 5's commit therefore still fails the dashboard
typecheck on its own (TS2739 in `baseState`), and Tasks 6's subagent inherits
a dirty file it did not create. AGENTS.md tells it to leave such a file alone,
and Task 7 stages it later.

**Implies.** Add `Inbox.test.tsx` to Task 5's Files list and `git add`.

## 7. [MEDIUM][PRECISION] No hook test exercises the new `restoreScroll` seed

The seed is one line: `useRef(restoreScroll && restored !== undefined ?
restored.scrollTop : 0)` (plan 1743). No test passes `restoreScroll` to the
hook. `grep restoreScroll` over the plan finds only the parameter, the seed
line, and `Inbox.test.tsx`'s mock recording the argument (plan 2834-2838).
The `Probe` in `useInbox.test.tsx` has no such prop.

Spec 7.1 asks for "the unmount save ... writes the seeded `scrollTop` when no
scroll event happened". Reverting the seed to `useRef(0)` keeps every planned
test green.

**Implies.** Add the case: store hit with `scrollTop: 55`,
`restoreScroll={true}`, unmount with no `noteScrollTop` call, expect a saved
55. Then `restoreScroll={false}` expects 0. Run it under StrictMode, which is
the reason the seed exists.

## 8. [MEDIUM][PRECISION] The long-name/placement case was moved to self-QA, which does not carry it; and the long name is mintable in e2e (contests adjudication 19)

Spec 7.3 test 4 (revised, spec ~1036-1041) says the long-name 768px case "is
covered in the live self-QA (7.4) by renaming a contact to a long name".
Task 11 step 4's five self-QA items (plan 4504-4521) do not include it, so
the case the 768px band exists for (spec 5.4 "THE NAME CAN SHRINK") is now
proven nowhere.

The adjudication's premise, "the lean world cannot mint it", is half true:

- The placement tag needs a conversation carrying `placementId`. The lean
  seed's Tasha conversation has none (`app/src/lib/seed/lean.ts:224-235`), so
  the tag does need seed data.
- A LONG NAME does not. The suite already mints named contacts:
  `POST /api/contacts` with `firstName`/`lastName`
  (`e2e/tests/dashboard-next/inbox-mark-unread-header.spec.ts:80-94`), then
  `registerParty` + `sendAsParty` on that phone (`:144-145`). That yields a
  contact row with a long name, which is the only row that stresses the 45%
  head cap.

The minted unknown row the plan uses instead has a short phone name, so its
768px check never exercises name shrink.

**Implies.** In test 4, mint a contact with a long name through the API for
the 768px check, and put the placement-tag case in Task 11 step 4 explicitly.

## 9. [MEDIUM][DECISION] The conversation pages' "Back to inbox" links are PUSH arrivals: the position is lost, and on an installed PWA they may be the only way back

Spec 5.8 sends every PUSH arrival to the top, with the rationale "an operator
who clicks Inbox because the badge says there is new unread must land on the
new rows" (spec ~714). The PUSH arrivals it enumerates are the sidebar link,
the nav badge, and a programmatic navigate. It misses two links with BACK
intent:

- `<Link to="/inbox" aria-label="Back to inbox">` in
  `dashboard/src/routes/conversation/ConversationDetail.tsx:398`;
- the same link in `dashboard/src/routes/conversation/GroupTextView.tsx:319`.

The rationale does not apply to either. The manifest declares
`display: 'standalone'` (`app/src/routes/appIdentity.ts:43`), and an iOS
home-screen install shows no browser back button, so on Sam's phone these
links may be the only way back from a relay or group thread. There the
headline promise ("the same list and the same place") would never happen.
UNVERIFIED how Sam runs the dashboard.

**Implies.** A product call for the human, not a builder guess: either treat
these two links as back (for example, `navigate(-1)` when the previous entry
is `/inbox`, or pass a restore flag in link state), or record in spec 5.8
that they are deliberately "go to inbox".

## 10. [LOW][PRECISION] Two carried-over comment blocks now state false things

The carry-over list (plan 2051-2066) copies these verbatim from `main`:

- Block (3), `useInbox.ts:207-223` on main, calls this reachable: "mark read,
  a background reconcile fails, the operator hits Retry, and the POST commits
  while Retry's page is on the wire. Installing that page instead is safe."
  Under spec 5.7 that sequence keeps `status: 'ready'`, so the guard now
  DISCARDS Retry's page. The banner then stays until the mark-read's own
  reconcile commits.
- Block (5), `useInbox.ts:322-326` on main, says "The filter and cursor are
  captured at callback creation". The v2 `loadMore` reads the cursor from
  `listRef` at call time.

**Implies.** Amend those two sentences while carrying the blocks over.

## 11. [LOW][PRECISION] Task 10b misses a fifth pin in `inboxDiagnostics.test.ts`

Task 10b says "change the four pinned `limit: 30` entries" (plan 4431).
`app/test/inboxDiagnostics.test.ts:37-39` also pins
`.toEqual([30])` ("all at the dashboard's 30"), and the test title at `:10`
says "at 30 rows", so the test goes red after the stated edits.

Its step 5 runs app vitest, whose `globalSetup` throws without DynamoDB Local
(`app/test/globalSetup.ts:69-87`). Task 8 says to start it, but Task 8 is
separable and may be dropped.

## 12. [LOW][PRECISION] Task 8's "honest red" is not red

Plan 3555-3566 says the red is `npm run typecheck` failing "on the unknown
`inboxPrefetch` key". Step 1 already widens `makeDeps`' `routerOpts` type, and
the only other use is a spread
(`...(routerOpts?.inboxPrefetch !== undefined && { inboxPrefetch: ... })`).
TypeScript does not excess-property-check spread members; the existing
`unreadWalkLimit` spread uses the same shape (`app/test/inboxFeed.test.ts:118-120`).
So nothing is red before Step 4.

The paragraph also still contains an unedited self-question ("under vitest's
esbuild strip? No:").

## 13. [LOW][PRECISION] `expectHeadFirst`'s second assertion can never fail

After `expect(after[0]?.cursor).toBe(false)`, `firstHead` is 0, so
`after.slice(0, firstHead)` is empty and `.some(...)` is always false
(plan 3921-3927). The helper checks only that the first request is a head
read. Its docstring's "no cursor request precedes a head read" is not
separately enforced.

## 14. [LOW][PRECISION] Self-QA item 5 still says auto-load "appends on scroll" at `?limit=2`

Plan 4519-4520. Revised spec 7.3 (tests 2 and 3) says the chain runs on load
at a tiny limit, so this QA step describes behavior the build will not show.

## 15. [LOW][PRECISION] Interface blocks still show the three-argument hook, and Task 7's Files list omits `Inbox.styles.test.ts`

- Task 5 Produces: `useInbox(filter, limit?, operatorId?)` (plan 1540).
- Task 7 Consumes: `useInbox(filter, limit, operatorId)` (plan 2808).
- Task 7 Files (plan 2802-2805) omits `Inbox.styles.test.ts`, which its
  commit stages.

## 16. [LOW][PRECISION] UNVERIFIED: Task 7 mutates a state-held element; `react-hooks/immutability` is an error for dashboard sources

`scrollRoot` is `useState` state, and the restore effect assigns
`scrollRoot.scrollTop = target` (plan 3126-3127). The repo applies
`recommended-latest` to `dashboard/**` (`eslint.config.mjs:47-51`) and
switches `react-hooks/immutability` OFF only for test files (`:64`), which
means it is on for `Inbox.tsx`. That rule rejects mutating values returned
from `useState`. Existing scroll writes go through refs or local variables
(`dashboard/src/routes/contact/Timeline.tsx:2224`).

Not run. Gate 5 is where it would surface. Holding the container in a ref
removes the question.

## 17. [LOW][PRECISION] Spec 5.11's warm-sample worry is unfounded: readiness already waits for the head read

Spec ~832-841 and plan Task 11 step 3 anticipate a warm inbox sample whose
readiness "can resolve BEFORE the head read finishes". Readiness returns only
when `latest.pendingCount === 0` (`e2e/performance/readiness.ts:118-121`).
Every first-party required request begun inside the sample is tracked as
pending (`e2e/performance/collect.ts:436-437, 544-547`), and a restored
mount's head read starts after the sample's click.

So the count is still 1, and the "extend the harness readiness" contingency
should never trigger. Fine to keep as a fallback, but the spec's reason is
wrong.

## 18. [LOW][PRECISION] Concede: adjudication 21

The 404's rejection is handled inside `waitFor`'s async act, before the
assertions run, so the test does discriminate a wrong 404 arm. I withdraw
that part of round-1 A17.

---

## Fixes checked and found correct (no finding)

- **jsdom fallback in code.** `scrollParentOf` falls back to
  `document.documentElement` (plan 3042-3050). jsdom stores `scrollTop` on
  elements (the jsdom 25 Element impl), and `addEventListener` works on
  `<html>`.
- **Rows named by formatted phone.** `displayOf` matches
  `formatPhoneForDisplay`, which is a pure regex (`app/src/lib/phone.ts:73-77`).
  The fake never sends the persona label to the app: `buildInboundSmsParams`
  carries no label (`fake-twilio/src/engine/engine.ts:258-268`), and the
  webhook is awaited (`:275-278`), so rows exist when `sendAsParty` returns.
  Playwright's string `name` is a case-insensitive substring match, so
  `rowFor` works on unknown and contact-backed-unknown rows. Counts in tests
  2-6 hold against the lean world: Tasha plus the group text plus the
  connecting relay group on All.
- **Test 6 arithmetic** (15, 15, 6 plus 2 gives 17, 32, 38), with the
  sentinel starting outside the margin at 1280x400. After finding 1's fix the
  scroll path fires once per scroll.
- **Test 3's first half** at `?limit=10` has no cursor. The second half
  restores `cursor: null`, so there is no sentinel before the head read.
- **Task 10b's classifier edit.** It matches `collect.ts:183-190` and the
  `collect.test.ts` tuples (273, 289, 306, 320, 442). `routes.test.ts:716` and
  `selfQa.ts:145/225` are the harness's OWN fixture reads at `limit=30` and
  correctly stay.
- **Task 8's stop-flag test with `slowReads`.** The main loop's
  `latestRaw(conv-0)` shares worker 0's timer, so only worker 0 can start one
  more chain before `stop()`. Correct code gives 8 or 9 reads, which is at
  most 9. Without `stop`, all 25 chunk reads run.
- **Task 8's degraded-fallback assertion.** It is meaningful: an evict-on-fail
  cache would make the on-arm `findByPhone` count 10 against the off-arm's 9.
- **The inlined fixture** and the `Jun 25` fixture are both fine.
- **Epoch carried across the reset and the 404 arm; status before the empty
  commit.** Both correct. The new epoch assertion is discriminating: the
  synchronous read after `rerender` sees `1`, and it would see `0` under the
  old reset.
- **`Inbox.styles.test.ts`.** The regex matches after comment stripping, and
  both cases go red before Task 7 step 4.
