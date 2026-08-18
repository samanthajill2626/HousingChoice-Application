---
id: modal-busy-close-affordance
title: Modal close affordance looks active while dismissal is guarded
type: improvement
severity: low
status: open
area: dashboard
created: 2026-08-18
refs: dashboard/src/routes/contact/Modal.tsx, dashboard/src/routes/shared/RosterConfirmDialog.tsx
---

**Problem.** Some flows intentionally ignore dismissal while an irreversible
operation is busy. Their Cancel action is visibly disabled, but the shared modal's
header close button still looks active while the header button, backdrop, and Escape
all lead to the same guarded no-op. The flow is safe, but the close affordance invites
an action and gives the operator no explanation when nothing happens.

**Suggested fix.** Give `Modal` an explicit dismissal-disabled or busy presentation
that makes the header close state legible and accessible, or show concise status copy
that explains why dismissal is temporarily unavailable. Keep the behavior consistent
across the header button, backdrop, Escape, and footer actions.

Split from the resolved focus-lifecycle issue
[modal-onclose-refocus-trap](./modal-onclose-refocus-trap.md).
