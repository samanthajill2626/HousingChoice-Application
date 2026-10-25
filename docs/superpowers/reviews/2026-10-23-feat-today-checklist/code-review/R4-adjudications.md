# R4 adjudications - feat/today-checklist (tracker #31)

Adjudicated by the build orchestrator, 2026-10-25, on `R4-review.md`
(fresh, the closing round under R3-adjudications' loop rule; HEAD 8f352af6 =
FW3 5a52e978 + one planner docs commit; HIGH 0, MEDIUM 0, LOW 1, INFO 1;
REGRESSION 1, NOT A REGRESSION 1; nothing affects a send). R4 found FW3-1,
FW3-2 and FW3-3 real for their findings.

(R4's first dispatch, ~03:07Z, was cut off by the account's weekly usage
limit before it wrote anything; this R4 was dispatched fresh at 14:03Z.
Infra recovery 1 in the ledger; no budget consumed.)

## Fix wave 4 (one child, fresh) - the regression only

- FW4-1 (R4-1, LOW, REGRESSION, CONFIRMED). FW3-3 keeps contact-less 404
  fallback Identify rows distinct (right) but they still share one React key
  (`refType:refId`, refId `unknown?phone=...`), so React's keyed
  reconciliation leaves ghost rows: a duplicated row after a fallback
  refetch, and a stale fallback row above the server's rows after the server
  answers again, until a reload. Accepted R4's challenge: FW3-3 kept the
  output half of R3-2's fix and dropped the render-key half. Fix: unique
  render keys in the Today item lists - a repeated `refType:refId` within one
  list gets an occurrence suffix (`#2`, `#3`, ...) - so the wire type and
  every refId / link stay untouched (spec 3, PR31: the dashboard type
  mirrors the server wire). Tests: R4's ghost-row probes (fallback refetch;
  fallback then server) made permanent; every existing Today test green.

## Filed, not fixed (loop rule: NOT A REGRESSION)

- R4-2 (INFO, CONFIRMED, pre-existing on the FW3 base and on main's shape).
  A past-tours reload that recovers from a failure, or any reload that goes
  from empty to non-empty, shows "All caught up" for one labeling round trip:
  usePastTours clears `reloadFailed` as soon as the raw rows land
  (dashboard/src/routes/tours/useTours.ts ~328) while useTodayPastTours keeps
  the previous (empty) labeled rows until the labels land
  (dashboard/src/routes/today/useTodayPastTours.ts ~167-178, ~199). Against
  spec 2.3's settle rule and 5.3 ("The All caught up settle wait covers this
  labeling"), for one round trip. FW4 files it as
  docs/issues/today-past-tours-labeling-settle-window.md (type bug,
  severity low, area dashboard), citing those lines and the suggested fix
  (treat "raw rows changed, labels pending" as not settled).

## Loop closes after FW4

FW4 gets one focused fresh check of its own diff (R5). Under the loop rule
any R5 LOW / INFO that is not a regression introduced by FW4 is filed, not
fixed.
