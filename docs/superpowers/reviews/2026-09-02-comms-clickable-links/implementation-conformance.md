# Implementation conformance review - clickable communications links

Date: 2026-09-02
Reviewer: Phase 4 spec conformance
Scope: `b45e6fdca1ca9fc986df02e9d7b768c6aad1de19...070655f8`

## Verdict: FAIL - two must-fix record/discipline defects

The runtime implementation and focused proof conform to the approved behavior.
The branch is not ready to advance until the two findings below are corrected and
the affected focused checks are rerun. Full repository gates and live self-QA are
later workflow phases and are not claimed by this review.

## Must-fix findings

### C1 - New Timeline comment is non-ASCII

`dashboard/src/routes/contact/Timeline.tsx:9` is a newly changed comment and
contains an em dash. The repository requires new or touched comments to be
ASCII-only. Reproduce with:

```powershell
git diff --unified=0 --no-color b45e6fdca1ca9fc986df02e9d7b768c6aad1de19...HEAD |
  Select-String '^\\+' |
  Select-String '[^\\x00-\\x7F]'
```

It reports the added Timeline comment. Replace the punctuation with ASCII before
the next commit. This is a source-discipline defect; tests will not expose it.

### C2 - Dependency proof records the wrong license for tslib

`docs/superpowers/reviews/2026-09-02-comms-clickable-links/s1-dependency-proof-adjudication.md:11-13`
states that the installed manifests reported MIT licensing. The selected direct
dependency is MIT, but its installed runtime dependency is not: `package-lock.json:8266-8269`
and `node_modules/tslib/package.json` identify `tslib@2.8.1` as `0BSD`.

Reproduce with:

```powershell
node -p "require('./node_modules/tslib/package.json').license"
```

Expected output is `0BSD`. Correct the tracked proof to state `autolinker` is MIT
and `tslib` is 0BSD. This does not reject the dependency; it makes the required
license evidence accurate.

## Work-map conformance

| Item | Status | Evidence |
| --- | --- | --- |
| S1 shared parser and dependency | PARTIAL | `dashboard/package.json:13-18` and `package-lock.json:4682-4689,8266-8269` contain exact `autolinker@4.1.5` and `tslib@2.8.1`. `LinkifiedText.tsx:16-68` uses the exact URL-only options, public `Autolinker.parse`, same-length angle masking, parser ranges, original source, protocol-relative/tld HTTPS normalization, and final `safeHttpUrl` call. C2 leaves the dependency-proof record inaccurate. |
| S2 shared Timeline readers | CONFORMS | The only approved Timeline sites use the shared component at `Timeline.tsx:1035-1040,1506-1519`. Shared Timeline callers remain unchanged; `Timeline.linkified.test.tsx:53-153` covers inbound/outbound SMS and MMS, attachments, Relay/native-group attribution, metadata click control, email clipping, and whitespace behavior. |
| S3 opened unmatched-email detail | CONFORMS | `UnmatchedRow.tsx:122-138` keeps the raw preview in its header button, while only loaded `detail.text` uses the component at `:177-208`. `UnmatchedRow.test.tsx:61-87` proves no preview link, safe opened link, punctuation, one read mark, HTML disclosure, and attachments. |
| E1 hermetic browser seam | CONFORMS | `e2e/tests/dashboard-next/comms-clickable-links.spec.ts:30-77` reseeds lean data, plants a real inbound message, asserts both hrefs/attributes and punctuation exclusion, routes a hermetic popup, and proves the dashboard route and bubble class remain unchanged. The E1 report records exit 0, `1 passed (33.8s)`, and freed owned ports. |
| E2 focused proof and diff boundary | CONFORMS | The ledger records dashboard typecheck exit 0, 9 focused files and 246 tests, dashboard build exit 0, and `git diff --check` exit 0. The changed behavior is limited to the three Timeline text sites and opened unmatched detail; no backend, API, seed, or endpoint change appears in the feature diff. |

## Acceptance-contract check

- Recognition and safety: CONFORMS. `LinkifiedText.tsx:30-60` preserves explicit HTTP(S), normalizes parser-owned protocol-relative and `tld` matches to HTTPS, and allows only `safeHttpUrl` output. Tests at `LinkifiedText.test.tsx:30-130` cover public bare domains with ports/path/query/fragment, `www`, local exclusions, explicit localhost, unsupported schemes, punctuation, Unicode delimiters, IDN, `.zip`, repeated offsets, raw tag/comment-shaped input, and literal `&amp;`.
- Plain-text security and DOM shape: CONFORMS. The component emits keyed `Fragment` text plus real anchors at `LinkifiedText.tsx:71-93`; it has no HTML renderer or injection path. `LinkifiedText.test.tsx:133-171` proves direct text nodes, escaped markup-shaped input, attributes, and stopped propagation.
- Visible source, clipping, and whitespace: CONFORMS. Full-source parsing and display clipping are in `LinkifiedText.tsx:39-68`; Timeline computes the truncated-only `snippetEnd` at `Timeline.tsx:1481-1485`. `Timeline.linkified.test.tsx:115-153` proves full href for a clipped label, `...` for 141 spaces, and untruncated trailing-whitespace preservation.
- Timeline coverage and non-link regressions: CONFORMS. `Timeline.tsx:1015-1041,1495-1535` preserves attribution, attachment placement, metadata behavior, email fields, and the sandboxed original-HTML disclosure. The diff does not alter scheduled cards, calls/transcripts, composers, or Timeline callers.
- Unmatched-email interactive boundary: CONFORMS. The preview remains text inside the header button and the opened detail alone adds anchors, as proved above.
- Anchor behavior/style: CONFORMS. `LinkifiedText.tsx:79-88` supplies `target="_blank"`, `rel="noopener noreferrer"`, and stopped bubbling. `LinkifiedText.module.css:1-14` keeps underline, wrapping, focus ring, and visited color parity.
- Dependency/platform evidence: PARTIAL. S1 records clean Windows install, build, no install scripts/optional/native dependencies, ARM64 import success, and existing unrelated audit findings, but C2 must correct the license statement.
- Final full gates and hermetic live self-QA: PENDING by workflow sequence. They are required before handback, but are intentionally not completed or implied by this Phase 4 implementation review.

## Review notes

- The plan's original contiguous-prefix clipping fixture was correctly adjusted in
  `Timeline.linkified.test.tsx:115-121`: the inserted ASCII delimiter establishes
  a real parser boundary while retaining URL start offset 126. This is a justified
  live-parser correction, not a scope deviation.
- The public static parse strategy is supported by the prior cold re-review at
  `autolinker-public-api-rereview.md:1-118`; this implementation does not call
  private `parseText`, `getAnchorHref`, `link`, an anchor builder, or a replacement
  callback.
