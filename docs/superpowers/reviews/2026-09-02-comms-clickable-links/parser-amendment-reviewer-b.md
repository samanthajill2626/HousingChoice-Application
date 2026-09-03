# Parser amendment adversarial review

## Finding 1 - HIGH: protocol-relative widening turns unsupported-scheme payloads into HTTPS anchors

**Location:** `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:298-315` and `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:167-176`

The proposed `protocolRelative` test treats any URL result preceded by `//` as a
protocol-relative URL, regardless of what occurs before those slashes. LinkifyJS
does not recognize `javascript`, `data`, `vbscript`, or an arbitrary scheme as the
URL token in `scheme://example.com`; it recognizes the bare domain beginning after
the slashes. The prescribed widening therefore changes a parser result from
`example.com/a` into `//example.com/a`, and normalizes it to an HTTPS destination.

Concrete reproduction with `linkifyjs@4.3.3` and the exact proposed options:

```
linkify.find('javascript://example.com/a', 'url', { defaultProtocol: 'https' })
// [{ type: 'url', value: 'example.com/a', start: 13, end: 26, href: 'https://example.com/a' }]
```

The plan then computes `protocolRelative === true`, `source === '//example.com/a'`,
and `safeHttpUrl('https://example.com/a')` succeeds. The rendered body becomes
literal `javascript:` followed by a clickable `//example.com/a` HTTPS anchor. The
same result occurs for `data://`, `vbscript://`, `unknown://`, and
`foo://localhost/a`. This contradicts the locked exclusion of non-web schemes and
makes the source-boundary rule depend on an accidental two-character suffix rather
than a genuine protocol-relative URL. The acceptance tests cover only
`javascript:example.com` and `data:text/html,example.com`; they do not exercise the
`://` cases that trigger this transformation.

## Finding 2 - HIGH: `source.includes('://')` rejects valid fuzzy URLs whose path, query, or fragment contains a URL

**Location:** `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:281-287` and `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:171-175`

The planned normalizer uses `source.includes('://')` to decide that a match has an
explicit scheme. `://` is legal inside a fuzzy URL's path, query, and fragment, so
this is not a test for a leading scheme. It passes that bare source unchanged to
`safeHttpUrl`, whose `new URL(source)` rejects it as relative; the component then
returns it as plain text even though LinkifyJS found a valid URL.

Concrete reproduction with `linkifyjs@4.3.3` and the exact proposed options:

```
linkify.find('example.com/?next=https://target.example/a', 'url', { defaultProtocol: 'https' })
// [{ type: 'url', value: 'example.com/?next=https://target.example/a',
//    start: 0, end: 42, href: 'https://example.com/?next=https://target.example/a' }]
```

At plan line 284 the source contains `://`, so it is incorrectly treated as
explicit; `safeHttpUrl('example.com/?next=https://target.example/a')` returns null.
The same loss occurs for `example.com/redirect/https://target.example/a`,
`www.example.com/?next=https://target.example/a`, and a fragment containing an
embedded URL. This violates the required fuzzy bare-domain support for paths,
queries, and fragments, and neither the specified token tests nor the browser proof
covers it.
