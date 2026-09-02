# Implementation review adjudication

Date: 2026-09-02
Scope: Phase 4 implementation conformance and independent plan-blind adversarial
reviews at commit `070655f8`, recorded in `1869e78e`.

## Confirmed must-fixes

1. E1 leaves its fixture-inserted message in the single-worker hermetic lane.
   This is confirmed from `comms-clickable-links.spec.ts:35-41` and the existing
   post-mutation reseed pattern cited by the adversarial review. The fix wave
   must add unconditional local-lane reseed cleanup and prove the focused E1
   spec plus a representative later dashboard spec.
2. Parser-classified malformed scheme sources such as `http:example.com/a` are
   accepted by `safeHttpUrl` after WHATWG normalization, which changes the
   navigated destination. This is confirmed by the installed-package probe in
   the adversarial record. The fix wave must admit parser scheme matches only
   when their original source has an explicit HTTP(S) authority, preserve all
   other source text, and add regressions for `http:example.com/a`,
   `https:example.com/a`, and `http:///example.com/a`.
3. The added Timeline comment contains a non-ASCII em dash. Replace it with
   ASCII punctuation and re-run the added-line ASCII check.
4. The dependency proof incorrectly calls `tslib@2.8.1` MIT. The installed
   manifest reports `0BSD`; correct the evidence while retaining Autolinker's
   MIT license and the existing pure-JS/no-hook conclusions.

## No scope expansion

All four findings are in-scope correctness, test isolation, or required record
accuracy. No production API, infrastructure, fixture endpoint, dependency
version, or rollout action is authorized by this fix wave.

## Required proof after the fix

- LinkifiedText focused tests, including the three malformed-scheme cases.
- The exact E1 browser spec and one later dashboard-next spec after its cleanup.
- Dashboard typecheck and production build.
- Added-line ASCII scan and focused diff review.
