// WP1 B2a S3.11 (spec D1, D2.3, D9; plan PR3, WI12): assembleRanking over the
// in-memory world. It computes the pool, then each candidate's card inputs
// with at most RANKING_READ_CONCURRENCY in flight: one listByContact, one
// listByTenant and ONE units batch read per tenant card (plus one landlord
// read with the switch on). A candidate whose own reads fail is returned in
// place as `unverified` (never read as "not on file"); a failure of the
// anchor's own reads fails the whole result. Every card is built by
// tenantCard / propertyCard through the two sides (WI12). Pure.
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { RepoDeps } from '../src/repos/conversationsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import {
  ASSEMBLE_MESSAGES,
  assembleRanking,
  buildPropertySide,
  buildTenantSide,
  createAssembleDeps,
  loadPropertyFacts,
  poolTooLargeMissing,
  propertyDisplay,
  tenantDisplay,
  type AssembledCandidate,
  type AssembleResult,
  type SideCtx,
  type VerifiedCandidate,
} from '../src/services/ranking/assemble.js';
import { propertyCard, propertyFacts } from '../src/services/ranking/cards.js';
import { propertyMissing, tenantMissing } from '../src/services/ranking/completeness.js';
import { pairHistoryFingerprint } from '../src/services/ranking/fingerprints.js';
import { POOL_MESSAGES } from '../src/services/ranking/pool.js';
import { NO_ADDRESS_LABEL } from '../src/services/ranking/seenSet.js';
import { ATLANTA } from './helpers/orgFixtures.js';
import {
  DEFAULT_TEST_CONFIG,
  NOW,
  ORG_ENTRIES,
  daysAgo,
  rankingWorld,
  sendRow,
  tenant,
  unit,
  type WorldSeed,
} from './helpers/rankingFixtures.js';

const OPTS = { includeOlder: false, now: NOW };
const OFF = { orgEntries: ORG_ENTRIES, landlordCard: false };
const SIDE_CTX: SideCtx = { now: NOW, seenMax: 8, orgEntries: ORG_ENTRIES, landlordCard: false };

const U1 = unit('u1', { priority: true });
const U2 = unit('u2');
const U3 = unit('u3');
const T1 = tenant('t1');
const T2 = tenant('t2', { consent_method: undefined });
const T3 = tenant('t3');
const S_T1_U1 = sendRow('u1', 't1', [{ at: daysAgo(8) }], { declined: { at: daysAgo(5), by: 'staff' } });
const S_T1_U2 = sendRow('u2', 't1', [{ at: daysAgo(4) }]);
const S_T2_U3 = sendRow('u3', 't2', [{ at: daysAgo(2) }]);
const LANDLORD_1: ContactItem = { contactId: 'contact-landlord-1', type: 'landlord', req_qualifications: 'No smoking' };

function world(extra: { units?: UnitItem[]; contacts?: ContactItem[]; config?: WorldSeed['config'] } = {}) {
  return rankingWorld({
    contacts: [T1, T2, T3, LANDLORD_1, ...(extra.contacts ?? [])],
    units: extra.units ?? [U1, U2, U3],
    sends: [S_T1_U1, S_T1_U2, S_T2_U3],
    config: extra.config,
  });
}

function ok(result: AssembleResult): Extract<AssembleResult, { ok: true }> {
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result;
}

function verified(candidate: AssembledCandidate | undefined): VerifiedCandidate {
  if (candidate === undefined || candidate.unverified) throw new Error('expected a verified candidate');
  return candidate;
}

