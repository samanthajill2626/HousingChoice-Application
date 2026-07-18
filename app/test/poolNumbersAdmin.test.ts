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
import {
  RELEASE_GRACE_MS,
  type PoolNumberItem,
  type PoolNumberLifecycleState,
  type PoolNumbersRepo,
} from '../src/repos/poolNumbersRepo.js';
import { type MessagingAdapter } from '../src/adapters/messaging.js';
import { type AppConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createPoolNumbersService } from '../src/services/poolNumbers.js';
import { createLogCapture } from './helpers/logCapture.js';

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

// --- W1: de-dupe a mid-transition number the 3-state read projected twice ------
describe('GET /api/pool-numbers - de-dupe mid-transition rows (W1)', () => {
  it('collapses a number a racing transition projected into TWO state partitions to ONE furthest-along row (and a releasing row is not retire-eligible even idle + past grace)', async () => {
    const world = createFakeWorld();
    const pn = '+15551239001';
    // One CLOSED group closed exactly at the grace boundary: idle (zero open) and
    // past grace, so the ONLY thing left to block retire eligibility is the row's
    // non-active lifecycle state (proves the mirror keys off state, not the clock).
    await seedGroup(world, pn, { status: 'closed', createdAt: '2026-01-01T00:00:00.000Z' });
    const atGrace = new Date(NOW.getTime() - RELEASE_GRACE_MS).toISOString();
    // Model the GSI mid active->releasing transition: listByState still returns the
    // STALE 'active' projection AND the FRESH 'releasing' projection of the SAME
    // poolNumber (two copies, same number).
    const staleActive = poolItem(pn, { lifecycle_state: 'active', last_group_closed_at: atGrace });
    const freshReleasing = poolItem(pn, { lifecycle_state: 'releasing', last_group_closed_at: atGrace });
    const pool: PoolNumbersRepo = {
      ...makeFakePoolRepo(),
      async listByState(state: PoolNumberLifecycleState) {
        if (state === 'active') return [staleActive];
        if (state === 'releasing') return [freshReleasing];
        return [];
      },
    };
    const { app } = makeWebhookHarness({ world, poolNumbersRepo: pool, poolNumbersNow: () => NOW });

    const res = await getAdmin(app);
    expect(res.status).toBe(200);
    const rows = numbersOf(res).filter((n) => n.number === pn);
    expect(rows).toHaveLength(1); // collapsed, not duplicated
    const row = rows[0];
    expect(row?.state).toBe('releasing'); // furthest-along wins
    expect(row?.openGroups).toBe(0);
    expect(row?.totalGroups).toBe(1);
    // A releasing row is not retire-eligible even when idle + past grace (the
    // mirror requires lifecycle_state 'active') - route-level releasing coverage.
    expect(row?.retire).toEqual({ eligible: false });
  });
});

// --- W2: an unparseable close stamp must not leak NaN -> null to the client ----
describe('GET /api/pool-numbers - retire mirror NaN guard (W2)', () => {
  it('an unparseable last_group_closed_at yields not-eligible with NO daysRemaining (never NaN -> JSON null on the wire)', async () => {
    const world = createFakeWorld();
    const pn = '+15551239100';
    // Idle (zero open) and hosted (one closed group) so only the corrupt close
    // stamp is left to decide - it must NOT drive a NaN countdown.
    await seedGroup(world, pn, { status: 'closed', createdAt: '2026-01-01T00:00:00.000Z' });
    const pool = makeFakePoolRepo([poolItem(pn, { last_group_closed_at: 'not-a-date' })]);
    const { app } = makeWebhookHarness({ world, poolNumbersRepo: pool, poolNumbersNow: () => NOW });

    const res = await getAdmin(app);
    expect(res.status).toBe(200);
    const row = numbersOf(res).find((n) => n.number === pn);
    expect(row?.openGroups).toBe(0);
    expect(row?.totalGroups).toBe(1);
    expect(row?.retire).toEqual({ eligible: false });
    // NaN serializes to JSON null; assert the wire never carries a null countdown.
    expect(JSON.stringify(res.body)).not.toContain('"daysRemaining":null');
  });
});

