// Seed unread-flag coherence - the STANDING guard on the byUnread invariant
// (design 2026-08-16 section 4.2): `unread_flag` exists on a conversation row
// IFF that row's `unread_count > 0`, and its value is exactly 'unread'.
//
// Why this guard has to exist at all: seeds write WHOLE items with an
// unconditional PutCommand (lib/seed/index.ts, performanceSeed.ts), so a
// fixture that carries a nonzero `unread_count` without the flag silently
// vanishes from every unread read - the inbox Unread tab, the nav badge and
// Today all query the sparse byUnread GSI, whose HASH *is* `unread_flag`.
// `ConversationItem` also declares `[key: string]: unknown`, so tsc cannot
// catch a misspelled or missing flag on any seed literal. Only a walk of the
// built rows can.
//
// Worlds covered: performance, lean, cast, matrix.
//
// live.ts is DELIBERATELY EXCLUDED, for two independently verified reasons
// (mirroring the same exclusion in seedRosterShape.test.ts):
//   1. it exports NO reachable item array - the builder is the module-private
//      `buildLiveStaticItems` (live.ts:98) and the only export is the writer
//      `seedLive()`, so reaching it would mean a refactor-export for the sole
//      benefit of a guard; and
//   2. it seeds NO nonzero unread - all four of its conversation rows write a
//      literal `unread_count: 0` (live.ts:264, :282, :310, :331) and `seedLive`
//      writes nothing else into the conversations table, so there is no row
//      here for the invariant to be wrong about.
// If live.ts ever seeds a nonzero unread, export the builder and add it below.
import { describe, it, expect } from 'vitest';
import { SEED } from '../src/lib/seed/lean.js';
import { castItems } from '../src/lib/seed/cast.js';
import { matrixItems } from '../src/lib/seed/matrix.js';
import {
  generatePerformanceSeed,
  resolvePerformanceSeedConfig,
} from '../src/lib/seed/performance.js';
import { UNREAD_FLAG_VALUE } from '../src/repos/conversationsRepo.js';

// matrixItems and the performance generator are now-relative; a fixed instant
// makes both deterministic.
const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');
const ANCHOR = '2026-07-01T12:00:00.000Z';

type Row = Record<string, unknown>;

const performanceConversations = generatePerformanceSeed(
  resolvePerformanceSeedConfig({}, ANCHOR),
).tables.conversations as unknown as Row[];

const PROFILES: Record<string, Row[]> = {
  lean: (SEED['conversations'] ?? []) as Row[],
  cast: (castItems()['conversations'] ?? []) as Row[],
  matrix: (matrixItems(FIXED_NOW)['conversations'] ?? []) as Row[],
  performance: performanceConversations,
};

/**
 * Pointer/claim partitions (phone#/email#/token#) are key-only rows that carry
 * neither `unread_count` nor `unread_flag`, so they pass the invariant either
 * way - but they are excluded explicitly so a reader knows the omission is a
 * decision and not an oversight. cast.ts DOES emit phone# claim rows.
 */
function conversationRowsOf(rows: Row[]): Row[] {
  return rows.filter((r) => {
    const id = r['conversationId'];
    return (
      typeof id === 'string' &&
      !id.startsWith('phone#') &&
      !id.startsWith('email#') &&
      !id.startsWith('token#')
    );
  });
}

function unreadCountOf(row: Row): number {
  const count = row['unread_count'];
  return typeof count === 'number' ? count : 0;
}

describe('seed unread flag (byUnread invariant)', () => {
  it('every world actually yields conversation rows (a guard over nothing proves nothing)', () => {
    for (const [profile, rows] of Object.entries(PROFILES)) {
      expect(conversationRowsOf(rows).length, `${profile} must emit conversations`).toBeGreaterThan(
        0,
      );
    }
  });

  it('unread_flag is present IFF unread_count > 0, in every seed world', () => {
    for (const [profile, rows] of Object.entries(PROFILES)) {
      for (const conv of conversationRowsOf(rows)) {
        const where = `${profile}:${String(conv['conversationId'])}`;
        const unread = unreadCountOf(conv);
        expect(
          'unread_flag' in conv,
          `${where} has unread_count ${unread} - the flag must be ${unread > 0 ? 'PRESENT' : 'ABSENT'} (byUnread is keyed on it)`,
        ).toBe(unread > 0);
      }
    }
  });

  it('every present unread_flag carries exactly the index HASH value', () => {
    for (const [profile, rows] of Object.entries(PROFILES)) {
      for (const conv of conversationRowsOf(rows)) {
        if (!('unread_flag' in conv)) continue;
        const where = `${profile}:${String(conv['conversationId'])}`;
        expect(conv['unread_flag'], `${where} flag must be the single index partition value`).toBe(
          UNREAD_FLAG_VALUE,
        );
      }
    }
  });

  it('the performance world is the only one seeding nonzero unread, and it does seed some', () => {
    // Pins the audit the spec rests on: lean/cast/matrix write 0 or omit the
    // field, so a flag appearing there is a bug, and performance MUST contain
    // flagged rows or the guard above passes vacuously for the one world that
    // exercises it.
    for (const profile of ['lean', 'cast', 'matrix'] as const) {
      const flagged = conversationRowsOf(PROFILES[profile] ?? []).filter((c) => unreadCountOf(c) > 0);
      expect(flagged, `${profile} must not seed nonzero unread`).toHaveLength(0);
    }
    const perfFlagged = conversationRowsOf(performanceConversations).filter(
      (c) => unreadCountOf(c) > 0,
    );
    expect(perfFlagged.length).toBeGreaterThan(0);
    expect(perfFlagged.every((c) => c['unread_flag'] === UNREAD_FLAG_VALUE)).toBe(true);
  });
});
