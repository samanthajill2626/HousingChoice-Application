// GET /api/pool-numbers - the admin-only, read-only pool-number inventory
// (group text numbers). Asserts: the requireRole('admin') gate (VA -> 403), the
// pool-record -> groups join (open/closed counts + newest-first order), the
// burnedCount (Set-size / absent), the retire mirror boundaries (injected clock),
// per-group label precedence + closedAt semantics, and two PII invariants
// (burned_phones contents never serialized; no phone in any log line).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TEST_ADMIN_COOKIE, TEST_SESSION_COOKIE } from './helpers/authSession.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';
import { RELEASE_GRACE_MS, type PoolNumberItem, type PoolNumbersRepo } from '../src/repos/poolNumbersRepo.js';

// --- The response contract, from the consumer's side (T3 copies it verbatim) ---
interface GroupRowView {
  conversationId: string;
  label: string;
  memberCount: number;
  status: 'open' | 'closed';
  createdAt?: string;
  closedAt?: string;
  lastActivityAt?: string;
}
interface NumberRowView {
  number: string;
  state: 'active' | 'releasing' | 'released';
  openGroups: number;
  totalGroups: number;
  burnedCount: number;
  lastActivityAt?: string;
  lastGroupClosedAt?: string;
  releasedAt?: string;
  retire: { eligible: boolean; daysRemaining?: number };
  groups: GroupRowView[];
}

const SECRET = ORIGIN_SECRET;
const SENTINEL = '0000-00-00T00:00:00.000Z';
const NOW = new Date('2026-07-18T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function numbersOf(res: request.Response): NumberRowView[] {
  return (res.body as { numbers: NumberRowView[] }).numbers;
}

function getAdmin(app: import('express').Express): Promise<request.Response> {
  return request(app)
    .get('/api/pool-numbers')
    .set('x-origin-verify', SECRET)
    .set('cookie', TEST_ADMIN_COOKIE);
}

/** A pool_numbers item with the required fields defaulted (active by default). */
function poolItem(poolNumber: string, over: Partial<PoolNumberItem> = {}): PoolNumberItem {
  return {
    poolNumber,
    lifecycle_state: 'active',
    quarantine_until: SENTINEL,
    voice_capable: true,
    sms_capable: true,
    provisioned_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/**
 * A read-only in-memory PoolNumbersRepo: listByState/listActive/get read the
 * seeded store; the mutators are unused stubs (the admin route never writes).
 */
function makeFakePoolRepo(
  items: PoolNumberItem[] = [],
): PoolNumbersRepo & { store: Map<string, PoolNumberItem> } {
  const store = new Map<string, PoolNumberItem>(items.map((i) => [i.poolNumber, i]));
  return {
    store,
    async get(poolNumber) {
      return store.get(poolNumber);
    },
    async listActive() {
      return [...store.values()].filter((i) => i.lifecycle_state === 'active');
    },
    async listByState(state) {
      return [...store.values()].filter((i) => i.lifecycle_state === state);
    },
    async create() {
      throw new Error('create: not used by the read-only admin route');
    },
    async burnClaim() {
      return undefined;
    },
    async noteGroupClosed() {
      return;
    },
    async beginRelease() {
      return undefined;
    },
    async abortRelease() {
      return undefined;
    },
    async releaseNumber() {
      return undefined;
    },
  };
}

type Member = { contactId: string; phone: string; name?: string };

/**
 * Seed a relay group onto `pool` through the world fake, then mutate the fields
 * createRelayGroup fixes to 'now'/'open' (the returned item IS the stored ref).
 */
async function seedGroup(
  world: FakeWorld,
  pool: string,
  over: {
    members?: Member[];
    tag?: string;
    status?: 'open' | 'closed';
    createdAt?: string;
    lastActivityAt?: string;
    closeAnnouncedAt?: string;
  } = {},
) {
  const members = over.members ?? [{ contactId: 'c1', phone: '+15550000001', name: 'Member One' }];
  const group = await world.conversationsRepo.createRelayGroup({
    poolNumber: pool,
    members,
    ...(over.tag !== undefined && { tag: over.tag }),
  });
  if (over.status !== undefined) group.status = over.status;
  if (over.createdAt !== undefined) group.created_at = over.createdAt;
  if (over.lastActivityAt !== undefined) group.last_activity_at = over.lastActivityAt;
  if (over.closeAnnouncedAt !== undefined) group.close_announced_at = over.closeAnnouncedAt;
  return group;
}

describe('GET /api/pool-numbers - admin gate', () => {
  it('403s a VA with {error:forbidden} (same shape as the other admin routes)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/pool-numbers')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE); // VA
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });
});

