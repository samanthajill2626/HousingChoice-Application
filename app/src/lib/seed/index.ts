// seed/index.ts — profile-aware seeding entry point.
//
// seedAll(endpoint, profile) writes seed items to DynamoDB Local (never AWS).
// - 'lean' (default): writes exactly the canonical SEED fixtures (byte-identical
//   on re-runs; same PutCommand idempotency as the legacy seedData.ts runner).
//   Also stamps the inbound-voice-line holder (both profiles; idempotent).
// - 'full': lean + castItems() + matrixItems() merged in; then seedLive() + seedMedia().
//
// The holder stamp is folded into both profiles so devReset's separate
// seedInboundVoiceLineHolder call remains a harmless no-op double-stamp.
//
// See app/src/lib/seedData.ts (thin re-export) and .superpowers/sdd/ for the
// full spec / task breakdown.
import { PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createDocumentClient } from '../dynamo.js';
import { tableName } from '../config.js';
import { HOLDER_POINTER_KEY, type UserItem } from '../../repos/usersRepo.js';
import { SEED } from './lean.js';
import { castItems } from './cast.js';
import { matrixItems } from './matrix.js';
import { seedLive } from './live.js';
import { seedMedia } from './media.js';
import { historyItems } from './history.js';

export { SEED } from './lean.js';

export const LOCAL_DEFAULT_ENDPOINT = 'http://localhost:8000';

/**
 * The inbound-voice-line holder cell the LOCAL dev/e2e stack seeds. A FAKE E.164
 * that only means anything against fake-twilio — hardcoded here, with NO env var
 * behind it (the deprecated `FOUNDER_CELL` was removed). The e2e specs reference
 * this same value as the seeded holder cell.
 */
export const SEED_INBOUND_VOICE_CELL = '+15550000001';

/**
 * LOCAL dev/e2e convenience: stamp the founder/admin user as the inbound-voice-line
 * HOLDER so inbound-bridge e2e tests pass without a manual UI assignment. Idempotent:
 * when `cell` is set, stamp the founder/admin user's `cell` = cell,
 * `cell_verified_at` = seed time, and point the HOLDER_POINTER_KEY sentinel at
 * them. A no-op when `cell` is unset or no admin user exists.
 *
 * PRODUCTION has NO such seed and NO env-var fallback — inbound routing requires
 * assigning an inbound-voice-line holder via the UI (the holder verifies their
 * cell first). The local stack passes `SEED_INBOUND_VOICE_CELL` (see devReset.ts).
 *
 * The founder is resolved as the seeded `user-0001` when present, else the first
 * admin user found (a tiny scan of the bounded users table). Never logs the
 * cell (PII, §9).
 */
export async function seedInboundVoiceLineHolder(
  endpoint: string,
  cell: string | undefined,
  at: string = new Date().toISOString(),
): Promise<boolean> {
  if (cell === undefined || cell.length === 0) return false;
  const doc = createDocumentClient({ endpoint });
  try {
    const usersTable = tableName('users');
    // Bounded scan of the tiny users table — pick the seeded founder if present,
    // else the first admin (defensive: filter to items that carry a role).
    const { Items } = await doc.send(new ScanCommand({ TableName: usersTable }));
    const users = (Items as UserItem[] | undefined) ?? [];
    const founder =
      users.find((u) => u.userId === 'user-0001') ??
      users.find((u) => u.role === 'admin');
    if (!founder) return false;
    // SET the founder's verified cell on their user item...
    await doc.send(
      new UpdateCommand({
        TableName: usersTable,
        Key: { userId: founder.userId },
        UpdateExpression: 'SET cell = :cell, cell_verified_at = :at',
        ExpressionAttributeValues: { ':cell': cell, ':at': at },
      }),
    );
    // ...then establish the HOLDER via the single authoritative pointer (the
    // HOLDER_POINTER_KEY sentinel row) rather than a per-user boolean. Idempotent
    // (last-writer-wins on one field); mirrors usersRepo.assignInboundVoiceLine.
    await doc.send(
      new UpdateCommand({
        TableName: usersTable,
        Key: { userId: HOLDER_POINTER_KEY },
        UpdateExpression: 'SET holder_user_id = :uid',
        ExpressionAttributeValues: { ':uid': founder.userId },
      }),
    );
    // userId only — never the cell (PII).
    console.log(`  seeded   inbound_voice_line holder: ${founder.userId}`);
    return true;
  } finally {
    doc.destroy();
  }
}

export type SeedProfile = 'lean' | 'full';

/**
 * Idempotent seed: write all items for the given profile to DynamoDB Local.
 * Fixed IDs + plain PutCommand = safe to re-run forever (same items overwrite
 * themselves; no table clears — that is resetLocalData's job).
 *
 * Stamps the inbound-voice-line holder after seeding (both profiles; idempotent).
 * devReset's existing separate seedInboundVoiceLineHolder call is safe to keep —
 * it becomes a no-op double-stamp.
 */
export async function seedAll(endpoint: string, profile: SeedProfile = 'lean'): Promise<number> {
  // Build the item map: start with lean, merge extra tables for full.
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const [base, items] of Object.entries(SEED)) {
    tables[base] = [...items];
  }

  // One seed clock shared by the now-relative generators (matrix + live) so the
  // whole 'full' world agrees on "now" (mirrors seedLive(endpoint, now)).
  const now = new Date();

  if (profile === 'full') {
    // Merge castItems and matrixItems on top of lean (additive by table name).
    for (const [base, items] of Object.entries(castItems())) {
      tables[base] = [...(tables[base] ?? []), ...items];
    }
    for (const [base, items] of Object.entries(matrixItems(now))) {
      tables[base] = [...(tables[base] ?? []), ...items];
    }

    // Lifecycle-history post-pass (FULL profile ONLY — the lean branch is never
    // touched, keeping its byte-stable e2e/reseed world). Deterministic AUDIT
    // trails materialize how every non-start placement/tenant/landlord/unit got
    // to its END state, PLUS the person-centric Contact Timeline milestones
    // (activity_events); historyItems dedupes both vs the pre-existing rows so it
    // is the single source of truth (§4.7). Call it ONCE and wire BOTH tables.
    // Runs after cast+matrix merge and BEFORE the Put loop below.
    const history = historyItems(tables);
    tables['audit_events'] = history.audit_events;
    tables['activity_events'] = history.activity_events;
  }

  const doc = createDocumentClient({ endpoint });
  let count = 0;
  try {
    for (const [base, items] of Object.entries(tables)) {
      if (items.length === 0) continue;
      const physicalName = tableName(base);
      for (const item of items) {
        await doc.send(new PutCommand({ TableName: physicalName, Item: item }));
        count += 1;
      }
      console.log(`  seeded   ${physicalName}: ${items.length} item${items.length === 1 ? '' : 's'}`);
    }
  } finally {
    doc.destroy();
  }

  if (profile === 'full') {
    await seedLive(endpoint, now);
    // Seed the two cast media objects (MinIO); fail-soft when MinIO is unreachable.
    await seedMedia();
  }

  // Fold in the inbound-voice-line holder stamp (both profiles; idempotent).
  await seedInboundVoiceLineHolder(endpoint, SEED_INBOUND_VOICE_CELL);

  return count;
}
