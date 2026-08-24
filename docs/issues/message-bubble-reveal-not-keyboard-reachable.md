---
id: message-bubble-reveal-not-keyboard-reachable
title: The message bubble's click-to-reveal is a bare div, so the per-recipient breakdown is keyboard-unreachable
type: bug
severity: med
status: open
area: dashboard/contact-timeline
created: 2026-08-24
refs: dashboard/src/routes/contact/Timeline.tsx:927 (MessageBubble's bubble div, onClick={toggleMeta}), dashboard/src/routes/contact/Timeline.tsx:999 (the recipient <ul>, showRecipients && revealed), dashboard/src/routes/contact/Timeline.tsx:936 (the via_closed_group Link), dashboard/src/routes/contact/Timeline.tsx:1047 (the Retry button), dashboard/src/routes/contact/Timeline.tsx:1221 (CallCard's Details button)
---

**Problem.** The message bubble's reveal is a `div` with an `onClick` and nothing
else - no `role`, no `tabIndex`, no `aria-expanded`
(the bubble `div` in `MessageBubble`,
`dashboard/src/routes/contact/Timeline.tsx:925-928`):

```
<div
  className={`${styles.bubble} ${outbound ? styles.out : styles.in} ${revealed ? styles.revealed ?? '' : ''}`}
  onClick={toggleMeta}
>
```

A keyboard-only or screen-reader user cannot focus it, cannot activate it, and is
never told it is a disclosure or what state it is in. **PRE-EXISTING** - this is
how the transport / number / time reveal has always worked.

**This feature makes the CONSEQUENCE worse, which is why it is filed now.** What
sat behind the inaccessible control before was a nicety: the transport, the
number, and a time that is already on the cluster label. After
`feat/per-recipient-delivery` (2026-08-24) what sits behind it is the PAYLOAD OF
THE FEATURE - the per-recipient row list, conditionally rendered on the same
`revealed` state (the recipient `<ul>`, `Timeline.tsx:999-1024`), which is the
only place the dashboard ever names WHICH recipient a send did not confirm. The
accessible summary this branch added mitigates but does not erase the damage:
the chip carries `role="img"` plus an `aria-label` naming the unconfirmed
recipients (the rollup chip, `Timeline.tsx:962-976`, and the branch-0
message-level chip at `:949-961`), so a screen-reader user hears the summary -
but they still cannot open the list to read the rows, their times, or their
per-leg reasons.

**The blocker - the honest fix is not "make it a button".** The bubble already
NESTS interactive children, and a `<button>` may not contain interactive content:

- a `Link` for a message intercepted from a now-closed relay group
  (the `via_closed_group` `Link`, `Timeline.tsx:936-944`), and
- the Retry button on a failed send (`Timeline.tsx:1047-1059`).

Both call `e.stopPropagation()` precisely because they sit inside the bubble's
click handler. So this is a real design decision, not a one-line attribute fix.

**Suggested fix.** Two shapes are worth weighing, and the right one should be
picked with the disclosure's interaction design, not by whichever is smaller:

1. **A dedicated reveal control**, following the precedent that already exists a
   few hundred lines down THE SAME FILE: `CallCard`'s `Details` control
   (`Timeline.tsx:1221-1232`) is a real `<button>` with
   `aria-expanded={revealed}` and a per-card accessible name. Note this collides with locked decision 1 of
   the per-recipient design ("no second click target inside the bubble"), so it
   needs that decision revisited rather than quietly overridden.
2. **Keep the whole bubble as the target** but give it `role="button"`,
   `tabIndex={0}`, `aria-expanded` and an `onKeyDown` for Enter/Space. This keeps
   the single target, but nesting a `Link` and a `Retry` button inside a
   `role="button"` is invalid ARIA and the nested controls' own keyboard handling
   would have to be reconciled with the outer one.

Either way the disclosure needs `aria-expanded` and an accessible name that says
what is behind it.

Related, same file and same surface:
[`load-older-control-loses-focus-and-announces-nothing`](./load-older-control-loses-focus-and-announces-nothing.md)
(the same class of defect on the Load-older control) and
[`timeline-load-older-remounts-and-collapses-reveals`](./timeline-load-older-remounts-and-collapses-reveals.md)
(the same `revealed` state, destroyed by a remount on every Load older click - so
a user who does reach the list loses it as soon as they load context).
