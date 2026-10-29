// WP1 B2a spec D6: the dollar cost of one ranking call. The price table
// (dollars per million input / output tokens per model id) is config's:
// DEFAULT_AI_PRICE_TABLE in lib/config.ts (the Claude API model table as of
// 2026-10-06, confirmed by Cameron at the spec gate), replaced whole by
// AI_PRICE_TABLE (S2). The caller passes it in. Prompt caching is off
// (charter 14), so cache-read tokens are recorded on the run but not priced.
// Pure: a type-only import.
import type { AiPrice } from '../../lib/config.js';

type PriceTable = Readonly<Record<string, Readonly<AiPrice>>>;

/** The model ids the fake and console drivers stamp: they call nothing and cost nothing. */
const UNBILLED_MODELS: ReadonlySet<string> = new Set(['fake', 'console']);

export function priceOf(priceTable: PriceTable, model: string): Readonly<AiPrice> | undefined {
  return Object.prototype.hasOwnProperty.call(priceTable, model) ? priceTable[model] : undefined;
}

/**
 * in * inputTokens / 1e6 + out * outputTokens / 1e6, rounded to 1e-6 dollars.
 * Zero for the fake and console drivers and for a call that carried no usage.
 * Throws for a billed model with no price: startup refuses that config (S2),
 * so reaching it is a programming error.
 */
export function costUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number } | undefined,
  priceTable: PriceTable,
): number {
  if (usage === undefined || UNBILLED_MODELS.has(model)) return 0;
  const price = priceOf(priceTable, model);
  if (price === undefined) throw new Error(`no price for model ${model} in AI_PRICE_TABLE`);
  const dollars = (price.in * usage.inputTokens) / 1e6 + (price.out * usage.outputTokens) / 1e6;
  return Math.round(dollars * 1e6) / 1e6;
}
