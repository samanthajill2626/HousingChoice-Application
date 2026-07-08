---
id: stagemenu-statusmenu-consolidation
title: Fold the placements-page StageMenu into an extended ui/StatusMenu
type: debt
severity: low
status: open
area: dashboard
created: 2026-07-08
refs: dashboard/src/routes/placements/StageMenu.tsx, dashboard/src/ui/StatusMenu.tsx
---

**Problem.** Two grouped, gated stage/status menus now coexist: the placements
page's row kebab (StageMenu, built on feat/placements-page) and the shared
ui/StatusMenu pill (landed on main the same day for the property, placement
detail, and contact headers - the status-pill rollout). Mechanics overlap
(grouped items, current-item marking, outside-click + Escape close), but they
are not drop-in interchangeable:

- StatusMenu is a value-pill TRIGGER (displays the current value); StageMenu is
  a kebab icon (the ledger row already shows the stage, so a pill would
  duplicate it).
- StageMenu REQUIRES a portal + position:fixed to escape the ledger's
  overflow:hidden clipping and the row actions z-index stacking context;
  StatusMenu renders a plain absolutely-positioned child and only works in
  unclipped headers. Using StatusMenu in a ledger row as-is would reintroduce
  the clipping bug fixed during live QA.
- StageMenu disables the current stage and styles "Mark lost..." as a danger
  item; StatusMenu uses menuitemradio with the current checked, no per-item
  disable or danger styling.

Both surfaces drive the same requestMove -> gateFor -> transitionPlacement
pipeline, so there is no behavioral divergence - this is purely component
consolidation debt.

**Suggested fix.** Extend ui/StatusMenu with: an icon/kebab trigger variant, an
opt-in portal + fixed positioning mode (with the focus management StageMenu
already has: focus first enabled item on open, restore to trigger on
Escape/selection), per-item disabled, and a danger item slot. Then replace
StageMenu with the extended component. Cross-page blast radius (four surfaces),
so do it as its own reviewed change, not as a rider.
