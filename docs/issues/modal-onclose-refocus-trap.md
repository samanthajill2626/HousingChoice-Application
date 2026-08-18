---
id: modal-onclose-refocus-trap
title: Modal onClose changes steal input focus during re-renders
type: bug
severity: med
status: resolved
area: dashboard
created: 2026-08-17
updated: 2026-08-18
resolved: 2026-08-18
refs: dashboard/src/routes/contact/Modal.tsx, dashboard/src/routes/contact/Modal.test.tsx, dashboard/src/routes/contact/CreateRelayGroupModal.test.tsx, e2e/tests/flows/email-triage.spec.ts
---

**Problem.** `Modal` previously used one effect keyed on `[onClose]` to move focus
into the dialog, register its document-level Escape handler, and restore focus on
cleanup. A parent render that supplied a new callback identity therefore looked
like dialog teardown and remount: focus left the field the operator was typing in,
landed on the dialog container, and later keystrokes were dropped.

The failure was reproduced both through an ordinary controlled input render in the
Email "Link to contact" dialog and through a page-behind update while the relay
group member search held focus. In the Email flow, character-by-character input
stopped at `T` while `document.activeElement` became the dialog.

**Resolution (2026-08-18).** `Modal` now separates current callback state from
mount lifecycle state. Its document listener reads the latest `onClose` from a ref,
while dialog focus, listener registration, and trigger restoration run only for the
mount lifecycle. Initial dialog focus is a fallback: if a child has already focused
one of its fields during mount, that focus is preserved. The original trigger is
captured before child effects can claim focus, so it is still restored on unmount.

The Escape listener also respects a descendant that has already called
`preventDefault()`, allowing an open typeahead to consume the first Escape without
closing its dialog. Caller-side callback memoization used only as a focus workaround
was removed. Unit coverage pins mount-time child focus, fresh callbacks, current
Escape callbacks, descendant Escape handling, and trigger restoration. The focused
Email Playwright regression types sequentially and asserts both retained focus and
the complete value.

Two separate concerns remain intentionally open: the busy-state close affordance in
[modal-busy-close-affordance](./modal-busy-close-affordance.md) and missing Tab-key
containment in
[modal-tab-focus-containment](./modal-tab-focus-containment.md).
