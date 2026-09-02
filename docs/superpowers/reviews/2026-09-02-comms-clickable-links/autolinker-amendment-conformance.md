# Autolinker amendment conformance review

Date: 2026-09-02
Scope: documentation amendment at `c22b153d` only. No implementation or manifest was changed.

## Verdict: FAIL

The selected package, parse-only API, source-range strategy, locality behavior,
punctuation behavior, and renderer boundaries conform. One must-fix conflict makes
the proposed code unable to meet the locked HTTPS-normalization contract: with the
required Autolinker options, `getAnchorHref()` returns `http://` for fuzzy `www`
and bare-domain matches. The amendment requires that exact value to be passed
directly to `safeHttpUrl`, which accepts HTTP and therefore cannot correct it.

No production code is approved from this design until the contract is reconciled.
The resolution must preserve the human-directed parser boundary; this review does
not select a new normalization rule.

## Review evidence

I unpacked and ran the published `autolinker@4.1.5` package in an isolated
temporary directory with scripts disabled. This did not alter the worktree,
manifests, or lockfile. Its declarations expose a default `Autolinker` export, a
static `parse(text, options)` method, a discriminated `type: 'url'` URL match, and
the `getOffset()`, `getMatchedText()`, and `getAnchorHref()` methods used by the
sketch.

The exact configured runtime probe produced the following material results:

```text
input: example.com:8443/a?x=1#top
match: type=url offset=0 text=example.com:8443/a?x=1#top
href: http://example.com:8443/a?x=1#top

input: example.com/a
href: http://example.com/a

input: www.example.com/a
href: http://www.example.com/a

input: //example.com/a
match: type=url offset=0 text=//example.com/a href=//example.com/a

input: //localhost/a
matches: []

input: http://localhost:5174/a
match: type=url offset=0 text=http://localhost:5174/a

input: example.com/unicode/path U+3002
match text: example.com/unicode/path
```

The same probe confirmed the expected source-only punctuation boundaries for
U+3002, U+FF0C, U+3001, ASCII brackets, and full-width brackets. It also confirmed
that `ftp://example.com`, `data://example.com/a`, and `foo://example.com/a` are
returned as complete URL matches, so the proposed final `safeHttpUrl` boundary is
required and will preserve them as text when it rejects their candidate.

## Conformance findings

### 1. Dependency selection and parser-only boundary - CONFORMS

- The adjudication names the direct dashboard dependency as
  `autolinker@4.1.5`, removes the superseded proposal, and prohibits the HTML
  renderer, anchor builder, `link()`, and replacement callback at
  `s1-autolinker-dependency-adjudication.md:8-11`.
- The plan limits the runtime dependency to `dashboard/package.json` and requires
  the root lockfile graph at `plans/2026-09-02-comms-clickable-links.md:29-30`.
- The exact URL-only options are consistent across the decision record
  `s1-autolinker-dependency-adjudication.md:13-22`, specification
  `specs/2026-09-02-comms-clickable-links-design.md:161-165`, plan
  `plans/2026-09-02-comms-clickable-links.md:31-36`, and live worklist
  `.superpowers/sdd/worklist.md:32`.
- The current dashboard manifest has no Autolinker entry at
  `dashboard/package.json:13-18`, as expected before S1. The amendment describes
  a future installation rather than falsely claiming the dependency is present.

### 2. Parse API, type shape, offsets, and source preservation - CONFORMS

- The proposed `import Autolinker from 'autolinker'`,
  `ReturnType<typeof Autolinker.parse>`, `type === 'url'` narrowing,
  `getOffset()`, and `getMatchedText()` use the actual package API at
  `plans/2026-09-02-comms-clickable-links.md:273-315`.
- The token sketch uses parser offsets and matched source rather than a competing
  URL expression at `plans/2026-09-02-comms-clickable-links.md:311-340`, consistent
  with the locked parser-owned source range at
  `specs/2026-09-02-comms-clickable-links-design.md:161-177`.
- The probe confirmed whole-match source preservation for the required bare-domain
  port/path/query/fragment input and correct nonzero offsets for bracketed input.

### 3. HTTP(S) safety fallback and unsupported-scheme text - CONFORMS

- Every planned link candidate reaches `safeHttpUrl` at
  `plans/2026-09-02-comms-clickable-links.md:298-300`; a rejected candidate becomes
  a text token at `:326-334`.
- The live guard accepts only absolute `http:` and `https:` destinations at
  `dashboard/src/lib/safeUrl.ts:9-17`, so it rejects the empirically recognized
  FTP, data, and unknown-scheme matches without emitting an anchor.
- The explicit test corpus preserves exact source and forbids unsupported anchor
  schemes at `plans/2026-09-02-comms-clickable-links.md:245-251`.

### 4. HTTPS normalization for fuzzy public URLs - MISSING (must-fix)

- The product contract requires `www` and bare domains to normalize to HTTPS before
  final safety validation at `specs/2026-09-02-comms-clickable-links-design.md:67-69`.
