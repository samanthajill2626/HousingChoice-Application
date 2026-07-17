// Apply service (write policy) - the heart of conversation-fact-extraction (T5).
//
// In-memory stubs for every dep (no DynamoDB). Each behavior in plan Task 5
// items 1-11 is pinned by at least one test.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ExtractionResult } from '../src/adapters/extraction.js';
import { createLogger, type Logger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import { applyExtraction, type ApplyDeps } from '../src/services/extraction/apply.js';

const NOW = '2026-07-16T12:00:00.000Z';
const CONV = 'conv-1';

function makeContact(overrides: Partial<ContactItem> = {}): ContactItem {
  return { contactId: 'c1', type: 'tenant', ...overrides };
}

interface StubRecords {
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  suggestions: unknown[];
  audits: Array<{ entityKey: string; type: string; payload?: Record<string, unknown> }>;
  emits: Array<{ name: string; payload: unknown }>;
}

function makeDeps(opts: {
  findByPhone?: (phone: string) => Promise<ContactItem | undefined>;
  putSuggestionImpl?: (s: unknown) => Promise<unknown>;
  updateImpl?: (id: string, patch: Record<string, unknown>) => Promise<ContactItem>;
} = {}): { deps: ApplyDeps; records: StubRecords; logger: Logger } {
  const records: StubRecords = { updates: [], suggestions: [], audits: [], emits: [] };
  const logger = createLogger({ destination: createLogCapture().stream, level: 'debug' });

  const contacts: ApplyDeps['contacts'] = {
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      if (opts.updateImpl) return opts.updateImpl(id, patch);
      records.updates.push({ id, patch });
      return { contactId: id, type: 'tenant', ...patch } as ContactItem;
    }),
    addPhone: vi.fn(async (id: string) => ({ contactId: id, type: 'tenant' }) as ContactItem),
    findByPhone: vi.fn(async (phone: string) =>
      opts.findByPhone ? opts.findByPhone(phone) : undefined,
    ),
  };

  const extraction: ApplyDeps['extraction'] = {
    putSuggestion: vi.fn(async (s: unknown) => {
      if (opts.putSuggestionImpl) return opts.putSuggestionImpl(s);
      records.suggestions.push(s);
      return s as never;
    }),
    deleteSuggestion: vi.fn(async () => {}),
  };

  const audit: ApplyDeps['audit'] = {
    append: vi.fn(async (entityKey: string, type: string, payload?: Record<string, unknown>) => {
      records.audits.push({ entityKey, type, payload });
    }),
  };

  const events: ApplyDeps['events'] = {
    emit: vi.fn((name: string, payload: unknown) => {
      records.emits.push({ name, payload });
    }),
  };

  const deps: ApplyDeps = { contacts, extraction, audit, events, logger, now: () => NOW };
  return { deps, records, logger };
}

function run(deps: ApplyDeps, contact: ContactItem, result: ExtractionResult, cursorTsMsgId = 'ts-9') {
  return applyExtraction(deps, { contact, conversationId: CONV, cursorTsMsgId, result });
}

