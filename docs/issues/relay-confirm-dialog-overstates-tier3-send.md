---
id: relay-confirm-dialog-overstates-tier3-send
title: RosterConfirmDialog says N recipients will receive this even when a tier-3 create sends nothing
type: bug
severity: med
status: open
area: dashboard/relay
created: 2026-08-17
refs: dashboard/src/routes/shared/RosterConfirmDialog.tsx, app/src/services/relayProvisioning.ts
---

**Problem.** `RosterConfirmDialog` says "N recipients will receive this." on
all three relay-open surfaces (tour, placement, standalone), but a tier-3
`connecting` create sends nothing until a warmed number registers: the group is
created with no pool number and the intro is deferred to the
`relay.numberReady` handler. The operator reads a promise of an immediate send
at the only moment they can cancel; the correction (the standalone flow's
unsent-intro panel) arrives only AFTER the irreversible create. Pre-existing
defect on the two shipped surfaces, surfaced by the contact-create-relay-group
review, and an explicitly accepted trade for the standalone surface (editing a
dialog three shipped surfaces depend on was out of scope).

**Suggested fix.** Teach the dialog (or its callers) a connecting-aware count
line, e.g. "N recipients will receive this once the group's number is ready"
when the open may land connecting. Needs wording that stays true on tiers 1-2.
