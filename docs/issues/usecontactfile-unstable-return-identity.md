---
id: usecontactfile-unstable-return-identity
title: useContactFile returns a fresh object every render
type: debt
severity: low
status: open
area: dashboard/contact
created: 2026-08-18
refs: dashboard/src/routes/contact/useContactFile.ts:214-216
---

**Problem.** Both return paths of `useContactFile` build a new object on every
render:

    if (state.forId !== contactId) return { ...FILE_LOADING, refetch };
    return { ...state, refetch };

The parts are stable - `state` only changes when a fetch commits, `refetch` is
`useCallback`'d on `[]` - but the wrapper spread is not, so the returned `file`
never keeps its identity across renders.

Verified 2026-08-18 that this costs NOTHING today. `ContactDetail` is the only
consumer, it destructures nothing into a dep array, and every use of `file` is a
direct read in JSX (`file.status`, `file.placements`, `file.relayGroups.rows`,
...). There is no `useMemo`, `useEffect` or `useCallback` anywhere in the page
whose dependency list mentions `file` or a field of it. Zero churn, zero extra
renders.

The gap is a trap for the next consumer, on a page that re-renders constantly:
`ContactDetail` re-renders on every SSE tick (message.persisted,
conversation.updated, scheduled.updated) and on each timeline refetch. The first
`useEffect(..., [file])` or `useMemo(..., [file.relayGroups])` written against
this hook would re-fire on every one of those, and the symptom - an effect that
runs constantly for no visible reason - reads as an SSE bug rather than a hook
identity bug.

**Suggested fix.** `useMemo` the returned object on `[state, contactId, refetch]`
(the `forId` comparison is derived from `state` and `contactId`, so both belong
in the list), returning the `FILE_LOADING` shape or the committed one from
inside the memo. Cheap, and it makes the hook safe to depend on.
