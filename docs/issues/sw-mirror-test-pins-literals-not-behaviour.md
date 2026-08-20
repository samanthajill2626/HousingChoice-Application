---
id: sw-mirror-test-pins-literals-not-behaviour
title: The sw.js mirror test pins string literals, so it cannot catch the next drift
type: debt
severity: med
status: open
area: dashboard
created: 2026-08-20
refs: dashboard/src/sw/mirror.test.ts, dashboard/public/sw.js, dashboard/src/sw/route.ts, dashboard/src/sw/display.ts
---

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
