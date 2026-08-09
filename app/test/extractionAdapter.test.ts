// T3: extraction driver seam (factory + console + fake). The Anthropic driver's
// network path is deliberately NOT exercised here (request-shaping is covered by
// the schema/prompt tests in extractionSchema.test.ts) - EXCEPT for the
// malformed-response guards (F9), where the SDK is stubbed to return a shape the
// driver's types promise but a runtime response might not carry.
import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ reply: {} as unknown }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class StubAnthropic {
    readonly messages = { create: async (): Promise<unknown> => sdk.reply };
  },
}));

const {
  createExtractionDriver,
  EMPTY_EXTRACTION,
  ExtractionRefusedError,
} = await import('../src/adapters/extraction.js');
import type { ExtractionInput } from '../src/adapters/extraction.js';
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
      meta: { driver: 'fake', rawText: '{"fields":{"pets":{"op":"write","value":"yes"}}}' },
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
      meta: { driver: 'fake', rawText: '{"noteLines":["stairs are fine"]}' },
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
      ok: true, meta: { driver: 'fake', rawText: '{not valid json' }, result: EMPTY_EXTRACTION,
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
      ok: true, meta: { driver: 'fake' }, result: EMPTY_EXTRACTION,
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
