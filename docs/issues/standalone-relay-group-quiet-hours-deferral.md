---
id: standalone-relay-group-quiet-hours-deferral
title: Standalone relay-group creates cannot defer to quiet-hours end
type: improvement
severity: med
status: open
area: app/relay
created: 2026-08-17
refs: app/src/routes/relayGroups.ts, dashboard/src/routes/shared/RosterConfirmDialog.tsx
---

**Problem.** A standalone relay group created from the contact file during
quiet hours sends its intro immediately. Tours and placements defer by writing
a `pendingRosterActionsRepo` row keyed `${ownerType}#${ownerId}#open` with an
owner type of `tour | placement`; a standalone create has no owner id, so there
is no row to write. Deeper: a pending `open_group` row stores NO roster and
re-resolves from the owner when it fires, so a standalone deferral needs a new
row shape carrying its own member list. The confirm dialog handles this
honestly today via `allowDefer={false}` (the deferral button is not shown, the
quiet-hours warning still renders), but full parity is missing.

**Suggested fix.** A third pending-action owner type for standalone groups, a
pending row shape that carries its own member list, and a poller path that
provisions from stored members. Referenced from the `allowDefer` prop comment
in `RosterConfirmDialog.tsx` (`TODO(standalone-relay-group-quiet-hours-deferral):`).
