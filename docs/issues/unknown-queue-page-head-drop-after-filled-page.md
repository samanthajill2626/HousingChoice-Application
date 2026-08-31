---
id: unknown-queue-page-head-drop-after-filled-page
title: Unknown-queue page-head thread-read failure drops a row with zero retries when the cursor came from a FILLED page
type: bug
severity: med
status: open
area: app
created: 2026-08-26
refs: app/src/routes/inbox.ts:1935, app/test/inboxUnknownTab.test.ts
---

**Problem.** The Unknown tab's paged walk defers a page when a contact's
participant-GSI read throws: the page stops at that row and mints a cursor AT
it, so the next request re-reads it. That deferral is capped at one retry by a
page-head guard, which steps OVER the row (an ERROR, and a `dropped` counter)
when the failure lands on the first row a request consumes and nothing has been
kept. Without the cap a failure on row one answers with the cursor it arrived
with, and every Load more repeats the identical request forever - the shape
`readUnknownQueue` throws to outlaw.

The 2026-08-26 phase-6 fix added `resume !== undefined` to that guard, because
the cap's justification ("the previous request already re-read this row") is
false on a fresh page-one load: there was no previous request, so a transient
fault dropped a triage row from a walk that then self-reported complete
(`nextCursor: null`). With the gate, request one defers and request two - which
now carries a cursor - steps over. Exactly one retry, then progress.

**The residual.** `resume !== undefined` cannot tell WHY the cursor exists. A
cursor minted by the page-FULL exit (`boundary = after`, the `keptContacts.length
>= limit` break) is indistinguishable from one minted by a deferral, so the
first row consumed after every filled page still gets ZERO retries: a transient
throttle on that row drops it, and the walk can still end `nextCursor: null`.
The blast radius is smaller than the closed case - it needs a queue longer than
one page and a fault landing on exactly the resumed row - but it is the same
class of defect (a silently missing row on a triage queue), and it is reachable
with the dashboard's `limit: 30` against any queue past 30 rows.

**Suggested fix.** Make the cursor carry its provenance - one extra field in the
`{q,b,k}` unknown-cursor namespace saying whether the position was minted by a
deferral or by a full page - and gate the step-over on "this cursor is a retry
of a deferral" rather than on "a cursor exists". That is a wire-shape change
(`decodeUnknownCursor` validation, the cursor-namespace pins, and the
cross-page cursor tests all move with it), which is why it was filed rather
than folded into the one-predicate fix.

Note the shared root with
`unknown-queue-status-flip-duplicates-across-pages`: both are consequences of a
cursor that carries a POSITION and nothing else.
