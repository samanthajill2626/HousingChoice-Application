// gen-tables generator contract: the in-memory tfvars object Terraform
// consumes must carry all 9 tables with the contractual GSI names, the
// matches TTL, streams on messages+cases only, and PITR on everything.
// (tables.test.ts asserts the TABLES source itself; this asserts the
// Terraform-facing projection of it.)
import { describe, expect, it } from 'vitest';
import { buildTablesTfvars, renderTablesTfvarsJson } from '../scripts/gen-tables.js';

const { tables } = buildTablesTfvars();

describe('buildTablesTfvars — Terraform projection of tables.ts', () => {
  it('contains exactly the 9 tables, alphabetically keyed (for_each/state keys)', () => {
    expect(Object.keys(tables)).toEqual([
      'audit_events',
      'cases',
      'contacts',
      'conversations',
      'invoices',
      'matches',
      'messages',
      'units',
      'users',
    ]);
  });

  it('carries the contractual GSI names per table', () => {
    const gsiNames = (base: string) => tables[base]?.gsis.map((g) => g.index_name);
    expect(gsiNames('contacts')).toEqual(['byPhone', 'byTypeStatus', 'byHousingAuthority']);
    expect(gsiNames('units')).toEqual(['byLandlord', 'byStatus', 'byJurisdiction']);
    expect(gsiNames('conversations')).toEqual(['byParticipantPhone', 'byLastActivity']);
    expect(gsiNames('messages')).toEqual([]);
    expect(gsiNames('matches')).toEqual(['byUnit']);
    expect(gsiNames('cases')).toEqual([
      'byTenant',
      'byUnit',
      'byStage',
      'byTourDate',
      'byNextDeadline',
    ]);
    expect(gsiNames('invoices')).toEqual(['byLandlord', 'byStatus']);
    expect(gsiNames('users')).toEqual(['byEmail']);
    expect(gsiNames('audit_events')).toEqual(['byActor']);
  });

  it('keys and GSI keys carry name+type; optional range keys are omitted', () => {
    expect(tables['matches']).toMatchObject({
      hash_key: { name: 'tenantId', type: 'S' },
      range_key: { name: 'unitId', type: 'S' },
    });
    expect(tables['contacts']?.range_key).toBeUndefined();
    const byNextDeadline = tables['cases']?.gsis.find((g) => g.index_name === 'byNextDeadline');
    expect(byNextDeadline).toEqual({
      index_name: 'byNextDeadline',
      hash_key: { name: 'next_deadline_type', type: 'S' },
      range_key: { name: 'next_deadline_at', type: 'S' },
    });
    expect(tables['users']?.gsis[0]?.range_key).toBeUndefined();
  });

  it('TTL only on matches (expires_at)', () => {
    expect(tables['matches']?.ttl_attribute).toBe('expires_at');
    const withTtl = Object.entries(tables).filter(([, t]) => t.ttl_attribute !== undefined);
    expect(withTtl.map(([base]) => base)).toEqual(['matches']);
  });

  it('streams on messages and cases ONLY', () => {
    const streaming = Object.entries(tables)
      .filter(([, t]) => t.stream)
      .map(([base]) => base);
    expect(streaming).toEqual(['cases', 'messages']); // alphabetical key order
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
