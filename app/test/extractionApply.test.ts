// Apply service (write policy) - the heart of conversation-fact-extraction (T5).
//
// In-memory stubs for every dep (no DynamoDB). Each behavior in plan Task 5
// items 1-11 is pinned by at least one test.
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  SuggestionDismissedError,
  type GuardedTypeDeleteResult,
  type PutSuggestionResult,
  type SuggestionItem,
} from '../src/repos/extractionRepo.js';
import type { ExtractionResult } from '../src/adapters/extraction.js';
import { createLogger, type Logger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import { applyExtraction, coerceField, type ApplyDeps } from '../src/services/extraction/apply.js';
import type { OrgEntry } from '../src/lib/orgNames.js';
import { buildStartingEntries } from '../src/lib/orgStartingList.js';
import { normalizeSuggestionValue } from '../src/services/extraction/schema.js';

const NOW = '2026-07-16T12:00:00.000Z';
const CONV = 'conv-1';
/** The organization list every apply call resolves housingAuthority against (spec 2026-10-06 D8). */
let orgSeq = 0;
const ORG_ENTRIES: OrgEntry[] = buildStartingEntries(NOW, () => `org-${(orgSeq += 1)}`);

function makeContact(overrides: Partial<ContactItem> = {}): ContactItem {
  return { contactId: 'c1', type: 'tenant', ...overrides };
}

/** A model Notes line (B1 spec D4). 0.9 clears the default 0.7 floor. */
function note(text: string, confidence = 0.9): { text: string; confidence: number } {
  return { text, confidence };
}

interface StubRecords {
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  suggestions: SuggestionItem[];
  audits: Array<{ entityKey: string; type: string; payload?: Record<string, unknown> }>;
  emits: Array<{ name: string; payload: unknown }>;
}

function makeDeps(opts: {
  findByPhone?: (phone: string) => Promise<ContactItem | undefined>;
  putSuggestionImpl?: (s: Parameters<ApplyDeps['extraction']['putSuggestion']>[0]) => Promise<PutSuggestionResult>;
  getByIdImpl?: (contactId: string, opts?: { consistentRead?: boolean }) => Promise<ContactItem | undefined>;
  guardedDeleteImpl?: (suggestion: SuggestionItem, revision: number) => Promise<GuardedTypeDeleteResult>;
  updateImpl?: (id: string, patch: Record<string, unknown>) => Promise<ContactItem>;
  /** Tombstoned values as `target#normValue` pairs (hasDismissal stub). */
  dismissedValues?: string[];
  /** EXTRACTION_FACT_MIN_CONFIDENCE for this run (B1 spec D4); default 0.7. */
  factMinConfidence?: number;
} = {}): { deps: ApplyDeps; records: StubRecords; logger: Logger; logCapture: ReturnType<typeof createLogCapture> } {
  const records: StubRecords = { updates: [], suggestions: [], audits: [], emits: [] };
  const logCapture = createLogCapture();
  const logger = createLogger({ destination: logCapture.stream, level: 'debug' });

  const contacts: ApplyDeps['contacts'] = {
    getById: vi.fn(async (contactId: string, getOpts?: { consistentRead?: boolean }) =>
      opts.getByIdImpl ? opts.getByIdImpl(contactId, getOpts) : undefined,
    ),
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
    putSuggestion: vi.fn(async (s: Parameters<ApplyDeps['extraction']['putSuggestion']>[0]): Promise<PutSuggestionResult> => {
      const item: SuggestionItem = {
        ...s,
        itemId: `sugg#${s.ownerContactId}#${s.target}`,
        _pendingPartition: 'pending',
        createdAt: NOW,
      };
      const result: PutSuggestionResult = opts.putSuggestionImpl
        ? await opts.putSuggestionImpl(s)
        : { item };
      records.suggestions.push(result.item);
      return result;
    }),
    deleteSuggestion: vi.fn(async () => {}),
    deleteTypeSuggestionIfCurrentAtContactRevision: vi.fn(
      async (suggestion: SuggestionItem, revision: number) =>
        opts.guardedDeleteImpl ? opts.guardedDeleteImpl(suggestion, revision) : 'deleted' as const,
    ),
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

  const deps: ApplyDeps = {
    contacts, extraction, audit, events, logger, now: () => NOW,
    factMinConfidence: opts.factMinConfidence ?? 0.7,
  };
  return { deps, records, logger, logCapture };
}

function run(
  deps: ApplyDeps,
  contact: ContactItem,
  result: ExtractionResult,
  cursorTsMsgId = 'ts-9',
  runId?: string,
  orgEntries: readonly OrgEntry[] = ORG_ENTRIES,
) {
  return applyExtraction(deps, {
    contact, conversationId: CONV, cursorTsMsgId, result, orgEntries,
    ...(runId !== undefined && { runId }),
  });
}

describe('applyExtraction - run-log plumbing', () => {
  it('stamps the runId on every suggestion it writes', async () => {
    const { deps, records } = makeDeps();
    await run(
      deps,
      makeContact({ type: 'tenant', pets: 'a dog' }),
      { fields: { pets: { op: 'suggest', value: 'two cats', reason: 'said so' } } },
      'ts-9',
      'run-7',
    );
    expect((records.suggestions[0] as { runId?: string }).runId).toBe('run-7');
  });

  it('surfaces the displaced runId on ApplyOutcome without ever touching ai_runs', async () => {
    const { deps } = makeDeps({
      putSuggestionImpl: async (s) => ({
        item: { ...s, itemId: 'x', _pendingPartition: 'pending', createdAt: NOW },
        displaced: { ...s, itemId: 'x', createdAt: 'before', suggestedValue: 'older', runId: 'run-earlier' },
      }),
    });
    const out = await run(
      deps,
      makeContact({ type: 'tenant', pets: 'a dog' }),
      { fields: { pets: { op: 'suggest', value: 'two cats', reason: 'said so' } } },
      'ts-9',
      'run-7',
    );
    expect(out.displaced).toEqual([{ target: 'pets', runId: 'run-earlier', createdAt: 'before' }]);
  });

  it('emits no displaced entry when the displaced row predates the run log', async () => {
    const { deps } = makeDeps({
      putSuggestionImpl: async (s) => {
        const { runId: _runId, ...prior } = s;
        return {
          item: { ...s, itemId: 'x', _pendingPartition: 'pending', createdAt: NOW },
          displaced: { ...prior, itemId: 'x', createdAt: 'before', suggestedValue: 'older' },
        };
      },
    });
    const out = await run(
      deps,
      makeContact({ type: 'tenant', pets: 'a dog' }),
      { fields: { pets: { op: 'suggest', value: 'two cats' } } },
      'ts-9',
      'run-7',
    );
    expect(out.displaced).toEqual([]);
  });
});

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
    expect(outcome).toEqual({ wrote: [], suggested: [], notedLines: 0, notesBelowFloor: 0, notesDemoted: 0, notesDuplicate: 0, appendedLines: [], displaced: [], decisions: [] });
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
      fields: { voucherSize: { op: 'suggest', value: '3', reason: 'voucher reissued as a 3-bedroom' } },
    });
    expect(outcome.suggested).toEqual(['voucherSize']);
    expect(records.updates).toHaveLength(0);
    expect(records.suggestions[0]).toMatchObject({
      ownerContactId: 'c1',
      target: 'voucherSize',
      currentValue: '2',
      suggestedValue: '3',
      reason: 'voucher reissued as a 3-bedroom',
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
    expect(outcome).toEqual({
      wrote: [],
      suggested: [],
      notedLines: 0,
      notesBelowFloor: 0,
      notesDemoted: 0,
      notesDuplicate: 0,
      appendedLines: [],
      displaced: [],
      decisions: [
        { target: 'firstName', outcome: 'dropped', dropReason: 'wrong_contact_type', proposedValue: 'Pat' },
        { target: 'voucherSize', outcome: 'dropped', dropReason: 'wrong_contact_type', proposedValue: '3' },
        { target: 'pets', outcome: 'dropped', dropReason: 'wrong_contact_type', proposedValue: 'yes' },
      ],
    });
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

  it('SUGGESTS an unrecognised housingAuthority rather than dropping it', async () => {
    // Was "skips an off-vocabulary housingAuthority". The field is free text
    // (Cameron, 2026-08-09) - a human types anything into ContactEditForm and
    // the importer passes unknown values through verbatim, so the extractor
    // dropping them made the AI the only writer that could not record a real
    // answer. A client naming an authority we have not seen is data.
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { housingAuthority: { op: 'write', value: 'Nowhere PHA' } },
    });
    // Demoted, not written: a transcript can mishear, so a novel authority
    // waits for one human confirmation before it becomes a GSI hash value.
    expect(outcome.wrote).toEqual([]);
    expect(records.updates).toHaveLength(0);
    expect(outcome.suggested).toEqual(['housingAuthority']);
    expect(records.suggestions[0]).toMatchObject({
      target: 'housingAuthority',
      suggestedValue: 'Nowhere PHA',
    });
  });

  it('writes a housingAuthority that is a list name directly', async () => {
    // Was 'Fulton County' - now a spelling of Fulton County Housing Authority
    // (spec 2026-10-06 section 13), so it is written as that name (the spelling
    // case is the next test). This one keeps the exact-name case.
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { housingAuthority: { op: 'write', value: 'Jonesboro Housing Authority' } },
    });
    expect(outcome.wrote).toEqual(['housingAuthority']);
    expect(records.updates[0]!.patch['housingAuthority']).toBe('Jonesboro Housing Authority');
  });

  it('writes a list SPELLING as its entry\'s exact name', async () => {
    // The case the whole normalizer exists for. Broadcast audience resolution is
    // an exact hash match on the byHousingAuthority GSI, so had "Dekalb Housing"
    // been stored verbatim it would have formed a second DeKalb audience
    // invisible to the others. It is written, not suggested, BECAUSE it is a
    // spelling of exactly one list entry (spec 2026-10-06 D4/D8).
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { housingAuthority: { op: 'write', value: 'Dekalb Housing' } },
    });
    expect(outcome.wrote).toEqual(['housingAuthority']);
    expect(records.updates[0]!.patch['housingAuthority']).toBe('DeKalb County Housing Authority');
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

  it.each(['partner', 'property_manager'] as const)(
    'persists a %s type suggestion at the source contact revision',
    async (kind) => {
      const { deps, records } = makeDeps();
      const out = await run(
        deps,
        makeContact({ type: 'unknown', classification_revision: 4 }),
        { fields: {}, typeSuggestion: { value: kind, reason: 'stated role' } },
        'ts-9',
        'run-kind',
      );

      expect(records.suggestions[0]).toMatchObject({
        target: 'type',
        suggestedValue: kind,
        contactClassificationRevision: 4,
        runId: 'run-kind',
      });
      expect(out.suggested).toEqual(['type']);
      expect(out.decisions[0]).toMatchObject({ outcome: 'suggested', proposedValue: kind });
    },
  );

  it('uses logical revision zero for a legacy unknown contact', async () => {
    const { deps, records } = makeDeps();
    await run(deps, makeContact({ type: 'unknown' }), {
      fields: {}, typeSuggestion: { value: 'tenant' },
    });
    expect(records.suggestions[0]).toMatchObject({ contactClassificationRevision: 0 });
  });

  it('retracts its row and drops when the live contact is classified', async () => {
    const { deps, records } = makeDeps({
      getByIdImpl: async () => makeContact({ type: 'tenant', classification_revision: 1 }),
    });
    const out = await run(deps, makeContact({ type: 'unknown' }), {
      fields: {}, typeSuggestion: { value: 'tenant' },
    });

    expect(out.suggested).toEqual([]);
    expect(out.decisions).toContainEqual(expect.objectContaining({
      target: 'type', outcome: 'dropped', dropReason: 'type_already_classified',
    }));
    expect(deps.extraction.deleteTypeSuggestionIfCurrentAtContactRevision)
      .toHaveBeenCalledWith(records.suggestions[0], 1);
    expect(deps.contacts.getById).toHaveBeenCalledWith('c1', { consistentRead: true });
    expect(records.emits).toEqual([{ name: 'suggestion.updated', payload: { contactId: 'c1' } }]);
  });

  it('retracts its row when an unknown contact moved to a newer classification epoch', async () => {
    const { deps } = makeDeps({
      getByIdImpl: async () => makeContact({ type: 'unknown', classification_revision: 4 }),
    });
    const out = await run(deps, makeContact({ type: 'unknown', classification_revision: 2 }), {
      fields: {}, typeSuggestion: { value: 'tenant' },
    });
    expect(out.decisions[0]).toMatchObject({
      outcome: 'dropped', dropReason: 'type_classification_changed',
    });
    expect(deps.contacts.getById).toHaveBeenCalledWith('c1', { consistentRead: true });
  });

  it('preserves a pending decision when guarded cleanup finds a replacement or marker', async () => {
    const { deps } = makeDeps({
      getByIdImpl: async () => makeContact({ type: 'tenant', classification_revision: 1 }),
      guardedDeleteImpl: async () => 'suggestion_changed_or_absent',
    });
    const out = await run(deps, makeContact({ type: 'unknown' }), {
      fields: {}, typeSuggestion: { value: 'tenant' },
    });
    expect(out.suggested).toEqual(['type']);
    expect(out.decisions[0]).toMatchObject({ target: 'type', outcome: 'suggested' });
    expect(deps.contacts.getById).toHaveBeenCalledWith('c1', { consistentRead: true });
  });

  it('re-reads after a contact revision conflict and retries against the newer revision', async () => {
    const getById = vi.fn()
      .mockResolvedValueOnce(makeContact({ type: 'tenant', classification_revision: 1 }))
      .mockResolvedValueOnce(makeContact({ type: 'tenant', classification_revision: 2 }));
    const guardedDelete = vi.fn()
      .mockResolvedValueOnce('contact_revision_changed' as const)
      .mockResolvedValueOnce('deleted' as const);
    const { deps } = makeDeps({ getByIdImpl: getById, guardedDeleteImpl: guardedDelete });
    await run(deps, makeContact({ type: 'unknown' }), { fields: {}, typeSuggestion: { value: 'tenant' } });
    expect(getById).toHaveBeenCalledTimes(2);
    expect(getById).toHaveBeenNthCalledWith(1, 'c1', { consistentRead: true });
    expect(getById).toHaveBeenNthCalledWith(2, 'c1', { consistentRead: true });
    expect(guardedDelete).toHaveBeenNthCalledWith(1, expect.anything(), 1);
    expect(guardedDelete).toHaveBeenNthCalledWith(2, expect.anything(), 2);
  });

  it('leaves a stable unknown contact pending without guarded cleanup', async () => {
    const { deps } = makeDeps({
      getByIdImpl: async () => makeContact({ type: 'unknown', classification_revision: 2 }),
    });
    const out = await run(deps, makeContact({ type: 'unknown', classification_revision: 2 }), {
      fields: {}, typeSuggestion: { value: 'tenant' },
    });
    expect(out.suggested).toEqual(['type']);
    expect(deps.contacts.getById).toHaveBeenCalledWith('c1', { consistentRead: true });
    expect(deps.extraction.deleteTypeSuggestionIfCurrentAtContactRevision).not.toHaveBeenCalled();
  });

  it('keeps a pending decision and warns when the live contact is missing', async () => {
    const { deps, logCapture } = makeDeps({ getByIdImpl: async () => undefined });
    const out = await run(deps, makeContact({ type: 'unknown' }), {
      fields: {}, typeSuggestion: { value: 'tenant' },
    });
    expect(out.suggested).toEqual(['type']);
    expect(deps.contacts.getById).toHaveBeenCalledWith('c1', { consistentRead: true });
    expect(deps.extraction.deleteTypeSuggestionIfCurrentAtContactRevision).not.toHaveBeenCalled();
    expect(logCapture.atLevel(40)).toContainEqual(expect.objectContaining({
      msg: 'type suggestion reconciliation found no live contact (best-effort)',
    }));
  });

  it('keeps a pending decision and warns when the reconciliation read fails', async () => {
    const { deps, logCapture } = makeDeps({
      getByIdImpl: async () => { throw new Error('read unavailable'); },
    });
    const out = await run(deps, makeContact({ type: 'unknown' }), {
      fields: {}, typeSuggestion: { value: 'tenant' },
    });
    expect(out.suggested).toEqual(['type']);
    expect(deps.contacts.getById).toHaveBeenCalledWith('c1', { consistentRead: true });
    expect(logCapture.atLevel(40)).toContainEqual(expect.objectContaining({
      msg: 'type suggestion reconciliation failed (best-effort)',
    }));
  });

  it('stops after four contact-revision conflicts and preserves the pending decision', async () => {
    const getById = vi.fn(async () => makeContact({ type: 'tenant', classification_revision: 1 }));
    const guardedDelete = vi.fn(async () => 'contact_revision_changed' as const);
    const { deps } = makeDeps({ getByIdImpl: getById, guardedDeleteImpl: guardedDelete });
    const out = await run(deps, makeContact({ type: 'unknown' }), {
      fields: {}, typeSuggestion: { value: 'tenant' },
    });
    expect(out.suggested).toEqual(['type']);
    expect(getById).toHaveBeenCalledTimes(4);
    expect(getById).toHaveBeenNthCalledWith(1, 'c1', { consistentRead: true });
    expect(getById).toHaveBeenNthCalledWith(2, 'c1', { consistentRead: true });
    expect(getById).toHaveBeenNthCalledWith(3, 'c1', { consistentRead: true });
    expect(getById).toHaveBeenNthCalledWith(4, 'c1', { consistentRead: true });
    expect(guardedDelete).toHaveBeenCalledTimes(4);
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
      noteLines: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((text) => note(text)),
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
      noteLines: ['  ', '', 'real fact'].map((text) => note(text)),
    });
    expect(outcome.notedLines).toBe(1);
  });

  it('appends to existing notes with a newline join, preserving existing text', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant', notes: 'existing note' }), {
      fields: {},
      noteLines: [note('new fact')],
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
    const result: ExtractionResult = { fields: {}, noteLines: [note('stairs are a problem')] };

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
      noteLines: [note('likes the neighborhood')],
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
      orgEntries: ORG_ENTRIES,
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

  // B1 spec D4 / charter 6.4 ("appends no lines"), Cameron's spec-gate answer
  // Q1: a demoted run now appends NO Notes line. This case used to pin the
  // opposite ("notes are additive - the append still lands directly"). The
  // consequence Q1 accepted: an AI caseworker note (lib/caseworkers.ts
  // hasAiCaseworkerNote) is not written from such a window (WI6).
  it('leaves native suggestions untouched under the flag, appends NO note line, and counts it (no demotion audit)', async () => {
    const { deps, records } = makeDeps();
    const contact = makeContact({ type: 'tenant', voucherSize: 2 });
    const outcome = await applyExtraction(deps, {
      orgEntries: ORG_ENTRIES,
      contact,
      conversationId: CONV,
      cursorTsMsgId: 'ts-9',
      result: {
        fields: { voucherSize: { op: 'suggest', value: '3', reason: 'voucher reissued as a 3-bedroom' } },
        noteLines: [note('likes the neighborhood')],
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
    // A demoted run appends no line - withheld and counted, never written.
    expect(outcome.notedLines).toBe(0);
    expect(outcome.notesDemoted).toBe(1);
    expect(records.updates.find((u) => typeof u.patch['notes'] === 'string')).toBeUndefined();
    // No write op was present, so no demotion audit fires.
    expect(records.audits.find((a) => a.type === 'ai_extraction_demoted')).toBeUndefined();
  });

  it('with the flag explicitly false, a write on an empty field lands directly (parity)', async () => {
    const { deps, records } = makeDeps();
    const outcome = await applyExtraction(deps, {
      orgEntries: ORG_ENTRIES,
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
      orgEntries: ORG_ENTRIES,
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
      orgEntries: ORG_ENTRIES,
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
      noteLines: [note('Current address: 1 Main St'), note('Has a service dog')],
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
        note('Current address is unstable, couch-surfing with family'),
        note('Current address: 535 Seal Pl NE, Atlanta'),
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

describe('applyExtraction - per-target decisions for the run log', () => {
  it('records a direct write with its previous and coerced values', async () => {
    const { deps } = makeDeps();
    const out = await run(deps, makeContact({ type: 'tenant', pets: 'a dog' }), {
      fields: { pets: { op: 'write', value: 'two cats', reason: 'said so' } },
    });
    expect(out.decisions).toEqual([
      {
        target: 'pets', outcome: 'wrote',
        proposedValue: 'two cats', coercedValue: 'two cats',
        previousValue: 'a dog', reason: 'said so',
      },
    ]);
  });

  it('records wrong_contact_type when the field does not apply to this contact', async () => {
    const { deps } = makeDeps();
    const out = await run(deps, makeContact({ type: 'unknown' }), {
      fields: { voucherSize: { op: 'write', value: '2' } },
    });
    expect(out.decisions).toEqual([
      { target: 'voucherSize', outcome: 'dropped', dropReason: 'wrong_contact_type', proposedValue: '2' },
    ]);
  });

  it('records invalid_value when coercion refuses a well-formed but wrong value', async () => {
    const { deps } = makeDeps();
    const out = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { voucherSize: { op: 'write', value: '99' } }, // outside 0..12
    });
    expect(out.decisions[0]).toMatchObject({
      target: 'voucherSize', outcome: 'dropped', dropReason: 'invalid_value',
    });
  });

  it('records equal_to_current for a suggestion matching the stored value', async () => {
    const { deps } = makeDeps();
    const out = await run(deps, makeContact({ type: 'tenant', pets: 'a dog' }), {
      fields: { pets: { op: 'suggest', value: 'a dog' } },
    });
    expect(out.decisions[0]).toMatchObject({ target: 'pets', outcome: 'dropped', dropReason: 'equal_to_current' });
  });

  it('records dismissed_before when the tombstone suppresses the suggestion', async () => {
    const { deps } = makeDeps({ dismissedValues: ['pets#two cats'] });
    const out = await run(deps, makeContact({ type: 'tenant', pets: 'a dog' }), {
      fields: { pets: { op: 'suggest', value: 'two cats' } },
    });
    expect(out.decisions[0]).toMatchObject({ outcome: 'dropped', dropReason: 'dismissed_before' });
    expect(out.suggested).toEqual([]);
  });

  it('records dismissed_before when the atomic writer fence loses after the preflight read', async () => {
    const { deps } = makeDeps({
      // hasDismissal returns false, then the transaction observes the dismissal
      // that won in between. This is the race the old read-plus-Put path missed.
      putSuggestionImpl: async () => {
        throw new SuggestionDismissedError();
      },
    });
    const out = await run(deps, makeContact({ type: 'tenant', pets: 'a dog' }), {
      fields: { pets: { op: 'suggest', value: 'two cats' } },
    });
    expect(out.decisions[0]).toMatchObject({
      outcome: 'dropped',
      dropReason: 'dismissed_before',
    });
    expect(out.suggested).toEqual([]);
  });

  it('records repo_error when the suggestion upsert throws', async () => {
    const { deps } = makeDeps({ putSuggestionImpl: async () => { throw new Error('ddb down'); } });
    const out = await run(deps, makeContact({ type: 'tenant', pets: 'a dog' }), {
      fields: { pets: { op: 'suggest', value: 'two cats' } },
    });
    expect(out.decisions[0]).toMatchObject({ outcome: 'dropped', dropReason: 'repo_error' });
  });

  it('records demotedFrom write - NOT a drop - for an inferred-role demotion', async () => {
    const { deps } = makeDeps();
    const out = await applyExtraction(deps, {
      orgEntries: ORG_ENTRIES,
      contact: makeContact({ type: 'tenant', pets: 'a dog' }),
      conversationId: CONV,
      hasInferredRoleContent: true,
      result: { fields: { pets: { op: 'write', value: 'two cats' } } },
    });
    expect(out.decisions[0]).toMatchObject({ target: 'pets', outcome: 'suggested', demotedFrom: 'write' });
    expect(out.decisions[0]?.dropReason).toBeUndefined();
  });

  it('records demotedFrom write for a LOSSY address write routed to review', async () => {
    const { deps } = makeDeps();
    const out = await run(
      deps,
      makeContact({ type: 'tenant', address: { line1: '1 Main St', city: 'Atlanta', zip: '30303' } }),
      { fields: {}, address: { op: 'write', parts: { line1: '2 Oak Ave' } } },
    );
    expect(out.decisions.find((d) => d.target === 'address')).toMatchObject({
      outcome: 'suggested', demotedFrom: 'write',
    });
  });

  it('records status_not_onboarding_tenant', async () => {
    const { deps } = makeDeps();
    const out = await run(deps, makeContact({ type: 'tenant', status: 'searching' }), {
      fields: {}, statusAdvance: { suggest: true },
    });
    expect(out.decisions).toEqual([
      { target: 'status', outcome: 'dropped', dropReason: 'status_not_onboarding_tenant' },
    ]);
  });

  it('records type_already_classified', async () => {
    const { deps } = makeDeps();
    const out = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {}, typeSuggestion: { value: 'tenant' },
    });
    expect(out.decisions).toEqual([
      { target: 'type', outcome: 'dropped', dropReason: 'type_already_classified', proposedValue: 'tenant' },
    ]);
  });

  it('records the three phone drop reasons', async () => {
    const bad = await run(makeDeps().deps, makeContact({ type: 'tenant' }), {
      fields: {}, phoneAddition: { phone: 'not a number' },
    });
    expect(bad.decisions[0]).toMatchObject({ dropReason: 'phone_not_canonicalizable' });

    const owned = await run(makeDeps().deps, makeContact({ type: 'tenant', phone: '+14045550000' }), {
      fields: {}, phoneAddition: { phone: '404-555-0000' },
    });
    expect(owned.decisions[0]).toMatchObject({ dropReason: 'phone_already_owned' });

    const otherDeps = makeDeps({
      findByPhone: async () => ({ contactId: 'someone-else', type: 'tenant' }) as ContactItem,
    });
    const other = await run(otherDeps.deps, makeContact({ type: 'tenant' }), {
      fields: {}, phoneAddition: { phone: '404-555-9999' },
    });
    expect(other.decisions[0]).toMatchObject({ dropReason: 'phone_owned_by_other' });
    // Two different mutations, both recorded: the drop AND a note line.
    expect(other.notedLines).toBe(1);
  });

  it('does NOT record a decision when the batched write FAILS', async () => {
    const { deps } = makeDeps({ updateImpl: async () => { throw new Error('ddb down'); } });
    const out = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { pets: { op: 'write', value: 'two cats' } },
    });
    expect(out.wrote).toEqual([]);
    expect(out.decisions).toEqual([]);
  });

  it('does NOT record a decision for a filtered note line (note lines are not targets)', async () => {
    const { deps } = makeDeps();
    const out = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {}, noteLines: [note('Current address is 1 Main St 30303'), note('stairs are fine')],
    });
    expect(out.decisions).toEqual([]);
    expect(out.notedLines).toBe(1);
  });

  it('EXHAUSTIVENESS: every branch that mutates or discards emits exactly one decision', async () => {
    // Guards the Task 17 join: a target apply forgets to report is recorded as a
    // REASONLESS drop and warns, rather than silently reading as something else.
    // If this test ever fails, apply gained a branch and the table in the plan's
    // Task 14 is stale.
    const { deps } = makeDeps();
    const out = await run(deps, makeContact({ type: 'tenant', pets: 'a dog' }), {
      fields: {
        pets: { op: 'suggest', value: 'two cats' },
        voucherSize: { op: 'write', value: '99' },
        tenure: { op: 'none' },
      },
      statusAdvance: { suggest: false },
    });
    expect(out.decisions.map((d) => d.target).sort()).toEqual(['pets', 'voucherSize']);
    for (const d of out.decisions) {
      if (d.outcome === 'dropped') expect(d.dropReason).toBeDefined();
    }
  });
});