describe('applyExtraction - field writes (items 1-3)', () => {
  it('writes an empty field and stamps <field>_source with ai provenance', async () => {
    const { deps, records } = makeDeps();
    const contact = makeContact({ type: 'tenant' }); // no pets yet
    const outcome = await run(deps, contact, {
      fields: { pets: { op: 'write', value: 'has a dog', reason: 'said has a dog' } },
    });

    expect(outcome.wrote).toEqual(['pets']);
    expect(records.updates).toHaveLength(1);
    const patch = records.updates[0]!.patch;
    expect(patch['pets']).toBe('has a dog');
    expect(patch['pets_source']).toEqual({ source: 'ai', at: NOW, conversationId: CONV, tsMsgId: 'ts-9' });
  });

  it('permits an occupied-field write and audits from/to per field', async () => {
    const { deps, records } = makeDeps();
    const contact = makeContact({ type: 'tenant', pets: 'cat' });
    const outcome = await run(deps, contact, {
      fields: { pets: { op: 'write', value: 'one cat', reason: 'clarified spelling' } },
    });

    expect(outcome.wrote).toEqual(['pets']);
    expect(records.updates[0]!.patch['pets']).toBe('one cat');
    const applied = records.audits.find((a) => a.type === 'ai_extraction_applied');
    expect(applied).toBeDefined();
    expect(applied!.entityKey).toBe('contacts#c1');
    expect(applied!.payload).toMatchObject({ conversationId: CONV });
    expect(applied!.payload!['fields']).toEqual([
      { field: 'pets', from: 'cat', to: 'one cat', reason: 'clarified spelling' },
    ]);
  });

  it('op:none does nothing', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact(), { fields: { pets: { op: 'none' } } });
    expect(outcome).toEqual({ wrote: [], suggested: [], notedLines: 0 });
    expect(records.updates).toHaveLength(0);
    expect(records.emits).toHaveLength(0);
  });

  it('combines multiple written fields into ONE update patch', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {
        firstName: { op: 'write', value: 'Dana' },
        voucherSize: { op: 'write', value: '2' },
      },
    });
    expect(outcome.wrote.sort()).toEqual(['firstName', 'voucherSize']);
    expect(records.updates).toHaveLength(1);
    expect(records.updates[0]!.patch['firstName']).toBe('Dana');
    expect(records.updates[0]!.patch['voucherSize']).toBe(2);
  });
});

describe('applyExtraction - suggestions on conflict (item 4)', () => {
  it('suggests when the model marks a conflict', async () => {
    const { deps, records } = makeDeps();
    const contact = makeContact({ type: 'tenant', voucherSize: 2 });
    const outcome = await run(deps, contact, {
      fields: { voucherSize: { op: 'suggest', value: '3', reason: 'now needs 3BR' } },
    });
    expect(outcome.suggested).toEqual(['voucherSize']);
    expect(records.updates).toHaveLength(0);
    expect(records.suggestions[0]).toMatchObject({
      ownerContactId: 'c1',
      target: 'voucherSize',
      currentValue: '2',
      suggestedValue: '3',
      reason: 'now needs 3BR',
      conversationId: CONV,
      tsMsgId: 'ts-9',
    });
  });

  it('skips a suggestion whose value string-equals the current value', async () => {
    const { deps, records } = makeDeps();
    const contact = makeContact({ type: 'tenant', voucherSize: 2 });
    const outcome = await run(deps, contact, {
      fields: { voucherSize: { op: 'suggest', value: '2' } },
    });
    expect(outcome.suggested).toEqual([]);
    expect(records.suggestions).toHaveLength(0);
  });
});

describe('applyExtraction - type gating (item 1)', () => {
  it('no-ops ALL field ops for a landlord contact', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'landlord' }), {
      fields: {
        firstName: { op: 'write', value: 'Pat' },
        pets: { op: 'write', value: 'yes' },
        voucherSize: { op: 'suggest', value: '3' },
      },
    });
    expect(outcome).toEqual({ wrote: [], suggested: [], notedLines: 0 });
    expect(records.updates).toHaveLength(0);
    expect(records.suggestions).toHaveLength(0);
    expect(records.emits).toHaveLength(0);
  });

  it('writes names for an unknown contact but ignores tenant-only facts', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'unknown' }), {
      fields: {
        lastName: { op: 'write', value: 'Rivera' },
        pets: { op: 'write', value: 'yes' },
      },
    });
    expect(outcome.wrote).toEqual(['lastName']);
    expect(records.updates[0]!.patch['pets']).toBeUndefined();
  });
});

