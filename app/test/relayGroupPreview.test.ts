// POST /api/relay-groups/preview (spec 6.2) - what creating a STANDALONE relay
// group WOULD send. A pure read: it provisions nothing, touches no pool number,
// and never consults the provisioning kill-switch.
//
// Runs on the shared in-memory world through makeWebhookHarness (the same
// harness relayApi.test.ts uses), so every request carries BOTH the origin
// secret and the sealed session cookie, and the real Express error middleware
// is mounted - which is what lets the fail-closed test assert a real 500.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { _resetForTests } from '../src/jobs/jobs.js';
import { composeIntroBody } from '../src/jobs/relayFanOut.js';
import type { PoolNumberItem } from '../src/repos/poolNumbersRepo.js';
import type { PoolNumbersService } from '../src/services/poolNumbers.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';

const ALICE = '+15550100001';
const BOB = '+15550100002';
const CARLA = '+15550100003';

/** 23:30 in America/Chicago - inside the pinned 21:00-08:00 window. */
const QUIET_NOW = '2026-08-05T04:30:00.000Z';
/** 12:30 in America/Chicago - outside it. */
const AWAKE_NOW = '2026-08-05T17:30:00.000Z';

/**
 * A pool service that RECORDS every entry point the preview must never reach.
 * The preview asserting `provisionAttempts === 0` is the only way to prove it
 * did not quietly buy or claim a number on a read.
 */
function makeSpyPoolNumbers(): PoolNumbersService & { provisionAttempts: number } {
  const spy = {
    provisionAttempts: 0,
    async provisionForGroup() {
      spy.provisionAttempts += 1;
      const record: PoolNumberItem = {
        poolNumber: '+15550300001',
        lifecycle_state: 'active',
        quarantine_until: '0000-00-00T00:00:00.000Z',
        voice_capable: true,
        sms_capable: true,
        provisioned_at: new Date().toISOString(),
      };
      return { kind: 'assigned' as const, poolNumber: record.poolNumber, record, provisioned: true };
    },
    async noteGroupClosed() {},
    async burnMember() {
      return true;
    },
    async burnGroupRoster() {
      return true;
    },
    async retireEligible() {
      return [];
    },
    async onNumberRegistered() {},
    async warmOneNumber() {
      spy.provisionAttempts += 1;
    },
    async refillBufferIfNeeded() {
      spy.provisionAttempts += 1;
    },
    async flagStuckWarming() {},
    async flagStuckConnecting() {},
    async getRecord() {
      return undefined;
    },
    async clearConnectingEarmarks() {},
  };
  return spy;
}

