// WP1 B2a spec D14.3 (WI10): no seed writes a contact's Notes box or its
// stamp - seeds carry no notes_updated_at, which reads as "never stamped".
// The lean world stays byte-stable through S1 (S1.11 checks its diff).
import { describe, expect, it } from 'vitest';
import { SEED } from '../src/lib/seed/lean.js';
import { castItems } from '../src/lib/seed/cast.js';
import { matrixItems } from '../src/lib/seed/matrix.js';
import { buildLiveStaticItems } from '../src/lib/seed/live.js';

type Row = Record<string, unknown>;
type Tables = Readonly<Record<string, readonly Row[]>>;

// matrix and live are now-relative; a fixed instant makes them deterministic.
const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');
const WORLDS: ReadonlyArray<readonly [string, readonly Tables[]]> = [
  ['lean', [SEED]],
  ['full', [SEED, castItems(), matrixItems(FIXED_NOW), buildLiveStaticItems(FIXED_NOW)]],
];

describe('no seed writes a contact Notes box or its stamp (WP1 B2a D14.3, WI10)', () => {
  for (const [name, layers] of WORLDS) {
    it(`(PIN) the ${name} world: no contact carries notes or notes_updated_at`, () => {
      const contacts = layers.flatMap((tables) => [...(tables['contacts'] ?? [])]);
      expect(contacts.length).toBeGreaterThan(0);
      expect(contacts.filter((c) => 'notes' in c || 'notes_updated_at' in c).map((c) => c['contactId'])).toEqual([]);
    });
  }
});
