// WP1 B2a spec D6: the anthropic ranking driver. The SDK is STUBBED (plan
// WI7): no test here reaches the network or reads ANTHROPIC_API_KEY - every
// key below is a fake string. Pins the exact request (model, adaptive
// thinking, effort, the json_schema format, max_tokens, the per-request
// timeout, maxRetries 1, no fallback or beta), the failure mapping, usage,
// the supported-model refusal and the factory.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({
  reply: {} as unknown,
  throwError: undefined as unknown,
  lastRequest: undefined as Record<string, unknown> | undefined,
  lastOptions: undefined as Record<string, unknown> | undefined,
  constructed: [] as Array<Record<string, unknown>>,
  calls: 0,
}));

vi.mock('@anthropic-ai/sdk', () => {
  class StubTimeoutError extends Error {}
  class StubAnthropic {
    static APIConnectionTimeoutError = StubTimeoutError;
    readonly messages = {
      create: async (params: Record<string, unknown>, options: Record<string, unknown>): Promise<unknown> => {
        sdk.calls += 1;
        sdk.lastRequest = params;
        sdk.lastOptions = options;
        if (sdk.throwError !== undefined) throw sdk.throwError;
        return sdk.reply;
      },
    };
    constructor(opts: Record<string, unknown>) {
      sdk.constructed.push(opts);
    }
  }
  return { default: StubAnthropic };
});

const { createRankingDriver, isSupportedRankingModel } = await import('../src/adapters/ranking.js');
const SdkStub = (await import('@anthropic-ai/sdk')).default as unknown as { APIConnectionTimeoutError: new (m: string) => Error };
import { RANKING_SUPPORTED_MODELS } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { buildRankingBatch } from '../src/services/ranking/prompt.js';
import { rankingSchema } from '../src/services/ranking/schema.js';
import { createLogCapture } from './helpers/logCapture.js';
import { propertyCardFixture, tenantCardFixture, tenantsForPropertySource } from './helpers/rankingBatchFixture.js';

const KEY = 'sk-test-not-a-real-key';
type Settings = Parameters<typeof createRankingDriver>[0];
const base: Settings = {
  rankingDriver: 'anthropic',
  aiRankingModel: 'claude-sonnet-5-5',
  rankingEffort: 'low',
  rankingMaxOutputTokens: 16000,
  rankingCallTimeoutMs: 120000,
  anthropicApiKey: KEY,
  anthropicApiBaseUrl: undefined,
};

function batch(landlordCard = false) {
  return buildRankingBatch(tenantsForPropertySource(
    [tenantCardFixture({ firstName: 'Zelda', notes: 'Private note text' }), tenantCardFixture()],
    propertyCardFixture(),
    { landlordCard },
  ));
}

function answer(text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stop_reason: 'end_turn',
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0 },
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }],
    ...over,
  };
}

const goodText = JSON.stringify({
  candidates: [
    { candidateId: 'c1', score: 81, for: [{ text: 'near work', source: 'area' }], against: [], unknowns: [], failedRequirements: [], fairHousingFlags: [] },
    { candidateId: 'c2', score: 40, for: [], against: [], unknowns: [], failedRequirements: [], fairHousingFlags: [] },
  ],
});

beforeEach(() => {
  sdk.reply = answer(goodText);
  sdk.throwError = undefined;
  sdk.lastRequest = undefined;
  sdk.lastOptions = undefined;
  sdk.constructed = [];
  sdk.calls = 0;
});

