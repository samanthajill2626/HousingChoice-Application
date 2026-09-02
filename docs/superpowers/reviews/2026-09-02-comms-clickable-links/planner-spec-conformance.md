# Planner-side spec conformance review - clickable communications links

Date: 2026-09-02

Reviewer: independent planner-side conformance review

Scope: committed feature diff `d4298abed01516baa5fae7767037767611e753c8...3136c60e465a99338e7e90077d46b84fabf8eb8e`, the approved design, and current reader consumers. This was a read-only review. No source, manifest, test, lockfile, git-state, or ignored-run-state change was made.

## Verdict: PASS

There are no remaining must-fix findings. The feature conforms to the approved shared-renderer, source-preservation, safety, reader-boundary, and interaction contracts. The narrow installed-parser probe also confirmed the critical classifications used by the implementation: a public domain with port/path/query/fragment and public protocol-relative input are URL matches, `//localhost/a` is not, and malformed `http:example.com/a` forms are scheme matches. The source-authority guard at `dashboard/src/ui/LinkifiedText.tsx:31-33` deliberately leaves the latter literal rather than allowing WHATWG URL repair to create a different destination; it is a safe tightening outside the accepted URL set, not a competing host or punctuation grammar.

## Requirement verdicts

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| S1 - exact dependency and shared tokenizer/renderer | PASS | `dashboard/package.json:13-18` pins direct runtime `autolinker` to `4.1.5`; `package-lock.json:4682-4692,8266-8269` resolves it with only `tslib@2.8.1`. `dashboard/src/ui/LinkifiedText.tsx:16-22` has the locked URL-only options, and `:24-71` uses a same-length parser-only angle-bracket mask, public parser ranges, original-source slices, protocol-relative/TLD HTTPS normalization, and `safeHttpUrl`. The component emits only React text fragments and anchors at `:74-95`; it neither mounts parser HTML nor produces markup strings. Dependency proof records clean Windows install/build, Linux ARM64 install/import, licenses, and no lifecycle/native/optional dependency path at `docs/superpowers/reviews/2026-09-02-comms-clickable-links/s1-dependency-proof-adjudication.md:9-18`. |
| Recognition, source preservation, and scheme safety | PASS | `LinkifiedText.tsx:47-65` retains only parser `url` matches, preserves source offsets and text, and degrades a rejected candidate to the exact text token. `:30-39` preserves explicit HTTP(S), makes only parser-TLD and leading `//` public inputs HTTPS, and passes every admitted candidate through the existing HTTP(S)-only boundary at `dashboard/src/lib/safeUrl.ts:9-17`. `dashboard/src/ui/LinkifiedText.test.tsx:24-138` covers HTTP(S), `www`, bare port/path/query/fragment, repeated ranges, punctuation and Unicode boundaries, IDN and `.zip`, local/fuzzy exclusions, explicit localhost, unsupported and malformed schemes, literal tag/comment-shaped content, literal `&amp;`, and a crossing display boundary. |
| S2 - all shared Timeline communications readers | PASS | The one shared message renderer invokes `LinkifiedText` for every non-email message body at `dashboard/src/routes/contact/Timeline.tsx:1014-1040`, preserving attachment rendering immediately afterward. Its email card uses the same renderer for the collapsed snippet and expanded plain-text body at `:1506-1519`. Direct contact, placement, tour, Relay, and native-group views continue to consume this shared Timeline at `dashboard/src/routes/contact/ContactCommsPane.tsx:319`, `dashboard/src/routes/placements/PlacementConversation.tsx:320`, `dashboard/src/routes/tours/TourConversation.tsx:467`, `dashboard/src/routes/conversation/ConversationDetail.tsx:480`, and `dashboard/src/routes/conversation/GroupTextView.tsx:448`. `dashboard/src/routes/contact/Timeline.linkified.test.tsx:53-153` covers inbound/outbound SMS and MMS, independent attachment display, Relay/native-group attribution, bubble click behavior, and both email presentations. |
| S3 - opened unmatched-email detail only | PASS | The collapsed preview remains literal text inside the row-toggle button at `dashboard/src/routes/email/UnmatchedRow.tsx:122-138`; only loaded opened plain text calls the shared renderer at `:177-184`. The original sandboxed HTML disclosure remains independent at `:185-199`. `dashboard/src/routes/email/UnmatchedRow.test.tsx:61-87` proves the preview has no anchor, the opened detail has a safe anchor with punctuation remaining text, and the existing read/HTML/attachment affordances remain intact. |
| Snippet semantics and source formatting | PASS | `EmailCard` computes the truncated-only visible range as `bodyText.slice(0, 140).trimEnd().length` at `Timeline.tsx:1481-1485`, parses the full source in `LinkifiedText`, and appends the existing ASCII suffix only when the body is over 140 characters at `:1506-1509`. The tokenizer computes the destination from the complete parser match before clipping its label at `LinkifiedText.tsx:47-65`. Focused tests prove full href plus clipped label, whitespace-only truncation, and untruncated trailing-whitespace preservation at `Timeline.linkified.test.tsx:115-153`. |
| Anchor behavior, styling, and propagation | PASS | Each emitted link has the required safe href, new-tab target, relationship attributes, and stopped click propagation at `LinkifiedText.tsx:82-91`. `dashboard/src/ui/LinkifiedText.module.css:1-14` preserves underlining, wrapping, focus-visible focus-ring styling, and visited-color parity. The shared Timeline test proves a link click does not reveal bubble metadata while an ordinary bubble click does at `Timeline.linkified.test.tsx:95-113`. |
| E1 - hermetic browser proof | PASS | `e2e/tests/dashboard-next/comms-clickable-links.spec.ts:35-85` reseeds the owned lane before and after the test, injects an explicit and bare-path URL, checks complete hrefs/attributes and excluded punctuation, routes a controlled popup target, and proves popup navigation leaves the dashboard route and bubble metadata unchanged. The self-QA record documents the focused proof as a passing hermetic run at `docs/superpowers/reviews/2026-09-02-comms-clickable-links/self-qa.md:22-33`. |
| E2 - focused proof, review records, final workflow evidence | PASS with residual risk | The final handback records focused linkifier, dashboard, browser, dependency, review, self-QA, synchronization, and final-gate evidence at `docs/superpowers/reviews/2026-09-02-comms-clickable-links/handback.md:22-69`. It correctly preserves the raw final result: typecheck, unit, and smoke exited 0; full E2E exited 1 due to a non-feature outbound-MMS viewer failure also reproduced at base; touched-file lint's sole error is baseline. The detailed attribution is at `final-gate-adjudication.md:10-46`. |

