---
id: sw-notificationclick-message-has-no-listener
title: The service worker's notificationclick postMessage has no listener, so every notification tap is a full page navigation
type: debt
severity: low
status: open
area: dashboard/sw
created: 2026-08-17
refs: dashboard/public/sw.js:247, dashboard/src/sw/display.ts:102
---

PRE-EXISTING - not introduced by the inbound-message-push feature, and no code
was changed for this filing. Filed here because the feature changes how often it
happens.

**Problem.** `dashboard/public/sw.js:247`, inside `focusOrOpen`, posts a message
to the focused client:

    client.postMessage({ type: 'notificationclick', action: action || null, data });

Its own comment says this is so the page "can act without a reload". Nothing
listens. Grepping `dashboard/src` for `notificationclick` finds exactly one hit -
a comment in `dashboard/src/sw/display.ts:102` about the data allowlist - and no
`navigator.serviceWorker.addEventListener('message', ...)` handler anywhere. So
the postMessage half of the contract is dead and the `client.navigate(absolute)`
two lines below always runs: a full document navigation of whatever the staffer
had open, discarding in-page state such as unsaved composer text.

Frequency is what changed. Before this feature the only pushes were voice
(`pre_ring` / `missed_call` / `voicemail`) - a handful of taps a day. Now every
inbound message and every unmatched email produces a tappable notification, so a
routine tap on a message alert reloads the app.

**Suggested fix.** Pick one and make the contract honest:

- Handle the message client-side - a `navigator.serviceWorker` message listener
  that routes in-app (React Router navigate) for a soft transition, and skip
  `client.navigate` when the client acknowledged it; or
- Delete the dead `postMessage` and its comment, leaving `client.navigate` as
  the single documented behavior.

Either way the change touches the tested-mirror pair (`dashboard/src/sw/*` and
the `dashboard/public/sw.js` verbatim copy), so both must move together.