describe('property anchor - the tenants of one property', () => {
  it('assembles the anchor and every candidate in pool order from tenantCard and propertyCard (WI12)', async () => {
    const w = world();
    const result = ok(await assembleRanking({ kind: 'unit', id: 'u1' }, OPTS, w.deps));
    const anchorSide = buildPropertySide(U1, OFF);
    expect(result.direction).toBe('tenants_for_property');
    expect(result.anchor).toEqual({
      ref: { kind: 'unit', id: 'u1' },
      record: U1,
      display: 'u1 Main St, Decatur',
      card: anchorSide.card,
      missing: anchorSide.missing,
      anchorNotes: [],
      fingerprint: anchorSide.fingerprint,
      propertyFacts: anchorSide.facts,
      authorities: { mapped: [ATLANTA.name], unmapped: [] },
    });
    expect(result.candidates.map((c) => [c.candidateId, c.tenantId, c.unitId, c.unverified, c.display, c.hasConsent])).toEqual([
      ['t1', 't1', 'u1', false, 'Pat t1', true],
      ['t2', 't2', 'u1', false, 'Pat t2', false],
      ['t3', 't3', 'u1', false, 'Pat t3', true],
    ]);
    const t1Side = buildTenantSide(
      T1,
      { sends: [S_T1_U1, S_T1_U2], tours: [], units: new Map([['u1', U1], ['u2', U2]]), landlords: new Map() },
      SIDE_CTX,
    );
    const c1 = verified(result.candidates[0]);
    expect(c1.card).toEqual(t1Side.card);
    expect(c1.missing).toEqual(t1Side.missing);
    expect(c1.pairHistory).toEqual({
      sends: [{ at: daysAgo(8), kind: 'sent' }],
      declined: { by: 'staff', at: daysAgo(5) },
      tours: [],
      daysSinceLastSend: 8,
    });
    expect(c1.fingerprints).toEqual({
      tenantCard: t1Side.fingerprint,
      unitCard: anchorSide.fingerprint,
      pairHistory: pairHistoryFingerprint(c1.pairHistory),
    });
    expect(c1.propertyFacts).toEqual(anchorSide.facts);
    // Charter section 20 item 18: the anchor maps ATLANTA, so the pool fenced every candidate: matched.
    expect(result.candidates.map((c) => verified(c).authority)).toEqual(['matched', 'matched', 'matched']);
    expect(c1.card).not.toHaveProperty('housingAuthority');
    expect(result.anchor.card).not.toHaveProperty('authorities');
    expect(verified(result.candidates[2]).pairHistory).toEqual({ sends: [], declined: null, tours: [], daysSinceLastSend: null });
    expect([...result.homes.keys()]).toEqual(['u1', 'u2', 'u3']);
    expect(result.homes.get('u3')).toEqual({ label: 'u3 Main St, Decatur', card: propertyCard(U3, OFF) });
    expect(result.unverifiedCount).toBe(0);
  });

  it('reads each tenant card with one sends read and ONE units batch read for its whole seen set', async () => {
    const w = world();
    await assembleRanking({ kind: 'unit', id: 'u1' }, OPTS, w.deps);
    expect([...w.calls.listByContact].sort()).toEqual(['t1', 't2', 't3']);
    expect(w.calls.unitBatchReads.map((ids) => ids.join(',')).sort()).toEqual(['u1,u2', 'u3']);
  });

  it('an incomplete units read leaves only that candidate unverified, never "not on file"', async () => {
    const w = world();
    w.state.incompleteIds.add('u3');
    const result = ok(await assembleRanking({ kind: 'unit', id: 'u1' }, OPTS, w.deps));
    expect(result.candidates[1]).toEqual({
      tenantId: 't2',
      unitId: 'u1',
      candidateId: 't2',
      display: 'Pat t2',
      record: T2,
      hasConsent: false,
      unverified: true,
      card: null,
      missing: null,
      pairHistory: null,
      fingerprints: null,
      propertyFacts: buildPropertySide(U1, OFF).facts,
    });
    expect(result.candidates.map((c) => c.unverified)).toEqual([false, true, false]);
    expect([...result.homes.keys()]).toEqual(['u1', 'u2']);
    expect(result.unverifiedCount).toBe(1);
  });

  it('PR17: a failed tours read leaves that candidate unverified; assembleRanking never throws for a candidate', async () => {
    const w = world();
    w.state.failingTourReads.add('t1');
    const result = ok(await assembleRanking({ kind: 'unit', id: 'u1' }, OPTS, w.deps));
    expect(result.candidates.map((c) => [c.candidateId, c.unverified])).toEqual([
      ['t1', true],
      ['t2', false],
      ['t3', false],
    ]);
    expect([...result.homes.keys()]).toEqual(['u3']);
  });

  it('IR7: the display is always a string - a name else the contactId; a label, else a stored address string (WL-S3-3), else the no-address placeholder', async () => {
    const noAddress = unit('u-noaddress', { address: undefined });
    const noName = tenant('t-noname', { firstName: undefined, lastName: undefined });
    const w = world({ units: [U1, U2, U3, noAddress], contacts: [noName] });
    const result = ok(await assembleRanking({ kind: 'unit', id: 'u-noaddress' }, OPTS, w.deps));
    expect(result.anchor.display).toBe(NO_ADDRESS_LABEL);
    expect(result.candidates.find((c) => c.candidateId === 't-noname')?.display).toBe('t-noname');
    expect(tenantDisplay(T1)).toBe('Pat t1');
    expect(propertyDisplay(U1)).toBe('u1 Main St, Decatur');
  });

  it('WL-S3-3: a legacy string address displays as stored, trimmed; the label the model sees and the attach step are unchanged', async () => {
    const legacy = { ...unit('u-legacy'), address: '  9 Old Rd, Atlanta, GA 30310  ' } as unknown as UnitItem;
    const blank = { ...unit('u-blank'), address: '   ' } as unknown as UnitItem;
    expect(propertyDisplay(legacy)).toBe('9 Old Rd, Atlanta, GA 30310');
    expect(propertyDisplay(blank)).toBe(NO_ADDRESS_LABEL);
    const named = tenant('t1', { notes: '9 Old Rd, Atlanta, GA 30310: liked the yard' });
    const w = rankingWorld({ contacts: [named], units: [legacy], sends: [sendRow('u-legacy', 't1', [{ at: daysAgo(2) }])] });
    const asAnchor = ok(await assembleRanking({ kind: 'unit', id: 'u-legacy' }, OPTS, w.deps));
    expect(asAnchor.anchor.display).toBe('9 Old Rd, Atlanta, GA 30310');
    expect(asAnchor.homes.get('u-legacy')?.label).toBe(NO_ADDRESS_LABEL);
    const asCandidate = ok(await assembleRanking({ kind: 'tenant', id: 't1' }, OPTS, w.deps));
    expect(asCandidate.candidates.map((c) => [c.candidateId, c.display])).toEqual([['u-legacy', '9 Old Rd, Atlanta, GA 30310']]);
    expect(asCandidate.homes.get('u-legacy')?.label).toBe(NO_ADDRESS_LABEL);
    expect(asCandidate.anchor.card['notes']).toBe('9 Old Rd, Atlanta, GA 30310: liked the yard');
  });

  it('a failed sends read leaves that candidate unverified too', async () => {
    const w = world();
    w.state.failingSendReads.add('t3');
    const result = ok(await assembleRanking({ kind: 'unit', id: 'u1' }, OPTS, w.deps));
    expect(result.candidates.map((c) => [c.candidateId, c.unverified])).toEqual([
      ['t1', false],
      ['t2', false],
      ['t3', true],
    ]);
    expect(result.unverifiedCount).toBe(1);
  });

  it('runs at most RANKING_READ_CONCURRENCY candidate reads at once', async () => {
    const many = ['t4', 't5', 't6'].map((id) => tenant(id));
    const w = world({ contacts: many, config: { rankingReadConcurrency: 2 } });
    w.state.sendReadDelayMs = 5;
    await assembleRanking({ kind: 'unit', id: 'u1' }, OPTS, w.deps);
    expect(w.calls.listByContact).toHaveLength(6);
    expect(w.calls.maxInFlightSendReads).toBe(2);
  });

  it('a pool failure passes through and no card is read', async () => {
    const failing = world();
    failing.state.orgListFails = true;
    expect(await assembleRanking({ kind: 'unit', id: 'u1' }, OPTS, failing.deps)).toEqual({
      ok: false,
      reason: 'org_list_failed',
      message: POOL_MESSAGES.orgListFailed,
    });
    expect(failing.calls.listByContact).toEqual([]);
    const tooMany = world({ config: { rankingMaxPool: 1 } });
    expect(await assembleRanking({ kind: 'unit', id: 'u1' }, OPTS, tooMany.deps)).toMatchObject({ ok: false, reason: 'pool_too_large', size: 3 });
    expect(tooMany.calls.listByContact).toEqual([]);
    expect(await assembleRanking({ kind: 'unit', id: 'u-nope' }, OPTS, world().deps)).toMatchObject({ ok: false, reason: 'anchor_not_found' });
  });
});

