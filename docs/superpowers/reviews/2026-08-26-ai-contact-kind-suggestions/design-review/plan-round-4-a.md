# Plan round 4 adversarial review

Reviewed the full plan at commit `7c10079d` against the approved specification and
the adjudications through plan-review round 3. This is a fresh literal-execution
review, including the revised no-run marker path, identity helper, activation order,
Property Manager resolver, revision fence, races, TDD claims, and commands.

## Findings

### 1. [MEDIUM] Task 4 redeclares the existing route verdict clock

**What is wrong:** Step 9 tells the builder to retain the existing generic
non-type cleanup loop, and Step 10 then instructs them to introduce
`const verdictAt = new Date().toISOString()` after `contacts.update`. The existing
PATCH handler already declares that same block-scoped constant immediately before
the retained generic loop. Executing both instructions literally produces a
TypeScript redeclaration error; deleting the old declaration instead is an
unstated builder inference.

**Evidence:** The plan says to keep the existing `pendingByField` generic cleanup
for non-type fields at
`docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1044`, and its
new Step 10 snippet declares `verdictAt` at
`docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1051-1054`.
The existing retained route scope has
`const verdictAt = new Date().toISOString()` at
`app/src/routes/contacts.ts:1529-1532`, and its generic AI-run stamp consumes that
binding at `app/src/routes/contacts.ts:1550-1555`.

**Implication:** The Task 4 implementation instructions are not directly
compilable. State that Step 10 reuses the existing `verdictAt` binding (or move the
one existing declaration once, with both the generic non-type loop and new type
drain sharing it). The focused route/typecheck gates would catch the result, but
the plan should not require a builder to resolve the contradiction by guessing.

**Design impact:** Precision only. This does not change any approved decision,
ownership boundary, or race protocol.

## Attacked areas that held

- **Legacy no-run cleanup and marker options:** The new drain only calls
  `aiRuns.setVerdict` when `candidate.runId !== undefined`, while preserving safe
  guarded deletion for a legacy row; it supplies the target, expected pending
  marker, exact candidate `createdAt`, actor, and route time at
  `docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1091-1114`.
  This matches the actual optional marker contract at
  `app/src/repos/aiRunsRepo.ts:110-115`, and the plan now has explicit no-run and
  marker-option assertions at
  `docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:993-1009`.
- **Identity helper ownership:** `sameSuggestionIdentity` is defined once in Task
  2 with the required revision-first and legacy exact fallback at
  `docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:328-348`, and
  Task 4 consumes that exported contract rather than inventing another identity
  comparison at `docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1091-1093`.
- **Property Manager semantics:** The planned backend resolver checks the raw
  exact persisted role and explicitly rejects every other non-empty role,
  including whitespace variants, at
  `docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:875-898`.
  That is consistent with the full-kind comparison required by spec D8,
  `docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:218-240`.
- **Activation ordering:** Runtime schema/parser/prompt activation remains Task
  6 and is explicitly gated on Tasks 2-5 at
  `docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1543-1546`;
  the plan does not repoint real model output before persistence, route, and UI
  consumers exist.
- **Revision and post-write drain contract:** The plan bases the drain on the
  revision returned by `contacts.update`, uses post-write consistent reads, a
  bounded reread loop, and a no-poll extraction-writer handoff at
  `docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1046-1118`.
  Its stated committed-revision boundary agrees with the adjudicated D11 policy;
  no new contradiction was found.
- **TDD and focused commands:** The revised no-run and marker-option behaviors
  are observable in the Task 4 red tests before their implementation steps
  (`docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:950-1019`).
  The Task 6 prompt examples each assert both the phrase and expected outcome at
  `docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1607-1646`.

## Verdict

One MEDIUM precision defect remains. It does not change an approved design
decision, but the plan is not yet safe for a no-context builder to execute
literally until it resolves the duplicate `verdictAt` declaration.
