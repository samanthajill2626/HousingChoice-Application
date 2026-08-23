---
id: sw-mirror-function-list-hand-maintained
title: The sw.js mirror comparison only covers a hand-maintained list, so a seventh mirrored function is unguarded
type: debt
severity: low
status: resolved
area: dashboard/sw
created: 2026-08-21
resolved: 2026-08-23
refs: dashboard/src/sw/mirror.test.ts, dashboard/public/sw.js
---

**Resolution (2026-08-23, `fix/test-hardening-wave2`).** Took the suggested fix
below verbatim. `MIRRORED` is now derived at runtime from the module exports:

```ts
const MODULE_EXPORTS: Record<string, unknown> = { ...route, ...display };
const MIRRORED = Object.keys(MODULE_EXPORTS)
  .filter((name) => typeof MODULE_EXPORTS[name] === 'function')
  .sort();
```

`extractFunction` already threw on a name it could not find, so an export with
no counterpart in `sw.js` now fails the file at collection, naming it. Interfaces
drop out for free - they do not exist at runtime.

Two things the change needed that the issue did not mention:

- A COLLISION CHECK. `{ ...route, ...display }` would silently drop one of two
  same-named exports and compare the survivor twice under one name.
- A VACUITY FLOOR. If the enumeration ever yields nothing - a renamed module, a
  changed import, an empty namespace object - every comparison would cover zero
  functions and the suite would stay green. `MIRRORED_FLOOR` asserts the six
  known names are present. It is a floor, NOT the coverage list: a seventh
  function does not belong in it. Same reasoning as the import-count floor in
  `scripts/smoke-dist.mjs`.

Deriving the list also cost a compile-time check, since `agreeOn`'s `name`
parameter was a union of the six literals and is now `string`. `agreeOn` throws
on a name that is not mirrored, so a typo fails loudly instead of calling
`undefined`.

Probed rather than assumed. Adding a seventh exported function to `route.ts`
with no mirror fails with `function unmirroredSeventh not found in public/sw.js`
- the previously unguarded case. Emptying the enumeration fails all 7 tests, the
floor and every comparison. Restored, 11/11 green.

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