describe('tenant anchor - the properties of one tenant', () => {
  it('assembles the anchor card once and every property candidate with its own card, facts and priority', async () => {
    const w = world({ units: [U1, U2, unit('u3', { status: 'occupied' })] });
    const result = ok(await assembleRanking({ kind: 'tenant', id: 't1' }, OPTS, w.deps));
    const anchorSide = buildTenantSide(
      T1,
      { sends: [S_T1_U1, S_T1_U2], tours: [], units: new Map([['u1', U1], ['u2', U2]]), landlords: new Map() },
      SIDE_CTX,
    );
    expect(result.direction).toBe('properties_for_tenant');
    expect(result.anchor).toEqual({
      ref: { kind: 'tenant', id: 't1' },
      record: T1,
      display: 'Pat t1',
      card: anchorSide.card,
      missing: anchorSide.missing,
      anchorNotes: [],
      fingerprint: anchorSide.fingerprint,
      propertyFacts: null,
      authorities: { mapped: [], unmapped: [] },
    });
    expect(result.candidates.map((c) => [c.candidateId, c.tenantId, c.unitId, c.unverified, c.display, c.priority])).toEqual([
      ['u1', 't1', 'u1', false, 'u1 Main St, Decatur', true],
      ['u2', 't1', 'u2', false, 'u2 Main St, Decatur', false],
    ]);
    const c1 = verified(result.candidates[0]);
    expect(c1.card).toEqual(propertyCard(U1, OFF));
    expect(c1.propertyFacts).toEqual(propertyFacts(U1, OFF));
    expect(c1.pairHistory.declined).toEqual({ by: 'staff', at: daysAgo(5) });
    expect(c1.fingerprints).toEqual({
      tenantCard: anchorSide.fingerprint,
      unitCard: buildPropertySide(U1, OFF).fingerprint,
      pairHistory: pairHistoryFingerprint(c1.pairHistory),
    });
    expect([...result.homes.keys()]).toEqual([...anchorSide.homes.keys()]);
  });

  it('charter section 20 item 18: each property candidate carries its own pair authority fact; no card names an authority', async () => {
    // u1 accepts the tenant's mapped authority (the pool fenced it: matched);
    // u2 records only a name the organization list does not know (the pool did
    // not fence it: unconfirmed).
    const w = world({ units: [U1, unit('u2', { accepted_authorities: ['Nowhere Board'] })] });
    const result = ok(await assembleRanking({ kind: 'tenant', id: 't1' }, OPTS, w.deps));
    expect(result.candidates.map((c) => [c.candidateId, verified(c).authority])).toEqual([
      ['u1', 'matched'],
      ['u2', 'unconfirmed'],
    ]);
    expect(result.anchor.card).not.toHaveProperty('housingAuthority');
    for (const c of result.candidates) expect(verified(c).card).not.toHaveProperty('authorities');
  });

  it("an incomplete read of the anchor's own seen units fails the whole result", async () => {
    const w = world();
    w.state.incompleteIds.add('u2');
    expect(await assembleRanking({ kind: 'tenant', id: 't1' }, OPTS, w.deps)).toEqual({
      ok: false,
      reason: 'anchor_unreadable',
      message: ASSEMBLE_MESSAGES.anchorUnreadable,
      candidateIds: ['u1', 'u2', 'u3'],
    });
  });

  it('PR38: the unreadable tenant anchor carries the computed pool unit ids, in pool order', async () => {
    const w = world({ units: [U1, U2, unit('u3', { status: 'occupied' }), unit('u4')] });
    w.state.failingTourReads.add('t1');
    const result = await assembleRanking({ kind: 'tenant', id: 't1' }, OPTS, w.deps);
    expect(result).toMatchObject({ ok: false, reason: 'anchor_unreadable', candidateIds: ['u1', 'u2', 'u4'] });
  });
});

