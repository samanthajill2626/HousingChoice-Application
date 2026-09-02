# Parser amendment re-review

Verdict: FINDINGS

## Finding 1 - HIGH: the selected parser violates the locked bare-localhost exclusion

**Location:** `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:159-162,277-280` and `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:307-335`

The amended tokenizer renders every non-suppressed `url` result whose parser `href`
passes `safeHttpUrl`. With the required `linkifyjs@4.3.3` and exact options, a bare
single-label localhost is a URL result:

```
linkify.find('localhost/a', 'url', { defaultProtocol: 'https' })
// [{ type: 'url', value: 'localhost/a', href: 'https://localhost/a', start: 0, end: 11 }]
```

The prescribed code therefore emits a link token with text `localhost/a` and href
`https://localhost/a`. This directly contradicts the locked decision and required
test that bare `localhost` remains text; only explicit `http://localhost`,
`https://localhost`, and `//localhost` are eligible. The same behavior occurs for
bare `localhost` without a path. No proposed local filter may be silently added:
the current contract prohibits a competing URL grammar. Correct the parser/design
choice or obtain an explicit contract amendment before S1 resumes.

## Finding 2 - HIGH: `linkifyjs@4.3.3` includes the required-excluded Unicode sentence punctuation in the URL

**Location:** `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:232-249` and `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:191-194,269-285`

The binding test requires `example.com/unicode/path\u3002` to link only
`example.com/unicode/path`, leaving U+3002 as text, while also requiring parser-owned
punctuation boundaries and forbidding application punctuation trimming. The selected
parser does not have that boundary:

```
linkify.find('example.com/unicode/path\u3002', 'url', { defaultProtocol: 'https' })
// [{ type: 'url', value: 'example.com/unicode/path\u3002',
//    href: 'https://example.com/unicode/path\u3002', start: 0, end: 25 }]
```

Passing `match.href` through `safeHttpUrl` preserves the character (percent-encoded
by `URL`), so the planned implementation cannot produce the specified token array.
A local U+3002 trimmer would contradict the no-competing-regexp/parser-owned-boundary
rule. Reconcile the parser selection with the locked behavior before implementation.

## Prior findings re-check

The amendment itself correctly addresses both prior high findings:

- For `javascript://example.com/a`, `data://example.com/a`, `vbscript://example.com/a`,
  and `foo://example.com/a`, the parser's result is immediately preceded by `://`; the
  new guard leaves it literal instead of widening it to a protocol-relative HTTPS link.
- For a fuzzy URL containing embedded `https://` in its path, query, or fragment,
  the parser-supplied `href` is `https://`-normalized and survives `safeHttpUrl`.

Source-offset cursor behavior also remains lossless for both the suppressed result and
a display boundary that cuts through a match: preceding text, the visible match range,
and the remaining visible tail are emitted in source order. These correct fixes do not
resolve Findings 1 and 2.
