---
id: optional-call-outcome-breaks-already-loaded-bundles
title: Making call_outcome optional throws in an ALREADY-LOADED old dashboard bundle until the user refreshes
type: bug
severity: med
status: open
area: dashboard
created: 2026-08-19
refs: app/src/routes/contactTimeline.ts, dashboard/src/api/types.ts, dashboard/src/routes/contact/Timeline.tsx
---

**Problem.** `feat/comms-panel-call-direction` makes `call_outcome` OPTIONAL on
the `TimelineCall` wire contract and removes the server's `?? 'missed'` default,
so a call row with no terminal outcome - a `ringing` row, or a gate-refusal stamp
- now arrives with the field ABSENT.

The dashboard bundle that shipped BEFORE this change treats the field as
required and reads it unconditionally (`call.call_outcome.charAt(0)` in the old
CallCard). A browser tab that loaded the old bundle and is still open when the
new server deploys will therefore throw a TypeError the moment it renders such a
row, and will keep throwing until the user reloads the page.

Deploy-order note, since it constrains nothing on the way in but does explain the
window: the server and the dashboard ship together, so the exposure is not a
staged-rollout gap - it is purely the already-loaded-tab window, which lasts as
long as a staff member leaves the dashboard open across a deploy. Staff keep this
app open all day, so the window is real rather than theoretical.

This is NOT fixable in the branch that introduced it: the vulnerable code is the
bundle that is already shipped and already in people's browsers. It is recorded
here so the condition is understood rather than rediscovered as a mystery
TypeError in the logs on deploy day.

**Suggested fix.** Nothing on the server side is worth doing - reinstating the
default would restore the dishonest "Missed" label the whole change exists to
remove. The options are operational or structural:

- Deploy at a quiet hour and accept the window (cheapest; the blast radius is a
  stale tab, and a reload fixes it).
- Give the dashboard a build-stamp check that prompts an open tab to reload when
  the server reports a newer bundle. That is the general fix for this whole class
  of problem, not just this field, and would pay for itself the next time a wire
  contract narrows.

Either way, the durable lesson is that REMOVING a required wire field is a
breaking change for already-loaded clients even when server and client deploy
together.
