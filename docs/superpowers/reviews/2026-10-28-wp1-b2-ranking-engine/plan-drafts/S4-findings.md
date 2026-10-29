# S4 plan-draft findings (WP1 B2a, plan section 8)

Findings that need a planner ruling. Draft: `.superpowers/sdd/plan-draft-S4.md`.

## S4-F1. The prompt fingerprint leaves the schema out, so a schema-only change does not mark a match out of date

- Spec D4: "`promptFingerprint` = sha256 of the system text, recorded on
  every run." Spec D9's version rule marks a match out of date on a rubric
  version, examples version or model change - not on the prompt
  fingerprint.
- Extraction's fingerprint covers the system prompt AND the serialized
  schema, because both are sent on the same call and both define the
  contract (app/src/services/extraction/prompt.ts:202-219).
- For ranking the schema is not one constant: the flag-field enum grows from
  18 to 32 fields when `RANKING_LANDLORD_CARD` turns on (`flagFieldsFor`,
  draft S4.3), and a requirement key added to `REQUIREMENT_UNIT_KEYS`
  (app/src/lib/requirements.ts:115-117) flows into both enums
  automatically - changing what the model may answer without changing the
  system text, `RUBRIC_VERSION` or `EXAMPLES_VERSION`, so every stored match
  stays current. (Flipping the landlord switch changes every unit card
  fingerprint, so that case is covered by D13; a registry edit is not.)
- Draft's choice: the spec's text - the full 64-hex sha256 of the system
  text only (draft C1).
- Ruling needed: keep as written, or fingerprint the system text plus both
  serialized schemas (one constant, still recorded on every run; nothing in
  D9 reads it, so it matters to B2b and to whoever reads the run log).

## S4-F2. S5's draft calls S4 names S4 now provides, but `buildRankingPrompt` needs two fields S5's call does not pass

- S5's draft (its section 9, "What S5 needs from S4") codes against
  `buildRankingPrompt({ direction, anchor, candidates, homes })`,
  `costUsd(model, usage, priceTable)`, `createRankingDriver(config, logger)`,
  `RankingCallMeta`, `RankingBatchInput` from `driverTypes.ts`, and a
  `ParsedRanking` of `{ byHandle, droppedUnlawfulFlags }`.
- Draft's choice (draft C12): S4 provides every one of those names and
  shapes (`buildRankingBatch` stays the core builder the counterfactual
  script uses). `buildRankingPrompt` REQUIRES `batchIndex` (the console
  driver logs it) and `landlordCard` (it picks the schema's flag-field enum
  and the unlawful-flag parse rule, spec D5) - neither is derivable from
  S5's four arguments, and a default of `false` would silently use the
  wrong schema and drop valid `landlord:` flags whenever the switch is on.
- Ruling needed: S5's `runBatch` call gains `batchIndex: index` and
  `landlordCard: deps.config.rankingLandlordCard` (one line each).
