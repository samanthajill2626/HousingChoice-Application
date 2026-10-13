// Seed contact-type invariants (fix/caseworker-integrity; spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 1,
// I2-I4, and section 5 "Seeds"). Seeds are raw puts: none of the route checks
// that keep these rules run for them, so a seed that put a non-tenant on a
// tour or placement, named a non-landlord as a property's landlord of record,
// or seated a caseworker on a property's contact list would build a world the
// app itself refuses to build - and every lane and demo starts from a seed.
//
// Checked per WORLD, composed the way the seeders write it (a later layer's
// row replaces an earlier one with the same id, as a later PutCommand does):
//   - lean:        SEED (lib/seed/lean.ts) - the e2e world;
//   - full:        SEED + castItems() + matrixItems(now) (seedAll('full'),
//                  lib/seed/index.ts), then the live builder
//                  buildLiveStaticItems(now) (seedLive, lib/seed/live.ts);
//   - performance: SEED + the generated performance tables
//                  (resetPerformanceData resets to lean first,
//                  lib/performanceSeed.ts) - at the default scale, and with
//                  NO generated contacts, which exercises the lean fallbacks
//                  (contact-tenant-0001 / contact-landlord-0001).
//
// The rules. EVERY seeded tour and placement - open or closed - names a
// contact typed `tenant`: stricter than I2 (open records only) on purpose, as
// no seed needs a closed record on a non-tenant; relax it to open records only
// if a seed ever models a converted caseworker's closed history. Every LIVE
// unit with a `landlordId` names a contact typed `landlord` (an ownerless unit
// is a supported state; a soft-deleted one is fenced at restore). No unit's
// contact list - the stored `contacts[]`, else the row derived from
// `landlordId` (unitContacts) - seats a caseworker (isCaseworker,
// lib/caseworkers.ts), and every seat names a seeded contact. On 2026-10-12 no
// seed holds a caseworker at all, so the last rule guards future seeds.
import { describe, expect, it } from 'vitest';
import { SEED } from '../src/lib/seed/lean.js';
import { castItems } from '../src/lib/seed/cast.js';
import { matrixItems } from '../src/lib/seed/matrix.js';
import { buildLiveStaticItems } from '../src/lib/seed/live.js';
import {
  generatePerformanceSeed,
  resolvePerformanceSeedConfig,
  type PerformanceSeedInput,
} from '../src/lib/seed/performance.js';
import { isCaseworker } from '../src/lib/caseworkers.js';
import { unitContacts, type UnitItem } from '../src/repos/unitsRepo.js';

type Row = Record<string, unknown>;
type Tables = Readonly<Record<string, readonly Row[]>>;

// matrix, live and performance are now-relative; a fixed instant makes them deterministic.
const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');
const ANCHOR = FIXED_NOW.toISOString();

function performanceTables(input: PerformanceSeedInput): Tables {
  return generatePerformanceSeed(resolvePerformanceSeedConfig(input, ANCHOR)).tables as unknown as Tables;
}

const WORLDS: Readonly<Record<string, readonly Tables[]>> = {
  lean: [SEED],
  full: [SEED, castItems(), matrixItems(FIXED_NOW), buildLiveStaticItems(FIXED_NOW)],
  performance: [SEED, performanceTables({})],
  'performance-lean-fallbacks': [SEED, performanceTables({ contacts: 0, nativeGroups: 0, conversations: 0 })],
};

interface WorldCheck {
  violations: string[];
  checked: { tours: number; placements: number; liveUnits: number; contactListRows: number };
}

/** One table across the layers, by id; a later layer's row wins. Phone-pointer
 *  rows (`phoneref#...` contactIds, cast.ts) are not contacts and are skipped. */
function byId(layers: readonly Tables[], table: string, key: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const layer of layers) {
    for (const row of layer[table] ?? []) {
      const id = row[key];
      if (typeof id === 'string' && !id.startsWith('phoneref#')) rows.set(id, row);
    }
  }
  return rows;
}

function kindOf(contact: Row | undefined): string {
  return contact === undefined ? 'missing' : `typed ${String(contact['type'])}`;
}

