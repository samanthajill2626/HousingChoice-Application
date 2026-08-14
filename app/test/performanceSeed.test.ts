import { describe, expect, it, vi } from 'vitest';
import { LISTING_STATUSES, PLACEMENT_STAGES, TENANT_STATUSES, LANDLORD_STATUSES } from '../src/lib/statusModel.js';
import { TOUR_STATUSES } from '../src/lib/toursModel.js';
import { conversationIdForGroup } from '../src/lib/import/ids.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import {
  PERFORMANCE_SEED_BOUNDS,
  generatePerformanceSeed,
  nativeGroupCapacity,
  resolvePerformanceSeedConfig,
  resolvePerformanceSelfQaFixtures,
  toPerformanceSeedManifest,
  validatePerformanceConversation,
  type PerformanceSeedInput,
  type PerformanceSeedManifest,
} from '../src/lib/seed/performance.js';

const ANCHOR = '2026-08-11T16:00:00.000Z';

type OptionalKeyOf<T> = {
  [Key in keyof T]-?: {} extends Pick<T, Key> ? Key : never;
}[keyof T];
type AssertNoOptionalKeys<Keys extends never> = Keys;
type PerformanceSeedManifestHasNoOptionalKeys = AssertNoOptionalKeys<OptionalKeyOf<PerformanceSeedManifest>>;
const performanceSeedManifestHasNoOptionalKeys: PerformanceSeedManifestHasNoOptionalKeys = undefined as never;

const zeroWorld = (overrides: PerformanceSeedInput = {}): PerformanceSeedInput => ({
  scale: 1,
  contacts: 0,
  units: 0,
  placements: 0,
  tours: 0,
  conversations: 0,
  nativeGroups: 0,
  messagesPerConversation: 0,
  broadcasts: 0,
  recipientsPerBroadcast: 0,
  ...overrides,
});

