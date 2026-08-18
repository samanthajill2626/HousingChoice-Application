---
id: roster-confirm-dialog-unclosable-on-hung-confirm
title: A hung confirm makes RosterConfirmDialog unclosable on every surface
type: bug
severity: med
status: open
area: dashboard/relay
created: 2026-08-18
refs: dashboard/src/routes/shared/RosterConfirmDialog.tsx:82-92, dashboard/src/routes/shared/RosterConfirmDialog.tsx:143-145
---

**Problem.** Two halves, and only one of them is a defect.

The RIGHT half: `RosterConfirmDialog` now refuses its own dismissals while a
confirm is on the wire - Cancel is `disabled={busy}` and the Modal `onClose`
(Escape, the backdrop, the header X) is wrapped in `if (!busy)`. That guard
closes a real double-purchase door. Without it, a dismissal mid-create hands the
caller its picker back with the member list intact, and a second confirm buys a
SECOND pool number: `POST /api/relay-groups` has no idempotency key, and the
standalone path has no owner row to key a 409 `relay_exists` on.

The GAP: `onConfirm` has no timeout and nothing bounds `busy`. `run()` sets
`busy` true and clears it only in the `.catch`. A confirm promise that never
settles - a request that hangs rather than fails, a caller whose own await never
resolves - therefore leaves `busy` true forever, and with it every dismissal
path disabled at once. The dialog becomes unclosable on Cancel, Escape, the
backdrop AND the X, with no interrupt affordance anywhere: the operator's only
exit is a page reload.

This is worse on the surfaces where the guarded action is REVERSIBLE. The
tour/placement quiet-hours deferral confirms through the same dialog and, inside
quiet hours, the default button only writes a pending row that the operator can
cancel from the card afterwards. Escape used to close that dialog. It no longer
can while the request is in flight, so a hung deferral traps the operator behind
a guard that is protecting an action they could have undone in one click.

**Suggested fix.** Bound the wait rather than removing the guard. Any of:

- a timeout inside `run()` that rejects (and clears `busy`) after N seconds, so
  the existing inline-error path takes over;
- an interrupt affordance that APPEARS after N seconds ("this is taking a while
  - close anyway"), which keeps the fast path guarded and gives the slow one a
  door;
- a per-surface `allowInterrupt` prop, so the reversible tour/placement
  deferral keeps its Escape and only the standalone create - the one that buys
  a number - holds the hard guard.

Note that the CALLER can already be ambiguous-safe independently: the standalone
create's modal treats a no-answer rejection as "may have been created" and lands
on a terminal panel with no retry (`CreateRelayGroupModal`), so a bounded wait
here would not re-open the double-create door on that surface.