describe('applyExtraction - housingAuthority against the organization list (spec 2026-10-06 D8)', () => {
  it('writes an exact list name the old alias map never knew', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { housingAuthority: { op: 'write', value: 'Marietta Housing Authority', reason: 'said so' } },
    });
    expect(outcome.wrote).toEqual(['housingAuthority']);
    expect(records.updates[0]!.patch['housingAuthority']).toBe('Marietta Housing Authority');
  });

  it('writes a unique spelling, or the name in another case, as the entry\'s exact name', async () => {
    for (const said of ['Atlanta (AHA)', 'atlanta housing authority.']) {
      const { deps, records } = makeDeps();
      const outcome = await run(deps, makeContact({ type: 'tenant' }), {
        fields: { housingAuthority: { op: 'write', value: said } },
      });
      expect(outcome.wrote).toEqual(['housingAuthority']);
      expect(records.updates[0]!.patch['housingAuthority']).toBe('Atlanta Housing Authority');
      expect(outcome.decisions[0]).toMatchObject({
        target: 'housingAuthority', outcome: 'wrote', proposedValue: said, coercedValue: 'Atlanta Housing Authority',
      });
    }
  });

  it('still lets the model\'s op decide: a write over an occupied field writes the list name', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant', housingAuthority: 'Atlanta (AHA)' }), {
      fields: { housingAuthority: { op: 'write', value: 'Atlanta Housing Authority', reason: 'fuller name' } },
    });
    expect(outcome.wrote).toEqual(['housingAuthority']);
    expect(records.updates[0]!.patch['housingAuthority']).toBe('Atlanta Housing Authority');
  });

  it('a suggest of a list spelling suggests the entry\'s exact name', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(
      deps,
      makeContact({ type: 'tenant', housingAuthority: 'Georgia Department of Community Affairs' }),
      { fields: { housingAuthority: { op: 'suggest', value: 'Atlanta (AHA)', reason: 'moved to Atlanta' } } },
    );
    expect(outcome.suggested).toEqual(['housingAuthority']);
    expect(records.updates).toHaveLength(0);
    expect(records.suggestions[0]).toMatchObject({
      target: 'housingAuthority',
      currentValue: 'Georgia Department of Community Affairs',
      suggestedValue: 'Atlanta Housing Authority',
    });
  });

  it('drops a suggestion whose RESOLVED name equals the current value', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant', housingAuthority: 'Atlanta Housing Authority' }), {
      fields: { housingAuthority: { op: 'suggest', value: 'Atlanta (AHA)' } },
    });
    expect(records.suggestions).toHaveLength(0);
    expect(outcome.decisions[0]).toMatchObject({
      target: 'housingAuthority', outcome: 'dropped', dropReason: 'equal_to_current',
    });
  });

  it('drops an agency name - by name or spelling, on either op - as agency_not_authority', async () => {
    const cases = [
      ['write', 'Hope Atlanta'],
      ['suggest', 'Hope Atlanta'],
      ['write', 'VASH'],
    ] as const;
    for (const [op, said] of cases) {
      const { deps, records } = makeDeps();
      const outcome = await run(deps, makeContact({ type: 'tenant' }), {
        fields: { housingAuthority: { op, value: said, reason: 'her caseworker works there' } },
      });
      expect(records.updates).toHaveLength(0);
      expect(records.suggestions).toHaveLength(0);
      expect(outcome.wrote).toEqual([]);
      expect(outcome.suggested).toEqual([]);
      expect(outcome.decisions).toEqual([{
        target: 'housingAuthority',
        outcome: 'dropped',
        dropReason: 'agency_not_authority',
        proposedValue: said,
        reason: 'her caseworker works there',
      }]);
    }
  });

  it('suggests a shared abbreviation as said, demoting a write (PIN)', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { housingAuthority: { op: 'write', value: 'AHA' } },
    });
    expect(outcome.wrote).toEqual([]);
    expect(records.suggestions[0]).toMatchObject({ target: 'housingAuthority', suggestedValue: 'AHA' });
    expect(outcome.decisions[0]).toMatchObject({ outcome: 'suggested', demotedFrom: 'write', coercedValue: 'AHA' });
  });

  it('suggests a compound value as said, whitespace collapsed (PIN)', async () => {
    const { deps, records } = makeDeps();
    await run(deps, makeContact({ type: 'tenant' }), {
      fields: { housingAuthority: { op: 'write', value: 'DCA   HUD-VASH' } },
    });
    expect(records.suggestions[0]).toMatchObject({ target: 'housingAuthority', suggestedValue: 'DCA HUD-VASH' });
  });

  it('inferred-role content still demotes a list match - to a suggestion of the exact name', async () => {
    const { deps, records } = makeDeps();
    const outcome = await applyExtraction(deps, {
      orgEntries: ORG_ENTRIES,
      contact: makeContact({ type: 'tenant' }),
      conversationId: CONV,
      cursorTsMsgId: 'ts-9',
      result: { fields: { housingAuthority: { op: 'write', value: 'Atlanta (AHA)' } } },
      hasInferredRoleContent: true,
    });
    expect(outcome.wrote).toEqual([]);
    expect(records.suggestions[0]).toMatchObject({ target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority' });
    const demoted = records.audits.find((a) => a.type === 'ai_extraction_demoted');
    expect(demoted!.payload).toMatchObject({ fields: ['housingAuthority'] });
  });

  it('resolves against the list the run passed in ctx, not a fixed copy', async () => {
    const metro: OrgEntry = {
      orgId: 'metro', kind: 'housing_authority', name: 'Metro Housing Authority', spellings: ['Metro HA'],
      createdAt: NOW, createdBy: 'test', updatedAt: NOW, updatedBy: 'test',
    };
    const { deps, records } = makeDeps();
    const outcome = await run(
      deps,
      makeContact({ type: 'tenant' }),
      { fields: { housingAuthority: { op: 'write', value: 'Metro HA' } } },
      'ts-9',
      undefined,
      [metro],
    );
    expect(outcome.wrote).toEqual(['housingAuthority']);
    expect(records.updates[0]!.patch['housingAuthority']).toBe('Metro Housing Authority');
  });
});