describe('resolvePerformanceSeedConfig', () => {
  it('resolves the scale-1 base world and its physical and embedded totals', () => {
    const config = resolvePerformanceSeedConfig({}, ANCHOR);

    expect(config).toMatchObject({
      anchor: ANCHOR,
      scale: 1,
      contacts: 100,
      units: 16,
      placements: 50,
      tours: 50,
      conversations: 100,
      nativeGroups: 21,
      totalConversations: 121,
      messagesPerConversation: 10,
      requestedLongConversationMessages: 10,
      resolvedLongConversationMessages: 10,
      longConversationFixturePresent: true,
      ordinaryMessageCount: 1_200,
      tailMessageCount: 10,
      totalMessageCount: 1_210,
      broadcasts: 10,
      recipientsPerBroadcast: 25,
      requestedLargeBroadcastRecipients: 25,
      resolvedLargeBroadcastRecipients: 25,
      largeBroadcastFixturePresent: true,
      messageCount: 1_210,
      requestedRecipientCount: 250,
      resolvedRecipientCount: 250,
      totalRecipientCount: 250,
      tenantCount: 95,
      landlordCount: 4,
      unknownCount: 1,
      activeTenantCount: 81,
      activeLandlordCount: 3,
      activeUnknownCount: 1,
      activeContactCount: 85,
      deletedContactCount: 15,
      nativeGroupMemberSlotCount: 63,
      requestedRelayGroupCount: 20,
      relayGroupCount: 20,
      clippedRelayGroupCount: 0,
      fixedUnmatchedEmailCount: 4,
      physicalItemCount: 1_561,
      totalItemCount: 1_874,
    });
  });

  it('multiplies entity counts at scale 100 without multiplying densities', () => {
    const config = resolvePerformanceSeedConfig({ scale: 100 }, ANCHOR);

    expect(config).toMatchObject({
      contacts: 10_000,
      units: 1_600,
      placements: 5_000,
      tours: 5_000,
      conversations: 10_000,
      nativeGroups: 2_100,
      totalConversations: 12_100,
      messagesPerConversation: 10,
      broadcasts: 1_000,
      recipientsPerBroadcast: 25,
      messageCount: 121_000,
      totalMessageCount: 121_000,
      requestedRecipientCount: 25_000,
      resolvedRecipientCount: 25_000,
      requestedRelayGroupCount: 2_000,
      relayGroupCount: 1_000,
      clippedRelayGroupCount: 1_000,
      physicalItemCount: 155_704,
      nativeGroupMemberSlotCount: 6_300,
      totalItemCount: 187_004,
    });
  });

  it('lets each override replace its independently scaled value', () => {
    const config = resolvePerformanceSeedConfig(
      {
        scale: 3,
        contacts: 7,
        units: 8,
        placements: 9,
        tours: 10,
        conversations: 11,
        nativeGroups: 12,
        messagesPerConversation: 12,
        longConversationMessages: 13,
        broadcasts: 13,
        recipientsPerBroadcast: 6,
        largeBroadcastRecipients: 7,
      },
      ANCHOR,
    );

    expect(config).toMatchObject({
      scale: 3,
      contacts: 7,
      units: 8,
      placements: 9,
      tours: 10,
      conversations: 11,
      nativeGroups: 12,
      messagesPerConversation: 12,
      requestedLongConversationMessages: 13,
      broadcasts: 13,
      recipientsPerBroadcast: 6,
      requestedLargeBroadcastRecipients: 7,
      messageCount: 277,
      requestedRecipientCount: 78,
      resolvedRecipientCount: 78,
    });
  });

  it.each([
    ['contacts', 0, 20_000],
    ['units', 0, 20_000],
    ['placements', 0, 20_000],
    ['tours', 0, 20_000],
    ['conversations', 0, 20_000],
    ['nativeGroups', 0, 20_000],
    ['broadcasts', 0, 20_000],
    ['messagesPerConversation', 0, 100],
    ['longConversationMessages', 0, 20_000],
    ['recipientsPerBroadcast', 0, 1_000],
    ['largeBroadcastRecipients', 0, 1_000],
  ] as const)('accepts the exact lower and upper %s bounds', (key, lower, upper) => {
    const base = key === 'nativeGroups' ? zeroWorld({ contacts: 20_000 }) : zeroWorld();
    const lowerConfig = resolvePerformanceSeedConfig({ ...base, [key]: lower }, ANCHOR);
    const upperConfig = resolvePerformanceSeedConfig({ ...base, [key]: upper }, ANCHOR);

    const resolvedKey = key === 'longConversationMessages'
      ? 'requestedLongConversationMessages'
      : key === 'largeBroadcastRecipients'
        ? 'requestedLargeBroadcastRecipients'
        : key;
    expect(lowerConfig[resolvedKey]).toBe(lower);
    expect(upperConfig[resolvedKey]).toBe(upper);
  });

  it.each([
    ['scale', 0],
    ['scale', 101],
    ['scale', 1.5],
    ['contacts', -1],
    ['contacts', 20_001],
    ['contacts', 1.5],
    ['units', -1],
    ['units', 20_001],
    ['units', 1.5],
    ['placements', -1],
    ['placements', 20_001],
    ['placements', 1.5],
    ['tours', -1],
    ['tours', 20_001],
    ['tours', 1.5],
    ['conversations', -1],
    ['conversations', 20_001],
    ['conversations', 1.5],
    ['nativeGroups', -1],
    ['nativeGroups', 20_001],
    ['nativeGroups', 1.5],
    ['messagesPerConversation', -1],
    ['messagesPerConversation', 101],
    ['messagesPerConversation', 1.5],
    ['longConversationMessages', -1],
    ['longConversationMessages', 20_001],
    ['longConversationMessages', 1.5],
    ['broadcasts', -1],
    ['broadcasts', 20_001],
    ['broadcasts', 1.5],
    ['recipientsPerBroadcast', -1],
    ['recipientsPerBroadcast', 1_001],
    ['recipientsPerBroadcast', 1.5],
    ['largeBroadcastRecipients', -1],
    ['largeBroadcastRecipients', 1_001],
    ['largeBroadcastRecipients', 1.5],
  ] as const)('rejects an invalid or non-integer %s value', (key, value) => {
    const input = key === 'scale' ? { scale: value } : zeroWorld({ [key]: value });

    expect(() => resolvePerformanceSeedConfig(input, ANCHOR)).toThrow(key);
  });

  it('publishes the exact safety bounds as data rather than parser magic', () => {
    expect(PERFORMANCE_SEED_BOUNDS).toEqual({
      scale: { min: 1, max: 100 },
      entityCount: { min: 0, max: 20_000 },
      messagesPerConversation: { min: 0, max: 100 },
      longConversationMessages: { min: 0, max: 20_000 },
      recipientsPerBroadcast: { min: 0, max: 1_000 },
      largeBroadcastRecipients: { min: 0, max: 1_000 },
      nativeGroups: { min: 0, max: 20_000 },
      relayGroups: { max: 1_000 },
      totalItems: { max: 250_000 },
    });
  });

  it('deduplicates fallback recipients before total-cap arithmetic when contacts are zero', () => {
    const config = resolvePerformanceSeedConfig(
      zeroWorld({ broadcasts: 2, recipientsPerBroadcast: 25 }),
      ANCHOR,
    );

    expect(config).toMatchObject({
      requestedRecipientCount: 50,
      resolvedRecipientsPerBroadcast: 1,
      resolvedRecipientCount: 2,
      physicalItemCount: 6,
      totalItemCount: 8,
      fallbacks: {
        tenant: 'lean_tenant',
        landlord: 'lean_landlord',
        unit: 'lean_unit',
      },
    });
  });

  it('clips generated relay groups to 1000 and preserves the conversation total', () => {
    const config = resolvePerformanceSeedConfig(
      zeroWorld({ conversations: 20_000 }),
      ANCHOR,
    );

    expect(config).toMatchObject({
      conversations: 20_000,
      requestedRelayGroupCount: 4_000,
      relayGroupCount: 1_000,
      clippedRelayGroupCount: 3_000,
      physicalItemCount: 20_004,
    });
  });

  it('rejects a resolved physical-plus-recipient total above 250000 before generation', () => {
    expect(() =>
      resolvePerformanceSeedConfig(
        zeroWorld({ contacts: 20_000, broadcasts: 20_000, recipientsPerBroadcast: 1_000 }),
        ANCHOR,
      ),
    ).toThrow('totalItemCount');
  });

  it.each([
    [0, 0, 0, 0],
    [1, 0, 0, 1],
    [2, 0, 0, 2],
    [24, 0, 0, 24],
    [25, 1, 0, 24],
    [99, 3, 0, 96],
    [100, 4, 1, 95],
    [101, 4, 1, 96],
  ] as const)('uses the 95/4/1 allocation for %i generated contacts', (contacts, landlords, unknown, tenants) => {
    const config = resolvePerformanceSeedConfig(zeroWorld({ contacts }), ANCHOR);
    const { tables } = generatePerformanceSeed(config);

    expect(config.landlordCount).toBe(landlords);
    expect(config.unknownCount).toBe(unknown);
    expect(config.tenantCount).toBe(tenants);
    expect(tables.contacts.filter((row) => row.type === 'landlord')).toHaveLength(landlords);
    expect(tables.contacts.filter((row) => row.type === 'unknown')).toHaveLength(unknown);
    expect(tables.contacts.filter((row) => row.type === 'tenant')).toHaveLength(tenants);
    expect(config.activeContactCount + config.deletedContactCount).toBe(contacts);
    expect(tables.contacts.filter((row) => row.deleted_at === undefined)).toHaveLength(config.activeContactCount);
  });

  it.each([
    [0, 0],
    [1, 0],
    [2, 1],
    [3, 4],
    [4, 11],
    [100, 20_000],
    [20_000, 20_000],
  ] as const)('saturates native roster capacity for %i active contacts at %i', (activeContacts, capacity) => {
    expect(nativeGroupCapacity(activeContacts)).toBe(capacity);
  });

  it('resolves native schedules, tails, clips, and logical work before generation', () => {
    const native = resolvePerformanceSeedConfig(zeroWorld({ contacts: 5, nativeGroups: 4 }), ANCHOR);
    const tail = resolvePerformanceSeedConfig(
      zeroWorld({ contacts: 100, conversations: 2, messagesPerConversation: 3, longConversationMessages: 7, broadcasts: 2, recipientsPerBroadcast: 3, largeBroadcastRecipients: 8 }),
      ANCHOR,
    );
    const clipped = resolvePerformanceSeedConfig(
      zeroWorld({ contacts: 5, broadcasts: 2, recipientsPerBroadcast: 1_000, largeBroadcastRecipients: 1_000 }),
      ANCHOR,
    );

    expect(native).toMatchObject({ nativeGroupCapacity: 11, nativeGroupRosterSizes: [2, 3, 4, 2], nativeGroupMemberSlotCount: 11 });
    expect(tail).toMatchObject({
      longConversationFixturePresent: true,
      ordinaryMessageCount: 3,
      tailMessageCount: 7,
      totalMessageCount: 10,
      physicalItemCount: 118,
      totalRecipientCount: 11,
      totalItemCount: 129,
    });
    expect(clipped).toMatchObject({
      recipientPoolSize: 4,
      recipientsPerBroadcast: 1_000,
      resolvedRecipientsPerBroadcast: 4,
      requestedOrdinaryRecipientCount: 1_000,
      resolvedOrdinaryRecipientCount: 4,
      clippedOrdinaryRecipientCount: 996,
      resolvedLargeBroadcastRecipients: 4,
      totalRecipientCount: 8,
      clippedLargeBroadcastRecipients: 996,
    });
  });

  it('makes tails absent when their parent population is zero and rejects impossible native groups', () => {
    const config = resolvePerformanceSeedConfig(
      zeroWorld({ contacts: 5, nativeGroups: 2, messagesPerConversation: 5, longConversationMessages: 5 }),
      ANCHOR,
    );

    expect(config).toMatchObject({
      totalConversations: 2,
      longConversationFixturePresent: false,
      resolvedLongConversationMessages: 0,
      ordinaryMessageCount: 10,
      tailMessageCount: 0,
      totalMessageCount: 10,
      largeBroadcastFixturePresent: false,
      resolvedLargeBroadcastRecipients: 0,
      clippedLargeBroadcastRecipients: 0,
      physicalItemCount: 21,
      nativeGroupMemberSlotCount: 5,
      totalItemCount: 26,
    });
    expect(() => resolvePerformanceSeedConfig(zeroWorld({ contacts: 5, nativeGroups: 12 }), ANCHOR)).toThrow('nativeGroups');
    expect(() => resolvePerformanceSeedConfig(zeroWorld({ messagesPerConversation: 2, longConversationMessages: 1 }), ANCHOR)).toThrow('longConversationMessages');
    expect(() => resolvePerformanceSeedConfig(zeroWorld({ recipientsPerBroadcast: 2, largeBroadcastRecipients: 1 }), ANCHOR)).toThrow('largeBroadcastRecipients');
  });

  it('captures one anchor when none is supplied and normalizes an explicit ISO anchor', () => {
    const now = vi.fn(() => new Date('2026-08-11T12:34:56.789Z'));

    const captured = resolvePerformanceSeedConfig({}, undefined, now);
    const explicit = resolvePerformanceSeedConfig({}, '2026-08-11T08:34:56.789-04:00', now);

    expect(captured.anchor).toBe('2026-08-11T12:34:56.789Z');
    expect(explicit.anchor).toBe('2026-08-11T12:34:56.789Z');
    expect(now).toHaveBeenCalledTimes(1);
    expect(() => resolvePerformanceSeedConfig({}, 'not-an-anchor')).toThrow('anchor');
  });

  it('builds a detached manifest with every workload field required by its public type', () => {
    const config = resolvePerformanceSeedConfig({}, ANCHOR);
    const manifest = toPerformanceSeedManifest(config);
    const manifestContract: PerformanceSeedManifest = manifest;

    expect(manifest).toEqual(config);
    expect(manifest).not.toBe(config);
    expect(manifestContract).toEqual(manifest);
    expect(manifest.workloadModelVersion).toBe(2);
    expect(performanceSeedManifestHasNoOptionalKeys).toBeUndefined();
    expect(Object.keys(manifest).sort()).toEqual(Object.keys(config).sort());
  });
});

