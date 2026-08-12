import { describe, expect, it, vi } from 'vitest';
import {
  PERFORMANCE_SEED_BOUNDS,
  generatePerformanceSeed,
  resolvePerformanceSeedConfig,
  toPerformanceSeedManifest,
  type PerformanceSeedInput,
} from '../src/lib/seed/performance.js';

const ANCHOR = '2026-08-11T16:00:00.000Z';

const zeroWorld = (overrides: PerformanceSeedInput = {}): PerformanceSeedInput => ({
  scale: 1,
  contacts: 0,
  units: 0,
  placements: 0,
  tours: 0,
  conversations: 0,
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
      units: 25,
      placements: 50,
      tours: 50,
      conversations: 100,
      messagesPerConversation: 10,
      broadcasts: 10,
      recipientsPerBroadcast: 25,
      messageCount: 1_000,
      requestedRecipientCount: 250,
      resolvedRecipientCount: 250,
      requestedRelayGroupCount: 20,
      relayGroupCount: 20,
      clippedRelayGroupCount: 0,
      fixedUnmatchedEmailCount: 4,
      physicalItemCount: 1_339,
      totalItemCount: 1_589,
    });
  });

  it('multiplies entity counts at scale 100 without multiplying densities', () => {
    const config = resolvePerformanceSeedConfig({ scale: 100 }, ANCHOR);

    expect(config).toMatchObject({
      contacts: 10_000,
      units: 2_500,
      placements: 5_000,
      tours: 5_000,
      conversations: 10_000,
      messagesPerConversation: 10,
      broadcasts: 1_000,
      recipientsPerBroadcast: 25,
      messageCount: 100_000,
      requestedRecipientCount: 25_000,
      resolvedRecipientCount: 25_000,
      requestedRelayGroupCount: 2_000,
      relayGroupCount: 1_000,
      clippedRelayGroupCount: 1_000,
      physicalItemCount: 133_504,
      totalItemCount: 158_504,
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
        messagesPerConversation: 12,
        broadcasts: 13,
        recipientsPerBroadcast: 6,
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
      messagesPerConversation: 12,
      broadcasts: 13,
      recipientsPerBroadcast: 6,
      messageCount: 132,
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
    ['broadcasts', 0, 20_000],
    ['messagesPerConversation', 0, 100],
    ['recipientsPerBroadcast', 0, 1_000],
  ] as const)('accepts the exact lower and upper %s bounds', (key, lower, upper) => {
    const lowerConfig = resolvePerformanceSeedConfig(zeroWorld({ [key]: lower }), ANCHOR);
    const upperConfig = resolvePerformanceSeedConfig(zeroWorld({ [key]: upper }), ANCHOR);

    expect(lowerConfig[key]).toBe(lower);
    expect(upperConfig[key]).toBe(upper);
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
    ['messagesPerConversation', -1],
    ['messagesPerConversation', 101],
    ['messagesPerConversation', 1.5],
    ['broadcasts', -1],
    ['broadcasts', 20_001],
    ['broadcasts', 1.5],
    ['recipientsPerBroadcast', -1],
    ['recipientsPerBroadcast', 1_001],
    ['recipientsPerBroadcast', 1.5],
  ] as const)('rejects an invalid or non-integer %s value', (key, value) => {
    const input = key === 'scale' ? { scale: value } : zeroWorld({ [key]: value });

    expect(() => resolvePerformanceSeedConfig(input, ANCHOR)).toThrow(key);
  });

  it('publishes the exact safety bounds as data rather than parser magic', () => {
    expect(PERFORMANCE_SEED_BOUNDS).toEqual({
      scale: { min: 1, max: 100 },
      entityCount: { min: 0, max: 20_000 },
      messagesPerConversation: { min: 0, max: 100 },
      recipientsPerBroadcast: { min: 0, max: 1_000 },
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

  it('captures one anchor when none is supplied and normalizes an explicit ISO anchor', () => {
    const now = vi.fn(() => new Date('2026-08-11T12:34:56.789Z'));

    const captured = resolvePerformanceSeedConfig({}, undefined, now);
    const explicit = resolvePerformanceSeedConfig({}, '2026-08-11T08:34:56.789-04:00', now);

    expect(captured.anchor).toBe('2026-08-11T12:34:56.789Z');
    expect(explicit.anchor).toBe('2026-08-11T12:34:56.789Z');
    expect(now).toHaveBeenCalledTimes(1);
    expect(() => resolvePerformanceSeedConfig({}, 'not-an-anchor')).toThrow('anchor');
  });

  it('builds a detached counts-only manifest and leaves row generation explicit', () => {
    const config = resolvePerformanceSeedConfig({}, ANCHOR);
    const manifest = toPerformanceSeedManifest(config);

    expect(manifest).toEqual(config);
    expect(manifest).not.toBe(config);
    expect(() => generatePerformanceSeed(config)).toThrow(
      'performance row generation not implemented',
    );
  });
});