// --- W3: PARITY - the retire mirror must agree with the real sweep -------------
//
// Pins the retire mirror (this route's retireMirror) to the sweep
// (services/poolNumbers.ts retireEligible). If you change retireEligible, this
// test failing is the page silently lying about what the CLI will retire -
// update BOTH. Each boundary case runs the SAME fixture through (a) the ROUTE
// (retire.eligible) and (b) the SERVICE with relayNumberReleaseEnabled TRUE (the
// sweep releases exactly what it deems eligible), then asserts the route's
// eligible verdict == the number's membership in the released list.

/** A releasable in-memory pool repo (WORKING beginRelease/releaseNumber/abortRelease). */
function makeReleasableFakeRepo(
  items: PoolNumberItem[],
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
      throw new Error('create: not used by the parity sweep');
    },
    async burnClaim() {
      return undefined;
    },
    async noteGroupClosed() {
      return;
    },
    async beginRelease(poolNumber) {
      const item = store.get(poolNumber);
      if (!item || item.lifecycle_state !== 'active') return undefined;
      item.lifecycle_state = 'releasing';
      return item;
    },
    async abortRelease(poolNumber) {
      const item = store.get(poolNumber);
      if (!item || item.lifecycle_state !== 'releasing') return undefined;
      item.lifecycle_state = 'active';
      return item;
    },
    async releaseNumber(poolNumber) {
      const item = store.get(poolNumber);
      if (!item || item.lifecycle_state !== 'releasing') return undefined;
      item.lifecycle_state = 'released';
      item.released_at = new Date().toISOString();
      return item;
    },
  };
}

/** Quiet logger for the service under test (retireEligible logs on release). */
const parityLogger = createLogger({ destination: createLogCapture().stream });
/** Minimal config: retireEligible only reads relayNumberReleaseEnabled (ON here). */
const RELEASE_ENABLED_CONFIG = {
  messagingDriver: 'console',
  relayLiveProvisioning: true,
  relayNumberReleaseEnabled: true,
} as AppConfig;

type ParityCase = {
  name: string;
  pn: string;
  state: 'active' | 'releasing';
  lastClosedAt?: string;
  groups: Array<'open' | 'closed'>;
  /** The shared verdict both surfaces must reach. */
  eligible: boolean;
};

/**
 * Run one fixture through BOTH surfaces off ONE shared world (identical group
 * composition), returning the route's row + eligible verdict and the sweep's
 * released list (with adapter drops) so the caller can assert they agree.
 */
async function runParity(pc: ParityCase): Promise<{
  row: NumberRowView | undefined;
  eligible: boolean;
  released: string[];
  adapterDrops: string[];
}> {
  const world = createFakeWorld();
  for (const status of pc.groups) {
    await seedGroup(world, pc.pn, { status, createdAt: '2026-01-01T00:00:00.000Z' });
  }
  const recFields: Partial<PoolNumberItem> = {
    lifecycle_state: pc.state,
    ...(pc.lastClosedAt !== undefined && { last_group_closed_at: pc.lastClosedAt }),
  };

  // (a) ROUTE: read retire.eligible from the admin inventory.
  const routePool = makeFakePoolRepo([poolItem(pc.pn, recFields)]);
  const { app } = makeWebhookHarness({ world, poolNumbersRepo: routePool, poolNumbersNow: () => NOW });
  const res = await getAdmin(app);
  const row = numbersOf(res).find((n) => n.number === pc.pn);

  // (b) SWEEP: the service releases exactly the numbers it deems eligible. Same
  // clock, same grace, and the SAME conversations fake (world.conversationsRepo)
  // driving the open-group veto - the inputs the two surfaces genuinely share.
  const adapterDrops: string[] = [];
  const adapter = {
    async releasePhoneNumber(poolNumber: string) {
      adapterDrops.push(poolNumber);
    },
  } as unknown as MessagingAdapter;
  const svc = createPoolNumbersService({
    adapter,
    poolNumbersRepo: makeReleasableFakeRepo([poolItem(pc.pn, recFields)]),
    conversationsRepo: world.conversationsRepo,
    logger: parityLogger,
    now: () => NOW,
    config: RELEASE_ENABLED_CONFIG,
  });
  const released = await svc.retireEligible();

  return { row, eligible: row?.retire.eligible ?? false, released, adapterDrops };
}

