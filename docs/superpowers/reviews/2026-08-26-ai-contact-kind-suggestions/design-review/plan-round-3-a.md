# Plan round 3 adversarial review

## 1. [HIGH] The D11 route drain calls an undefined verdict helper and never specifies the no-run behavior

**What is wrong**

Task 4's drain calls `stampTypeVerdictBestEffort(candidate, verdict)`, but neither
Task 2 nor Task 4 defines that helper, its dependencies, or its required guard for
a suggestion with no `runId`.  The existing route only calls `aiRuns.setVerdict`
after it has explicitly proved `pending.runId !== undefined`; D8 likewise limits
the originating-run verdict to rows with a run id.  A literal implementation
therefore either fails to compile, tries to pass an undefined run id to
`setVerdict`, or forces the builder to guess the finalization-marker options that
are central to D11 (`expectedVerdict`, exact `freshSuggestionCreatedAt`, actor,
and best-effort catch/logging).

**Evidence**

- The new drain invokes the nonexistent helper unconditionally after every
  successful guarded delete
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1083-1092).
- The helper appears nowhere else in the plan or repository; a repository search
  finds only that call.
- Current route code protects the run-id boundary and supplies the marker-safe
  options before calling `aiRuns.setVerdict`
  (app/src/routes/contacts.ts:1539-1558).
- D8 says a pre-write suggestion is stamped only when it has a run id
  (docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:244-247),
  while D11 requires legacy pending rows to remain compatible and defines
  finalization-marker ownership
  (docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:296-298,
  318-331).
- The proposed verdict tests seed `runId: 'run-kind'` in every displayed case
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:954-985), so
  they cannot expose the missing no-run guard.

**Implication**

The plan does not give an implementer a compilable, auditable verdict path for a
legacy/type row without a run, and it risks breaking the finalization handoff by
recreating the call with incomplete options.  Define the local helper (or inline
the existing guarded call): it must return without stamping when `runId` is
absent; otherwise call `setVerdict` with `target: 'type'`, `expectedVerdict:
'pending'`, the candidate's exact `createdAt` as `freshSuggestionCreatedAt`, the
route actor/time, and a catch/log boundary.  Add one no-run regression plus one
assertion that a routed delete uses those marker options.

## Attacked areas that held

- The new `sameSuggestionIdentity` contract correctly requires matching owner and
  target, treats immutable revision as authoritative only when both rows carry
  one, and otherwise uses exact `createdAt` plus present-or-absent `runId`
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:323-348).
- The plan now uses the same named `GuardedTypeDeleteResult` in Task 2 and Task 4
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:323-363,
  1065-1072), closing the prior undefined-result-type issue.
- The new prompt test pins all six D3 examples with their canonical outcomes and
  retains the property-manager and mentioned-caseworker disambiguations
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1589-1624).
- The route's initial post-write read, revision fence, and no-poll ownership
  boundary remain consistent with D11 after the identity-helper revision
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1039-1096).
