// Shared ranking-batch fixtures (WP1 B2a): small synthetic cards and the
// buildRankingBatch sources the S4-S8 tests build on. Cards here are plain
// records shaped like S3's cards; propertyFacts is derived the way S3's
// propertyFacts reads a card (free text by field, recorded requirement keys).
import { PROPERTY_FREE_TEXT_FIELDS, RANKED_REQUIREMENT_KEYS } from '../../src/services/ranking/cardFields.js';
import type { PropertyFactsLike, RankingBatchSource } from '../../src/services/ranking/prompt.js';
import type { Card, MissingFlag, PairHistory } from '../../src/services/ranking/types.js';

export const NO_HISTORY: PairHistory = { sends: [], declined: null, tours: [], daysSinceLastSend: null };

export function propertyCardFixture(over: Card = {}): Card {
  return {
    address: { line1: '10 Fixture Street', city: 'Decatur', state: 'GA', zip: '30030' },
    beds: 2,
    baths: 1,
    area: 'Decatur',
    rent_min: 1400,
    payment_standard: 1600,
    notes: 'Fenced yard',
    status: 'available',
    voucherSizes: [2],
    voucherSizesInferredFromBeds: false,
    authorities: { mapped: ['Decatur Housing Authority'], unmapped: [] },
    ...over,
  };
}

export function tenantCardFixture(over: Card = {}): Card {
  return {
    firstName: 'Fixture',
    lastName: 'Tenant',
    voucherSize: 2,
    housingAuthority: 'Decatur Housing Authority',
    status: 'searching',
    notes: 'Works days.',
    lastHeardFrom: 'this week',
    propertiesSeen: [],
    ...over,
  };
}

export function factsOf(card: Card): PropertyFactsLike {
  const recordedRequirementKeys = RANKED_REQUIREMENT_KEYS.filter((key) => {
    const value = card[key];
    return value === true || typeof value === 'number' || (typeof value === 'string' && value.trim().length > 0);
  });
  const freeTextByField: Record<string, string> = {};
  for (const field of PROPERTY_FREE_TEXT_FIELDS) {
    const value = card[field];
    if (typeof value === 'string' && value.trim().length > 0) freeTextByField[field] = value.trim();
  }
  return { recordedRequirementKeys, freeTextByField };
}

export function missing(...labels: string[]): MissingFlag[] {
  return labels.map((label, i) => ({ key: `missing_${i + 1}`, label }));
}

export interface FixtureOptions {
  homes?: Map<string, { label: string; card: Card }>;
  landlordCard?: boolean;
  batchIndex?: number;
}

/** A property anchor ('unit-anchor') with these tenant cards as candidates tenant-1..n. */
export function tenantsForPropertySource(tenants: Card[], property: Card = propertyCardFixture(), opts: FixtureOptions = {}): RankingBatchSource {
  return {
    direction: 'tenants_for_property',
    batchIndex: opts.batchIndex ?? 0,
    landlordCard: opts.landlordCard ?? false,
    anchor: { card: property, missing: [] },
    candidates: tenants.map((card, i) => ({
      candidateId: `tenant-${i + 1}`,
      unitId: 'unit-anchor',
      card,
      missing: [],
      pairHistory: NO_HISTORY,
      propertyFacts: factsOf(property),
    })),
    homes: opts.homes ?? new Map(),
  };
}

/** A tenant anchor with these properties as candidates (candidateId = unitId). */
export function propertiesForTenantSource(
  properties: Array<{ unitId: string; card: Card }>,
  tenant: Card = tenantCardFixture(),
  opts: FixtureOptions = {},
): RankingBatchSource {
  return {
    direction: 'properties_for_tenant',
    batchIndex: opts.batchIndex ?? 0,
    landlordCard: opts.landlordCard ?? false,
    anchor: { card: tenant, missing: [] },
    candidates: properties.map((p) => ({
      candidateId: p.unitId,
      unitId: p.unitId,
      card: p.card,
      missing: [],
      pairHistory: NO_HISTORY,
      propertyFacts: factsOf(p.card),
    })),
    homes: opts.homes ?? new Map(),
  };
}
