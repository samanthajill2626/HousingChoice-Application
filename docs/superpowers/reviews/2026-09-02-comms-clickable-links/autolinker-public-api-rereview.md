# Autolinker public API re-review

Date: 2026-09-02
Scope: Fresh cold review of the documentation-only public-API correction at
`af34af31`, before S1 implementation or dependency installation.

## Verdict: PASS

No must-fix was found. The revised sketch uses supported Autolinker 4.1.5 APIs,
keeps parser offsets and matched lengths applicable to the original JavaScript
source string, and preserves the locked destination and reader-boundary
contracts. No production source, manifest, lockfile, or dependency installation
was changed during this review.

## Empirical published-package probe

I used the already-unpacked published `autolinker@4.1.5` package in the disposable
`C:\Users\Cameron\AppData\Local\Temp\hc-autolinker-rereview-415\package`
directory. This was a read-only probe; it did not modify the worktree.

- The declaration exposes `Autolinker.parse(textOrHtml, options)` as a public static
  method at `dist/commonjs/autolinker.d.ts:177`; its implementation constructs an
  instance and delegates to the public instance `parse` at
  `dist/commonjs/autolinker.js:485-487`. The declared return is `Match[]`, and
  `UrlMatch` has the public discriminant `readonly type: 'url'` plus
  `getUrlMatchType()` at `dist/commonjs/match/url-match.d.ts:18-22,70-80`.
  Therefore the exact type narrowing in the plan at
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:312,331-335` is
  supported and does not reuse the private `parseText` API.
- `UrlMatchType` is exactly `'scheme' | 'tld' | 'ipV4'` at
  `dist/commonjs/match/url-match.d.ts:121`. Runtime returned `tld` for both
  `www.example.com/a` and `example.com:8443/a?x=1#top`; it returned `tld` for
  `//example.com/a` too. The sketch's source-leading `//` branch precedes the
  `tld` branch at plan lines 315-319, so the protocol-relative input becomes
  `https://example.com/a`, while both public fuzzy forms become HTTPS. There is
  no stale `'www'` comparison.
- With the exact approved options, masking raw delimiters as specified at plan
  lines 31-38 produced these public-parse results:

  - `<script>https://example.com/a</script>`: URL offset 8, matched length 21;
    slicing the original source at that range returned exactly
    `https://example.com/a`.
  - `<a>https://example.com/a</a>`: URL offset 3, matched length 21.
  - `<!-- https://example.com/a -->`: URL offset 5, matched length 21.
  - `emoji` plus a U+1F600 character, a space, and the literal script-shaped
    source: URL offset 17, the exact JavaScript code-unit offset in the original
    string, and original slicing again returned the URL byte-for-byte.

  These reproduce the tag, anchor, and comment suppression that raw static
  `parse` previously caused, while exercising the actual public API. U+FF1C and
  U+FF1E each occupy one JavaScript code unit, so the map used by the sketch is
  length preserving. The specification requires exactly that map and original
  range slicing at
  `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:162-184`.
- The explicit literal source `https://example.com/?x=1&amp;y=2` returned one
  `scheme` match whose matched text and original slice were the complete 32
  character source. Passing the exact source candidate through the current
  `safeHttpUrl` returned the same literal URL, including `&amp;`; it did not turn
  the query into `&y=2`. This validates the revised candidate rule at plan lines
  40-45 and sketch lines 314-320 against the final safety function at
  `dashboard/src/lib/safeUrl.ts:9-17`.
- `ftp://example.com/a`, `ftps://example.com/a`, and `file:///tmp/a` were each
  parser `scheme` matches, but the exact candidate returned `null` from the
  current `safeHttpUrl` boundary. `http://localhost:5174/a` remained a `scheme`
  match and safe HTTP link, while `//localhost/a` produced no URL match. This is
  the required unsupported-scheme and local-only behavior without an
  application-owned host grammar.
- A punctuation vector with balanced ASCII delimiters, U+3002, U+FF0C, U+3001,
  and full-width brackets produced the same offsets, matched lengths, and source
  slices from masked public `parse` as from the package's internal non-HTML parser.
  The public result excluded the surrounding punctuation, so the copied parser
  boundary remains the selected parser's boundary rather than a local trim rule.

## Contract and proof review

- The specification describes the parser-only source copy, public API, original
  source slicing, `tld` normalization, exact explicit-source candidate, and final
  `safeHttpUrl` authority consistently at
  `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:162-205`.
  Its security contract still confines rendering to React text/anchor nodes and
  to absolute safe HTTP(S) destinations at lines 270-281.
- The implementation sketch follows that contract: it masks only the parser copy
  at plan lines 308-310, derives `matchEnd` only from the parser offset and
  same-length match at lines 331-335, derives candidates from the original source
  at lines 314-320, and clips only the visible label after parsing the complete
  input at lines 346-359. A crossing URL therefore retains its full destination,
  as required by the spec at lines 236-253.
- The revised test corpus directly covers explicit HTTP(S), protocol-relative,
  `www`, and bare-domain HTTPS outputs at plan lines 201-220; literal script,
  anchor, comment, and HTML-looking source at lines 257-265; and the literal
  `&amp;` plus snippet-boundary case at lines 261-263. The Linux ARM64 package
  probe at lines 163-165 repeats the public API, bare, `www`, protocol-relative,
  script offset, and literal-amp candidate checks. It is sufficient package proof
  for the documented dependency gate.
- The propagation plan still changes exactly the approved readers: the SMS/MMS
  message body plus Timeline email snippet and expanded email at plan lines
  530-569, and only opened `UnmatchedRow` detail at lines 651-669. It explicitly
  leaves the unmatched-row preview raw. The live reader surfaces agree:
  `dashboard/src/routes/contact/Timeline.tsx:1035,1477-1505` and
  `dashboard/src/routes/email/UnmatchedRow.tsx:136,182`. The worklist preserves
  the same boundary at `.superpowers/sdd/worklist.md:32-33`.

## Non-blocking observation

The supported static API still recognizes HTML character-reference boundaries.
For example, masked public `parse` links the URL in
`&lt;script&gt;https://example.com/a&lt;/script&gt;` at original offset 14, but a
literal `https://example.com/a?x=1&nbsp;z=2` is matched only through `x=1`.
Offsets remain valid and the required literal `&amp;` case is fully preserved.
This is a documented consequence of choosing the public HTML-aware parser after
masking raw tag/comment delimiters, not a source-loss, destination-rewrite, or
markup-suppression regression in the approved corpus. The current documents
accurately limit the masking claim to raw `<` and `>` tag/comment interpretation
at spec lines 162-168, so this does not require a correction before S1.

## Must-fix findings

None.
