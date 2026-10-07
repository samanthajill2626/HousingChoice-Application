// jobs/orgRewrite.ts (spec D11; plan 3.9; planner rulings R4-F3, R4-F4): the
// handler acts only for the running rewrite its payload names, runs one pass
// per stored field, records done or failed with the counts, NEVER rethrows,
// stops writing once its heartbeat finds the lock gone, and two concurrent
// runs of one definition rewrite each record once. Over the harness world
// fakes and the real services.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetForTests, configureJobsLogger, dispatchJob, registeredJobNames } from '../src/jobs/jobs.js';
import {
  ORG_REWRITE_JOB,
  parseOrgRewritePayload,
  registerOrgRewriteJobHandler,
  runOrgRewriteJob,
} from '../src/jobs/orgRewrite.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import type { OrgEntry } from '../src/lib/orgNames.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { OrgRewriteState } from '../src/repos/orgListRepo.js';
import { createOrgRecordsService } from '../src/services/orgRecords.js';
import { createOrgRewriteService } from '../src/services/orgRewrite.js';
import { ATLANTA, ORG_FIXTURE, orgListItem, quietLogger, runningRewrite } from './helpers/orgFixtures.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const USE: OrgRewriteState = runningRewrite({
  jobId: 'job-1',
  action: 'use',
  field: 'housingAuthority',
  fromTexts: ['Atlanta Hsg'],
  toName: ATLANTA.name,
});
const ZERO = { housingAuthority: 0, agency: 0, accepted_authorities: 0, skipped: 0, conflicts: 0 };

function holder(contactId: string, extra: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'tenant', status: 'searching', housingAuthority: 'Atlanta Hsg', ...extra };
}

/** A world whose org list carries `lastRewrite`, plus the job's deps over the world fakes. */
async function jobWorld(
  lastRewrite: OrgRewriteState | undefined,
  opts: { entries?: readonly OrgEntry[]; contacts?: ContactItem[] } = {},
) {
  const world = createFakeWorld();
  await world.orgListRepo.putForSeed(
    orgListItem(opts.entries ?? ORG_FIXTURE, lastRewrite === undefined ? {} : { lastRewrite }),
  );
  world.contacts.push(...(opts.contacts ?? [holder('t-1'), holder('t-2'), holder('t-3')]));
  const logger = quietLogger();
  const orgRecords = createOrgRecordsService({
    contactsRepo: world.contactsRepo,
    unitsRepo: world.unitsRepo,
    auditRepo: world.auditRepo,
    logger,
  });
  const orgRewrite = createOrgRewriteService({
    orgListRepo: world.orgListRepo,
    orgRecords,
    logger,
    enqueue: async () => {
      throw new Error('the job never enqueues');
    },
  });
  return { world, deps: { orgListRepo: world.orgListRepo, orgRecords, orgRewrite, logger } };
}

const rewritesIn = (world: FakeWorld) => world.auditEvents.filter((e) => e.event_type === 'org_name_rewrite');

describe('parseOrgRewritePayload (plan 3.9)', () => {
  it('accepts { jobId } and refuses anything else', () => {
    expect(parseOrgRewritePayload({ jobId: 'job-1' })).toEqual({ jobId: 'job-1' });
    for (const bad of [null, 'job-1', {}, { jobId: '' }, { jobId: 7 }]) {
      expect(() => parseOrgRewritePayload(bad)).toThrow(/org\.rewrite/);
    }
  });
});

