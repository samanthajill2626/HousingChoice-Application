---
id: kebab-menus-keyboard-navigation
title: Kebab/action menus lack APG menu-button keyboard support (arrows, focus management)
type: debt
severity: low
status: open
area: dashboard
created: 2026-07-08
refs: dashboard/src/routes/listing/ListingActionsMenu.tsx, dashboard/src/routes/contact/ContactActionsMenu.tsx, dashboard/src/routes/contact/CallMenu.tsx
---

**Problem.** The header kebab menus (ListingActionsMenu, ContactActionsMenu,
CallMenu) expose role="menu"/"menuitem" semantics but implement none of the
WAI-ARIA APG menu-button keyboard pattern: no ArrowUp/ArrowDown navigation, focus
does not move into the menu on open, and focus drops to <body> on close/selection
(the focused item unmounts). Screen-reader and keyboard users can still reach the
items with Tab, but the announced role promises arrow-key behavior that is not
there. ui/StatusMenu implemented the full pattern (arrow/Home/End roving focus,
focus-into-menu on open, focus-return to the trigger on Escape/outside-close/
selection, items tabIndex=-1) - these menus predate it and were left as-is
deliberately during the status-pill fix pass to avoid refactoring shared
convention mid-mission.

**Suggested fix.** Extract StatusMenu's keyboard/focus wiring into a small shared
hook (e.g. useMenuButton) and adopt it in the three kebab menus; or convert them
to render through a shared Menu primitive. Behavior parity checklist: ArrowDown/
ArrowUp wrap, Home/End, Escape returns focus to the trigger, Tab closes and
resumes the page tab order from the trigger, selection returns focus to the
trigger, items tabIndex=-1.
