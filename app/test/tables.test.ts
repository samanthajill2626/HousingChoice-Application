// M0.3 contract tests for lib/tables.ts: all 9 tables, exact PK/SK and GSI
// names per architecture doc v2.12 §5 (p.11–12), streams on messages+cases,
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
  it('defines the 9 doc-§5 tables plus settings (M1.4), pool_numbers (M1.7), broadcasts (M1.8a)', () => {
    expect(TABLES.map((t) => t.baseName)).toEqual([
      'contacts',
      'units',
      'conversations',
      'messages',
      'matches',
      'cases',
      'invoices',
      'users',
      'audit_events',
      'settings',
      'pool_numbers',
      'broadcasts',
    ]);
  });

  it('broadcasts (M1.8a): PK broadcastId; GSIs byStatus (status), byCreatedAt (created_by + created_at); no stream/TTL', () => {
    const t = spec('broadcasts');
    expect(t.hashKey.name).toBe('broadcastId');
    expect(t.rangeKey).toBeUndefined();
    expect(gsiNames(t)).toEqual(['byStatus', 'byCreatedAt']);
    const byStatus = t.gsis.find((g) => g.indexName === 'byStatus');
    expect(byStatus?.hashKey.name).toBe('status');
    expect(byStatus?.rangeKey).toBeUndefined();
    const byCreatedAt = t.gsis.find((g) => g.indexName === 'byCreatedAt');
    expect(byCreatedAt?.hashKey.name).toBe('created_by');
    expect(byCreatedAt?.rangeKey?.name).toBe('created_at');
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

  it('units: PK unitId; GSIs byLandlord, byStatus, byJurisdiction', () => {
    const t = spec('units');
    expect(t.hashKey.name).toBe('unitId');
    expect(t.rangeKey).toBeUndefined();
    expect(gsiNames(t)).toEqual(['byLandlord', 'byStatus', 'byJurisdiction']);
  });

  it('conversations: PK conversationId; GSIs byParticipantPhone, byLastActivity, byPoolNumber (M1.7)', () => {
    const t = spec('conversations');
    expect(t.hashKey.name).toBe('conversationId');
    expect(t.rangeKey).toBeUndefined();
    expect(gsiNames(t)).toEqual(['byParticipantPhone', 'byLastActivity', 'byPoolNumber']);
    expect(t.gsis.find((g) => g.indexName === 'byPoolNumber')?.sparse).toBe(true);
    expect(t.gsis.find((g) => g.indexName === 'byPoolNumber')?.hashKey.name).toBe('pool_number');
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

  it('cases: PK caseId; GSIs byTenant, byUnit, byStage, byTourDate (sparse), byNextDeadline (sparse); stream on', () => {
    const t = spec('cases');
    expect(t.hashKey.name).toBe('caseId');
    expect(t.rangeKey).toBeUndefined();
    expect(gsiNames(t)).toEqual(['byTenant', 'byUnit', 'byStage', 'byTourDate', 'byNextDeadline']);
    expect(t.gsis.find((g) => g.indexName === 'byTourDate')?.sparse).toBe(true);
    expect(t.gsis.find((g) => g.indexName === 'byNextDeadline')?.sparse).toBe(true);
    // doc-specified deadline attributes (§5: "next_deadline_at/type")
    const byNextDeadline = t.gsis.find((g) => g.indexName === 'byNextDeadline');
    expect(byNextDeadline?.hashKey.name).toBe('next_deadline_type');
    expect(byNextDeadline?.rangeKey?.name).toBe('next_deadline_at');
    expect(t.stream).toBe('NEW_AND_OLD_IMAGES');
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

  it('only messages and cases have streams; only matches has TTL', () => {
    expect(TABLES.filter((t) => t.stream).map((t) => t.baseName)).toEqual(['messages', 'cases']);
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
    expect(tableName('cases', { TABLE_PREFIX: 'hc-prod-' })).toBe('hc-prod-cases');
  });
});