describe('applyExtraction - coercion/validation (item 2)', () => {
  it("coerces voucherSize '2' to the integer 2", async () => {
    const { deps, records } = makeDeps();
    await run(deps, makeContact({ type: 'tenant' }), {
      fields: { voucherSize: { op: 'write', value: '2' } },
    });
    expect(records.updates[0]!.patch['voucherSize']).toBe(2);
  });

  it("skips voucherSize '15' (out of 0..12 range)", async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { voucherSize: { op: 'write', value: '15' } },
    });
    expect(outcome.wrote).toEqual([]);
    expect(records.updates).toHaveLength(0);
  });

  it("skips voucherSize 'two' (not a digit string)", async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { voucherSize: { op: 'write', value: 'two' } },
    });
    expect(outcome.wrote).toEqual([]);
    expect(records.updates).toHaveLength(0);
  });

  it('skips an off-vocabulary housingAuthority', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { housingAuthority: { op: 'write', value: 'Nowhere PHA' } },
    });
    expect(outcome.wrote).toEqual([]);
    expect(records.updates).toHaveLength(0);
  });

  it('writes an in-vocabulary housingAuthority', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { housingAuthority: { op: 'write', value: 'Fulton County' } },
    });
    expect(outcome.wrote).toEqual(['housingAuthority']);
    expect(records.updates[0]!.patch['housingAuthority']).toBe('Fulton County');
  });

  it("coerces porting 'true' to the boolean true", async () => {
    const { deps, records } = makeDeps();
    await run(deps, makeContact({ type: 'tenant' }), {
      fields: { porting: { op: 'write', value: 'true' } },
    });
    expect(records.updates[0]!.patch['porting']).toBe(true);
  });

  it('skips a name longer than 120 chars', async () => {
    const { deps } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { firstName: { op: 'write', value: 'x'.repeat(121) } },
    });
    expect(outcome.wrote).toEqual([]);
  });
});

describe('applyExtraction - statusAdvance (item 5)', () => {
  it('suggests searching only when tenant is in onboarding', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant', status: 'onboarding' }), {
      fields: {},
      statusAdvance: { suggest: true, reason: 'voucher in hand' },
    });
    expect(outcome.suggested).toEqual(['status']);
    expect(records.suggestions[0]).toMatchObject({
      target: 'status',
      suggestedValue: 'searching',
      currentValue: 'onboarding',
    });
  });

  it('ignores statusAdvance when the tenant is not in onboarding', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant', status: 'searching' }), {
      fields: {},
      statusAdvance: { suggest: true },
    });
    expect(outcome.suggested).toEqual([]);
    expect(records.suggestions).toHaveLength(0);
  });

  it('ignores statusAdvance for a non-tenant', async () => {
    const { deps } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'unknown', status: 'onboarding' }), {
      fields: {},
      statusAdvance: { suggest: true },
    });
    expect(outcome.suggested).toEqual([]);
  });
});

describe('applyExtraction - typeSuggestion (item 6)', () => {
  it('suggests a type only for an unknown contact', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'unknown' }), {
      fields: {},
      typeSuggestion: { value: 'tenant', reason: 'looking for a home' },
    });
    expect(outcome.suggested).toEqual(['type']);
    expect(records.suggestions[0]).toMatchObject({
      target: 'type',
      suggestedValue: 'tenant',
      currentValue: 'unknown',
    });
  });

  it('ignores typeSuggestion for a non-unknown contact', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {},
      typeSuggestion: { value: 'landlord' },
    });
    expect(outcome.suggested).toEqual([]);
    expect(records.suggestions).toHaveLength(0);
  });
});