// Worklist ruling RG-2 (2026-10-06): a dismissal tombstone is keyed on the
// suggestion's TEXT (normalizeSuggestionValue). Before spec 2026-10-06 D8 a
// known authority was suggested under its old alias spelling ("Atlanta (AHA)",
// "DCA", "Fulton County", ...) and anything else as the model said it; now a
// list match is suggested under the entry's full NAME - a different key. So
// the suggest path also checks the model's own text and every spelling of the
// matched entry that names it alone (ruling B-3: a spelling shared within the
// kind, such as AHA, does not count), and a value dismissed before the deploy
// is still never re-suggested (ruling 2026-07-21). Writes never consult
// dismissals.
describe('applyExtraction - a list match honors dismissals of its other spellings (worklist RG-2)', () => {
  const tombstone = (text: string): string =>
    `housingAuthority#${normalizeSuggestionValue('housingAuthority', text)}`;

  it('drops the full name when an old spelling of the entry was dismissed', async () => {
    const { deps, records } = makeDeps({ dismissedValues: [tombstone('Atlanta (AHA)')] });
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { housingAuthority: { op: 'suggest', value: 'Atlanta Housing Authority', reason: 'said so' } },
    });
    expect(outcome.suggested).toEqual([]);
    expect(records.suggestions).toHaveLength(0);
    expect(outcome.decisions).toEqual([{
      target: 'housingAuthority',
      outcome: 'dropped',
      dropReason: 'dismissed_before',
      proposedValue: 'Atlanta Housing Authority',
    }]);
  });

  it('drops the full name when the model\'s own text was dismissed', async () => {
    const said = 'Housing Authority of the City of Atlanta';
    const { deps, records } = makeDeps({ dismissedValues: [tombstone(said)] });
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { housingAuthority: { op: 'suggest', value: said } },
    });
    expect(outcome.suggested).toEqual([]);
    expect(records.suggestions).toHaveLength(0);
    expect(outcome.decisions[0]).toMatchObject({
      target: 'housingAuthority', outcome: 'dropped', dropReason: 'dismissed_before', proposedValue: said,
    });
  });

  it('drops it when the dismissed text is no spelling but resolves to the entry', async () => {
    // D4 reads 'atlanta housing authority.' as the name, but its dismissal key
    // keeps the period: only the check of the model's own text catches it.
    const said = 'atlanta housing authority.';
    const { deps, records } = makeDeps({ dismissedValues: [tombstone(said)] });
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { housingAuthority: { op: 'suggest', value: said } },
    });
    expect(outcome.suggested).toEqual([]);
    expect(records.suggestions).toHaveLength(0);
    expect(outcome.decisions[0]).toMatchObject({ outcome: 'dropped', dropReason: 'dismissed_before' });
  });

  it('(PIN) a dismissal of ANOTHER entry\'s spelling does not suppress it', async () => {
    const { deps, records } = makeDeps({ dismissedValues: [tombstone('DCA')] });
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { housingAuthority: { op: 'suggest', value: 'Atlanta Housing Authority' } },
    });
    expect(outcome.suggested).toEqual(['housingAuthority']);
    expect(records.suggestions[0]).toMatchObject({
      target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
    });
  });

  it('(PIN) a WRITE of a list match never consults dismissals', async () => {
    // The ruling leaves writes as they were: D8 handles a match exactly as a
    // known authority always was, and a write never read the tombstones.
    const { deps, records } = makeDeps({ dismissedValues: [tombstone('Atlanta (AHA)')] });
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { housingAuthority: { op: 'write', value: 'Atlanta Housing Authority' } },
    });
    expect(outcome.wrote).toEqual(['housingAuthority']);
    expect(records.updates[0]!.patch['housingAuthority']).toBe('Atlanta Housing Authority');
  });

  // Worklist ruling B-3: only the spellings that resolve to the matched entry
  // ALONE extend its dismissal keys. AHA is a spelling of both Atlanta and
  // Augusta, so a dismissed "AHA" (an ambiguous suggestion, suggested as said)
  // rejected that text - not Augusta's full name.
  it('a dismissal of a SHARED spelling does not suppress one entry\'s full name (worklist B-3)', async () => {
    const { deps, records } = makeDeps({
      dismissedValues: [`housingAuthority#${normalizeSuggestionValue('housingAuthority', 'AHA')}`],
    });
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { housingAuthority: { op: 'suggest', value: 'Augusta Housing Authority' } },
    });
    expect(outcome.suggested).toEqual(['housingAuthority']);
    expect(records.suggestions).toHaveLength(1);
    expect(records.suggestions[0]).toMatchObject({
      target: 'housingAuthority', suggestedValue: 'Augusta Housing Authority',
    });
  });

  it('(PIN) a dismissal of a spelling unique to the entry still suppresses its full name (worklist B-3)', async () => {
    // 'Atlanta (AHA)' holds the shared token AHA, but the WHOLE spelling
    // resolves to Atlanta alone, so it stays one of Atlanta's dismissal keys.
    const { deps, records } = makeDeps({ dismissedValues: [tombstone('Atlanta (AHA)')] });
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { housingAuthority: { op: 'suggest', value: 'Atlanta Housing Authority' } },
    });
    expect(outcome.suggested).toEqual([]);
    expect(records.suggestions).toHaveLength(0);
    expect(outcome.decisions[0]).toMatchObject({
      target: 'housingAuthority', outcome: 'dropped', dropReason: 'dismissed_before',
    });
  });
});

