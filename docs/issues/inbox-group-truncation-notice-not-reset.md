---
id: inbox-group-truncation-notice-not-reset
title: The inbox group-truncation notice survives a failed refetch and sits above the error banner
type: bug
severity: low
status: open
area: dashboard/inbox
created: 2026-08-16
refs: dashboard/src/routes/inbox/Inbox.tsx, dashboard/src/routes/inbox/useInbox.ts
---

**Problem.** Filed from the conformance re-review of `feat/inbox-unread-index`
(N4). PRE-EXISTING. The filing note claimed adjacency to that branch because the
inbox error banner is now easier to reach on the Unread tab (an empty truncated
unread page renders it - spec 4.5 step 3). That adjacency does NOT hold: the
server never sets `groupsTruncated` on a `filter=unread` response, so the notice
cannot be standing on the Unread tab from a server page and the easier-to-reach
banner there cannot collide with it. See "Which tabs can reach it" below. The
defect itself is real and unaffected - it lives on All and Groups.

`Inbox.tsx:75` renders the group-truncation notice on `inbox.groupsTruncated`
ALONE. The whole gate is `{inbox.groupsTruncated ? (`, and nothing in the block
it opens reads `inbox.status`. `groupsTruncated` is written in exactly three
places in `useInbox.ts`: set from the page on success (`:241`), cleared on the
404/pending arm (`:271`), and cleared by the filter-change effect (`:303`). It is
NOT cleared on the generic (non-404) error arm, whose last statement is a lone
`applyStatus('error');` (`:278`), and NOT by `retry()`, which only sets
`status: 'loading'` and re-enters `fetchFirstPage` (`:314-317`). That error arm
leaves `base` and `truncated` standing too; `truncated` is harmless there only
because its own notice IS status-gated (`Inbox.tsx:160-163`).

Failure scenario: the operator is on a filter whose first page reported
`groupsTruncated: true`, so the notice renders. A background refetch (an SSE
reconcile, or `retry()`) fails. `status` becomes `'error'`, the row block stops
rendering (it requires `status === 'ready'`), and the page now shows

```
Showing the latest N group texts.  See all group texts
We couldn't load your inbox.  [Retry]
```

- a claim about a list that is no longer on screen, with a working link, sitting
directly above the statement that the list could not be loaded. Retrying does
not clear it; only switching filters does. Low severity: nothing is lost and the
link still goes somewhere real.

There are TWO bad renders, not one. The `'error'` one above, and a second one
while `retry()`'s request is on the wire: `retry()` sets `'loading'` without
clearing anything, so the same notice makes the same claim above the
`<Spinner center />` at `Inbox.tsx:169`. A fix has to cover both.

**The 2026-08-24 `useInbox` rework did not touch this.** That work (the
`activeFilterRef` / `statusRef` + `applyStatus` / `firstPageGenRef` /
`clearPendingRefetch` pass, and the filter-EPOCH scoping in
`markRead`/`markUnread`) did change the error arm: it now refuses on both axes
before running, `if (gen !== genRef.current || filter !== activeFilterRef.current) return;`
(`useInbox.ts:265`). But that is a guard on WHEN the arm runs, not a reset of
what it leaves behind, so `groupsTruncated` survives it exactly as before and the
failure scenario above is unaltered. The path is live and already exercised: a
ready page followed by a 500 on the debounced SSE reconcile is driven at
`dashboard/src/routes/inbox/useInbox.test.tsx:796-802`, and the hook's own
comment at `useInbox.ts:256-261` states that a background failure still puts a
healthy list into the error state (filed separately as
`inbox-reconcile-failure-blanks-list`).

**Which tabs can reach it.** The server sets `groupsTruncated` in two places
only: the `filter=groups` branch (`app/src/routes/inbox.ts:1051`) and the
page-one group merge (`app/src/routes/inbox.ts:1610`), which sits inside
`if (startKey === undefined && filter !== 'unknown')` and whose own comment at
`:1601` reads "Only `filter=all` reaches here now (`groups` and `unread`
returned above)". `:1060` states it outright as a structural fact:
"groupsTruncated is never set under unread". So reproduction needs the operator
on **All** (page one) or **Groups**, past the group cap, and then a failing
first-page fetch. It is NOT reachable on Unread or Unknown from a server page,
which is what makes the precondition uncommon even though the consequence is
deterministic once it holds.

