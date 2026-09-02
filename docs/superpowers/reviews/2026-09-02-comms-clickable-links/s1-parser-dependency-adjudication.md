# S1 parser dependency adjudication

Date: 2026-09-02
Status: Human decision applied; revised design and plan require focused review.

## Blocker evidence

The first S1 attempt installed the approved `linkify-it@6.1.0` and `tlds@1.261.0`
without committing them. Clean Windows installation, dependency metadata, and the
disposable Linux ARM64 probe passed. The exact required parser configuration still
returned no match for `example.com:8443/a?x=1#top`, although it matched ordinary
bare domains, paths, `.zip`, and explicit HTTP(S) URLs. That conflicts with the
approved required fuzzy bare-domain port/path behavior and the ban on a competing
repository URL regexp.

## Human decision

Replace the rejected dependencies with direct dashboard `linkifyjs@4.3.3` core.
Do not use `linkify-react`. Remove the uncommitted `linkify-it` and `tlds` additions.
The isolated parser probe showed that `linkifyjs.find` returns one URL result with
source offsets for the required port/path form, ordinary bare and `www` forms,
`.zip`, and parser-owned punctuation boundaries.

`linkifyjs` begins a protocol-relative result after the adjacent `//`. The revised
contract widens only that parser result by exactly those two source characters before
normalization. It introduces no competing URL recognition regexp. The renderer still
filters URL results, preserves only explicit HTTP(S) sources, normalizes protocol
relative and inferred destinations to HTTPS, and requires `safeHttpUrl` before an
anchor is emitted.

## Preserved constraints

All original acceptance behavior remains: bare-domain ports/paths/query/fragments;
punctuation and source offsets; HTTP(S) safety; plain-text rendering; email snippet
clipping; propagation isolation; the unmatched row-button boundary; focused and
browser proof; dependency platform proof; full gates; and human-owned merge,
deployment, infrastructure, and production actions.