// B1 spec D3: a tenant matching input coerces by its KIND (from the one list),
// never by name. coerceField is pure and exported - the probe (spec D7) and
// the accept path (suggestionResolution.ts coerceAccept) use the same rule.
describe('coerceField - the tenant matching inputs by kind (B1 spec D3)', () => {
  it('trims a text value and keeps one of exactly 500 characters', () => {
    expect(coerceField('area_preference', '  Decatur or Tucker  ')).toEqual({ ok: true, value: 'Decatur or Tucker' });
    const max = 'x'.repeat(500);
    expect(coerceField('preferences_constraints', max)).toEqual({ ok: true, value: max });
  });

  it('DROPS (never truncates) a text value over 500 characters, and an empty one', () => {
    expect(coerceField('accessibility_need', 'x'.repeat(501))).toMatchObject({ ok: false });
    expect(coerceField('area_preference', '   ')).toMatchObject({ ok: false });
    expect(coerceField('area_preference', undefined)).toMatchObject({ ok: false });
  });

  it('reads dollars with $, commas and spaces stripped, as a whole number 0..20000', () => {
    expect(coerceField('max_tenant_portion', '$1,200')).toEqual({ ok: true, value: 1200 });
    expect(coerceField('max_tenant_portion', ' 1 200 ')).toEqual({ ok: true, value: 1200 });
    expect(coerceField('max_tenant_portion', '0')).toEqual({ ok: true, value: 0 });
    expect(coerceField('max_tenant_portion', '20000')).toEqual({ ok: true, value: 20000 });
  });

  it('drops a fractional, negative, out-of-range or non-numeric dollar value (1200.50 is not rounded)', () => {
    for (const raw of ['1200.50', '-5', '20001', 'about 1200', '', '$']) {
      expect(coerceField('max_tenant_portion', raw), raw).toMatchObject({ ok: false });
    }
  });

  it('(PIN) leaves the eight original fields exactly as they were', () => {
    expect(coerceField('pets', 'x'.repeat(121))).toMatchObject({ ok: false });
    expect(coerceField('pets', '  two cats ')).toEqual({ ok: true, value: 'two cats' });
    expect(coerceField('voucherSize', '3')).toEqual({ ok: true, value: 3 });
    expect(coerceField('porting', 'true')).toEqual({ ok: true, value: true });
  });
});