describe('poolTooLargeMissing - the anchor gaps over the ceiling (FB4, PR16)', () => {
  it('a property anchor: propertyMissing with the pool organization list; a tenant anchor: tenantMissing', async () => {
    const w = world({ config: { rankingMaxPool: 1 } });
    const overUnit = await assembleRanking({ kind: 'unit', id: 'u1' }, OPTS, w.deps);
    if (overUnit.ok || overUnit.reason !== 'pool_too_large') throw new Error('expected pool_too_large');
    expect(await poolTooLargeMissing(overUnit, w.deps)).toEqual(propertyMissing(U1, OFF));
    const overTenant = await assembleRanking({ kind: 'tenant', id: 't1' }, OPTS, w.deps);
    if (overTenant.ok || overTenant.reason !== 'pool_too_large') throw new Error('expected pool_too_large');
    expect(await poolTooLargeMissing(overTenant, w.deps)).toEqual(tenantMissing(T1));
  });

  it("switch on: reads the property anchor's landlord; a landlord read that cannot finish throws", async () => {
    const w = world({ config: { rankingMaxPool: 1, rankingLandlordCard: true } });
    const over = await assembleRanking({ kind: 'unit', id: 'u1' }, OPTS, w.deps);
    if (over.ok || over.reason !== 'pool_too_large') throw new Error('expected pool_too_large');
    expect(await poolTooLargeMissing(over, w.deps)).toEqual(
      propertyMissing(U1, { orgEntries: ORG_ENTRIES, landlordCard: true, landlord: LANDLORD_1 }),
    );
    w.state.incompleteIds.add('contact-landlord-1');
    await expect(poolTooLargeMissing(over, w.deps)).rejects.toBeInstanceOf(IncompleteBatchReadError);
  });

  it('any other failure carries no anchor gaps', async () => {
    const w = world();
    w.state.orgListFails = true;
    const failed = await assembleRanking({ kind: 'unit', id: 'u1' }, OPTS, w.deps);
    if (failed.ok || failed.reason !== 'org_list_failed') throw new Error('expected org_list_failed');
    expect(await poolTooLargeMissing(failed, w.deps)).toEqual([]);
  });
});

