// WP1 B1 (spec 2026-10-26 section 4 "Seeds"; plan PR3, WI7): the FULL demo
// world gives ONE tenant every tenant matching input - the cast Searching
// Tenant, Monique Everett (persona 4: status searching, properties sent) -
// stored exactly as the contacts PATCH would store them. The LEAN e2e world
// is untouched (byte-stable).
import { describe, expect, it } from 'vitest';
import { SEED } from '../src/lib/seed/lean.js';
import { castItems } from '../src/lib/seed/cast.js';
import { matrixItems } from '../src/lib/seed/matrix.js';
import { buildLiveStaticItems } from '../src/lib/seed/live.js';
import { TENANT_MATCHING_INPUTS, parseTenantMatchingInputs } from '../src/lib/tenantMatchingInputs.js';

type Row = Record<string, unknown>;
type Tables = Readonly<Record<string, readonly Row[]>>;

// matrix and live are now-relative; a fixed instant makes them deterministic.
const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');
const HOLDER = 'contact-cast-searching-tenant';
const FULL: readonly Tables[] = [SEED, castItems(), matrixItems(FIXED_NOW), buildLiveStaticItems(FIXED_NOW)];

function rowsOf(layers: readonly Tables[], table: string): Row[] {
  return layers.flatMap((tables) => [...(tables[table] ?? [])]);
}

function matchingOf(row: Row | undefined): Row {
  if (row === undefined) return {};
  return Object.fromEntries(
    TENANT_MATCHING_INPUTS.filter((input) => input.key in row).map((input) => [input.key, row[input.key]]),
  );
}

describe('full profile: one demo tenant with every tenant matching input (PR3)', () => {
  it('exactly one contact in the full world holds any of them: the cast Searching Tenant', () => {
    const holders = rowsOf(FULL, 'contacts')
      .filter((c) => Object.keys(matchingOf(c)).length > 0)
      .map((c) => c['contactId']);
    expect(holders).toEqual([HOLDER]);
  });

  it('she is a searching tenant holding all four, stored exactly as the contacts PATCH stores them', () => {
    const tenant = rowsOf(FULL, 'contacts').find((c) => c['contactId'] === HOLDER);
    expect(tenant?.['type']).toBe('tenant');
    expect(tenant?.['status']).toBe('searching');
    const held = matchingOf(tenant);
    expect(Object.keys(held)).toEqual(TENANT_MATCHING_INPUTS.map((input) => input.key));
    expect(parseTenantMatchingInputs(held)).toEqual({ ok: true, fields: held });
  });
});

describe('lean profile: byte-stable, untouched (WI7)', () => {
  it('(PIN) no lean contact holds a tenant matching input', () => {
    for (const contact of SEED['contacts'] ?? []) expect(matchingOf(contact)).toEqual({});
  });
});
