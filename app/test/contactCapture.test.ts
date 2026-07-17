// M1.2 unit tests: the contact auto-capture service — stub creation for
// unknown phones, link backfill for known ones, the no-overwrite guarantee,
// and the conversation-anchored race handling (the byPhone GSI is eventually
// consistent; the participants claim is the arbiter). In-memory fakes mirror
// the repos' conditional-write semantics.
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { AuditRepo } from '../src/repos/auditRepo.js';
import type { ContactItem, ContactsRepo } from '../src/repos/contactsRepo.js';
import type {
  ConversationItem,
  ConversationParticipant,
  ConversationsRepo,
} from '../src/repos/conversationsRepo.js';
import { createContactCapture } from '../src/services/contactCapture.js';
import { createLogCapture } from './helpers/logCapture.js';

const PHONE = '+15550100001';

interface CaptureFakes {
  conversation: ConversationItem;
  contacts: ContactItem[];
  /** contactIds actually created by createIfAbsent. */
  creates: string[];
  /** setParticipantsIfAbsent call count (race-path assertions). */
  claimAttempts: number;
  /** When true, findByPhone returns nothing even for stored contacts (GSI lag). */
  simulateGsiLag: boolean;
  auditEvents: { entityKey: string; eventType: string; payload?: Record<string, unknown> }[];
  contactsRepo: ContactsRepo;
  conversationsRepo: ConversationsRepo;
  auditRepo: AuditRepo;
  capture: ReturnType<typeof createContactCapture>;
}

function makeCaptureFakes(seed: { participants?: ConversationParticipant[]; contacts?: ContactItem[] } = {}): CaptureFakes {
  const conversation: ConversationItem = {
    conversationId: 'conv-1',
    participant_phone: PHONE,
    status: 'open',
    last_activity_at: '2026-06-12T09:00:00.000Z',
    type: 'tenant_1to1',
    ai_mode: 'auto',
    created_at: '2026-06-12T09:00:00.000Z',
    ...(seed.participants !== undefined && { participants: seed.participants }),
  };
  const contacts: ContactItem[] = seed.contacts ?? [];
  const creates: string[] = [];
  const auditEvents: CaptureFakes['auditEvents'] = [];

  const fakes = {
    conversation,
    contacts,
    creates,
    claimAttempts: 0,
    simulateGsiLag: false,
    auditEvents,
  } as CaptureFakes;

  const contactsRepo: ContactsRepo = {
    async findByPhone(phone) {
      if (fakes.simulateGsiLag) return undefined;
      return contacts.find((c) => c.phone === phone);
    },
    async getById(contactId) {
      return contacts.find((c) => c.contactId === contactId);
    },
    async createIfAbsent(item) {
      if (contacts.some((c) => c.contactId === item.contactId)) return false;
      contacts.push({ ...item });
      creates.push(item.contactId);
      return true;
    },
    async listByType(type, opts = {}) {
      const items = contacts
        .filter((c) => c.type === type)
        .filter((c) => (opts.status === undefined ? true : c.status === opts.status));
      return { items };
    },
    async listByHousingAuthority(housingAuthority) {
      return { items: contacts.filter((c) => c['housingAuthority'] === housingAuthority) };
    },
    async create(input) {
      const item = { ...input, contactId: input.contactId ?? `contact-${contacts.length + 1}` };
      contacts.push({ ...item });
      creates.push(item.contactId);
      return item;
    },
    async setFlag() {},
    async clearFlag() {},
    async softDelete(contactId) {
      return contacts.find((c) => c.contactId === contactId)!;
    },
    async restore(contactId) {
      return contacts.find((c) => c.contactId === contactId)!;
    },
    async update(contactId) {
      return contacts.find((c) => c.contactId === contactId)!;
    },
    // BE1 multi-phone primitives — unused by the capture service.
    async addPhone(contactId) {
      return contacts.find((c) => c.contactId === contactId)!;
    },
    async setPhone(contactId) {
      return contacts.find((c) => c.contactId === contactId)!;
    },
    async removePhone(contactId) {
      return contacts.find((c) => c.contactId === contactId)!;
    },
    async touchPhoneLastSeen() {},
  };

  const conversationsRepo: ConversationsRepo = {
    async getById(id) {
      return id === conversation.conversationId ? conversation : undefined;
    },
    async findByParticipantPhone() {
      return [];
    },
    async setType() {
      return conversation;
    },
    async applyTriage() {
      return conversation;
    },
    async setParticipantsIfAbsent(conversationId, participants) {
      fakes.claimAttempts += 1;
      if (conversationId !== conversation.conversationId) {
        throw new Error(`setParticipantsIfAbsent: conversation not found: ${conversationId}`);
      }
      if (conversation.participants !== undefined) return false;
      conversation.participants = participants;
      return true;
    },
    // Unused by the capture service:
    createOrGetByParticipantPhone: async () => conversation,
    touchLastActivity: async () => conversation,
    incrementUnread: async () => 1,
    resetUnread: async () => conversation,
    listByLastActivity: async () => ({ items: [] }),
    listRelayGroups: async () => ({ items: [], truncated: false }),
    setMode: async () => {},
    setSmsOptOut: async () => {},
    incrementAutomatedSendCount: async () => 1,
    // Relay groups (M1.7) — unused by the capture service:
    createRelayGroup: async () => conversation,
    getByPoolNumber: async () => undefined,
    getAllByPoolNumber: async () => [],
    setCloseNagNextAt: async () => {},
    addMember: async () => conversation,
    removeMember: async () => conversation,
    setRelayStatus: async () => conversation,
    setRelayMemberOptedOut: async () => {},
    clearRelayMemberOptedOut: async () => {},
    rebindOwner: async () => conversation,
  };

  const auditRepo: AuditRepo = {
    async append(entityKey, eventType, payload) {
      auditEvents.push({ entityKey, eventType, ...(payload !== undefined && { payload }) });
    },
    async listByEntity() {
      return [];
    },
  };

  const capture = createContactCapture({
    contactsRepo,
    conversationsRepo,
    auditRepo,
    logger: createLogger({ destination: createLogCapture().stream }),
  });

  return Object.assign(fakes, { contactsRepo, conversationsRepo, auditRepo, capture });
}

