---
id: modal-onclose-refocus-trap
title: Modal keys its Escape/focus effect on onClose, so any parent re-render steals focus into the dialog and drops keystrokes
type: bug
severity: med
status: open
area: dashboard
created: 2026-08-17
refs: dashboard/src/routes/contact/Modal.tsx:21-36, dashboard/src/routes/contact/CreateRelayGroupModal.tsx:252-255, dashboard/src/routes/contact/ContactEditForm.tsx, dashboard/src/routes/contact/PhoneManager.tsx
---

**Problem.** `Modal`'s one effect does three things - move focus into the dialog,
register the document-level Escape handler, and (on cleanup) return focus to the
previously focused element - and it is keyed on `[onClose]`
(`Modal.tsx:21-36`). So every time a parent passes a NEW callback identity the
effect tears down and re-runs: focus leaves whatever the operator was typing in,
lands on the dialog container, and every subsequent keystroke goes nowhere until
they click back into the field.

Nothing about a re-render should move focus, so the trap fires on ordinary page
activity. Reproduced in the contact-create-relay-group re-review against
`CreateRelayGroupModal`, whose parent (`ContactDetail`) re-renders on
`message.persisted`, `conversation.updated` and `scheduled.updated` SSE events -
and the operator is on that page precisely because the contact is texting them:

```
PROBE control value >>> Marcus      (no parent re-render: typing accumulates)
PROBE before bump, activeElement >>> Add member
PROBE after bump, activeElement >>> dialog
PROBE after bump, value >>> Mar     (three keystrokes dropped)
```

That branch fixed its own instance from the caller's side (ContactDetail
memoizes the handler it passes, and the modal memoizes the busy-guard it builds
from it), which makes the symptom unreachable for that ONE modal. It is a
discipline every future caller has to know about rather than a fix: the same
wiring is shared by `ContactEditForm` and `PhoneManager`, which also hold text
inputs, and by `RosterConfirmDialog`, which now passes an inline busy-guard by
design.

**Suggested fix.** Fix it in `Modal`, where it belongs: keep `onClose` in a ref
updated each render, and key the effect `[]`. The Escape handler reads the ref,
so it always calls the current callback while the focus/cleanup pair runs exactly
once per mount. That retires the whole class and lets the callers stop memoizing
defensively.

**Same component, while you are in there (re-review R8).** The header X still
LOOKS live while a flow is busy: after the busy guards landed, Cancel greys out
but Escape / the backdrop / the X silently no-op, so the X invites a click that
does nothing and says nothing (`PROBE X-Close disabled while busy >>> false`).
An optional `busy` prop that disables the X - or a short note in the header -
would make the freeze legible instead of merely safe. Legibility, not
correctness: nothing is lost by the no-op.
