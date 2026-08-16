// T3: extraction driver seam (factory + console + fake). The Anthropic driver's
// network path is deliberately NOT exercised here (request-shaping is covered by
// the schema/prompt tests in extractionSchema.test.ts) - EXCEPT for the
// malformed-response guards (F9), where the SDK is stubbed to return a shape the
// driver's types promise but a runtime response might not carry.
import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ reply: {} as unknown, lastRequest: undefined as Record<string, unknown> | undefined }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class StubAnthropic {
    readonly messages = {
      create: async (params: Record<string, unknown>): Promise<unknown> => {
        sdk.lastRequest = params;
        return sdk.reply;
      },
    };
  },
}));

const {
  createExtractionDriver,
  EMPTY_EXTRACTION,
  ExtractionRefusedError,
} = await import('../src/adapters/extraction.js');
import type { ExtractionInput } from '../src/adapters/extraction.js';
import { extractionPromptFingerprint } from '../src/services/extraction/prompt.js';
import { parseExtractionOps } from '../src/services/extraction/schema.js';

const model = 'claude-opus-4-8';

const baseInput: ExtractionInput = {
  profile: { contactType: 'tenant', phones: [] },
  transcript: [{ tsMsgId: '2026-07-16T10:00:00.000Z#s1', speaker: 'client', text: 'hi', at: '2026-07-16T10:00:00.000Z', channel: 'sms' }],
};

const markerInput: ExtractionInput = {
  profile: { contactType: 'tenant', phones: [] },
  transcript: [{
    tsMsgId: '2026-07-16T10:00:00.000Z#s1',
    speaker: 'client',
    text: 'EXTRACT:{"fields":{"pets":{"op":"none","value":"","reason":""}}}',
    at: '2026-07-16T10:00:00.000Z',
    channel: 'sms',
  }],
};

describe('createExtractionDriver', () => {
  it('selects a driver by kind', () => {
    expect(createExtractionDriver({ driver: 'console', model }).kind).toBe('console');
    expect(createExtractionDriver({ driver: 'fake', model }).kind).toBe('fake');
    expect(createExtractionDriver({ driver: 'anthropic', model, apiKey: 'sk-test' }).kind).toBe('anthropic');
  });

  it('throws for the anthropic driver without an apiKey', () => {
    expect(() => createExtractionDriver({ driver: 'anthropic', model })).toThrow();
  });
});

describe('console driver', () => {
  it('returns EMPTY_EXTRACTION (stays offline)', async () => {
    const driver = createExtractionDriver({ driver: 'console', model });
    await expect(driver.extract(baseInput)).resolves.toEqual({
      ok: true, meta: { driver: 'console' }, result: EMPTY_EXTRACTION,
    });
  });

  it('reports its identity and no model-specific fields', async () => {
    // A required precondition for the run log: without meta.driver, three
    // recorded fields cannot be populated (design 6.4).
    const call = await createExtractionDriver({ driver: 'console', model }).extract(baseInput);
    expect(call.meta).toEqual({ driver: 'console' });
  });
});

