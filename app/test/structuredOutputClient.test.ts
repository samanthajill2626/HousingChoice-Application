// WP1 B1 spec D7 rev 9 (plan task S6.1a): the structured-output client in
// adapters/extraction.ts - the never-written grader's ONE vendor call. The SDK
// is STUBBED (no network, no key, WI16), as extractionAdapter.test.ts does: the
// request shape (the caller's own system, user content and schema; the shared
// output cap; the per-model thinking-off form), the client construction it
// shares with the extraction driver, and every failure arm, which must RETURN,
// never throw.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  reply: {} as unknown,
  throwWith: undefined as Error | undefined,
  lastRequest: undefined as Record<string, unknown> | undefined,
  constructed: [] as Array<Record<string, unknown>>,
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class StubAnthropic {
    constructor(opts: Record<string, unknown>) {
      sdk.constructed.push(opts);
    }
    readonly messages = {
      create: async (params: Record<string, unknown>): Promise<unknown> => {
        sdk.lastRequest = params;
        if (sdk.throwWith !== undefined) throw sdk.throwWith;
        return sdk.reply;
      },
    };
  },
}));

const { createExtractionDriver, createStructuredOutputClient } = await import('../src/adapters/extraction.js');
import type { StructuredOutputRequest } from '../src/adapters/extraction.js';

const request: StructuredOutputRequest = {
  system: 'You judge items.',
  user: 'PLANTED FACT: none\n\nITEMS (JSON):\n[]',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { verdicts: { type: 'array', items: { type: 'string' } } },
    required: ['verdicts'],
  },
};

const OK_REPLY = {
  stop_reason: 'end_turn',
  usage: { input_tokens: 40, output_tokens: 9 },
  content: [{ type: 'text', text: '{"verdicts":[]}' }],
};

beforeEach(() => {
  sdk.reply = OK_REPLY;
  sdk.throwWith = undefined;
  sdk.lastRequest = undefined;
  sdk.constructed.length = 0;
});

describe('createStructuredOutputClient - the request', () => {
  it("sends the caller's system, user content and schema verbatim, with the shared 4096 output cap", async () => {
    const client = createStructuredOutputClient({ model: 'claude-opus-4-8', apiKey: 'sk-test' });
    expect(client.model).toBe('claude-opus-4-8');
    await client.call(request);
    expect(sdk.lastRequest).toEqual({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      thinking: { type: 'disabled' },
      output_config: { format: { type: 'json_schema', schema: request.schema } },
      system: 'You judge items.',
      messages: [{ role: 'user', content: 'PLANTED FACT: none\n\nITEMS (JSON):\n[]' }],
    });
  });

  // The same per-model OFF switch as the driver (extraction.ts thinkingOff):
  // claude-sonnet-5-5 refuses `disabled`.
  it('turns thinking off with between_tools on claude-sonnet-5-5', async () => {
    await createStructuredOutputClient({ model: 'claude-sonnet-5-5', apiKey: 'sk-test' }).call(request);
    expect(sdk.lastRequest?.['thinking']).toEqual({ type: 'between_tools' });
  });

  it('constructs the SDK client exactly as the extraction driver does', () => {
    createStructuredOutputClient({ model: 'claude-sonnet-5-5', apiKey: 'sk-test' });
    createExtractionDriver({ driver: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-test' });
    createStructuredOutputClient({ model: 'claude-sonnet-5-5', apiKey: 'sk-test', apiBaseUrl: 'http://127.0.0.1:9' });
    expect(sdk.constructed).toEqual([
      { apiKey: 'sk-test' },
      { apiKey: 'sk-test' },
      { apiKey: 'sk-test', baseURL: 'http://127.0.0.1:9' },
    ]);
  });

  it('requires an apiKey', () => {
    expect(() => createStructuredOutputClient({ model: 'claude-sonnet-5-5', apiKey: '' })).toThrow(/apiKey/);
  });
});

describe('createStructuredOutputClient - the answer (never a throw)', () => {
  const client = () => createStructuredOutputClient({ model: 'claude-sonnet-5-5', apiKey: 'sk-test' });

  it('returns the text and the usage on a normal answer', async () => {
    await expect(client().call(request)).resolves.toEqual({
      ok: true,
      text: '{"verdicts":[]}',
      usage: { inputTokens: 40, outputTokens: 9 },
    });
  });

  it('a refusal is a refusal, keeping usage when billed', async () => {
    sdk.reply = { stop_reason: 'refusal', content: [] };
    const unbilled = await client().call(request);
    expect(unbilled).toMatchObject({ ok: false, failure: 'refusal' });
    expect('usage' in unbilled).toBe(false);
    sdk.reply = { stop_reason: 'refusal', usage: { input_tokens: 7, output_tokens: 0 } };
    expect(await client().call(request)).toMatchObject({ ok: false, failure: 'refusal', usage: { inputTokens: 7, outputTokens: 0 } });
  });

  it('a max_tokens stop is a truncation, with its usage', async () => {
    sdk.reply = { stop_reason: 'max_tokens', usage: { input_tokens: 40, output_tokens: 4096 }, content: [{ type: 'text', text: '{"verd' }] };
    const call = await client().call(request);
    expect(call).toMatchObject({ ok: false, failure: 'truncated', usage: { inputTokens: 40, outputTokens: 4096 } });
    expect(call.ok === false && call.message).toMatch(/4096-token output cap/);
  });

  it('a thrown SDK error is a driver failure', async () => {
    sdk.throwWith = new Error('connect ECONNREFUSED');
    await expect(client().call(request)).resolves.toEqual({ ok: false, failure: 'driver', message: 'connect ECONNREFUSED' });
  });

  it.each([
    ['no usage', { stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }, /no usage counts/],
    ['no content array', { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }, /no content blocks/],
    ['no text block', { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [] }, /no text block/],
  ])('a response with %s is a driver failure', async (_name, reply, message) => {
    sdk.reply = reply;
    const call = await client().call(request);
    expect(call.ok).toBe(false);
    expect(call.ok === false && call.failure).toBe('driver');
    expect(call.ok === false && call.message).toMatch(message);
  });
});
