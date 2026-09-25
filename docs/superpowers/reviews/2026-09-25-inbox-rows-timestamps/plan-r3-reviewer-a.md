# Plan review R3 - reviewer A (adversarial)

Plan: `docs/superpowers/plans/2026-09-25-inbox-rows-timestamps.md` (v3 @c7744e19)
Spec: `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md` (DRAFT 8.2)
Also read: `plan-r2-adjudications.md`.
Repo: `W:\tmp\inbox-rows-timestamps`. Read-only; nothing was run. Plan line
numbers are v3's.

Labels: DECISION = a task's mechanism must change to deliver the spec;
PRECISION = a sentence, a test case, or a factual slip.

## Honest read: is this round precision-only?

Nearly, but not entirely. Everything OUTSIDE Task 7b is precision.
Task 7b carries one genuine decision (finding 1: the two mark-unread
departures now land on a different URL, and an existing e2e spec pins the old
one) and one product question (finding 6). Both belong naturally to the
ruling Cameron already owes on 7b, so the round can close if that ruling
answers them.

The auto-load rewrite is right in every common path I walked. What remains
there is one claim worded too absolutely (finding 5), with a one-line
hardening.

---

## 1. [HIGH][DECISION] Task 7b breaks an existing e2e spec: the group-text mark-unread departure no longer lands on bare `/inbox`

Task 7b swaps `navigate('/inbox')` in `ThreadUnreadToggle.tsx:189` and
`ContactDetail.tsx:399` for `backToInbox()`. The row link now carries
`{ fromInbox: true }`, so after 7b those departures go BACK to whatever inbox
URL the row was opened from.

`e2e/tests/dashboard-next/inbox-mark-unread-header.spec.ts` (its group-text
case) does exactly this:

1. `page.goto(\`${NEXT}/inbox?filter=groups\`)`;
2. clicks the row;
3. presses the header's Mark unread;
4. asserts `await expect(page).toHaveURL(/\/inbox$/, ...)` at line 215.

After 7b the URL is `/inbox?filter=groups`, which does not end in `/inbox`,
so this assertion fails at the `npm run e2e` gate. The contact case at line
174 still passes, because it opens from bare `/inbox`.

Spec 4.1 says existing inbox specs "are re-run unchanged and must stay green"
(spec 249). Task 7b step 5 names only unit tests to update. A literal builder
meets this red at gate 4 with nothing in the plan that authorizes editing the
spec.

