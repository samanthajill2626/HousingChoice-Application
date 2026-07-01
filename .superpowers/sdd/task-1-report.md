# Task 1 Report — `Tour` entity + `toursRepo`

**Status:** DONE

---

## Files changed

| File | Action | Notes |
|---|---|---|
| `app/src/lib/tables.ts` | Modified | Added `tours` table + 3 GSIs (`byTenant`, `byUnit`, `byScheduledAt`) |
| `app/src/repos/toursRepo.ts` | Created | `TourItem`, `createToursRepo(deps)`, all 6 repo functions |
| `app/test/toursRepo.integration.test.ts` | Created | 10 integration tests, mirrors `unitsRepo.integration.test.ts` |
| `app/test/tables.test.ts` | Modified | Added `'tours'` to table list; added tours contract test |
| `app/test/genTables.test.ts` | Modified | Added `'tours'` to alphabetical Terraform key list; added tours Terraform shape test |
| `infra/envs/dev/tables.auto.tfvars.json` | Modified | `npm run gen:tables` auto-updated (15 tables) |
| `infra/envs/prod/tables.auto.tfvars.json` | Modified | `npm run gen:tables` auto-updated (15 tables) |

---

## TDD — RED → GREEN

**RED phase:** Tests written before the repo existed. Running them against a missing module would have produced import errors. Because the table creation is in `tables.ts` (consumed by `ensureTable` in `beforeAll`), the test would have also failed the `getTableSpec('tours')` call.

**GREEN phase:** Implemented `toursRepo.ts` and added the `tours` table spec to `tables.ts`. All 10 tests passed immediately on first run.

### Test run output (GREEN)

```
✓ create generates a tourId, stamps timestamps, and get reads it back  12ms
✓ get returns undefined for an unknown tourId  3ms
✓ create stores optional fields (groupThreadId, outcome, moveForward, convertible)  5ms
✓ listByTenant returns all tours for a tenant and none for others  16ms
✓ listByUnit returns all tours for a unit and none for others  9ms
✓ listByScheduledRange returns tours in window and excludes tours outside  16ms
✓ listByScheduledRange boundary: BETWEEN is inclusive on both ends  8ms
✓ patch updates fields and bumps updatedAt without touching other fields  5ms
✓ patch exit gate: sets outcome, moveForward, convertible  4ms
✓ patch throws ConditionalCheckFailedException for an unknown tourId  5ms

Test Files: 1 passed (1)
Tests: 10 passed (10)
Duration: 994ms
```

### Full app suite (no regressions)

```
Test Files: 117 passed | 1 skipped (118)
Tests: 1451 passed | 5 skipped (1456)
```

(1 skipped = `staticSmoke.test.ts` — no built dashboard; expected)

### Typecheck

```
npm run typecheck — all workspaces clean (0 errors)
```

---

## GSI design decisions

- **`byTenant`**: hash `tenantId`; no range key. Supports `listByTenant(tenantId)`.
- **`byUnit`**: hash `unitId`; no range key. Supports `listByUnit(unitId)`.
- **`byScheduledAt`**: hash `_schedPartition` (constant string `'tours'`); range `scheduledAt` (ISO 8601). Supports `listByScheduledRange(from, to)` via `BETWEEN`. Sparse: items without `scheduledAt` never index here (though `scheduledAt` is currently required in `CreateTourInput` — sparseness is a convention that allows making it optional later without a migration, e.g. for draft/cancelled tours).

---

## Key implementation notes

- `TourStatus = string` — Task 2 narrows this to a proper enum in `toursModel.ts`
- `status` defaults to `'scheduled'` in `create` when caller omits it
- `CreateTourInput = Partial<TourItem> & { tenantId, unitId, scheduledAt, tourType }` — mirrors `CreateUnitInput` pattern (not `Omit`) to satisfy TypeScript's spread-into-explicit-type assignment
- `patch` uses the same SET/REMOVE loop as `unitsRepo.update` (expression-aliased keys, null → REMOVE, undefined → skip)
- `ConditionalCheckFailedException` re-exported for callers
- `db-create.ts` was not modified directly — it iterates `TABLES` automatically; only `tables.ts` needed updating

---

## Concerns

None. The implementation is complete, clean, and follows existing conventions precisely.
