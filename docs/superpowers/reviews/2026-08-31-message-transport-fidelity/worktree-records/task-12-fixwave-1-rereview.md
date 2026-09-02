# Task 12 fix wave 1 rereview

## Verdict

PASS / CONFORMS. Cold review of `6feb30f0` against `665fa7e0` found no new P1,
P2, or P3 issue in the assertion correction.

## Fresh state sweep

- `message-transport-fidelity.spec.ts:91-101` scopes each transport assertion to
  the revealed bubble and requires the complete visible transport segment ending
  in ` - `. A label beginning `RCS -> ...`, `MMS -> ...`, or `SMS -> ...` cannot
  satisfy its requested-only or agreement assertion.
- Pending callback proof is non-vacuous: the fixture is versioned requested-RCS
  only (`:119-128`), the visible pre-callback bubble is required to be `RCS - `
  and to contain no `RCS -> ` transition (`:257-259`), then the signed real
  provider callback is posted and the same bubble is required to become
  `RCS -> SMS - ` (`:260-267`). A premature fallback fails before the callback;
  an absent or wrong post-callback fallback fails after it.
- The incomplete per-recipient fixture (`:156-179`) now requires requested-only
  `RCS - ` and no transition (`:276-277`), in addition to the existing no-Mixed
  and two-visible-recipient proof (`:278-281`). The complete mixed case remains
  separately pinned to `RCS -> Mixed - ` and one RCS plus one RCS-to-SMS recipient
  (`:269-274`).
- The actual-equals-requested direct optimistic state (`:333-348`) and native
  Group MMS state (`:354-359`) both require their exact initial label and reject
  a transition. The direct case still proves a real fake-provider outbound send
  before its post-refetch assertion; its intentional one-shot route hold is the
  existing synchronization control, not a hidden mock or retry.
- The excluded row check is repaired at `:302-306`: the accessible listitem name
  must start with the fully escaped formatted phone followed by ` - `. A visible
  excluded row has that renderer-guaranteed separator (`Timeline.tsx:1101-1108`),
  while the state-absent and opted-out control rows remain required at `:292-301`.
  This cannot silently pass because of the former template-string U+0008.

## Renderer and selector check

`Timeline.tsx:836-851` emits the bubble metadata as
`transport - number - time`; `messageTransport.ts:96-108,129-131` emits exactly
the requested-only, aggregate, agreement, and fallback forms asserted here.
The recipient disclosure is conditionally rendered only after the bubble click
(`Timeline.tsx:1054-1076`), so the bubble-local `getByText` checks the displayed
metadata rather than an invisible list. Recipient assertions remain
accessibility-first `getByRole('list'/'listitem', { name })` selectors.

## Prior findings and adjudication

- Exact transport P2: closed. The shared helper's old prefix acceptance is gone;
  all required requested-only/agreement sites have negative transition proof, and
  the callback retains a distinct post-callback fallback assertion.
- Excluded-recipient P2: closed. The selector now uses a literal ` - ` delimiter,
  matching the accessible-name contract instead of a mis-escaped `\\b`.

## Verification boundary

No E2E command was started: `e2e/.artifacts/lane.json` and `session.pid` identify
an active lane-10 interactive/self-QA session (launcher PID `71704`), and project
guidance forbids a reviewer from starting a competing suite. This review used the
exact commit diff plus static renderer/selector reachability checks only.
