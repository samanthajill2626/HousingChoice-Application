---
id: optional-call-outcome-breaks-already-loaded-bundles
title: Making call_outcome optional throws in an ALREADY-LOADED old dashboard bundle until the user refreshes
type: bug
severity: med
status: open
area: dashboard
created: 2026-08-19
updated: 2026-09-26
refs: app/src/routes/contactTimeline.ts, dashboard/src/api/types.ts, dashboard/src/routes/contact/Timeline.tsx, docs/superpowers/specs/2026-09-24-retry-send-window-design.md
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

**UPDATE 2026-09-26 (`feat/retry-send-window`).** The same already-loaded-tab
window applies to `feat/retry-send-window`. It changes what the server writes
and refuses, and a tab loaded before its deploy keeps the old bundle, which
reads the new data wrongly in three ways. Each was checked against the
pre-branch code, base `da04d0cb`:

- **A window-declined relay leg shows an app-internal code.** The new server
  closes a relay retry rung with `retry_window_closed` when the send window
  declines it (the claim in `app/src/routes/webhooks/twilio.ts`, and the relay
  retry job in `app/src/jobs/relayRetryLeg.ts`). The base join copies the last
  rung's code onto the leg with no exception for that code (base
  `dashboard/src/routes/contact/relayRetryJoin.ts:410`, `:413`), base
  `INTERNAL_CODE_REASONS` has no entry for it (base
  `dashboard/src/routes/contact/deliveryStatus.ts:913-935`), and
  `deliveryReason` falls to its raw-code template (base
  `deliveryStatus.ts:1007`). The leg reads "Delivery failed (error
  retry_window_closed)" where the new bundle reads "Phone unreachable (error
  30003)". The re-review's probe rendered exactly that string from the base
  files (N1 in
  `docs/superpowers/reviews/2026-09-24-retry-send-window/build-rereview.md`).
- **Every 30003 outside a relay leg still promises a retry.** The base 30003
  copy says "will retry" (base `deliveryStatus.ts:778`), and the bubble uses it
  with no condition (base `dashboard/src/routes/contact/Timeline.tsx:980`),
  including on the failures the new server declines to retry.
- **Retry still shows during a live promise, and a press reads as a generic
  failure.** The base bubble renders Retry with no promise condition (base
  `Timeline.tsx:1341`). A press while a retry is scheduled gets the new
  server's 409 `retry_pending`; the base `sendFailureMessage` has no case for
  it (base `Timeline.tsx:86-131`, reached from the press at `:2400-2405`), so
  the tab shows the generic send-failure copy (base `Timeline.tsx:130`) and
  invites another press. Nothing is sent twice: the server refuses every press
  while the promise lasts. (Adversarial review F10, `build-review-adversarial.md`
  in the same folder.)

A reload fixes all three, and nothing forces one: `dashboard/src` has no
build-stamp check and no `location.reload`, and the service worker
(`dashboard/public/sw.js`) handles push only and caches nothing, so an open tab
keeps the old bundle until someone reloads it by hand. The build-stamp check
suggested above would close this class for good. Until then, the branch's
review adjudication (`build-rereview-adjudications.md`, row N1, same folder)
puts "reload every open dashboard tab after the deploy" in the branch's deploy
note.
