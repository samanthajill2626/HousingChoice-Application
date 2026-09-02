# Spec review B - clickable links

## 1. [BLOCKING] Unsupported-scheme literal-text guarantee has no enforceable mechanism

What is wrong:

Sections 6 and 8 promise that `javascript:`, `data:`, `vbscript:`, `file:`,
`ftp:`, and `mailto:` remain literal text, including when adjacent text contains
a valid link. The specified mechanism only disables the parser's `ftp:` and
`mailto:` schemas, then treats every fuzzy match as a URL by prefixing it with
`https://` before calling `safeHttpUrl`. `safeHttpUrl` sees only that synthetic
HTTP(S) string, so it cannot distinguish a genuine bare domain from a fuzzy
domain that the parser found inside the tail of an unsupported-scheme string.
No source-context exclusion or parser rule that makes the stated guarantee true
is specified.

Evidence:

- Spec sections 6 and 8 require unsupported schemes to remain literal, while
  section 6 prescribes HTTPS-prefixing every fuzzy match before the sole safety
  check.
- The current lockfile resolves `linkify-it` 5.0.2 through `mailparser`
  (`package-lock.json:6685-6691`). With the spec's intended settings on that
  installed parser (`tlds`, `fuzzyLink: true`, `fuzzyEmail: false`,
  `fuzzyIP: false`, `ftp:` disabled, and `mailto:` disabled),
  `data:text/html,example.com` produces a fuzzy `example.com` match. The
  installed parser separately gathers fuzzy candidates after schema candidates
  (`node_modules/linkify-it/index.mjs:488-513`) and normalizes a fuzzy match by
  prepending `http://` (`node_modules/linkify-it/index.mjs:627-635`). The
  target 6.1.0 behavior is UNVERIFIED in this worktree, but the design gives no
  version-specific proof or required guard that would prevent the same result.
- The existing final boundary accepts and serializes any absolute HTTP(S) URL
  (`dashboard/src/lib/safeUrl.ts:9-17`), so it will accept the resulting
  `https://example.com`, not reject it because the original source started with
  `data:`.

What it implies:

The builder must invent an exclusion policy, despite the spec claiming that the
parser plus `safeHttpUrl` is the complete trust boundary. Without a defined
mechanism and tests for embedded cases such as `data:text/html,example.com` and
`javascript:example.com`, the implementation can ship a clickable link inside
text the acceptance criteria require to stay literal. Define the exact parser
configuration or source-boundary rule that rejects these candidates before
normalization, and require the embedded-scheme cases in the pure-helper tests.

## 2. [LOW] Email snippet contract omits current trailing-whitespace trimming

What is wrong:

The spec says the new helper emits text unchanged and describes a 140-source-
character snippet followed by `...`, but it does not preserve the current
`trimEnd()` step before that suffix. A direct implementation of sections 7.1 and
7.3 changes the text-node contract for a truncated email whose first 140 source
characters end in whitespace.

Evidence:

- The current EmailCard computes a truncated snippet as
  `bodyText.slice(0, EMAIL_SNIPPET_CHARS).trimEnd() + '...'`
  (`dashboard/src/routes/contact/Timeline.tsx:1477-1480`).
- Section 7.1 says text before, between, and after matches is emitted unchanged;
  section 7.3 only says to apply a 140-character source limit and request the
  suffix.

What it implies:

State whether the pre-suffix `trimEnd()` is retained and add a regression case.
Otherwise the design claims to keep the current email snippet presentation while
silently changing it for this input class.
