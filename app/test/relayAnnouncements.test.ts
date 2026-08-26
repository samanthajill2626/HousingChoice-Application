// Relay-group SYSTEM ANNOUNCEMENT gate (services/relayAnnouncements.ts). The
// unusable-gate hardening (spec 4.4): because pool_number NEVER clears now, a
// CLOSED group still carries its number - so the gate must key on STATUS, not
// pool_number presence. A closed group is refused (logged no-op); an open group
// with a pool number + roster still sends. Driven on the in-memory world fakes.
import { describe, expect, it, vi } from 'vitest';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';
import { isMemberSuppressed, sendRelayAnnouncement } from '../src/services/relayAnnouncements.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

const ALICE = '+15550100001';
const BOB = '+15550100002';

function deps(world: ReturnType<typeof createFakeWorld>) {
  return {
    conversationsRepo: world.conversationsRepo,
    messagesRepo: world.messagesRepo,
    contactsRepo: world.contactsRepo,
    adapter: world.adapter,
    events: world.events,
  };
}

describe('sendRelayAnnouncement - system-SID markers on persist:false legs', () => {
  // WHY (log-hygiene spec section 5): legs-only mode (the dev intro replay's
  // only originator) writes NO delivery slot and NO relaysid pointer, so every
  // DLR for those legs reaches the /status webhook's unknown-SID ERROR backstop
  // and feeds the error alarm. A syssid# marker resolves them to the INFO ack.
  async function openGroup(world: ReturnType<typeof createFakeWorld>, poolNumber: string) {
    return world.conversationsRepo.createRelayGroup({
      poolNumber,
      members: [
        { phone: ALICE, contactId: 'c-a', name: 'Alice' },
        { phone: BOB, contactId: 'c-b', name: 'Bob' },
      ],
    });
  }

  it('writes ONE marker per sent leg, keyed by the send providerSid and tagged with kind', async () => {
    const world = createFakeWorld();
    const conv = await openGroup(world, '+15550100060');

    const result = await sendRelayAnnouncement(deps(world), {
      conversationId: conv.conversationId,
      body: 'Welcome to the group.',
      kind: 'relay.intro',
      persist: false,
    });

    expect(result?.sentCount).toBe(2);
    expect(world.systemSidMarkers.size).toBe(2);
    // The marker key is the SID the carrier will quote back on the DLR.
    for (const [sid, markerKind] of world.systemSidMarkers) {
      expect(sid).toMatch(/^SMfake-out-/);
      expect(markerKind).toBe('relay.intro');
    }
  });

  it('writes NO markers in persist mode (the slot + relaysid pointer already resolve those DLRs)', async () => {
    const world = createFakeWorld();
    const conv = await openGroup(world, '+15550100061');

    const result = await sendRelayAnnouncement(deps(world), {
      conversationId: conv.conversationId,
      body: 'Tour tomorrow.',
      kind: 'tour.day_before',
    });

    expect(result?.sentCount).toBe(2);
    expect(world.systemSidMarkers.size).toBe(0);
  });

  it('a marker write that throws WARNs and leaves the announcement successful', async () => {
    const world = createFakeWorld();
    const conv = await openGroup(world, '+15550100062');
    vi.spyOn(world.messagesRepo, 'putSystemSidMarker').mockRejectedValue(new Error('marker-boom'));
    const capture = createLogCapture();

    const result = await sendRelayAnnouncement(
      { ...deps(world), logger: createLogger({ destination: capture.stream }) },
      {
        conversationId: conv.conversationId,
        body: 'Welcome to the group.',
        kind: 'relay.intro',
        persist: false,
      },
    );

    // Both legs really went out; a best-effort marker must not un-send them.
    expect(world.sent).toHaveLength(2);
    expect(result?.sentCount).toBe(2);
    // WARN, not ERROR: the marker try/catch is its OWN, so this must never
    // reach the per-member send catch (which would log a spurious
    // alarm-feeding send-failure ERROR).
    const warns = capture.atLevel(40);
    expect(warns).toHaveLength(2);
    expect(warns[0]?.['msg']).toContain('system-SID marker write failed');
    expect((warns[0]?.['err'] as { message?: string })?.message).toBe('marker-boom');
    expect(warns[0]?.['kind']).toBe('relay.intro');
    // logSafeMemberKey, never the loop-local memberKey: a contact-less member
    // would put a raw phone in the line through relayMemberKey's fallback.
    expect(warns[0]?.['memberKey']).toBe('c-a');
    expect(capture.atLevel(50)).toEqual([]);
    expect(JSON.stringify(capture.lines)).not.toContain(ALICE);
  });
});

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

  it('ignores group_text rows returned by the phone query (invariant 13.6)', async () => {
    // The last surviving "not relay_group" reader. Harmless only while the
    // byParticipantPhone GSI is sparse against group rows; the moment anything
    // gives a group thread a participant_phone (a "primary member"
    // denormalization, a GSI widening), an sms_opt_out written on a MULTI-PARTY
    // thread would read as this member's own suppression and silently mute them
    // from every relay announcement and intro. Its twin numberSuppression.ts
    // carries the identical clause.
    const world = createFakeWorld();
    world.contacts.push({ contactId: 'c-a', type: 'tenant', phone: ALICE });
    const now = new Date().toISOString();
    world.conversations.set('conv-gt', {
      conversationId: 'conv-gt',
      participant_phone: ALICE,
      status: 'group_open',
      last_activity_at: now,
      type: 'group_text',
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
