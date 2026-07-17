// Apply service - the guarded write policy (conversation-fact-extraction T5,
// spec 4.4/4.5). Takes ONE ExtractionResult for a contact and applies it:
//
//   - write empty (or model-judged-equivalent) fields directly, stamping
//     per-field `<field>_source` provenance and auditing from/to;
//   - queue a pending SUGGESTION when the model flagged a genuine conflict, or
//     for status-advance / type-classification / a novel phone number;
//   - append secondary facts to the contact's notes.
//
// Every side-effect is BEST-EFFORT (try/catch + log): a suggestion failure must
// never abort a field write, and a notes failure must never lose a suggestion.
// The outcome reflects only the mutations that actually succeeded. A single
// `suggestion.updated` event fires at the end when anything changed.
//
// PII: never log message bodies or phone numbers - only ids/field names/counts.
import type { ContactItem, ContactType, createContactsRepo } from '../../repos/contactsRepo.js';
import { contactPhones } from '../../repos/contactsRepo.js';
import type { createExtractionRepo } from '../../repos/extractionRepo.js';
import type { ExtractableField, ExtractionResult } from '../../adapters/extraction.js';
import { normalizeToE164 } from '../../lib/phone.js';
import { EXTRACTABLE_FIELDS, HOUSING_AUTHORITY_VOCAB } from './schema.js';
import type { Logger } from '../../lib/logger.js';

export interface ApplyDeps {
  contacts: Pick<ReturnType<typeof createContactsRepo>, 'update' | 'addPhone' | 'findByPhone'>;
  extraction: Pick<ReturnType<typeof createExtractionRepo>, 'putSuggestion' | 'deleteSuggestion'>;
  audit: { append(entityKey: string, type: string, payload?: Record<string, unknown>): Promise<unknown> };
  events: { emit(name: string, payload: unknown): void };
  logger: Logger;
  now(): string; // ISO
}

export interface ApplyOutcome {
  /** Field names directly written. */
  wrote: string[];
  /** Suggestion targets upserted (firstName..porting | status | type | phone). */
  suggested: string[];
  /** Count of note lines appended. */
  notedLines: number;
}

/** firstName/lastName apply for tenant AND unknown contacts. */
const NAME_FIELDS: readonly ExtractableField[] = ['firstName', 'lastName'];

const MAX_TEXT_CHARS = 120;
const MAX_NOTE_LINES = 5;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

type Coerced = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Coerce/validate a raw string op value per its field. Invalid -> ok:false
 * (caller skips + logs). voucherSize -> int 0..12; porting -> boolean;
 * housingAuthority -> controlled vocabulary; names/pets/evictions/tenure ->
 * non-empty trimmed string <= 120 chars.
 */
function coerceField(field: ExtractableField, raw: string | undefined): Coerced {
  if (raw === undefined) return { ok: false, reason: 'no value supplied' };
  const trimmed = raw.trim();
  switch (field) {
    case 'voucherSize': {
      if (!/^\d+$/.test(trimmed)) return { ok: false, reason: 'voucherSize is not a digit string' };
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 0 || n > 12) {
        return { ok: false, reason: 'voucherSize is outside 0..12' };
      }
      return { ok: true, value: n };
    }
    case 'porting': {
      if (trimmed === 'true') return { ok: true, value: true };
      if (trimmed === 'false') return { ok: true, value: false };
      return { ok: false, reason: 'porting is not true|false' };
    }
    case 'housingAuthority': {
      if (!HOUSING_AUTHORITY_VOCAB.includes(trimmed)) {
        return { ok: false, reason: 'housingAuthority is off-vocabulary' };
      }
      return { ok: true, value: trimmed };
    }
    default: {
      // firstName / lastName / pets / evictions / tenure - free text.
      if (trimmed.length === 0) return { ok: false, reason: 'empty after trim' };
      if (trimmed.length > MAX_TEXT_CHARS) return { ok: false, reason: 'exceeds 120 chars' };
      return { ok: true, value: trimmed };
    }
  }
}

/** Which fields a contact of this type may have written/suggested. */
function fieldApplies(field: ExtractableField, type: ContactType): boolean {
  if (NAME_FIELDS.includes(field)) return type === 'tenant' || type === 'unknown';
  // Remaining (voucherSize/housingAuthority/pets/evictions/tenure/porting) are
  // tenant facts.
  return type === 'tenant';
}

