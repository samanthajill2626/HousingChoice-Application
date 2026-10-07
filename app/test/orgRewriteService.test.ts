// services/orgRewrite.ts (spec D10-D12; plan 3.4, 3.4b, 3.9): the rewrite lock
// and every action that starts a rewrite, over the in-memory org list with an
// injected clock, id source and enqueue - so each case can assert the ONE list
// write, the rewrite id minted before it, and the job payload.
import { describe, expect, it } from 'vitest';
import { JOB_ENVELOPE_VERSION, type JobEnvelope } from '../src/jobs/types.js';
import type { OrgEntry } from '../src/lib/orgNames.js';
import type { OrgRewriteState } from '../src/repos/orgListRepo.js';
import { createOrgRewriteService } from '../src/services/orgRewrite.js';
import {
  ATLANTA,
  DCA,
  ORG_FIXTURE,
  orgEntry,
  orgListItem,
  orgRef,
  quietLogger,
  runningRewrite,
} from './helpers/orgFixtures.js';
import { createOrgListFake } from './helpers/orgListFake.js';

const T1 = '2026-10-06T12:00:00.000Z';
const NL = String.fromCharCode(10);

function envelopeFor(jobName: string, payload: unknown): JobEnvelope {
  return {
    v: JOB_ENVELOPE_VERSION,
    jobId: 'envelope-id',
    jobName,
    payload,
    correlationContext: {},
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    hopCount: 1,
    enqueuedAt: T1,
  };
}

/** A service over a fake list seeded with `entries`; ids are id-1, id-2, ... in mint order. */
async function rewriteService(
  opts: {
    entries?: readonly OrgEntry[];
    lastRewrite?: OrgRewriteState;
    now?: () => string;
    enqueue?: (jobName: string, payload: unknown) => Promise<JobEnvelope>;
  } = {},
) {
  const repo = createOrgListFake();
  await repo.putForSeed(
    orgListItem(opts.entries ?? ORG_FIXTURE, opts.lastRewrite === undefined ? {} : { lastRewrite: opts.lastRewrite }),
  );
  const enqueued: Array<{ jobName: string; payload: unknown }> = [];
  let n = 0;
  const svc = createOrgRewriteService({
    orgListRepo: repo,
    logger: quietLogger(),
    now: opts.now ?? (() => T1),
    newId: () => `id-${(n += 1)}`,
    enqueue:
      opts.enqueue ??
      (async (jobName: string, payload: unknown) => {
        enqueued.push({ jobName, payload });
        return envelopeFor(jobName, payload);
      }),
  });
  return { repo, svc, enqueued };
}