describe('contactCapture — unknown phone', () => {
  it('creates an unknown/needs_review stub (never a guessed type) with capture metadata, links it, and audits once', async () => {
    const f = makeCaptureFakes();
    const contact = await f.capture(f.conversation);

    expect(f.contacts).toHaveLength(1);
    // Operator mandate (2026-06-12): auto-capture never records guessed
    // identity — (type=unknown, status=needs_review) is the triage queue.
    expect(contact).toMatchObject({
      type: 'unknown',
      status: 'needs_review',
      phone: PHONE,
      capture_source: 'inbound_sms',
      // A2P/CTIA (spec §3.2): a first inbound text IS the consent basis —
      // customer-initiated contact stamps inbound_text so replies never JIT-gate.
      consent_method: 'inbound_text',
    });
    expect(typeof contact.captured_at).toBe('string');
    expect(typeof contact.consent_at).toBe('string');
    expect(contact.contactId).toMatch(/^contact-/);
    expect(f.conversation.participants).toEqual([{ contactId: contact.contactId, phone: PHONE }]);
    expect(f.auditEvents).toEqual([
      {
        entityKey: `contacts#${contact.contactId}`,
        eventType: 'contact_auto_captured',
        payload: { conversationId: 'conv-1', source: 'inbound_sms' },
      },
    ]);
  });

  it('a second capture (already linked + contact exists) is a pure read — no writes, no audit', async () => {
    const f = makeCaptureFakes();
    const first = await f.capture(f.conversation);
    const second = await f.capture(f.conversation);

    expect(second.contactId).toBe(first.contactId);
    expect(f.contacts).toHaveLength(1);
    expect(f.creates).toHaveLength(1);
    expect(f.auditEvents).toHaveLength(1);
    expect(f.claimAttempts).toBe(1); // no second claim
  });

  it('steady state with knownContact passed: zero repo calls beyond the inputs', async () => {
    const f = makeCaptureFakes();
    const stub = await f.capture(f.conversation);

    const claimsBefore = f.claimAttempts;
    const result = await f.capture(f.conversation, stub);
    expect(result).toBe(stub); // the known contact is returned as-is
    expect(f.claimAttempts).toBe(claimsBefore);
    expect(f.creates).toHaveLength(1);
  });
});

