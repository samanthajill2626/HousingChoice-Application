// M0.3 contract tests for lib/tables.ts: all 9 tables, exact PK/SK and GSI
// names per architecture doc v2.12 §5 (p.11-12), streams on messages+placements,
// TTL on matches, and the TABLE_PREFIX name resolution helper.
//
// These assertions ARE the contract Terraform must mirror in M0.4 — if one of
// them has to change, that is a contract change (README Deviations row).
import { describe, expect, it } from 'vitest';
import { DEFAULT_TABLE_PREFIX, tableName } from '../src/lib/config.js';
import { getTableSpec, TABLES, type TableSpec } from '../src/lib/tables.js';

function spec(baseName: string): TableSpec {
  return getTableSpec(baseName);
}

function gsiNames(s: TableSpec): string[] {
  return s.gsis.map((g) => g.indexName);
}

describe('tables.ts — the table contract', () => {
  it('defines the 9 doc-§5 tables plus settings (M1.4), pool_numbers (M1.7), broadcasts (M1.8a), activity_events (BE2), listing_sends (BE4), tours + tourReminders (Tours feature), placementNudges (Post-Tour & Application), placementDeadlines (placement-deadline-model), ai_extraction (conversation-fact-extraction)', () => {
    expect(TABLES.map((t) => t.baseName)).toEqual([
      'contacts',
      'units',
      'conversations',
      'messages',
      'matches',
      'placements',
      'invoices',
      'users',
      'audit_events',
      'settings',
      'pool_numbers',
      'broadcasts',
      'activity_events',
      'listing_sends',
      'tourReminders',
      'placementNudges',
      'placementDeadlines',
      'tours',
      'ai_extraction',
    ]);
  });

  it('activity_events (BE2/C2): PK contactId + SK tsEventId; no GSIs/stream/TTL', () => {
    const t = spec('activity_events');
    expect(t.hashKey.name).toBe('contactId');
    expect(t.rangeKey?.name).toBe('tsEventId');
    expect(t.gsis).toHaveLength(0);
    expect(t.stream).toBeUndefined();
    expect(t.ttlAttribute).toBeUndefined();
  });

  it('listing_sends (BE4/C4): PK unitId + SK contactId; GSI byContact (contactId + sentAt); no stream/TTL', () => {
    const t = spec('listing_sends');
    expect(t.hashKey.name).toBe('unitId');
    expect(t.rangeKey?.name).toBe('contactId');
    expect(gsiNames(t)).toEqual(['byContact']);
    const byContact = t.gsis.find((g) => g.indexName === 'byContact');
    expect(byContact?.hashKey.name).toBe('contactId');
    expect(byContact?.rangeKey?.name).toBe('sentAt');
    expect(t.stream).toBeUndefined();
    expect(t.ttlAttribute).toBeUndefined();
  });

  it('broadcasts (M1.8a): PK broadcastId; GSIs byCreated (_listPartition + created_at, the team-wide list), byUnit (unitId, sparse); no stream/TTL', () => {
    const t = spec('broadcasts');
    expect(t.hashKey.name).toBe('broadcastId');
    expect(t.rangeKey).toBeUndefined();
    expect(gsiNames(t)).toEqual(['byCreated', 'byUnit']);
    // byCreated: constant partition (every item stamps _listPartition =
    // 'broadcasts') + created_at sort — ONE query serves the All tab and the
    // status tabs (FilterExpression). Replaced byStatus (unsorted) + byCreatedAt
    // (per-creator — it scoped the All tab to the acting user, 2026-07-08 bug).
    const byCreated = t.gsis.find((g) => g.indexName === 'byCreated');
    expect(byCreated?.hashKey.name).toBe('_listPartition');
    expect(byCreated?.rangeKey?.name).toBe('created_at');
    expect(byCreated?.sparse).toBeUndefined(); // NOT sparse — every item stamps it
    // Broadcasts dashboard: the prior-recipients lookup — partition by unitId,
    // sparse (only broadcasts WITH a unitId index here).
    const byUnit = t.gsis.find((g) => g.indexName === 'byUnit');
    expect(byUnit?.hashKey.name).toBe('unitId');
    expect(byUnit?.rangeKey).toBeUndefined();
    expect(byUnit?.sparse).toBe(true);
    expect(t.stream).toBeUndefined();
    expect(t.ttlAttribute).toBeUndefined();
  });

  it('pool_numbers (M1.7): PK poolNumber; GSI byLifecycleState (lifecycle_state + quarantine_until); no stream/TTL', () => {
    const t = spec('pool_numbers');
    expect(t.hashKey.name).toBe('poolNumber');
    expect(t.rangeKey).toBeUndefined();
    expect(gsiNames(t)).toEqual(['byLifecycleState']);
    const gsi = t.gsis.find((g) => g.indexName === 'byLifecycleState');
    expect(gsi?.hashKey.name).toBe('lifecycle_state');
    expect(gsi?.rangeKey?.name).toBe('quarantine_until');
    expect(t.stream).toBeUndefined();
    expect(t.ttlAttribute).toBeUndefined();
  });

  it('settings: PK settingId; no GSIs (M1.4 — founder-editable templates home)', () => {
    const t = spec('settings');
    expect(t.hashKey.name).toBe('settingId');
    expect(t.rangeKey).toBeUndefined();
    expect(t.gsis).toEqual([]);
    expect(t.stream).toBeUndefined();
    expect(t.ttlAttribute).toBeUndefined();
  });

  it('contacts: PK contactId; GSIs byPhone, byTypeStatus, byHousingAuthority', () => {
    const t = spec('contacts');
    expect(t.hashKey.name).toBe('contactId');
    expect(t.rangeKey).toBeUndefined();
    expect(gsiNames(t)).toEqual(['byPhone', 'byTypeStatus', 'byHousingAuthority']);
  });

  it('units: PK unitId; GSIs byLandlord, byStatus, byJurisdiction, byProperty (sparse, BE3)', () => {
    const t = spec('units');
    expect(t.hashKey.name).toBe('unitId');
    expect(t.rangeKey).toBeUndefined();
    expect(gsiNames(t)).toEqual(['byLandlord', 'byStatus', 'byJurisdiction', 'byProperty']);
    const byProperty = t.gsis.find((g) => g.indexName === 'byProperty');
    expect(byProperty?.hashKey.name).toBe('propertyId');
    expect(byProperty?.rangeKey).toBeUndefined();
    expect(byProperty?.sparse).toBe(true);
  });

  it('conversations: PK conversationId; GSIs byParticipantPhone, byLastActivity, byPoolNumber, byRelayStatus', () => {
    const t = spec('conversations');
    expect(t.hashKey.name).toBe('conversationId');
    expect(t.rangeKey).toBeUndefined();
    expect(gsiNames(t)).toEqual([
      'byParticipantPhone',
      'byLastActivity',
      'byPoolNumber',
      'byRelayStatus',
    ]);
    expect(t.gsis.find((g) => g.indexName === 'byPoolNumber')?.sparse).toBe(true);
    expect(t.gsis.find((g) => g.indexName === 'byPoolNumber')?.hashKey.name).toBe('pool_number');
    // byRelayStatus: sparse relay-group index (relay-inbox-open-groups-truncation fix).
    const byRelayStatus = t.gsis.find((g) => g.indexName === 'byRelayStatus');
    expect(byRelayStatus?.sparse).toBe(true);
    expect(byRelayStatus?.hashKey.name).toBe('relay_status');
    expect(byRelayStatus?.rangeKey?.name).toBe('last_activity_at');
  });

  it('messages: PK conversationId, SK ts#msgId; stream on; no GSIs', () => {
    const t = spec('messages');
    expect(t.hashKey.name).toBe('conversationId');
    expect(t.rangeKey?.name).toBe('tsMsgId'); // value shape: <ISO ts>#<msgId>
    expect(t.gsis).toEqual([]);
    expect(t.stream).toBe('NEW_AND_OLD_IMAGES');
  });

  it('matches: PK tenantId, SK unitId; GSI byUnit; TTL attribute set', () => {
    const t = spec('matches');
    expect(t.hashKey.name).toBe('tenantId');
    expect(t.rangeKey?.name).toBe('unitId');
    expect(gsiNames(t)).toEqual(['byUnit']);
    expect(t.ttlAttribute).toBe('expires_at');
    expect(t.stream).toBeUndefined();
  });

  it('placements: PK placementId; GSIs byTenant, byUnit, byStage, byTourDate (sparse); byNextDeadline RETIRED; stream on', () => {
    const t = spec('placements');
    expect(t.hashKey.name).toBe('placementId');
    expect(t.rangeKey).toBeUndefined();
    // byNextDeadline is retired (placement-deadline-model): deadlines are
    // first-class placementDeadlines items now.
    expect(gsiNames(t)).toEqual(['byTenant', 'byUnit', 'byStage', 'byTourDate']);
    expect(t.gsis.find((g) => g.indexName === 'byTourDate')?.sparse).toBe(true);
    expect(t.gsis.find((g) => g.indexName === 'byNextDeadline')).toBeUndefined();
    expect(t.stream).toBe('NEW_AND_OLD_IMAGES');
  });

  it('placementDeadlines: PK deadlineId; GSIs byPlacement, byDueAt (fixed partition + at range); no stream', () => {
    const t = spec('placementDeadlines');
    expect(t.hashKey.name).toBe('deadlineId');
    expect(t.rangeKey).toBeUndefined();
    expect(gsiNames(t)).toEqual(['byPlacement', 'byDueAt']);
    expect(t.gsis.find((g) => g.indexName === 'byPlacement')?.hashKey.name).toBe('placementId');
    const byDueAt = t.gsis.find((g) => g.indexName === 'byDueAt');
    expect(byDueAt?.hashKey.name).toBe('_deadlinePartition');
    expect(byDueAt?.rangeKey?.name).toBe('at');
    expect(t.stream).toBeUndefined();
  });

  it('invoices: PK invoiceId; GSIs byLandlord, byStatus', () => {
    const t = spec('invoices');
    expect(t.hashKey.name).toBe('invoiceId');
    expect(t.rangeKey).toBeUndefined();
    expect(gsiNames(t)).toEqual(['byLandlord', 'byStatus']);
  });

  it('users: PK userId; GSI byEmail', () => {
    const t = spec('users');
    expect(t.hashKey.name).toBe('userId');
    expect(t.rangeKey).toBeUndefined();
    expect(gsiNames(t)).toEqual(['byEmail']);
  });

  it('audit_events: PK entityKey, SK ts; GSI byActor', () => {
    const t = spec('audit_events');
    expect(t.hashKey.name).toBe('entityKey');
    expect(t.rangeKey?.name).toBe('ts');
    expect(gsiNames(t)).toEqual(['byActor']);
  });

  it('tours (Tours feature): PK tourId; GSIs byTenant, byUnit, byScheduledAt (sparse), byStatus; no stream/TTL', () => {
    const t = spec('tours');
    expect(t.hashKey.name).toBe('tourId');
    expect(t.rangeKey).toBeUndefined();
    expect(gsiNames(t)).toEqual(['byTenant', 'byUnit', 'byScheduledAt', 'byStatus']);
    const byTenant = t.gsis.find((g) => g.indexName === 'byTenant');
    expect(byTenant?.hashKey.name).toBe('tenantId');
    expect(byTenant?.rangeKey).toBeUndefined();
    const byUnit = t.gsis.find((g) => g.indexName === 'byUnit');
    expect(byUnit?.hashKey.name).toBe('unitId');
    expect(byUnit?.rangeKey).toBeUndefined();
    const byScheduledAt = t.gsis.find((g) => g.indexName === 'byScheduledAt');
    expect(byScheduledAt?.hashKey.name).toBe('_schedPartition');
    expect(byScheduledAt?.rangeKey?.name).toBe('scheduledAt');
    expect(byScheduledAt?.sparse).toBe(true);
    // byStatus: hash=status, range=createdAt — powers the dashboard queue.
    const byStatus = t.gsis.find((g) => g.indexName === 'byStatus');
    expect(byStatus?.hashKey.name).toBe('status');
    expect(byStatus?.rangeKey?.name).toBe('createdAt');
    expect(byStatus?.sparse).toBeUndefined(); // NOT sparse — every item has a status
    expect(t.stream).toBeUndefined();
    expect(t.ttlAttribute).toBeUndefined();
  });

  it('only messages and placements have streams; only matches has TTL', () => {
    expect(TABLES.filter((t) => t.stream).map((t) => t.baseName)).toEqual(['messages', 'placements']);
    expect(TABLES.filter((t) => t.ttlAttribute).map((t) => t.baseName)).toEqual(['matches']);
  });

  it('getTableSpec throws on unknown base names', () => {
    expect(() => getTableSpec('nope')).toThrow(/Unknown table base name/);
  });
});

describe('tableName — TABLE_PREFIX resolution', () => {
  it('defaults to hc-local- when TABLE_PREFIX is unset', () => {
    expect(tableName('contacts', {})).toBe('hc-local-contacts');
    expect(DEFAULT_TABLE_PREFIX).toBe('hc-local-');
  });

  it('honors TABLE_PREFIX from env (hc-dev-/hc-prod- in M0.4)', () => {
    expect(tableName('audit_events', { TABLE_PREFIX: 'hc-dev-' })).toBe('hc-dev-audit_events');
    expect(tableName('placements', { TABLE_PREFIX: 'hc-prod-' })).toBe('hc-prod-placements');
  });
});
