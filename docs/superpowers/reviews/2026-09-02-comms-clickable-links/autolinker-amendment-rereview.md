# Autolinker amendment re-review

Date: 2026-09-02
Scope: Cold review of the documentation-only correction at `2c5e3e79` before S1
implementation. No implementation, manifest, or lockfile was changed by this
review.

## Verdict: FAIL

The correction has the right high-level intent: fuzzy public URLs must become
HTTPS, and literal communications text must not receive HTML-aware suppression.
However, the prescribed `parseText` call is private in the selected package's
published TypeScript API, and the proposed `www` classification does not exist in
that API. The exact S1 sketch therefore cannot typecheck. A further plain-text
source-preservation gap remains for an explicit URL containing literal `&amp;`.

No S1 dependency or implementation work should begin from this design. Resolve the
three must-fixes consistently in the decision record, specification, plan, and
proof corpus, then run another focused review against the supported package API.

## Empirical package check

I unpacked the cached published `autolinker@4.1.5` tarball in the disposable
`%TEMP%/hc-autolinker-rereview-415` directory and executed its CommonJS build with
the exact proposed URL-only options. The worktree, package manifests, and lockfile
were not changed.

The package declaration marks `parseText` as `private` at
`%TEMP%/hc-autolinker-rereview-415/package/dist/commonjs/autolinker.d.ts:510-531`.
An isolated strict TypeScript compile of the proposed
`ReturnType<typeof autolinker.parseText>` failed with:

```text
TS2341: Property 'parseText' is private and only accessible within class 'Autolinker'.
```

The same package declares `UrlMatchType` as only `'scheme' | 'tld' | 'ipV4'` at
`%TEMP%/hc-autolinker-rereview-415/package/dist/commonjs/match/url-match.d.ts:121`.
The isolated comparison against `'www'` failed with TS2367 because that string has
no overlap with the declared union.

At runtime, the private method does produce the intended non-HTML behavior:

```text
parser.parseText('<script>https://example.com/a</script>')
  -> scheme match at offset 8, source https://example.com/a
Autolinker.parse('<script>https://example.com/a</script>', options)
  -> []

parser.parseText('www.example.com/a')
  -> type tld, href http://www.example.com/a
parser.parseText('example.com:8443/a?x=1#top')
  -> type tld, href http://example.com:8443/a?x=1#top
```

Thus the behavior motivating A1 and A2 is real, but the stated public API and one
of its classifications are not.

## Must-fix findings

### R1 - The proposed plain-text parser API is private and makes the S1 sketch fail typecheck

Evidence:

- The decision requires one Autolinker instance's `parseText` API at
  `docs/superpowers/reviews/2026-09-02-comms-clickable-links/s1-autolinker-dependency-adjudication.md:8-12`.
- The specification calls `parseText` as the required plain-text API at
  `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:162-180`.
- The exact implementation sketch accesses it in both a type query and executable
  call at `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:304,324`.
- Published Autolinker declarations identify `parseText` as private at the package
  path and lines recorded in the empirical check above.

Reproduction: compiling the planned type alias with `tsc --strict` returns TS2341
before S1 can build. Calling the JavaScript method through a cast would only depend
on an unsupported private API and would violate the stated public-parser boundary.

Effect: the correction cannot ship as written, and a future Autolinker update may
change or remove the internal method without a supported compatibility contract.

Required correction: select a supported public plain-text parser interface that
meets the locked source-boundary behavior, or revise the product/parser decision
with an explicit supported implementation strategy. Do not bypass this failure with
`any`, a declaration augmentation, or an internal-method cast. Add a real dashboard
typecheck proof for the selected API before S1 implementation resumes.

### R2 - `www` is not an Autolinker 4.1.5 `UrlMatchType`, so the normalization sketch has a second TypeScript error

Evidence:

- The global contract requires a `www` or `tld` branch at
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:38-42`.
- The prescribed code compares `matchType === 'www'` at
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:306-313`.
- The decision makes the same classification claim at
  `docs/superpowers/reviews/2026-09-02-comms-clickable-links/s1-autolinker-dependency-adjudication.md:26-31`.
- The published declaration's actual union is `'scheme' | 'tld' | 'ipV4'`; the
  package runtime reports `tld`, not `www`, for `www.example.com/a`.

Reproduction: strict TypeScript reports TS2367 for comparing that union to `'www'`.
The runtime probe above shows that `tld` already covers both bare and `www` fuzzy
matches under the selected configuration.

Effect: even if R1 were bypassed, the sample implementation still fails typecheck.
The current wording also misstates the parser contract that is meant to prevent an
application-owned URL grammar.

Required correction: use only classifications actually declared and empirically
returned by 4.1.5, and add direct unit plus ARM probe assertions for both a bare and
`www` source. The correction must preserve the A1 outcome: both examples normalize
to HTTPS without using a local host or URL-recognition grammar.

### R3 - `getAnchorHref()` mutates literal `&amp;` in a plain-text explicit URL, breaking complete-source destination preservation

Evidence:

- The plan uses `getAnchorHref()` for every non-fuzzy, non-protocol-relative match
  at `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:306-313`.
- The specification says that a clipped link's destination is normalized from the
  complete original match at
  `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:235-244`, while
  the security contract requires source-preserving plain-text behavior at `:267-275`.
- Autolinker's `getAnchorHref()` unconditionally replaces every `&amp;` with `&` at
  `%TEMP%/hc-autolinker-rereview-415/package/dist/commonjs/match/url-match.js:146-149`.

Reproduction with the exact parser options:

```text
source: https://example.com/?x=1&amp;y=2
matched source: https://example.com/?x=1&amp;y=2
getAnchorHref(): https://example.com/?x=1&y=2
```

Effect: in a communication body, literal text representing the query parameter
name `amp;y` navigates as a different query with parameter `y`. This is HTML-source
decoding after the correction explicitly moved parsing to non-HTML text. The gap is
especially visible when the complete URL crosses the 140-character email boundary:
the visible source is preserved but the destination is not the complete source URL.

Required correction: define and test the candidate derivation for explicit scheme
matches so it preserves plain-text URL bytes while retaining the final
`safeHttpUrl` HTTP(S) boundary. Include an explicit `&amp;` regression, including a
crossing-snippet case if the selected supported parser API can recognize it.

## Adjudication challenge and non-findings

The A1 adjudication is directionally correct: observed `tld` matches for both bare
and `www` input make source-prefixed HTTPS viable, and `//` still needs the separate
`https:` candidate. It is not correct to describe a runtime `www` classification.

The A2 adjudication is directionally correct about runtime behavior: `parseText`
recognizes URLs inside literal script, anchor, and comment-shaped strings whereas
HTML-aware `parse` suppresses them. It is not correct to call `parseText` public or
to base new production code on it without an explicit supported API decision.

No additional regression was found in the planned Timeline and unmatched-email
propagation boundaries. The current live surfaces remain the message body at
`dashboard/src/routes/contact/Timeline.tsx:1035`, the Timeline email snippet and
expanded body at `dashboard/src/routes/contact/Timeline.tsx:1477-1505`, and only
the expanded unmatched-email detail outside Timeline. The proposed scope continues
to leave the unmatched-email row-toggle preview non-interactive. The final
`safeHttpUrl` guard at `dashboard/src/lib/safeUrl.ts:9-17` still rejects parsed FTP,
data, and unknown schemes; this review found no reason to weaken that boundary.
