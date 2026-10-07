// jobs/orgRewrite.ts (spec D11; plan 3.9; planner rulings R4-F3, R4-F4): the
// handler acts only for the running rewrite its payload names - CLAIMING it
// first, which re-validates a lapsed lock as Run again does (code review
// R2-BE-1) - runs one pass per stored field, records done or failed with the
// counts, NEVER rethrows, stops writing once its heartbeat finds the lock gone,
// and two concurrent runs of one definition rewrite each record once. Over the
// harness world fakes and the real services.
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
import { createOrgNamesService } from '../src/services/orgNames.js';
import { createOrgRecordsService } from '../src/services/orgRecords.js';
import { createOrgRewriteService } from '../src/services/orgRewrite.js';
import { ATLANTA, ORG_FIXTURE, orgListItem, quietLogger, runningRewrite, STEP_UP } from './helpers/orgFixtures.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const USE: OrgRewriteState = runningRewrite({
  jobId: 'job-1',
  action: 'use',
  field: 'housingAuthority',
  fromTexts: ['Atlanta Hsg'],
  toName: ATLANTA.name,
});
const ZERO = { housingAuthority: 0, agency: 0, accepted_authorities: 0, skipped: 0, conflicts: 0 };

/**
 * `def` with a heartbeat of NOW on the clock the services use: a job delivered
 * while its lock is fresh. (runningRewrite's default heartbeat, ORG_T0, is a
 * LAPSED lock on the real clock - which the job re-validates first.)
 */