describe('fake driver', () => {
  // The real driver stamps promptFingerprint on the meta it assembles first, on
  // EVERY exit (adapters/extraction.ts:189-193). The fake now mirrors that, so
  // the run log's fingerprint plumbing is reachable hermetically (F7c).
  const fingerprint = expect.stringMatching(/^[0-9a-f]{12}$/) as unknown as string;

  it('parses the EXTRACT marker from the NEWEST client utterance, ignoring staff and older markers', async () => {
    const driver = createExtractionDriver({ driver: 'fake', model });
    const input: ExtractionInput = {
      profile: { contactType: 'tenant', phones: [] },
      transcript: [
        {
          tsMsgId: '2026-07-16T10:00:00.000Z#s1',
          speaker: 'client',
          text: 'EXTRACT:{"fields":{"pets":{"op":"write","value":"old"}}}',
          at: '2026-07-16T10:00:00.000Z',
          channel: 'sms',
        },
        {
          tsMsgId: '2026-07-16T10:01:00.000Z#s2',
          speaker: 'staff',
          text: 'EXTRACT:{"fields":{"pets":{"op":"write","value":"STAFF"}}}',
          at: '2026-07-16T10:01:00.000Z',
          channel: 'sms',
        },
        {
          tsMsgId: '2026-07-16T10:02:00.000Z#s3',
          speaker: 'client',
          text: 'sure\nEXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}',
          at: '2026-07-16T10:02:00.000Z',
          channel: 'sms',
        },
      ],
    };
    await expect(driver.extract(input)).resolves.toEqual({
      ok: true,
      meta: { driver: 'fake', promptFingerprint: fingerprint, rawText: '{"fields":{"pets":{"op":"write","value":"yes"}}}' },
      result: { fields: { pets: { op: 'write', value: 'yes' } } },
    });
  });

  it('merges a marker with no fields over EMPTY_EXTRACTION', async () => {
    const driver = createExtractionDriver({ driver: 'fake', model });
    const input: ExtractionInput = {
      profile: { contactType: 'tenant', phones: [] },
      transcript: [
        {
          tsMsgId: '2026-07-16T10:00:00.000Z#s1',
          speaker: 'client',
          text: 'EXTRACT:{"noteLines":["stairs are fine"]}',
          at: '2026-07-16T10:00:00.000Z',
          channel: 'sms',
        },
      ],
    };
    await expect(driver.extract(input)).resolves.toEqual({
      ok: true,
      meta: { driver: 'fake', promptFingerprint: fingerprint, rawText: '{"noteLines":["stairs are fine"]}' },
      result: { fields: {}, noteLines: ['stairs are fine'] },
    });
  });

  it('returns EMPTY_EXTRACTION on malformed marker JSON (never throws)', async () => {
    const driver = createExtractionDriver({ driver: 'fake', model });
    const input: ExtractionInput = {
      profile: { contactType: 'tenant', phones: [] },
      transcript: [
        { tsMsgId: '2026-07-16T10:00:00.000Z#s1', speaker: 'client', text: 'EXTRACT:{not valid json', at: '2026-07-16T10:00:00.000Z', channel: 'sms' },
      ],
    };
    await expect(driver.extract(input)).resolves.toEqual({
      ok: true,
      meta: { driver: 'fake', promptFingerprint: fingerprint, rawText: '{not valid json' },
      result: EMPTY_EXTRACTION,
    });
  });

  it('returns EMPTY_EXTRACTION when no client utterance carries a marker', async () => {
    const driver = createExtractionDriver({ driver: 'fake', model });
    const input: ExtractionInput = {
      profile: { contactType: 'tenant', phones: [] },
      transcript: [
        { tsMsgId: '2026-07-16T10:00:00.000Z#s1', speaker: 'client', text: 'just chatting, no marker', at: '2026-07-16T10:00:00.000Z', channel: 'sms' },
      ],
    };
    await expect(driver.extract(input)).resolves.toEqual({
      ok: true,
      meta: { driver: 'fake', promptFingerprint: fingerprint },
      result: EMPTY_EXTRACTION,
    });
  });

  it('emits rawText that is REAL JSON - the marker payload, never the marker line', async () => {
    const call = await createExtractionDriver({ driver: 'fake', model }).extract(markerInput);
    expect(call.meta.rawText).toBe('{"fields":{"pets":{"op":"none","value":"","reason":""}}}');
    expect(call.meta.rawText).not.toContain('EXTRACT:');
  });

  it("the fake driver's rawText parses through parseExtractionOps - the e2e's whole mechanism", async () => {
    const call = await createExtractionDriver({ driver: 'fake', model }).extract(markerInput);
    expect(call.meta.rawText).toBeDefined();
    expect(parseExtractionOps(call.meta.rawText).pets).toEqual({ op: 'none' });
  });

  it('a malformed marker keeps rawText so the run log shows what the driver was handed', async () => {
    const call = await createExtractionDriver({ driver: 'fake', model }).extract({
      profile: { contactType: 'tenant', phones: [] },
      transcript: [{
        tsMsgId: '2026-07-16T10:00:00.000Z#s1',
        speaker: 'client', text: 'EXTRACT:{oops', at: '2026-07-16T10:00:00.000Z', channel: 'sms',
      }],
    });
    expect(call.ok).toBe(true);
    expect(call.meta.rawText).toBe('{oops');
  });

  it('stamps promptFingerprint on every exit, matching the real prompt fingerprint', async () => {
    const driver = createExtractionDriver({ driver: 'fake', model });
    const [parsed, noMarker] = await Promise.all([
      driver.extract(markerInput),
      driver.extract(baseInput),
    ]);
    expect(parsed.meta.promptFingerprint).toBe(extractionPromptFingerprint());
    expect(noMarker.meta.promptFingerprint).toBe(extractionPromptFingerprint());
  });

  // F7c: without these arms the fake could not produce ok:false, so outcome
  // 'failed', the error block, burned attempts and parking had ZERO hermetic
  // coverage. `__fail` is dev-only (EXTRACTION_DRIVER=fake is refused in
  // production, config.ts:811-814).
  const failMarker = (payload: Record<string, unknown>): ExtractionInput => ({
    profile: { contactType: 'tenant', phones: [] },
    transcript: [{
      tsMsgId: '2026-07-16T10:00:00.000Z#s1',
      speaker: 'client',
      text: `EXTRACT:${JSON.stringify(payload)}`,
      at: '2026-07-16T10:00:00.000Z',
      channel: 'sms',
    }],
  });

  it('drives a parse failure and keeps rawText, like the real parse arm', async () => {
    const call = await createExtractionDriver({ driver: 'fake', model })
      .extract(failMarker({ __fail: 'parse' }));
    expect(call.ok).toBe(false);
    if (call.ok) throw new Error('expected a failure');
    expect(call.failure).toBe('parse');
    expect(call.message).toContain('simulated parse failure');
    // adapters/extraction.ts:255-260 stamps rawText BEFORE the parse, so a
    // malformed response still carries the text that explains it.
    expect(call.meta.rawText).toBe('{"__fail":"parse"}');
    expect(call.meta.promptFingerprint).toBe(extractionPromptFingerprint());
  });

  it('drives a driver failure with no rawText and an overridable message', async () => {
    const call = await createExtractionDriver({ driver: 'fake', model })
      .extract(failMarker({ __fail: 'driver', __failMessage: 'connect ECONNREFUSED' }));
    expect(call.ok).toBe(false);
    if (call.ok) throw new Error('expected a failure');
    expect(call.failure).toBe('driver');
    expect(call.message).toBe('connect ECONNREFUSED');
    // The real driver's SDK-throw arm returns before any response text exists
    // (adapters/extraction.ts:203-205).
    expect(call.meta.rawText).toBeUndefined();
    expect(call.meta.promptFingerprint).toBe(extractionPromptFingerprint());
  });

  it('drives a refusal with no rawText, like the real stop_reason arm', async () => {
    const call = await createExtractionDriver({ driver: 'fake', model })
      .extract(failMarker({ __fail: 'refusal' }));
    expect(call.ok).toBe(false);
    if (call.ok) throw new Error('expected a failure');
    expect(call.failure).toBe('refusal');
    expect(call.message).toContain('simulated refusal');
    expect(call.meta.rawText).toBeUndefined();
  });

  it('drives a truncation that KEEPS rawText, like the real max_tokens arm', async () => {
    const call = await createExtractionDriver({ driver: 'fake', model })
      .extract(failMarker({ __fail: 'truncated' }));
    expect(call.ok).toBe(false);
    if (call.ok) throw new Error('expected a failure');
    expect(call.failure).toBe('truncated');
    expect(call.message).toContain('simulated max_tokens truncation');
    // The real arm stamps the partial response text before returning, because on
    // a mid-object cut that text is the whole evidence.
    expect(call.meta.rawText).toBeDefined();
  });

  it('ignores an unknown __fail value and extracts the payload normally', async () => {
    const call = await createExtractionDriver({ driver: 'fake', model })
      .extract(failMarker({ __fail: 'kaboom', fields: { pets: { op: 'write', value: 'cat' } } }));
    expect(call.ok).toBe(true);
    if (!call.ok) throw new Error('expected success');
    expect(call.result.fields?.pets).toEqual({ op: 'write', value: 'cat' });
  });
});

