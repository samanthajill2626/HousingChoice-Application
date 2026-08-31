# Task 1 review - canonical AI contact-kind union

## Verdicts

- SPEC-CONFORMANCE: PASS
- TASK-QUALITY: APPROVED

## Findings

No findings. Finding count: 0.

## Evidence reviewed

The committed S1 diff is limited to `app/src/adapters/extraction.ts` (commit
`e8100f3e`; `git diff-tree --name-status` reports that file only). It adds the
exported `SuggestedContactKind` at `app/src/adapters/extraction.ts:73-77` with
the exact four canonical wire values (`tenant`, `landlord`,
`property_manager`, and `partner`), and consumes it only at
`app/src/adapters/extraction.ts:82`. This meets the task brief
`.superpowers/sdd/2026-08-26-ai-contact-kind-suggestions/task-1-brief.md:16-25`
and the S1 worklist contract at `.superpowers/sdd/worklist.md:27-31`.

The diff contains no `ContactType` declaration or substitution. Thus
`property_manager` is correctly a suggestion wire value, not a contact base
type.

## Attacked-but-held checks

- **Runtime activation:** Held. The production structured schema remains
  Tenant/Landlord-only: `app/src/services/extraction/schema.ts:119-126` still
  enumerates `tenant`, `landlord`, and `none`; the parser at
  `app/src/services/extraction/schema.ts:244-251` still accepts only Tenant or
  Landlord into `ExtractionResult`. The S1 commit did not modify this file.
- **Raw-operation activation:** Held. The unchanged raw-operation view at
  `app/src/services/extraction/schema.ts:423-429` continues to expose a
  non-sentinel string merely as an attempted suggestion for diagnostics; the
  S1 diff has no parser change and therefore does not enable new real-model
  values.
- **Prompt activation:** Held. The unchanged model instruction at
  `app/src/services/extraction/prompt.ts:65-69` permits type suggestions only
  for Tenant or Landlord. The prompt is not in the commit file set.
- **Indirect fake-driver activation:** Held. `app/src/adapters/extractionFake.ts:84`
  already casts marker JSON to `Partial<ExtractionResult>` and spreads it into
  the result; the S1 commit neither changes the fake protocol nor introduces a
  new marker/source. The widened declaration makes future typed fake payloads
  representable but changes no runtime code or real-model output path.
- **Scope and hygiene:** Held. The reviewed commit changes one permitted file,
  adds only ASCII lines (`git diff --check` clean; all seven added lines are
  ASCII), and introduces no dependency, seed, import, infrastructure, or
  backfill change. The worktree is clean at review.

## Verification evidence

No tests were run by this read-only reviewer. The implementer report records
`npm run typecheck -w @housingchoice/app` exit 0 and the two specified focused
test files passing (41 tests); this is appropriate compile-only task evidence,
not independently re-executed here.
