// services/orgRewrite.ts (spec D10-D12; plan 3.4, 3.4b, 3.9): the rewrite lock
// and every action that starts a rewrite, over the in-memory org list with an
// injected clock, id source and enqueue - so each case can assert the ONE list
// write, the rewrite id minted before it, and the job payload.
import { describe, expect, it } from 'vitest';
import { JOB_ENVELOPE_VERSION, type JobEnvelope } from '../src/jobs/types.js';
import type { OrgEntry } from '../src/lib/orgNames.js';
import type { OrgRewriteState } from '../src/repos/orgListRepo.js';
import { createOrgRewriteService, type OrgRewriteService } from '../src/services/orgRewrite.js';
import {
  ATLANTA,
  AUGUSTA,
  DCA,
  ORG_FIXTURE,
  ORG_T0,
  STEP_UP,
  VASH,
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

describe('OrgRewriteService.resolveNotOnList (spec D10)', () => {
  type ResolveInput = Parameters<OrgRewriteService['resolveNotOnList']>[0];

  it('Use with "Remember this spelling" settles the value and remembers it - in one write', async () => {
    const { repo, svc, enqueued } = await rewriteService();
    const out = await svc.resolveNotOnList({
      field: 'housingAuthority',
      value: 'Atlanta Hsg Auth',
      action: 'use',
      name: ATLANTA.name,
      rememberSpelling: true,
      actor: 'usr_admin',
    });
    expect(out).toEqual({
      lastRewrite: {
        jobId: 'id-1',
        action: 'use',
        fromTexts: ['Atlanta Hsg Auth'],
        field: 'housingAuthority',
        fields: ['housingAuthority'],
        toName: ATLANTA.name,
        status: 'running',
        heartbeatAt: T1,
        startedAt: T1,
        startedBy: 'usr_admin',
      },
      skippedSpellings: [],
    });
    const stored = await repo.peek();
    expect(stored?.version).toBe(2);
    expect(stored?.entries[0]?.spellings).toEqual(['AHA', 'Atlanta Housing', 'Atlanta (AHA)', 'Atlanta Hsg Auth']);
    expect(enqueued).toEqual([{ jobName: 'org.rewrite', payload: { jobId: 'id-1' } }]);
  });

  it('a spelling the D12 rules refuse is skipped with its reason; the Use still runs', async () => {
    const { repo, svc } = await rewriteService();
    const out = await svc.resolveNotOnList({
      field: 'housingAuthority',
      value: 'DCA HUD-VASH',
      action: 'use',
      name: DCA.name,
      rememberSpelling: true,
      actor: 'usr_admin',
    });
    expect(out.skippedSpellings).toEqual([{ spelling: 'DCA HUD-VASH', problem: 'compound' }]);
    expect(out.lastRewrite).toMatchObject({ action: 'use', toName: DCA.name, status: 'running' });
    expect((await repo.peek())?.entries.find((e) => e.orgId === 'org-dca')?.spellings).toEqual(['DCA', 'Georgia DCA']);
  });

  it('Add as new creates the entry - a corrected name keeps the value as a spelling - then Uses it', async () => {
    const { repo, svc } = await rewriteService();
    const out = await svc.resolveNotOnList({
      field: 'housingAuthority',
      value: 'Fulton Cnty HA',
      action: 'add',
      name: 'Fulton County Housing Authority',
      rememberSpelling: true,
      actor: 'usr_admin',
    });
    // The new entry's id is minted first (id-1), the rewrite id second (id-2).
    expect(out.lastRewrite).toMatchObject({
      jobId: 'id-2',
      action: 'use',
      fromTexts: ['Fulton Cnty HA'],
      field: 'housingAuthority',
      toName: 'Fulton County Housing Authority',
    });
    expect((await repo.peek())?.entries.at(-1)).toEqual({
      orgId: 'id-1',
      kind: 'housing_authority',
      name: 'Fulton County Housing Authority',
      spellings: ['Fulton Cnty HA'],
      createdAt: T1,
      createdBy: 'usr_admin',
      updatedAt: T1,
      updatedBy: 'usr_admin',
    });
  });

  it('Add as new without a name adds the value itself, of the field kind; a compound value cannot be added', async () => {
    const plain = await rewriteService();
    const out = await plain.svc.resolveNotOnList({ field: 'agency', value: 'Mercy Care', action: 'add', actor: 'usr_admin' });
    expect(out.lastRewrite).toMatchObject({ action: 'use', field: 'agency', toName: 'Mercy Care' });
    expect((await plain.repo.peek())?.entries.at(-1)).toMatchObject({ kind: 'agency', name: 'Mercy Care', spellings: [] });
    const compound = await rewriteService();
    await expect(
      compound.svc.resolveNotOnList({ field: 'housingAuthority', value: 'DCA HUD-VASH', action: 'add', actor: 'u' }),
    ).rejects.toMatchObject({ status: 409, body: { error: 'org_name_compound' } });
  });

  it('Move to Agency, Move to Housing authority, Split and Clear carry their definitions', async () => {
    const a = await rewriteService();
    expect(
      (await a.svc.resolveNotOnList({ field: 'housingAuthority', value: 'HUD VASH', action: 'move_to_agency', name: VASH.name, actor: 'u' }))
        .lastRewrite,
    ).toMatchObject({ action: 'move_to_agency', field: 'housingAuthority', fromTexts: ['HUD VASH'], toName: VASH.name });
    const b = await rewriteService();
    expect(
      (await b.svc.resolveNotOnList({ field: 'agency', value: 'DCA', action: 'move_to_housing_authority', name: DCA.name, actor: 'u' }))
        .lastRewrite,
    ).toMatchObject({ action: 'move_to_housing_authority', field: 'agency', fromTexts: ['DCA'], toName: DCA.name });
    const c = await rewriteService();
    expect(
      (
        await c.svc.resolveNotOnList({
          field: 'housingAuthority',
          value: 'DCA HUD-VASH',
          action: 'split',
          name: DCA.name,
          agencyName: VASH.name,
          actor: 'u',
        })
      ).lastRewrite,
    ).toMatchObject({ action: 'split', field: 'housingAuthority', toName: DCA.name, agencyName: VASH.name });
    const d = await rewriteService();
    const cleared = (await d.svc.resolveNotOnList({ field: 'accepted_authorities', value: 'Junk', action: 'clear', actor: 'u' }))
      .lastRewrite;
    expect(cleared).toMatchObject({ action: 'clear', field: 'accepted_authorities', fromTexts: ['Junk'] });
    expect(cleared).not.toHaveProperty('toName');
  });

  it('refuses (400) a blank or on-list value, the wrong field and the wrong kind; a name variant (409) unless used as its own entry', async () => {
    const { repo, svc } = await rewriteService();
    const resolve = (input: Omit<ResolveInput, 'actor'>) => svc.resolveNotOnList({ ...input, actor: 'u' });
    const refused: Array<Omit<ResolveInput, 'actor'>> = [
      { field: 'housingAuthority', value: '  ', action: 'clear' },
      { field: 'housingAuthority', value: ATLANTA.name, action: 'clear' },
      { field: 'agency', value: 'HUD VASH', action: 'move_to_agency', name: VASH.name },
      { field: 'accepted_authorities', value: 'DCA HUD-VASH', action: 'split', name: DCA.name, agencyName: VASH.name },
      { field: 'housingAuthority', value: 'DCA HUD-VASH', action: 'split', name: DCA.name, agencyName: ATLANTA.name },
      { field: 'housingAuthority', value: 'Junk', action: 'use', name: STEP_UP.name },
      { field: 'housingAuthority', value: 'Junk', action: 'use' },
    ];
    for (const input of refused) {
      await expect(resolve(input)).rejects.toMatchObject({ status: 400 });
    }
    // A NAME VARIANT (spec D10): a pass over it would also rewrite every exact
    // holder of the name, so only "Use <that entry>" may settle it - 409 with the entry.
    const variants: Array<Omit<ResolveInput, 'actor'>> = [
      { field: 'housingAuthority', value: 'atlanta housing authority', action: 'clear' },
      { field: 'housingAuthority', value: 'atlanta housing authority', action: 'use', name: AUGUSTA.name },
      { field: 'accepted_authorities', value: 'ATLANTA HOUSING AUTHORITY', action: 'add', name: 'Atlanta Housing Two' },
    ];
    for (const input of variants) {
      await expect(resolve(input)).rejects.toMatchObject({
        status: 409,
        body: { error: 'org_value_is_name_variant', entry: orgRef(ATLANTA) },
      });
    }
    expect((await repo.peek())?.version).toBe(1);
    // A name variant settled as its OWN entry is safe: the pass leaves the exact holders alone.
    const own = await resolve({ field: 'housingAuthority', value: 'atlanta housing authority', action: 'use', name: ATLANTA.name });
    expect(own.lastRewrite.toName).toBe(ATLANTA.name);
    // A stored name padded with whitespace arrives TRIMMED (trimJsonBody) - as
    // the exact name. Use <that entry> is allowed (the clear above stays 400).
    const fresh = await rewriteService();
    const padded = await fresh.svc.resolveNotOnList({
      field: 'housingAuthority',
      value: ATLANTA.name,
      action: 'use',
      name: ATLANTA.name,
      actor: 'u',
    });
    expect(padded.lastRewrite.fromTexts).toEqual([ATLANTA.name]);
    expect(padded.lastRewrite.toName).toBe(ATLANTA.name);
  });

  it('is refused while another rewrite runs', async () => {
    const { svc } = await rewriteService({
      lastRewrite: runningRewrite({ action: 'clear', field: 'agency', fromTexts: ['x'], heartbeatAt: T1 }),
    });
    await expect(
      svc.resolveNotOnList({ field: 'agency', value: 'Steps', action: 'clear', actor: 'u' }),
    ).rejects.toMatchObject({ status: 409, body: { error: 'org_rewrite_running' } });
  });
});

describe('OrgRewriteService.runAgain (spec D11)', () => {
  it('restarts a failed or stalled rewrite under a NEW id with the same definition', async () => {
    const failed: OrgRewriteState = {
      ...runningRewrite({ jobId: 'job-old', action: 'use', field: 'agency', fromTexts: ['Steps'], toName: STEP_UP.name }),
      status: 'failed',
      counts: { agency: 2 },
      error: 'enqueue_failed',
      finishedAt: ORG_T0,
    };
    const { svc, enqueued } = await rewriteService({ lastRewrite: failed });
    const out = await svc.runAgain('usr_admin2');
    expect(out.lastRewrite).toEqual({
      jobId: 'id-1',
      action: 'use',
      field: 'agency',
      fields: ['agency'],
      fromTexts: ['Steps'],
      toName: STEP_UP.name,
      status: 'running',
      heartbeatAt: T1,
      startedAt: T1,
      startedBy: 'usr_admin2',
    });
    expect(enqueued).toEqual([{ jobName: 'org.rewrite', payload: { jobId: 'id-1' } }]);
    const stalled = await rewriteService({
      lastRewrite: runningRewrite({ jobId: 'job-old', action: 'clear', field: 'agency', fromTexts: ['x'], heartbeatAt: '2026-10-06T11:45:00.000Z' }),
    });
    expect((await stalled.svc.runAgain('a')).lastRewrite).toMatchObject({ jobId: 'id-1', action: 'clear', status: 'running' });
  });

  it('is refused for a running rewrite, a done one, the cleanup lock (even stale), or none', async () => {
    const running = await rewriteService({
      lastRewrite: runningRewrite({ action: 'clear', field: 'agency', fromTexts: ['x'], heartbeatAt: T1 }),
    });
    await expect(running.svc.runAgain('a')).rejects.toMatchObject({ status: 409, body: { error: 'org_rewrite_running' } });
    const done = await rewriteService({
      lastRewrite: { ...runningRewrite({ action: 'clear', field: 'agency', fromTexts: ['x'] }), status: 'done' },
    });
    await expect(done.svc.runAgain('a')).rejects.toMatchObject({ status: 409, body: { error: 'org_rewrite_not_rerunnable' } });
    const cleanup = await rewriteService({
      lastRewrite: runningRewrite({ action: 'cleanup', fromTexts: [], heartbeatAt: '2026-10-06T11:00:00.000Z' }),
    });
    await expect(cleanup.svc.runAgain('a')).rejects.toMatchObject({ status: 409, body: { error: 'org_rewrite_not_rerunnable' } });
    const none = await rewriteService();
    await expect(none.svc.runAgain('a')).rejects.toMatchObject({ status: 409, body: { error: 'org_rewrite_not_rerunnable' } });
  });

  it('re-checks its target names first: 409 org_rewrite_target_gone once a name left the list or changed kind', async () => {
    const failed = (def: OrgRewriteState): OrgRewriteState => ({ ...def, status: 'failed', finishedAt: ORG_T0 });
    const useStepUp = failed(
      runningRewrite({ jobId: 'job-old', action: 'use', field: 'agency', fromTexts: ['Steps'], toName: STEP_UP.name }),
    );
    const gone = { status: 409, body: { error: 'org_rewrite_target_gone' } };
    // The agency was deleted after the failure (a failed rewrite holds no lock).
    const deleted = await rewriteService({
      entries: ORG_FIXTURE.filter((e) => e.orgId !== STEP_UP.orgId),
      lastRewrite: useStepUp,
    });
    await expect(deleted.svc.runAgain('a')).rejects.toMatchObject(gone);
    expect(deleted.enqueued).toEqual([]);
    // It became a housing authority: the agency field must not receive it.
    const rekinded = await rewriteService({
      entries: ORG_FIXTURE.map((e) => (e.orgId === STEP_UP.orgId ? { ...e, kind: 'housing_authority' as const } : e)),
      lastRewrite: useStepUp,
    });
    await expect(rekinded.svc.runAgain('a')).rejects.toMatchObject(gone);
    // A split's agency half is re-checked too.
    const split = await rewriteService({
      entries: ORG_FIXTURE.filter((e) => e.orgId !== VASH.orgId),
      lastRewrite: failed(
        runningRewrite({
          jobId: 'job-old',
          action: 'split',
          field: 'housingAuthority',
          fromTexts: ['DCA HUD-VASH'],
          toName: DCA.name,
          agencyName: VASH.name,
        }),
      ),
    });
    await expect(split.svc.runAgain('a')).rejects.toMatchObject(gone);
    // A rename's target is its stored name, of the kind its fields belong to.
    const renamed = await rewriteService({
      lastRewrite: failed(
        runningRewrite({
          jobId: 'job-old',
          action: 'rename',
          fromTexts: ['Old Name'],
          fields: ['housingAuthority', 'accepted_authorities'],
          toName: 'Renamed Again Since',
        }),
      ),
    });
    await expect(renamed.svc.runAgain('a')).rejects.toMatchObject(gone);
    // A clear names no target and re-runs as stored.
    const clear = await rewriteService({
      lastRewrite: failed(runningRewrite({ jobId: 'job-old', action: 'clear', field: 'agency', fromTexts: ['x'] })),
    });
    expect((await clear.svc.runAgain('a')).lastRewrite).toMatchObject({ action: 'clear', fields: ['agency'], status: 'running' });
  });

  // Build ruling B-2: a failed rewrite holds no lock, so a from-text may have
  // become a listed name since. Re-running would rewrite every record holding
  // that now-listed name, where a fresh action on the value is refused (D10).
  const failedRewrite = (def: OrgRewriteState): OrgRewriteState => ({ ...def, status: 'failed', finishedAt: ORG_T0 });
  const failedClear = (value: string): OrgRewriteState =>
    failedRewrite(runningRewrite({ jobId: 'job-old', action: 'clear', field: 'agency', fromTexts: [value] }));
  // Not on the starting list; added after the Clear failed.
  const HOPE_HOUSE = orgEntry({ orgId: 'org-hope', kind: 'agency', name: 'Hope House' });

  it('refuses (409 org_rewrite_target_gone) once a from-text was added since as an agency name', async () => {
    const failed = failedClear('Hope House');
    const { repo, svc, enqueued } = await rewriteService({ entries: [...ORG_FIXTURE, HOPE_HOUSE], lastRewrite: failed });
    await expect(svc.runAgain('usr_admin')).rejects.toMatchObject({ status: 409, body: { error: 'org_rewrite_target_gone' } });
    expect(enqueued).toEqual([]);
    expect((await repo.peek())?.lastRewrite).toEqual(failed);
    expect((await repo.peek())?.version).toBe(1);
  });

  it('refuses (409 org_rewrite_target_gone) once a from-text became a NAME VARIANT of an added agency', async () => {
    // "hope-house" differs from the added name only in case and punctuation.
    const failed = failedClear('hope-house');
    const { repo, svc, enqueued } = await rewriteService({ entries: [...ORG_FIXTURE, HOPE_HOUSE], lastRewrite: failed });
    await expect(svc.runAgain('usr_admin')).rejects.toMatchObject({ status: 409, body: { error: 'org_rewrite_target_gone' } });
    expect(enqueued).toEqual([]);
    expect((await repo.peek())?.lastRewrite).toEqual(failed);
    expect((await repo.peek())?.version).toBe(1);
  });

  it('(PIN) re-runs a Use whose from-text is a variant of its OWN target, and a from-text that names only the other kind', async () => {
    // "Use <that entry>" settles a name variant (spec D10): the pass leaves the exact holders alone.
    const own = await rewriteService({
      lastRewrite: failedRewrite(
        runningRewrite({
          jobId: 'job-old',
          action: 'use',
          field: 'housingAuthority',
          fromTexts: ['atlanta housing authority'],
          toName: ATLANTA.name,
        }),
      ),
    });
    expect((await own.svc.runAgain('usr_admin2')).lastRewrite).toEqual({
      jobId: 'id-1',
      action: 'use',
      fromTexts: ['atlanta housing authority'],
      field: 'housingAuthority',
      fields: ['housingAuthority'],
      toName: ATLANTA.name,
      status: 'running',
      heartbeatAt: T1,
      startedAt: T1,
      startedBy: 'usr_admin2',
    });
    expect(own.enqueued).toEqual([{ jobName: 'org.rewrite', payload: { jobId: 'id-1' } }]);
    // A HOUSING AUTHORITY named "Hope House" does not put the agency value on the list (D3).
    const otherKind = await rewriteService({
      entries: [...ORG_FIXTURE, { ...HOPE_HOUSE, kind: 'housing_authority' as const }],
      lastRewrite: failedClear('Hope House'),
    });
    expect((await otherKind.svc.runAgain('a')).lastRewrite).toMatchObject({
      jobId: 'id-1',
      action: 'clear',
      fromTexts: ['Hope House'],
      status: 'running',
    });
    expect(otherKind.enqueued).toEqual([{ jobName: 'org.rewrite', payload: { jobId: 'id-1' } }]);
  });
});

describe('OrgRewriteService.acquireForCleanup (spec section 8)', () => {
  it('takes the lock as action cleanup, enqueues nothing, blocks other rewrites, and lives through heartbeat and finish', async () => {
    let clock = T1;
    const { repo, svc, enqueued } = await rewriteService({ now: () => clock });
    const lock = await svc.acquireForCleanup('cleanup-script');
    expect(lock).toEqual({
      jobId: 'id-1',
      action: 'cleanup',
      fromTexts: [],
      fields: ['housingAuthority', 'agency', 'accepted_authorities'],
      status: 'running',
      heartbeatAt: T1,
      startedAt: T1,
      startedBy: 'cleanup-script',
    });
    expect(enqueued).toEqual([]);
    await expect(svc.rename('org-dca', 'Georgia Community Affairs', 'a')).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_rewrite_running' },
    });
    await expect(svc.acquireForCleanup('again')).rejects.toMatchObject({ status: 409, body: { error: 'org_rewrite_running' } });
    clock = '2026-10-06T12:05:00.000Z';
    expect(await svc.heartbeat('id-1')).toBe(true);
    await svc.finish('id-1', { status: 'done', counts: { housingAuthority: 4 } });
    expect((await repo.peek())?.lastRewrite).toMatchObject({
      jobId: 'id-1',
      action: 'cleanup',
      status: 'done',
      counts: { housingAuthority: 4 },
      finishedAt: '2026-10-06T12:05:00.000Z',
    });
  });
});
