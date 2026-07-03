# Task 1 Report — seed/ module skeleton + profiles + holder-stamp fold-in

**Status:** COMPLETE — all gates green.

## Files changed
- `app/src/lib/seed/index.ts` — NEW: `seedAll(endpoint, profile='lean')`, `seedInboundVoiceLineHolder`, `SEED_INBOUND_VOICE_CELL`, `LOCAL_DEFAULT_ENDPOINT`, `SeedProfile` type
- `app/src/lib/seed/lean.ts` — pre-existing; no drift found
- `app/src/lib/seed/cast.ts` — task comment corrected: Task 2 → Task 3
- `app/src/lib/seed/matrix.ts` — task comment corrected: Task 3 → Task 2
- `app/src/lib/seedData.ts` — rewritten as thin re-export from `./seed/index.js`
- `app/scripts/db-seed.ts` — profile via `SEED_PROFILE` env; one log line names profile
- `scripts/dev.mjs` — `runTsx()` gains optional `extraEnv={}` param; `--seeded` path passes `{ SEED_PROFILE: 'full' }` to db-seed only
- `app/test/seedProfile.integration.test.ts` — NEW: 4 profile-contract tests (lean count, lean items present, holder stamped, full ⊇ lean)

## lean.ts fidelity
No drift found. `lean.ts` is byte-equivalent to the SEED object in the original `seedData.ts` — same IDs, fields, timestamps (T0/T1/T2), MATCH_EXPIRES_AT, and all comments.

## Test summary
- `npm test -w @housingchoice/app -- test/seedData.test.ts`: 11/11 passed (unchanged)
- `npm test -w @housingchoice/app -- test/seedProfile.integration.test.ts`: 4/4 passed
- Full app suite: 128 passed, 1 skipped (S3/MinIO not running — expected), 0 failed
- Scripted proof: `SEED_PROFILE=full npx tsx app/scripts/db-seed.ts` → exit 0, holder stamped; bare `npx tsx app/scripts/db-seed.ts` → exit 0, holder stamped

## Concerns
- `devReset.ts` still calls `seedInboundVoiceLineHolder` separately after `seedAll`. Because `seedAll` now folds in the holder stamp, this is a harmless double-stamp (the second call overwrites `cell_verified_at` with a slightly later ISO timestamp — per the plan, this is acceptable and intentional).
- The `cell_verified_at` field set by the holder stamp is NOT byte-stable (uses `new Date().toISOString()` as default) — this is pre-existing behavior carried forward verbatim.
