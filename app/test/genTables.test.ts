// gen-tables generator contract: the in-memory tfvars object Terraform
// consumes must carry all 9 tables with the contractual GSI names, the
// matches TTL, streams on messages+placements only, and PITR on everything.
// (tables.test.ts asserts the TABLES source itself; this asserts the
// Terraform-facing projection of it.)
import { describe, expect, it } from 'vitest';
import { buildTablesTfvars, renderTablesTfvarsJson } from '../scripts/gen-tables.js';

const { tables } = buildTablesTfvars();

describe('buildTablesTfvars — Terraform projection of tables.ts', () => {
  it('contains the 9 doc-§5 tables plus settings (M1.4) + pool_numbers (M1.7) + broadcasts (M1.8a) + activity_events (BE2) + listing_sends (BE4) + tours + tourReminders (Tours feature) + placementNudges (Post-Tour & Application), alphabetically keyed (for_each/state keys)', () => {
    expect(Object.keys(tables)).toEqual([
      'activity_events',
      'audit_events',
      'broadcasts',
      'contacts',
      'conversations',
      'invoices',
      'listing_sends',
      'matches',
      'messages',
      'placementDeadlines',
      'placementNudges',
      'placements',
      'pool_numbers',
      'settings',
      'tourReminders',
      'tours',
      'units',
      'users',
    ]);
  });

  it('activity_events (BE2/C2): PK contactId + SK tsEventId; no GSIs, no stream/TTL', () => {
    expect(tables['activity_events']).toEqual({
      hash_key: { name: 'contactId', type: 'S' },
      range_key: { name: 'tsEventId', type: 'S' },
      gsis: [],
      stream: false,
      pitr: true,
    });
  });

  it('listing_sends (BE4/C4): PK unitId + SK contactId; GSI byContact (contactId + sentAt); no stream/TTL', () => {
    expect(tables['listing_sends']).toEqual({
      hash_key: { name: 'unitId', type: 'S' },
      range_key: { name: 'contactId', type: 'S' },
      gsis: [
        {
          index_name: 'byContact',
          hash_key: { name: 'contactId', type: 'S' },
          range_key: { name: 'sentAt', type: 'S' },
        },
      ],
      stream: false,
      pitr: true,
    });
  });

  it('broadcasts (M1.8a): PK broadcastId; GSIs byCreated (team-wide list) + byUnit; no stream/TTL', () => {
    expect(tables['broadcasts']).toEqual({
      hash_key: { name: 'broadcastId', type: 'S' },
      gsis: [
        {
          // The team-wide list feed: constant partition + created_at sort.
          // Replaced byStatus + byCreatedAt (2026-07-08) — see tables.ts.
          index_name: 'byCreated',
          hash_key: { name: '_listPartition', type: 'S' },
          range_key: { name: 'created_at', type: 'S' },
        },
        {
          // Prior-recipients lookup (Broadcasts dashboard). Sparse in tables.ts,
          // but the tfvars GSI shape carries no `sparse` field (the module emits
          // none — sparseness is a data convention, not a schema attribute).
          index_name: 'byUnit',
          hash_key: { name: 'unitId', type: 'S' },
        },
      ],
      stream: false,
      pitr: true,
    });
  });

  it('pool_numbers (M1.7): PK poolNumber; GSI byLifecycleState (lifecycle_state + quarantine_until); no stream/TTL', () => {
    expect(tables['pool_numbers']).toEqual({
      hash_key: { name: 'poolNumber', type: 'S' },
      gsis: [
        {
          index_name: 'byLifecycleState',
          hash_key: { name: 'lifecycle_state', type: 'S' },
          range_key: { name: 'quarantine_until', type: 'S' },
        },
      ],
      stream: false,
      pitr: true,
    });
  });

  it('settings: PK settingId, no GSIs, no stream, no TTL (M1.4 founder-templates home)', () => {
    expect(tables['settings']).toEqual({
      hash_key: { name: 'settingId', type: 'S' },
      gsis: [],
      stream: false,
      pitr: true,
    });
  });

  it('tours (Tours feature): PK tourId; GSIs byTenant, byUnit, byScheduledAt (sparse), byStatus; no stream/TTL', () => {
    expect(tables['tours']).toEqual({
      hash_key: { name: 'tourId', type: 'S' },
      gsis: [
        {
          index_name: 'byTenant',
          hash_key: { name: 'tenantId', type: 'S' },
        },
        {
          index_name: 'byUnit',
          hash_key: { name: 'unitId', type: 'S' },
        },
        {
          // Sparse time-window GSI: fixed partition '_schedPartition' + range
          // 'scheduledAt'. Sparse flag is a data convention only (not in tfvars).
          index_name: 'byScheduledAt',
          hash_key: { name: '_schedPartition', type: 'S' },
          range_key: { name: 'scheduledAt', type: 'S' },
        },
        {
          // Status queue GSI: hash=status, range=createdAt. Powers
          // listByStatus() for the dashboard queue (e.g. all 'requested' tours).
          index_name: 'byStatus',
          hash_key: { name: 'status', type: 'S' },
          range_key: { name: 'createdAt', type: 'S' },
        },
      ],
      stream: false,
      pitr: true,
    });
  });

  it('carries the contractual GSI names per table', () => {
    const gsiNames = (base: string) => tables[base]?.gsis.map((g) => g.index_name);
    expect(gsiNames('contacts')).toEqual(['byPhone', 'byTypeStatus', 'byHousingAuthority']);
    expect(gsiNames('units')).toEqual(['byLandlord', 'byStatus', 'byJurisdiction', 'byProperty']);
    expect(gsiNames('conversations')).toEqual([
      'byParticipantPhone',
      'byLastActivity',
      'byPoolNumber',
      'byRelayStatus',
    ]);
    expect(gsiNames('messages')).toEqual([]);
    expect(gsiNames('matches')).toEqual(['byUnit']);
    expect(gsiNames('placements')).toEqual([
      'byTenant',
      'byUnit',
      'byStage',
      'byTourDate',
    ]);
    expect(gsiNames('placementDeadlines')).toEqual(['byPlacement', 'byDueAt']);
    expect(gsiNames('invoices')).toEqual(['byLandlord', 'byStatus']);
    expect(gsiNames('users')).toEqual(['byEmail']);
    expect(gsiNames('audit_events')).toEqual(['byActor']);
    expect(gsiNames('tours')).toEqual(['byTenant', 'byUnit', 'byScheduledAt', 'byStatus']);
  });

  it('keys and GSI keys carry name+type; optional range keys are omitted', () => {
    expect(tables['matches']).toMatchObject({
      hash_key: { name: 'tenantId', type: 'S' },
      range_key: { name: 'unitId', type: 'S' },
    });
    expect(tables['contacts']?.range_key).toBeUndefined();
    const byDueAt = tables['placementDeadlines']?.gsis.find((g) => g.index_name === 'byDueAt');
    expect(byDueAt).toEqual({
      index_name: 'byDueAt',
      hash_key: { name: '_deadlinePartition', type: 'S' },
      range_key: { name: 'at', type: 'S' },
    });
    expect(tables['users']?.gsis[0]?.range_key).toBeUndefined();
  });

  it('TTL only on matches (expires_at)', () => {
    expect(tables['matches']?.ttl_attribute).toBe('expires_at');
    const withTtl = Object.entries(tables).filter(([, t]) => t.ttl_attribute !== undefined);
    expect(withTtl.map(([base]) => base)).toEqual(['matches']);
  });

  it('streams on messages and placements ONLY', () => {
    const streaming = Object.entries(tables)
      .filter(([, t]) => t.stream)
      .map(([base]) => base);
    expect(streaming).toEqual(['messages', 'placements']); // alphabetical key order
  });

  it('PITR true for every table', () => {
    for (const t of Object.values(tables)) expect(t.pitr).toBe(true);
  });

  it('renders deterministically with a trailing newline', () => {
    const a = renderTablesTfvarsJson();
    expect(a).toBe(renderTablesTfvarsJson());
    expect(a.endsWith('}\n')).toBe(true);
    expect(JSON.parse(a)).toEqual({ tables });
  });
});
