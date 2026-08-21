---
id: sw-mirror-control-char-divergence
title: public/sw.js isPlausibleId omits the DEL character src/sw/route.ts rejects - the tested module and the shipped worker disagree
type: bug
severity: low
status: resolved
area: dashboard/sw
created: 2026-08-16
resolved: 2026-08-21
refs: dashboard/public/sw.js:193, dashboard/src/sw/route.ts:46, dashboard/src/sw/mirror.test.ts
---

**Resolution (2026-08-21).** Two halves, and the second is the one that matters.

The divergence itself was repaired on `fix/quick-reply-surface`:
`dashboard/public/sw.js:193` now reads `!/[/\\:\s\x00-\x1f\x7f]/.test(id)`,
with `\x7f` present and a comment recording why.

But that fix came with another literal PIN, which is the same mechanism that let
this survive from `26a01b9f` to 2026-08-16 in the first place. So
`mirror.test.ts` was rewritten to compare the two copies BEHAVIOURALLY - it
lifts the mirror's functions out of the classic worker and runs them against the
modules over a shared input table, with DEL present as an explicit
`\u007F` escape (the test carries no raw control bytes, matching the
convention route.ts sets for itself).

Proven by re-introducing this exact bug: dropping `\x7f` from the mirror's class
now fails 2 of the 10 cases. Under the old pins it passed.

See [`sw-mirror-test-pins-literals-not-behaviour`](./sw-mirror-test-pins-literals-not-behaviour.md)
for the mechanism and the other two probes.

**Problem.** `dashboard/public/sw.js` is a hand-maintained VERBATIM MIRROR of
the tested ES modules `dashboard/src/sw/route.ts` and
`dashboard/src/sw/display.ts` - a classic service worker cannot import them, so
the pure functions are duplicated. The two have drifted on one input class:

- `dashboard/src/sw/route.ts:44` builds its unsafe-character class as
  `new RegExp('[/\\\\:\\s\\u0000-\\u001f\\u007f]')` - control chars U+0000
  through U+001F **and U+007F (DEL)**.
- `dashboard/public/sw.js:190` inlines `/[/\\:\s\x00-\x1f]/` - the same class
  **without** `\x7f`.

So `isPlausibleId` in the artifact that actually runs in the browser ACCEPTS a
conversation id containing a DEL byte, while the module the unit suite
(`route.test.ts`) exercises REJECTS it. The divergence is narrow - a DEL in a
path segment is percent-encoded by `encodeURIComponent` before it reaches the
URL, and `assertSameOriginPath` still gates the result - so this is not a live
security hole today. The real defect is that the tested module and the shipped
worker no longer agree, which is precisely the property the mirror is supposed
to guarantee.

Pre-existing: it predates the inbound-message-push feature and was found during
that feature's mirror work. Deliberately NOT fixed there - out of scope for a
push feature, and changing an id-validation predicate in the shipped worker
deserves its own change with its own verification.

Note that the new `dashboard/src/sw/mirror.test.ts` smoke test does NOT catch
it: that test pins only this feature's new fragments (the `unmatched_email`
kind, the `alerting` renotify expression, the `/email` route rung). It asserts
nothing about the `isPlausibleId` character class.

**Suggested fix.** Align the mirror - make `sw.js:190` reject `\x7f` as well
(`/[/\\:\s\x00-\x1f\x7f]/`) - and extend `mirror.test.ts` with a fragment
covering that line so the two can never drift apart again unnoticed. While
there, consider whether the smoke test should pin every mirrored predicate
rather than only the lines a given feature happened to touch.
