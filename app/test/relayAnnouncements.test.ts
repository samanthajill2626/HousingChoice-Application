// Relay-group SYSTEM ANNOUNCEMENT gate (services/relayAnnouncements.ts). The
// unusable-gate hardening (spec 4.4): because pool_number NEVER clears now, a
// CLOSED group still carries its number - so the gate must key on STATUS, not
// pool_number presence. A closed group is refused (logged no-op); an open group
// with a pool number + roster still sends. Driven on the in-memory world fakes.
import { describe, expect, it } from 'vitest';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';
import { sendRelayAnnouncement } from '../src/services/relayAnnouncements.js';

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
