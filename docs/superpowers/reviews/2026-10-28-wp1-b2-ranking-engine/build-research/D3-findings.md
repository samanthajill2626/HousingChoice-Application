# D3 findings - S3 Pool and cards (S3.1-S3.12 and the Published shapes)

- Reader: D3 (read-only delta reader, B2a build Phase 1).
- Scope: plan section 7, S3 "Pool and cards": the Published shapes block S4-S6
  code against, contradictions C1-C10, the assembly / review-round notes, the
  cross-slice notes, and tasks S3.1-S3.12 - types.ts, cardFields.ts and the
  classification test, pairHistory.ts, seenSet.ts, seenFeedback.ts, pool.ts,
  cards.ts, completeness.ts, fingerprints.ts, assemble.ts, the shared fixtures
  and the B1 reader-test widening. Spec D1, D2.1-D2.5, D3, D13; watch items
  WI4 (S3 half), WI8, WI11, WI12, WI20.
- Read: plan lines 1-590 (binding) and 10010-16251; the S1 / S2 text S3
  consumes (S1.6 ContactItem stamp, S1 parser and importer edits, S2.3
  completeness, S2.4 / S2.5 repo signatures, S2 AppConfig fields); spec
  D1, D2, D3, D13 and section 6. Code: contactsRepo.ts (ContactItem,
  isDeleted, IncompleteBatchReadError, ListContactsOpts, getManyByIds,
  listByType), unitsRepo.ts (UnitItem, ListUnitsOpts, getById), toursRepo.ts,
  listingSendsRepo.ts (+ DeclineRecord), orgListRepo.ts, services/orgNames.ts,
  lib/orgNames.ts, requirements.ts, unitFields.ts, blastAudienceRules.ts,
  propertyLabel.ts, contactName.ts, smsCompliance.ts, config.ts tableName,
  extraction/schema.ts PROVENANCE_FIELDS, tenantMatchingInputs.ts,
  audienceResolution.ts, the four seed modules + seed/index.ts, the writer
  sources the classification test scans, test/helpers/orgFixtures.ts, the B1
  reader test, dashboard authorityPrefill.test.ts, app vitest config and
  globalSetup, eslint.config.mjs, tsconfig.base / test.
- Method beyond reading (scratch only, outside the worktree; details in
  `.superpowers/sdd/research/D3-reference.md`): every S3 code block extracted
  from the plan with S3.5 / S3.7 / S3.11's own replace-and-append steps
  applied (all six anchors byte-exact, each unique); S2's published additions
  stubbed (completeness, the five AppConfig fields, getManyByIds,
  hasActivePlacementForOtherTenant); type-checked with the repo's options
  (tsc 5.9.3), run with the installed vitest 3.2.6 (no DynamoDB), linted with
  the repo eslint config, ASCII-swept; the seed worlds and the five writer
  scans re-run against the tree.
- Verdict: build-ready as written - 0 BLOCKER, 0 MAJOR, 5 MINOR. All 23 S3
  files compile with zero errors, lint clean, are ASCII, and all 12 test files
  / 165 tests pass as written (every hand-worked value holds); the registries
  classify every declared key, writer key and seed-world attribute.

## Findings

### D3-1 (MINOR) - two S3 texts still describe PR29's unlawful-flag grouping that PR40 withdrew