// B1 spec D3: the four follow the existing write/suggest/demotion rule, as pets
// does. (The filled-text-field write drop is S3.4.)
describe('applyExtraction - the tenant matching inputs (B1 spec D3)', () => {
  it('writes an EMPTY text field directly, trimmed, with ai provenance', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { area_preference: { op: 'write', value: ' Decatur or Tucker ', reason: 'said so' } },
    });
    expect(outcome.wrote).toEqual(['area_preference']);
    expect(records.updates[0]!.patch['area_preference']).toBe('Decatur or Tucker');
    expect(records.updates[0]!.patch['area_preference_source']).toEqual({
      source: 'ai', at: NOW, conversationId: CONV, tsMsgId: 'ts-9',
    });
  });

  it('writes the dollars field as a whole NUMBER', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: { max_tenant_portion: { op: 'write', value: '$1,200', reason: 'can pay 1200' } },
    });
    expect(outcome.wrote).toEqual(['max_tenant_portion']);
    expect(records.updates[0]!.patch['max_tenant_portion']).toBe(1200);
  });

  it('suggests a contradiction on a filled text field, carrying the full replacement value', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant', area_preference: 'Marietta' }), {
      fields: { area_preference: { op: 'suggest', value: 'Decatur, not Marietta', reason: 'changed her mind' } },
    });
    expect(outcome.suggested).toEqual(['area_preference']);
    expect(records.updates).toHaveLength(0);
    expect(records.suggestions[0]).toMatchObject({
      target: 'area_preference', currentValue: 'Marietta', suggestedValue: 'Decatur, not Marietta',
    });
  });

  it('demotes a write on an EMPTY field to a suggestion under inferred-role content, and audits it', async () => {
    const { deps, records } = makeDeps();
    const outcome = await applyExtraction(deps, {
      orgEntries: ORG_ENTRIES,
      contact: makeContact({ type: 'tenant' }),
      conversationId: CONV,
      cursorTsMsgId: 'ts-9',
      result: { fields: { accessibility_need: { op: 'write', value: 'ground floor' } } },
      hasInferredRoleContent: true,
    });
    expect(outcome.wrote).toEqual([]);
    expect(outcome.suggested).toEqual(['accessibility_need']);
    expect(outcome.decisions[0]).toMatchObject({ target: 'accessibility_need', outcome: 'suggested', demotedFrom: 'write' });
    expect(records.audits.find((a) => a.type === 'ai_extraction_demoted')?.payload).toMatchObject({
      fields: ['accessibility_need'],
    });
  });

  it('drops the four for a contact that is not a tenant (wrong_contact_type)', async () => {
    const { deps, records } = makeDeps();
    const out = await run(deps, makeContact({ type: 'unknown' }), {
      fields: { preferences_constraints: { op: 'write', value: 'no apartments' } },
    });
    expect(out.decisions).toEqual([
      { target: 'preferences_constraints', outcome: 'dropped', dropReason: 'wrong_contact_type', proposedValue: 'no apartments' },
    ]);
    expect(records.updates).toHaveLength(0);
  });

  it('records invalid_value for an over-cap text value and a fractional dollar amount', async () => {
    const { deps } = makeDeps();
    const out = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {
        preferences_constraints: { op: 'write', value: 'x'.repeat(501) },
        max_tenant_portion: { op: 'write', value: '1200.50' },
      },
    });
    expect(out.wrote).toEqual([]);
    expect(out.decisions.map((d) => [d.target, d.dropReason])).toEqual([
      ['max_tenant_portion', 'invalid_value'],
      ['preferences_constraints', 'invalid_value'],
    ]);
  });
});