describe('runOrgRewriteJob (spec D11; plan 3.9)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing unless lastRewrite names this id and is running', async () => {
    for (const last of [undefined, { ...USE, jobId: 'job-newer' }, { ...USE, status: 'done' as const }, { ...USE, status: 'failed' as const }]) {
      const { world, deps } = await jobWorld(last);
      expect(await runOrgRewriteJob({ jobId: 'job-1' }, deps)).toEqual({ outcome: 'not_current' });
      expect(world.contacts.map((c) => c['housingAuthority'])).toEqual(['Atlanta Hsg', 'Atlanta Hsg', 'Atlanta Hsg']);
      expect((await world.orgListRepo.peek())?.version).toBe(1);
    }
  });

  it('runs the definition and records done with its counts; the audit actor is whoever started it', async () => {
    const { world, deps } = await jobWorld(USE);
    const counts = { ...ZERO, housingAuthority: 3 };
    expect(await runOrgRewriteJob({ jobId: 'job-1' }, deps)).toEqual({ outcome: 'done', counts });
    expect(world.contacts.every((c) => c['housingAuthority'] === ATLANTA.name)).toBe(true);
    expect((await world.orgListRepo.peek())?.lastRewrite).toMatchObject({ jobId: 'job-1', status: 'done', counts });
    expect(rewritesIn(world).map((e) => e.actorId)).toEqual(['usr_admin', 'usr_admin', 'usr_admin']);
  });

  it('a rename runs one pass per STORED field (fixed when it started) and sums the counts', async () => {
    const NEW = 'Housing Authority of the City of Atlanta';
    const entries = ORG_FIXTURE.map((e) => (e.orgId === ATLANTA.orgId ? { ...e, name: NEW } : e));
    const { world, deps } = await jobWorld(
      runningRewrite({
        jobId: 'job-1',
        action: 'rename',
        fromTexts: [ATLANTA.name],
        fields: ['housingAuthority', 'accepted_authorities'],
        toName: NEW,
      }),
      { entries, contacts: [holder('t-1', { housingAuthority: ATLANTA.name })] },
    );
    world.units.set('u-1', { unitId: 'u-1', landlordId: 'l-1', status: 'available', accepted_authorities: [ATLANTA.name] });
    expect(await runOrgRewriteJob({ jobId: 'job-1' }, deps)).toEqual({
      outcome: 'done',
      counts: { ...ZERO, housingAuthority: 1, accepted_authorities: 1 },
    });
    expect(world.contacts[0]?.['housingAuthority']).toBe(NEW);
    expect(world.units.get('u-1')?.accepted_authorities).toEqual([NEW]);
  });

  it('a rewrite that names no fields records failed and resolves - it never looks the target up', async () => {
    const { world, deps } = await jobWorld(
      runningRewrite({ jobId: 'job-1', action: 'rename', fromTexts: ['Old Name'], fields: [], toName: 'Gone' }),
    );
    expect(await runOrgRewriteJob({ jobId: 'job-1' }, deps)).toEqual({ outcome: 'failed', counts: {} });
    expect((await world.orgListRepo.peek())?.lastRewrite).toMatchObject({
      status: 'failed',
      error: 'the rewrite names no record fields',
    });
  });

  it('a pass that stops records failed with the counts so far and resolves - it never rethrows', async () => {
    const { world, deps } = await jobWorld(USE, {
      contacts: [holder('t-1'), holder('t-2', { deleted_at: '2026-10-01T00:00:00.000Z' })],
    });
    const list = world.contactsRepo.listByType.bind(world.contactsRepo);
    let pages = 0;
    world.contactsRepo.listByType = async (type, opts) => {
      pages += 1;
      if (pages === 2) throw new Error('ProvisionedThroughputExceededException');
      return list(type, opts);
    };
    const counts = { ...ZERO, housingAuthority: 1 };
    expect(await runOrgRewriteJob({ jobId: 'job-1' }, deps)).toEqual({ outcome: 'failed', counts });
    expect((await world.orgListRepo.peek())?.lastRewrite).toMatchObject({
      status: 'failed',
      counts,
      error: expect.stringContaining('ProvisionedThroughputExceededException'),
    });
  });

  it('a finish that fails too is logged, and the run still resolves', async () => {
    const { deps } = await jobWorld(USE);
    const result = await runOrgRewriteJob(
      { jobId: 'job-1' },
      {
        ...deps,
        orgRewrite: {
          heartbeat: deps.orgRewrite.heartbeat,
          finish: async () => {
            throw new Error('org list busy');
          },
        },
      },
    );
    expect(result.outcome).toBe('failed');
  });

  it('two concurrent runs of ONE definition rewrite each record once and leave one finished rewrite', async () => {
    const holders = Array.from({ length: 8 }, (_, i) => holder(`t-${i}`));
    const { world, deps } = await jobWorld(USE, { contacts: holders });
    const runs = await Promise.all([
      runOrgRewriteJob({ jobId: 'job-1' }, deps),
      runOrgRewriteJob({ jobId: 'job-1' }, deps),
    ]);
    expect(world.contacts.every((c) => c['housingAuthority'] === ATLANTA.name)).toBe(true);
    // Every record written - and audited - exactly once across both runs.
    expect(rewritesIn(world)).toHaveLength(8);
    const written = runs.reduce((sum, r) => sum + (r.outcome === 'not_current' ? 0 : (r.counts['housingAuthority'] ?? 0)), 0);
    expect(written).toBe(8);
    expect((await world.orgListRepo.peek())?.lastRewrite).toMatchObject({ jobId: 'job-1', status: 'done' });
  });

  it('a run whose lock a newer rewrite took over writes NO record after its next heartbeat and never finishes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T12:00:00.000Z'));
    const { world, deps } = await jobWorld(USE); // three holders of 'Atlanta Hsg'
    const newer = runningRewrite({ jobId: 'job-2', action: 'clear', field: 'agency', fromTexts: ['x'] });
    const write = world.contactsRepo.rewriteOrgFields.bind(world.contactsRepo);
    world.contactsRepo.rewriteOrgFields = async (contactId, expected, next) => {
      const outcome = await write(contactId, expected, next);
      // Each write takes 25 s, so the pass heartbeats after every record; after
      // the FIRST write job-1's lock has gone stale and job-2 has taken it over.
      vi.setSystemTime(Date.now() + 25_000);
      const item = await world.orgListRepo.get();
      if (item.lastRewrite?.jobId === 'job-1') await world.orgListRepo.putForSeed({ ...item, lastRewrite: newer });
      return outcome;
    };
    expect(await runOrgRewriteJob({ jobId: 'job-1' }, deps)).toEqual({
      outcome: 'lock_lost',
      counts: { ...ZERO, housingAuthority: 1 },
    });
    // The record written before the takeover stays; none was written after it.
    expect(world.contacts.filter((c) => c['housingAuthority'] === ATLANTA.name)).toHaveLength(1);
    expect(world.contacts.filter((c) => c['housingAuthority'] === 'Atlanta Hsg')).toHaveLength(2);
    expect(rewritesIn(world)).toHaveLength(1);
    // No finish: the newer rewrite's state stands exactly as it took the lock.
    expect((await world.orgListRepo.peek())?.lastRewrite).toEqual(newer);
  });
});