describe('the request (spec D6)', () => {
  it('is exactly the spec request: adaptive thinking, effort and the json_schema format, no fallback', async () => {
    const b = batch();
    await createRankingDriver(base).rankBatch(b);
    expect(sdk.lastRequest).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: rankingSchema({ landlordCard: false }) } },
      system: b.system,
      messages: [{ role: 'user', content: b.user }],
    });
    expect(sdk.lastRequest).not.toHaveProperty('fallbacks');
    expect(sdk.lastRequest).not.toHaveProperty('betas');
  });

  it('sends the per-request timeout and maxRetries 1', async () => {
    await createRankingDriver({ ...base, rankingCallTimeoutMs: 45000 }).rankBatch(batch());
    expect(sdk.lastOptions).toEqual({ timeout: 45000, maxRetries: 1 });
  });

  it('uses the landlord-on schema for a landlord-on batch, and the configured model and effort', async () => {
    await createRankingDriver({ ...base, aiRankingModel: 'claude-opus-5-5', rankingEffort: 'medium', rankingMaxOutputTokens: 8000 }).rankBatch(batch(true));
    expect(sdk.lastRequest).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: rankingSchema({ landlordCard: true }) } },
    });
  });

  it('constructs the client with the key, and the base URL only when given', () => {
    createRankingDriver(base);
    createRankingDriver({ ...base, anthropicApiBaseUrl: 'http://127.0.0.1:9999' });
    expect(sdk.constructed).toEqual([{ apiKey: KEY }, { apiKey: KEY, baseURL: 'http://127.0.0.1:9999' }]);
  });
});

describe('a good answer', () => {
  it('parses through the production parser and carries meta: model, fingerprint, raw text, usage, latency', async () => {
    const times = [5000, 5420];
    const b = batch();
    const call = await createRankingDriver(base, undefined, { now: () => times.shift()! }).rankBatch(b);
    expect(call.ok).toBe(true);
    if (!call.ok) return;
    expect(call.meta).toEqual({
      driver: 'anthropic',
      model: 'claude-sonnet-5-5',
      promptFingerprint: b.promptFingerprint,
      rawText: goodText,
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 0 },
      latencyMs: 420,
    });
    expect(call.output.byHandle.get('c1')!.score).toBe(81);
  });

  it('omits cacheReadInputTokens when the response does not carry it', async () => {
    sdk.reply = answer(goodText, { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null } });
    const call = await createRankingDriver(base).rankBatch(batch());
    expect(call.meta.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('logs counts only (never card text)', async () => {
    const capture = createLogCapture();
    await createRankingDriver(base, createLogger({ level: 'info', destination: capture.stream })).rankBatch(batch());
    expect(capture.lines).toHaveLength(1);
    expect(capture.lines[0]).toMatchObject({ msg: 'anthropic ranking usage', candidates: 2, inputTokens: 1200, outputTokens: 300 });
    const logged = JSON.stringify(capture.lines);
    for (const secret of ['Zelda', 'Private note text', 'near work']) expect(logged).not.toContain(secret);
  });
});

describe('the failure mapping (never a throw)', () => {
  it('a timeout (after the one retry) is failure timeout', async () => {
    sdk.throwError = new SdkStub.APIConnectionTimeoutError('Request timed out.');
    const call = await createRankingDriver(base).rankBatch(batch());
    expect(call).toMatchObject({ ok: false, failure: 'timeout', message: 'Anthropic ranking call timed out after 120000 ms (one retry included)' });
  });

  it('any other SDK error is failure driver with its message', async () => {
    sdk.throwError = new Error('400 invalid_request_error: grammar too large');
    const call = await createRankingDriver(base).rankBatch(batch());
    expect(call).toMatchObject({ ok: false, failure: 'driver', message: '400 invalid_request_error: grammar too large' });
    expect(call.meta.usage).toBeUndefined();
  });

  it('stop_reason refusal is failure refusal, usage still stamped', async () => {
    sdk.reply = answer('', { stop_reason: 'refusal' });
    const call = await createRankingDriver(base).rankBatch(batch());
    expect(call).toMatchObject({ ok: false, failure: 'refusal', message: 'Anthropic declined to rank this batch (stop_reason: refusal)' });
    expect(call.meta.usage).toEqual({ inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 0 });
  });

  it('stop_reason max_tokens is failure truncated with the partial text', async () => {
    sdk.reply = answer('{"candidates":[{"candidateId":"c1"', { stop_reason: 'max_tokens', usage: { input_tokens: 9, output_tokens: 16000 } });
    const call = await createRankingDriver(base).rankBatch(batch());
    expect(call).toMatchObject({
      ok: false,
      failure: 'truncated',
      message: 'Anthropic ranking hit the 16000-token output cap (thinking included) (16000 output tokens) and returned an incomplete response (stop_reason: max_tokens)',
    });
    expect(call.meta.rawText).toBe('{"candidates":[{"candidateId":"c1"');
  });

  it('no usage, no content list or no text block is failure driver', async () => {
    sdk.reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: goodText }] };
    expect(await createRankingDriver(base).rankBatch(batch())).toMatchObject({ ok: false, failure: 'driver', message: 'Anthropic ranking response carried no usage counts' });
    sdk.reply = { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    expect(await createRankingDriver(base).rankBatch(batch())).toMatchObject({ ok: false, failure: 'driver', message: 'Anthropic ranking response contained no content blocks' });
    sdk.reply = answer('', { content: [{ type: 'thinking', thinking: '', signature: 's' }] });
    expect(await createRankingDriver(base).rankBatch(batch())).toMatchObject({ ok: false, failure: 'driver', message: 'Anthropic ranking response contained no text block' });
  });

  it('unparseable text is failure parse, the raw text kept', async () => {
    sdk.reply = answer('not json at all');
    const call = await createRankingDriver(base).rankBatch(batch());
    expect(call).toMatchObject({ ok: false, failure: 'parse', message: 'ranking output is not valid JSON' });
    expect(call.meta.rawText).toBe('not json at all');
  });
});

