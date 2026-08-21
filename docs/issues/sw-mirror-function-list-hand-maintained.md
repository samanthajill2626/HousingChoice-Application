---
id: sw-mirror-function-list-hand-maintained
title: The sw.js mirror comparison only covers a hand-maintained list, so a seventh mirrored function is unguarded
type: debt
severity: low
status: open
area: dashboard/sw
created: 2026-08-21
refs: dashboard/src/sw/mirror.test.ts, dashboard/public/sw.js
---

**Problem.** `mirror.test.ts` now compares `public/sw.js` against the ES modules
BEHAVIOURALLY, which closed
[`sw-mirror-test-pins-literals-not-behaviour`](./sw-mirror-test-pins-literals-not-behaviour.md).
But it compares the six functions named in a `MIRRORED` array literal:

```ts
const MIRRORED = [
  'isPlausibleId', 'resolveSafePath', 'assertSameOriginPath',
  'notificationTag', 'buildNotificationOptions', 'staleTagsFor',
] as const;
```

If someone mirrors a SEVENTH function into `sw.js` and does not add it to that
list, it is unguarded - and the test stays green. That is a weaker version of
the exact failure mode the rewrite removed: coverage limited to what somebody
remembered to enumerate.

Filed separately rather than left as a note inside the resolved issue, because a
residual recorded in a CLOSED issue does not appear in open triage.

**Why it was not just fixed.** The obvious remedy - compare EVERY function
present in both files - does not work as stated: `sw.js` legitimately carries
worker-only code with no module counterpart (`closeStaleNotifications`,
`focusOrOpen`, the `push` / `notificationclick` listeners), so a naive
every-function comparison would fail permanently on code that is correct.

**Suggested fix.** Invert the direction: enumerate the EXPORTS of
`src/sw/route.ts` and `src/sw/display.ts` at runtime (they are ES modules, so
`Object.keys(import * as m)` gives them for free) and require that every
exported function has a counterpart in `sw.js`. That makes the module the source
of truth for what must be mirrored, which it already claims to be, and removes
the hand-maintained list entirely. Worker-only functions in `sw.js` are then
correctly ignored, because the check runs module -> mirror rather than the
reverse.

Low severity because the current list does cover everything mirrored today; this
is about the NEXT addition, and it is cheap to do whenever that file is next
opened.
