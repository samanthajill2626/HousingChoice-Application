---
id: modal-tab-focus-containment
title: Modal does not contain Tab focus while open
type: bug
severity: med
status: open
area: dashboard/accessibility
created: 2026-08-18
refs: dashboard/src/routes/contact/Modal.tsx
---

**Problem.** The shared dialog has `aria-modal="true"` and establishes initial
focus, but it does not contain Tab or Shift+Tab navigation. Keyboard focus can leave
an open dialog and reach the obscured page behind it, so the implementation does not
yet provide complete modal keyboard behavior.

**Suggested fix.** Add focus containment that follows the dialog's current enabled,
focusable descendants, wraps forward and backward navigation, and restores the
original trigger on close. Cover empty-content, dynamically enabled controls,
portaled typeahead results, and nested interactive children without breaking their
own key handling.

This was explicitly out of scope for the resolved focus-lifecycle issue
[modal-onclose-refocus-trap](./modal-onclose-refocus-trap.md).
