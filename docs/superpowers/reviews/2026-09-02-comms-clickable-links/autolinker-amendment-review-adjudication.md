# Autolinker amendment review adjudication

Date: 2026-09-02
Scope: Resolve the two confirmed blockers in the independent review reports at
`autolinker-amendment-conformance.md` and `autolinker-amendment-adversarial.md`.

## Confirmed findings and resolutions

### A1: Fuzzy `www` and bare URLs defaulted to HTTP

Confirmed. Autolinker 4.1.5's `getAnchorHref()` assumes `http://` for its `www`
and `tld` match classifications. Passing that value directly through `safeHttpUrl`
would violate the approved HTTPS-normalization contract because the safety boundary
correctly permits both HTTP and HTTPS.

Resolution: after preserving explicit `http://`/`https://` and source-leading `//`,
use the parser's `getUrlMatchType()` metadata. For `www` and `tld`, derive the
candidate as `https://${getMatchedText()}`. For `scheme`, use `getAnchorHref()` and
rely on `safeHttpUrl` to reject unsupported schemes. This is parser-owned match
classification, not an application URL grammar. The Linux ARM64 probe and unit
corpus now assert the normalized HTTPS bare and protocol-relative destinations.

### A2: Static `parse()` interpreted communication text as HTML

Confirmed. The static `parse()` route is HTML-aware and suppresses literal URLs in
sender-provided `script`, anchor, and comment-shaped text. That conflicts with the
plain-text renderer/security contract even though React would later escape the
source.

Resolution: construct one module-scoped Autolinker instance with the locked
URL-only configuration and call its public `parseText(text)` method. It returns
source-relative offsets and URL match metadata without HTML interpretation. The
unit corpus and Linux ARM64 probe now include literal script/anchor/comment-shaped
source cases. React remains the sole text/anchor renderer.

## Adjudication

Both findings are must-fix and are incorporated consistently in the specification,
implementation plan, decision record, and ignored live-tree worklist. No production
code or package manifest has changed. A fresh review of this fix is required before
S1 TDD restarts.