## Non-blocking notes and residual risks

- The raw `npm run e2e` completion command was not green: 266 tests passed and the unrelated outbound-MMS viewer assertion failed. It is a genuine remaining suite-health risk, not a clickable-links regression, because the same file fails at the original base and passes twice in isolation on this branch; the branch records that evidence rather than claiming a green gate (`final-gate-adjudication.md:16-46`).
- The focused browser proof exercises one real shared Timeline path. The other reader variants are covered at the component/shared-renderer seam, which is the intentional scope boundary; no separate route-specific browser test is necessary for identical renderer behavior.

## Findings

No must-fix findings.

## Final wide re-review - 2026-09-02 (HEAD `e1d8f471b3f90fc3b827de4a7481f462ad08bbad`)

### Verdict: PASS

This re-review did not rely on `planner-review-adjudication.md` as an authority. I independently inspected the complete `3136c60e..e1d8f471` documentation delta, the approved specification, the live linkifier and all approved reader seams, the E1 source, and the self-QA/final-gate records. `git diff --exit-code 3136c60e..e1d8f471 -- dashboard package-lock.json e2e/tests` exited 0: the correction changes no runtime source, dependency, lockfile, or browser test.

The corrected specification status is accurate and suitably scoped: `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:3` says it is approved after the Autolinker public-API re-review, and that re-review is explicitly PASS with no must-fixes at `autolinker-public-api-rereview.md:7-13,116-118`. It does not claim that the unrelated raw-red full E2E gate passed.

The E1 handback correction is also accurate. `handback.md:10` now says `popup navigation`; the real test waits for a `popup`, clicks the explicit anchor, and asserts the popup destination at `e2e/tests/dashboard-next/comms-clickable-links.spec.ts:78-81`. It then proves the dashboard route and bubble metadata did not change at `:83-84`. The hermetic self-QA record reports the same routed-popup behavior and passing focused proof at `self-qa.md:22-33`.

The broader implementation and consumer conclusion remains unchanged: `dashboard/src/ui/LinkifiedText.tsx:16-95` remains the sole shared parser/tokenizer/anchor implementation, Timeline continues to use it only for message bodies and the two plain-text email views at `dashboard/src/routes/contact/Timeline.tsx:1035-1040,1506-1519`, and only loaded unmatched-email detail uses it outside Timeline at `dashboard/src/routes/email/UnmatchedRow.tsx:177-184`. The raw unmatched preview, original HTML-email sandbox, composers, transcripts, and metadata remain outside that renderer.

### New findings

No new severity-labeled findings. The prior PASS remains valid.

### Residual risk

The recorded raw full E2E result remains exit 1 for the separately attributed outbound-MMS viewer failure (`final-gate-adjudication.md:16-46`). This documentation correction neither hides nor changes that existing suite-health risk.
