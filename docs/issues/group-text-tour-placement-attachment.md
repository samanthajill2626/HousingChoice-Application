---
id: group-text-tour-placement-attachment
title: Attach native group_text threads to tours/placements the way relay groups attach
type: improvement
severity: medium
status: open
area: dashboard/comms
created: 2026-08-10
refs: docs/superpowers/specs/2026-08-10-group-texting-design.md, app/src/repos/conversationsRepo.ts
---

**Problem.** Relay groups attach to tours/placements via the generalized
owner reference (owner_ref, M1.10/Task 5), which powers the comms panes and
placement channel surfaces. Native `group_text` threads (group-texting
feature, 2026-08) ship v1 as inbox + thread view only - they cannot be
attached to a tour or placement, so a group text coordinating a specific
placement is not visible from that placement's hub.

Cameron raised this at the group-texting spec gate (2026-08-10); it was
scoped out of v1 for the cutover timeline, not on the merits.

**Sketch.** Extend the owner_ref pattern to group_text threads: an attach
seam (from the tour/placement UI and/or the thread header), comms-pane
rendering for group threads, and the enumerated-reader sweep for every
owner_ref consumer. The group-texting spec's participants-matching-reader
rule applies: surfaces must handle group rosters explicitly, never fall
through as 1:1.