describe('loadPropertyFacts - the run detail open-flag facts (IR9)', () => {
  it('reads the distinct ids in one complete read and answers each found unit facts', async () => {
    const w = world();
    const facts = await loadPropertyFacts(['u2', 'u1', 'u2', 'u-nope'], w.deps);
    expect([...facts.keys()].sort()).toEqual(['u1', 'u2']);
    expect(facts.get('u1')).toEqual(propertyFacts(U1, OFF));
    expect(w.calls.unitBatchReads).toEqual([['u-nope', 'u1', 'u2']]);
  });

  it('switch on: a landlord default counts as recorded and its text is the landlord: twin', async () => {
    const w = world({ config: { rankingLandlordCard: true } });
    const facts = await loadPropertyFacts(['u1'], w.deps);
    expect(facts.get('u1')?.recordedRequirementKeys).toContain('qualifications');
    expect(facts.get('u1')?.freeTextByField['landlord:qualifications']).toBe('No smoking');
  });

  it('an incomplete read throws; no ids reads nothing', async () => {
    const w = world();
    w.state.incompleteIds.add('u1');
    await expect(loadPropertyFacts(['u1'], w.deps)).rejects.toBeInstanceOf(IncompleteBatchReadError);
    const quiet = world();
    expect((await loadPropertyFacts([], quiet.deps)).size).toBe(0);
    expect(quiet.calls.unitBatchReads).toEqual([]);
  });
});

