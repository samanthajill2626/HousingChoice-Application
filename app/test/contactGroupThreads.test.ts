// Route tests - GET /api/contacts/:contactId/group-threads
//   -> { groups: GroupThreadRow[], truncated: boolean }.
// The contact page's "Group threads" card. Runs on the shared in-memory world,
// authed via the real sealed session cookie next to the origin secret. Covers:
//   - membership matched by roster contactId AND by any of the contact's numbers
//     (a roster entry minted for a bare phone carries no contactId);
//   - relay groups and 1:1 threads never appear here - by PARTITION, not by any
//     type filter (the route has none; see that test's own comment);
//   - otherMemberNames excludes self and nameless entries (names only, no phone);
//   - the BOUNDED read reports truncation instead of silently clipping;
//   - 404 unknown contact + 404 a phone-pointer id; empty list for none.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { phoneRefId } from '../src/repos/contactsRepo.js';
import type { ConversationParticipant } from '../src/repos/conversationsRepo.js';
import { groupThreadLabel } from '../src/lib/groupTitle.js';

const TENANT = 'c-tenant';
const PHONE_A = '+15550100001';
const PHONE_B = '+15550100002';
const OTHER_PHONE = '+15550100003';

describe('GET /api/contacts/:id/group-threads', () => {
  let app: Express;
  let world: FakeWorld;

  beforeEach(() => {
    const h = makeWebhookHarness();
    app = h.app;
    world = h.world;
  });

  const authedGet = (path: string) =>
    request(app).get(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

  function seedContact(): void {
    world.contacts.push({
      contactId: TENANT,
      type: 'tenant',
      status: 'active',
      phone: PHONE_A,
      phones: [
        { phone: PHONE_A, primary: true },
        { phone: PHONE_B, primary: false, label: 'work' },
      ],
    });
  }

  async function seedGroup(
    conversationId: string,
    members: ConversationParticipant[],
    lastActivityAt = '2026-06-17T10:00:00.000Z',
  ): Promise<void> {
    await world.conversationsRepo.createGroupTextThread({
      conversationId,
      members,
      lastActivityAt,
    });
  }

  it('returns the group texts this contact is rostered on, by contactId', async () => {
    seedContact();
    await seedGroup('gt-1', [
      { contactId: TENANT, phone: PHONE_A, name: 'Tasha Tenant' },
      { contactId: 'c-other', phone: OTHER_PHONE, name: 'Marcus Landlord' },
    ]);

    const res = await authedGet(`/api/contacts/${TENANT}/group-threads`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      groups: [
        {
          conversationId: 'gt-1',
          memberCount: 2,
          lastActivityAt: '2026-06-17T10:00:00.000Z',
          // Self is excluded - the label names who ELSE is in the thread, and
          // it comes from the ONE server-side derivation the inbox row and the
          // thread header also use (lib/groupTitle.ts).
          title: 'With Marcus',
          otherMemberNames: ['Marcus Landlord'],
        },
      ],
      truncated: false,
    });
  });

  it('titles a NAMELESS roster (every migrated group) exactly as the inbox row does', async () => {
    // The migration shape: an imported roster carries no `name`. The card used
    // to derive its own label over `otherMemberNames` and rendered a bare
    // "Group text" here while the very same thread showed real names in its
    // header. One thread must not carry three different names.
    seedContact();
    await seedGroup('gt-nameless', [
      { contactId: TENANT, phone: PHONE_A },
      { contactId: 'c-other', phone: OTHER_PHONE },
    ]);

    const res = await authedGet(`/api/contacts/${TENANT}/group-threads`);

    expect(res.status).toBe(200);
    const row = res.body.groups[0];
    expect(row.otherMemberNames).toEqual([]);
    expect(row.title).toBe(groupThreadLabel([{ contactId: 'c-other', phone: OTHER_PHONE }]));
    expect(row.title).not.toBe('Group text');
  });

  it('matches a SECONDARY number whose roster entry carries no contactId', async () => {
    seedContact();
    await seedGroup('gt-2', [
      { contactId: '', phone: PHONE_B },
      { contactId: 'c-other', phone: OTHER_PHONE, name: 'Marcus Landlord' },
    ]);

    const res = await authedGet(`/api/contacts/${TENANT}/group-threads`);

    expect(res.body.groups.map((g: { conversationId: string }) => g.conversationId)).toEqual([
      'gt-2',
    ]);
  });

  it('omits threads the contact is not in', async () => {
    seedContact();
    await seedGroup('gt-3', [
      { contactId: 'c-other', phone: OTHER_PHONE, name: 'Marcus Landlord' },
      { contactId: 'c-third', phone: '+15550100009', name: 'Dee Third' },
    ]);

    const res = await authedGet(`/api/contacts/${TENANT}/group-threads`);
    expect(res.body.groups).toEqual([]);
    expect(res.body.truncated).toBe(false);
  });

  it('shows neither the relay group nor the 1:1 this contact IS on - the group_open partition read is the WHOLE exclusion', async () => {
    // NAMED FOR WHAT IT PROVES. The route has NO type filter: it reads the
    // `group_open` partition through listGroupTexts and matches rosters in code,
    // so a relay group or a 1:1 is excluded purely by living in another
    // partition. Forcing listGroupTexts to hand back a relay row would NOT be
    // excluded - it would be rendered - which is exactly why the old name
    // ("never returns a relay group or a 1:1 thread") promised a guard that does
    // not exist. If a type filter is ever wanted here, it has to be written
    // first; this test would not have caught its absence.
    seedContact();
    await world.conversationsRepo.createRelayGroup({
      poolNumber: '+15550190001',
      members: [{ contactId: TENANT, phone: PHONE_A, name: 'Tasha Tenant' }],
    });
    await world.conversationsRepo.createOrGetByParticipantPhone(PHONE_A, 'tenant_1to1');

    const res = await authedGet(`/api/contacts/${TENANT}/group-threads`);
    expect(res.body.groups).toEqual([]);
  });

  it('drops nameless other members rather than showing their number', async () => {
    seedContact();
    await seedGroup('gt-4', [
      { contactId: TENANT, phone: PHONE_A, name: 'Tasha Tenant' },
      { contactId: '', phone: OTHER_PHONE },
    ]);

    const res = await authedGet(`/api/contacts/${TENANT}/group-threads`);
    expect(res.body.groups[0]).toMatchObject({ memberCount: 2, otherMemberNames: [] });
  });

  it('orders newest-activity-first', async () => {
    seedContact();
    const me: ConversationParticipant = { contactId: TENANT, phone: PHONE_A, name: 'Tasha Tenant' };
    const them: ConversationParticipant = { contactId: 'c-other', phone: OTHER_PHONE, name: 'Marcus' };
    await seedGroup('gt-old', [me, them], '2026-06-10T10:00:00.000Z');
    await seedGroup('gt-new', [me, them], '2026-06-18T10:00:00.000Z');

    const res = await authedGet(`/api/contacts/${TENANT}/group-threads`);
    expect(res.body.groups.map((g: { conversationId: string }) => g.conversationId)).toEqual([
      'gt-new',
      'gt-old',
    ]);
  });

  it('SURFACES truncation when the bounded read stops early', async () => {
    seedContact();
    const me: ConversationParticipant = { contactId: TENANT, phone: PHONE_A, name: 'Tasha Tenant' };
    const them: ConversationParticipant = { contactId: 'c-other', phone: OTHER_PHONE, name: 'Marcus' };
    await seedGroup('gt-1', [me, them]);
    // There is no member->thread index, so a clipped walk could omit a thread
    // this contact IS in. The flag rides the wire; the card shows it.
    const real = world.conversationsRepo.listGroupTexts.bind(world.conversationsRepo);
    world.conversationsRepo.listGroupTexts = async (opts) => ({
      ...(await real(opts)),
      truncated: true,
    });

    const res = await authedGet(`/api/contacts/${TENANT}/group-threads`);
    expect(res.body.truncated).toBe(true);
    expect(res.body.groups).toHaveLength(1);
  });

  it('404s an unknown contact and a phone-pointer id', async () => {
    seedContact();
    expect((await authedGet('/api/contacts/nope/group-threads')).status).toBe(404);
    const pointerId = phoneRefId(PHONE_A);
    world.contacts.push({ contactId: pointerId, phone_ref: true, phone_ref_owner: TENANT } as never);
    expect(
      (await authedGet(`/api/contacts/${encodeURIComponent(pointerId)}/group-threads`)).status,
    ).toBe(404);
  });
});
