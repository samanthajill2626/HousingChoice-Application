---
id: inbox-truncated-flag-two-meanings
title: The inbox unread feed's `truncated` flag carries two meanings the client cannot separate
type: debt
severity: med
status: open
area: app
created: 2026-08-17
updated: 2026-08-25
refs: app/src/routes/inbox.ts:152, app/src/routes/inbox.ts:1363-1428, dashboard/src/routes/inbox/Inbox.tsx:160-167, dashboard/src/api/types.ts:2824, app/src/lib/unreadFeed.ts:708
---

**Re-adjudicated 2026-08-25 against main @88ac7b36.** The defect still
reproduces and the remedy's shape is right, so this stays open at `med`. What
changed: the accounting is now FOUR producers rather than two, the consumer
trace below is recorded as the load-bearing fact (exactly ONE consumer is
mis-served), the old "cheap to do" line is replaced by two not-skippable builder
conditions, and the stale `refs:` line numbers - which had rotted off the
branches they pointed at - are corrected.

**Problem.** `GET /api/inbox?filter=unread` sets `truncated: true` from FOUR
separate branches carrying TWO different meanings, and the client receives one
boolean: `InboxPage.truncated` (`app/src/routes/inbox.ts:152`, mirrored
field-for-field at `dashboard/src/api/types.ts:2824`). All four branches live in
`aggregateInbox`'s unread cursor chain, `app/src/routes/inbox.ts:1363-1428`:

1. PAGEABLE - THE BUDGET EXIT THAT KEPT ROWS (`:1392-1403`). The walk spent its
   budget, so the page ends early, AND a cursor is minted from the `scanPosition`
   the request already paid for. The withheld rows ARE reachable: "Load more"
   works.
2. UN-PAGEABLE - THE DEPTH CAP (`:1386-1391`, `seen.size > SEEN_SET_MAX`). Past
   this many ids the server can mint no cursor it would itself accept, so paging
   is over while supply remains. This page can be FULL, so it is one of the two
   that reach the notice.
3. UN-PAGEABLE - `unresolvedDrops > 0` (`:1420`), applied AFTER the whole cursor
   chain and naming candidates the request could not resolve at all. On a full
   page every lag-dropped candidate lands here; those rows cannot be paged to for
   the rest of the session, and this branch can co-occur with a minted cursor
   from branch 1 or with the plain natural-end arm.
4. UN-PAGEABLE BUT STRUCTURALLY EMPTY (`:1365-1376`, the budget dying before
   anything was consumed, plus any empty page whose cursor the invariant at
   `:1428` nulls). `state.scanPosition` is assigned on every consumed raw item
   (`app/src/lib/unreadFeed.ts:367`, contract at `:423`), so no row can exist
   while it is undefined: this branch always has zero rows.

Note what branch 1 is NOT. "The budget exit is pageable" holds only when rows
survived; a budget exit that produced none falls into branch 4 and mints no
cursor.

**THE LOAD-BEARING FACT: of the four producers funnelling into one boolean,
exactly ONE consumer is mis-served.** The full trace:

- THE TRUNCATION NOTICE (`dashboard/src/routes/inbox/Inbox.tsx:160-167`) is the
  mis-served one. Its gate is
  `filter === 'unread' && status === 'ready' && truncated && serverRowCount > 0`.
  It depends on the UN-PAGEABLE meaning (branches 2 and 3) and receives the
  union, so branch 1 renders it above a working "Load more". Reachable and
  already pinned on both sides: `app/test/inboxFeed.test.ts:1433` returns
  `truncated === true` with two rows and a non-null cursor, and
  `dashboard/src/routes/inbox/Inbox.test.tsx:327` asserts the notice renders
  alongside the Load more button.
- THE FAILURE BANNER (`Inbox.tsx:42`, rendered at `:183`) is MEANING-AGNOSTIC
  and CORRECT. Gated on `serverRowCount === 0 && truncated`, it is fed by branch
  4 and by branch 3 on an empty page. An empty page that ended early is not "all
  caught up" whether or not the withheld rows are reachable, so this consumer
  must KEEP reading `truncated` and needs no change.
- `useInbox` (`dashboard/src/routes/inbox/useInbox.ts:242` and `:348`, exposed at
  `:540`) is PURE PASSTHROUGH. It forwards the union and depends on neither
  meaning.
- THE NAV BADGE'S `truncated` IS A SEPARATE FIELD AND IS NOT AFFECTED.
  `InboxUnreadCount.truncated` (`app/src/routes/inbox.ts:165-171`) is returned
  verbatim from the collector at `:1725`, which derives it SINGLE-MEANING at
  `app/src/lib/unreadFeed.ts:708` (`truncated: !capped && !state.scanExhausted`).
  The route states the asymmetry outright at `:1714-1717`. That flag is already
  honest; what it lacks is a client - `dashboard/src/app/UnreadContext.tsx:126`
  reads `capped` and deliberately ignores `truncated`. NO badge-side remedy
  depends on this issue, and this issue must not be sequenced ahead of one.

