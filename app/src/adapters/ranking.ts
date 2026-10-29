// WP1 B2a spec D6: the ranking driver factory and the anthropic ranking
// driver - the ONLY new Anthropic SDK import site (adapter rule; services
// depend on services/ranking/driverTypes.ts). Fake and console drivers live
// in rankingFake.ts (one rules module, plan PR8).
//
// THE REQUEST: model = AI_RANKING_MODEL; max_tokens =
// RANKING_MAX_OUTPUT_TOKENS (thinking tokens count against it);
// thinking: { type: 'adaptive' }; output_config: { effort: RANKING_EFFORT,
// format: { type: 'json_schema', schema } }; request options timeout =
// RANKING_CALL_TIMEOUT_MS and maxRetries 1, so one call's wall clock stays
// bounded (at twice the timeout: the SDK retries a timed-out call once).
// NO server-side refusal fallback: a fallback would score some pairs on
// another model, breaking "one model per ranking" and the version rule
// (charter 10.3); a refusal is a failed batch.
//
// THE THINKING TRAP: extraction pins thinking OFF per model
// (adapters/extraction.ts thinkingOff); ranking runs adaptive thinking with
// an effort, which only the models in RANKING_SUPPORTED_MODELS take. Any
// other model is refused here; the driver is built at boot (S5), so the
// refusal stops startup.
import Anthropic from '@anthropic-ai/sdk';
import { RANKING_SUPPORTED_MODELS, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type {
  RankingBatchInput,
  RankingCall,
  RankingCallMeta,
  RankingDriver,
  RankingEffort,
} from '../services/ranking/driverTypes.js';
import { parseRankingText } from '../services/ranking/parse.js';
import { rankingSchema } from '../services/ranking/schema.js';
import { ConsoleRankingDriver, FakeRankingDriver } from './rankingFake.js';

/** Spec D6: one SDK retry, so a call's wall clock is bounded. */
export const RANKING_MAX_RETRIES = 1;

export function isSupportedRankingModel(model: string): boolean {
  return RANKING_SUPPORTED_MODELS.includes(model);
}

interface AnthropicRankingOptions {
  apiKey: string;
  apiBaseUrl?: string;
  model: string;
  effort: RankingEffort;
  maxOutputTokens: number;
  callTimeoutMs: number;
  logger?: Logger;
  now?: () => number;
}

class AnthropicRankingDriver implements RankingDriver {
  readonly kind = 'anthropic' as const;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: RankingEffort;
  private readonly maxOutputTokens: number;
  private readonly callTimeoutMs: number;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(opts: AnthropicRankingOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, ...(opts.apiBaseUrl ? { baseURL: opts.apiBaseUrl } : {}) });
    this.model = opts.model;
    this.effort = opts.effort;
    this.maxOutputTokens = opts.maxOutputTokens;
    this.callTimeoutMs = opts.callTimeoutMs;
    this.log = opts.logger ?? defaultLogger;
    this.now = opts.now ?? Date.now;
  }

  async rankBatch(input: RankingBatchInput): Promise<RankingCall> {
    const started = this.now();
    // Meta is assembled FIRST and returned on every path (as extraction).
    const meta: RankingCallMeta = { driver: 'anthropic', model: this.model, promptFingerprint: input.promptFingerprint, latencyMs: 0 };
    let message: Awaited<ReturnType<typeof this.client.messages.create>>;
    try {
      message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxOutputTokens,
          thinking: { type: 'adaptive' },
          output_config: {
            effort: this.effort,
            format: { type: 'json_schema', schema: rankingSchema({ landlordCard: input.landlordCard }) },
          },
          system: input.system,
          messages: [{ role: 'user', content: input.user }],
        },
        { timeout: this.callTimeoutMs, maxRetries: RANKING_MAX_RETRIES },
      );
    } catch (err) {
      meta.latencyMs = this.now() - started;
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        return {
          ok: false, meta, failure: 'timeout',
          message: `Anthropic ranking call timed out after ${this.callTimeoutMs} ms (one retry included)`,
        };
      }
      return { ok: false, meta, failure: 'driver', message: err instanceof Error ? err.message : String(err) };
    }
    meta.latencyMs = this.now() - started;
    // Defensive reading, as AnthropicExtractionDriver.extract: a response
    // missing what its type promises is a 'driver' failure, never a TypeError.
    const usage: typeof message.usage | undefined = message?.usage;
    const usageOk = typeof usage?.input_tokens === 'number' && typeof usage.output_tokens === 'number';
    if (usageOk) {
      const cacheRead: unknown = usage.cache_read_input_tokens;
      meta.usage = {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        ...(typeof cacheRead === 'number' ? { cacheReadInputTokens: cacheRead } : {}),
      };
      // Counts only - never card text (PII).
      this.log.info(
        {
          batchIndex: input.batchIndex,
          candidates: input.wire.candidates.length,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
        },
        'anthropic ranking usage',
      );
    }
    // A refusal is classified before the usage guard (a pre-output decline
    // may carry no counts), as extraction does.
    if (message?.stop_reason === 'refusal') {
      return { ok: false, meta, failure: 'refusal', message: 'Anthropic declined to rank this batch (stop_reason: refusal)' };
    }
    if (message?.stop_reason === 'max_tokens') {
      const partial = Array.isArray(message.content)
        ? message.content.find((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        : undefined;
      if (partial !== undefined) meta.rawText = partial.text;
      const spent = meta.usage?.outputTokens;
      return {
        ok: false, meta, failure: 'truncated',
        message:
          `Anthropic ranking hit the ${this.maxOutputTokens}-token output cap (thinking included)` +
          (spent === undefined ? '' : ` (${spent} output tokens)`) +
          ' and returned an incomplete response (stop_reason: max_tokens)',
      };
    }
    if (!usageOk) {
      return { ok: false, meta, failure: 'driver', message: 'Anthropic ranking response carried no usage counts' };
    }
    const content: typeof message.content | undefined = message.content;
    if (!Array.isArray(content)) {
      return { ok: false, meta, failure: 'driver', message: 'Anthropic ranking response contained no content blocks' };
    }
    const textBlock = content.find((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text');
    if (!textBlock) {
      return { ok: false, meta, failure: 'driver', message: 'Anthropic ranking response contained no text block' };
    }
    meta.rawText = textBlock.text;
    const parsed = parseRankingText(textBlock.text, {
      handles: input.handles.map((h) => h.handle),
      freeTextByHandle: input.freeTextByHandle,
      landlordCard: input.landlordCard,
    });
    return parsed.ok ? { ok: true, meta, output: parsed.value } : { ok: false, meta, failure: 'parse', message: parsed.message };
  }
}

/** The config fields the driver reads, by their AppConfig names (S5 passes `config` itself). */
export type RankingDriverSettings = Pick<
  AppConfig,
  | 'rankingDriver'
  | 'aiRankingModel'
  | 'rankingEffort'
  | 'rankingMaxOutputTokens'
  | 'rankingCallTimeoutMs'
  | 'anthropicApiKey'
  | 'anthropicApiBaseUrl'
>;

/**
 * The ranking driver for these settings. Startup already refuses an
 * unsupported or unpriced model (lib/config.ts, S2); the anthropic arm
 * RE-ASSERTS the supported set for callers that build settings without
 * loadConfig (the counterfactual script), and refuses a missing key.
 */
export function createRankingDriver(
  settings: RankingDriverSettings,
  logger?: Logger,
  opts: { now?: () => number } = {},
): RankingDriver {
  switch (settings.rankingDriver) {
    case 'fake':
      return new FakeRankingDriver({ now: opts.now });
    case 'console':
      return new ConsoleRankingDriver({ logger, now: opts.now });
    case 'anthropic': {
      if (!isSupportedRankingModel(settings.aiRankingModel)) {
        throw new Error(
          `AI_RANKING_MODEL must be one of ${RANKING_SUPPORTED_MODELS.join(', ')} ` +
            `(the models that run adaptive thinking with an effort), got: ${settings.aiRankingModel}`,
        );
      }
      if (!settings.anthropicApiKey) {
        throw new Error('createRankingDriver: driver "anthropic" requires an apiKey (ANTHROPIC_API_KEY)');
      }
      return new AnthropicRankingDriver({
        apiKey: settings.anthropicApiKey,
        apiBaseUrl: settings.anthropicApiBaseUrl,
        model: settings.aiRankingModel,
        effort: settings.rankingEffort,
        maxOutputTokens: settings.rankingMaxOutputTokens,
        callTimeoutMs: settings.rankingCallTimeoutMs,
        logger,
        now: opts.now,
      });
    }
    default: {
      const exhaustive: never = settings.rankingDriver;
      throw new Error(`createRankingDriver: unknown driver ${String(exhaustive)}`);
    }
  }
}
