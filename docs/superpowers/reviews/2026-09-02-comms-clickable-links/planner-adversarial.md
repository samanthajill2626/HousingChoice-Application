# Planner-side plan-blind adversarial review

## Scope

Reviewed only the committed `main...HEAD` diff at `feat/comms-clickable-links`
`3136c60e465a99338e7e90077d46b84fabf8eb8e`, the repository code, and
`AGENTS.md`. I did not read the feature design, plan, worklist, handback, or
prior review/adjudication artifacts.

## Verdict: PASS

No actionable findings.

The new tokenizer preserves source offsets while using Autolinker only as a
parser, reconstructs every rendered href from the original source, rejects any
non-HTTP(S) result through `safeHttpUrl`, and renders text through React nodes
rather than generated HTML (`dashboard/src/ui/LinkifiedText.tsx:24-71`). Its
anchors use both `target="_blank"` and `rel="noopener noreferrer"`
(`dashboard/src/ui/LinkifiedText.tsx:82-91`). The rendering change reaches the
shared Timeline SMS/MMS body, both Timeline email presentations, and loaded
unmatched-email detail without changing a mutation or source-of-truth path
(`dashboard/src/routes/contact/Timeline.tsx:1035-1039`,
`dashboard/src/routes/contact/Timeline.tsx:1506-1519`,
`dashboard/src/routes/email/UnmatchedRow.tsx:177-208`). All contact, relay,
native-group, tour, and placement conversation surfaces route through that
Timeline component. The explicit link click propagation guard is correct for
the existing bubble metadata toggle (`dashboard/src/routes/contact/Timeline.tsx:1006-1018`).

## Residual risks

- Explicit `http(s)` URLs, including loopback/private-network addresses and
  URLs with user-info, remain deliberately clickable. They require an operator
  click and open in a separate tab; no page-origin script execution or request
  is introduced automatically. If the product threat model later treats
  staff-facing messages as untrusted phishing content, address that centrally
  in `safeHttpUrl` rather than adding a second, divergent parser policy here.
- `LinkifiedText` parses its input on each render; a collapsed email snippet
  also parses the complete body so a URL crossing the 140-character boundary
  keeps its complete destination. Autolinker documents this as linear parsing,
  so this is not a correctness defect, but unusually large retained email
  bodies plus Timeline's delivery-status ticker remain a performance watchpoint.
- External links are visibly underlined and keyboard-focusable, but their
  accessible name does not state that they open a new tab. That is a future UX
  refinement, not a failure of link semantics or keyboard operation.

## Final wide re-review - 2026-09-02 (HEAD `e1d8f471`)

### Verdict: PASS

No new severity-labeled findings.

This was a fresh full-diff sweep, not a confirmation of the earlier result. I
verified the only new documentation correction directly: the E2E actually waits
for a popup and proves its external navigation, so changing the handback from
"popup non-opening assertion" to "popup navigation" is accurate
(`e2e/tests/dashboard-next/comms-clickable-links.spec.ts:78-80`). The design
status-line correction has no runtime or test effect.

I re-traced every Timeline caller and its optimistic writers: contact, relay,
native-group, tour, and placement conversations all supply messages to the one
modified shared renderer; no write, SSE, delivery, source-selection, or
attachment path was changed. The unmatched-email change remains confined to the
already-lazy opened-detail response, outside the header button
(`dashboard/src/routes/email/UnmatchedRow.tsx:101-116`,
`dashboard/src/routes/email/UnmatchedRow.tsx:177-208`). Additional parser
probes confirmed code-unit-correct offsets after surrogate pairs, literal
markup delimiters retained as React text, rejected unsupported schemes, and
source-punctuation preservation. `git diff --check main...HEAD` is clean.

The prior residual risks remain bounded. In particular, Autolinker can identify
a scheme URL after adjacent word text (for example `xhttps://example.com`),
but the renderer links the exact detected `https://...` substring and preserves
the prefix as text. Without a product word-boundary requirement, that is parser
policy rather than a confirmed source/destination-integrity defect.
