# Clickable communications links handback

## Scope delivered

| Work item | Result |
| --- | --- |
| S1 | Shipped `LinkifiedText`, using exact `autolinker@4.1.5` parse matches and a final safe HTTP(S) destination check. The renderer produces React text and anchors, never parser HTML. It keeps source punctuation and full URL destinations, maps bare public domains and protocol-relative targets to HTTPS, rejects unsafe schemes, bare local hosts, single-label hosts, and fuzzy IPs. |
| S2 | Shipped body linkification for Timeline SMS, MMS, Relay, native-group, and email content. Sender attribution and non-interactive email preview rows remain intact. A clipped URL snippet keeps its full anchor destination; whitespace-only clipped content renders as `...`. |
| S3 | Shipped linkification only in the opened unmatched-email body. Closed rows remain non-interactive and cannot contain nested anchors. |
| E1 | Added the real-browser communications-links E2E proof, covering anchor behavior, punctuation, popup navigation, and message-bubble behavior. The focused E1 test passed. |
| E2 | Completed dependency proof, focused proof, review/fix/re-review, hermetic self-QA, main synchronization, and final gate adjudication. |

## Parser and dependency decision

The final design uses `autolinker@4.1.5`, not `linkifyjs` or `linkify-react`.
The production component calls only the parser API with URL matching enabled and
email, phone, mention, and hashtag matching disabled. It does not use the HTML
renderer. The tracked design and dependency records include the exact Windows
clean-install, Linux ARM64 import/install, lifecycle, license, and audit
evidence.

## Focused proof

- Safe linkifier test: 23 tests passed after the final fix wave.
- Focused dashboard suite: 9 files and 246 tests passed.
- Focused E1: 1 passed in 15.5 seconds.
- Follow-on inbox communications proof: 1 passed in 15.1 seconds.
- Dashboard typecheck and production build: exit 0.

## Review and resolutions

Implementation conformance and plan-blind adversarial review found four
must-fixes. The fix wave resolved the E1 cleanup, malformed-scheme source
admission, added-line ASCII, and tslib license evidence findings. Cold
re-review returned PASS with no new must-fixes. The records are
`implementation-conformance.md`, `implementation-adversarial.md`,
`implementation-review-adjudication.md`, and `fix-wave-rereview.md` in this
directory.

## Self-QA

A hermetic session confirmed the local dashboard identity (`dev: true`, lane
8, commit `f065942a`) and was stopped cleanly. No connected browser binding
was available for free-form driving, so the self-QA record names that
limitation and uses the real E1 browser test plus the follow-on inbox test as
the direct browser proof. See `self-qa.md`.

## Final gate evidence

The local `main` commit `d4298abe` was merged once at `d7bd29e0`; the feature
branch is 0 commits behind local `main`.

- `npm run typecheck`: exit 0.
- `npm test`: exit 0. App: 359 files / 6741 tests; dashboard: 188 / 3030;
  e2e unit: 20 / 496; fake Twilio: 34 / 245; fake Twilio web: 13 / 111.
- `npm run smoke`: exit 0; 1396 import specifiers across 246 emitted files
  resolve under plain Node.
- `npm run e2e`: exit 1, 266 passed and 1 failed in the unmodified
  outbound-MMS viewer spec. The same file passed twice in isolation (6/6 in
  46.1 seconds and 44.9 seconds), while the file also fails at original base
  on a documented historical viewer-scroll assertion (5 passed / 1 failed).
  The full-suite-only trigger-visibility result is tracked in
  `docs/issues/outbound-mms-viewer-trigger-visibility-full-suite.md`.
- Touched-file ESLint: raw exit 1 for one `Timeline.tsx`
  `react-hooks/set-state-in-effect` finding. The exact finding exists at the
  original base, so the touched-line ratchet has no new errors.

`final-gate-adjudication.md` records the full raw outputs and attribution. It
does not label either raw red command green.

## Change inventory

Runtime changes are confined to the shared linkifier, Timeline, unmatched-email
renderer, Autolinker manifest/lock update, and their tests. E2E adds the
communications-link proof. The remaining branch changes are approved spec,
plan, review, dependency, self-QA, gate, and handback records. The original
base-to-branch delta is 5172 additions and 139 deletions across 59 files,
including the one-time main sync; the feature-only delta against the
synchronized main merge base is 4008 additions and 11 deletions across 43
files.

## Branch condition

The implementation is ready for human merge review with the explicitly
recorded non-feature E2E and baseline-lint evidence above. It remains unmerged.
No deployment, infrastructure, environment, or post-merge operation is owed.