The `inbox-mark-unread` mission added an operator-visible notice for the
un-pageable meaning ("a cap is acceptable only if the list says it is capped" -
the human's ruling at the spec gate). Because the wire signal is one flag, the
notice cannot be gated to branches 2 and 3 from the client: gating on `!hasMore`
silences it in the WORST state (branch 3's unreachable rows sitting behind a
minted cursor), and not gating it means the notice can appear above a working
"Load more".

The mission shipped the second trade deliberately - an occasionally redundant
notice beats silence in the state the human's ruling is about - and this issue
records the residue.

**Suggested fix.** Split the signal on the wire: keep `truncated` as the honest
"this page ended early" flag and add a second field naming whether the withheld
rows are REACHABLE (`truncatedUnreachable: true`), set ONLY by branch 2 (the
depth cap) and branch 3 (the unresolved-drop path), never by the budget exit. The
client then renders the capped notice on the unreachable flag alone and leaves
the pageable case to "Load more". Checked arm by arm against the notice's real
gate: branch 1 suppresses it correctly, branches 2 and 3 render it correctly, and
branch 4 never reaches it because of the `serverRowCount > 0` half.

WHY THE "un-pageable page with rows" WORRY IS CLOSED, which is what makes the
split safe rather than merely tidier: BRANCH ORDERING. `seen.size > SEEN_SET_MAX`
is tested at `app/src/routes/inbox.ts:1386` BEFORE `budgetSpent` at `:1392`, so a
budget-minted cursor can never carry a seen-set past the cap and is therefore
always decodable by the guard at `:358`. There is consequently no rows-bearing
page that is un-pageable while `truncatedUnreachable` stays false - the only
rows-bearing arm that nulls the cursor is branch 2, and `:1428` only fires at
zero rows.

TWO BUILDER CONDITIONS. NEITHER IS SKIPPABLE; the split is wrong without both.

1. THE NEW FLAG NEEDS OR-ACROSS-THE-SESSION SEMANTICS, unlike `truncated`.
   `useInbox` documents `truncated` at `dashboard/src/routes/inbox/useInbox.ts:60-66`
   as "a statement about the LATEST page read, so it is replaced (never OR-ed) by
   each page", and `:348` implements that on Load more. That is right for
   `truncated`, which describes a page - but branch 3 is a SESSION fact: a row
   dropped on page 1 is unreachable for the rest of the paging session no matter
   what page 2 reports. Copying the replace-per-page semantics means one "Load
   more" onto a natural-end page clears `truncatedUnreachable` and the notice
   vanishes while the badge still counts rows no page can show - reintroducing
   the exact silence the split exists to prevent, one click later. So:
   `truncated` stays REPLACE, `truncatedUnreachable` is OR-ed across the paging
   session and reset only on filter change / refetch-from-scratch, alongside the
   existing resets at `:274` and `:307`. This gap is latent in the single flag
   today; the split is where it becomes visible and must be decided out loud.
2. THE CLIENT DEFAULTS TO `truncatedUnreachable ?? truncated`, never to `false`.
   A new dashboard against an older backend sees the field absent; defaulting it
   false renders the notice NEVER, which is silence in precisely the branch-2 and
   branch-3 states the human's ruling covers. The nullish fallback keeps today's
   loud-but-imprecise notice as the degraded mode, which is the direction the
   ruling points.

Scope. All four branches already exist and are individually commented in
`app/src/routes/inbox.ts`, so the server half is a second local variable plus one
field on the return at `:1452`. It is a wire-contract change, so
`dashboard/src/api/types.ts:2824` moves with `app/src/routes/inbox.ts:152` (the
mirror is declared field-for-field), and it needs the route test plus the
`useInbox` / `Inbox.tsx` half. Note the client test at
`dashboard/src/routes/inbox/Inbox.test.tsx:327` asserts the ACCEPTED TRADE and
must be INVERTED rather than deleted - it becomes two tests, unreachable+hasMore
renders and pageable+hasMore does not - and the design-record comments at
`Inbox.tsx:119-159` and `Inbox.test.tsx:318-326` argue for the current behavior,
so they must be rewritten in the same commit.

This issue is now ONE SLICE with `unread-fill-loop-query-amplification`,
`unread-budget-truncation-has-no-forward-path` and
`unread-load-more-empty-on-exact-multiple`, under a single coherent flag contract
(`capped` / `scanExhausted` / `truncated` / `consumedAll`) in
`app/src/lib/unreadFeed.ts`.