// B1 spec D3: for the three TEXT tenant matching inputs "write" means "fill an
// empty field" and nothing else. An added fact is a Notes line (D4); only a
// `suggest` (a contradiction) creates a suggestion. So the model never
// rewrites staff text live and suggestions do not churn on rewordings.
describe('applyExtraction - a write never rewrites a filled text field (B1 spec D3)', () => {
  it('drops a write on a NON-EMPTY text field as text_field_filled - not a write, not a suggestion', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant', area_preference: 'Marietta' }), {
      fields: { area_preference: { op: 'write', value: 'Marietta or Smyrna', reason: 'added Smyrna' } },
    });
    expect(outcome.wrote).toEqual([]);
    expect(outcome.suggested).toEqual([]);
    expect(records.updates).toHaveLength(0);
    expect(records.suggestions).toHaveLength(0);
    expect(outcome.decisions).toEqual([{
      target: 'area_preference', outcome: 'dropped', dropReason: 'text_field_filled',
      proposedValue: 'Marietta or Smyrna', reason: 'added Smyrna',
    }]);
  });

  it('drops it under inferred-role content too, and keeps it OUT of the Layer-3 demotion audit', async () => {
    const { deps, records } = makeDeps();
    const outcome = await applyExtraction(deps, {
      orgEntries: ORG_ENTRIES,
      contact: makeContact({ type: 'tenant', preferences_constraints: 'no apartments' }),
      conversationId: CONV,
      cursorTsMsgId: 'ts-9',
      result: { fields: { preferences_constraints: { op: 'write', value: 'no apartments, needs a yard' } } },
      hasInferredRoleContent: true,
    });
    expect(outcome.suggested).toEqual([]);
    expect(records.suggestions).toHaveLength(0);
    expect(outcome.decisions[0]).toMatchObject({ outcome: 'dropped', dropReason: 'text_field_filled' });
    expect(outcome.decisions[0]?.demotedFrom).toBeUndefined();
    expect(records.audits.find((a) => a.type === 'ai_extraction_demoted')).toBeUndefined();
  });

  it('(PIN) a whitespace-only stored value is empty: the write fills it', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant', accessibility_need: '   ' }), {
      fields: { accessibility_need: { op: 'write', value: 'ground floor' } },
    });
    expect(outcome.wrote).toEqual(['accessibility_need']);
    expect(records.updates[0]!.patch['accessibility_need']).toBe('ground floor');
  });

  it('(PIN) the dollars field keeps the pets rule: a same-fact write on a filled value lands', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant', max_tenant_portion: 1100 }), {
      fields: { max_tenant_portion: { op: 'write', value: '1,200', reason: 'corrected' } },
    });
    expect(outcome.wrote).toEqual(['max_tenant_portion']);
    expect(records.updates[0]!.patch['max_tenant_portion']).toBe(1200);
  });

  it('(PIN) a suggest on a filled text field still suggests - a contradiction is a suggestion', async () => {
    const { deps } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant', area_preference: 'Marietta' }), {
      fields: { area_preference: { op: 'suggest', value: 'Decatur' } },
    });
    expect(outcome.suggested).toEqual(['area_preference']);
  });
});