This is also a real product difference, not just a test artifact. D2 ("the
unread direction is a DEPARTURE - it navigates to the inbox") becomes "returns
to the tab you came from, restored". That may be better, but it is a change.

**Implies.** Cameron's 7b ruling must cover the two mark-unread departures
separately from the two back arrows. Either keep them as pushes to `/inbox`
(drop those two call sites from 7b), or name this spec edit (the regex becomes
`/\/inbox(\?|$)/`) and record the exception in 4.1.

## 2. [MEDIUM][PRECISION] `backToInbox.test.tsx`'s "goes BACK in history" case cannot pass as written

The `/inbox` route element is `<><InboxStub /><OpenFromInbox /></>`
(plan ~3450). `OpenFromInbox` navigates to `/conversations/x` from a mount
effect (plan 3430-3436).

After `fireEvent.click(back)`:

1. `navigate(-1)` pops the MemoryRouter to `/inbox?limit=7`. `go(-1)` is
   synchronous in memory history, and `fireEvent` runs inside `act`, which
   flushes the router's transition.
2. The route's element remounts, and `OpenFromInbox` mounts again.
3. Its effect runs inside the same `act` and pushes `/conversations/x` again.

When the assertion runs, the DOM is the `Thread`, so
`screen.getByTestId('inbox')` throws. Task 7b step 5's PASS is false.

**Implies.** Open the thread from a button, or from an effect guarded by a
module flag, rather than from an unconditional mount effect on the route you
go back to.

## 3. [MEDIUM][PRECISION] Task 7's fix for the immutability rule reads a ref during render, which is a `react-hooks/refs` error

v3 passes `root: rootReady ? scrollRootRef.current : null` into `useAutoLoad`
in the component body (plan 3170). Reading `ref.current` during render is
exactly what `react-hooks/refs` rejects. The rule is ON for dashboard sources
through `recommended-latest` (`eslint.config.mjs:47-51`) and OFF only for
test files (`:62`). The spec itself records the repo's `react-hooks/refs`
rule (spec section 2).

So round 2's LOW (state mutation) has become a ref-in-render error on the
same line, and gate 5 fails on `Inbox.tsx`. UNVERIFIED, since lint was not
run.

**Implies.** Keep the element in state for rendering and for `useAutoLoad`,
and write `scrollTop` through a local ref mirror set in the layout effect.
Or pass the ref object into `useAutoLoad` and read `.current` inside its
effects.

## 4. [MEDIUM][PRECISION] The spinner-strand escape is now pinned by nothing; the adjudication's claim and the amended comment are both wrong

Adjudication 5 says the deleted line-781 test is covered because ":717 still
pins the spinner guard". It does not. In `useInbox.test.tsx:717-769` the
mark-read commits after two filter changes, so
`filterGenRef.current === mutationGen` is false, `genRef` is never bumped
(plan 1978), and `fetchHead`'s first guard never sees a stale `gen`.

The escape `&& statusRef.current === 'ready'` therefore has no test, yet it
is still load-bearing on one filter. Reachable path under the v3 hook:

1. mark a row read (the POST hangs);
2. a reconcile commits an EMPTY page, so `base` is empty;
3. the next reconcile fails with no rows rendered, so status goes `error`
   (plan ~1795-1807);
4. Retry sets `loading`;
5. the POST commits in the same filter epoch, so `genRef++`;
6. Retry's page must install. Without the escape, the tab strands on a
   spinner with no Retry.

Two related slips:

- The amended carried comment (3) now reads "Reachable on a filter change:
  mark read, switch tabs ..." (plan 2066). That is the same error: on a
  filter change the guard's first half is false, so the escape is irrelevant.
- The deletion instruction removes "the comment paragraph directly above it
  that begins 'The structural point'" (plan 2092). The paragraph above that,
  `useInbox.test.tsx:771-774` ("RE-REVIEW, the residue BOTH reviewers and I
  missed..."), is left orphaned above the next test.

**Implies.** Add the same-filter test above (it is short). Make the
comment's example the same-filter path. Delete the whole 771-780 comment
block.

## 5. [MEDIUM][PRECISION] "Consumption at arrival" is consumption at RENDER; two interleavings still fire on pre-commit geometry

**Walked against React effect ordering.** Effects in one component run in
declaration order: observer, re-observe, consume (plan ~2770-2803). In the
page-commit render, the re-observe effect calls `reobserve`, and the real
observer reports in a later task. The consume effect then sees the report
that fired, already consumed, and does nothing. The restore, discarded-page,
failed-page, mid-load and manual-click shapes all hold. So do the nine unit
tests (traced one by one; all pass).

**Where it still leaks.** The report is "consumed" by the effect in whichever
render first contains it, not at callback time.

- (a) An observer callback for a crossing made during the load can run
  (`setReport`) after the page response resolved but before React's
  scheduled render task. React then batches it with the commit's `setList` +
  `setLoadingMore(false)`. That single render has `enabled` true and a report
  whose geometry predates the append, so the consume effect FIRES on it: two
  pages.
- (b) Per the IntersectionObserver spec, `unobserve` removes the
  registration but does not purge entries already queued for delivery. An
  entry recorded in the frame before the commit and delivered after the
  re-observe call arrives while enabled and is consumed as fresh.

Both need a crossing in a narrow window, so they are rare. UNVERIFIED in
Chromium. But the spec now states the absolute rule "a report that predates
the commit that enabled the hook can never fire" (spec 340-343), and the plan
says the rule is "independent of that timing" (plan 2509). Neither is true.

**Implies.** In the re-observe effect, set `consumedSeqRef.current =
seqRef.current` before `reobserve`. That closes (a): the effect runs before
the consume effect in the same flush. For (b), drop entries whose
`entry.time` precedes the re-observe call. Or soften the two sentences to
"in the common case".

## 6. [MEDIUM][DECISION] Task 7b's rationale does not reach the main path: contact rows open a page with no way back

The stated reason for 7b is that on the installed app "there may be no
browser back button" (spec ~733-747). But contact rows, the majority of the
inbox, open `/contacts/<id>`. Unknown rows open `/contacts/unknown?phone=`.
`ContactDetail.tsx` has no back affordance at all (grep finds no back link or
`to="/inbox"` in `routes/contact/*.tsx`). There the way back is the
sidebar/drawer Inbox link, which is a PUSH, so it lands at the top.

7b therefore restores position only from relay and group threads and from
the two mark-unread departures. Whether iOS standalone offers an edge-swipe
back is UNVERIFIED.

**Implies.** A question to fold into Cameron's 7b ruling. Either a back
affordance on the contact page (reusing `useBackToInbox`), or a spec 5.8
sentence recording that the in-app way back covers thread pages only.

## 7. [LOW][PRECISION] The intercepted "Back to inbox" link hijacks modified clicks; keyboard activation is fine

Keyboard: Enter on a focused anchor dispatches a `click`. React Router's
`Link` runs the user's `onClick` first and skips its own navigation when
`defaultPrevented` is set, so keyboard activation takes the back path
correctly.

But `e.preventDefault()` is unconditional (plan ~3536-3541). Ctrl/Cmd-click
(new tab) and Shift-click (new window) become an in-tab history back.
Middle-click fires `auxclick`, not `click`, and is unaffected.

**Implies.** Return early on `e.button !== 0 || e.metaKey || e.ctrlKey ||
e.shiftKey || e.altKey`, the same test RR's `Link` applies internally.

## 8. [LOW][PRECISION] Task 7b puts the hook in the wrong component in `ConversationDetail.tsx`

The back link at `ConversationDetail.tsx:398` lives in `RelayGroupView`
(declared at `:176`), not in the exported `ConversationDetail` (`:77`). The
instruction "call it in the component body (with the other hooks, before any
early return)" (plan 3528) reads as the top-level component, whose early
returns are at `:113-160`. The call belongs in `RelayGroupView`.

## 9. [LOW][PRECISION] "Dropping Task 7b deletes nothing else" is false

Plan 3376 says nothing depends on 7b. But Task 9 test 3's in-app back step,
Task 11 step 4 item 4's second half, and spec 7.3 test 3's last sentence
all do. The drop instruction must name them.

---

## Checked and found correct (no finding)

- **The nine `useAutoLoad` tests pass against the v3 hook.** I traced each
  with the synchronous fake:
  - "enabling alone never fires": `reobserved` 0, and seq 2 was already
    consumed;
  - restore shape: one fire from the post-reobserve seq, none after the
    second commit;
  - mid-load shape: the crossings during the load are discarded, the commit
    re-observes, and it fires once;
  - sentinel unmount/remount: the epoch is handled while the sentinel is
    null, and the new observer's initial report fires only on crossing.

  The two NO_REPORT resets to `consumedSeqRef = 0` are harmless, because
  `seqRef` is monotonic.
- **Real IntersectionObserver.** `unobserve` + `observe` creates a new
  registration whose initial entry is computed at the next rendering update
  and delivered in a later task, never synchronously. The plan's comments
  now say so.
- **`POST ${APP}/api/contacts` with `{ type, firstName, lastName, phone }`.**
  - The route parses that body and returns 201 (`app/src/routes/contacts.ts:1021-1060`).
    The existing spec relies on the same shape
    (`inbox-mark-unread-header.spec.ts:88-91`).
  - The CSRF check passes an absent `Origin`, and accepts a local dev origin
    (`app/src/middleware/csrfOrigin.ts:52-60`).
  - The session cookie is `Secure` only in production and `SameSite=lax`
    (`app/src/middleware/auth.ts:63-64`). An APIRequestContext request is not
    a cross-site browser request, and a host-only `127.0.0.1` cookie matches
    the app port because cookies ignore ports, so `page.request` carries the
    dev-login session.
  - The contact exists before the inbound, so `findByPhone` folds the thread
    into a contact row named by it.
- **`navigate(-1)` semantics in the browser.** The previous entry is always
  the inbox URL the row was clicked from, filter included. A reload keeps
  history state, and the back becomes a cross-document load of that URL.
  Entries without the state (deep link, badge, new tab, a replace
  navigation) fall back to pushing `/inbox`, so the unsafe direction (state
  present, previous entry not the inbox) does not arise from these call
  sites. `navigationType` is `POP`, so the restore applies. The one e2e
  consequence is finding 1.
- **Task 5's `restoreScroll` seed test** discriminates: the saved value is
  77 with the seed and 0 without, and the unmount save is the only save
  because the head read never settles.
- **Task 8's `toBeGreaterThan(1)`** is red before Step 5 (the sequential loop
  reads one) and green after (the eight first-wave reads).
- **`expectHeadFirst`** now asserts something real in both call sites.
- **Test 3's in-app step.** `GroupTextView` renders `Back to inbox` (its
  `aria-label`) after the header loads; Playwright's click auto-waits; the
  row click is a no-op mark-read (lean group `unread_count: 0`); the back is
  a POP to `/inbox?limit=10` with the snapshot saved on unmount.
- **Conflict check for 7b's new files.** No 2026-09 plan or spec in
  `W:\tmp\share-skip-fix`, `W:\tmp\retry-send-window` or
  `W:\tmp\send-outcome-reconcile` names `ContactDetail`,
  `ConversationDetail`, `GroupTextView`, `ThreadUnreadToggle` or
  `InboxRow`.
