// T3: extraction driver seam (factory + console + fake). The Anthropic driver's
// network path is deliberately NOT exercised here (request-shaping is covered by
// the schema/prompt tests in extractionSchema.test.ts).
import { describe, expect, it } from 'vitest';
import {
  createExtractionDriver,
  EMPTY_EXTRACTION,
  ExtractionRefusedError,
  type ExtractionInput,
} from '../src/adapters/extraction.js';

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

  it.skip("the fake driver's rawText parses through parseExtractionOps - the e2e's whole mechanism", async () => {
    // TODO(ai-run-log): unskip in Slice 7 (Task 15 Step 5) - parseExtractionOps
    // does not exist yet. Skipping is deliberate and time-boxed; omitting the
    // assertion is how the mechanism goes unverified. If the marker prefix ever
    // leaked into rawText, parseExtractionOps would return the empty view and
    // EVERY e2e decision would silently record not_addressed.
    const call = await createExtractionDriver({ driver: 'fake', model }).extract(markerInput);
    expect(call.meta.rawText).toBeDefined();
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

describe('ExtractionRefusedError', () => {
  it('is an Error subclass', () => {
    expect(new ExtractionRefusedError('refused')).toBeInstanceOf(Error);
  });
});
