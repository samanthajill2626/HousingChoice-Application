---
id: stream-anchor-block-vanish-pill-flash
title: Upcoming block emptying in the same commit as a tall appended message can show a pill instead of following
type: bug
severity: low
status: open
area: dashboard
created: 2026-09-02
refs: dashboard/src/routes/contact/Timeline.tsx, dashboard/src/routes/contact/streamAnchor.ts
---

**Problem.** The stream anchor re-derives on the Upcoming block's UNMOUNT flip
(deliberate - re-deriving on mount ate the first-mount pin, caught in live QA).
When the LAST scheduled item fires, the hub delivers the bucket-empty and the
new message in the same commit: the block unmounts, the re-derivation reads
POST-append geometry, and if the new bubble is taller than the 48px slack the
operator who was at bottom derives `null` instead of `sentinel` - a "New
messages" pill for a message that is already on screen, instead of follow.

Requires the empty-and-append to land in one commit AND a tall bubble;
otherwise unreachable. Found by the planner's plan-blind adversarial review of
`feat/tour-reminder-supersession` (finding 2).

**Suggested fix.** Capture the anchor BEFORE the commit that unmounts the block
(a layout-effect-ordered read, or deriving from pre-update geometry saved by
the ResizeObserver), so the unmount re-derivation classifies against the
geometry the operator was actually standing in. Any change here re-runs the
phone live-QA walk - this is the one region of the branch verified by hand, and
an untested fix trades a narrow wrinkle for an unverified anchor.