/** `[Auto - Jul 16]` - month/day (UTC, deterministic) from deps.now(). */
function autoPrefix(nowIso: string): string {
  const d = new Date(nowIso);
  const month = MONTHS[d.getUTCMonth()] ?? 'Jan';
  return `[Auto - ${month} ${d.getUTCDate()}]`;
}

export async function applyExtraction(
  deps: ApplyDeps,
  ctx: { contact: ContactItem; conversationId: string; cursorTsMsgId?: string; result: ExtractionResult },
): Promise<ApplyOutcome> {
  const { contact, conversationId, cursorTsMsgId, result } = ctx;
  const { logger, now } = deps;
  const contactId = contact.contactId;
  const at = now();

  const wrote: string[] = [];
  const suggested: string[] = [];
  const noteStrings: string[] = [];

  // Per-field provenance stamp (generalizes status_source; A1 adjudication).
  const sourceStamp = {
    source: 'ai' as const,
    at,
    conversationId,
    ...(cursorTsMsgId !== undefined && { tsMsgId: cursorTsMsgId }),
  };

  // --- 1-4. Field ops ------------------------------------------------------
  const writePatch: Record<string, unknown> = {};
  const auditFields: Array<{ field: string; from: unknown; to: unknown; reason?: string }> = [];
  const pendingWrites: string[] = [];

  for (const field of EXTRACTABLE_FIELDS) {
    const fieldOp = result.fields[field];
    if (!fieldOp || fieldOp.op === 'none') continue;

    if (!fieldApplies(field, contact.type)) {
      logger.debug({ contactId, field, contactType: contact.type }, 'extraction field op ignored for contact type');
      continue;
    }

    const coerced = coerceField(field, fieldOp.value);
    if (!coerced.ok) {
      logger.debug({ contactId, field, reason: coerced.reason }, 'extraction field op skipped (invalid value)');
      continue;
    }

    if (fieldOp.op === 'write') {
      writePatch[field] = coerced.value;
      writePatch[`${field}_source`] = sourceStamp;
      auditFields.push({
        field,
        from: contact[field],
        to: coerced.value,
        ...(fieldOp.reason !== undefined && { reason: fieldOp.reason }),
      });
      pendingWrites.push(field);
    } else {
      // op === 'suggest'. Belt-and-braces: skip when the suggestion string-equals
      // the current value exactly.
      const currentValue = contact[field] !== undefined ? String(contact[field]) : undefined;
      const suggestedValue = String(coerced.value);
      if (currentValue !== undefined && currentValue === suggestedValue) {
        logger.debug({ contactId, field }, 'extraction suggestion skipped (equal to current)');
        continue;
      }
      const ok = await putSuggestionSafe(deps, {
        ownerContactId: contactId,
        target: field,
        ...(currentValue !== undefined && { currentValue }),
        suggestedValue,
        ...(fieldOp.reason !== undefined && { reason: fieldOp.reason }),
        conversationId,
        ...(cursorTsMsgId !== undefined && { tsMsgId: cursorTsMsgId }),
      });
      if (ok) suggested.push(field);
    }
  }

  // Commit all direct field writes in ONE update patch (best-effort). Only mark
  // them `wrote` once the update actually lands.
  if (pendingWrites.length > 0) {
    try {
      await deps.contacts.update(contactId, writePatch);
      wrote.push(...pendingWrites);
      // Audit the batch (best-effort; a failed audit never un-does the write).
      try {
        await deps.audit.append(`contacts#${contactId}`, 'ai_extraction_applied', {
          fields: auditFields,
          conversationId,
        });
      } catch (err) {
        logger.warn({ contactId, err }, 'extraction audit append failed (write persisted)');
      }
    } catch (err) {
      logger.warn({ contactId, err }, 'extraction field write failed');
    }
  }

  // --- 5. statusAdvance ----------------------------------------------------
  if (result.statusAdvance?.suggest === true) {
    if (contact.type === 'tenant' && contact.status === 'onboarding') {
      const ok = await putSuggestionSafe(deps, {
        ownerContactId: contactId,
        target: 'status',
        currentValue: contact.status,
        suggestedValue: 'searching',
        ...(result.statusAdvance.reason !== undefined && { reason: result.statusAdvance.reason }),
        conversationId,
        ...(cursorTsMsgId !== undefined && { tsMsgId: cursorTsMsgId }),
      });
      if (ok) suggested.push('status');
    } else {
      logger.debug(
        { contactId, contactType: contact.type, status: contact.status },
        'statusAdvance ignored (not an onboarding tenant)',
      );
    }
  }

  // --- 6. typeSuggestion ---------------------------------------------------
  if (result.typeSuggestion) {
    if (contact.type === 'unknown') {
      const ok = await putSuggestionSafe(deps, {
        ownerContactId: contactId,
        target: 'type',
        currentValue: contact.type,
        suggestedValue: result.typeSuggestion.value,
        ...(result.typeSuggestion.reason !== undefined && { reason: result.typeSuggestion.reason }),
        conversationId,
        ...(cursorTsMsgId !== undefined && { tsMsgId: cursorTsMsgId }),
      });
      if (ok) suggested.push('type');
    } else {
      logger.debug({ contactId, contactType: contact.type }, 'typeSuggestion ignored (contact already classified)');
    }
  }

  // --- 7. phoneAddition ----------------------------------------------------
  if (result.phoneAddition) {
    const e164 = normalizeToE164(result.phoneAddition.phone);
    if (e164 === undefined) {
      logger.debug({ contactId }, 'phoneAddition ignored (not canonicalizable)');
    } else if (contactPhones(contact).some((p) => p.phone === e164)) {
      logger.debug({ contactId }, 'phoneAddition ignored (already owned by contact)');
    } else {
      let ownedByOther = false;
      try {
        const owner = await deps.contacts.findByPhone(e164);
        ownedByOther = owner !== undefined && owner.contactId !== contactId;
      } catch (err) {
        logger.warn({ contactId, err }, 'phoneAddition findByPhone failed - treating as unowned');
      }
      if (ownedByOther) {
        // Do NOT suggest a number that belongs to someone else; leave a note.
        noteStrings.push(`Mentioned number ${e164} which belongs to another contact`);
      } else {
        const label = result.phoneAddition.label;
        const reason = result.phoneAddition.reason;
        const combinedReason =
          label !== undefined && reason !== undefined
            ? `${label}: ${reason}`
            : (label ?? reason);
        const ok = await putSuggestionSafe(deps, {
          ownerContactId: contactId,
          target: 'phone',
          suggestedValue: e164,
          ...(combinedReason !== undefined && { reason: combinedReason }),
          conversationId,
          ...(cursorTsMsgId !== undefined && { tsMsgId: cursorTsMsgId }),
        });
        if (ok) suggested.push('phone');
      }
    }
  }

  // --- 8. noteLines --------------------------------------------------------
  let notedLines = 0;
  const rawNotes = [...(result.noteLines ?? []), ...noteStrings];
  const cleaned = rawNotes.map((line) => line.trim()).filter((line) => line.length > 0).slice(0, MAX_NOTE_LINES);
  if (cleaned.length > 0) {
    const prefix = autoPrefix(at);
    const joined = cleaned.map((line) => `${prefix} ${line}`).join('\n');
    // Read-modify-write on the ctx.contact snapshot. This can lose a concurrent
    // human notes edit made between the snapshot read and this write; the race
    // is ACCEPTED (single scalar attribute, low write frequency) rather than
    // paying for an optimistic-concurrency retry loop on a low-stakes field.
    const existing = typeof contact.notes === 'string' ? contact.notes.trim() : '';
    const nextNotes = existing.length > 0 ? `${existing}\n${joined}` : joined;
    try {
      await deps.contacts.update(contactId, { notes: nextNotes });
      notedLines = cleaned.length;
    } catch (err) {
      logger.warn({ contactId, err }, 'extraction notes append failed');
    }
  }

  // --- 10. emit once when anything changed ---------------------------------
  if (wrote.length + suggested.length + notedLines > 0) {
    deps.events.emit('suggestion.updated', { contactId });
  }

  return { wrote, suggested, notedLines };
}

/**
 * Best-effort putSuggestion: returns true when the upsert succeeded, false (and
 * logs) when it threw - so a single suggestion failure never aborts the rest of
 * the apply pass or gets counted as a success.
 */
async function putSuggestionSafe(
  deps: ApplyDeps,
  s: Parameters<ApplyDeps['extraction']['putSuggestion']>[0],
): Promise<boolean> {
  try {
    await deps.extraction.putSuggestion(s);
    return true;
  } catch (err) {
    deps.logger.warn({ contactId: s.ownerContactId, target: s.target, err }, 'putSuggestion failed');
    return false;
  }
}