describe('generatePerformanceSeed', () => {
  it('builds the exact scale-1 physical table world and fixed appendix', () => {
    const config = resolvePerformanceSeedConfig({}, ANCHOR);
    const generated = generatePerformanceSeed(config);

    expect(Object.keys(generated.tables)).toEqual([
      'contacts',
      'units',
      'placements',
      'tours',
      'conversations',
      'messages',
      'broadcasts',
      'unmatched_email',
    ]);
    expect(Object.fromEntries(Object.entries(generated.tables).map(([table, rows]) => [table, rows.length]))).toEqual({
      contacts: 100,
      units: 16,
      placements: 50,
      tours: 50,
      conversations: 121,
      messages: 1_210,
      broadcasts: 10,
      unmatched_email: 4,
    });
    expect(generated.manifest).toEqual(toPerformanceSeedManifest(config));
    expect(generated.tables.unmatched_email.map((row) => row.status)).toEqual([
      'unmatched',
      'unmatched',
      'quarantined',
      'quarantined',
    ]);
    expect(generated.tables.unmatched_email.map((row) => row.unmatchedId)).toEqual([
      'um-00000000000000000000000000000001',
      'um-00000000000000000000000000000002',
      'um-00000000000000000000000000000003',
      'um-00000000000000000000000000000004',
    ]);
  });

  it('covers fixed contact, unit, placement, and tour ratios with every indexed field', () => {
    const { tables } = generatePerformanceSeed(resolvePerformanceSeedConfig({}, ANCHOR));

    expect(tables.contacts.filter((row) => row.type === 'tenant')).toHaveLength(95);
    expect(tables.contacts.filter((row) => row.type === 'landlord')).toHaveLength(4);
    expect(tables.contacts.filter((row) => row.type === 'unknown')).toHaveLength(1);
    expect(new Set(tables.contacts.filter((row) => row.type === 'tenant').map((row) => row.status))).toEqual(
      new Set(TENANT_STATUSES),
    );
    expect(tables.contacts.filter((row) => row.type === 'landlord').every(
      (row) => row.status !== undefined && new Set<string>(LANDLORD_STATUSES).has(row.status),
    )).toBe(true);
    expect(tables.contacts.filter((row) => row.deleted_at !== undefined)).toHaveLength(15);
    expect(new Set(tables.contacts.map((row) => row.phone))).toHaveLength(100);
    expect(new Set(tables.contacts.map((row) => row.email))).toHaveLength(100);
    for (const row of tables.contacts) {
      expect(row).toMatchObject({
        contactId: expect.stringMatching(/^perf-contact-[0-9]{5}$/),
        phone: expect.stringMatching(/^\+1555[0-9]{7}$/),
        email: expect.stringMatching(/^perf-contact-[0-9]{5}@example\.test$/),
        type: expect.any(String),
        status: expect.any(String),
      });
    }

    expect(new Set(tables.units.map((row) => row.status))).toEqual(new Set(LISTING_STATUSES));
    expect(tables.units.filter((row) => row.deleted_at !== undefined)).toHaveLength(3);
    for (const row of tables.units) {
      expect(row).toMatchObject({
        unitId: expect.stringMatching(/^perf-unit-[0-9]{5}$/),
        landlordId: expect.any(String),
        status: expect.any(String),
        address: {
          line1: expect.any(String),
          city: 'Atlanta',
          state: 'GA',
          zip: expect.stringMatching(/^[0-9]{5}$/),
        },
      });
    }

    expect(new Set(tables.placements.map((row) => row.stage))).toEqual(new Set(PLACEMENT_STAGES));
    expect(tables.placements.some((row) => row.attention !== undefined)).toBe(true);
    expect(
      tables.placements
        .filter((row) => row.attention !== undefined)
        .every((row) => row.stage !== 'moved_in' && row.stage !== 'lost'),
    ).toBe(true);
    expect(tables.placements.some((row) => Date.parse(row.stage_entered_at ?? '') < Date.parse(ANCHOR) - 30 * 86_400_000)).toBe(true);
    for (const row of tables.placements) {
      expect(row).toMatchObject({
        placementId: expect.stringMatching(/^perf-placement-[0-9]{5}$/),
        tenantId: expect.any(String),
        unitId: expect.any(String),
        stage: expect.any(String),
        stage_entered_at: expect.any(String),
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });
    }

    expect(new Set(tables.tours.map((row) => row.status))).toEqual(new Set(TOUR_STATUSES));
    for (const row of tables.tours) {
      expect(row).toMatchObject({
        tourId: expect.stringMatching(/^perf-tour-[0-9]{5}$/),
        tenantId: expect.any(String),
        unitId: expect.any(String),
        status: expect.any(String),
        _schedPartition: 'tours',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      if (row.status !== 'requested') expect(row.scheduledAt).toEqual(expect.any(String));
    }
  });

  it.each(['2026-01-03T02:15:00.000Z', '2046-11-19T19:45:00.000Z'])(
    'derives all time windows from anchor %s',
    (anchor) => {
      const { tables } = generatePerformanceSeed(resolvePerformanceSeedConfig({}, anchor));
      const anchorMs = Date.parse(anchor);
      const scheduled = tables.tours.filter((row) => row.status === 'scheduled');

      expect(scheduled.some((row) => row.scheduledAt?.slice(0, 10) === anchor.slice(0, 10))).toBe(true);
      expect(scheduled.every((row) => {
        const at = Date.parse(row.scheduledAt ?? '');
        return at >= anchorMs - 24 * 60 * 60 * 1_000 && at <= anchorMs + 30 * 24 * 60 * 60 * 1_000;
      })).toBe(true);
      expect(tables.placements.some((row) => row.attention?.at === anchor)).toBe(true);
      expect(tables.conversations.every((row) => Date.parse(row.last_activity_at) <= anchorMs)).toBe(true);
      expect(tables.messages.every((row) => Date.parse(row.created_at) <= anchorMs)).toBe(true);
      expect(tables.broadcasts.every((row) => Date.parse(row.created_at) <= anchorMs)).toBe(true);
    },
  );

  it('keeps every generated relationship resolvable and every ID unique', () => {
    const { tables } = generatePerformanceSeed(resolvePerformanceSeedConfig({}, ANCHOR));
    const contactIds = new Set(tables.contacts.map((row) => row.contactId));
    const tenantIds = new Set(tables.contacts.filter((row) => row.type === 'tenant').map((row) => row.contactId));
    const landlordIds = new Set(tables.contacts.filter((row) => row.type === 'landlord').map((row) => row.contactId));
    const unitIds = new Set(tables.units.map((row) => row.unitId));
    const conversationIds = new Set(tables.conversations.map((row) => row.conversationId));

    expect(contactIds).toHaveLength(tables.contacts.length);
    expect(unitIds).toHaveLength(tables.units.length);
    expect(conversationIds).toHaveLength(tables.conversations.length);
    expect(new Set(tables.placements.map((row) => row.placementId))).toHaveLength(tables.placements.length);
    expect(new Set(tables.tours.map((row) => row.tourId))).toHaveLength(tables.tours.length);
    expect(new Set(tables.broadcasts.map((row) => row.broadcastId))).toHaveLength(tables.broadcasts.length);

    expect(tables.units.every((row) => landlordIds.has(row.landlordId))).toBe(true);
    expect(tables.placements.every((row) => tenantIds.has(row.tenantId) && unitIds.has(row.unitId))).toBe(true);
    expect(tables.tours.every((row) => tenantIds.has(row.tenantId) && unitIds.has(row.unitId))).toBe(true);
    expect(tables.conversations.every((row) => row.participants?.every((participant) => contactIds.has(participant.contactId)))).toBe(true);
    expect(tables.messages.every((row) => conversationIds.has(row.conversationId))).toBe(true);
    expect(tables.broadcasts.every((row) => row.unitId === undefined || unitIds.has(row.unitId))).toBe(true);
    expect(tables.broadcasts.every((row) => Object.keys(row.recipients).every((contactId) => contactIds.has(contactId)))).toBe(true);
  });

  it('generates sortable complete messages and runtime-valid conversation shapes', () => {
    const config = resolvePerformanceSeedConfig({}, ANCHOR);
    const { tables } = generatePerformanceSeed(config);
    const byConversation = new Map<string, typeof tables.messages>();
    for (const message of tables.messages) {
      const rows = byConversation.get(message.conversationId) ?? [];
      rows.push(message);
      byConversation.set(message.conversationId, rows);
      expect(message).toMatchObject({
        tsMsgId: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*#perf-msg-[0-9]{5}-[0-9]{3}$/),
        type: 'sms',
        direction: expect.stringMatching(/^(inbound|outbound)$/),
        author: expect.any(String),
        provider_sid: expect.any(String),
        provider_ts: expect.any(String),
        delivery_status: expect.any(String),
        created_at: expect.any(String),
      });
    }
    expect(tables.messages).toHaveLength(config.totalMessageCount);
    for (const conversation of tables.conversations) {
      expect(() => validatePerformanceConversation(conversation)).not.toThrow();
      const messages = byConversation.get(conversation.conversationId) ?? [];
      expect(messages).toHaveLength(
        conversation.type === 'relay_group' && conversation.status === 'open' && conversation.conversationId === 'perf-conversation-00000'
          ? config.resolvedLongConversationMessages
          : config.messagesPerConversation,
      );
      expect(messages.map((row) => row.tsMsgId)).toEqual([...messages.map((row) => row.tsMsgId)].sort());
      expect(conversation).toMatchObject({
        last_activity_at: expect.any(String),
        last_message_preview: expect.any(String),
        unread_count: expect.any(Number),
        created_at: expect.any(String),
      });
    }
  });

  it('generates unique canonical native groups with typed rosters and native sender attribution', () => {
    const config = resolvePerformanceSeedConfig(zeroWorld({ contacts: 100, nativeGroups: 21, conversations: 1, messagesPerConversation: 2 }), ANCHOR);
    const { tables } = generatePerformanceSeed(config);
    const groups = tables.conversations.filter((row) => row.type === 'group_text');
    const messagesByConversation = new Map<string, typeof tables.messages>();
    for (const message of tables.messages) {
      const rows = messagesByConversation.get(message.conversationId) ?? [];
      rows.push(message);
      messagesByConversation.set(message.conversationId, rows);
    }

    expect(groups).toHaveLength(config.nativeGroups);
    expect(groups.map((group) => group.participants?.length)).toEqual(config.nativeGroupRosterSizes);
    expect(new Set(groups.map((group) => group.conversationId))).toHaveLength(groups.length);
    expect(groups.some((group) => group.unread_count === 0)).toBe(true);
    expect(groups.some((group) => (group.unread_count ?? 0) > 0)).toBe(true);
    for (const group of groups) {
      const roster = group.participants ?? [];
      expect(group).toMatchObject({ status: 'group_open', ai_mode: 'manual' });
      expect(group.pool_number).toBeUndefined();
      expect(group.relay_status).toBeUndefined();
      expect(group.participant_phone).toBeUndefined();
      expect(group.participants_version).toBeUndefined();
      expect(group.owner).toBeUndefined();
      expect(group.ever_member_phones).toBeUndefined();
      expect(group.conversationId).toBe(conversationIdForGroup(roster.map((participant) => participant.phone)));
      expect(roster.every((participant) => participant.contactId.startsWith('perf-contact-'))).toBe(true);
      for (const message of messagesByConversation.get(group.conversationId) ?? []) {
        if (message.direction === 'inbound') {
          expect(message.relay_sender_key).toMatch(/^phone#\+1555[0-9]{7}$/);
          expect(['tenant', 'landlord', 'unknown']).toContain(message.author);
        } else {
          expect(message.author).toBe('teammate');
          expect(message.relay_sender_key).toBe('team');
        }
      }
    }
    expect(config.nativeGroupMemberSlotCount).toBe(groups.reduce((total, group) => total + (group.participants?.length ?? 0), 0));
  });

  it.each([0, 1, 2, 3, 4, 5])('accepts every feasible native count for an active pool of %i', (activeContacts) => {
    const contacts = activeContacts === 0 ? 0 : activeContacts + 1;
    const base = zeroWorld({ contacts, messagesPerConversation: 0 });
    const capacity = nativeGroupCapacity(activeContacts);

    for (let requested = 0; requested <= capacity; requested += 1) {
      expect(resolvePerformanceSeedConfig({ ...base, nativeGroups: requested }, ANCHOR).nativeGroups).toBe(requested);
    }
    expect(() => resolvePerformanceSeedConfig({ ...base, nativeGroups: capacity + 1 }, ANCHOR)).toThrow('nativeGroups');
  });

  it('keeps the remaining native iterators in rotation after the larger sizes exhaust', () => {
    const config = resolvePerformanceSeedConfig(zeroWorld({ contacts: 5, nativeGroups: 11, messagesPerConversation: 0 }), ANCHOR);
    const groups = generatePerformanceSeed(config).tables.conversations.filter((row) => row.type === 'group_text');

    expect(config.nativeGroupRosterSizes).toEqual([2, 3, 4, 2, 3, 2, 3, 2, 3, 2, 2]);
    expect(groups.map((group) => group.participants?.length)).toEqual(config.nativeGroupRosterSizes);
    expect(new Set(groups.map((group) => group.conversationId))).toHaveLength(11);
  });

  it('materializes only the requested native groups at the 20000 cap-valid zero-density boundary', () => {
    const config = resolvePerformanceSeedConfig(
      zeroWorld({ contacts: 20_000, nativeGroups: 20_000, messagesPerConversation: 0, longConversationMessages: 0 }),
      ANCHOR,
    );
    const groups = generatePerformanceSeed(config).tables.conversations.filter((row) => row.type === 'group_text');

    expect(config.nativeGroups).toBe(20_000);
    expect(groups).toHaveLength(20_000);
    expect(new Set(groups.map((group) => group.conversationId))).toHaveLength(20_000);
    expect(() => resolvePerformanceSeedConfig({ contacts: 20_000, nativeGroups: 20_000 }, ANCHOR)).toThrow('totalItemCount');
  });

  it.each([
    ['scale 1', resolvePerformanceSeedConfig({}, ANCHOR)],
    ['scale 7', resolvePerformanceSeedConfig({ scale: 7 }, ANCHOR)],
    ['cap-valid zero-density', resolvePerformanceSeedConfig(
      zeroWorld({ contacts: 20_000, nativeGroups: 20_000, messagesPerConversation: 0, longConversationMessages: 0 }),
      ANCHOR,
    )],
  ] as const)('visits and materializes no extra native roster combinations at %s', (_name, config) => {
    let visited = 0;
    let materialized = 0;
    const materializedRosterSizes: number[] = [];

    generatePerformanceSeed(config, {
      onNativeRosterVisited: () => { visited += 1; },
      onNativeRosterMaterialized: (roster?: readonly unknown[]) => {
        materialized += 1;
        materializedRosterSizes.push(roster?.length ?? -1);
      },
    });

    expect(visited).toBe(config.nativeGroups);
    expect(materialized).toBe(config.nativeGroups);
    expect(materializedRosterSizes).toEqual(config.nativeGroupRosterSizes);
  });

  it('reconciles every generated table and embedded recipient map to manifest totals', () => {
    const { tables, manifest } = generatePerformanceSeed(resolvePerformanceSeedConfig({}, ANCHOR));
    const physicalItemCount = Object.values(tables).reduce((total, table) => total + table.length, 0);
    const nativeGroupMemberSlotCount = tables.conversations
      .filter((conversation) => conversation.type === 'group_text')
      .reduce((total, conversation) => total + (conversation.participants?.length ?? 0), 0);
    const totalRecipientCount = tables.broadcasts
      .reduce((total, broadcast) => total + Object.keys(broadcast.recipients).length, 0);

    expect(physicalItemCount).toBe(manifest.physicalItemCount);
    expect(nativeGroupMemberSlotCount).toBe(manifest.nativeGroupMemberSlotCount);
    expect(totalRecipientCount).toBe(manifest.totalRecipientCount);
  });

  it.each([0, 10, 10_080, 10_081, 10_082, 20_000])('replaces the relay fixture message depth at %i without backdating messages beyond its parent', (longConversationMessages) => {
    const config = resolvePerformanceSeedConfig(
      zeroWorld({ contacts: 100, conversations: 1, nativeGroups: 2, messagesPerConversation: 0, longConversationMessages }),
      ANCHOR,
    );
    const { tables } = generatePerformanceSeed(config);
    const fixture = tables.conversations.find((row) => row.conversationId === 'perf-conversation-00000');
    const fixtureMessages = tables.messages.filter((row) => row.conversationId === fixture?.conversationId);

    expect(fixtureMessages).toHaveLength(longConversationMessages);
    expect(fixtureMessages.every((row) => row.created_at >= (fixture?.created_at ?? ''))).toBe(true);
    expect(tables.messages).toHaveLength(config.totalMessageCount);
  });

  it('uses active generated tenant recipients and makes the large terminal broadcast the fixture', () => {
    const config = resolvePerformanceSeedConfig(
      zeroWorld({ contacts: 100, broadcasts: 3, recipientsPerBroadcast: 2, largeBroadcastRecipients: 25 }),
      ANCHOR,
    );
    const { tables } = generatePerformanceSeed(config);
    const eligible = new Set(tables.contacts.filter((contact) => contact.type === 'tenant' && contact.deleted_at === undefined).map((contact) => contact.contactId));

    expect(Object.keys(tables.broadcasts[0]?.recipients ?? {})).toHaveLength(config.resolvedLargeBroadcastRecipients);
    expect(Object.keys(tables.broadcasts[1]?.recipients ?? {})).toHaveLength(config.resolvedRecipientsPerBroadcast);
    expect(tables.broadcasts.every((broadcast) => Object.keys(broadcast.recipients).every((contactId) => eligible.has(contactId)))).toBe(true);
    expect(tables.broadcasts.every((broadcast) => new Set(Object.keys(broadcast.recipients)).size === Object.keys(broadcast.recipients).length)).toBe(true);
    const fallback = generatePerformanceSeed(resolvePerformanceSeedConfig(zeroWorld({ contacts: 0, broadcasts: 1, recipientsPerBroadcast: 2, largeBroadcastRecipients: 2 }), ANCHOR));
    expect(Object.keys(fallback.tables.broadcasts[0]?.recipients ?? {})).toEqual(['contact-tenant-0001']);
  });

  it('clips relay groups without dropping conversations and enforces status-valid sparse fields', () => {
    const config = resolvePerformanceSeedConfig(zeroWorld({ conversations: 5_010, messagesPerConversation: 0 }), ANCHOR);
    const { tables } = generatePerformanceSeed(config);
    const relays = tables.conversations.filter((row) => row.type === 'relay_group');

    expect(tables.conversations).toHaveLength(5_010);
    expect(relays).toHaveLength(1_000);
    expect(tables.conversations.filter((row) => row.type !== 'relay_group')).toHaveLength(4_010);
    for (const relay of relays) {
      expect(relay.relay_status).toBe(`relay_group#${relay.status}`);
      expect(relay.participants?.length).toBeGreaterThanOrEqual(2);
      if (relay.status === 'open') {
        expect(relay.pool_number).toEqual(expect.stringMatching(/^\+1555[0-9]{7}$/));
        expect(relay.participant_phone).toBe(relay.pool_number);
      } else {
        expect(relay.status).toBe('connecting');
        expect(relay.pool_number).toBeUndefined();
        expect(relay.participant_phone).toBeUndefined();
      }
    }
  });

  it.each([1, 2, 3, 4])('guarantees a readable relay fixture for %i non-zero conversations', (conversations) => {
    const config = resolvePerformanceSeedConfig(zeroWorld({ conversations, messagesPerConversation: 0 }), ANCHOR);
    const { tables } = generatePerformanceSeed(config);

    expect(config.relayGroupCount).toBe(1);
    expect(tables.conversations.some((row) => row.type === 'relay_group' && row.status === 'open')).toBe(true);
  });

  it('guarantees a current scheduled tour when the tour override is one', () => {
    const config = resolvePerformanceSeedConfig(zeroWorld({ tours: 1 }), ANCHOR);
    const { tables } = generatePerformanceSeed(config);

    expect(tables.tours).toEqual([expect.objectContaining({
      status: 'scheduled',
      scheduledAt: ANCHOR,
    })]);
  });

  it('keeps the newest terminal broadcast reachable and de-duplicates every recipient map', () => {
    const config = resolvePerformanceSeedConfig({}, ANCHOR);
    const { tables, manifest } = generatePerformanceSeed(config);
    const sorted = [...tables.broadcasts].sort((a, b) => b.created_at.localeCompare(a.created_at));

    expect(sorted[0]).toBe(tables.broadcasts[0]);
    expect(sorted[0]?.status).toBe('sent');
    expect(sorted.slice(0, 50).some((row) => row.status === 'sent' || row.status === 'failed')).toBe(true);
    for (const row of tables.broadcasts) {
      expect(row).toMatchObject({
        broadcastId: expect.stringMatching(/^perf-broadcast-[0-9]{5}$/),
        _listPartition: 'broadcasts',
        created_at: expect.any(String),
        status: expect.stringMatching(/^(draft|sending|sent|failed)$/),
        stats: expect.any(Object),
        recipients: expect.any(Object),
      });
      expect(Object.keys(row.recipients)).toHaveLength(manifest.resolvedRecipientsPerBroadcast);
      expect(row.stats.audience).toBe(manifest.resolvedRecipientsPerBroadcast);
    }
  });

  it.each([
    ['generated parents', {}, { tenant: /^perf-contact-/, landlord: /^contact-landlord-0001$/, unit: /^perf-unit-/ }],
    ['lean tenant', { contacts: 0 }, { tenant: /^contact-tenant-0001$/, landlord: /^contact-landlord-0001$/, unit: /^perf-unit-/ }],
    ['lean unit and landlord', { units: 0, contacts: 1 }, { tenant: /^perf-contact-/, landlord: /^contact-landlord-0001$/, unit: /^unit-0001$/ }],
    ['no conversations', { conversations: 0 }, { tenant: /^perf-contact-/, landlord: /^contact-landlord-0001$/, unit: /^perf-unit-/ }],
  ] as const)('resolves the %s parent-child vector without changing requested entity counts', (_name, overrides, expected) => {
    const input = { ...zeroWorld(), contacts: 10, units: 2, placements: 2, tours: 2, conversations: 2, messagesPerConversation: 2, broadcasts: 2, recipientsPerBroadcast: 4, ...overrides };
    const config = resolvePerformanceSeedConfig(input, ANCHOR);
    const { tables } = generatePerformanceSeed(config);

    for (const row of tables.placements) {
      expect(row.tenantId).toMatch(expected.tenant);
      expect(row.unitId).toMatch(expected.unit);
    }
    for (const row of tables.tours) {
      expect(row.tenantId).toMatch(expected.tenant);
      expect(row.unitId).toMatch(expected.unit);
    }
    for (const row of tables.units) expect(row.landlordId).toMatch(expected.landlord);
    expect(tables.messages).toHaveLength(config.conversations * config.messagesPerConversation);
    expect(tables.placements).toHaveLength(config.placements);
    expect(tables.tours).toHaveLength(config.tours);
    expect(tables.conversations).toHaveLength(config.conversations);
  });

  it('collapses recipients to the lean tenant before generation and cap arithmetic', () => {
    const config = resolvePerformanceSeedConfig(
      zeroWorld({ contacts: 0, broadcasts: 2, recipientsPerBroadcast: 25 }),
      ANCHOR,
    );
    const { tables, manifest } = generatePerformanceSeed(config);

    expect(manifest).toMatchObject({
      requestedRecipientCount: 50,
      resolvedRecipientsPerBroadcast: 1,
      resolvedRecipientCount: 2,
    });
    expect(tables.broadcasts.map((row) => Object.keys(row.recipients))).toEqual([
      ['contact-tenant-0001'],
      ['contact-tenant-0001'],
    ]);
  });

  it('reserves six distinct, unread, first-page scale-1 self-QA fixtures with exact back-references', () => {
    const config = resolvePerformanceSeedConfig({}, ANCHOR);
    const { tables } = generatePerformanceSeed(config);
    const fixtures = resolvePerformanceSelfQaFixtures(config);
    const contactDetailConversation = tables.conversations.find((row) =>
      row.participants?.some((participant) => participant.contactId === fixtures.contact_detail),
    );
    const inboxConversation = tables.conversations.find((row) =>
      row.participants?.some((participant) => participant.contactId === fixtures.inbox_row),
    );
    const conversationDetail = tables.conversations.find((row) => row.conversationId === fixtures.conversation_detail);
    const tourGroup = tables.conversations.find((row) => row.conversationId === fixtures.tour_group);
    const placementGroup = tables.conversations.find((row) => row.conversationId === fixtures.placement_group);
    const unmatched = tables.unmatched_email.find((row) => row.unmatchedId === fixtures.unmatched_email);
    const tour = tables.tours.find((row) => row.groupThreadId === fixtures.tour_group);
    const placement = tables.placements.find((row) => row.group_thread === fixtures.placement_group);
    const messageConversationIds = new Set(tables.messages.map((row) => row.conversationId));

    expect(Object.keys(fixtures)).toEqual([
      'contact_detail',
      'conversation_detail',
      'inbox_row',
      'unmatched_email',
      'tour_group',
      'placement_group',
    ]);
    expect(fixtures.contact_detail).not.toBe(fixtures.inbox_row);
    expect(new Set([fixtures.conversation_detail, fixtures.tour_group, fixtures.placement_group])).toHaveLength(3);
    expect(contactDetailConversation).toMatchObject({ type: 'tenant_1to1', status: 'open', unread_count: expect.any(Number) });
    expect(inboxConversation).toMatchObject({ type: 'tenant_1to1', status: 'open', unread_count: expect.any(Number) });
    expect(contactDetailConversation?.conversationId).not.toBe(inboxConversation?.conversationId);
    expect(contactDetailConversation?.unread_count).toBeGreaterThan(0);
    expect(inboxConversation?.unread_count).toBeGreaterThan(0);
    for (const relay of [conversationDetail, tourGroup, placementGroup]) {
      expect(relay).toMatchObject({
        type: 'relay_group',
        status: 'open',
        relay_status: 'relay_group#open',
        unread_count: expect.any(Number),
      });
      expect(relay?.unread_count).toBeGreaterThan(0);
      expect(messageConversationIds.has(relay?.conversationId ?? '')).toBe(true);
    }
    expect(conversationDetail?.owner).toEqual({ type: null });
    expect(tourGroup?.owner).toEqual({ type: 'tour', id: tour?.tourId });
    expect(placementGroup?.owner).toEqual({ type: 'placement', id: placement?.placementId });
    expect(tour).toMatchObject({ status: 'scheduled', groupThreadId: fixtures.tour_group });
    expect(placement).toMatchObject({ group_thread: fixtures.placement_group });
    expect(tour?.scheduledAt?.slice(0, 10)).toBe(ANCHOR.slice(0, 10));
    expect(placement?.attention).toBeUndefined();
    expect(unmatched).toMatchObject({ status: 'unmatched', read: false });

    const newestInboxRows = tables.conversations
      .filter((row) => row.status === 'open' || row.status === 'connecting')
      .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
    expect(newestInboxRows.slice(0, 30).some((row) => row.conversationId === inboxConversation?.conversationId)).toBe(true);
    expect(newestInboxRows.some((row) => row.conversationId === fixtures.conversation_detail)).toBe(true);
  });

  it('keeps private fixture IDs structurally absent from manifest serialization', () => {
    const config = resolvePerformanceSeedConfig({}, ANCHOR);
    const generated = generatePerformanceSeed(config);
    const fixtures = resolvePerformanceSelfQaFixtures(config);
    const serialized = JSON.stringify({ ok: true, manifest: generated.manifest });

    for (const [key, rawId] of Object.entries(fixtures)) {
      expect(serialized).not.toContain(key);
      expect(serialized).not.toContain(rawId);
    }
    expect(serialized).not.toContain('perf-');
  });
});

describe('resolvePerformanceSelfQaFixtures', () => {
  const changedConfigs = [
    { scale: 0 },
    { scale: 2 },
    { contacts: 99 },
    { units: 24 },
    { placements: 49 },
    { tours: 49 },
    { conversations: 99 },
    { nativeGroups: 20 },
    { messagesPerConversation: 9 },
    { requestedLongConversationMessages: 9 },
    { broadcasts: 9 },
    { recipientsPerBroadcast: 24 },
    { requestedLargeBroadcastRecipients: 24 },
  ] as const;

  it.each(changedConfigs)('rejects a non-default scale-1 fixture world %j', (patch) => {
    const config = { ...resolvePerformanceSeedConfig({}, ANCHOR), ...patch };
    expect(() => resolvePerformanceSelfQaFixtures(config)).toThrow('default scale-1');
  });
});

describe('validatePerformanceConversation', () => {
  it.each([
    ['missing relay_status', { relay_status: undefined }],
    ['wrong relay_status', { relay_status: 'relay_group#closed' }],
    ['missing owner', { owner: undefined }],
    ['missing participants', { participants: [] as ConversationItem['participants'] }],
    ['missing last activity', { last_activity_at: '' }],
    ['open without pool number', { pool_number: undefined }],
    ['open without participant phone', { participant_phone: undefined }],
  ] as const)('rejects relay rows with %s', (_name, patch) => {
    const relay = generatePerformanceSeed(resolvePerformanceSeedConfig({}, ANCHOR)).tables.conversations.find(
      (row) => row.type === 'relay_group' && row.status === 'open',
    );
    expect(relay).toBeDefined();
    expect(() => validatePerformanceConversation({ ...relay!, ...patch })).toThrow('conversation');
  });

  it('rejects connecting relay rows that invent sparse pool fields', () => {
    const relay = generatePerformanceSeed(resolvePerformanceSeedConfig({}, ANCHOR)).tables.conversations.find(
      (row) => row.type === 'relay_group' && row.status === 'connecting',
    );
    expect(relay).toBeDefined();
    expect(() => validatePerformanceConversation({ ...relay!, pool_number: '+15550000000' })).toThrow('conversation');
    expect(() => validatePerformanceConversation({ ...relay!, participant_phone: '+15550000000' })).toThrow('conversation');
  });
});
