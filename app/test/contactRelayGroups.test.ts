// Route tests — GET /api/contacts/:contactId/relay-groups → { groups: RelayGroupRow[] }.
// Runs on the shared in-memory world (the harness fakes), authed via the real
// sealed session cookie next to the origin secret. Covers:
//   - membership matched by roster contactId (even on a number that isn't the
//     contact's) AND by a SECONDARY phone (roster entry with no contactId);
//   - non-member relay groups + 1:1 threads never match;
//   - closed groups included (status 'closed', NO poolNumber);
//   - newest-activity-first ordering across the open+closed partitions;
//   - otherMemberNames excludes self and renders a nameless member as their own
//     formatted phone (staff chrome), with the placement_tag carve-out when NOBODY
//     else has a real name; owner/tag/memberCount surfaced;
//   - 404 unknown contact + 404 a phone-pointer id; { groups: [] } for none.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { phoneRefId } from '../src/repos/contactsRepo.js';
import type {
  ConversationItem,
  ConversationParticipant,
} from '../src/repos/conversationsRepo.js';

const TENANT = 'c-tenant';
const PHONE_A = '+15550100001';
const PHONE_B = '+15550100002';
const LANDLORD_PHONE = '+15550100003';
const POOL = '+15550190001';

describe('GET /api/contacts/:id/relay-groups', () => {
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

  /** Seed a relay_group thread directly (full control over every attribute). */
  function seedRelay(
    conversationId: string,
    participants: ConversationParticipant[],
    opts: {
      status?: 'open' | 'closed';
      poolNumber?: string;
      lastActivityAt?: string;
      owner?: ConversationItem['owner'];
      tag?: string;
    } = {},
  ): void {
    const at = opts.lastActivityAt ?? '2026-07-01T10:00:00.000Z';
    const status = opts.status ?? 'open';
    const conv: ConversationItem = {
      conversationId,
      // A relay's participant_phone is the synthetic POOL number.
      participant_phone: opts.poolNumber ?? POOL,
      // A closed relay has RELEASED its pool number (the attribute is cleared).
      ...(status === 'open' && { pool_number: opts.poolNumber ?? POOL }),
      status,
      // The byRelayStatus GSI HASH, stamped in LOCKSTEP with `status` exactly as
      // the real writer does (conversationsRepo.ts:1875). It is not optional
      // decoration: `listRelayGroups` Queries that sparse index and consults
      // NOTHING else, so a relay row without it is a shape production can never
      // produce - it would be invisible to every relay read.
      //
      // These fixtures omitted it and passed anyway, because the in-memory
      // double used to filter on `type`+`status` instead. Correcting that double
      // to read `relay_status` (the field the real GSI reads) turned all eight
      // of these tests red at once, which is the drift doing exactly what it was
      // filed to prevent - assertions made against a row the service could not
      // return. See docs/issues/relay-duplicate-detection-fake-partition-drift.md.
      relay_status: `relay_group#${status}`,
      last_activity_at: at,
      type: 'relay_group',
      ai_mode: 'manual',
      participants,
      created_at: at,
      ...(opts.owner !== undefined && { owner: opts.owner }),
      ...(opts.tag !== undefined && { placement_tag: opts.tag }),
    };
    world.conversations.set(conversationId, conv);
  }

  it('404s an unknown contact', async () => {
    const res = await authedGet('/api/contacts/nope/relay-groups');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('contact_not_found');
  });

  it('404s a phone-pointer id (internal routing record, never a contact)', async () => {
    seedContact();
    const pointerId = phoneRefId(PHONE_B);
    world.contacts.push({
      contactId: pointerId,
      type: 'unknown',
      phone: PHONE_B,
      phone_ref: true,
      phone_ref_owner: TENANT,
    } as never);
    const res = await authedGet(`/api/contacts/${encodeURIComponent(pointerId)}/relay-groups`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('contact_not_found');
  });

  it('returns { groups: [] } for a contact in no groups', async () => {
    seedContact();
    // A relay the contact is NOT in, plus their own 1:1 — neither may match.
    seedRelay('conv-other', [
      { contactId: 'c-someone', phone: '+15550100009', name: 'Someone Else' },
      { contactId: '', phone: LANDLORD_PHONE },
    ]);
    world.conversations.set('conv-1to1', {
      conversationId: 'conv-1to1',
      participant_phone: PHONE_A,
      status: 'open',
      last_activity_at: '2026-07-01T09:00:00.000Z',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      participants: [{ contactId: TENANT, phone: PHONE_A }],
      created_at: '2026-07-01T09:00:00.000Z',
    });
    const res = await authedGet(`/api/contacts/${TENANT}/relay-groups`);
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
  });

  it('matches by roster contactId even when the roster phone is not on the contact', async () => {
    seedContact();
    // The member entry carries a phone the contact does NOT have (e.g. added by
    // an operator with a stale number) — the contactId link still counts.
    seedRelay('conv-r1', [
      { contactId: TENANT, phone: '+15550109999', name: 'Tina Tenant' },
      { contactId: '', phone: LANDLORD_PHONE, name: 'Lars Landlord' },
    ]);
    const res = await authedGet(`/api/contacts/${TENANT}/relay-groups`);
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].conversationId).toBe('conv-r1');
  });

  it('matches by a SECONDARY phone (roster entry with no contactId)', async () => {
    seedContact();
    seedRelay('conv-r2', [
      { contactId: '', phone: PHONE_B }, // the contact's work number, unlinked
      { contactId: '', phone: LANDLORD_PHONE, name: 'Lars Landlord' },
    ]);
    const res = await authedGet(`/api/contacts/${TENANT}/relay-groups`);
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].conversationId).toBe('conv-r2');
  });

  it('surfaces the row fields: pool number, count, owner, tag, other names (self excluded, nameless shown by number)', async () => {
    seedContact();
    seedRelay(
      'conv-r3',
      [
        { contactId: TENANT, phone: PHONE_A, name: 'Tina Tenant' }, // self — excluded from others
        { contactId: '', phone: LANDLORD_PHONE, name: 'Lars Landlord' },
        // Nameless - rendered as their OWN formatted phone, not dropped. This card
        // is staff chrome; the navigator needs somebody to call, and a silently
        // shorter list misrepresents who is on the thread.
        { contactId: '', phone: '+15550100008' },
      ],
      {
        poolNumber: POOL,
        lastActivityAt: '2026-07-02T12:00:00.000Z',
        owner: { type: 'tour', id: 'tour-1' },
        tag: 'Maple St tour',
      },
    );
    const res = await authedGet(`/api/contacts/${TENANT}/relay-groups`);
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([
      {
        conversationId: 'conv-r3',
        status: 'open',
        poolNumber: POOL,
        memberCount: 3,
        lastActivityAt: '2026-07-02T12:00:00.000Z',
        owner: { type: 'tour', id: 'tour-1' },
        tag: 'Maple St tour',
        otherMemberNames: ['Lars Landlord', '(555) 010-0008'],
      },
    ]);
  });

  it('sends NO otherMemberNames when nobody else is named and a tag exists (the tag carve-out)', async () => {
    // The client mirror (GroupTextsCard groupLabel) computes its own precedence
    // over this DTO: names -> tag -> pool number. Handing it a list of raw digits
    // would make its tag rung unreachable for every group that has members, so an
    // empty array is how the server says "let the operator's label win here".
    seedContact();
    seedRelay(
      'conv-r9',
      [
        { contactId: TENANT, phone: PHONE_A, name: 'Tina Tenant' },
        { contactId: '', phone: LANDLORD_PHONE },
      ],
      { lastActivityAt: '2026-07-02T12:00:00.000Z', tag: 'Maple St tour' },
    );
    const res = await authedGet(`/api/contacts/${TENANT}/relay-groups`);
    expect(res.status).toBe(200);
    expect(res.body.groups[0].otherMemberNames).toEqual([]);
    expect(res.body.groups[0].tag).toBe('Maple St tour');
  });

  it('falls back to numbers when nobody else is named and there is NO tag', async () => {
    seedContact();
    seedRelay(
      'conv-r10',
      [
        { contactId: TENANT, phone: PHONE_A, name: 'Tina Tenant' },
        { contactId: '', phone: LANDLORD_PHONE },
      ],
      { lastActivityAt: '2026-07-02T12:00:00.000Z' },
    );
    const res = await authedGet(`/api/contacts/${TENANT}/relay-groups`);
    expect(res.status).toBe(200);
    expect(res.body.groups[0].otherMemberNames).toEqual(['(555) 010-0003']);
  });

  it('legacy placementId-only rows resolve a placement owner (getOwner fallback)', async () => {
    seedContact();
    seedRelay('conv-r4', [{ contactId: TENANT, phone: PHONE_A }], {
      lastActivityAt: '2026-07-02T08:00:00.000Z',
    });
    // Poke the legacy back-reference on (no canonical `owner` field).
    world.conversations.get('conv-r4')!.placementId = 'placement-7';
    const res = await authedGet(`/api/contacts/${TENANT}/relay-groups`);
    expect(res.status).toBe(200);
    expect(res.body.groups[0].owner).toEqual({ type: 'placement', id: 'placement-7' });
  });

  it('includes CLOSED groups — status closed, NO poolNumber — and orders newest-activity-first across partitions', async () => {
    seedContact();
    seedRelay('conv-old-open', [{ contactId: TENANT, phone: PHONE_A }], {
      lastActivityAt: '2026-06-20T10:00:00.000Z',
    });
    seedRelay('conv-closed', [{ contactId: TENANT, phone: PHONE_A }], {
      status: 'closed',
      lastActivityAt: '2026-06-28T10:00:00.000Z',
    });
    seedRelay('conv-new-open', [{ contactId: TENANT, phone: PHONE_A }], {
      lastActivityAt: '2026-07-02T10:00:00.000Z',
    });
    const res = await authedGet(`/api/contacts/${TENANT}/relay-groups`);
    expect(res.status).toBe(200);
    expect(res.body.groups.map((g: { conversationId: string }) => g.conversationId)).toEqual([
      'conv-new-open',
      'conv-closed',
      'conv-old-open',
    ]);
    const closed = res.body.groups[1];
    expect(closed.status).toBe('closed');
    expect(closed.poolNumber).toBeUndefined();
    // Membership survives close — the roster is untouched by the status flip.
    expect(closed.memberCount).toBe(1);
  });

  it('standalone (unowned) groups carry owner { type: null }', async () => {
    seedContact();
    seedRelay('conv-r5', [{ contactId: TENANT, phone: PHONE_A }]);
    const res = await authedGet(`/api/contacts/${TENANT}/relay-groups`);
    expect(res.status).toBe(200);
    expect(res.body.groups[0].owner).toEqual({ type: null });
  });

  // M1 participant-snapshot-refresh: `participants[].name` is a write-time
  // snapshot nothing refreshes, so a member renamed after the group was built
  // kept showing their old name on this card. The card now resolves names from
  // the contacts themselves at read time - in ONE batch.
  it('RED: otherMemberNames come from the OTHER members contacts, not the stored snapshot', async () => {
    seedContact();
    world.contacts.push({
      contactId: 'c-other',
      type: 'landlord',
      status: 'active',
      phone: LANDLORD_PHONE,
      firstName: 'Lena',
      lastName: 'Landlord',
    });
    seedRelay(
      'rg-1',
      [
        { contactId: TENANT, phone: PHONE_A, name: 'Me' },
        { contactId: 'c-other', phone: LANDLORD_PHONE, name: 'Old Landlord' },
      ],
      { status: 'open' },
    );
    const res = await authedGet(`/api/contacts/${TENANT}/relay-groups`);
    expect(res.status).toBe(200);
    expect(res.body.groups[0].otherMemberNames).toEqual(['Lena Landlord']);
  });

  // THE READ BUDGET IS THE PROMISE. The route walks three status partitions, so
  // the batch must sit OUTSIDE that loop and take the ids collected AFTER the
  // membership filter - one read for the card, never one per partition and never
  // one per member. A group this contact is NOT on contributes no ids.
  it('RED: ONE batch per card, over exactly the ids of the groups this contact is in', async () => {
    seedContact();
    seedRelay(
      'rg-open',
      [
        { contactId: TENANT, phone: PHONE_A },
        { contactId: 'c-in-open', phone: LANDLORD_PHONE },
      ],
      { status: 'open' },
    );
    seedRelay(
      'rg-closed',
      [
        { contactId: TENANT, phone: PHONE_A },
        { contactId: 'c-in-closed', phone: '+15550100008' },
      ],
      { status: 'closed' },
    );
    seedRelay('rg-not-mine', [{ contactId: 'c-out', phone: '+15550100009' }], { status: 'open' });
    const real = world.contactsRepo.getDisplaysByIds.bind(world.contactsRepo);
    const batches: string[][] = [];
    world.contactsRepo.getDisplaysByIds = async (ids) => {
      batches.push([...ids]);
      return real(ids);
    };
    await authedGet(`/api/contacts/${TENANT}/relay-groups`);
    expect(batches).toHaveLength(1);
    expect(new Set(batches[0])).toEqual(new Set([TENANT, 'c-in-open', 'c-in-closed']));
  });
});
