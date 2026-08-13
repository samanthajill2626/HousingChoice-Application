---
id: load-older-control-loses-focus-and-announces-nothing
title: The Load older messages control drops keyboard focus and announces nothing
type: bug
severity: med
status: open
area: dashboard
created: 2026-08-13
refs: dashboard/src/routes/contact/Timeline.tsx:1316, dashboard/src/routes/contact/Timeline.tsx:1322, dashboard/src/routes/contact/Timeline.tsx:1328
---

**Problem.** The "Load older messages" control is keyboard-hostile in exactly the
moment the feature exists to serve - keeping the operator's place while older
history arrives.

- It is `disabled` while a page is in flight (`Timeline.tsx:1328`). Chromium
  blurs a focused element when it becomes disabled, so focus falls to `<body>`
  on every click.
- It is UNMOUNTED entirely when `hasOlder` flips false (`Timeline.tsx:1322`), so
  on the last click of a thread focus is lost with nothing to return to.
- There is no `aria-live` region and no `aria-busy`, so a screen reader gets no
  signal that the request started, that it finished, or that up to 50 older
  messages were inserted ABOVE the current reading position. The visual design
  deliberately does not move the transcript, which means a non-visual user has no
  cue at all that anything happened.

**Failure story.** A navigator who works by keyboard tabs to "Load older
messages" and presses Enter. The button disables, focus drops to the document
body, and the next Tab starts from the top of the page instead of from the
control. They tab back, press Enter again, and this time the thread reaches its
beginning: the control unmounts mid-press and focus is lost again, now
permanently. A screen-reader user gets the same two focus losses plus silence -
their only way to discover the 50 new messages is to re-read the transcript from
the top.

Verdict on evidence: reasoned from the JSX and Chromium's blur-on-disable
behavior, not driven in a real browser - jsdom does not model blur-on-disable, so
the existing Timeline suite cannot see it either way. Worth confirming in an
interactive session before choosing between the fixes below.

**Suggested fix.** Keep the button mounted and use `aria-disabled` plus a no-op
handler instead of `disabled` while loading, so focus survives the round trip.
At end-of-history, either keep it mounted in a disabled-looking end state
("No older messages") or move focus deliberately to the first newly prepended
entry. Add a polite live region announcing "Loading older messages" and
"Loaded N older messages", and `aria-busy` on the stream while a page is in
flight.
