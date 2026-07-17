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
  transcript: [{ speaker: 'client', text: 'hi', at: '2026-07-16T10:00:00.000Z', channel: 'sms' }],
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
    await expect(driver.extract(baseInput)).resolves.toEqual(EMPTY_EXTRACTION);
  });
});

describe('fake driver', () => {
  it('parses the EXTRACT marker from the NEWEST client utterance, ignoring staff and older markers', async () => {
    const driver = createExtractionDriver({ driver: 'fake', model });
    const input: ExtractionInput = {
      profile: { contactType: 'tenant', phones: [] },
      transcript: [
        {
          speaker: 'client',
          text: 'EXTRACT:{"fields":{"pets":{"op":"write","value":"old"}}}',
          at: '2026-07-16T10:00:00.000Z',
          channel: 'sms',
        },
        {
          speaker: 'staff',
          text: 'EXTRACT:{"fields":{"pets":{"op":"write","value":"STAFF"}}}',
          at: '2026-07-16T10:01:00.000Z',
          channel: 'sms',
        },
        {
          speaker: 'client',
          text: 'sure\nEXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}',
          at: '2026-07-16T10:02:00.000Z',
          channel: 'sms',
        },
      ],
    };
    await expect(driver.extract(input)).resolves.toEqual({ fields: { pets: { op: 'write', value: 'yes' } } });
  });

  it('merges a marker with no fields over EMPTY_EXTRACTION', async () => {
    const driver = createExtractionDriver({ driver: 'fake', model });
    const input: ExtractionInput = {
      profile: { contactType: 'tenant', phones: [] },
      transcript: [
        {
          speaker: 'client',
          text: 'EXTRACT:{"noteLines":["stairs are fine"]}',
          at: '2026-07-16T10:00:00.000Z',
          channel: 'sms',
        },
      ],
    };
    await expect(driver.extract(input)).resolves.toEqual({ fields: {}, noteLines: ['stairs are fine'] });
  });

  it('returns EMPTY_EXTRACTION on malformed marker JSON (never throws)', async () => {
    const driver = createExtractionDriver({ driver: 'fake', model });
    const input: ExtractionInput = {
      profile: { contactType: 'tenant', phones: [] },
      transcript: [
        { speaker: 'client', text: 'EXTRACT:{not valid json', at: '2026-07-16T10:00:00.000Z', channel: 'sms' },
      ],
    };
    await expect(driver.extract(input)).resolves.toEqual(EMPTY_EXTRACTION);
  });

  it('returns EMPTY_EXTRACTION when no client utterance carries a marker', async () => {
    const driver = createExtractionDriver({ driver: 'fake', model });
    const input: ExtractionInput = {
      profile: { contactType: 'tenant', phones: [] },
      transcript: [
        { speaker: 'client', text: 'just chatting, no marker', at: '2026-07-16T10:00:00.000Z', channel: 'sms' },
      ],
    };
    await expect(driver.extract(input)).resolves.toEqual(EMPTY_EXTRACTION);
  });
});

describe('ExtractionRefusedError', () => {
  it('is an Error subclass', () => {
    expect(new ExtractionRefusedError('refused')).toBeInstanceOf(Error);
  });
});