describe('registerOrgRewriteJobHandler (plan 3.9)', () => {
  afterEach(() => {
    _resetForTests();
  });

  it('registers org.rewrite; dispatch drops a malformed payload WITHOUT throwing and runs a valid one', async () => {
    _resetForTests();
    configureJobsLogger(quietLogger());
    const { world } = await jobWorld(USE);
    const capture = createLogCapture();
    registerOrgRewriteJobHandler({
      orgListRepo: world.orgListRepo,
      contactsRepo: world.contactsRepo,
      unitsRepo: world.unitsRepo,
      auditRepo: world.auditRepo,
      logger: createLogger({ destination: capture.stream }),
    });
    expect(registeredJobNames()).toContain(ORG_REWRITE_JOB);
    // An envelope-less but dispatchable event (the mediaMirrorJob.test.ts shape).
    const dispatch = (payload: unknown) =>
      dispatchJob({
        jobId: `envelope-${Math.random()}`,
        jobName: ORG_REWRITE_JOB,
        payload,
        correlationId: 'corr-1',
        hopCount: 1,
        enqueuedAt: new Date().toISOString(),
      } as never);
    // A rethrow here would make SQS redeliver it five times.
    await expect(dispatch({ nope: true })).resolves.toBeUndefined();
    expect(capture.atLevel(50).some((line) => line['msg'] === 'org.rewrite: malformed payload - dropped')).toBe(true);
    await dispatch({ jobId: 'job-1' });
    expect(world.contacts.every((c) => c['housingAuthority'] === ATLANTA.name)).toBe(true);
    expect((await world.orgListRepo.peek())?.lastRewrite?.status).toBe('done');
  });
});
