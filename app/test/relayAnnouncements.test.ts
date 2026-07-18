// Relay-group SYSTEM ANNOUNCEMENT gate (services/relayAnnouncements.ts). The
// unusable-gate hardening (spec 4.4): because pool_number NEVER clears now, a
// CLOSED group still carries its number - so the gate must key on STATUS, not
// pool_number presence. A closed group is refused (logged no-op); an open group
// with a pool number + roster still sends. Driven on the in-memory world fakes.
import { describe, expect, it, vi } from 'vitest';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';
import { isMemberSuppressed, sendRelayAnnouncement } from '../src/services/relayAnnouncements.js';

const ALICE = '+15550100001';

function deps(world: ReturnType<typeof createFakeWorld>) {
  return {
    conversationsRepo: world.conversationsRepo,
    messagesRepo: world.messagesRepo,
    contactsRepo: world.contactsRepo,
    adapter: world.adapter,
    events: world.events,
  };
}

describe('sendRelayAnnouncement - closed-gate hardening (spec 4.4)', () => {
  it('skips a CLOSED relay group even though the pool number is still present', async () => {
    const world = createFakeWorld();
    const conv = await world.conversationsRepo.createRelayGroup({
      poolNumber: '+15550100050',
      members: [{ phone: ALICE, contactId: '', name: 'Alice' }],
    });
    // Close it: status flips to 'closed', pool_number is KEPT (burn-multiplexing).
    await world.conversationsRepo.setRelayStatus(conv.conversationId, 'closed', 'open');
    expect((await world.conversationsRepo.getById(conv.conversationId))?.pool_number).toBe(
      '+15550100050',
    );

    const result = await sendRelayAnnouncement(deps(world), {
      conversationId: conv.conversationId,
      body: 'This group chat is now closed.',
      kind: 'group_closed',
    });
    // Refused (logged no-op) - nothing sent, nothing persisted.
    expect(result).toBeUndefined();
    expect(world.sent).toHaveLength(0);
    expect(world.messages.filter((m) => m.conversationId === conv.conversationId)).toHaveLength(0);
  });

  it('still sends on an OPEN relay group with a pool number + roster', async () => {
    const world = createFakeWorld();
    const conv = await world.conversationsRepo.createRelayGroup({
      poolNumber: '+15550100051',
      members: [{ phone: ALICE, contactId: '', name: 'Alice' }],
    });
    const result = await sendRelayAnnouncement(deps(world), {
      conversationId: conv.conversationId,
      body: 'This group chat is now closed.',
      kind: 'group_closed',
    });
    expect(result).toBeDefined();
    expect(result?.sentCount).toBe(1);
    expect(world.sent.map((s) => s.to)).toEqual([ALICE]);
    expect(world.sent.every((s) => s.from === '+15550100051')).toBe(true);
  });
});

describe('isMemberSuppressed - per-phone 1:1 flag (BE1 scope)', () => {
  const member = { contactId: 'c-a', phone: ALICE, name: 'Alice' };

  it('suppresses on the contact flag alone (existing behavior)', async () => {
    const world = createFakeWorld();
    world.contacts.push({ contactId: 'c-a', type: 'tenant', phone: ALICE, sms_opt_out: true });
    // No 1:1 conversation seeded - findByParticipantPhone returns [].
    expect(await isMemberSuppressed(world.contactsRepo, world.conversationsRepo, member)).toBe(true);
  });

  it('suppresses on the 1:1 conversation flag alone', async () => {
    const world = createFakeWorld();
    // Contact carries NO flag; the STOP landed only on the phone's 1:1 thread.
    world.contacts.push({ contactId: 'c-a', type: 'tenant', phone: ALICE });
    const oneToOne = await world.conversationsRepo.createOrGetByParticipantPhone(
      ALICE,
      'tenant_1to1',
    );
    await world.conversationsRepo.setSmsOptOut(oneToOne.conversationId, true);
    expect(await isMemberSuppressed(world.contactsRepo, world.conversationsRepo, member)).toBe(true);
  });

  it('ignores relay_group rows returned by the phone query', async () => {
    const world = createFakeWorld();
    world.contacts.push({ contactId: 'c-a', type: 'tenant', phone: ALICE });
    const now = new Date().toISOString();
    // Defensive: a relay_group row whose participant_phone happens to equal the
    // member phone (prod groups front the POOL number) must NEVER count as a 1:1.
    world.conversations.set('conv-rg', {
      conversationId: 'conv-rg',
      participant_phone: ALICE,
      status: 'open',
      last_activity_at: now,
      type: 'relay_group',
      ai_mode: 'manual',
      created_at: now,
      sms_opt_out: true,
    });
    expect(await isMemberSuppressed(world.contactsRepo, world.conversationsRepo, member)).toBe(
      false,
    );
  });

  it('not suppressed when neither store is flagged', async () => {
    const world = createFakeWorld();
    world.contacts.push({ contactId: 'c-a', type: 'tenant', phone: ALICE });
    expect(await isMemberSuppressed(world.contactsRepo, world.conversationsRepo, member)).toBe(
      false,
    );
  });

  it('never creates a conversation (read-only lookup)', async () => {
    const world = createFakeWorld();
    world.contacts.push({ contactId: 'c-a', type: 'tenant', phone: ALICE });
    const spy = vi.spyOn(world.conversationsRepo, 'createOrGetByParticipantPhone');
    await isMemberSuppressed(world.contactsRepo, world.conversationsRepo, member);
    expect(spy).not.toHaveBeenCalled();
  });
});
