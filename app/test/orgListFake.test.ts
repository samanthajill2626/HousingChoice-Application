// The in-memory org-list fake (app/test/helpers/orgListFake.ts) keeps the
// repos/orgListRepo.ts contract the service, job and route suites rely on.
// The real repo is held to the same contract against DynamoDB Local in
// orgListRepo.integration.test.ts.
import { describe, expect, it } from 'vitest';
import { STARTING_ORG_LIST } from '../src/lib/orgStartingList.js';
import { ORG_LIST_MAX_BYTES, OrgListBusyError, OrgListFullError } from '../src/repos/orgListRepo.js';
import { ATLANTA, DCA, orgEntry, orgListItem } from './helpers/orgFixtures.js';
import { createOrgListFake, ORG_LIST_FAKE_NOW } from './helpers/orgListFake.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

const EXTRA = orgEntry({ orgId: 'org-extra', kind: 'agency', name: 'Extra Agency' });

describe('createOrgListFake (mirrors repos/orgListRepo.ts)', () => {
  it('creates the starting list on the FIRST read only, with deterministic ids', async () => {
    const repo = createOrgListFake();
    expect(await repo.peek()).toBeNull();
    const first = await repo.get();
    expect(first.version).toBe(1);
    expect(first.entries.map((e) => e.name)).toEqual(STARTING_ORG_LIST.map((s) => s.name));
    expect(first.entries[0]).toMatchObject({ orgId: 'org-1', createdAt: ORG_LIST_FAKE_NOW, createdBy: 'system' });
    expect(await repo.get()).toEqual(first);
  });

  it('putForSeed() overwrites, and every read hands out a copy', async () => {
    const repo = createOrgListFake();
    await repo.putForSeed(orgListItem([ATLANTA], { version: 9 }));
    const read = await repo.get();
    read.entries.push(DCA);
    const again = await repo.peek();
    expect(again?.entries.map((e) => e.orgId)).toEqual(['org-atl']);
    expect(again?.version).toBe(9);
  });

  it('mutate() bumps the version; a no-op change or a domain error writes nothing', async () => {
    const repo = createOrgListFake();
    await repo.putForSeed(orgListItem([ATLANTA]));
    const read = await repo.mutate((c) => ({ next: { ...c, entries: [...c.entries, DCA] }, result: c.version }));
    expect(read).toBe(1);
    expect((await repo.peek())?.version).toBe(2);
    expect(await repo.mutate((c) => ({ next: c, result: 'same' }))).toBe('same');
    await expect(
      repo.mutate(() => {
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    expect((await repo.peek())?.version).toBe(2);
  });

  it('interleaved mutates re-apply on a fresh read; the one that loses five races gives up busy', async () => {
    const repo = createOrgListFake();
    await repo.putForSeed(orgListItem([ATLANTA]));
    const add = (i: number) =>
      repo.mutate((c) => ({
        next: { ...c, entries: [...c.entries, orgEntry({ orgId: `org-${i}`, kind: 'agency', name: `Agency ${i}` })] },
        result: i,
      }));
    const settled = await Promise.allSettled([1, 2, 3, 4, 5, 6].map(add));
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(5);
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(OrgListBusyError);
    const stored = await repo.peek();
    expect(stored?.version).toBe(6);
    expect(stored?.entries).toHaveLength(6);
  });

  it('refuses past ORG_LIST_MAX_BYTES', async () => {
    const repo = createOrgListFake();
    await expect(
      repo.mutate((c) => ({ next: { ...c, entries: [{ ...EXTRA, notes: 'x'.repeat(ORG_LIST_MAX_BYTES) }] }, result: null })),
    ).rejects.toBeInstanceOf(OrgListFullError);
  });

  it('the harness world carries one, empty until its first read', async () => {
    const world = createFakeWorld();
    expect(await world.orgListRepo.peek()).toBeNull();
    expect((await world.orgListRepo.get()).entries).toHaveLength(STARTING_ORG_LIST.length);
  });
});