describe('OrgRewriteService.rename (spec D11, D12)', () => {
  it('ONE list write renames, keeps the old name as a spelling, and starts a running rewrite under an id minted first', async () => {
    const { repo, svc, enqueued } = await rewriteService();
    const out = await svc.rename('org-atl', ' Housing Authority of the City of Atlanta ', 'usr_admin');
    expect(out.entry).toEqual({
      ...ATLANTA,
      name: 'Housing Authority of the City of Atlanta',
      spellings: ['AHA', 'Atlanta Housing', 'Atlanta (AHA)', 'Atlanta Housing Authority'],
      updatedAt: T1,
      updatedBy: 'usr_admin',
    });
    expect(out.skippedSpellings).toEqual([]);
    expect(out.lastRewrite).toEqual({
      jobId: 'id-1',
      action: 'rename',
      fromTexts: ['Atlanta Housing Authority'],
      // Fixed NOW, from the entry's kind (spec 5.1): the job never looks the target up again.
      fields: ['housingAuthority', 'accepted_authorities'],
      toName: 'Housing Authority of the City of Atlanta',
      status: 'running',
      heartbeatAt: T1,
      startedAt: T1,
      startedBy: 'usr_admin',
    });
    // The payload carries the rewrite id - never an envelope id (plan 3.9).
    expect(enqueued).toEqual([{ jobName: 'org.rewrite', payload: { jobId: 'id-1' } }]);
    const stored = await repo.peek();
    expect(stored?.version).toBe(2);
    expect(stored?.lastRewrite).toEqual(out.lastRewrite);
    expect(stored?.entries[0]).toEqual(out.entry);
  });

  it('may take one of the entry own spellings, which then leaves its spellings (D12)', async () => {
    const { svc } = await rewriteService();
    const out = await svc.rename('org-atl', 'Atlanta Housing', 'usr_admin');
    expect(out.entry.spellings).toEqual(['AHA', 'Atlanta (AHA)', 'Atlanta Housing Authority']);
  });

  it('an old name the D12 rules cannot keep is skipped with its reason, and the rename still runs', async () => {
    const full = orgEntry({
      orgId: 'org-full',
      kind: 'agency',
      name: 'Full Agency',
      spellings: Array.from({ length: 20 }, (_, i) => `Full Spelling ${i}`),
    });
    const { svc } = await rewriteService({ entries: [...ORG_FIXTURE, full] });
    const out = await svc.rename('org-full', 'Full Agency Renamed', 'usr_admin');
    expect(out.skippedSpellings).toEqual([{ spelling: 'Full Agency', problem: 'too_many' }]);
    expect(out.entry.spellings).toHaveLength(20);
    expect(out.lastRewrite.status).toBe('running');
  });

  it('refuses an unknown entry and a taken, compound or invalid name, writing and enqueueing nothing', async () => {
    const { repo, svc, enqueued } = await rewriteService();
    await expect(svc.rename('org-nope', 'X', 'a')).rejects.toMatchObject({ status: 404, body: { error: 'org_not_found' } });
    await expect(svc.rename('org-atl', 'Georgia DCA', 'a')).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_name_taken', entry: orgRef(DCA) },
    });
    await expect(svc.rename('org-atl', 'DCA VASH', 'a')).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_name_compound' },
    });
    await expect(svc.rename('org-atl', `Atlanta${NL}HA`, 'a')).rejects.toMatchObject({
      status: 400,
      body: { error: 'org_name_invalid' },
    });
    expect((await repo.peek())?.version).toBe(1);
    expect(enqueued).toEqual([]);
  });

  it('one rewrite at a time: refused while the lock is fresh; a 15-minute-old heartbeat no longer blocks', async () => {
    const lock = (heartbeatAt: string) =>
      runningRewrite({ jobId: 'job-held', action: 'clear', field: 'agency', fromTexts: ['x'], heartbeatAt });
    const held = await rewriteService({ lastRewrite: lock('2026-10-06T11:50:00.000Z') });
    await expect(held.svc.rename('org-dca', 'Georgia Community Affairs', 'a')).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_rewrite_running', lastRewrite: { jobId: 'job-held' } },
    });
    expect(held.enqueued).toEqual([]);
    const stale = await rewriteService({ lastRewrite: lock('2026-10-06T11:45:00.000Z') });
    const out = await stale.svc.rename('org-dca', 'Georgia Community Affairs', 'a');
    expect(out.lastRewrite).toMatchObject({ jobId: 'id-1', status: 'running' });
  });
});

describe('OrgRewriteService.heartbeat / finish (spec D11; planner ruling R4-F4)', () => {
  it('act only for the RUNNING rewrite they name; heartbeat says whether the lock is still the caller\'s', async () => {
    let clock = T1;
    const { repo, svc } = await rewriteService({
      lastRewrite: runningRewrite({
        jobId: 'job-1',
        action: 'use',
        field: 'agency',
        fromTexts: ['Steps'],
        toName: 'Step Up',
        heartbeatAt: T1,
      }),
      now: () => clock,
    });
    clock = '2026-10-06T12:00:20.000Z';
    expect(await svc.heartbeat('job-other')).toBe(false);
    expect((await repo.peek())?.version).toBe(1); // not its lock: nothing written
    expect(await svc.heartbeat('job-1')).toBe(true);
    expect((await repo.peek())?.lastRewrite?.heartbeatAt).toBe('2026-10-06T12:00:20.000Z');
    clock = '2026-10-06T12:01:00.000Z';
    await svc.finish('job-1', { status: 'done', counts: { agency: 2 } });
    const done = (await repo.peek())?.lastRewrite;
    expect(done).toMatchObject({
      jobId: 'job-1',
      status: 'done',
      counts: { agency: 2 },
      finishedAt: '2026-10-06T12:01:00.000Z',
    });
    const version = (await repo.peek())?.version;
    await svc.finish('job-1', { status: 'failed', error: 'a late duplicate' });
    // A finished rewrite's lock is nobody's: a late duplicate learns it must stop.
    expect(await svc.heartbeat('job-1')).toBe(false);
    expect((await repo.peek())?.lastRewrite).toEqual(done);
    expect((await repo.peek())?.version).toBe(version);
  });
});