describe('createAssembleDeps - the production deps (IR9)', () => {
  it('builds every repo the gatherer reads on the given env and doc, passing config and logger through', async () => {
    const tables: string[] = [];
    const doc = {
      async send(command: { input: { TableName?: string } }) {
        tables.push(command.input.TableName ?? '');
        return {};
      },
    } as unknown as NonNullable<RepoDeps['doc']>;
    const config = { ...DEFAULT_TEST_CONFIG } as unknown as AppConfig;
    const logger = createLogger({ level: 'silent' });
    const deps = createAssembleDeps({ config, logger, doc, env: { TABLE_PREFIX: 'hc-test-assemble-' } });
    expect(deps.config).toBe(config);
    expect(deps.logger).toBe(logger);
    for (const fn of [
      deps.contacts.getById,
      deps.contacts.listByType,
      deps.contacts.getManyByIds,
      deps.units.getById,
      deps.units.listByStatus,
      deps.units.getManyByIds,
      deps.placements.hasActivePlacementForOtherTenant,
      deps.listingSends.listByContact,
      deps.tours.listByTenant,
      deps.orgNames.read,
    ]) {
      expect(typeof fn).toBe('function');
    }
    expect(await deps.contacts.getById('c1')).toBeUndefined();
    expect(await deps.units.getById('u1')).toBeUndefined();
    expect(tables).toEqual(['hc-test-assemble-contacts', 'hc-test-assemble-units']);
  });
});

describe('the landlord card switch on (spec D2.1)', () => {
  it("puts the landlord's defaults on the anchor card and on every seen home's card", async () => {
    const w = world({ config: { rankingLandlordCard: true } });
    const result = ok(await assembleRanking({ kind: 'unit', id: 'u1' }, OPTS, w.deps));
    expect(result.anchor.card['landlordDefaults']).toEqual({ qualifications: 'No smoking' });
    expect(result.homes.get('u2')?.card['landlordDefaults']).toEqual({ qualifications: 'No smoking' });
    expect(result.anchor.propertyFacts?.recordedRequirementKeys).toContain('qualifications');
  });

  it('PR43: a property anchor whose landlord cannot be read fails the whole result, carrying the pool contact ids', async () => {
    const w = world({ config: { rankingLandlordCard: true } });
    w.state.incompleteIds.add('contact-landlord-1');
    const result = await assembleRanking({ kind: 'unit', id: 'u1' }, OPTS, w.deps);
    expect(result).toEqual({
      ok: false,
      reason: 'anchor_unreadable',
      message: ASSEMBLE_MESSAGES.anchorUnreadable,
      candidateIds: ['t1', 't2', 't3'],
    });
  });

  it("a tenant anchor's property candidate whose landlord cannot be read is unverified, with no facts", async () => {
    const u4 = unit('u4', { landlordId: 'contact-landlord-2' });
    const w = world({ units: [U1, U2, U3, u4], config: { rankingLandlordCard: true } });
    w.state.incompleteIds.add('contact-landlord-2');
    const result = ok(await assembleRanking({ kind: 'tenant', id: 't1' }, OPTS, w.deps));
    expect(result.candidates.map((c) => [c.candidateId, c.unverified])).toEqual([
      ['u1', false],
      ['u2', false],
      ['u3', false],
      ['u4', true],
    ]);
    expect(result.candidates[3]?.propertyFacts).toBeNull();
    expect(result.unverifiedCount).toBe(1);
  });
});
