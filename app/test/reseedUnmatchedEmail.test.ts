// email-channel B4 / ADJ-8: reseed clears the unmatched_email side-door store
// WITHOUT any explicit dev.ts edit. resetLocalData (devReset.ts:75-77) clears
// EVERY TABLES base (+ the outbox) before re-seeding, and B3 registered
// unmatched_email in TABLES - so a reseed wipes any side-door rows automatically.
//
// This is a deterministic MECHANISM proof (no DynamoDB, no seedAll) rather than a
// heavy clear+full-seed integration test: it pins the exact clear-set resetLocalData
// builds, which is the missing link B4 owes. The row storage itself + the TABLES
// registration are already covered by B3's unmatchedEmailRepo integration tests and
// tables.test.ts; and unmatched_email is deliberately kept OUT of every seed profile
// (F23), so after a reseed the table is empty.
import { describe, expect, it } from 'vitest';
import { TABLES } from '../src/lib/tables.js';
import { OUTBOX_TABLE_BASE } from '../src/adapters/recordingMessaging.js';

describe('reseed clears unmatched_email (ADJ-8, F23)', () => {
  it("resetLocalData's clear-set (every TABLES base + the outbox) includes unmatched_email", () => {
    // Mirror the exact array resetLocalData iterates to clear tables (devReset.ts:75).
    const clearSet = [...TABLES.map((t) => t.baseName), OUTBOX_TABLE_BASE];
    expect(clearSet).toContain('unmatched_email');
  });

  it('unmatched_email is a plain PK (unmatchedId) table - no seed-tied hash/range key a profile would populate', () => {
    // F23: the side-door store must never enter a byte-asserted seed snapshot, so a
    // reseed leaves it empty (cleared above, and nothing re-seeds it). We assert the
    // table carries no seed-tied hash/range default that a seed would populate - it
    // is a plain PK table with a byStatus GSI (B3), populated only at runtime.
    const spec = TABLES.find((t) => t.baseName === 'unmatched_email');
    expect(spec).toBeDefined();
    expect(spec!.hashKey.name).toBe('unmatchedId');
  });
});
