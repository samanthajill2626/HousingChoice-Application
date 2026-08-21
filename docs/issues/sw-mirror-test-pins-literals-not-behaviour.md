---
id: sw-mirror-test-pins-literals-not-behaviour
title: The sw.js mirror test pins string literals, so it cannot catch the next drift
type: debt
severity: med
status: resolved
area: dashboard
created: 2026-08-20
resolved: 2026-08-21
refs: dashboard/src/sw/mirror.test.ts, dashboard/public/sw.js, dashboard/src/sw/route.ts, dashboard/src/sw/display.ts
---

**Resolution (2026-08-21, `fix/test-suite-hardening`).** `mirror.test.ts` now
compares the two copies BEHAVIOURALLY: it lifts the six mirrored functions out
of the classic worker, and runs them against the ES modules over a shared input
table. 10 cases.

**Behaviour rather than the normalised-source comparison this issue suggested**,
for three reasons that only became visible while building it:

1. The issue's own warning - a hand-rolled TS stripper that is itself buggy
   makes the test worse than the pins - simply does not apply if you never
   strip types. Running both copies needs no normalisation at all.
2. Reflowing or re-commenting a correct mirror cannot fail a behaviour test.
   That was the pins' *other* failure mode and the suggested fix would have
   inherited a weaker version of it.
3. **Source comparison could not have worked here anyway.** The module builds
   its class from `UNSAFE_ID_CHARS = new RegExp('[/\\\\:\\s\\u0000-\\u001f\\u007f]')`
   while the mirror inlines `/[/\\:\s\x00-\x1f\x7f]/`. Different source,
   identical behaviour - exactly the distinction that matters, and one a source
   diff would have reported as a permanent false failure.

An esbuild-based variant was tried first and abandoned: esbuild breaks under the
dashboard's jsdom environment, and switching that file to the node environment
breaks the workspace's DOM setup. Behaviour comparison sidesteps the whole
problem.

**Proven with three mutation probes rather than trusted on a green tick:**

| probe against `public/sw.js` | result |
|---|---|
| re-introduce the historical DEL divergence (drop `\x7f`) | **2 failed** |
| change the `unmatched_email` route to `/email/quarantine` - a FUTURE drift no pin existed for | **1 failed** |
| change `notificationTag`'s `unmatched_email` tag (display half) | **2 failed** |
| restore (verified byte-identical) | 10 passed |

Probe 2 is the one the old file structurally could not catch, and it is the
failure mode this issue was filed on.

Kept a few behavioural pins alongside, per this issue's own advice: two
identically BROKEN copies compare equal, so the highest-value invariants (the
quick-reply target never naming a recipient, action buttons not being ignored,
off-origin paths never escaping the allow-list) are still asserted directly.

**Residual, deliberately not solved:** the `MIRRORED` list is hand-maintained.
A seventh mirrored function added to `sw.js` and not to that list is still
unguarded. Comparing every function in both files was considered and rejected -
`sw.js` legitimately carries worker-only code (`closeStaleNotifications`,
`focusOrOpen`, the event listeners) that has no module counterpart.

**Problem.** `public/sw.js` is a classic service worker and cannot import the ES
modules it duplicates, so it carries hand-maintained copies of
`src/sw/route.ts` and `src/sw/display.ts`. The modules are what the test suite
exercises; the mirror is what actually runs on the phone. A forgotten mirror
edit therefore ships tested-but-dead logic, silently.

`mirror.test.ts` exists to prevent that, but every assertion in it is
`expect(swSource).toContain('<some exact source fragment>')`. It never compares
the two files. Two consequences:

  - It only catches the specific copies someone thought to pin. Any FUTURE
    change to `route.ts` - tightening `UNSAFE_ID_CHARS`, narrowing an allow-list
    regex, adding a branch - passes green with the mirror untouched. That is the
    identical failure mode the file was written to prevent.
  - The pins are formatting-brittle in the other direction: reflowing a
    correctly-mirrored line fails the test.

This is not hypothetical. A one-character divergence sat in `isPlausibleId` from
`26a01b9f` until 2026-08-20 - the module rejected `\x7f` (DEL) and the mirror did
not - through the entire life of this test file. It was found by reading, not by
the suite. (Fixed on `fix/quick-reply-surface`, along with a pin for that exact
character, which is again a pin and not a comparison.)

**Suggested fix.** Extract the mirrored function bodies from both files and
compare them after normalizing the KNOWN, deliberate differences, which are
small and enumerable:

  - `export ` prefixes (module only)
  - TypeScript type annotations and `is`-predicate return types
  - `data ?? {}` (module) vs `data || {}` (mirror)
  - comments and whitespace

A failure should name the diverging function. Worth checking whether stripping
types with the esbuild/tsx already in the toolchain is cheaper and more robust
than a regex normalizer - a hand-rolled TS stripper that is itself buggy would
make this test worse than the pins.

Keep a small number of behavioural pins for the highest-value invariants (the
allow-list, the missed-call branch) so a green comparison of two identically
BROKEN files is still caught.
