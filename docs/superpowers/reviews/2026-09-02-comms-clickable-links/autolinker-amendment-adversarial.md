# Autolinker amendment adversarial review

Date: 2026-09-02
Scope: Amended parser/design and live reader surfaces before implementation.
Verdict: FAIL - two blocking contract mismatches must be corrected before S1.

## Findings

### HIGH A1 - Fuzzy public URLs are downgraded to HTTP, not normalized to HTTPS

Evidence:

- `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:67-69`
  requires `www` and bare-domain matches to normalize to `https://`.
- `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:172-175`
  and `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:37-45`
  direct all non-protocol-relative URL matches through `getAnchorHref()`.
- The proposed implementation does exactly that at
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:298-300`.
- Autolinker 4.1.5's installed package source implements `UrlMatch.getUrl()` by
  prepending `http://` to a non-scheme, non-protocol-relative match, and
  `getAnchorHref()` returns that value. This is also stated in its own type
  documentation as an HTTP assumption.

Reproduction:

```
Autolinker.parse('example.com/path?x=1#f', options)[0].getAnchorHref()
// 'http://example.com/path?x=1#f'
Autolinker.parse('www.example.com/a', options)[0].getAnchorHref()
// 'http://www.example.com/a'
```

Effect: the proposed component silently navigates fuzzy public links over HTTP,
contrary to the locked HTTPS normalization and the stated security/privacy
invariant. `safeHttpUrl` accepts both schemes, so it cannot repair this downgrade.

Required correction: branch on the parser match kind/source and explicitly prefix
`https://` for `www` and bare TLD matches, while retaining the source-preserving
display label and retaining the existing `https:` prefix for `//` matches. Add
direct assertions for both `www` and bare-domain HTTPS hrefs; the current E1 test
would otherwise fail its expected bare href.

### HIGH A2 - `Autolinker.parse()` treats message text as HTML and violates the plain-text parser boundary

Evidence:

- `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:74`,
  `:252-260`, and `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:41-42`
  require untrusted communications to remain plain text and prohibit parsing HTML.
- The amended design mandates `Autolinker.parse(text, ...)` at
  `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:161-166` and
  the proposed implementation calls it at
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:311`.
- In Autolinker 4.1.5, `parse()` calls `parseHtml()` and deliberately skips text
  nested in `a`, `style`, and `script` tags plus comments. That is HTML parsing,
  even though the eventual React output is escaped.

Reproduction:

```
Autolinker.parse('<script>https://example.com/a</script>', options)
// []
Autolinker.parse('<a>https://example.com/a</a>', options)
// []
Autolinker.parse('<b>https://example.com/a</b>', options)[0]
// source offset 3, source 'https://example.com/a'
```

Effect: identical literal communication text receives different link behavior
because the parser interprets sender text as markup. React then displays the tag
characters as plain text, making the invisible parser behavior both surprising and
outside the approved plain-text contract. This also leaves the planned
HTML-looking-content test unable to prove that source text is handled without an
HTML parser.

Required correction: construct one module-scoped Autolinker instance with the
approved URL-only options and call its public `parseText(text)` method, which
accepts non-HTML text and returns offsets relative to that source. Preserve the
existing React-only renderer. Add regression tests for literal `script`, `a`, and
comment-shaped strings containing a URL, asserting their source text is escaped
and their URL recognition is not suppressed by HTML interpretation.

## Checked non-findings

- The token plan uses JavaScript offsets and `slice`; that is consistent with the
  explicitly retained JavaScript source-string 140-character snippet contract in
  `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:232-233`,
  including surrogate pairs.
- The proposed parser options disable fuzzy IPv4 matching, and explicit HTTP(S)
  localhost behavior matches the amended local-only decision. Explicit private
  HTTP(S) addresses remain clickable under the stated HTTP(S)-only boundary; the
  design does not promise a private-network denylist or background fetch.
- `safeHttpUrl` at `dashboard/src/lib/safeUrl.ts:9-17` is an effective final
  scheme gate for `javascript:`, `data:`, `vbscript:`, and other non-HTTP(S)
  parser matches, but it accepts HTTP and therefore cannot enforce A1's required
  HTTPS normalization.
- The live reader audit supports the planned propagation boundary: Timeline owns
  the approved message body and plain-text email sites at
  `dashboard/src/routes/contact/Timeline.tsx:1035`, `:1500`, and `:1505`; the
  separate opened unmatched-email body is at
  `dashboard/src/routes/email/UnmatchedRow.tsx:182`. The unmatched row preview
  remains inside its button at `UnmatchedRow.tsx:122-138` and should remain raw
  text. Scheduled cards and call transcripts are distinct excluded readers.

## Review conclusion

Do not begin S1 from the current documents. Correct A1 and A2, update their unit
and browser/component assertions as appropriate, then re-review the amended
parser contract. No implementation, manifest, or runtime reader file was changed
for this review.
