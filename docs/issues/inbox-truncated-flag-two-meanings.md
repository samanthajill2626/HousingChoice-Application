---
id: inbox-truncated-flag-two-meanings
title: The inbox unread feed's `truncated` flag carries two meanings the client cannot separate
type: debt
severity: med
status: open
area: app
created: 2026-08-17
refs: app/src/routes/inbox.ts:1317, app/src/routes/inbox.ts:1346, dashboard/src/routes/inbox/Inbox.tsx
---

**Problem.** `GET /api/inbox?filter=unread` sets `truncated: true` for two
structurally different situations, and the client receives one boolean:

1. THE PAGEABLE BUDGET EXIT - the walk spent its budget, so the page ends early
   AND a cursor is minted. The withheld rows ARE reachable: "Load more" works.
2. THE UN-PAGEABLE ENDS - the depth cap (`seen.size > SEEN_SET_MAX`, no cursor
   minted), and `unresolvedDrops > 0`, which is set AFTER the whole cursor chain
   and names candidates the request could not resolve at all. On a full page every
   lag-dropped candidate lands here, and those rows cannot be paged to.

The `inbox-mark-unread` mission added an operator-visible notice for case 2 ("a
cap is acceptable only if the list says it is capped" - the human's ruling at the
spec gate). Because the wire signal is one flag, the notice cannot be gated to
case 2 from the client: gating on `!hasMore` silences it in the WORST state
(un-pageable rows behind a minted cursor), and not gating it means the notice can
appear above a working "Load more".

The mission shipped the second trade deliberately - an occasionally redundant
notice beats silence in the state the human's ruling is about - and this issue
records the residue.

**Suggested fix.** Split the signal on the wire: keep `truncated` as the honest
"this page ended early" flag and add a second field naming whether the withheld
rows are REACHABLE (something like `truncatedUnreachable: true`, set only by the
depth cap and the unresolved-drop path, never by the budget exit). The client then
renders the capped notice on the unreachable flag alone and leaves the pageable
case to "Load more".

Cheap to do (both branches already exist and are individually commented in
`app/src/routes/inbox.ts`); it is a wire-contract change, so it needs the usual
route test plus the `useInbox` / `Inbox.tsx` half.
