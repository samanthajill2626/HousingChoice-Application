// app/src/lib/seedData.ts — thin re-export from the seed/ module.
//
// All seed data and logic now live under app/src/lib/seed/:
//   seed/lean.ts      — the canonical SEED map (lean profile fixtures)
//   seed/cast.ts      — extended cast personas (Task 3)
//   seed/matrix.ts    — cross-entity story snapshots (Task 2)
//   seed/live.ts      — runtime-timestamp items (Task 4)
//   seed/index.ts     — seedAll(), seedInboundVoiceLineHolder(), constants
//
// This file is kept for back-compat so devReset.ts, db-seed.ts, and existing
// tests can all import from './seedData.js' without change.
//
// Full spec: .superpowers/sdd/task-1-brief.md and seed-research.md.
export {
  SEED,
  seedAll,
  seedInboundVoiceLineHolder,
  SEED_INBOUND_VOICE_CELL,
  LOCAL_DEFAULT_ENDPOINT,
} from './seed/index.js';
export type { SeedProfile } from './seed/index.js';