describe('createRankingDriver', () => {
  it('selects each kind; fake and console ignore the model and need no key', () => {
    expect(createRankingDriver(base).kind).toBe('anthropic');
    expect(createRankingDriver({ ...base, rankingDriver: 'fake', aiRankingModel: 'anything', anthropicApiKey: undefined }).kind).toBe('fake');
    expect(createRankingDriver({ ...base, rankingDriver: 'console', aiRankingModel: 'anything', anthropicApiKey: undefined }).kind).toBe('console');
  });

  it('re-asserts config\'s supported set: an unsupported model is refused (config refuses it at startup too, S2)', () => {
    for (const model of ['claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-4-8', '']) {
      expect(isSupportedRankingModel(model)).toBe(false);
      expect(() => createRankingDriver({ ...base, aiRankingModel: model })).toThrow(/AI_RANKING_MODEL must be one of claude-sonnet-5-5, claude-opus-5-5/);
    }
    for (const model of RANKING_SUPPORTED_MODELS) expect(isSupportedRankingModel(model)).toBe(true);
    expect([...RANKING_SUPPORTED_MODELS]).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
  });

  it('refuses the anthropic driver without a key', () => {
    expect(() => createRankingDriver({ ...base, anthropicApiKey: undefined })).toThrow(/requires an apiKey/);
    expect(() => createRankingDriver({ ...base, anthropicApiKey: '' })).toThrow(/requires an apiKey/);
  });

  it('makes no call until rankBatch', () => {
    createRankingDriver(base);
    expect(sdk.calls).toBe(0);
  });
});

// IR30: S3.1's reader scan reads the two ranking adapters through an
// existsSync filter; pin that both files exist so that filter is never
// vacuous (the scan itself is S3's, WI8).
describe('the ranking adapter files exist (the reader scan is not vacuous)', () => {
  it('adapters/ranking.ts and adapters/rankingFake.ts', () => {
    const adapters = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'adapters');
    expect(existsSync(path.join(adapters, 'ranking.ts'))).toBe(true);
    expect(existsSync(path.join(adapters, 'rankingFake.ts'))).toBe(true);
  });
});
