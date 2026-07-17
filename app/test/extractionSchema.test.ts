// T4: JSON output schema + prompt builder for conversation fact extraction.
import { describe, expect, it } from 'vitest';
import {
  EXTRACTION_SCHEMA,
  HOUSING_AUTHORITY_VOCAB,
  parseExtractionText,
} from '../src/services/extraction/schema.js';
import {
  buildExtractionSystemPrompt,
  buildExtractionUserContent,
} from '../src/services/extraction/prompt.js';
import type { ExtractionInput } from '../src/adapters/extraction.js';

// The structured-outputs contract: every object level carries
// additionalProperties:false and NONE of the unsupported constraint keywords
// (minimum/maximum/minLength) appear anywhere - we clamp in code instead.
function walkSchema(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walkSchema(child, `${path}[${i}]`));
    return;
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const banned of ['minimum', 'maximum', 'minLength']) {
      expect(obj[banned], `${path}.${banned} must be absent`).toBeUndefined();
    }
    if (obj.type === 'object') {
      expect(obj.additionalProperties, `${path}.additionalProperties`).toBe(false);
    }
    for (const [key, value] of Object.entries(obj)) walkSchema(value, `${path}.${key}`);
  }
}

describe('EXTRACTION_SCHEMA', () => {
  it('sets additionalProperties:false on every object and uses no unsupported constraint keys', () => {
    walkSchema(EXTRACTION_SCHEMA, 'schema');
  });
});

describe('HOUSING_AUTHORITY_VOCAB', () => {
  it('lists the exact controlled vocabulary (13 entries)', () => {
    expect(HOUSING_AUTHORITY_VOCAB).toEqual([
      'Jonesboro (JHA)',
      'Fulton County',
      'Atlanta (AHA)',
      'Clayton County',
      'College Park',
      'Georgia Housing Voucher (GHV)',
      'Step Up',
      'Claratel',
      'Hope Atlanta',
      'HUD VASH',
      'DCA',
      'McDonough',
      'East Point',
    ]);
  });
});

describe('parseExtractionText', () => {
  it('round-trips a full structurally-valid payload', () => {
    const payload = {
      fields: {
        firstName: { op: 'write', value: 'Maria', reason: 'client gave name' },
        voucherSize: { op: 'suggest', value: '3', reason: 'said 3 bedrooms' },
        pets: { op: 'none' },
      },
      statusAdvance: { suggest: true, reason: 'voucher in hand' },
      typeSuggestion: { value: 'tenant', reason: 'seeking a home' },
      phoneAddition: { phone: '+14045551234', label: 'cell', reason: 'her other number' },
      noteLines: ['Has a stairs concern'],
    };
    expect(parseExtractionText(JSON.stringify(payload))).toEqual(payload);
  });

  it('clamps 7 noteLines to 5 and truncates long strings to 200 chars', () => {
    const long = 'x'.repeat(250);
    const seven = Array.from({ length: 7 }, (_unused, i) => `note ${i} ${long}`);
    const parsed = parseExtractionText(
      JSON.stringify({
        fields: { pets: { op: 'write', value: 'yes', reason: long } },
        noteLines: seven,
      }),
    );
    expect(parsed.noteLines).toHaveLength(5);
    for (const line of parsed.noteLines ?? []) expect(line.length).toBeLessThanOrEqual(200);
    expect(parsed.fields.pets?.reason?.length).toBeLessThanOrEqual(200);
  });

  it('drops unknown field keys and defaults missing fields to {}', () => {
    const parsed = parseExtractionText(
      JSON.stringify({
        fields: { bogusField: { op: 'write', value: 'x' }, pets: { op: 'write', value: 'yes' } },
      }),
    );
    expect(parsed.fields.pets).toEqual({ op: 'write', value: 'yes' });
    expect((parsed.fields as Record<string, unknown>).bogusField).toBeUndefined();

    expect(parseExtractionText(JSON.stringify({ noteLines: ['hi'] })).fields).toEqual({});
  });

  it('ignores field ops with an invalid op enum', () => {
    const parsed = parseExtractionText(
      JSON.stringify({ fields: { pets: { op: 'delete', value: 'x' } } }),
    );
    expect(parsed.fields.pets).toBeUndefined();
  });

  it('throws SyntaxError on unparseable text', () => {
    expect(() => parseExtractionText('not json{')).toThrow(SyntaxError);
  });
});

describe('prompt builders', () => {
  it('system prompt lists every housing-authority vocabulary value', () => {
    const sys = buildExtractionSystemPrompt();
    for (const value of HOUSING_AUTHORITY_VOCAB) expect(sys).toContain(value);
  });

  it('user content carries the profile JSON then a chronological transcript', () => {
    const input: ExtractionInput = {
      profile: { contactType: 'tenant', firstName: 'Ann', voucherSize: 2, phones: ['+14045550000'] },
      transcript: [
        { speaker: 'client', text: 'Hi there', at: '2026-07-16T10:01:00.000Z', channel: 'sms' },
        { speaker: 'staff', text: 'Hello', at: '2026-07-16T10:00:00.000Z', channel: 'sms' },
      ],
    };
    const user = buildExtractionUserContent(input);
    expect(user).toContain('CURRENT PROFILE');
    expect(user).toContain('"contactType": "tenant"');
    expect(user).toContain('TRANSCRIPT');
    expect(user).toContain('[staff] Hello');
    expect(user).toContain('[client] Hi there');
    // Chronological order by timestamp regardless of input order.
    expect(user.indexOf('[staff] Hello')).toBeLessThan(user.indexOf('[client] Hi there'));
  });
});
