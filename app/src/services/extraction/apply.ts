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
import {
  ADDRESS_PART_KEYS,
  cleanAddressParts,
  contactAddressToParts,
  formatAddressParts,
  normalizeAddressForCompare,
} from './address.js';
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
  ctx: {
    contact: ContactItem;
    conversationId: string;
    cursorTsMsgId?: string;
    result: ExtractionResult;
    // Spec Layer 3: when the assembled window contained ANY inferred-role
    // (unknown-speaker) utterance, the whole run is demoted to suggest-only.
    // OPTIONAL/defaulted-false so slice-1 callers/tests are unaffected.
    hasInferredRoleContent?: boolean;
  },
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
  // Fields whose op:'write' was demoted to a suggestion (spec Layer 3 audit).
  const demotedFields: string[] = [];

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

    if (fieldOp.op === 'write' && ctx.hasInferredRoleContent !== true) {
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
      // op === 'suggest', OR a demoted op:'write' (inferred-role content, spec
      // Layer 3): route the write through the SAME suggest path - no direct write,
      // no <field>_source provenance stamped (nothing is written).
      if (fieldOp.op === 'write') demotedFields.push(field);
      // Belt-and-braces: skip when the suggestion string-equals the current value.
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

  // --- address (compound ninth target; spec 2026-07-20 SS5) ------------------
  // Rides the SAME batched contacts.update + ai_extraction_applied audit as the
  // scalar field writes above (block placed before the commit). Tenant-only:
  // landlord/team_member/unknown conversations are saturated with PROPERTY
  // addresses, so the false-positive cost dominates any triage value.
  if (result.address !== undefined) {
    if (contact.type !== 'tenant') {
      logger.debug({ contactId, contactType: contact.type }, 'extraction address ignored for contact type');
    } else {
      const parts = cleanAddressParts(result.address.parts);
      const formattedNew = formatAddressParts(parts);
      if (formattedNew.length === 0) {
        logger.debug({ contactId }, 'extraction address skipped (no usable parts)');
      } else {
        const currentParts = contactAddressToParts(contact['address']);
        const formattedCurrent = formatAddressParts(currentParts);
        const hasCurrent = formattedCurrent.length > 0;
        // LOSSY occupied write: a stored (non-empty) part that the cleaned new
        // parts do NOT restate would be SILENTLY DROPPED by the whole-object SET
        // replace. Spec 2026-07-20 SS5 allows occupied direct writes as
        // "same-fact-better-form"; a write that would DROP stored parts cannot be
        // better-form, so it is routed to human review instead (adversarial
        // review F1). A key present with a DIFFERENT value is a correction (not a
        // loss); a superset / same-key-set / no-current write is not lossy.
        const lossy =
          hasCurrent &&
          ADDRESS_PART_KEYS.some((k) => {
            const cur = currentParts[k];
            return typeof cur === 'string' && cur.length > 0 && parts[k] === undefined;
          });
        if (result.address.op === 'write' && ctx.hasInferredRoleContent !== true && !lossy) {
          writePatch['address'] = parts;
          writePatch['address_source'] = sourceStamp;
          // from/to are FORMATTED single-line strings (never the raw object) so
          // the audit shape stays flat; from is undefined when there was none.
          auditFields.push({
            field: 'address',
            from: hasCurrent ? formattedCurrent : undefined,
            to: formattedNew,
            ...(result.address.reason !== undefined && { reason: result.address.reason }),
          });
          pendingWrites.push('address');
        } else {
          // A write reaches this suggest branch for one of two reasons. Only the
          // Layer-3 inferred-role demotion feeds demotedFields (the
          // ai_extraction_demoted audit is reserved for it); a lossy demotion
          // gets its own PII-safe debug line ({ contactId } only - never parts).
          if (result.address.op === 'write' && ctx.hasInferredRoleContent === true) {
            demotedFields.push('address');
          } else if (result.address.op === 'write' && lossy) {
            logger.debug({ contactId }, 'extraction address write demoted to suggestion (would drop stored parts)');
          }
          if (
            hasCurrent &&
            normalizeAddressForCompare(formattedCurrent) === normalizeAddressForCompare(formattedNew)
          ) {
            logger.debug({ contactId }, 'extraction address suggestion skipped (equal to current)');
          } else {
            const ok = await putSuggestionSafe(deps, {
              ownerContactId: contactId,
              target: 'address',
              ...(hasCurrent && { currentValue: formattedCurrent }),
              suggestedValue: formattedNew, // display string (the chip)
              suggestedAddress: parts, // parts payload (what accept writes)
              ...(result.address.reason !== undefined && { reason: result.address.reason }),
              conversationId,
              ...(cursorTsMsgId !== undefined && { tsMsgId: cursorTsMsgId }),
            });
            if (ok) suggested.push('address');
          }
        }
      }
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

  // Inferred-role demotion audit (spec Layer 3). The write-audit above sits
  // inside the pendingWrites block, which is empty under full demotion, so the
  // demotion records its own best-effort append. Field NAMES + the role map are
  // labels (not transcript text or phone numbers) - safe to log.
  if (ctx.hasInferredRoleContent === true && demotedFields.length > 0) {
    try {
      await deps.audit.append(`contacts#${contactId}`, 'ai_extraction_demoted', {
        fields: demotedFields,
        ...(result.speakerRoles !== undefined && { speakerRoles: result.speakerRoles }),
        conversationId,
      });
    } catch (err) {
      logger.warn({ contactId, err }, 'extraction demotion audit append failed');
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
  // Addresses are a structured target now - a model that still narrates one into
  // noteLines is overridden deterministically (spec SS5); the prompt forbids it,
  // this filter makes the ban belt-and-braces. The digit requirement keeps the
  // filter to POSTAL lines (a street/zip always carries one) so digit-free
  // housing-STATUS facts ("Current address is unstable, couch-surfing") survive.
  const rawNotes = [...(result.noteLines ?? []), ...noteStrings].filter(
    (line) => !(/^current address\b/i.test(line.trim()) && /\d/.test(line)),
  );
  const cleaned = rawNotes.map((line) => line.trim()).filter((line) => line.length > 0).slice(0, MAX_NOTE_LINES);
  if (cleaned.length > 0) {
    const prefix = autoPrefix(at);
    // Read-modify-write on the ctx.contact snapshot. This can lose a concurrent
    // human notes edit made between the snapshot read and this write; the race
    // is ACCEPTED (single scalar attribute, low write frequency) rather than
    // paying for an optimistic-concurrency retry loop on a low-stakes field.
    const existing = typeof contact.notes === 'string' ? contact.notes.trim() : '';
    // Belt-and-braces idempotency guard (adversarial F1): applyExtraction runs
    // BEFORE repo.complete(), so a complete() failure re-arms the SAME due row and
    // the retry re-extracts the identical transcript against a contact that already
    // carries run 1's appended line. Drop any candidate whose formatted
    // `[Auto - <date>] <line>` OR bare `<line>` is already present verbatim in the
    // current notes, so the retry appends nothing (the deterministic FAKE driver
    // double-appends every time otherwise; the anthropic driver only usually does).
    const toAppend = cleaned.filter(
      (line) => !existing.includes(`${prefix} ${line}`) && !existing.includes(line),
    );
    if (toAppend.length > 0) {
      const joined = toAppend.map((line) => `${prefix} ${line}`).join('\n');
      const nextNotes = existing.length > 0 ? `${existing}\n${joined}` : joined;
      try {
        await deps.contacts.update(contactId, { notes: nextNotes });
        notedLines = toAppend.length;
      } catch (err) {
        logger.warn({ contactId, err }, 'extraction notes append failed');
      }
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