Note this is a DIFFERENT half of the same notice from the one already handled:
the count reaching zero through optimistic mark-read is covered in `Inbox.tsx`
(adversarial 30 - the notice drops the count and keeps the link). That fix
addressed a stale COUNT while the list rendered; this is a stale NOTICE while the
list does not.

**Suggested fix.** Gate the notice on `inbox.status === 'ready'` at
`Inbox.tsx:75`, next to the row block it describes. That is the whole change.

It is the preferred arm on precedent, not taste: the sibling notice 85 lines
below is already written this way. The Unread truncation notice at
`Inbox.tsx:160-163` opens

```
{filter === 'unread' &&
inbox.status === 'ready' &&
inbox.truncated &&
inbox.serverRowCount > 0 ? (
```

so `truncated` is hidden on a non-ready status by a GATE and is deliberately not
cleared in the error arm. Gating `groupsTruncated` the same way makes the two
notices consistent; clearing it in the error arm would make them diverge, and
would forge the server's statement rather than suppress a render - `useInbox.ts`
calls `groupsTruncated` "the server's separate, untouched statement"
(`:56-57`). The gate also covers both bad renders above, since `'error'` and
`'loading'` are both non-ready.

The alternative arm - clear `groupsTruncated` in `fetchFirstPage`'s error path
AND in `retry()` - does work, but only if BOTH halves are done; the error-arm
half alone leaves the spinner render open. Prefer the gate.

The gate cannot change a currently-correct render. The only other statuses are
`'pending'`, where `useInbox.ts:271` has already forced the flag false, and the
initial `'loading'`, where it has never been set. The only behavioural delta is
hiding the notice in the two states where it lies.

**Regression test - cheaper than this file originally claimed.** A composed
`useInbox` + `Inbox` render is NOT needed. `Inbox.test.tsx:32-41` mocks
`./useInbox.js` and injects the hook state wholesale through `baseState`
(`:14-30`), so the pin is two cases:
`baseState({ status: 'error', groupsTruncated: true, groupRowsShown: 2, rows: [...] })`
asserting `queryByText(/Showing the latest/)` is null while the alert is up, and
the same for `status: 'loading'`. No existing test breaks: `baseState` defaults
to `status: 'ready'` (`:16`) and none of the group-notice cases overrides it
(`:218-222`, `:235`, `:242`, `:248`, `:259`, `:274`). Optionally add one
`useInbox` test pinning that `groupsTruncated` REMAINS true through a non-404
failure, so the next reader knows the gate - not a reset - is what hides it.

**Scope limit - what this fix does NOT close.** The status gate does not close
the adjacent one-commit filter-change window, and nobody should claim it does.
`useInbox` clears the flag in an EFFECT, so there is one committed render where
the new `filter` is already in the JSX while `groupsTruncated` and
`groupRowsShown` still describe the OLD filter's page - and `status` is still
`'ready'` for that commit, so no status check intercepts it. `Inbox.tsx:151-159`
documents the identical shape for the unread notice. It is PRE-EXISTING and
ORTHOGONAL to this issue, it is not made worse by the gate, and closing it would
want epoch matching or moving the reset out of the effect - not another status
check.

**Re-adjudicated 2026-08-25 against main @88ac7b36.** Verdict STILL-VALID: the
defect reproduces unchanged and the status gate is sound. This pass corrected the
reset inventory in place (three writers, not one - the 404/pending arm clears the
flag too), withdrew the Unread-tab adjacency claim, added the server-side fact
that `groupsTruncated` is never set under `filter=unread`, named the second
(spinner) render, and replaced the composed-render test suggestion with the
existing injected-state harness. Severity stays low.