describe('GET /api/pool-numbers - join + counts', () => {
  it('joins a number to its groups: one open + one closed -> openGroups 1, totalGroups 2, newest-first', async () => {
    const world = createFakeWorld();
    const pn = '+15551230001';
    await seedGroup(world, pn, {
      status: 'closed',
      createdAt: '2026-03-01T00:00:00.000Z',
      lastActivityAt: '2026-03-02T00:00:00.000Z',
    });
    const openGroup = await seedGroup(world, pn, {
      status: 'open',
      createdAt: '2026-05-01T00:00:00.000Z',
      lastActivityAt: '2026-05-09T00:00:00.000Z',
    });
    const pool = makeFakePoolRepo([poolItem(pn)]);
    const { app } = makeWebhookHarness({ world, poolNumbersRepo: pool });

    const res = await getAdmin(app);
    expect(res.status).toBe(200);
    const row = numbersOf(res).find((n) => n.number === pn);
    expect(row).toBeDefined();
    expect(row).toMatchObject({ state: 'active', openGroups: 1, totalGroups: 2 });
    // Newest first: the open group (created 2026-05) precedes the closed (2026-03).
    expect(row?.groups[0]?.conversationId).toBe(openGroup.conversationId);
    expect(row?.groups.map((g) => g.status)).toEqual(['open', 'closed']);
    // number-level lastActivityAt = max of the groups' last_activity_at.
    expect(row?.lastActivityAt).toBe('2026-05-09T00:00:00.000Z');
  });

  it('burnedCount is the Set size; 0 when the attribute is absent', async () => {
    const withBurn = '+15551230010';
    const noBurn = '+15551230011';
    const pool = makeFakePoolRepo([
      poolItem(withBurn, { burned_phones: new Set(['+15559990001', '+15559990002', '+15559990003']) }),
      poolItem(noBurn),
    ]);
    const { app } = makeWebhookHarness({ world: createFakeWorld(), poolNumbersRepo: pool });

    const res = await getAdmin(app);
    expect(res.status).toBe(200);
    expect(numbersOf(res).find((n) => n.number === withBurn)?.burnedCount).toBe(3);
    expect(numbersOf(res).find((n) => n.number === noBurn)?.burnedCount).toBe(0);
  });
});

describe('GET /api/pool-numbers - retire mirror (injected clock)', () => {
  it('exactly at the grace boundary -> eligible', async () => {
    const world = createFakeWorld();
    const pn = '+15551230100';
    await seedGroup(world, pn, { status: 'closed', createdAt: '2026-01-01T00:00:00.000Z' });
    const atGrace = new Date(NOW.getTime() - RELEASE_GRACE_MS).toISOString();
    const pool = makeFakePoolRepo([poolItem(pn, { last_group_closed_at: atGrace })]);
    const { app } = makeWebhookHarness({ world, poolNumbersRepo: pool, poolNumbersNow: () => NOW });

    const res = await getAdmin(app);
    const row = numbersOf(res).find((n) => n.number === pn);
    expect(row?.retire).toEqual({ eligible: true });
  });

  it('one day short of grace -> not eligible, daysRemaining 1', async () => {
    const world = createFakeWorld();
    const pn = '+15551230101';
    await seedGroup(world, pn, { status: 'closed', createdAt: '2026-01-01T00:00:00.000Z' });
    const oneDayShort = new Date(NOW.getTime() - RELEASE_GRACE_MS + DAY_MS).toISOString();
    const pool = makeFakePoolRepo([poolItem(pn, { last_group_closed_at: oneDayShort })]);
    const { app } = makeWebhookHarness({ world, poolNumbersRepo: pool, poolNumbersNow: () => NOW });

    const res = await getAdmin(app);
    const row = numbersOf(res).find((n) => n.number === pn);
    expect(row?.retire).toEqual({ eligible: false, daysRemaining: 1 });
  });

  it('an OPEN group -> not eligible AND daysRemaining absent (even past grace)', async () => {
    const world = createFakeWorld();
    const pn = '+15551230102';
    // Past grace by the pool clock, but a live open group vetoes both eligibility
    // and the countdown.
    await seedGroup(world, pn, { status: 'open', createdAt: '2026-01-01T00:00:00.000Z' });
    const atGrace = new Date(NOW.getTime() - RELEASE_GRACE_MS).toISOString();
    const pool = makeFakePoolRepo([poolItem(pn, { last_group_closed_at: atGrace })]);
    const { app } = makeWebhookHarness({ world, poolNumbersRepo: pool, poolNumbersNow: () => NOW });

    const res = await getAdmin(app);
    const row = numbersOf(res).find((n) => n.number === pn);
    expect(row?.openGroups).toBe(1);
    expect(row?.retire).toEqual({ eligible: false });
    expect(row?.retire.daysRemaining).toBeUndefined();
  });

  it('never-hosted (no groups, no last_group_closed_at) -> not eligible, no countdown', async () => {
    const pn = '+15551230103';
    const pool = makeFakePoolRepo([poolItem(pn)]);
    const { app } = makeWebhookHarness({ world: createFakeWorld(), poolNumbersRepo: pool, poolNumbersNow: () => NOW });

    const res = await getAdmin(app);
    const row = numbersOf(res).find((n) => n.number === pn);
    expect(row?.totalGroups).toBe(0);
    expect(row?.retire).toEqual({ eligible: false });
  });

  it('a released row -> state released, releasedAt present, eligible false', async () => {
    const world = createFakeWorld();
    const pn = '+15551230104';
    await seedGroup(world, pn, { status: 'closed', createdAt: '2026-01-01T00:00:00.000Z' });
    const releasedAt = '2026-07-01T00:00:00.000Z';
    // Past grace too - proves the eligible mirror still requires lifecycle_state active.
    const atGrace = new Date(NOW.getTime() - RELEASE_GRACE_MS).toISOString();
    const pool = makeFakePoolRepo([
      poolItem(pn, { lifecycle_state: 'released', released_at: releasedAt, last_group_closed_at: atGrace }),
    ]);
    const { app } = makeWebhookHarness({ world, poolNumbersRepo: pool, poolNumbersNow: () => NOW });

    const res = await getAdmin(app);
    const row = numbersOf(res).find((n) => n.number === pn);
    expect(row?.state).toBe('released');
    expect(row?.releasedAt).toBe(releasedAt);
    expect(row?.retire.eligible).toBe(false);
  });
});