describe('OrgRewriteService - an enqueue failure (spec D11)', () => {
  it('keeps the list change and records the rewrite failed', async () => {
    const { repo, svc } = await rewriteService({
      enqueue: async () => {
        throw new Error('queue down');
      },
    });
    const out = await svc.rename('org-dca', 'Georgia Community Affairs', 'usr_admin');
    expect(out.entry.name).toBe('Georgia Community Affairs');
    expect(out.lastRewrite).toMatchObject({ jobId: 'id-1', status: 'failed', error: 'enqueue_failed', finishedAt: T1 });
    const stored = await repo.peek();
    expect(stored?.entries.find((e) => e.orgId === 'org-dca')?.name).toBe('Georgia Community Affairs');
    expect(stored?.lastRewrite).toEqual(out.lastRewrite);
  });
});

describe('OrgRewriteService.merge (spec D11)', () => {
  it('moves the name and every spelling onto the target and removes the merged entry, in ONE write', async () => {
    const { repo, svc, enqueued } = await rewriteService();
    const out = await svc.merge('org-aug', 'org-atl', 'usr_admin');
    // AHA is shared with Atlanta - another entry - so it is no from-text.
    expect(out.lastRewrite).toEqual({
      jobId: 'id-1',
      action: 'merge',
      fromTexts: ['Augusta Housing Authority'],
      fields: ['housingAuthority', 'accepted_authorities'],
      toName: ATLANTA.name,
      status: 'running',
      heartbeatAt: T1,
      startedAt: T1,
      startedBy: 'usr_admin',
    });
    expect(enqueued).toEqual([{ jobName: 'org.rewrite', payload: { jobId: 'id-1' } }]);
    const stored = await repo.peek();
    expect(stored?.version).toBe(2);
    expect(stored?.entries.map((e) => e.orgId)).toEqual(['org-atl', 'org-dca', 'org-vash', 'org-stepup']);
    expect(stored?.entries[0]).toMatchObject({
      spellings: ['AHA', 'Atlanta Housing', 'Atlanta (AHA)', 'Augusta Housing Authority'],
      updatedAt: T1,
      updatedBy: 'usr_admin',
    });
  });

  it('a spelling the merged entry shared with a third entry stays shared, and is no from-text', async () => {
    const marietta = orgEntry({ orgId: 'org-mar', kind: 'housing_authority', name: 'Marietta Housing Authority', spellings: ['MHA'] });
    const macon = orgEntry({
      orgId: 'org-mac',
      kind: 'housing_authority',
      name: 'Macon-Bibb County Housing Authority',
      spellings: ['Macon Housing Authority', 'MHA'],
    });
    const dekalb = orgEntry({ orgId: 'org-dek', kind: 'housing_authority', name: 'DeKalb County Housing Authority', spellings: ['HADC'] });
    const { repo, svc } = await rewriteService({ entries: [marietta, macon, dekalb] });
    const out = await svc.merge('org-mar', 'org-dek', 'usr_admin');
    expect(out.lastRewrite.fromTexts).toEqual(['Marietta Housing Authority']);
    const stored = await repo.peek();
    expect(stored?.entries.find((e) => e.orgId === 'org-dek')?.spellings).toEqual([
      'HADC',
      'Marietta Housing Authority',
      'MHA',
    ]);
    expect(stored?.entries.find((e) => e.orgId === 'org-mac')?.spellings).toContain('MHA');
  });

  it('refuses an unknown entry, itself, the other kind, a running rewrite and a transfer past 20 - writing nothing', async () => {
    const crowded = orgEntry({
      orgId: 'org-crowd',
      kind: 'agency',
      name: 'Crowded Agency',
      spellings: Array.from({ length: 19 }, (_, i) => `Crowded ${i}`),
    });
    const { repo, svc, enqueued } = await rewriteService({ entries: [...ORG_FIXTURE, crowded] });
    await expect(svc.merge('org-nope', 'org-atl', 'a')).rejects.toMatchObject({ status: 404, body: { error: 'org_not_found' } });
    await expect(svc.merge('org-atl', 'org-nope', 'a')).rejects.toMatchObject({ status: 404, body: { error: 'org_not_found' } });
    await expect(svc.merge('org-atl', 'org-atl', 'a')).rejects.toMatchObject({ status: 400 });
    await expect(svc.merge('org-atl', 'org-vash', 'a')).rejects.toMatchObject({ status: 400 });
    // HUD-VASH's name and two spellings onto 19 spellings: 22 > 20 - refused, never dropped.
    await expect(svc.merge('org-vash', 'org-crowd', 'a')).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_spellings_full' },
    });
    expect((await repo.peek())?.version).toBe(1);
    expect(enqueued).toEqual([]);
    const running = await rewriteService({
      lastRewrite: runningRewrite({ action: 'clear', field: 'agency', fromTexts: ['x'], heartbeatAt: T1 }),
    });
    await expect(running.svc.merge('org-aug', 'org-atl', 'a')).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_rewrite_running' },
    });
  });
});