describe('POST /api/relay-groups/preview (standalone open preview)', () => {
  let world: FakeWorld;

  beforeEach(async () => {
    _resetForTests();
    world = createFakeWorld();
    // Wall-clock default: quiet hours OFF so `deferred` is deterministic for
    // every test that is not specifically about quiet hours.
    await world.settingsRepo.putOrgSettings({ quietHoursEnabled: false });
    world.contacts.push(
      { contactId: 'c-alice', type: 'tenant', phone: ALICE, firstName: 'Alice', lastName: 'Adams' },
      { contactId: 'c-bob', type: 'landlord', phone: BOB, firstName: 'Bob', lastName: 'Brown' },
    );
  });

  afterEach(() => {
    _resetForTests();
    vi.restoreAllMocks();
  });

  const preview = (app: Parameters<typeof request>[0], body: unknown) =>
    request(app)
      .post('/api/relay-groups/preview')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send(body as object);

  it('400s an absent or empty members list, in create wording', async () => {
    const { app } = makeWebhookHarness({ world });

    const absent = await preview(app, {});
    expect(absent.status).toBe(400);
    expect(absent.body.error).toBe('members (non-empty array) is required');

    const empty = await preview(app, { members: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('members (non-empty array) is required');
  });

  it('400s a member with no phone, through the SAME parser create uses', async () => {
    const { app } = makeWebhookHarness({ world });
    const res = await preview(app, { members: [{ name: 'x' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('member.phone is required');
  });

  it('lists an opted-out member but excludes them from recipientCount', async () => {
    world.contacts.push({
      contactId: 'c-otto',
      type: 'tenant',
      phone: CARLA,
      firstName: 'Otto',
      lastName: 'Out',
      sms_opt_out: true,
    });
    const { app } = makeWebhookHarness({ world });

    const res = await preview(app, {
      members: [
        { phone: ALICE, contactId: 'c-alice' },
        { phone: CARLA, contactId: 'c-otto' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.recipients).toEqual([
      { name: 'Alice Adams', reachability: 'reachable' },
      { name: 'Otto Out', reachability: 'opted_out' },
    ]);
    // Suppressed at send, so not a recipient - but still NAMED in the body,
    // because provisioning still puts them on the thread.
    expect(res.body.recipientCount).toBe(1);
    expect(res.body.body).toBe(composeIntroBody(['Alice Adams', 'Otto Out']));
  });

  it('suppresses a member whose per-phone STOP record lives on their 1:1 thread', async () => {
    // isMemberSuppressed is the REAL send gate: contact flag OR a STOPped
    // non-group conversation on that number. describeRoster's narrower rule
    // would miss this one.
    world.conversations.set('conv-bob-1to1', {
      conversationId: 'conv-bob-1to1',
      participant_phone: BOB,
      status: 'open',
      last_activity_at: new Date().toISOString(),
      type: 'landlord_1to1',
      ai_mode: 'auto',
      created_at: new Date().toISOString(),
      sms_opt_out: true,
    });
    const { app } = makeWebhookHarness({ world });

    const res = await preview(app, {
      members: [
        { phone: ALICE, contactId: 'c-alice' },
        { phone: BOB, contactId: 'c-bob' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.recipients[1]).toEqual({ name: 'Bob Brown', reachability: 'opted_out' });
    expect(res.body.recipientCount).toBe(1);
  });

  it('collapses members sharing a phone to ONE recipient, first wins', async () => {
    // Create de-dupes by phone (first wins) before provisioning, so the dialog
    // must not name someone who will never be a participant.
    world.contacts.push({
      contactId: 'c-sharer',
      type: 'tenant',
      phone: ALICE,
      firstName: 'Sam',
      lastName: 'Sharer',
    });
    const { app } = makeWebhookHarness({ world });

    const res = await preview(app, {
      members: [
        { phone: ALICE, contactId: 'c-alice' },
        { phone: ALICE, contactId: 'c-sharer' },
        { phone: BOB, contactId: 'c-bob' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.recipients).toEqual([
      { name: 'Alice Adams', reachability: 'reachable' },
      { name: 'Bob Brown', reachability: 'reachable' },
    ]);
    expect(res.body.recipientCount).toBe(2);
    expect(res.body.body).toBe(composeIntroBody(['Alice Adams', 'Bob Brown']));
  });

  it('names a bare-phone member structurally and never puts a phone in the body', async () => {
    const { app } = makeWebhookHarness({ world });
    const res = await preview(app, {
      members: [{ phone: ALICE, contactId: 'c-alice' }, { phone: '+15550100777' }],
    });

    expect(res.status).toBe(200);
    // No contact, no name - the dialog renders 'Unnamed number' from the
    // absent name; the preview itself carries no phone anywhere.
    expect(res.body.recipients).toEqual([
      { name: 'Alice Adams', reachability: 'reachable' },
      { reachability: 'reachable' },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('5550100777');
  });

  it('uses a client-supplied name VERBATIM, never a recomputed one', async () => {
    // resolveMemberName short-circuits on a supplied name and never reads the
    // contact (spec 2.12), and POST /api/relay-groups does the same. If the
    // preview recomputed from the contact, the confirm dialog would show one
    // name and the intro that actually goes out would show another.
    const { app } = makeWebhookHarness({ world });
    const res = await preview(app, {
      members: [
        { phone: ALICE, contactId: 'c-alice', name: 'Client Supplied' },
        { phone: BOB, contactId: 'c-bob' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.recipients[0].name).toBe('Client Supplied');
    expect(res.body.body).toContain('Client Supplied');
    expect(res.body.body).not.toContain('Alice Adams');
  });

  it('reports deferred:true with the clamped quiet-end instant on a PINNED clock', async () => {
    const { app } = makeWebhookHarness({ world, relayGroupsNow: () => QUIET_NOW });
    await world.settingsRepo.putOrgSettings({
      quietHoursEnabled: true,
      quietHoursStart: '21:00',
      quietHoursEnd: '08:00',
      timezone: 'America/Chicago',
    });

    const res = await preview(app, {
      members: [
        { phone: ALICE, contactId: 'c-alice' },
        { phone: BOB, contactId: 'c-bob' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.deferred).toBe(true);
    expect(res.body.quietEndsAt).toBe('2026-08-05T13:00:00.000Z'); // 08:00 CDT
  });

  it('reports deferred:false with NO quietEndsAt outside the same window', async () => {
    const { app } = makeWebhookHarness({ world, relayGroupsNow: () => AWAKE_NOW });
    await world.settingsRepo.putOrgSettings({
      quietHoursEnabled: true,
      quietHoursStart: '21:00',
      quietHoursEnd: '08:00',
      timezone: 'America/Chicago',
    });

    const res = await preview(app, {
      members: [
        { phone: ALICE, contactId: 'c-alice' },
        { phone: BOB, contactId: 'c-bob' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.deferred).toBe(false);
    expect(res.body).not.toHaveProperty('quietEndsAt');
  });

  it('FAILS CLOSED: a rejecting contact read 500s rather than claiming everyone is reachable', async () => {
    // isMemberSuppressed is deliberately not wrapped in try/catch - a repo
    // failure propagates so no caller ever texts a possibly-opted-out number
    // on a transient read error. The preview inherits that: no body, no dialog.
    const { app } = makeWebhookHarness({ world });
    vi.spyOn(world.contactsRepo, 'getById').mockRejectedValue(new Error('boom: contact read failed'));

    const res = await preview(app, {
      members: [
        { phone: ALICE, contactId: 'c-alice' },
        { phone: BOB, contactId: 'c-bob' },
      ],
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
    expect(res.body).not.toHaveProperty('recipients');
  });

  it('provisions NOTHING: no pool number is claimed, warmed, or bought', async () => {
    const pool = makeSpyPoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });

    const res = await preview(app, {
      members: [
        { phone: ALICE, contactId: 'c-alice' },
        { phone: BOB, contactId: 'c-bob' },
      ],
    });

    expect(res.status).toBe(200);
    expect(pool.provisionAttempts).toBe(0);
    // A preview creates no conversation either.
    expect(world.conversations.size).toBe(0);
  });

  it('warns when a live group has exactly these members', async () => {
    const { app } = makeWebhookHarness({ world });
    await world.conversationsRepo.createRelayGroup({
      poolNumber: '+15550190999',
      members: [
        { contactId: '', phone: ALICE, name: 'Alice Adams' },
        { contactId: '', phone: BOB, name: 'Bob Brown' },
      ],
      owner: { type: null },
    });

    const res = await preview(app, {
      members: [
        { phone: ALICE, name: 'Alice Adams' },
        { phone: BOB, name: 'Bob Brown' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.duplicateOf).toBeDefined();
    expect(res.body.duplicateOf.partition).toBe('open');
    expect(res.body.duplicateOf.memberNames).toEqual(['Alice Adams', 'Bob Brown']);
    // The wire rule: names travel, phones do not.
    expect(JSON.stringify(res.body)).not.toContain(ALICE);
  });

  it('does NOT warn for a superset roster', async () => {
    const { app } = makeWebhookHarness({ world });
    await world.conversationsRepo.createRelayGroup({
      poolNumber: '+15550190998',
      members: [
        { contactId: '', phone: ALICE, name: 'Alice Adams' },
        { contactId: '', phone: BOB, name: 'Bob Brown' },
      ],
      owner: { type: null },
    });

    const res = await preview(app, {
      members: [
        { phone: ALICE, name: 'Alice Adams' },
        { phone: BOB, name: 'Bob Brown' },
        { phone: CARLA, name: 'Carla Cole' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.duplicateOf).toBeUndefined();
  });
});
