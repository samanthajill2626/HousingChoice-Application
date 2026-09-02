# Parser amendment review adjudication

Date: 2026-09-02
Scope: focused review of the `linkifyjs@4.3.3` design and plan correction.

## Review results

- Reviewer A: PASS. The revised dependency, result filtering, protocol-relative
  adjustment, dependency proof, and retained acceptance requirements were complete.
- Reviewer B: two high-severity findings. Both were confirmed from the proposed code
  path and corrected before implementation.

## Finding 1: false protocol-relative widening after an unsupported scheme

`linkifyjs` may return a bare URL result after `scheme://`. Widening that result
unconditionally would make `javascript://example.com/a` display a `//example.com/a`
HTTPS anchor. The corrected contract checks the adjacent literal `://` first and
keeps that parser result as text. It only widens adjacent `//` when that preceding
scheme delimiter is absent. Tests now cover `javascript`, `data`, `vbscript`, and an
arbitrary scheme with `//` payloads.

## Finding 2: false explicit-scheme detection inside a fuzzy URL

An earlier sketch tested whether source contained `://` anywhere. A fuzzy URL can
legitimately carry an embedded URL in its path, query, or fragment. The corrected
normalizer uses `match.href` for every non-protocol-relative parser result, so the
selected parser owns explicit-vs-fuzzy normalization and the configured HTTPS
default. Tests now cover embedded `https://` in fuzzy URL content.

## Residual decision

These corrections are range and destination-safety guards around parser-owned results,
not a competing URL grammar. The original user-visible acceptance behavior remains
unchanged. A fresh re-review of this fix diff is required before S1 resumes.
