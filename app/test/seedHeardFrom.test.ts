// Seed derivation of contacts.last_heard_from_at (spec
// docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md,
// sections 5.1 and 14.2; invariant I4; D13). Pure: the derivation runs over the
// MERGED rows of a profile through the live paths' one attribution rule, and
// returns COPIES (the SEED and cast items are shared module literals).
import { describe, expect, it } from 'vitest';
import { SEED } from '../src/lib/seed/lean.js';
import { castItems } from '../src/lib/seed/cast.js';
import { matrixItems } from '../src/lib/seed/matrix.js';
import { deriveSeedHeardFrom } from '../src/lib/seed/heardFrom.js';

type Row = Record<string, unknown>;

// matrixItems is now-relative; any fixed instant makes it deterministic.
const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');

/** seedAll's merge (seed/index.ts): lean arrays copied, then for 'full' the
 *  cast and matrix tables appended per table. */
function merged(profile: 'lean' | 'full'): Record<string, Row[]> {
  const tables: Record<string, Row[]> = {};
  for (const [base, items] of Object.entries(SEED)) tables[base] = [...items];
  if (profile === 'full') {
    for (const [base, items] of Object.entries(castItems())) tables[base] = [...(tables[base] ?? []), ...items];
    for (const [base, items] of Object.entries(matrixItems(FIXED_NOW))) {
      tables[base] = [...(tables[base] ?? []), ...items];
    }
  }
  return tables;
}

const derive = (tables: Record<string, Row[]>): Promise<Row[]> =>
  deriveSeedHeardFrom(tables['messages'] ?? [], tables['conversations'] ?? [], tables['contacts'] ?? []);

const heardOf = (rows: Row[], id: string): unknown => rows.find((c) => c['contactId'] === id)?.['last_heard_from_at'];

describe('deriveSeedHeardFrom - lean (spec I4, D13)', () => {
  it('stamps the exact lean values; contacts never heard from carry no attribute', async () => {
    const rows = await derive(merged('lean'));
    expect(heardOf(rows, 'contact-tenant-0001')).toBe('2026-06-01T14:02:10.000Z');
    expect(heardOf(rows, 'contact-landlord-0001')).toBe('2026-06-01T13:45:00.000Z');
    const hastaff = rows.find((c) => c['contactId'] === 'contact-hastaff-0001');
    const tenant2 = rows.find((c) => c['contactId'] === 'contact-tenant-0002');
    expect(hastaff).toBeDefined();
    expect(tenant2).toBeDefined();
    expect(hastaff).not.toHaveProperty('last_heard_from_at');
    expect(tenant2).not.toHaveProperty('last_heard_from_at');
  });

  it('returns COPIES in the input order and never mutates the SEED literal', async () => {
    const input = merged('lean')['contacts'] ?? [];
    const rows = await derive(merged('lean'));
    const seedTenant = (SEED['contacts'] ?? []).find((c) => c['contactId'] === 'contact-tenant-0001')!;
    const derivedTenant = rows.find((c) => c['contactId'] === 'contact-tenant-0001')!;
    expect(seedTenant).not.toHaveProperty('last_heard_from_at');
    expect(derivedTenant).not.toBe(seedTenant);
    expect(rows).toHaveLength(input.length);
    expect(rows.map((c) => c['contactId'])).toEqual(input.map((c) => c['contactId']));
  });
});

describe('deriveSeedHeardFrom - full (lean + cast + matrix)', () => {
  it('stamps the exact cast values and keeps the lean ones', async () => {
    const rows = await derive(merged('full'));
    // Lean beats cast CU/CX for the landlord.
    expect(heardOf(rows, 'contact-tenant-0001')).toBe('2026-06-01T14:02:10.000Z');
    expect(heardOf(rows, 'contact-landlord-0001')).toBe('2026-06-01T13:45:00.000Z');
    expect(heardOf(rows, 'contact-cast-unknown-texter')).toBe('2026-05-01T09:00:00.000Z');
    expect(heardOf(rows, 'contact-cast-mid-intake-tenant')).toBe('2026-05-02T10:20:00.000Z');
    expect(heardOf(rows, 'contact-cast-parked-norta-tenant')).toBe('2026-05-04T13:10:00.000Z');
    // Group A beats relay and 1:1.
    expect(heardOf(rows, 'contact-cast-searching-tenant')).toBe('2026-05-08T10:05:00.000Z');
    expect(heardOf(rows, 'contact-cast-toured-yes-tenant')).toBe('2026-05-09T11:00:00.000Z');
    // Group B.
    expect(heardOf(rows, 'contact-cast-cold-call-landlord')).toBe('2026-05-09T11:00:00.000Z');
    expect(heardOf(rows, 'contact-cast-never-signed-landlord')).toBe('2026-05-01T09:30:00.000Z');
    expect(heardOf(rows, 'contact-cast-parked-landlord')).toBe('2026-05-02T10:15:00.000Z');
    expect(heardOf(rows, 'contact-cast-mid-intake-unit-landlord')).toBe('2026-05-03T11:05:00.000Z');
  });

  it('leaves contacts with no attributed inbound, every matrix contact and the phoneref# pointer unstamped', async () => {
    const rows = await derive(merged('full'));
    const unstamped = [
      'contact-cast-pm-managed-property-owner',
      'contact-cast-pm-managed-property-manager',
      'phoneref#+15550100105',
    ];
    for (const id of unstamped) {
      const row = rows.find((c) => c['contactId'] === id);
      expect(row, id).toBeDefined();
      expect(row, id).not.toHaveProperty('last_heard_from_at');
    }
    // Every matrix contact (ids `tenant-mx-*` / `landlord-mx-*`; the matrix
    // seeds no messages), taken from the matrix's own item set.
    const matrixIds = new Set((matrixItems(FIXED_NOW)['contacts'] ?? []).map((c) => c['contactId']));
    const matrix = rows.filter((c) => matrixIds.has(c['contactId']));
    expect(matrix.length).toBeGreaterThan(0);
    expect(matrix).toHaveLength(matrixIds.size);
    for (const row of matrix) expect(row, String(row['contactId'])).not.toHaveProperty('last_heard_from_at');
  });

  it('tolerates the pointer rows (phone# claims, the sid# message pointer, the phoneref# contact)', async () => {
    const tables = merged('full');
    expect((tables['conversations'] ?? []).some((c) => String(c['conversationId']).startsWith('phone#'))).toBe(true);
    expect((tables['messages'] ?? []).some((m) => String(m['conversationId']).startsWith('sid#'))).toBe(true);
    expect((tables['contacts'] ?? []).some((c) => String(c['contactId']).startsWith('phoneref#'))).toBe(true);
    await expect(derive(tables)).resolves.toHaveLength((tables['contacts'] ?? []).length);
  });
});