// B1 spec D4: applyExtraction appends exactly what filterNoteLines returns, the
// floor arriving through ApplyDeps from config.
describe('applyExtraction - Notes lines through filterNoteLines (B1 spec D4)', () => {
  it('drops a line below the floor, keeps one AT it, and reports the count', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {}, noteLines: [note('below the floor', 0.69), note('at the floor', 0.7)],
    });
    expect(outcome.notedLines).toBe(1);
    expect(outcome.notesBelowFloor).toBe(1);
    expect(records.updates[0]!.patch['notes']).toBe('[Auto - Jul 16] at the floor');
  });

  it('applies the floor before the five-line cap: seven lines, first five below -> two land', async () => {
    const { deps, records } = makeDeps();
    const lines = [1, 2, 3, 4, 5].map((n) => note(`low ${n}`, 0.2)).concat([note('high 6'), note('high 7')]);
    const outcome = await run(deps, makeContact({ type: 'tenant' }), { fields: {}, noteLines: lines });
    expect(outcome.notedLines).toBe(2);
    expect(outcome.notesBelowFloor).toBe(5);
    expect(records.updates[0]!.patch['notes']).toBe('[Auto - Jul 16] high 6\n[Auto - Jul 16] high 7');
  });

  it('reads the floor from ApplyDeps: a system line bypasses it, a model line does not', async () => {
    const { deps, records } = makeDeps({
      factMinConfidence: 1,
      findByPhone: async () => makeContact({ contactId: 'other', type: 'tenant' }),
    });
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {}, noteLines: [note('nearly sure', 0.99)], phoneAddition: { phone: '555-010-9999' },
    });
    expect(outcome.notedLines).toBe(1);
    expect(outcome.notesBelowFloor).toBe(1);
    expect(records.updates[0]!.patch['notes']).toBe('[Auto - Jul 16] Mentioned number +15550109999 which belongs to another contact');
  });

  it('a guarded duplicate no longer takes a cap slot (WI5)', async () => {
    // Whole words: written for the substring guard, which matched a single
    // letter inside "seed". FW2-1 compares whole lines; the words stay.
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant', notes: 'seed\n[Auto - Jul 16] alpha' }), {
      fields: {}, noteLines: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((text) => note(text)),
    });
    expect(outcome.notedLines).toBe(5);
    expect(records.updates[0]!.patch['notes']).toBe(
      'seed\n[Auto - Jul 16] alpha\n[Auto - Jul 16] bravo\n[Auto - Jul 16] charlie\n[Auto - Jul 16] delta\n[Auto - Jul 16] echo\n[Auto - Jul 16] foxtrot',
    );
  });

  it('appends feedback on 12 Oak St beside an earlier line on 112 Oak St - the guard compares whole lines (FW2-1)', async () => {
    const { deps, records } = makeDeps();
    const earlier = '[Auto - Jul 10] 112 Oak St, Decatur: likes it';
    const outcome = await run(deps, makeContact({ type: 'tenant', notes: earlier }), {
      fields: {}, noteLines: [note('12 Oak St, Decatur: likes it')],
    });
    expect(outcome.appendedLines).toEqual(['12 Oak St, Decatur: likes it']);
    expect(records.updates[0]!.patch['notes']).toBe(`${earlier}\n[Auto - Jul 16] 12 Oak St, Decatur: likes it`);
  });

  it('drops a fact re-extracted from an old message on a later day, writes the new one (any-date guard, handback ruling)', async () => {
    const { deps, records } = makeDeps();
    const earlier = '[Auto - Jul 10] 412 Oak Ave, Decatur: on the fence\n[Auto - Jul 12] works nights downtown';
    const outcome = await run(deps, makeContact({ type: 'tenant', notes: earlier }), {
      fields: {}, noteLines: [note('works nights downtown'), note('412 Oak Ave, Decatur: now likes it')],
    });
    expect(outcome.appendedLines).toEqual(['412 Oak Ave, Decatur: now likes it']);
    expect(records.updates[0]!.patch['notes']).toBe(`${earlier}\n[Auto - Jul 16] 412 Oak Ave, Decatur: now likes it`);
  });

  it('writes a new line the model copied with an old prefix under ONE prefix, and drops a copied old line (R3-4)', async () => {
    const { deps, records } = makeDeps();
    const earlier = '[Auto - Jul 10] works nights downtown';
    const outcome = await run(deps, makeContact({ type: 'tenant', notes: earlier }), {
      fields: {}, noteLines: [note('[Auto - Jul 10] works nights downtown'), note('[Auto - Jul 10] has a car')],
    });
    expect(outcome.appendedLines).toEqual(['has a car']);
    expect(records.updates[0]!.patch['notes']).toBe(`${earlier}\n[Auto - Jul 16] has a car`);
  });

  it('a demoted run appends NO line of either kind and emits nothing for notes', async () => {
    const { deps, records } = makeDeps({ findByPhone: async () => makeContact({ contactId: 'other', type: 'tenant' }) });
    const outcome = await applyExtraction(deps, {
      orgEntries: ORG_ENTRIES,
      contact: makeContact({ type: 'tenant' }),
      conversationId: CONV,
      cursorTsMsgId: 'ts-9',
      result: { fields: {}, noteLines: [note('works nights downtown')], phoneAddition: { phone: '555-010-9999' } },
      hasInferredRoleContent: true,
    });
    expect(outcome.notedLines).toBe(0);
    expect(outcome.notesDemoted).toBe(2);
    expect(records.updates).toHaveLength(0);
    expect(records.emits).toHaveLength(0);
  });

  it('drops a legacy string item without throwing (only the fake driver can deliver one, WI1)', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {}, noteLines: ['a legacy string line'] as unknown as ExtractionResult['noteLines'],
    });
    expect(outcome.notedLines).toBe(0);
    expect(records.updates).toHaveLength(0);
  });
});

