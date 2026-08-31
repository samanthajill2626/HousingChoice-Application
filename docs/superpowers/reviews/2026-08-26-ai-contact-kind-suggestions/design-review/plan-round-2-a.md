# Plan round 2 adversarial review

## 1. [HIGH] Task 4 names types and an identity helper that neither Task 2 nor the repository defines

**What is wrong**

The revised drain pseudocode cannot be implemented literally.  Task 2 exports
`GuardedTypeDeleteResult`, but Task 4 annotates its local result as
`DeleteTypeSuggestionResult`.  Neither the plan nor the current repository
defines that latter name.  The same drain then calls `sameSuggestionIdentity`,
which also does not exist and has no prescribed implementation or import.  This
is not cosmetic: that helper decides whether a deleted row receives `accepted`
or `superseded_by_human_edit`, including the legacy absent-revision/runId
fallback required by D11.

**Evidence**

- Task 2 declares the sole result union as `GuardedTypeDeleteResult` and uses it
  in the repository method signature
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:291-315).
- Task 4 instead declares `let result: DeleteTypeSuggestionResult` and calls
  `sameSuggestionIdentity(candidate, pendingTypeBefore)`
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1020-1042).
- A repository-wide search finds neither `DeleteTypeSuggestionResult` nor
  `sameSuggestionIdentity` outside this plan; current exact identity handling is
  embedded in `deleteSuggestionIfCurrent`, not exported as a reusable helper
  (app/src/repos/extractionRepo.ts:667-694).
- D11 requires exact immutable suggestion revision, with legacy `createdAt` plus
  present-or-absent `runId` fallback, for the cross-table delete/fencing protocol
  (docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:339-350).

**Implication**

The Task 4 implementation fails typecheck unless the builder invents names and
identity behavior.  More dangerously, a casually implemented identity comparison
can stamp a post-write replacement as accepted.  Name one exported result type
consistently and prescribe/create a shared `sameSuggestionIdentity` helper with
the exact current revision-first, legacy fallback semantics and focused unit
tests before the route step.

## 2. [MEDIUM] The activation prompt tests do not pin the tenant self-housing example required by D3

**What is wrong**

Task 6 says it will pin the four mutually exclusive kinds and all six D3 examples,
but its proposed prompt assertions never include the required self-housing tenant
example, `I am looking for a two-bedroom home for my family`, or an equivalent
Tenant outcome.  The only tenant-adjacent asserted phrase is the caseworker
mention; its assertion also does not require the word `Tenant`.  A rewritten
prompt can therefore retain the owner/manager/caseworker strings while dropping
the direct household-seeker rule, and all listed prompt assertions still pass.

**Evidence**

- D3 explicitly defines the direct household-seeker example as Tenant
  (docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:127-136),
  and the testing section requires the prompt contract to pin the relevant
  classifications (docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:525-532).
- Task 6 requires all six examples in prose
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1597-1615),
  but its actual red test lists owner, property-manager, caseworker, mentioned
  caseworker, and ambiguous-client phrases only
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1541-1564).

**Implication**

The model contract can regress to treating a clear tenant as merely an
unclassified external contact without a failing focused test.  Add an explicit
Tenant self-housing assertion and pair each of the six examples with its expected
canonical label or `none`, rather than testing only the presence of fragments.

## Attacked areas that held

- The prior activation-order finding is actually resolved: Task 1 is now
  type-only, while runtime schema/parser/prompt activation is gated until after
  Tasks 2-5 build the writers and consumers
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:55-114,
  1464-1475).
- The route now has an initial post-write consistent read when the pre-write
  snapshot is absent and catches pre-read, drain-read, and delete failures at the
  existing best-effort boundary
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:969-1047).
- The exact raw Property Manager comparison is correctly retained; leading,
  trailing, and whitespace-only roles are covered as unsupported rather than
  trimmed into the preset (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:775-849).
- The fixed post-write-read boundary correctly leaves a row published only after
  that read to the extraction writer, avoiding unsound polling by the route
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1047).
