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
  /** Tombstoned values as `target#normValue` pairs (hasDismissal stub). */
  dismissedValues?: string[];
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
    putSuggestion: vi.fn(async (s: Parameters<ApplyDeps['extraction']['putSuggestion']>[0]) => {
      if (opts.putSuggestionImpl) return (await opts.putSuggestionImpl(s)) as never;
      records.suggestions.push(s);
      return s as never;
    }),
    deleteSuggestion: vi.fn(async () => {}),
    hasDismissal: vi.fn(async (_contactId: string, target: string, normValue: string) =>
      (opts.dismissedValues ?? []).includes(`${target}#${normValue}`),
    ),
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

  it('is idempotent on a complete()-failure retry: the same result applied twice appends nothing the second time', async () => {
    // Run 1 appends the note. A complete() failure re-arms the SAME due row; the
    // retry re-fetches a contact now carrying run 1's line and re-extracts the
    // identical transcript. The guard must drop the already-present line so the
    // second run writes no notes (notedLines 0) - no double-append (F1).
    const { deps, records } = makeDeps();
    const result: ExtractionResult = { fields: {}, noteLines: ['stairs are a problem'] };

    const first = await run(deps, makeContact({ type: 'tenant', notes: 'seed note' }), result);
    expect(first.notedLines).toBe(1);
    const afterFirst = records.updates[0]!.patch['notes'] as string;
    expect(afterFirst).toBe('seed note\n[Auto - Jul 16] stairs are a problem');

    // Retry state: the contact snapshot now carries run 1's appended line.
    const second = await run(deps, makeContact({ type: 'tenant', notes: afterFirst }), result);
    expect(second.notedLines).toBe(0);
    // No second notes write landed, and nothing was emitted (nothing changed).
    expect(records.updates).toHaveLength(1);
    const line = 'stairs are a problem';
    const occurrences = afterFirst.split(line).length - 1;
    expect(occurrences).toBe(1);
    expect(records.emits.filter((e) => e.name === 'suggestion.updated')).toHaveLength(1);
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

describe('applyExtraction - inferred-role demotion (spec Layer 3)', () => {
  const ROLES = { 'Speaker 1': 'client', 'Speaker 2': 'staff' } as const;

  it('demotes a write on an EMPTY field to a suggestion and audits the demotion', async () => {
    const { deps, records } = makeDeps();
    const contact = makeContact({ type: 'tenant' }); // no pets yet
    const outcome = await applyExtraction(deps, {
      contact,
      conversationId: CONV,
      cursorTsMsgId: 'ts-9',
      result: {
        fields: { pets: { op: 'write', value: 'has a dog', reason: 'said has a dog' } },
        speakerRoles: { ...ROLES },
      },
      hasInferredRoleContent: true,
    });

    // The write became a suggestion: nothing direct-written, no <field>_source.
    expect(outcome.wrote).toEqual([]);
    expect(outcome.suggested).toEqual(['pets']);
    expect(records.updates).toHaveLength(0);
    expect(records.suggestions[0]).toMatchObject({
      ownerContactId: 'c1',
      target: 'pets',
      suggestedValue: 'has a dog',
      reason: 'said has a dog',
      conversationId: CONV,
      tsMsgId: 'ts-9',
    });

    // The write-audit is NOT emitted (no direct write happened).
    expect(records.audits.find((a) => a.type === 'ai_extraction_applied')).toBeUndefined();
    // A separate demotion audit carries the demoted field names + the role map.
    const demoted = records.audits.find((a) => a.type === 'ai_extraction_demoted');
    expect(demoted).toBeDefined();
    expect(demoted!.entityKey).toBe('contacts#c1');
    expect(demoted!.payload).toEqual({
      fields: ['pets'],
      speakerRoles: { 'Speaker 1': 'client', 'Speaker 2': 'staff' },
      conversationId: CONV,
    });
    // Something changed, so the single event still fires.
    expect(records.emits.filter((e) => e.name === 'suggestion.updated')).toHaveLength(1);
  });

  it('leaves native suggestions and notes appends untouched under the flag (no demotion audit)', async () => {
    const { deps, records } = makeDeps();
    const contact = makeContact({ type: 'tenant', voucherSize: 2 });
    const outcome = await applyExtraction(deps, {
      contact,
      conversationId: CONV,
      cursorTsMsgId: 'ts-9',
      result: {
        fields: { voucherSize: { op: 'suggest', value: '3', reason: 'now needs 3BR' } },
        noteLines: ['likes the neighborhood'],
      },
      hasInferredRoleContent: true,
    });

    // Native suggest behaves exactly as without the flag.
    expect(outcome.suggested).toEqual(['voucherSize']);
    expect(records.suggestions[0]).toMatchObject({
      target: 'voucherSize',
      currentValue: '2',
      suggestedValue: '3',
    });
    // Notes are additive - the append still lands directly.
    expect(outcome.notedLines).toBe(1);
    const noteUpdate = records.updates.find((u) => typeof u.patch['notes'] === 'string');
    expect(noteUpdate!.patch['notes']).toContain('[Auto - Jul 16] likes the neighborhood');
    // No write op was present, so no demotion audit fires.
    expect(records.audits.find((a) => a.type === 'ai_extraction_demoted')).toBeUndefined();
  });

  it('with the flag explicitly false, a write on an empty field lands directly (parity)', async () => {
    const { deps, records } = makeDeps();
    const outcome = await applyExtraction(deps, {
      contact: makeContact({ type: 'tenant' }),
      conversationId: CONV,
      cursorTsMsgId: 'ts-9',
      result: { fields: { pets: { op: 'write', value: 'has a dog' } } },
      hasInferredRoleContent: false,
    });
    expect(outcome.wrote).toEqual(['pets']);
    expect(outcome.suggested).toEqual([]);
    expect(records.updates[0]!.patch['pets']).toBe('has a dog');
    expect(records.updates[0]!.patch['pets_source']).toMatchObject({ source: 'ai', conversationId: CONV });
    expect(records.audits.find((a) => a.type === 'ai_extraction_demoted')).toBeUndefined();
  });

  it('demotion audit omits speakerRoles when the result carries none', async () => {
    const { deps, records } = makeDeps();
    const outcome = await applyExtraction(deps, {
      contact: makeContact({ type: 'tenant' }),
      conversationId: CONV,
      cursorTsMsgId: 'ts-9',
      result: { fields: { pets: { op: 'write', value: 'has a dog' } } }, // no speakerRoles
      hasInferredRoleContent: true,
    });
    expect(outcome.suggested).toEqual(['pets']);
    const demoted = records.audits.find((a) => a.type === 'ai_extraction_demoted');
    expect(demoted!.payload).toEqual({ fields: ['pets'], conversationId: CONV });
    expect(demoted!.payload!['speakerRoles']).toBeUndefined();
  });
});

describe('applyExtraction - address (ninth target)', () => {
  it('writes address into an empty field with provenance + audit', async () => {
    const { deps, records } = makeDeps();
    const contact = makeContact({ type: 'tenant' }); // no address yet
    const outcome = await run(deps, contact, {
      fields: {},
      address: { op: 'write', parts: { line1: '1 Main St', city: 'Atlanta' }, reason: 'stated current address' },
    });

    expect(outcome.wrote).toEqual(['address']);
    expect(records.updates).toHaveLength(1);
    const patch = records.updates[0]!.patch;
    // Stored exactly as the edit-form PATCH stores it: the cleaned parts object.
    expect(patch['address']).toEqual({ line1: '1 Main St', city: 'Atlanta' });
    expect(patch['address_source']).toEqual({ source: 'ai', at: NOW, conversationId: CONV, tsMsgId: 'ts-9' });
    // Audit from/to are FORMATTED strings (never the raw object) - flat shape.
    const applied = records.audits.find((a) => a.type === 'ai_extraction_applied');
    expect(applied!.payload!['fields']).toEqual([
      { field: 'address', from: undefined, to: '1 Main St, Atlanta', reason: 'stated current address' },
    ]);
  });

  it('op write on an occupied address still writes (model-judged equivalent)', async () => {
    const { deps, records } = makeDeps();
    const contact = makeContact({ type: 'tenant', address: { line1: '9 Old Rd', city: 'Macon' } });
    const outcome = await run(deps, contact, {
      fields: {},
      address: { op: 'write', parts: { line1: '1 Main St', city: 'Atlanta' } },
    });

    expect(outcome.wrote).toEqual(['address']);
    expect(records.updates[0]!.patch['address']).toEqual({ line1: '1 Main St', city: 'Atlanta' });
    const applied = records.audits.find((a) => a.type === 'ai_extraction_applied');
    expect(applied!.payload!['fields']).toEqual([
      { field: 'address', from: '9 Old Rd, Macon', to: '1 Main St, Atlanta' },
    ]);
  });

  it('demotes a LOSSY occupied write (drops stored parts) to a suggestion (F1)', async () => {
    const { deps, records } = makeDeps();
    // Stored address has five parts; the model restates only two, so a
    // whole-object SET replace would SILENTLY DROP line2/state/zip.
    const contact = makeContact({
      type: 'tenant',
      address: { line1: '123 Main St', line2: 'Apt 4', city: 'Atlanta', state: 'GA', zip: '30303' },
    });
    const outcome = await run(deps, contact, {
      fields: {},
      address: { op: 'write', parts: { line1: '123 Main St', city: 'Atlanta' }, reason: 'restated address' },
    });

    // No direct write: address never enters an update patch, no provenance stamp.
    expect(outcome.wrote).not.toContain('address');
    const addrUpdate = records.updates.find((u) => 'address' in u.patch || 'address_source' in u.patch);
    expect(addrUpdate).toBeUndefined();
    // Routed to human review as a single address suggestion carrying BOTH the
    // formatted display strings and the cleaned new parts.
    expect(outcome.suggested).toEqual(['address']);
    expect(records.suggestions).toHaveLength(1);
    expect(records.suggestions[0]).toMatchObject({
      ownerContactId: 'c1',
      target: 'address',
      currentValue: '123 Main St, Apt 4, Atlanta, GA, 30303',
      suggestedValue: '123 Main St, Atlanta',
      suggestedAddress: { line1: '123 Main St', city: 'Atlanta' },
      reason: 'restated address',
    });
    // A lossy demotion is NOT the Layer-3 inferred-role demotion: it must NOT
    // join demotedFields, so no ai_extraction_demoted audit fires.
    expect(records.audits.find((a) => a.type === 'ai_extraction_demoted')).toBeUndefined();
  });

  it('still writes an occupied SAME-KEY-SET correction directly (F1: not lossy)', async () => {
    const { deps, records } = makeDeps();
    // Same three keys stored and restated, values corrected: no stored part is
    // dropped, so this stays a direct "same-fact-better-form" write.
    const contact = makeContact({ type: 'tenant', address: { line1: '9 Old Rd', city: 'Macon', state: 'GA' } });
    const outcome = await run(deps, contact, {
      fields: {},
      address: { op: 'write', parts: { line1: '1 Main St', city: 'Atlanta', state: 'GA' } },
    });

    expect(outcome.wrote).toEqual(['address']);
    expect(records.updates[0]!.patch['address']).toEqual({ line1: '1 Main St', city: 'Atlanta', state: 'GA' });
    expect(records.updates[0]!.patch['address_source']).toMatchObject({ source: 'ai', conversationId: CONV });
    expect(records.suggestions).toHaveLength(0);
  });

  it('writes directly over a LEGACY STRING address (folds to line1 only; new parts a superset)', async () => {
    const { deps, records } = makeDeps();
    // Pre-contract dev record: address is a single plain string, which folds to
    // { line1 } ONLY. Structured parts that restate line1 (+ more) are a
    // superset, never lossy -> the legacy upgrade path writes directly.
    const contact = makeContact({ type: 'tenant', address: '123 Main St, Atlanta, GA 30303' });
    const parts = { line1: '123 Main St', city: 'Atlanta', state: 'GA', zip: '30303' };
    const outcome = await run(deps, contact, { fields: {}, address: { op: 'write', parts } });

    expect(outcome.wrote).toEqual(['address']);
    expect(records.updates[0]!.patch['address']).toEqual(parts);
    expect(records.suggestions).toHaveLength(0);
  });

  it('conflict suggests with display strings AND parts', async () => {
    const { deps, records } = makeDeps();
    const contact = makeContact({ type: 'tenant', address: { line1: '9 Old Rd', city: 'Macon' } });
    const outcome = await run(deps, contact, {
      fields: {},
      address: { op: 'suggest', parts: { line1: '1 Main St', city: 'Atlanta' }, reason: 'moved recently' },
    });

    expect(outcome.suggested).toEqual(['address']);
    expect(records.updates).toHaveLength(0);
    expect(records.suggestions[0]).toMatchObject({
      ownerContactId: 'c1',
      target: 'address',
      currentValue: '9 Old Rd, Macon',
      suggestedValue: '1 Main St, Atlanta',
      suggestedAddress: { line1: '1 Main St', city: 'Atlanta' },
      reason: 'moved recently',
      conversationId: CONV,
      tsMsgId: 'ts-9',
    });
  });

  it('normalized-equal suggestion is skipped', async () => {
    const { deps, records } = makeDeps();
    const contact = makeContact({ type: 'tenant', address: { line1: '535 Seal Pl NE', city: 'Atlanta' } });
    const outcome = await run(deps, contact, {
      fields: {},
      // Case + whitespace differ; normalized equal -> no suggestion.
      address: { op: 'suggest', parts: { line1: '535  seal pl ne', city: 'ATLANTA' } },
    });

    expect(outcome.suggested).toEqual([]);
    expect(records.suggestions).toHaveLength(0);
  });

  it('legacy plain-string stored address compares/normalizes correctly', async () => {
    const { deps, records } = makeDeps();
    // Pre-contract dev records carry `address` as a plain string.
    const contact = makeContact({ type: 'tenant', address: '535 Seal Pl NE, Atlanta' });
    const outcome = await run(deps, contact, {
      fields: {},
      address: { op: 'suggest', parts: { line1: '535 Seal Pl NE', city: 'Atlanta' } },
    });

    expect(outcome.suggested).toEqual([]);
    expect(records.suggestions).toHaveLength(0);
  });

  it('inferred-role content demotes an address write to a suggestion', async () => {
    const { deps, records } = makeDeps();
    const contact = makeContact({ type: 'tenant' }); // no address yet
    const outcome = await applyExtraction(deps, {
      contact,
      conversationId: CONV,
      cursorTsMsgId: 'ts-9',
      result: {
        fields: {},
        address: { op: 'write', parts: { line1: '1 Main St', city: 'Atlanta' } },
      },
      hasInferredRoleContent: true,
    });

    // The write became a suggestion: nothing direct-written.
    expect(outcome.wrote).toEqual([]);
    expect(outcome.suggested).toEqual(['address']);
    expect(records.updates).toHaveLength(0);
    expect(records.suggestions[0]).toMatchObject({
      target: 'address',
      suggestedValue: '1 Main St, Atlanta',
      suggestedAddress: { line1: '1 Main St', city: 'Atlanta' },
    });
    // 'address' joins the demotion audit's field list.
    const demoted = records.audits.find((a) => a.type === 'ai_extraction_demoted');
    expect(demoted).toBeDefined();
    expect(demoted!.payload!['fields']).toEqual(['address']);
    // No direct write happened, so no write-audit fires.
    expect(records.audits.find((a) => a.type === 'ai_extraction_applied')).toBeUndefined();
  });

  it('address is ignored for non-tenant contacts', async () => {
    for (const type of ['landlord', 'unknown'] as const) {
      const { deps, records } = makeDeps();
      const outcome = await run(deps, makeContact({ type }), {
        fields: {},
        address: { op: 'write', parts: { line1: '1 Main St', city: 'Atlanta' } },
      });
      expect(outcome.wrote).toEqual([]);
      expect(outcome.suggested).toEqual([]);
      expect(records.updates).toHaveLength(0);
      expect(records.suggestions).toHaveLength(0);
    }
  });

  it('noteLines starting with "Current address" are dropped', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {},
      noteLines: ['Current address: 1 Main St', 'Has a service dog'],
    });

    expect(outcome.notedLines).toBe(1);
    const notes = records.updates[0]!.patch['notes'] as string;
    expect(notes).toContain('Has a service dog');
    expect(notes).not.toContain('Current address');
  });

  it('a digit-free "Current address ..." housing-status note is KEPT (filter drops postal lines only)', async () => {
    // Planner review F4: the filter must not eat legitimate screening facts
    // like housing instability - only lines that actually carry a postal
    // address (which always contains a digit).
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {},
      noteLines: [
        'Current address is unstable, couch-surfing with family',
        'Current address: 535 Seal Pl NE, Atlanta',
      ],
    });

    expect(outcome.notedLines).toBe(1);
    const notes = records.updates[0]!.patch['notes'] as string;
    expect(notes).toContain('Current address is unstable, couch-surfing with family');
    expect(notes).not.toContain('535 Seal Pl NE');
  });
});

// Dismissal tombstones (Cameron's ruling 2026-07-21): a previously dismissed
// normalized value is never re-suggested; a different value still comes through.
describe('applyExtraction - dismissal tombstones', () => {
  it('suppresses a suggestion whose value was previously dismissed', async () => {
    const { deps, records } = makeDeps({ dismissedValues: ['firstName#cameron'] });
    const outcome = await run(deps, makeContact({ type: 'tenant', firstName: 'Natalie' }), {
      fields: { firstName: { op: 'suggest', value: 'Cameron', reason: 'stated in voicemail' } },
    });
    expect(outcome.suggested).toEqual([]);
    expect(records.suggestions).toHaveLength(0);
  });

  it('a DIFFERENT value than the tombstone still suggests', async () => {
    const { deps, records } = makeDeps({ dismissedValues: ['firstName#cameron'] });
    const outcome = await run(deps, makeContact({ type: 'tenant', firstName: 'Natalie' }), {
      fields: { firstName: { op: 'suggest', value: 'Kamran', reason: 'stated in voicemail' } },
    });
    expect(outcome.suggested).toEqual(['firstName']);
    expect(records.suggestions).toHaveLength(1);
  });
});