- The implementation contract instead says to pass every non-`//` match's
  `getAnchorHref()` directly to `safeHttpUrl` at
  `plans/2026-09-02-comms-clickable-links.md:37-45`; the exact sketch implements
  that rule at `:298-300`. The specification repeats the incorrect assertion that
  `getAnchorHref()` supplies an HTTPS TLD/bare target at
  `specs/2026-09-02-comms-clickable-links-design.md:172-175`.
- In Autolinker 4.1.5, the configured parser returns
  `http://example.com/a` for `example.com/a` and
  `http://www.example.com/a` for `www.example.com/a`. `safeHttpUrl` deliberately
  retains valid HTTP unchanged (`dashboard/src/lib/safeUrl.ts:12-13`). Therefore
  the sketch will render HTTP anchors, directly violating the specification.
- Adding `defaultProtocol: 'https'` to the options is not a remedy: the package
  declaration has no such configuration field, and the runtime probe still returned
  HTTP when the unsupported property was supplied.

Required adjudication: change the written contract so its allowed candidate
derivation can actually produce the required HTTPS fuzzy destinations, or change
the locked product requirement. Do not implement the current sketch and silently
ship HTTP anchors.

### 5. Protocol-relative and local-host treatment - CONFORMS

- The plan prefixes a parser-owned source beginning with `//` only at
  `plans/2026-09-02-comms-clickable-links.md:298-300`, which preserves the direct
  source and produces an absolute HTTPS candidate before `safeHttpUrl`.
- The decision record and specification exclude bare and protocol-relative local
  hosts while retaining explicit HTTP(S) localhost at
  `s1-autolinker-dependency-adjudication.md:48-53` and
  `specs/2026-09-02-comms-clickable-links-design.md:63-69`.
- The probe matched `//example.com/a`, did not match `//localhost/a`, and matched
  both explicit localhost HTTP(S) forms. This confirms the contract relies on the
  parser's boundary rather than an application host grammar.

### 6. Unicode punctuation, balanced brackets, and public-domain recognition - PARTIAL

- Match recognition conforms: the probe excluded U+3002, U+FF0C, U+3001, ASCII
  brackets, and full-width brackets from the matched source; the plan locks those
  cases at `plans/2026-09-02-comms-clickable-links.md:228-240`.
- Bare-domain port/path/query/fragment recognition also conforms at
  `s1-autolinker-dependency-adjudication.md:33-37` and
  `.superpowers/sdd/worklist.md:32-33`.
- End-to-end link conformance is partial because the public fuzzy URL destination
  is HTTP under the current code sketch (Finding 4), not the required HTTPS.

### 7. Email clipping, plain-text rendering, and nested-interactivity boundary - CONFORMS

- The specification requires parsing the complete email body before clipping its
  visible label, retaining the complete match destination, at
  `specs/2026-09-02-comms-clickable-links-design.md:216-233`; the token sketch
  parses `text` before applying `visibleEnd` at
  `plans/2026-09-02-comms-clickable-links.md:303-340`.
- The planned anchor is a React element with the required new-tab safety and stopped
  event propagation at `plans/2026-09-02-comms-clickable-links.md:343-363`, matching
  the specification at `specs/2026-09-02-comms-clickable-links-design.md:235-258`.
- The collapsed unmatched-email preview remains deliberately non-interactive at
  `plans/2026-09-02-comms-clickable-links.md:50-54`; the worklist identifies its
  header button and prohibits an anchor there at `.superpowers/sdd/worklist.md:78-83`.
- The HTML-looking-text corpus requires React text rendering and no generated image
  at `plans/2026-09-02-comms-clickable-links.md:252-255`. The parser probe found
  only the public URL after `<img ...>`; React text nodes preserve the apparent tag
  literally.

### 8. Commands and proof coverage - PARTIAL

- The focused dashboard commands map to live scripts: the dashboard provides
  `test`, `typecheck`, and `build` at `dashboard/package.json:6-11`; the plan uses
  them correctly at `plans/2026-09-02-comms-clickable-links.md:399-410`.
- The dependency proof covers clean install, resolved package graph, package
  lifecycle metadata, audit, and a disposable Linux ARM64 import at
  `plans/2026-09-02-comms-clickable-links.md:138-162`. Its static parse calls and
  `type`/offset/matched-text assertions are executable against 4.1.5.
- The Linux ARM64 probe and token tests do not assert the required normalized HTTPS
  destination for a bare or `www` match. The ARM probe can print success while the
  planned renderer emits the wrong HTTP anchor. Add a failing assertion for the
  exact normalized fuzzy `href` after the contract correction; this is needed to
  prevent a repeat of Finding 4.

## Required next action

Amend the spec, plan, decision record, and worklist consistently for the HTTPS
normalization conflict, then rerun this focused conformance review before S1 code or
dependency changes begin. All other reviewed Autolinker mechanics may remain as
written.
