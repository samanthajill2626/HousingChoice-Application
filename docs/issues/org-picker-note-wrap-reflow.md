---
id: org-picker-note-wrap-reflow
title: An org picker reserves ONE line for its note - a note that wraps (a narrow dialog, a long name) still reflows the form on blur
type: bug
severity: low
status: open
area: dashboard/orgs
created: 2026-10-07
refs: dashboard/src/routes/orgs/OrgPicker.module.css:128-134, dashboard/src/routes/orgs/OrgPicker.tsx:422-426, dashboard/src/routes/orgs/orgCopy.ts:108, dashboard/src/routes/contact/Modal.module.css:23
---

**Problem.** While an org picker holds typed text, the line under it is reserved for the
note it shows on blur (code review R2-FE-8, fix B17), so a blur - which happens on
mousedown - only fills the line in and never moves the controls below before the mouseup.
The reservation is ONE line of note (the `.pendingNote` min-height,
`dashboard/src/routes/orgs/OrgPicker.module.css:128-134`, rendered at
`dashboard/src/routes/orgs/OrgPicker.tsx:422-426`). The forms' longest notes wrap: the
refusal "Not saved - pick a name from the list, add it as new, or clear the text."
(`dashboard/src/routes/orgs/orgCopy.ts:108`) is 72 characters of extra-small text, and
"Save will use <name>." grows with the name. A phone-width dialog has about 294 px for
content (a 360 px viewport less the backdrop's and the body's padding; the dialog is
capped at 30rem, `dashboard/src/routes/contact/Modal.module.css:23`), and a desktop
window under about 520 px narrows it too. There the blur still adds a line under the
field - R2-FE-8's reflow between mousedown and mouseup, on exactly the refused-text case.
Plausible from the layout (jsdom cannot show it); to be checked in the build's live
self-QA at 360 px. Code review R3-FE-7
(`docs/superpowers/reviews/2026-10-06-clean-org-names/code-review/R3-FE.md`), ruled to
file rather than fix (`R3-adjudications.md` there). Filed during the clean-org-names
build (`feat/clean-org-names`).

**Suggested fix.** Reserve by content: while the field is focused and holds text, render
the note's text with `visibility: hidden` (out of the accessibility tree;
`aria-describedby` still only when shown), so the box always has the note's own wrapped
height and a blur only reveals it.