describe('applyExtraction - phoneAddition (item 7)', () => {
  it('skips a number already owned by the contact', async () => {
    const { deps, records } = makeDeps();
    const contact = makeContact({ type: 'tenant', phone: '+15550101234' });
    const outcome = await run(deps, contact, {
      fields: {},
      phoneAddition: { phone: '(555) 010-1234' },
    });
    expect(outcome.suggested).toEqual([]);
    expect(records.suggestions).toHaveLength(0);
  });

  it('notes (does not suggest) a number owned by a different contact', async () => {
    const { deps, records } = makeDeps({
      findByPhone: async () => makeContact({ contactId: 'other', type: 'tenant' }),
    });
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {},
      phoneAddition: { phone: '555-010-9999' },
    });
    expect(outcome.suggested).toEqual([]);
    expect(outcome.notedLines).toBe(1);
    const noteUpdate = records.updates.find((u) => typeof u.patch['notes'] === 'string');
    expect(noteUpdate!.patch['notes']).toContain('belongs to another contact');
    expect(noteUpdate!.patch['notes']).toContain('+15550109999');
  });

  it('suggests a novel number not owned by anyone', async () => {
    const { deps, records } = makeDeps({ findByPhone: async () => undefined });
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {},
      phoneAddition: { phone: '555-010-7777', label: 'work' },
    });
    expect(outcome.suggested).toEqual(['phone']);
    expect(records.suggestions[0]).toMatchObject({
      target: 'phone',
      suggestedValue: '+15550107777',
    });
  });

  it('skips an un-normalizable phone number', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {},
      phoneAddition: { phone: 'not-a-number' },
    });
    expect(outcome.suggested).toEqual([]);
    expect(records.suggestions).toHaveLength(0);
    expect(outcome.notedLines).toBe(0);
  });
});

describe('applyExtraction - noteLines (item 8)', () => {
  it('caps at 5 lines and prefixes each with [Auto - <MMM D>]', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {},
      noteLines: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    });
    expect(outcome.notedLines).toBe(5);
    const notes = records.updates[0]!.patch['notes'] as string;
    const lines = notes.split('\n');
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(line.startsWith('[Auto - Jul 16] ')).toBe(true);
  });

  it('filters empty note lines', async () => {
    const { deps } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {},
      noteLines: ['  ', '', 'real fact'],
    });
    expect(outcome.notedLines).toBe(1);
  });

  it('appends to existing notes with a newline join, preserving existing text', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant', notes: 'existing note' }), {
      fields: {},
      noteLines: ['new fact'],
    });
    expect(outcome.notedLines).toBe(1);
    expect(records.updates[0]!.patch['notes']).toBe('existing note\n[Auto - Jul 16] new fact');
  });
});

describe('applyExtraction - emit + best-effort isolation (items 9-10)', () => {
  it('emits suggestion.updated exactly once across several mutations', async () => {
    const { deps, records } = makeDeps();
    await run(deps, makeContact({ type: 'tenant', status: 'onboarding' }), {
      fields: { pets: { op: 'write', value: 'dog' } },
      statusAdvance: { suggest: true },
      noteLines: ['likes the neighborhood'],
    });
    const emits = records.emits.filter((e) => e.name === 'suggestion.updated');
    expect(emits).toHaveLength(1);
    expect(emits[0]!.payload).toEqual({ contactId: 'c1' });
  });

  it('does not emit when nothing changed', async () => {
    const { deps, records } = makeDeps();
    await run(deps, makeContact({ type: 'tenant' }), { fields: { pets: { op: 'none' } } });
    expect(records.emits).toHaveLength(0);
  });

  it('a putSuggestion failure does not abort field writes; outcome reflects only successes', async () => {
    const { deps, records } = makeDeps({
      putSuggestionImpl: async () => {
        throw new Error('dynamo down');
      },
    });
    const outcome = await run(deps, makeContact({ type: 'tenant', voucherSize: 2 }), {
      fields: {
        pets: { op: 'write', value: 'dog' },
        voucherSize: { op: 'suggest', value: '3' },
      },
    });
    expect(outcome.wrote).toEqual(['pets']);
    expect(outcome.suggested).toEqual([]); // the throwing suggest is not counted
    expect(records.updates.some((u) => u.patch['pets'] === 'dog')).toBe(true);
  });
});
