// Route tests — GET /api/contacts/:contactId/relay-groups → { groups: RelayGroupRow[] }.
// Runs on the shared in-memory world (the harness fakes), authed via the real
// sealed session cookie next to the origin secret. Covers:
//   - membership matched by roster contactId (even on a number that isn't the
//     contact's) AND by a SECONDARY phone (roster entry with no contactId);
//   - non-member relay groups + 1:1 threads never match;
//   - closed groups included (status 'closed', NO poolNumber);
//   - newest-activity-first ordering across the open+closed partitions;
//   - otherMemberNames excludes self + nameless entries; owner/tag/memberCount
//     surfaced;
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

  it('surfaces the row fields: pool number, count, owner, tag, other names (self + nameless excluded)', async () => {
    seedContact();
    seedRelay(
      'conv-r3',
      [
        { contactId: TENANT, phone: PHONE_A, name: 'Tina Tenant' }, // self — excluded from others
        { contactId: '', phone: LANDLORD_PHONE, name: 'Lars Landlord' },
        { contactId: '', phone: '+15550100008' }, // nameless — excluded from others
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
        otherMemberNames: ['Lars Landlord'],
      },
    ]);
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
});