- Plan: S3.1 cardFields.ts, the `requirementItemOfField` doc comment
  (plan 11436-11443: "which is how capOf matches an accommodation or an
  unlawful flag on any key of the item"); S3 Cross-slice notes, the S4
  schema / cap bullet (plan 10499-10501: "so `capOf` matches an accommodation
  or an open unlawful flag on any key of the failed key's item").
- Fact: PR40 (plan 543-547) limits item grouping to ACCOMMODATION flags; an
  unlawful flag lifts only a failed key on its own field. S4's `capOf`
  already follows PR40 (plan 16912-16920: items for accommodations,
  `unlawfulFields.has(key)` per field).
- Problem: comment / handoff drift only - S3 builds no cap, and S4's binding
  text is right - but the shipped comment in cardFields.ts would state the
  withdrawn rule.
- Correction: reword both to "an ACCOMMODATION flag on any key of the item
  (PR29 as amended by PR40, PR45); an unlawful flag matches only its own
  field, `landlord:<key>` read as `<key>`". Comment-only.

### D3-2 (MINOR) - S3.4's pool.ts commits an unused import

- Plan: S3.4 pool.ts import (plan 12625) brings in `voucherSizeMatches`; no
  S3.4 function calls it (first calls: S3.5 propertyPool / tenantPool, plan
  13310 and 13328).
- Problem: the S3.4 commit is lint-dirty (`@typescript-eslint/no-unused-vars`)
  until S3.5. tsc is unaffected (no noUnusedLocals) and S3.12's lint is clean
  (verified), so no gate fails.
- Correction: none needed. Do NOT trim the S3.4 import: S3.5's quoted "old"
  import block (plan 13082-13090) must match S3.4's byte-exact (it does). An
  implementer who lints at S3.4 should expect this one message.

### D3-3 (MINOR) - `notes_updated_at` is listed as an undeclared key, but S1 declares it

- Plan: S3.1 `UntypedTenantKey` (plan 11150 comment "attributes the stores
  carry that ContactItem does not declare"; plan 11172 `| 'notes_updated_at'`).
- Fact: S1.6 adds `notes_updated_at?: string;` to ContactItem (plan 2179).
- Problem: precision only - the union de-duplicates, so it compiles (proved
  with a probe that declares both S1's key and a new key: only the new key
  fails, TS1360 at the `satisfies` and TS2741 at TENANT_CARD_FIELDS). The
  plan's own note (plan 11471-11476) anticipates this.
- Correction: drop `| 'notes_updated_at'` from UntypedTenantKey (its
  TENANT_BASE_FIELDS entry stays, now through KnownKeys), or leave it; either
  compiles.

### D3-4 (MINOR) - the IR7 display names almost every full-world property "a property with no address on file"

- Plan: `propertyDisplay` (plan 15805-15807) and `SeenHome.label` (plan 12172)
  fall back to NO_ADDRESS_LABEL when `propertyLabel` gives nothing; C5
  (plan 10356-10363) and PR23 justify this as "legacy dev units may too".
- Fact: `propertyLabel` returns undefined for any plain-string address
  (app/src/lib/propertyLabel.ts:59-60). In the full seed world 57 of 60 units
  store a plain string (every lean, cast and matrix unit; only unit-live-a/b/c
  are structured); 12 of the 13 available units are strings. Every other staff
  surface shows such an address as stored
  (dashboard/src/routes/contact/format.ts:97-99 `formatAddress`). The importer
  writes a parsed structured address (app/src/lib/import/apply.ts:1487), so
  production imports are not affected; the hermetic e2e builds its fixtures
  through the API (WI19), so S7 is not affected either.
- Problem: not a build or gate failure. In the demo world the Rankings page
  (anchor, rows, seen homes) would show the placeholder for properties whose
  address every other page shows - a self-QA or demo surprise, wider than C5
  describes.
- Correction (planner's call; IR7 / PR23 stand unless changed): either record
  it in the S3 report and handback as a known demo-world effect, or let
  `propertyDisplay` (display only) return the trimmed legacy string before the
  placeholder. The attach step must keep using `attachLabel` only (PR23 is
  unaffected either way).

### D3-5 (MINOR) - C4 says the spec does not name `caseworker`; it does

- Plan: C4 (plan 10348-10353) "two tenant attributes the spec's lists do not
  name: `move_in_date` ... and `caseworker`".
- Fact: spec D2.1 excludes `caseworker` by name (spec line 249, "other
  people"). The registry (plan 11232) and the tests are right.
- Correction: record-wording only; `move_in_date` alone is the unnamed seed
  attribute (it is the only `unclassifiedKeys` result, as S3.1 pins).

## Checked and fine

- Declared keys: ContactItem has 65 at @404e039d (66 after S1) plus the four
  matching inputs through `extends TenantMatchingInputValues`; UnitItem 51.
  TENANT_BASE_FIELDS = (declared minus the four) + UntypedTenantKey exactly;
  PROPERTY_CARD_FIELDS = declared + UntypedUnitKey exactly (56). Lists in the
  reference file.
- `KnownKeys` strips the index signature and keeps the mapped-type keys; both
  `satisfies` clauses enforce source 1 (probe: a new declared key fails
  typecheck).
- Seed worlds (lean and full, FIXED_NOW): every tenant and unit attribute is
  classified; `move_in_date` (matrix.ts:542) is the one unclassified key;
  nothing the plan misses.
- The five writer scans (contacts parsers, importer contact and unit, public
  sign-up, WRITABLE_FIELDS + tombstones): every slice anchor exists, every
  minimum set is found, nothing unclassified; S1's `notes_expected_updated_at`
  (plan 2749) and importer stamp (plan 2457) stay classified.
- B1 reader test: the replacement keeps B1's ten READERS byte-identical;
  RED is ENOENT from `readdirSync` as stated; no S3 source spells a matching
  input key (grep 0 in all ten files); no S4-S6 source block spells one
  either (S5's spellings are in test files), so the widened scan will not trip
  later slices; examples.ts is the only exemption.
- Names / signatures / imports all resolve with `.js` under NodeNext:
  createLogger({ level }), OrgEntry, IncompleteBatchReadError(unprocessed,
  requested, table), ContactsPage, ListContactsOpts, ListUnitsOpts, UnitsPage,
  ShareLedgerEntry / DeclineRecord shapes, OrgListItem.settingId 'org-list',
  TourItem fields, orgFixtures ATLANTA/AUGUSTA/DCA/VASH/STEP_UP/orgEntry,
  FLYER_SHARE_KEY, propertyLabel / labelMatches, contactDisplayName,
  hasSmsConsent, checkScalarWrite / normalizeOrgText, bedroomSizesOfFilter /
  voucherSizeMatches, acceptedVoucherSizes / authoritiesOf, unitItemValue /
  landlordItemValue / isItemBlank / itemOfUnitKey / REQUIREMENT_ITEMS /
  REQUIREMENT_*_KEYS, PROVENANCE_FIELDS, createOrgNamesService({ orgListRepo,
  logger }), the six repo factories, tableName prefixing.
- S2 contract consumed: AppConfig field names and types (rankingPoolWindowDays,
  rankingMaxPool, rankingReadConcurrency, rankingSeenMax, rankingLandlordCard),
  `getManyByIds(unitIds, { requireComplete: true })` (soft-deleted units
  answer), `hasActivePlacementForOtherTenant(unitId, tenantId)`,
  `completeness: boolean` on the list - all match S3's use.
- Hand-worked values: all 165 cases pass as written (voucher clamps, parity
  cases, window edges, bucket edges, label folding, propertiesSeen order and
  bound, FB21 notes, card key order, facts, missing order, mergeMissing,
  WI11 cases, assemble shapes, concurrency 2). No S3 test asserts a literal
  hash (only equality, inequality and /^[0-9a-f]{64}$/).
- Dashboard prefill parity: the four entries and five cases are verbatim
  (authorityPrefill.test.ts:23-74); the list-unknown case has no server twin,
  as the test comment says.
- RED claims: S3.1 (unresolved import + ENOENT), S3.2-S3.4 / S3.6 / S3.8-S3.10
  (missing module), S3.5 / S3.7 / S3.11 (missing named exports read as
  undefined under vitest, every case calls one) all fail for the stated
  reason; each GREEN needs nothing a later task adds.
- Gates: lint 0 errors / 0 warnings on the 23 files; typecheck 0 errors in
  S3 files; ASCII 0; smoke-safe (relative `.js` imports, no directory import,
  no runtime cycle - pairHistory -> seenSet is type-only); no new user-facing
  message-catalog copy (the strings are staff UI / API text).
- WI4: `notes_updated_at` exclude, pinned twice. WI8 as above. WI11: six
  "no change" and four "change" named cases, all green. WI12: the grep
  matches exactly `propertyCard` and `tenantCard`. WI20: the tenant pool
  checks `hasActivePlacementForOtherTenant(unitId, anchor.contactId)` after
  the size / authority filter (placementChecks as the tests expect).
- PR16 / FB4, PR17, PR20, PR21, PR23, PR33, PR38 / PR43, IR7-IR9, FB19-FB21,
  R2F10 are implemented as ruled; the Published shapes match the code; S5 /
  S6 consume `rankingAnchorExists`, `createAssembleDeps`,
  `poolTooLargeMissing`, `sortRecencyAt` (cast to ContactItem at the use
  site) under the published names.
- Cited lines in C1-C10 and the "Cites verified" list match the tree (within
  a line or two: parseVoucherExpirationDate is :388).
- S3.12: the diff expectation (23 paths) matches what S3 creates; the ASCII
  glob `app/test/ranking*.test.ts` also sweeps S2's five `rankingRuns*` tests
  (harmless).
