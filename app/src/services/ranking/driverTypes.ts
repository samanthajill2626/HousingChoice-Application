// WP1 B2a spec D6: the ranking driver interface. No SDK import here: the
// services and the job depend on this interface; only adapters/ranking.ts
// imports @anthropic-ai/sdk. RankingCall is a DISCRIMINATED result that
// never throws, as ExtractionCall is: meta (model, raw text, usage, latency)
// is assembled first and returned on every path. Type-only imports: the
// effort levels and the supported models are config's (S2, lib/config.ts).
import type { ParsedRanking } from './parse.js';
import type { RankingBatchInput } from './prompt.js';

export type { RankingEffort } from '../../lib/config.js';
export type { RankingBatchInput } from './prompt.js';

export type RankingDriverKind = 'anthropic' | 'console' | 'fake';

export type RankingFailure = 'refusal' | 'parse' | 'truncated' | 'timeout' | 'driver';

export interface RankingUsage {
  inputTokens: number;
  outputTokens: number;
  /** Recorded when the response carries it (prompt caching is off; charter 14). */
  cacheReadInputTokens?: number;
}

export interface RankingCallMeta {
  driver: RankingDriverKind;
  /** The model actually used: the model id for anthropic, the literal 'fake' or 'console' otherwise (spec D6). */
  model: string;
  /** The batch's promptFingerprint. Every S4 driver sets it; optional so a stub meta type-checks (plan C12). */
  promptFingerprint?: string;
  /** The response text verbatim, pre-parse (the fake's own JSON). PII by design: never logged. */
  rawText?: string;
  usage?: RankingUsage;
  latencyMs: number;
}

export type RankingCall =
  | { ok: true; meta: RankingCallMeta; output: ParsedRanking }
  | { ok: false; meta: RankingCallMeta; failure: RankingFailure; message: string };

export interface RankingDriver {
  readonly kind: RankingDriverKind;
  rankBatch(input: RankingBatchInput): Promise<RankingCall>;
}