const fresh = (def: OrgRewriteState): OrgRewriteState => ({ ...def, heartbeatAt: new Date().toISOString() });

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
  return { world, deps: { orgRecords, orgRewrite, logger } };
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
    const { world, deps } = await jobWorld(fresh(USE));
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
      fresh(
        runningRewrite({
          jobId: 'job-1',
          action: 'rename',
          fromTexts: [ATLANTA.name],
          fields: ['housingAuthority', 'accepted_authorities'],
          toName: NEW,
        }),
      ),
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
    // FRESH: a lapsed lock is re-validated first, and 'Gone' is on no list.
    const { world, deps } = await jobWorld(
      fresh(runningRewrite({ jobId: 'job-1', action: 'rename', fromTexts: ['Old Name'], fields: [], toName: 'Gone' })),
    );
    expect(await runOrgRewriteJob({ jobId: 'job-1' }, deps)).toEqual({ outcome: 'failed', counts: {} });
    expect((await world.orgListRepo.peek())?.lastRewrite).toMatchObject({
      status: 'failed',
      error: 'the rewrite names no record fields',
    });
  });

  it('a pass that stops records failed with the counts so far and resolves - it never rethrows', async () => {
    const { world, deps } = await jobWorld(fresh(USE), {
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
    const { deps } = await jobWorld(fresh(USE));
    const result = await runOrgRewriteJob(
      { jobId: 'job-1' },
      {
        ...deps,
        orgRewrite: {
          claim: deps.orgRewrite.claim,
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
    const { world, deps } = await jobWorld(fresh(USE), { contacts: holders });
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
    const { world, deps } = await jobWorld(fresh(USE)); // three holders of 'Atlanta Hsg'
    const newer = runningRewrite({ jobId: 'job-2', action: 'clear', field: 'agency', fromTexts: ['x'] });
    const write = world.contactsRepo.rewriteOrgFields.bind(world.contactsRepo);
    world.contactsRepo.rewriteOrgFields = async (contactId, expected, next) => {
      const outcome = await write(contactId, expected, next);
      // Each write takes 25 s, so the pass heartbeats before every record after
      // the first; after the FIRST write a newer rewrite, job-2, has taken the lock over.
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

// Code review R2-BE-1: a message delivered after its lock LAPSED (15 minutes
// without a heartbeat - a worker down, a backed-up queue) used to run its
// definition unchecked, although every guard that keeps the list compatible
// with it was off meanwhile. The job now CLAIMS its rewrite first: one list
// write that re-validates a lapsed lock exactly as Run again does, and
// refreshes the heartbeat before any record is written.
describe('runOrgRewriteJob - a delivery after its lock lapsed (code review R2-BE-1)', () => {
  const T_START = '2026-10-06T12:00:00.000Z';
  const T_LATE = '2026-10-06T12:16:00.000Z'; // 16 minutes on: the lock has lapsed

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-validates first: a value that became a list name meanwhile is never rewritten - the rewrite ends failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T_START));
    // T0: Settings > Not on the list > housing authority "Metro HA" > Clear. The job is queued.
    const clear = runningRewrite({
      jobId: 'job-1',
      action: 'clear',
      field: 'housingAuthority',
      fromTexts: ['Metro HA'],
      heartbeatAt: T_START,
    });
    const { world, deps } = await jobWorld(clear, { contacts: [holder('t-old', { housingAuthority: 'Metro HA' })] });
    // The worker does not pick it up for 16 minutes: the lock lapses, so the
    // add goes ahead (an add waits only for a FRESH rewrite of its name)...
    vi.setSystemTime(new Date(T_LATE));
    const names = createOrgNamesService({ orgListRepo: world.orgListRepo, logger: quietLogger() });
    await names.add({ kind: 'housing_authority', name: 'Metro HA', actor: 'usr_va' });
    // ...D5 now takes "Metro HA" as an exact list name, and a tenant is saved with it.
    expect(await names.checkScalar('housingAuthority', 'Metro HA', undefined)).toEqual({ ok: true, value: 'Metro HA' });
    world.contacts.push(holder('t-new', { housingAuthority: 'Metro HA' }));
    // Run again refuses this definition now...
    await expect(deps.orgRewrite.runAgain('usr_admin')).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_rewrite_target_gone' },
    });
    // ...and the queued message, delivered late, applies the same check.
    const outcome = await runOrgRewriteJob({ jobId: 'job-1' }, deps);
    expect(world.contacts.find((c) => c.contactId === 't-new')?.['housingAuthority']).toBe('Metro HA');
    expect(world.contacts.find((c) => c.contactId === 't-old')?.['housingAuthority']).toBe('Metro HA');
    expect(rewritesIn(world)).toEqual([]);
    expect(outcome).toEqual({ outcome: 'failed', counts: {} });
    // Recorded failed, naming why - so no delivery of the message can ever run it.
    expect((await world.orgListRepo.peek())?.lastRewrite).toEqual({
      ...clear,
      status: 'failed',
      heartbeatAt: T_LATE,
      finishedAt: T_LATE,
      error: 'org_rewrite_target_gone: a value it rewrites became a name on the list',
    });
    expect(await runOrgRewriteJob({ jobId: 'job-1' }, deps)).toEqual({ outcome: 'not_current' });
  });

  it('re-validates the target too: a late Use whose target left the list meanwhile writes nothing and ends failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T_LATE));
    // "Use Step Up" for the agency value "Steps"; Step Up was deleted while the lock had lapsed.
    const { world, deps } = await jobWorld(
      runningRewrite({ jobId: 'job-1', action: 'use', field: 'agency', fromTexts: ['Steps'], toName: STEP_UP.name, heartbeatAt: T_START }),
      { entries: ORG_FIXTURE.filter((e) => e.orgId !== STEP_UP.orgId), contacts: [holder('t-1', { agency: 'Steps' })] },
    );
    const outcome = await runOrgRewriteJob({ jobId: 'job-1' }, deps);
    expect(world.contacts[0]?.['agency']).toBe('Steps');
    expect(rewritesIn(world)).toEqual([]);
    expect(outcome).toEqual({ outcome: 'failed', counts: {} });
    expect((await world.orgListRepo.peek())?.lastRewrite).toMatchObject({
      jobId: 'job-1',
      status: 'failed',
      error: 'org_rewrite_target_gone: a name it writes left the list or changed kind',
    });
  });

  it('(PIN) a late job whose re-validation passes runs to done', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T_LATE));
    const { world, deps } = await jobWorld({ ...USE, heartbeatAt: T_START });
    const counts = { ...ZERO, housingAuthority: 3 };
    expect(await runOrgRewriteJob({ jobId: 'job-1' }, deps)).toEqual({ outcome: 'done', counts });
    expect(world.contacts.every((c) => c['housingAuthority'] === ATLANTA.name)).toBe(true);
    expect((await world.orgListRepo.peek())?.lastRewrite).toMatchObject({ jobId: 'job-1', status: 'done', counts });
  });

  it('writes no record before a FRESH heartbeat: the claim refreshes a lapsed lock first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T_LATE));
    const { world, deps } = await jobWorld({ ...USE, heartbeatAt: T_START });
    const beatAtWrite: Array<string | undefined> = [];
    const write = world.contactsRepo.rewriteOrgFields.bind(world.contactsRepo);
    world.contactsRepo.rewriteOrgFields = async (contactId, expected, next) => {
      beatAtWrite.push((await world.orgListRepo.peek())?.lastRewrite?.heartbeatAt);
      return write(contactId, expected, next);
    };
    await runOrgRewriteJob({ jobId: 'job-1' }, deps);
    expect(beatAtWrite).toEqual([T_LATE, T_LATE, T_LATE]);
  });

  it('(PIN) a job delivered on time - its lock fresh - runs as before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T12:05:00.000Z'));
    const { world, deps } = await jobWorld({ ...USE, heartbeatAt: T_START });
    const counts = { ...ZERO, housingAuthority: 3 };
    expect(await runOrgRewriteJob({ jobId: 'job-1' }, deps)).toEqual({ outcome: 'done', counts });
    expect(world.contacts.every((c) => c['housingAuthority'] === ATLANTA.name)).toBe(true);
    // The definition untouched; only the run's own state changed.
    expect((await world.orgListRepo.peek())?.lastRewrite).toEqual({
      ...USE,
      status: 'done',
      counts,
      heartbeatAt: '2026-10-06T12:05:00.000Z',
      finishedAt: '2026-10-06T12:05:00.000Z',
    });
  });
});

