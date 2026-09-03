# Autolinker API re-review adjudication

Date: 2026-09-02
Scope: Resolve R1-R3 in `autolinker-amendment-rereview.md` without changing the
approved feature behavior or using a competing URL grammar.

## Confirmed findings and resolutions

### R1: `parseText` is private

Confirmed. The published 4.1.5 declarations mark `parseText` private, so it cannot
be used or type-queried in dashboard production code. The prior A2 resolution is
superseded.

Resolution: call supported static `Autolinker.parse` only on a parser-only copy in
which each `<` is U+FF1C and each `>` is U+FF1E. These replacements preserve one
JavaScript code unit per source character, so parser offsets and match lengths map
exactly to the original source. Autolinker consequently receives no raw tag or
comment delimiters to interpret, while React renders and safety-normalizes only the
unmodified original text. This is neither URL recognition nor HTML rendering.

An isolated 4.1.5 probe passed the masked literal
`<script>https://example.com/a</script>` source at offset 8, a bare-domain
port/path/query/fragment source, a `www` source, and an explicit source containing
literal `&amp;`; each candidate was derived from the original source range.

### R2: `www` is classified as `tld`

Confirmed. The 4.1.5 union is `scheme | tld | ipV4`; under the locked settings both
bare and `www` public domains report `tld`.

Resolution: normalize only `tld` source matches to `https://`. The Linux ARM64 and
unit proof explicitly cover both a bare-domain port/path/query/fragment URL and a
`www` URL. The disabled IPv4 match path is not a candidate for this normalization.

### R3: `getAnchorHref()` decodes literal `&amp;`

Confirmed. That HTML-oriented helper changes the destination of a literal plaintext
query string.

Resolution: do not call `getAnchorHref()`. For `scheme` matches, use the exact
original source range as the candidate; `safeHttpUrl` preserves explicit HTTP(S) and
rejects unsupported schemes. For protocol-relative and `tld` matches, construct the
approved HTTPS candidate from the same original range. The tests include an explicit
literal `&amp;` URL, including snippet-boundary behavior.

## Adjudication

All three findings are must-fix and are reflected in the specification, plan,
Autolinker decision record, and live-tree worklist. No production code, manifest,
lockfile, or runtime reader has changed. A fresh review must prove the public API,
same-length offset mapping, HTTPS normalization, and literal-source preservation
before S1 TDD restarts.