/** Every I2-I4 violation in one composed world (later layers win). */
function seedTypeViolations(layers: readonly Tables[]): WorldCheck {
  const contacts = byId(layers, 'contacts', 'contactId');
  const violations: string[] = [];
  const checked = { tours: 0, placements: 0, liveUnits: 0, contactListRows: 0 };
  for (const [table, key] of [['tours', 'tourId'], ['placements', 'placementId']] as const) {
    for (const [id, record] of byId(layers, table, key)) {
      checked[table] += 1;
      const tenantId = String(record['tenantId']);
      const tenant = contacts.get(tenantId);
      if (tenant?.['type'] !== 'tenant') {
        violations.push(`${table} ${id}: tenantId ${tenantId} is ${kindOf(tenant)}, not tenant`);
      }
    }
  }
  for (const [unitId, unit] of byId(layers, 'units', 'unitId')) {
    const deletedAt = unit['deleted_at'];
    const live = !(typeof deletedAt === 'string' && deletedAt.length > 0);
    const landlordId = unit['landlordId'];
    if (live && typeof landlordId === 'string' && landlordId.length > 0) {
      checked.liveUnits += 1;
      const owner = contacts.get(landlordId);
      if (owner?.['type'] !== 'landlord') {
        violations.push(`units ${unitId}: landlordId ${landlordId} is ${kindOf(owner)}, not landlord`);
      }
    }
    for (const seat of unitContacts(unit as unknown as Pick<UnitItem, 'contacts' | 'landlordId'>)) {
      checked.contactListRows += 1;
      const seated = contacts.get(seat.contactId);
      if (seated === undefined) {
        violations.push(`units ${unitId}: contact list seats ${seat.contactId}, which is not a seeded contact`);
      } else if (isCaseworker(seated)) {
        violations.push(`units ${unitId}: contact list seats caseworker ${seat.contactId}`);
      }
    }
  }
  return { violations, checked };
}

describe('seed contact-type invariants (I2-I4) hold in every seeded world', () => {
  for (const [world, layers] of Object.entries(WORLDS)) {
    it(`${world}: tours and placements name tenants, live landlords are landlords, no caseworker on a contact list`, () => {
      const { violations, checked } = seedTypeViolations(layers);
      expect(violations, `${world} violations`).toEqual([]);
      // Not vacuous: the world holds what is checked (lean seeds no tours).
      expect(checked.placements, `${world} placements checked`).toBeGreaterThan(0);
      expect(checked.liveUnits, `${world} live units checked`).toBeGreaterThan(0);
      expect(checked.contactListRows, `${world} contact-list rows checked`).toBeGreaterThan(0);
      if (world !== 'lean') expect(checked.tours, `${world} tours checked`).toBeGreaterThan(0);
    });
  }
});

describe('the seed checker itself', () => {
  it('names each kind of violation, and skips what the rules allow', () => {
    const world: Tables = {
      contacts: [
        { contactId: 'c-tenant', type: 'tenant' },
        { contactId: 'c-landlord', type: 'landlord' },
        { contactId: 'c-caseworker', type: 'partner', role: 'Case Worker' },
        { contactId: 'c-partner', type: 'partner', role: 'Housing navigator' },
        { contactId: 'phoneref#+15550109999', ref_contactId: 'c-tenant' },
      ],
      tours: [
        { tourId: 't-ok', tenantId: 'c-tenant', status: 'scheduled' },
        { tourId: 't-landlord', tenantId: 'c-landlord', status: 'closed' },
      ],
      placements: [
        { placementId: 'p-ok', tenantId: 'c-tenant', stage: 'send_application' },
        { placementId: 'p-gone', tenantId: 'c-gone', stage: 'lost' },
      ],
      units: [
        { unitId: 'u-ok', landlordId: 'c-landlord' },
        { unitId: 'u-ownerless', contacts: [] },
        {
          unitId: 'u-partner-owner',
          landlordId: 'c-partner',
          contacts: [{ contactId: 'c-partner', role: 'landlord', primaryContact: true }],
        },
        {
          unitId: 'u-deleted',
          landlordId: 'c-tenant',
          deleted_at: '2026-06-30T00:00:00.000Z',
          contacts: [{ contactId: 'c-landlord', role: 'owner', primaryContact: true }],
        },
        {
          unitId: 'u-seat',
          landlordId: 'c-landlord',
          contacts: [
            { contactId: 'c-landlord', role: 'landlord', primaryContact: true },
            { contactId: 'c-caseworker', role: 'other', primaryContact: false },
          ],
        },
      ],
    };
    expect(seedTypeViolations([world])).toEqual({
      violations: [
        'tours t-landlord: tenantId c-landlord is typed landlord, not tenant',
        'placements p-gone: tenantId c-gone is missing, not tenant',
        'units u-partner-owner: landlordId c-partner is typed partner, not landlord',
        'units u-seat: contact list seats caseworker c-caseworker',
      ],
      checked: { tours: 2, placements: 2, liveUnits: 3, contactListRows: 5 },
    });
  });

  it('composes layers the way the seeders write them: a later contact row wins', () => {
    const first: Tables = {
      contacts: [{ contactId: 'c-x', type: 'tenant' }],
      tours: [{ tourId: 't-x', tenantId: 'c-x', status: 'requested' }],
    };
    const later: Tables = { contacts: [{ contactId: 'c-x', type: 'landlord' }] };
    expect(seedTypeViolations([first, later]).violations).toEqual([
      'tours t-x: tenantId c-x is typed landlord, not tenant',
    ]);
  });
});
