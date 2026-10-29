// WP1 B2a S3.5 (spec D1; charter 5; plan WI20): computePool over the in-memory
// world (helpers/rankingFixtures.ts). Property anchor: searching, sendable,
// size, authority, window - every page read, soft-deleted never in, consent a
// flag only. Tenant anchor: available, not deleted, no active placement for a
// DIFFERENT tenant (the anchor's own placement never excludes, WI20), size and
// authority from the property's side, no window. Any record can be the anchor
// (anchor notes, never a refusal); an unreadable org list fails the pool; a
// pool above RANKING_MAX_POOL fails with its size. Pure.
import { describe, expect, it } from 'vitest';
import {
  computePool,
  POOL_MESSAGES,
  rankingAnchorExists,
  readRankingAnchor,
  type PoolResult,
} from '../src/services/ranking/pool.js';
import { ATLANTA, DCA } from './helpers/orgFixtures.js';
import { NOW, ORG_ENTRIES, daysAgo, rankingWorld, tenant, unit } from './helpers/rankingFixtures.js';

const OPTS = { includeOlder: false, now: NOW };

function ok(result: PoolResult): Exclude<PoolResult, { ok: false }> {
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result;
}

function ids(result: PoolResult): string[] {
  const pool = ok(result);
  return pool.kind === 'unit' ? pool.candidates.map((c) => c.contactId) : pool.candidates.map((u) => u.unitId);
}

describe('readRankingAnchor / rankingAnchorExists - the ONE anchor-exists rule (PR21)', () => {
  const w = rankingWorld({
    contacts: [tenant('t1', { status: 'placed' }), tenant('t-deleted', { deleted_at: daysAgo(1) }), { ...tenant('c-landlord'), type: 'landlord' }],
    units: [unit('u1', { status: 'occupied' }), unit('u-deleted', { deleted_at: daysAgo(1) })],
  });

  it('a tenant anchor is a live contact typed tenant, whatever its status', async () => {
    expect(await readRankingAnchor({ kind: 'tenant', id: 't1' }, w.deps)).toEqual({
      kind: 'tenant',
      record: tenant('t1', { status: 'placed' }),
    });
    expect(await rankingAnchorExists({ kind: 'tenant', id: 't1' }, w.deps)).toBe(true);
    for (const id of ['t-nope', 't-deleted', 'c-landlord', 'u1']) {
      expect(await rankingAnchorExists({ kind: 'tenant', id }, w.deps)).toBe(false);
    }
  });

  it('a unit anchor is a live unit of any status', async () => {
    expect(await readRankingAnchor({ kind: 'unit', id: 'u1' }, w.deps)).toEqual({
      kind: 'unit',
      record: unit('u1', { status: 'occupied' }),
    });
    for (const id of ['u-nope', 'u-deleted', 't1']) {
      expect(await rankingAnchorExists({ kind: 'unit', id }, w.deps)).toBe(false);
    }
  });
});