describe('GET /api/pool-numbers - group label precedence', () => {
  it('names > tag > "Group text"', async () => {
    const world = createFakeWorld();
    const pn = '+15551230200';
    const withNames = await seedGroup(world, pn, {
      members: [
        { contactId: 'c1', phone: '+15550000001', name: 'Alice' },
        { contactId: 'c2', phone: '+15550000002', name: 'Bob' },
      ],
      createdAt: '2026-05-03T00:00:00.000Z',
    });
    const withTag = await seedGroup(world, pn, {
      members: [{ contactId: 'c3', phone: '+15550000003' }],
      tag: 'Maple St lease-up',
      createdAt: '2026-05-02T00:00:00.000Z',
    });
    const bare = await seedGroup(world, pn, {
      members: [{ contactId: 'c4', phone: '+15550000004' }],
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    const pool = makeFakePoolRepo([poolItem(pn)]);
    const { app } = makeWebhookHarness({ world, poolNumbersRepo: pool });

    const res = await getAdmin(app);
    const groups = numbersOf(res).find((n) => n.number === pn)?.groups ?? [];
    const byId = (id: string) => groups.find((g) => g.conversationId === id);
    expect(byId(withNames.conversationId)?.label).toBe('With Alice & Bob');
    expect(byId(withNames.conversationId)?.memberCount).toBe(2);
    expect(byId(withTag.conversationId)?.label).toBe('Maple St lease-up');
    expect(byId(bare.conversationId)?.label).toBe('Group text');
  });
});

describe('GET /api/pool-numbers - per-group closedAt', () => {
  it('close_announced_at surfaces only for a CLOSED group that has it', async () => {
    const world = createFakeWorld();
    const pn = '+15551230300';
    const closedWithAttr = await seedGroup(world, pn, {
      status: 'closed',
      closeAnnouncedAt: '2026-06-01T12:00:00.000Z',
      createdAt: '2026-05-03T00:00:00.000Z',
    });
    // Crash window: marker set but the group is still OPEN -> closedAt suppressed.
    const openWithAttr = await seedGroup(world, pn, {
      status: 'open',
      closeAnnouncedAt: '2026-06-02T12:00:00.000Z',
      createdAt: '2026-05-02T00:00:00.000Z',
    });
    const closedNoAttr = await seedGroup(world, pn, {
      status: 'closed',
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    const pool = makeFakePoolRepo([poolItem(pn)]);
    const { app } = makeWebhookHarness({ world, poolNumbersRepo: pool });

    const res = await getAdmin(app);
    const groups = numbersOf(res).find((n) => n.number === pn)?.groups ?? [];
    const byId = (id: string) => groups.find((g) => g.conversationId === id);
    expect(byId(closedWithAttr.conversationId)?.closedAt).toBe('2026-06-01T12:00:00.000Z');
    expect(byId(openWithAttr.conversationId)?.closedAt).toBeUndefined();
    expect(byId(closedNoAttr.conversationId)?.closedAt).toBeUndefined();
  });
});

describe('GET /api/pool-numbers - PII', () => {
  it('never serializes burned_phones CONTENTS (count only)', async () => {
    const pn = '+15551230400';
    const secret = '+15559998888';
    const pool = makeFakePoolRepo([poolItem(pn, { burned_phones: new Set([secret, '+15559997777']) })]);
    const { app } = makeWebhookHarness({ world: createFakeWorld(), poolNumbersRepo: pool });

    const res = await getAdmin(app);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(numbersOf(res).find((n) => n.number === pn)?.burnedCount).toBe(2);
  });

  it('logs no phone number in any line (counts/states only)', async () => {
    const world = createFakeWorld();
    const pn = '+15551230500';
    await seedGroup(world, pn, { members: [{ contactId: 'c1', phone: '+15558887777', name: 'Pat' }] });
    const pool = makeFakePoolRepo([poolItem(pn, { burned_phones: new Set(['+15559990001']) })]);
    const { app, capture } = makeWebhookHarness({ world, poolNumbersRepo: pool });

    const res = await getAdmin(app);
    expect(res.status).toBe(200);
    // No E.164 anywhere in the captured log lines.
    expect(JSON.stringify(capture.lines)).not.toMatch(/\+1\d{10}/);
  });
});
