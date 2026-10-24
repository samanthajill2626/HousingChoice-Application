// The harness FAKE's today-checklist seams, pinned (plan rulings PR6, PR7).
//
// WHY THIS FILE EXISTS. Writer tests in S2-S4 read these records instead of
// spying: world.reachedOutTouches says which contacts a send stamped, and
// world.recipientDisplayCalls says which read Today asked for. A record that
// silently stopped filling would turn every "no stamp" assertion vacuous.
// The real repos are covered against DynamoDB Local
// (contactsRepo.integration.test.ts, caseworkerRepoParity.integration.test.ts).
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

type World = ReturnType<typeof createFakeWorld>;

function seedTenant(world: World, contactId: string, over: Partial<ContactItem> = {}): void {
  world.contacts.push({ contactId, type: 'tenant', status: 'searching', ...over });
}

describe('harness contactsRepo.touchLastReachedOut (PR7)', () => {
  it('records every call with the RAW at and its outcome, and moves only forward', async () => {
    const world = createFakeWorld();
    seedTenant(world, 'c-1', { last_heard_from_at: '2026-10-19T10:00:00.000Z' });

    expect(await world.contactsRepo.touchLastReachedOut('c-1', '2026-10-20T06:00:00-04:00')).toBe('written');
    expect(await world.contactsRepo.touchLastReachedOut('c-1', '2026-10-20T09:00:00.000Z')).toBe('skipped');
    expect(await world.contactsRepo.touchLastReachedOut('c-1', 'garbage')).toBe('skipped');
    expect(await world.contactsRepo.touchLastReachedOut('c-missing', '2026-10-20T11:00:00.000Z')).toBe('skipped');
    expect(await world.contactsRepo.touchLastReachedOut('c-1', '2026-10-21T10:00:00.000Z')).toBe('written');

    expect(world.reachedOutTouches).toEqual([
      { contactId: 'c-1', at: '2026-10-20T06:00:00-04:00', outcome: 'written' },
      { contactId: 'c-1', at: '2026-10-20T09:00:00.000Z', outcome: 'skipped' },
      { contactId: 'c-1', at: 'garbage', outcome: 'skipped' },
      { contactId: 'c-missing', at: '2026-10-20T11:00:00.000Z', outcome: 'skipped' },
      { contactId: 'c-1', at: '2026-10-21T10:00:00.000Z', outcome: 'written' },
    ]);
    const stored = world.contacts.find((c) => c.contactId === 'c-1');
    expect(stored?.last_reached_out_at).toBe('2026-10-21T10:00:00.000Z');
    // The inbound clock is a different field and a different record.
    expect(stored?.last_heard_from_at).toBe('2026-10-19T10:00:00.000Z');
    expect(world.heardFromTouches).toEqual([]);
    // Never creates a contact.
    expect(world.contacts.some((c) => c.contactId === 'c-missing')).toBe(false);
  });

  it('starts empty on a fresh world', () => {
    expect(createFakeWorld().reachedOutTouches).toEqual([]);
  });
});

describe('harness contactsRepo.getRecipientDisplaysByIds records its options (PR7)', () => {
  it('records the ids and the options exactly as passed; the answer ignores them', async () => {
    const world = createFakeWorld();
    seedTenant(world, 'c-1', { last_reached_out_at: '2026-10-20T10:00:00.000Z' });

    const plain = await world.contactsRepo.getRecipientDisplaysByIds(['c-1']);
    const consistent = await world.contactsRepo.getRecipientDisplaysByIds(['c-1', 'c-2'], {
      requireComplete: true,
      consistentRead: true,
    });

    expect(world.recipientDisplayCalls).toEqual([
      { contactIds: ['c-1'] },
      { contactIds: ['c-1', 'c-2'], opts: { requireComplete: true, consistentRead: true } },
    ]);
    // In memory every read is complete and consistent: same answer either way.
    expect(consistent.get('c-1')).toEqual(plain.get('c-1'));
    expect(consistent.get('c-1')?.last_reached_out_at).toBe('2026-10-20T10:00:00.000Z');
    expect(consistent.has('c-2')).toBe(false);
  });
});

describe('harness conversationsRepo.getByIdConsistent (PR6)', () => {
  it('answers what getById answers (in memory every read is consistent)', async () => {
    const world = createFakeWorld();
    const conv = await world.conversationsRepo.createOrGetByParticipantPhone('+15550109901', 'tenant_1to1');
    expect(await world.conversationsRepo.getByIdConsistent(conv.conversationId)).toBe(
      await world.conversationsRepo.getById(conv.conversationId),
    );
    expect(await world.conversationsRepo.getByIdConsistent('conv-missing')).toBeUndefined();
  });
});

describe('harness event recorder records contact.updated (PR7)', () => {
  it('a contact.updated emit lands in world.emitted, in order with the others', () => {
    const world = createFakeWorld();
    world.events.emit('contact.updated', { contactId: 'c-1' });
    world.events.emit('contact.updated', { contactId: 'c-2' });
    expect(world.emitted).toEqual([
      { event: 'contact.updated', payload: { contactId: 'c-1' } },
      { event: 'contact.updated', payload: { contactId: 'c-2' } },
    ]);
  });
});