// Code review R3-BE-1: the claim covers a lock that lapsed BEFORE the pass; a
// lock can also lapse DURING it. Two ways, both with every guard off once it
// has: a stall right before a write, and heartbeats that keep throwing. Either
// way a VA can add the cleared value as a name and save a tenant with it.
describe('runOrgRewriteJob - a lock that lapses DURING the pass (code review R3-BE-1)', () => {
  const T_START = '2026-10-06T12:00:00.000Z';
  const T_LAPSE = '2026-10-06T12:15:00.000Z'; // 15 minutes after the claim's heartbeat
  const T_LATE = '2026-10-06T12:16:00.000Z';
  // Settings > Not on the list > housing authority "Metro HA" > Clear, delivered on time.
  const CLEAR = runningRewrite({
    jobId: 'job-1',
    action: 'clear',
    field: 'housingAuthority',
    fromTexts: ['Metro HA'],
    heartbeatAt: T_START,
  });
  const contactIn = (world: FakeWorld, id: string) => world.contacts.find((c) => c.contactId === id);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a stall before a write: the first record after it is checked first - the VA saved with the new name keeps it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T_START));
    const { world, deps } = await jobWorld(CLEAR, {
      contacts: [holder('l-old', { type: 'landlord', status: 'active', housingAuthority: 'Metro HA' })],
    });
    const names = createOrgNamesService({ orgListRepo: world.orgListRepo, logger: quietLogger() });
    let d5: unknown;
    const list = world.contactsRepo.listByType.bind(world.contactsRepo);
    let stalled = false;
    world.contactsRepo.listByType = async (type, opts) => {
      if (!stalled) {
        stalled = true;
        // The pass's FIRST page read hangs 16 minutes (the client sets no
        // request timeout). At 12:15 the lock lapses, so the add goes ahead...
        vi.setSystemTime(new Date(T_LAPSE));
        await names.add({ kind: 'housing_authority', name: 'Metro HA', actor: 'usr_va' });
        // ...D5 takes "Metro HA" as an exact list name, and a VA saves a tenant with it...
        d5 = await names.checkScalar('housingAuthority', 'Metro HA', undefined);
        world.contacts.push(holder('t-new', { housingAuthority: 'Metro HA' }));
        // ...and at 12:16 the page comes back, the new tenant on it.
        vi.setSystemTime(new Date(T_LATE));
      }
      return list(type, opts);
    };
    const outcome = await runOrgRewriteJob({ jobId: 'job-1' }, deps);
    expect(contactIn(world, 't-new')?.['housingAuthority']).toBe('Metro HA');
    expect(d5).toEqual({ ok: true, value: 'Metro HA' });
    // The heartbeat BEFORE that first record found the lock lapsed: nothing written, no finish.
    expect(outcome).toEqual({ outcome: 'lock_lost', counts: ZERO });
    expect(contactIn(world, 'l-old')?.['housingAuthority']).toBe('Metro HA');
    expect(rewritesIn(world)).toEqual([]);
    expect((await world.orgListRepo.peek())?.lastRewrite).toEqual(CLEAR);
  });

  it('every heartbeat throwing: the run stops once its local lease ran out, before the lock can lapse - the VA saved with the new name keeps it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T_START));
    // 60 holders: a first page of 50, then 10 more.
    const holders = Array.from({ length: 60 }, (_, i) =>
      holder(`h-${String(i).padStart(2, '0')}`, { housingAuthority: 'Metro HA' }),
    );
    const { world, deps } = await jobWorld(CLEAR, { contacts: holders });
    const names = createOrgNamesService({ orgListRepo: world.orgListRepo, logger: quietLogger() });
    // At 12:15 - whether or not the pass still runs - the lock (last heartbeat
    // 12:00) lapses, the add goes ahead, and a VA saves a tenant with the name.
    let vaActed = false;
    const vaActs = async (): Promise<void> => {
      if (vaActed || Date.now() < Date.parse(T_LAPSE)) return;
      vaActed = true;
      await names.add({ kind: 'housing_authority', name: 'Metro HA', actor: 'usr_va' });
      world.contacts.push(holder('t-new', { housingAuthority: 'Metro HA' }));
    };
    const writtenAt: number[] = [];
    const write = world.contactsRepo.rewriteOrgFields.bind(world.contactsRepo);
    world.contactsRepo.rewriteOrgFields = async (contactId, expected, next) => {
      vi.setSystemTime(Date.now() + 25_000); // each write takes 25 s
      await vaActs();
      writtenAt.push(Date.now());
      return write(contactId, expected, next);
    };
    let beats = 0;
    const outcome = await runOrgRewriteJob(
      { jobId: 'job-1' },
      {
        ...deps,
        orgRewrite: {
          claim: deps.orgRewrite.claim,
          // The settings table cannot be read: every heartbeat throws.
          heartbeat: async () => {
            beats += 1;
            throw new Error('settings table unavailable');
          },
          finish: deps.orgRewrite.finish,
        },
      },
    );
    if (!vaActed) {
      vi.setSystemTime(new Date(T_LAPSE));
      await vaActs();
    }
    expect(contactIn(world, 't-new')?.['housingAuthority']).toBe('Metro HA');
    // Every record from the second on beats first; the beats inside the lease
    // (14 minutes - ORG_REWRITE_STALE_MS less 60 s - after the claim) threw and
    // the pass went on; the first one past it stopped the pass: 34 records
    // written, the last at 12:14:10, before the lock could lapse.
    expect(outcome).toEqual({ outcome: 'lock_lost', counts: { ...ZERO, housingAuthority: 34 } });
    expect(beats).toBe(34);
    expect(Math.max(...writtenAt)).toBeLessThan(Date.parse(T_LAPSE));
    // Not finished: left lapsed for Run again - which re-validates, and refuses now.
    expect((await world.orgListRepo.peek())?.lastRewrite).toEqual(CLEAR);
    await expect(deps.orgRewrite.runAgain('usr_admin')).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_rewrite_target_gone' },
    });
  });
});

describe('registerOrgRewriteJobHandler (plan 3.9)', () => {
  afterEach(() => {
    _resetForTests();
  });

  it('registers org.rewrite; dispatch drops a malformed payload WITHOUT throwing and runs a valid one', async () => {
    _resetForTests();
    configureJobsLogger(quietLogger());
    const { world } = await jobWorld(fresh(USE));
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