describe('property anchor - tenants are the candidates', () => {
  it('fences: searching, not opted out, not unreachable, a phone, not deleted; consent is no fence', async () => {
    const world = rankingWorld({
      units: [unit('u1')],
      contacts: [
        tenant('t-in'),
        tenant('t-no-consent', { consent_method: undefined }),
        tenant('t-onboarding', { status: 'onboarding' }),
        tenant('t-opted-out', { sms_opt_out: true }),
        tenant('t-unreachable', { sms_unreachable: true }),
        tenant('t-no-phone', { phone: undefined }),
        tenant('t-deleted', { deleted_at: daysAgo(1) }),
        { ...tenant('t-landlord'), type: 'landlord' },
      ],
    });
    expect(ids(await computePool({ kind: 'unit', id: 'u1' }, OPTS, world.deps))).toEqual(['t-in', 't-no-consent']);
  });

  it('a soft-deleted tenant stays out even when a list hands it back (the belt)', async () => {
    const world = rankingWorld({ units: [unit('u1')], contacts: [tenant('t-in'), tenant('t-deleted', { deleted_at: daysAgo(1) })] });
    world.state.leakDeletedInLists = true;
    expect(ids(await computePool({ kind: 'unit', id: 'u1' }, OPTS, world.deps))).toEqual(['t-in']);
  });

  it('reads every page, in ascending id order', async () => {
    const world = rankingWorld({ units: [unit('u1')], contacts: ['t5', 't3', 't1', 't4', 't2'].map((id) => tenant(id)) });
    expect(ids(await computePool({ kind: 'unit', id: 'u1' }, OPTS, world.deps))).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('voucher sizes: recorded, inferred from beds (4 means 4 or more), none takes every size', async () => {
    const contacts = [
      tenant('t-2', { voucherSize: 2 }),
      tenant('t-3', { voucherSize: 3 }),
      tenant('t-4', { voucherSize: 4 }),
      tenant('t-6', { voucherSize: 6 }),
      tenant('t-none', { voucherSize: undefined }),
    ];
    const world = rankingWorld({
      contacts,
      units: [
        unit('u-recorded', { voucher_size_accepted: [2, 3] }),
        unit('u-beds5', { beds: 5 }),
        unit('u-nothing', { beds: undefined }),
      ],
    });
    expect(ids(await computePool({ kind: 'unit', id: 'u-recorded' }, OPTS, world.deps))).toEqual(['t-2', 't-3']);
    expect(ids(await computePool({ kind: 'unit', id: 'u-beds5' }, OPTS, world.deps))).toEqual(['t-4', 't-6']);
    expect(ids(await computePool({ kind: 'unit', id: 'u-nothing' }, OPTS, world.deps))).toEqual(['t-2', 't-3', 't-4', 't-6', 't-none']);
  });

  it('authorities: none mapped is unlimited, some mapped limits to those (case and spacing folded), the mapping is returned', async () => {
    const contacts = [
      tenant('t-atl', { housingAuthority: ATLANTA.name }),
      tenant('t-atl-typed', { housingAuthority: ' atlanta  housing AUTHORITY ' }),
      tenant('t-dca', { housingAuthority: DCA.name }),
      tenant('t-none', { housingAuthority: undefined }),
    ];
    const world = rankingWorld({
      contacts,
      units: [
        unit('u-ambiguous', { accepted_authorities: ['AHA'] }),
        unit('u-limited', { accepted_authorities: [ATLANTA.name, 'Nowhere Board'] }),
        unit('u-empty', { accepted_authorities: [] }),
      ],
    });
    const ambiguous = ok(await computePool({ kind: 'unit', id: 'u-ambiguous' }, OPTS, world.deps));
    expect(ids(ambiguous)).toEqual(['t-atl', 't-atl-typed', 't-dca', 't-none']);
    expect(ambiguous.authorities).toEqual({ mapped: [], unmapped: ['AHA'] });
    const limited = ok(await computePool({ kind: 'unit', id: 'u-limited' }, OPTS, world.deps));
    expect(ids(limited)).toEqual(['t-atl', 't-atl-typed']);
    expect(limited.authorities).toEqual({ mapped: [ATLANTA.name], unmapped: ['Nowhere Board'] });
    expect(ids(await computePool({ kind: 'unit', id: 'u-empty' }, OPTS, world.deps))).toEqual(['t-atl', 't-atl-typed', 't-dca', 't-none']);
  });

  it('the window: heard from, created_at fallback, imported_from never falls back; includeOlder lifts it', async () => {
    const world = rankingWorld({
      units: [unit('u1')],
      contacts: [
        tenant('t-heard-10', { last_heard_from_at: daysAgo(10) }),
        tenant('t-heard-100', { last_heard_from_at: daysAgo(100) }),
        tenant('t-new-10', { last_heard_from_at: undefined, created_at: daysAgo(10) }),
        tenant('t-new-100', { last_heard_from_at: undefined, created_at: daysAgo(100) }),
        tenant('t-imported', { last_heard_from_at: undefined, created_at: daysAgo(5), imported_from: 'quo-airtable-import' }),
      ],
    });
    expect(ids(await computePool({ kind: 'unit', id: 'u1' }, OPTS, world.deps))).toEqual(['t-heard-10', 't-new-10']);
    expect(ids(await computePool({ kind: 'unit', id: 'u1' }, { includeOlder: true, now: NOW }, world.deps))).toEqual([
      't-heard-10',
      't-heard-100',
      't-imported',
      't-new-10',
      't-new-100',
    ]);
  });

  it('a property that is not available is still ranked, with its note', async () => {
    const world = rankingWorld({ units: [unit('u1', { status: 'occupied' })], contacts: [tenant('t1')] });
    const pool = ok(await computePool({ kind: 'unit', id: 'u1' }, OPTS, world.deps));
    expect(pool.anchorNotes).toEqual(['not_available']);
    expect(ids(pool)).toEqual(['t1']);
  });

  it('a missing or soft-deleted property is not found', async () => {
    const world = rankingWorld({ units: [unit('u-deleted', { deleted_at: daysAgo(1) })] });
    for (const id of ['u-nope', 'u-deleted']) {
      expect(await computePool({ kind: 'unit', id }, OPTS, world.deps)).toEqual({
        ok: false,
        reason: 'anchor_not_found',
        message: POOL_MESSAGES.anchorNotFound,
      });
    }
  });

  it('an unreadable organization list fails the pool; it never runs unlimited', async () => {
    const world = rankingWorld({ units: [unit('u1')], contacts: [tenant('t1')] });
    world.state.orgListFails = true;
    expect(await computePool({ kind: 'unit', id: 'u1' }, OPTS, world.deps)).toEqual({
      ok: false,
      reason: 'org_list_failed',
      message: POOL_MESSAGES.orgListFailed,
    });
  });

  it('the ceiling: above RANKING_MAX_POOL fails with its size; at it, ranks', async () => {
    const contacts = [tenant('t1'), tenant('t2'), tenant('t3')];
    const over = rankingWorld({ units: [unit('u1')], contacts, config: { rankingMaxPool: 2 } });
    expect(await computePool({ kind: 'unit', id: 'u1' }, OPTS, over.deps)).toEqual({
      ok: false,
      reason: 'pool_too_large',
      size: 3,
      message: 'Pool too large to rank (3 candidates)',
      anchorRecord: unit('u1'),
      anchor: { kind: 'unit', record: unit('u1') },
      anchorNotes: [],
      orgEntries: ORG_ENTRIES,
    });
    const at = rankingWorld({ units: [unit('u1')], contacts, config: { rankingMaxPool: 3 } });
    expect(ids(await computePool({ kind: 'unit', id: 'u1' }, OPTS, at.deps))).toEqual(['t1', 't2', 't3']);
  });
});

describe('tenant anchor - properties are the candidates', () => {
  it('available, not deleted, no active placement for ANOTHER tenant; the anchor own placement never excludes (WI20)', async () => {
    const world = rankingWorld({
      contacts: [tenant('t1')],
      units: [
        unit('u-a'),
        unit('u-occupied', { status: 'occupied' }),
        unit('u-deleted', { deleted_at: daysAgo(1) }),
        unit('u-other', {}),
        unit('u-mine', {}),
      ],
      activePlacements: [
        { unitId: 'u-other', tenantId: 't-someone-else' },
        { unitId: 'u-mine', tenantId: 't1' },
      ],
    });
    expect(ids(await computePool({ kind: 'tenant', id: 't1' }, OPTS, world.deps))).toEqual(['u-a', 'u-mine']);
    expect(world.calls.placementChecks.map(([unitId, tenantId]) => `${unitId}:${tenantId}`).sort()).toEqual([
      'u-a:t1',
      'u-mine:t1',
      'u-other:t1',
    ]);
  });

  it("the size and authority rules read from the property's side, with the anchor's size and authority", async () => {
    const world = rankingWorld({
      contacts: [tenant('t1', { voucherSize: 2, housingAuthority: ATLANTA.name })],
      units: [
        unit('u-fits'),
        unit('u-size3', { voucher_size_accepted: [3] }),
        unit('u-dca', { accepted_authorities: [DCA.name] }),
        unit('u-ambiguous', { accepted_authorities: ['AHA'] }),
      ],
    });
    expect(ids(await computePool({ kind: 'tenant', id: 't1' }, OPTS, world.deps))).toEqual(['u-ambiguous', 'u-fits']);
    expect(world.calls.placementChecks.map(([unitId]) => unitId).sort()).toEqual(['u-ambiguous', 'u-fits']);
  });

  it('any tenant can be the anchor: notes for the banner, no window, includeOlder ignored', async () => {
    const world = rankingWorld({
      contacts: [tenant('t1', { status: 'onboarding', sms_opt_out: true, last_heard_from_at: daysAgo(400) })],
      units: [unit('u1')],
    });
    const pool = ok(await computePool({ kind: 'tenant', id: 't1' }, OPTS, world.deps));
    expect(pool.anchorNotes).toEqual(['not_searching', 'not_sendable']);
    expect(pool.authorities).toEqual({ mapped: [], unmapped: [] });
    expect(ids(pool)).toEqual(['u1']);
    expect(ids(await computePool({ kind: 'tenant', id: 't1' }, { includeOlder: true, now: NOW }, world.deps))).toEqual(['u1']);
  });

  it('a missing, soft-deleted or non-tenant contact is not found', async () => {
    const world = rankingWorld({
      contacts: [tenant('t-deleted', { deleted_at: daysAgo(1) }), { ...tenant('c-landlord'), type: 'landlord' }],
      units: [unit('u1')],
    });
    for (const id of ['t-nope', 't-deleted', 'c-landlord']) {
      expect(await computePool({ kind: 'tenant', id }, OPTS, world.deps)).toMatchObject({ ok: false, reason: 'anchor_not_found' });
    }
  });

  it('the org-list failure and the ceiling apply to a tenant anchor too', async () => {
    const failing = rankingWorld({ contacts: [tenant('t1')], units: [unit('u1')] });
    failing.state.orgListFails = true;
    expect(await computePool({ kind: 'tenant', id: 't1' }, OPTS, failing.deps)).toMatchObject({ ok: false, reason: 'org_list_failed' });
    const over = rankingWorld({ contacts: [tenant('t1')], units: [unit('u1'), unit('u2')], config: { rankingMaxPool: 1 } });
    expect(await computePool({ kind: 'tenant', id: 't1' }, OPTS, over.deps)).toMatchObject({
      ok: false,
      reason: 'pool_too_large',
      size: 2,
      message: 'Pool too large to rank (2 candidates)',
      anchor: { kind: 'tenant', record: tenant('t1') },
      anchorNotes: [],
      orgEntries: ORG_ENTRIES,
    });
  });
});
