### Task 1: Declare the canonical kind type without runtime activation

**Files:**
- Modify: `app/src/adapters/extraction.ts:73-81`

**Interfaces:**
- Consumes: the existing inline `ExtractionResult.typeSuggestion.value` union.
- Produces: the canonical `SuggestedContactKind` TypeScript union needed by the persistence, route, and dashboard-ready backend work.
- Activation boundary: this task must not change `EXTRACTION_SCHEMA`, `parseExtractionText`, `parseExtractionOps`, or the model prompt. Production extraction must still emit only Tenant or Landlord until Task 6, after the PATCH route and dashboard can honor every new value.

- [ ] **Step 1: Add the shared wire union only**

In `app/src/adapters/extraction.ts`, define and consume:

```ts
export type SuggestedContactKind =
  | 'tenant'
  | 'landlord'
  | 'property_manager'
  | 'partner';

export interface ExtractionResult {
  fields: Partial<Record<ExtractableField, ExtractionFieldOp>>;
  statusAdvance?: { suggest: boolean; reason?: string };
  typeSuggestion?: { value: SuggestedContactKind; reason?: string };
  // Preserve the remaining existing fields unchanged.
}
```

Do not touch the runtime schema, parser, raw-operation parser, or prompt in this task. The type widening is compile-time scaffolding only, so it has no behavioral red test and does not activate model output.

- [ ] **Step 2: Prove the declaration compiles without changing runtime output**

Run:

```powershell
npm run typecheck -w @housingchoice/app
npm run test -w @housingchoice/app -- test/extractionSchema.test.ts test/extractionOps.test.ts
```

Expected: both commands PASS. Confirm the existing schema enum and applicable parser still reject Partner and Property Manager at runtime; Task 6 owns the deliberate red/green activation of those paths.

- [ ] **Step 3: Commit the compile-time contract**

Run:

```powershell
git status --short --branch
git rev-parse -q --verify MERGE_HEAD
git add app/src/adapters/extraction.ts
git commit -m "refactor: define AI contact kind union" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

Expected: status lists only the adapter before staging; `MERGE_HEAD` prints nothing; the commit succeeds. This commit is behavior-neutral and must not be deployed as a claim that the new model output is active.

---

