# Live-tree build research - findings and adjudications

Research date: 2026-10-08. Source baseline: 1c2264d2 (implementation files match
54e7b0d0). Setup record: bfd273ba. Researchers are read-only Astra xhigh children.
Raw reference and the consolidated implementation worklist belong in
.superpowers/sdd/live-tree-reference.md, not this durable findings file.

## C1 - conversion suggestion cleanup failures must log at error

Status: ACCEPTED by the build orchestrator after checking the plan and live code.
Scope: Tasks 3.1 and 3.6; no product decision or spec change.

The shared helpers proposed in plan lines 3365-3379 swallow suggestion deletion
and verdict failures at warn. The moved type drain also catches read, guarded
delete, and verdict failures (live routes/contacts.ts:1728, :1752, :1789).
Task 3.6 passes the ordinary logger into those helpers (plan:4920) and logs at
error only if an exception escapes. Consequently the outer conversion catch
cannot report these swallowed failures at error, contrary to D19 and plan 3.4.

Add a minimal optional failure-reporting seam to the shared helpers. The contacts
PATCH keeps its existing warning behavior. The conversion supplies error-level
reporting with conversion context. Pin type-read, guarded type-delete,
other-suggestion-delete, and aiRuns.setVerdict failures. A successfully committed
contact conversion still returns successfully; follow-on failures do not roll it
back or throw to the client. Preserve suggestion identity/revision guards.

## Contacts research disposition

No other new S1-S4 drift or contract gap found. No new dependency or schema is
needed. Real/fake parity is a runtime proof obligation for the planned S2 tests,
not something the read-only sweep claims to have tested. All scoped mutation and
reader surfaces, classification extraction importers, typed fakes, pointer rows,
thread ownership, router wiring, and importer bypasses were mapped. The accepted
in-flight extraction and later tour/placement/status races remain deferred.

## O1 - correct Task 7.5a's server allowlist reference

Status: ACCEPTED as a documentation/comment correction; no behavior change.
Task 7.5a cites services/orgRecords.ts RECORD_FIELDS and Task 5.5. The live
server allowlist is routes/organizations.ts:61, widened by Task 5.4. Use that
path when writing the client orgSelection.ts comment (plan:10547, :10612).

## Research close-out

Organization S5/S7: no additional behavior gap or source drift. The existing
plan covers server rewrites/usage/resolution, the merged list/detail Settings
layout, URL selection, and the synchronous one-settle gate. Preserve the gate,
full page width, and distinct-record totals.

Shares/dashboard S6/S8/S9/S10: no new drift or blocking gap. Both fan-out mint
sites, recipient projection, existing-thread reuse, admission gates, UI entry
points, and the perf/copy/e2e pins match the accepted rebaseline. All source
paths in scope remain unchanged from 54e7b0d0 before implementation.

No new dependency, schema, infrastructure, or emulation spike is required by the
live-tree findings. The prescribed research phase is complete. S1 may begin.
