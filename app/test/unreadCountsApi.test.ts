// GET /api/unread-counts — unread totals for a NAMED set of contacts and
// conversations.
//
// Replaces a whole-inbox sweep. The tour/placement channel rails needed unread
// for the 2-5 people on one roster and got there by reading every conversation
// and summing client-side: O(inbox) work for an O(people) question, and before
// the paging fix it silently saw only the newest 50 of 668 open threads.
//
// Semantics MUST match the client-side sumUnread it replaces: relay_group and
// group_text threads never count toward a 1:1 total, and a contact's threads are
// resolved across every phone AND email they own.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem, ContactsRepo } from '../src/repos/contactsRepo.js';
import type { ConversationItem, ConversationsRepo } from '../src/repos/conversationsRepo.js';
import { makeFakeUsersRepo, testUserItem, TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';

const SECRET = 'test-origin-secret';

function conv(over: Partial<ConversationItem>): ConversationItem {
  return {
    conversationId: 'c1',
    type: 'tenant_1to1',
    status: 'open',
    unread_count: 0,
    ...over,
  } as ConversationItem;
}

function contact(over: Partial<ContactItem>): ContactItem {
  return { contactId: 'k1', type: 'tenant', ...over } as ContactItem;
}

/** Build the app with fake contacts/conversations repos. `byPhone`/`byEmail`
 *  map a participant key to the threads that key resolves to. */
function makeApp(opts: {
  contacts?: ContactItem[];
  byPhone?: Record<string, ConversationItem[]>;
  byEmail?: Record<string, ConversationItem[]>;
  conversationsById?: Record<string, ConversationItem>;
}) {
  const contactsById = new Map((opts.contacts ?? []).map((c) => [c.contactId, c]));
  const contactsRepo = {
    async getById(id: string) {
      return contactsById.get(id);
    },
  } as unknown as ContactsRepo;
  const conversationsRepo = {
    async findByParticipantPhone(phone: string) {
      return opts.byPhone?.[phone] ?? [];
    },
    async findByParticipantEmail(email: string) {
      return opts.byEmail?.[email] ?? [];
    },
    async getById(id: string) {
      return opts.conversationsById?.[id];
    },
  } as unknown as ConversationsRepo;

  return buildApp({
    config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }),
    logger: createLogger({ destination: createLogCapture().stream }),
    auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
    api: { contactsRepo, conversationsRepo },
  });
}

function get(app: ReturnType<typeof buildApp>, qs: string) {
  return request(app)
    .get(`/api/unread-counts${qs}`)
    .set('x-origin-verify', SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}

describe('GET /api/unread-counts', () => {
  it('sums a contact 1:1 unread across every thread they own', async () => {
    const app = makeApp({
      contacts: [contact({ contactId: 'k1', phone: '+14045550111' })],
      byPhone: {
        '+14045550111': [
          conv({ conversationId: 'c-a', unread_count: 3 }),
          conv({ conversationId: 'c-b', unread_count: 2 }),
        ],
      },
    });
    const res = await get(app, '?contactIds=k1');
    expect(res.status).toBe(200);
    expect(res.body.byContact).toEqual({ k1: 5 });
  });

  it('NEVER counts a relay_group or group_text toward a 1:1 total', async () => {
    // The rail's 1:1 tab must not inherit group noise - this is the invariant
    // the replaced client-side sumUnread enforced.
    const app = makeApp({
      contacts: [contact({ contactId: 'k1', phone: '+14045550111' })],
      byPhone: {
        '+14045550111': [
          conv({ conversationId: 'c-1to1', unread_count: 1 }),
          conv({ conversationId: 'c-relay', type: 'relay_group', unread_count: 99 }),
          conv({ conversationId: 'c-group', type: 'group_text', unread_count: 42 }),
        ],
      },
    });
    const res = await get(app, '?contactIds=k1');
    expect(res.body.byContact).toEqual({ k1: 1 });
  });

  it('resolves threads keyed by EMAIL as well as by phone, deduped by id', async () => {
    const app = makeApp({
      contacts: [contact({ contactId: 'k1', phone: '+14045550111', email: 'k@example.com' })],
      byPhone: { '+14045550111': [conv({ conversationId: 'c-sms', unread_count: 2 })] },
      byEmail: {
        'k@example.com': [
          conv({ conversationId: 'c-mail', unread_count: 4 }),
          // Same thread reachable both ways - must be counted ONCE.
          conv({ conversationId: 'c-sms', unread_count: 2 }),
        ],
      },
    });
    const res = await get(app, '?contactIds=k1');
    expect(res.body.byContact).toEqual({ k1: 6 });
  });

  it('answers 0 for a known contact with no threads, and for an unknown contact', async () => {
    // An id that resolves to nothing must still appear in the map: the caller
    // renders a badge per requested id and a missing key is indistinguishable
    // from a failed lookup.
    const app = makeApp({ contacts: [contact({ contactId: 'k1', phone: '+1404555000' })] });
    const res = await get(app, '?contactIds=k1,nobody');
    expect(res.body.byContact).toEqual({ k1: 0, nobody: 0 });
  });

  it('returns per-conversation unread for explicitly named threads', async () => {
    // The group rail holds a conversationId, not a contact.
    const app = makeApp({
      conversationsById: { g1: conv({ conversationId: 'g1', type: 'relay_group', unread_count: 7 }) },
    });
    const res = await get(app, '?conversationIds=g1,missing');
    expect(res.body.byConversation).toEqual({ g1: 7, missing: 0 });
  });

  it('serves both maps in one round trip', async () => {
    const app = makeApp({
      contacts: [contact({ contactId: 'k1', phone: '+14045550111' })],
      byPhone: { '+14045550111': [conv({ conversationId: 'c-a', unread_count: 1 })] },
      conversationsById: { g1: conv({ conversationId: 'g1', unread_count: 4 }) },
    });
    const res = await get(app, '?contactIds=k1&conversationIds=g1');
    expect(res.body).toEqual({ byContact: { k1: 1 }, byConversation: { g1: 4 } });
  });

  it('answers empty maps when nothing is asked for', async () => {
    const res = await get(makeApp({}), '');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ byContact: {}, byConversation: {} });
  });

  it('REFUSES an unbounded id list rather than fanning out', async () => {
    // Each contact id costs a phone/email fan-out; an open-ended list is a
    // cheap way to make one request do arbitrary work.
    const tooMany = Array.from({ length: 51 }, (_, i) => `k${i}`).join(',');
    const res = await get(makeApp({}), `?contactIds=${tooMany}`);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/50/);
  });

  it('ignores blank entries from a trailing or doubled comma', async () => {
    const app = makeApp({ contacts: [contact({ contactId: 'k1', phone: '+1404555000' })] });
    const res = await get(app, '?contactIds=k1,,');
    expect(res.status).toBe(200);
    expect(res.body.byContact).toEqual({ k1: 0 });
  });
});
