# S1 Autolinker dependency adjudication

Date: 2026-09-02
Status: Human decision applied; revised design and plan require focused review.

## Decision

Replace the superseded `linkifyjs@4.3.3` proposal with direct dashboard
`autolinker@4.1.5`. Remove `linkifyjs` from the amended dependency design and do
not add it to manifests. Use its public URL-only match API on a parser-only
same-length source copy that replaces `<`/`>` with U+FF1C/U+FF1E, so the package
does not interpret sender text as HTML. Do not use the private `parseText` API, the
HTML renderer, anchor builder, `link()` method, or replacement callback.

The required parser configuration is:

```ts
{
  urls: { schemeMatches: true, tldMatches: true, ipV4Matches: false },
  email: false,
  phone: false,
  mention: false,
  hashtag: false,
}
```

The ordinary React token renderer preserves every source character. It derives a
candidate destination from a protocol-relative matched source by prefixing `https:`.
For parser `tld` classifications (including `www`) it prefixes exact original
matched source with `https://`; otherwise it uses exact original matched source.
Every candidate then passes through `safeHttpUrl`. Unsupported parsed schemes
therefore remain exact plain text rather than becoming destinations. This avoids
Autolinker's HTML-entity decoding in `getAnchorHref()`.

## Corpus and dependency evidence

The isolated decision corpus established that this configuration keeps U+3002,
U+FF0C, U+3001, ASCII/full-width brackets, and ordinary sentence punctuation out of
the URL match; returns source offsets; keeps a bare public-domain URL with port,
path, query, and fragment as one match; includes a protocol-relative public-domain
URL in its match; and recognizes `.zip` plus international-domain examples.

Autolinker 4.1.5 is MIT licensed, ships ESM/CJS and TypeScript declarations, has
one pure-JavaScript runtime dependency (`tslib`), and declares no native or optional
binary dependency. The isolated runtime audit reported zero vulnerabilities. S1
still must prove the exact lockfile graph, a clean Windows install/build, package
lifecycle metadata, and a disposable Linux ARM64 install/import before code is
accepted.

## Contract correction

Follow the mature parser's local-only boundary rather than adding a repository host
grammar. Bare `localhost`, protocol-relative `//localhost`, other single-label
hosts, and fuzzy IPs remain text. Explicit `http://localhost` and
`https://localhost` remain eligible after the final HTTP(S) safety check. This
intentionally replaces the earlier `//localhost` acceptance statement; the required
public bare-domain port/path/query/fragment behavior is unchanged.

## Rationale and preserved constraints

The `linkify-it` plus `tlds` spike failed the binding bare-domain port/path case.
The subsequent `linkifyjs` proposal could not satisfy the U+3002 boundary without
an application-owned Unicode grammar, contrary to the parser-owned-boundary
contract. The selected parser resolves both requirements without a competing URL
regular expression.

All other approved behavior remains: HTTP(S) safety, source-preserving plain-text
rendering, email-snippet clipping with complete destinations, stopped bubble click
propagation, an untouched unmatched-email row button, sender attribution, focused
and browser proof, platform dependency proof, full gates, and human-owned merge,
deployment, infrastructure, and production actions.