describe('anthropic driver - malformed SDK responses (F9)', () => {
  // extract()'s ONLY caller (jobs/extraction.ts) does not wrap it, so a throw
  // unwinds to the job's per-row backstop and is mislabeled errorKind 'repo'.
  // The discriminated return exists precisely so the caller learns WHICH STAGE
  // failed - and so a thrown error never carries rawText (contact PII on the one
  // object type this codebase's loggers serialize wholesale).
  const anthropic = () => createExtractionDriver({ driver: 'anthropic', model, apiKey: 'sk-test' });

  it('reports a response with no usage as a driver failure instead of throwing', async () => {
    sdk.reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"fields":{}}' }] };
    const call = await anthropic().extract(baseInput);
    expect(call.ok).toBe(false);
    expect(call.ok === false && call.failure).toBe('driver');
    expect(call.meta.driver).toBe('anthropic');
  });

  it('reports a response with no content array as a driver failure instead of throwing', async () => {
    sdk.reply = { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 4 } };
    const call = await anthropic().extract(baseInput);
    expect(call.ok).toBe(false);
    expect(call.ok === false && call.failure).toBe('driver');
    expect(call.meta.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it('keeps a well-formed response on the normal path', async () => {
    sdk.reply = {
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 5 },
      content: [{ type: 'text', text: '{"fields":{"pets":{"op":"none","value":"","reason":""}}}' }],
    };
    const call = await anthropic().extract(baseInput);
    expect(call.ok).toBe(true);
    expect(call.meta.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(call.meta.rawText).toBe('{"fields":{"pets":{"op":"none","value":"","reason":""}}}');
  });

  it('a refusal WITHOUT usage counts is a refusal, not a driver fault', async () => {
    // A pre-output classifier decline is a 200 with stop_reason 'refusal', an
    // EMPTY content array, and no billing - so no usage counts. The run log
    // must say the model declined, not that the transport broke.
    sdk.reply = { stop_reason: 'refusal', content: [] };
    const call = await anthropic().extract(baseInput);
    expect(call.ok).toBe(false);
    expect(call.ok === false && call.failure).toBe('refusal');
    expect(call.meta.usage).toBeUndefined();
  });

  it('a refusal WITH usage counts keeps its counts (billed mid-generation decline)', async () => {
    sdk.reply = { stop_reason: 'refusal', usage: { input_tokens: 7, output_tokens: 0 } };
    const call = await anthropic().extract(baseInput);
    expect(call.ok).toBe(false);
    expect(call.ok === false && call.failure).toBe('refusal');
    expect(call.meta.usage).toEqual({ inputTokens: 7, outputTokens: 0 });
  });

  it('pins thinking OFF explicitly, so the output cap means the same thing on every model', async () => {
    // THE REGRESSION GUARD for the sonnet-5 outage. Omitting `thinking` does not
    // mean one thing: on claude-opus-4-8 an absent parameter runs with thinking
    // off, on claude-sonnet-5 the same absent parameter runs ADAPTIVE thinking.
    // max_tokens caps thinking and response text TOGETHER, so swapping
    // AI_EXTRACTION_MODEL silently handed the JSON budget to reasoning tokens
    // and truncated every large run. Asserting the parameter is PRESENT is the
    // point - an assertion on behavior alone would pass again on the next model
    // whose default flips.
    sdk.reply = {
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 5 },
      content: [{ type: 'text', text: '{"fields":{}}' }],
    };
    await anthropic().extract(baseInput);
    expect(sdk.lastRequest?.['thinking']).toEqual({ type: 'disabled' });
    expect(sdk.lastRequest?.['max_tokens']).toBe(4096);
  });

  it('reports a max_tokens stop as a TRUNCATION, keeping the partial JSON as evidence', async () => {
    // The cap was spent mid-object. Without this arm the truncated text reaches
    // JSON.parse and the run is filed as errorKind 'parse' - a malformed-model
    // story for what is actually an under-budgeted request.
    const partial = '{"fields":{"pets":{"op":"write","value":"two cats","reas';
    sdk.reply = {
      stop_reason: 'max_tokens',
      usage: { input_tokens: 4977, output_tokens: 4096 },
      content: [{ type: 'text', text: partial }],
    };
    const call = await anthropic().extract(baseInput);
    expect(call.ok).toBe(false);
    expect(call.ok === false && call.failure).toBe('truncated');
    expect(call.ok === false && call.message).toContain('4096');
    expect(call.meta.rawText).toBe(partial);
    expect(call.meta.usage).toEqual({ inputTokens: 4977, outputTokens: 4096 });
  });

  it('a max_tokens stop with NO text block is a truncation, not a "no text block" driver fault', async () => {
    // The other shape of the same fault: the budget was gone before any JSON was
    // emitted, so content carries no text block at all. That used to fall
    // through to the driver arm and read as a broken response.
    sdk.reply = {
      stop_reason: 'max_tokens',
      usage: { input_tokens: 4977, output_tokens: 4096 },
      content: [],
    };
    const call = await anthropic().extract(baseInput);
    expect(call.ok).toBe(false);
    expect(call.ok === false && call.failure).toBe('truncated');
    expect(call.meta.rawText).toBeUndefined();
  });

  it('rawText SURVIVES a parse failure - the one case where the text is the whole answer', async () => {
    sdk.reply = {
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 5 },
      content: [{ type: 'text', text: 'not json at all' }],
    };
    const call = await anthropic().extract(baseInput);
    expect(call.ok).toBe(false);
    expect(call.ok === false && call.failure).toBe('parse');
    expect(call.meta.rawText).toBe('not json at all');
  });
});

describe('ExtractionRefusedError', () => {
  it('is an Error subclass', () => {
    expect(new ExtractionRefusedError('refused')).toBeInstanceOf(Error);
  });
});