// WP1 B1 spec D5.3: the job counts feedback lines over what apply APPENDED, so
// apply reports the appended lines themselves - bare text, no prefix, exactly
// the lines joined into notes. A feedback line is an ordinary Notes line: it
// passes the D4 path unchanged (no new filter, no shape check, no rewrite).
describe('applyExtraction - appendedLines (WP1 B1 spec D5.3)', () => {
  const FEEDBACK = '123 Main St, Decatur: on the fence - likes the yard, worried about the commute';

  it('carries the bare text of each appended line, model lines then system lines; a free-form feedback line unchanged', async () => {
    const { deps, records } = makeDeps({
      findByPhone: async () => makeContact({ contactId: 'other', type: 'tenant' }),
    });
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {},
      phoneAddition: { phone: '555-010-9999' },
      noteLines: [
        { text: FEEDBACK, confidence: 0.9 },
        { text: 'Works nights downtown', confidence: 0.8 },
      ],
    });
    const system = 'Mentioned number +15550109999 which belongs to another contact';
    expect(outcome.appendedLines).toEqual([FEEDBACK, 'Works nights downtown', system]);
    expect(outcome.notedLines).toBe(3);
    const noteUpdate = records.updates.find((u) => typeof u.patch['notes'] === 'string');
    expect(noteUpdate!.patch['notes']).toBe(
      [FEEDBACK, 'Works nights downtown', system].map((line) => `[Auto - Jul 16] ${line}`).join('\n'),
    );
  });

  it('leaves out a line the retry guard finds already in the notes', async () => {
    const { deps } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant', notes: `[Auto - Jul 16] ${FEEDBACK}` }), {
      fields: {},
      noteLines: [
        { text: FEEDBACK, confidence: 0.9 },
        { text: 'Works nights downtown', confidence: 0.9 },
      ],
    });
    expect(outcome.appendedLines).toEqual(['Works nights downtown']);
    expect(outcome.notedLines).toBe(1);
  });

  it('is empty when the notes write fails - nothing was appended', async () => {
    const { deps } = makeDeps({
      updateImpl: async () => {
        throw new Error('contacts down');
      },
    });
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {},
      noteLines: [{ text: FEEDBACK, confidence: 0.9 }],
    });
    expect(outcome.appendedLines).toEqual([]);
    expect(outcome.notedLines).toBe(0);
  });
});

// WP1 B2a spec D14.1 / D14.2: applyExtraction writes the collapsed line and
// reports the retry guard's drops as notesDuplicate.
describe('applyExtraction - collapsed lines and the duplicate count (WP1 B2a D14.1, D14.2)', () => {
  it('reports the lines the retry guard dropped as notesDuplicate', async () => {
    const { deps } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant', notes: 'seed\n[Auto - Jul 10] alpha' }), {
      fields: {}, noteLines: [note('alpha'), note('bravo')],
    });
    expect(outcome.notedLines).toBe(1);
    expect(outcome.notesDuplicate).toBe(1);
  });

  it('(PIN) writes a model line holding a break as ONE prefixed line', async () => {
    const { deps, records } = makeDeps();
    const outcome = await run(deps, makeContact({ type: 'tenant' }), {
      fields: {}, noteLines: [note('412 Oak Ave, Decatur: on the fence\nworried about the commute')],
    });
    expect(outcome.appendedLines).toEqual(['412 Oak Ave, Decatur: on the fence / worried about the commute']);
    expect(records.updates[0]!.patch['notes']).toBe('[Auto - Jul 16] 412 Oak Ave, Decatur: on the fence / worried about the commute');
  });
});
