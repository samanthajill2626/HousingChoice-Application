// WP1 B2a spec D6: every ranking run records its cost at the time of the
// call. Cost = in * inputTokens / 1e6 + out * outputTokens / 1e6 dollars,
// rounded to 1e-6. The table is config's (S2: DEFAULT_AI_PRICE_TABLE, or
// AI_PRICE_TABLE), passed in by the caller.
import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_PRICE_TABLE, loadConfig } from '../src/lib/config.js';
import { costUsd, priceOf } from '../src/services/ranking/cost.js';

describe('costUsd', () => {
  it('applies the formula over the default table', () => {
    expect(costUsd('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, DEFAULT_AI_PRICE_TABLE)).toBe(12);
    expect(costUsd('claude-opus-5-5', { inputTokens: 500_000, outputTokens: 100_000 }, DEFAULT_AI_PRICE_TABLE)).toBe(4);
  });

  it('reads the table it is given (an AI_PRICE_TABLE override)', () => {
    expect(costUsd('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 0 }, { 'claude-sonnet-5-5': { in: 3, out: 15 } })).toBe(3);
  });

  it('rounds to 1e-6 dollars', () => {
    // 2 * 1234 / 1e6 + 10 * 567 / 1e6 = 0.002468 + 0.00567 = 0.008138
    expect(costUsd('claude-sonnet-5-5', { inputTokens: 1234, outputTokens: 567 }, DEFAULT_AI_PRICE_TABLE)).toBe(0.008138);
    // 2 * 1 / 1e6 + 10 * 1 / 1e6 = 0.000012
    expect(costUsd('claude-sonnet-5-5', { inputTokens: 1, outputTokens: 1 }, DEFAULT_AI_PRICE_TABLE)).toBe(0.000012);
    // a fraction below 1e-6 rounds away: 0.3 * 1 / 1e6 = 3e-7 -> 0
    expect(costUsd('cheap', { inputTokens: 1, outputTokens: 0 }, { cheap: { in: 0.3, out: 0 } })).toBe(0);
  });

  it('is zero for the fake and console drivers and for a call with no usage', () => {
    expect(costUsd('fake', { inputTokens: 10, outputTokens: 10 }, DEFAULT_AI_PRICE_TABLE)).toBe(0);
    expect(costUsd('console', undefined, DEFAULT_AI_PRICE_TABLE)).toBe(0);
    expect(costUsd('claude-sonnet-5-5', undefined, DEFAULT_AI_PRICE_TABLE)).toBe(0);
  });

  it('throws for a priced call on a model with no price (startup refuses that config, S2)', () => {
    expect(() => costUsd('claude-haiku-5-5', { inputTokens: 1, outputTokens: 1 }, DEFAULT_AI_PRICE_TABLE))
      .toThrow(/no price for model claude-haiku-5-5/);
  });

  it('the configured default model is priced by the configured default table', () => {
    const cfg = loadConfig({ CF_ORIGIN_SECRET: 's', NODE_ENV: 'development' });
    expect(costUsd(cfg.aiRankingModel, { inputTokens: 1_000_000, outputTokens: 0 }, cfg.aiPriceTable)).toBe(2);
  });

  it('priceOf reads own keys only', () => {
    expect(priceOf(DEFAULT_AI_PRICE_TABLE, 'claude-sonnet-5-5')).toEqual({ in: 2, out: 10 });
    expect(priceOf(DEFAULT_AI_PRICE_TABLE, 'toString')).toBeUndefined();
  });
});