describe('contactCapture — known contact (backfill only)', () => {
  it('backfills the participants link and NEVER touches the contact record', async () => {
    const existing: ContactItem = {
      contactId: 'contact-known',
      type: 'landlord',
      status: 'active',
      phone: PHONE,
      notes: 'must survive',
    };
    const f = makeCaptureFakes({ contacts: [existing] });

    const result = await f.capture(f.conversation, existing);

    expect(result.contactId).toBe('contact-known');
    expect(f.conversation.participants).toEqual([{ contactId: 'contact-known', phone: PHONE }]);
    expect(f.creates).toHaveLength(0); // no contact write of any kind
    expect(f.contacts[0]).toEqual(existing); // field-for-field untouched
    expect(f.auditEvents).toHaveLength(0); // backfill is not a capture event
  });

  it('resolves the contact itself when the caller passes none', async () => {
    const existing: ContactItem = { contactId: 'contact-known', type: 'tenant', phone: PHONE };
    const f = makeCaptureFakes({ contacts: [existing] });

    const result = await f.capture(f.conversation);
    expect(result.contactId).toBe('contact-known');
    expect(f.conversation.participants?.[0]?.contactId).toBe('contact-known');
  });
});

describe('contactCapture — race handling (the byPhone GSI eventual-consistency window)', () => {
  it('two CONCURRENT first-message captures create exactly one contact + one audit (claim arbitration)', async () => {
    const f = makeCaptureFakes();
    f.simulateGsiLag = true; // both captures miss findByPhone, like a lagging GSI

    const [a, b] = await Promise.all([f.capture(f.conversation), f.capture(f.conversation)]);

    expect(a.contactId).toBe(b.contactId); // the loser adopted the winner's id
    expect(f.contacts).toHaveLength(1);
    expect(f.creates).toHaveLength(1);
    expect(f.auditEvents.filter((e) => e.eventType === 'contact_auto_captured')).toHaveLength(1);
    expect(f.conversation.participants).toHaveLength(1);
  });

  it('claim loser with an EXISTING contact adopts the linked contactId over its own', async () => {
    // The conversation snapshot has no participants (stale read), but the
    // authoritative row was linked to a different contact meanwhile.
    const existing: ContactItem = { contactId: 'contact-mine', type: 'tenant', phone: PHONE };
    const winner: ContactItem = { contactId: 'contact-winner', type: 'tenant', phone: PHONE };
    const f = makeCaptureFakes({ contacts: [existing, winner] });
    f.conversation.participants = [{ contactId: 'contact-winner', phone: PHONE }];
    const staleSnapshot: ConversationItem = { ...f.conversation };
    delete staleSnapshot.participants;

    const result = await f.capture(staleSnapshot, existing);

    expect(result.contactId).toBe('contact-winner');
    expect(f.creates).toHaveLength(0);
    expect(f.conversation.participants).toEqual([{ contactId: 'contact-winner', phone: PHONE }]);
  });

  it('heals the crash window: link exists but the contact row is missing → stub recreated under the LINKED id', async () => {
    const f = makeCaptureFakes({ participants: [{ contactId: 'contact-orphan-link', phone: PHONE }] });

    const result = await f.capture(f.conversation);

    expect(result.contactId).toBe('contact-orphan-link'); // deterministic, not a fresh uuid
    expect(f.contacts).toHaveLength(1);
    expect(f.contacts[0]).toMatchObject({
      contactId: 'contact-orphan-link',
      type: 'unknown',
      status: 'needs_review',
      phone: PHONE,
    });
    expect(f.auditEvents).toEqual([
      expect.objectContaining({
        entityKey: 'contacts#contact-orphan-link',
        eventType: 'contact_auto_captured',
      }),
    ]);
  });

  it('throws (for the webhook to ERROR-log) when the claim fails yet no link is readable', async () => {
    const f = makeCaptureFakes();
    f.conversationsRepo.setParticipantsIfAbsent = async () => false; // claim "lost"…
    f.conversationsRepo.getById = async () => f.conversation; // …but no participants anywhere

    await expect(f.capture(f.conversation)).rejects.toThrow(/no link.*readable/);
  });

  it('NEVER adopts a participants entry for a DIFFERENT phone (mismatch = unlinked, claim path runs)', async () => {
    // The conversation carries a link, but for some OTHER phone — adopting
    // participants[0] here would hand this phone the wrong person's contact.
    const wrongLink = { contactId: 'contact-of-other-phone', phone: '+15550999999' };
    const existing: ContactItem = { contactId: 'contact-right', type: 'tenant', phone: PHONE };
    const f = makeCaptureFakes({ participants: [wrongLink], contacts: [existing] });

    const result = await f.capture(f.conversation, existing);

    // The known (phone-matching) contact wins; the mismatched link is never
    // adopted and never overwritten (the claim is first-writer-wins).
    expect(result.contactId).toBe('contact-right');
    expect(f.claimAttempts).toBe(1); // treated as unlinked → the claim path ran
    expect(f.conversation.participants).toEqual([wrongLink]); // untouched
    expect(f.creates).toHaveLength(0); // no contact writes of any kind
  });
});