describe('GET /api/pool-numbers - retire mirror <-> sweep PARITY (W3)', () => {
  const DAY = DAY_MS;
  const activeCases: ParityCase[] = [
    {
      name: 'exactly at grace -> eligible',
      pn: '+15551239200',
      state: 'active',
      lastClosedAt: new Date(NOW.getTime() - RELEASE_GRACE_MS).toISOString(),
      groups: ['closed'],
      eligible: true,
    },
    {
      name: 'one ms short of grace -> not eligible',
      pn: '+15551239201',
      state: 'active',
      lastClosedAt: new Date(NOW.getTime() - RELEASE_GRACE_MS + 1).toISOString(),
      groups: ['closed'],
      eligible: false,
    },
    {
      name: 'one day short of grace -> not eligible',
      pn: '+15551239202',
      state: 'active',
      lastClosedAt: new Date(NOW.getTime() - RELEASE_GRACE_MS + DAY).toISOString(),
      groups: ['closed'],
      eligible: false,
    },
    {
      name: 'open group past grace -> not eligible',
      pn: '+15551239203',
      state: 'active',
      lastClosedAt: new Date(NOW.getTime() - RELEASE_GRACE_MS - DAY).toISOString(),
      groups: ['closed', 'open'],
      eligible: false,
    },
    {
      name: 'never hosted -> not eligible',
      pn: '+15551239204',
      state: 'active',
      groups: [],
      eligible: false,
    },
    {
      // W4: a corrupt / unparseable last_group_closed_at. The route mirror guards
      // NaN (not eligible); the sweep must SKIP it too - so neither surface acts
      // (the sweep's released list must NOT contain this number).
      name: 'unparseable close stamp -> not eligible (both sides skip corrupt)',
      pn: '+15551239206',
      state: 'active',
      lastClosedAt: 'not-a-date',
      groups: ['closed'],
      eligible: false,
    },
  ];

  it.each(activeCases)('active: $name - route verdict == sweep release membership', async (pc) => {
    const { row, eligible, released, adapterDrops } = await runParity(pc);
    expect(row).toBeDefined();
    expect(eligible).toBe(pc.eligible); // the route's verdict is as expected
    // THE PARITY INVARIANT: the sweep released this number IFF the page said eligible.
    expect(released.includes(pc.pn)).toBe(eligible);
    // The Twilio drop happened exactly when the release did (belt + braces).
    expect(adapterDrops.includes(pc.pn)).toBe(eligible);
  });

  it('releasing past grace: the route SEES a not-eligible row while the sweep is BLIND to it (listActive) - pairing holds', async () => {
    const pn = '+15551239205';
    const { row, eligible, released, adapterDrops } = await runParity({
      name: 'releasing past grace',
      pn,
      state: 'releasing',
      lastClosedAt: new Date(NOW.getTime() - RELEASE_GRACE_MS - DAY).toISOString(),
      groups: ['closed'],
      eligible: false,
    });
    // The route iterates ALL states, so it renders the releasing row...
    expect(row).toBeDefined();
    expect(row?.state).toBe('releasing');
    expect(eligible).toBe(false); // ...but the mirror requires 'active'.
    // The sweep only ever reads listActive, so a releasing number is invisible to
    // it and is never released. Parity still holds: false == false.
    expect(released).not.toContain(pn);
    expect(adapterDrops).not.toContain(pn);
    expect(released.includes(pn)).toBe(eligible);
  });
});
