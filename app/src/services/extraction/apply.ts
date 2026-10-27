// Apply service - the guarded write policy (conversation-fact-extraction T5,
// spec 4.4/4.5). Takes ONE ExtractionResult for a contact and applies it:
//
//   - write empty (or model-judged-equivalent) fields directly, stamping
//     per-field `<field>_source` provenance and auditing from/to;
//   - queue a pending SUGGESTION when the model flagged a genuine conflict, or
//     for status-advance / type-classification / a novel phone number;
//   - append Notes lines to the contact's notes - every value rule (clamp,
//     confidence floor, retry guard, cap, demotion) is filterNoteLines.
//
// Every side-effect is BEST-EFFORT (try/catch + log): a suggestion failure must
// never abort a field write, and a notes failure must never lose a suggestion.
// The outcome reflects only the mutations that actually succeeded. A single
// `suggestion.updated` event fires at the end when anything changed.
//
// PII: never log message bodies or phone numbers - only ids/field names/counts.
import type { ContactItem, ContactType, createContactsRepo } from '../../repos/contactsRepo.js';
import { contactClassificationRevision, contactPhones } from '../../repos/contactsRepo.js';
import { SuggestionDismissedError } from '../../repos/extractionRepo.js';
import type { createExtractionRepo, SuggestionItem } from '../../repos/extractionRepo.js';
import type { ExtractableField, ExtractionResult } from '../../adapters/extraction.js';
import { normalizeToE164 } from '../../lib/phone.js';
import { EXTRACTABLE_FIELDS, normalizeSuggestionValue } from './schema.js';
import { KINDS_FOR_FIELD, resolveOrgText, type OrgEntry } from '../../lib/orgNames.js';
import {
  ADDRESS_PART_KEYS,
  cleanAddressParts,
  contactAddressToParts,
  formatAddressParts,
  normalizeAddressForCompare,
} from './address.js';
import type { Logger } from '../../lib/logger.js';
import type { DropReason } from './runTypes.js';
import {
  TENANT_MATCHING_DOLLARS_MAX,
  TENANT_MATCHING_INPUTS,
  TENANT_MATCHING_TEXT_MAX,
  type TenantMatchingInputKind,
} from '../../lib/tenantMatchingInputs.js';

export interface ApplyDeps {
  contacts: Pick<ReturnType<typeof createContactsRepo>, 'getById' | 'update' | 'addPhone' | 'findByPhone'>;
  extraction: Pick<
    ReturnType<typeof createExtractionRepo>,
    'putSuggestion' | 'deleteSuggestion' | 'deleteTypeSuggestionIfCurrentAtContactRevision' | 'hasDismissal'
  >;
  audit: { append(entityKey: string, type: string, payload?: Record<string, unknown>): Promise<unknown> };
  events: { emit(name: string, payload: unknown): void };
  logger: Logger;
  now(): string; // ISO
  /**
   * EXTRACTION_FACT_MIN_CONFIDENCE (lib/config.ts, B1 spec D4): the floor
   * filterNoteLines applies to model note lines. REQUIRED, so a missed
   * construction site (worker.ts, routes/dev.ts, the test harnesses) is a
   * typecheck failure, never a silently unfloored run.
   */
  factMinConfidence: number;
}

export interface ApplyOutcome {
  /** Field names directly written. */
  wrote: string[];
  /** Suggestion targets upserted (firstName..porting | status | type | phone). */
  suggested: string[];
  /** Count of note lines appended. */
  notedLines: number;
  /**
   * WP1 B1 spec D5.3: the bare text (no `[Auto - <date>]` prefix) of each line
   * appended this run, model lines then system lines, exactly as joined into
   * `notes`; [] when nothing was appended or the write failed, so
   * `notedLines === appendedLines.length`. The job counts feedback lines over
   * it. Contact PII by design: never logged.
   */
  appendedLines: string[];
  /** Model note lines dropped below the confidence floor (B1 spec D4). */
  notesBelowFloor: number;
  /** Note lines a demoted run withheld (B1 spec D4); 0 when not demoted. */
  notesDemoted: number;
  /** Earlier run suggestions this apply pass replaced. */
  displaced: Array<{ target: string; runId: string; createdAt: string }>;
  /** One entry per target written, suggested, or discarded. Note lines are not targets. */
  decisions: ApplyDecision[];
}

/** What apply did with one target, and why. Values are contact PII by design. */
export interface ApplyDecision {
  target: string;
  outcome: 'wrote' | 'suggested' | 'dropped';
  proposedValue?: string;
  coercedValue?: unknown;
  previousValue?: string;
  reason?: string;
  demotedFrom?: 'write';
  dropReason?: DropReason;
}

/** firstName/lastName apply for tenant AND unknown contacts. */
const NAME_FIELDS: readonly ExtractableField[] = ['firstName', 'lastName'];

const MAX_TEXT_CHARS = 120;
/** At most this many Notes lines are appended per run (model lines first). */
const MAX_NOTE_LINES = 5;
/** A Notes line's text is clamped to this many characters (B1 spec D4). */
const MAX_NOTE_CHARS = 200;
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

export type Coerced = { ok: true; value: unknown } | { ok: false; reason: string };

/** B1 spec D1/D3: each tenant matching input's kind, keyed by field, from the list. */
const MATCHING_KIND: ReadonlyMap<string, TenantMatchingInputKind> = new Map(
  TENANT_MATCHING_INPUTS.map((input) => [input.key, input.kind] as const),
);

/**
 * Coerce/validate a raw string op value per its field. Invalid -> ok:false
 * (caller skips + logs). PURE and exported: the accept path
 * (suggestionResolution.ts coerceAccept) and the never-written probe (B1 spec
 * D7) use this exact rule.
 *
 * A tenant matching input coerces by its KIND (B1 spec D3), never by name:
 *   - text: trimmed; empty -> dropped; over TENANT_MATCHING_TEXT_MAX (the
 *     staff cap) -> DROPPED, never truncated (an extraction value only fills
 *     or replaces a field, so it has no reason to grow);
 *   - dollars: `$`, commas and spaces stripped, then a whole number
 *     0..TENANT_MATCHING_DOLLARS_MAX; anything else (1200.50 included) is
 *     dropped, never rounded.
 * The eight original fields: voucherSize -> int 0..12; porting -> boolean;
 * housingAuthority -> trimmed, whitespace-collapsed text <= 120 chars (the
 * field loop resolves it against the organization list); names/pets/
 * evictions/tenure -> non-empty trimmed string <= 120 chars.
 */
export function coerceField(field: ExtractableField, raw: string | undefined): Coerced {
  if (raw === undefined) return { ok: false, reason: 'no value supplied' };
  const trimmed = raw.trim();
  const kind = MATCHING_KIND.get(field);
  if (kind === 'text') {
    if (trimmed.length === 0) return { ok: false, reason: 'empty after trim' };
    if (trimmed.length > TENANT_MATCHING_TEXT_MAX) {
      return { ok: false, reason: `exceeds ${TENANT_MATCHING_TEXT_MAX} chars` };
    }
    return { ok: true, value: trimmed };
  }
  if (kind === 'dollars') {
    const digits = trimmed.replace(/[$,\s]/g, '');
    if (!/^\d+$/.test(digits)) return { ok: false, reason: 'not a whole dollar amount' };
    const dollars = Number(digits);
    if (dollars > TENANT_MATCHING_DOLLARS_MAX) {
      return { ok: false, reason: `exceeds ${TENANT_MATCHING_DOLLARS_MAX}` };
    }
    return { ok: true, value: dollars };
  }
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
      // Shape checks only. The field loop resolves the text against the stored
      // organization list (spec 2026-10-06 D8 + D4), where the run's list is in
      // scope. Whitespace runs collapse to one space, as the old alias
      // normalizer did, so text that is suggested as said stays tidy. A client
      // naming an authority we do not know is data, not a validation error.
      if (trimmed.length === 0) return { ok: false, reason: 'empty after trim' };
      if (trimmed.length > MAX_TEXT_CHARS) return { ok: false, reason: 'exceeds 120 chars' };
      return { ok: true, value: trimmed.replace(/\s+/g, ' ') };
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
  // Remaining (voucherSize/housingAuthority/pets/evictions/tenure/porting and
  // the tenant matching inputs, B1 spec D3) are tenant facts.
  return type === 'tenant';
}

/** A stored text value that holds something (whitespace-only reads as empty). */
function isFilledText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** `[Auto - Jul 16]` - month/day (UTC, deterministic) from deps.now(). */
function autoPrefix(nowIso: string): string {
  const d = new Date(nowIso);
  const month = MONTHS[d.getUTCMonth()] ?? 'Jan';
  return `[Auto - ${month} ${d.getUTCDate()}]`;
}

/**
 * A line's leading autoPrefix, whatever its date - the shape lib/caseworkers.ts
 * AUTO_PREFIX also reads. filterNoteLines removes it from a model line before
 * the retry guard and the write, and from both sides of a system line's
 * comparison (FW3-1).
 */
const LEADING_AUTO_PREFIX = /^\[Auto - [^\]]+\]/;

/**
 * The line trimmed, with EVERY leading autoPrefix removed (FW3-1, code review
 * R3-4): a model that copies a notes line copies its prefix too - even a
 * doubled one - and this run writes its own, so the box never gets two.
 */
function withoutAutoPrefix(line: string): string {
  let out = line.trim();
  while (LEADING_AUTO_PREFIX.test(out)) out = out.replace(LEADING_AUTO_PREFIX, '').trim();
  return out;
}

/** What filterNoteLines needs. Every field is plain data - the function is pure. */
export interface NoteLineFilterInput {
  /**
   * result.noteLines AS RECEIVED. Typed unknown[] on purpose: the fake driver
   * hands its marker payload over without parseExtractionText
   * (adapters/extractionFake.ts, the marker merge; B1 WI1), so an item may be
   * any shape.
   */
  modelLines: readonly unknown[] | undefined;
  /** System lines (today only the phone-owned-by-other note): no confidence, never floored. */
  systemLines: readonly string[];
  /** EXTRACTION_FACT_MIN_CONFIDENCE (lib/config.ts), 0 < floor <= 1. */
  floor: number;
  /** The contact's current notes, trimmed ('' when none) - the lines the retry guard compares against. */
  existingNotes: string;
  /**
   * The `[Auto - <MMM D>]` prefix this run appends with (autoPrefix). The
   * retry guard compares a model line AS THIS RUN WRITES IT, `<prefix> <line>`
   * (FW3-1), so the prefix's date is what limits that guard to the same day.
   * The probe's seam passes a fixed one (plan PR30).
   */
  prefix: string;
  /** hasInferredRoleContent: a demoted run appends no line (charter 6.4). */
  demoted: boolean;
}

export interface NoteLineFilterResult {
  /** Bare lines to append (no prefix): model lines first, then system lines, at most MAX_NOTE_LINES. */
  append: string[];
  /** How many leading entries of `append` are model lines - append.slice(0, modelCount). */
  modelCount: number;
  /** Model items dropped below the floor. */
  belowFloor: number;
  /** Lines a demoted run withheld; 0 when not demoted. */
  demoted: number;
}

/** A model confidence clamped to 0..1; a non-number (or NaN/Infinity) reads as 0. */
function clampConfidence(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
}

/**
 * Every Notes line value rule (B1 spec D4) - the ONE place they live (PR4).
 * PURE: no I/O, no clock, no logger. applyExtraction and the never-written
 * probe (spec D7) both call it, so the fake driver's parser bypass skips
 * nothing. In order:
 *
 *  1. Clamp: text trimmed, every leading `[Auto - <date>]` the model copied
 *     from the notes removed (FW3-1: this run writes its own; never a double
 *     prefix), and cut to MAX_NOTE_CHARS; confidence to 0..1 (a non-number
 *     reads as 0). An item that is not an object with string text is dropped
 *     uncounted (only the fake driver can deliver one).
 *  2. Floor FIRST: a model item below `floor` is dropped and counted.
 *  3. Blank lines and POSTAL lines are dropped. The postal filter drops ONLY
 *     a line that starts with "Current address" and carries a digit - the
 *     client's address narrated in the shape of the structured address
 *     target; the digit requirement keeps a digit-free housing-status fact
 *     ("Current address is unstable, couch-surfing"). It is not an address
 *     ban: B1 removed the prompt's no-address bullet (spec rev 9 D5.2, PR50)
 *     because a feedback line names a sent property by its address label
 *     (PROPERTIES SENT), so a written line may now carry an address.
 *  4. The retry guard (adversarial F1), BEFORE the cap (B1 WI5):
 *     applyExtraction runs BEFORE repo.complete(), so a complete() failure
 *     re-arms the SAME due row and the retry re-extracts the identical
 *     transcript minutes later, against a contact that already carries run
 *     1's lines. That retry is the guard's one purpose (FW3-1, code review R3:
 *     the retry guard decided). It compares WHOLE lines, each trimmed (FW2-1);
 *     a candidate that spans lines must match a run of whole lines.
 *     - A MODEL line is dropped only when, AS THIS RUN WRITES IT
 *       (`<prefix> <line>`), it equals lines already in the notes. The prefix
 *       carries the run's date, so this drops the same-day retry (and a
 *       same-day re-emission of the same words). A line equal to one from an
 *       EARLIER date, or to a bare staff line, is written: a change of mind
 *       back to earlier words is a new line (spec D5.2), and a lost change of
 *       mind costs more than a repeated line.
 *     - A SYSTEM line (apply's own text, which changes no meaning) is dropped
 *       when it equals a line of ANY date, the prefix removed on both sides,
 *       so it is not repeated on every run.
 *     A line merely CONTAINED in a longer one is KEPT: "12 Oak St, ..." inside
 *     "112 Oak St, ...", or a change of mind whose words an earlier line
 *     contains, is new feedback. Accepted costs (R3-adjudications): a retry
 *     that crosses UTC midnight appends its lines once more; a model line
 *     repeated verbatim on a later date is written again; a second run the
 *     same day that flips back to that day's words is dropped. A dropped line
 *     never takes a cap slot.
 *  5. System lines are appended after the model lines; they carry no
 *     confidence and are never floored.
 *  6. The cap: at most MAX_NOTE_LINES, model lines first.
 *  7. Demotion LAST: a demoted run (unknown-speaker content) appends no line
 *     of either kind and reports how many it withheld (charter 6.4; spec Q1).
 */
export function filterNoteLines(input: NoteLineFilterInput): NoteLineFilterResult {
  const isPostal = (line: string): boolean => /^current address\b/i.test(line) && /\d/.test(line);
  // Rule 4 over whole lines: every line trimmed and fenced by '\n' on both
  // sides, so one includes() matches only a run of WHOLE lines, never part of one.
  const physical = (text: string): string[] => text.split('\n').map((part) => part.trim());
  const fenced = (lines: readonly string[]): string => `\n${lines.join('\n')}\n`;
  const existing = physical(input.existingNotes);
  // A model line, as this run writes it, against the lines as stored: the same date only.
  const storedLines = fenced(existing);
  const modelPresent = (line: string): boolean => storedLines.includes(fenced(physical(`${input.prefix} ${line}`)));
  // A system line against every line with its prefix removed: any date.
  const unprefixedLines = fenced(existing.map(withoutAutoPrefix));
  const systemPresent = (line: string): boolean => unprefixedLines.includes(fenced(physical(line).map(withoutAutoPrefix)));

  let belowFloor = 0;
  const model: string[] = [];
  for (const item of input.modelLines ?? []) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const { text, confidence } = item as { text?: unknown; confidence?: unknown };
    if (typeof text !== 'string') continue;
    const line = withoutAutoPrefix(text).slice(0, MAX_NOTE_CHARS).trim();
    if (clampConfidence(confidence) < input.floor) {
      belowFloor += 1;
      continue;
    }
    if (line.length === 0 || isPostal(line) || modelPresent(line)) continue;
    model.push(line);
  }
  const system = input.systemLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isPostal(line) && !systemPresent(line));

  const append = [...model, ...system].slice(0, MAX_NOTE_LINES);
  if (input.demoted) return { append: [], modelCount: 0, belowFloor, demoted: append.length };
  return { append, modelCount: Math.min(model.length, MAX_NOTE_LINES), belowFloor, demoted: 0 };
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
    /** Opaque ai_runs id stamped on every suggestion produced by this apply. */
    runId?: string;
    /**
     * The organization list this run read (spec 2026-10-06 D8): housingAuthority
     * resolves against it (D4). The job passes the SAME snapshot its prompt
     * block was rendered from, so prompt and resolution agree within a run.
     */
    orgEntries: readonly OrgEntry[];
  },
): Promise<ApplyOutcome> {
  const { contact, conversationId, cursorTsMsgId, result } = ctx;
  const { logger, now } = deps;
  const contactId = contact.contactId;
  const at = now();

  const wrote: string[] = [];
  const suggested: string[] = [];
  const displaced: ApplyOutcome['displaced'] = [];
  let suggestionStateChanged = false;
  const decisions: ApplyDecision[] = [];
  const pendingDecisions: ApplyDecision[] = [];
  const decide = (decision: ApplyDecision): void => {
    decisions.push(decision);
  };
  const noteDisplaced = (target: string, prior: SuggestionItem | undefined): void => {
    if (prior?.runId !== undefined) displaced.push({ target, runId: prior.runId, createdAt: prior.createdAt });
  };
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
      decide({
        target: field,
        outcome: 'dropped',
        dropReason: 'wrong_contact_type',
        ...(fieldOp.value !== undefined && { proposedValue: fieldOp.value }),
        ...(fieldOp.reason !== undefined && { reason: fieldOp.reason }),
      });
      continue;
    }

    // B1 spec D3: for a TEXT tenant matching input, op "write" means "fill an
    // EMPTY field" and nothing else. A write on a filled one is dropped - not
    // demoted to a suggestion, and so never in `demotedFields` (the Layer-3
    // audit): an added fact belongs in a Notes line, and a contradiction comes
    // as a `suggest`. Checked BEFORE coercion, so its reason always wins. The
    // dollars kind keeps the pets rule (a same-fact write lands).
    if (fieldOp.op === 'write' && MATCHING_KIND.get(field) === 'text' && isFilledText(contact[field])) {
      logger.debug({ contactId, field }, 'extraction write on a filled text field dropped');
      decide({
        target: field,
        outcome: 'dropped',
        dropReason: 'text_field_filled',
        ...(fieldOp.value !== undefined && { proposedValue: fieldOp.value }),
        ...(fieldOp.reason !== undefined && { reason: fieldOp.reason }),
      });
      continue;
    }

    const coerced = coerceField(field, fieldOp.value);
    if (!coerced.ok) {
      logger.debug({ contactId, field, reason: coerced.reason }, 'extraction field op skipped (invalid value)');
      decide({
        target: field,
        outcome: 'dropped',
        dropReason: 'invalid_value',
        ...(fieldOp.value !== undefined && { proposedValue: fieldOp.value }),
        ...(fieldOp.reason !== undefined && { reason: fieldOp.reason }),
      });
      continue;
    }

    // Spec 2026-10-06 D8: a housing authority is resolved (D4) against the
    // organization list this run read (ctx.orgEntries - the snapshot its prompt
    // block was rendered from). A match is handled exactly as a known authority
    // always was: the model's op still decides write or suggest, and the value
    // written or suggested is the entry's exact NAME. An agency name is never a
    // housing authority: it is dropped (agency_not_authority) - never written,
    // never suggested. Anything else - ambiguous, compound, unknown - is valid
    // but not yet trusted, so it is SUGGESTED as said: a phone transcript can
    // mishear, and a staff confirmation is where a genuinely new authority is
    // added to the list.
    //
    // A not-on-the-list demotion is deliberately NOT pushed onto demotedFields:
    // that list feeds the `ai_extraction_demoted` audit, which means Layer-3
    // inferred-role demotion specifically. The per-decision `demotedFrom:
    // 'write'` below records it without overloading that audit's meaning.
    let value: unknown = coerced.value;
    let notOnList = false;
    // Worklist ruling RG-2 (2026-10-06): the other texts a matched entry was
    // suggested under before this change - the model's own text and the entry's
    // spellings (on the starting list, each old alias spelling of a housing
    // authority is one of them). The suggest path treats a dismissal of any of
    // them as a dismissal of the name, so a value dismissed before the deploy
    // is still never re-suggested. Ruling B-3: only the spellings that resolve
    // to THIS entry alone count. A spelling shared within the kind (AHA names
    // Atlanta and Augusta, MHA Marietta and Macon-Bibb) names no single entry:
    // a dismissal of an ambiguous "AHA" suggestion rejected that text, not
    // every full name it could mean, so it must not suppress a later,
    // unambiguous "Augusta Housing Authority" - a different value. Each old
    // alias spelling resolves to one entry, so RG-2's pre-deploy dismissals
    // still hold. The model's own text always counts: it resolved to exactly
    // this entry. Writes never consult dismissals; every other field passes
    // none.
    let alsoDismissedAs: readonly string[] = [];
    if (field === 'housingAuthority') {
      const resolved = resolveOrgText(ctx.orgEntries, String(coerced.value), KINDS_FOR_FIELD.housingAuthority);
      if (resolved.status === 'other_kind') {
        logger.debug({ contactId, field }, 'extraction: agency name proposed as a housing authority - dropped');
        decide({
          target: field,
          outcome: 'dropped',
          dropReason: 'agency_not_authority',
          ...(fieldOp.value !== undefined && { proposedValue: fieldOp.value }),
          ...(fieldOp.reason !== undefined && { reason: fieldOp.reason }),
        });
        continue;
      }
      if (resolved.status === 'match') {
        const matched = resolved.entry;
        value = matched.name;
        const ownSpellings = matched.spellings.filter((s) => {
          const r = resolveOrgText(ctx.orgEntries, s, KINDS_FOR_FIELD.housingAuthority);
          return r.status === 'match' && r.entry.orgId === matched.orgId;
        });
        alsoDismissedAs = [String(coerced.value), ...ownSpellings];
      } else {
        notOnList = true;
        if (fieldOp.op === 'write') {
          logger.debug(
            { contactId, field, resolution: resolved.status },
            'extraction: housing authority not on the list demoted to a suggestion',
          );
        }
      }
    }
    if (fieldOp.op === 'write' && ctx.hasInferredRoleContent !== true && !notOnList) {
      writePatch[field] = value;
      writePatch[`${field}_source`] = sourceStamp;
      auditFields.push({
        field,
        from: contact[field],
        to: value,
        ...(fieldOp.reason !== undefined && { reason: fieldOp.reason }),
      });
      pendingWrites.push(field);
      pendingDecisions.push({
        target: field,
        outcome: 'wrote',
        ...(fieldOp.value !== undefined && { proposedValue: fieldOp.value }),
        coercedValue: value,
        ...(contact[field] !== undefined && { previousValue: String(contact[field]) }),
        ...(fieldOp.reason !== undefined && { reason: fieldOp.reason }),
      });
    } else {
      // op === 'suggest', OR a demoted op:'write' (inferred-role content, spec
      // Layer 3): route the write through the SAME suggest path - no direct write,
      // no <field>_source provenance stamped (nothing is written).
      // Gate on the CAUSE, not merely on "was a write". Before the not-on-the-
      // list demotion existed these were the same statement - the only way to
      // reach this branch with op:'write' was inferred-role content - but they
      // are no longer, and `demotedFields` feeds the Layer-3
      // `ai_extraction_demoted` audit specifically. Being explicit keeps a
      // not-on-the-list demotion out of an audit that would misattribute it.
      if (fieldOp.op === 'write' && ctx.hasInferredRoleContent === true) demotedFields.push(field);
      // Belt-and-braces: skip when the suggestion string-equals the current value.
      const currentValue = contact[field] !== undefined ? String(contact[field]) : undefined;
      const suggestedValue = String(value);
      if (currentValue !== undefined && currentValue === suggestedValue) {
        logger.debug({ contactId, field }, 'extraction suggestion skipped (equal to current)');
        decide({
          target: field,
          outcome: 'dropped',
          dropReason: 'equal_to_current',
          ...(fieldOp.value !== undefined && { proposedValue: fieldOp.value }),
          ...(fieldOp.reason !== undefined && { reason: fieldOp.reason }),
          ...(fieldOp.op === 'write' && { demotedFrom: 'write' as const }),
        });
        continue;
      }
      const put = await putSuggestionSafe(deps, {
        ownerContactId: contactId,
        target: field,
        ...(currentValue !== undefined && { currentValue }),
        suggestedValue,
        ...(fieldOp.reason !== undefined && { reason: fieldOp.reason }),
        conversationId,
        ...(cursorTsMsgId !== undefined && { tsMsgId: cursorTsMsgId }),
        ...(ctx.runId !== undefined && { runId: ctx.runId }),
      }, alsoDismissedAs);
      if (put.ok) {
        suggested.push(field);
        noteDisplaced(field, put.displaced);
        decide({
          target: field,
          outcome: 'suggested',
          ...(fieldOp.value !== undefined && { proposedValue: fieldOp.value }),
          coercedValue: value,
          ...(currentValue !== undefined && { previousValue: currentValue }),
          ...(fieldOp.reason !== undefined && { reason: fieldOp.reason }),
          ...(fieldOp.op === 'write' && { demotedFrom: 'write' as const }),
        });
      } else {
        decide({
          target: field,
          outcome: 'dropped',
          dropReason: put.dropReason,
          ...(fieldOp.value !== undefined && { proposedValue: fieldOp.value }),
          ...(fieldOp.op === 'write' && { demotedFrom: 'write' as const }),
        });
      }
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
      decide({
        target: 'address',
        outcome: 'dropped',
        dropReason: 'wrong_contact_type',
        proposedValue: formatAddressParts(cleanAddressParts(result.address.parts)),
        ...(result.address.reason !== undefined && { reason: result.address.reason }),
      });
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
          pendingDecisions.push({
            target: 'address',
            outcome: 'wrote',
            proposedValue: formattedNew,
            coercedValue: parts,
            ...(hasCurrent && { previousValue: formattedCurrent }),
            ...(result.address.reason !== undefined && { reason: result.address.reason }),
          });
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
            decide({
              target: 'address',
              outcome: 'dropped',
              dropReason: 'equal_to_current',
              proposedValue: formattedNew,
              ...(result.address.reason !== undefined && { reason: result.address.reason }),
              ...(result.address.op === 'write' && { demotedFrom: 'write' as const }),
            });
          } else {
            const put = await putSuggestionSafe(deps, {
              ownerContactId: contactId,
              target: 'address',
              ...(hasCurrent && { currentValue: formattedCurrent }),
              suggestedValue: formattedNew, // display string (the chip)
              suggestedAddress: parts, // parts payload (what accept writes)
              ...(result.address.reason !== undefined && { reason: result.address.reason }),
              conversationId,
              ...(cursorTsMsgId !== undefined && { tsMsgId: cursorTsMsgId }),
              ...(ctx.runId !== undefined && { runId: ctx.runId }),
            });
            if (put.ok) {
              suggested.push('address');
              noteDisplaced('address', put.displaced);
              decide({
                target: 'address',
                outcome: 'suggested',
                proposedValue: formattedNew,
                coercedValue: parts,
                ...(hasCurrent && { previousValue: formattedCurrent }),
                ...(result.address.reason !== undefined && { reason: result.address.reason }),
                ...(result.address.op === 'write' && { demotedFrom: 'write' as const }),
              });
            } else {
              decide({
                target: 'address',
                outcome: 'dropped',
                dropReason: put.dropReason,
                proposedValue: formattedNew,
                ...(result.address.op === 'write' && { demotedFrom: 'write' as const }),
              });
            }
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
      decisions.push(...pendingDecisions);
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
      const put = await putSuggestionSafe(deps, {
        ownerContactId: contactId,
        target: 'status',
        currentValue: contact.status,
        suggestedValue: 'searching',
        ...(result.statusAdvance.reason !== undefined && { reason: result.statusAdvance.reason }),
        conversationId,
        ...(cursorTsMsgId !== undefined && { tsMsgId: cursorTsMsgId }),
        ...(ctx.runId !== undefined && { runId: ctx.runId }),
      });
      if (put.ok) {
        suggested.push('status');
        noteDisplaced('status', put.displaced);
        decide({
          target: 'status',
          outcome: 'suggested',
          coercedValue: 'searching',
          previousValue: contact.status,
          ...(result.statusAdvance.reason !== undefined && { reason: result.statusAdvance.reason }),
        });
      } else {
        decide({
          target: 'status',
          outcome: 'dropped',
          dropReason: put.dropReason,
        });
      }
    } else {
      logger.debug(
        { contactId, contactType: contact.type, status: contact.status },
        'statusAdvance ignored (not an onboarding tenant)',
      );
      decide({
        target: 'status',
        outcome: 'dropped',
        dropReason: 'status_not_onboarding_tenant',
      });
    }
  }

  // --- 6. typeSuggestion ---------------------------------------------------
  if (result.typeSuggestion) {
    if (contact.type === 'unknown') {
      const sourceRevision = contactClassificationRevision(contact);
      const put = await putSuggestionSafe(deps, {
        ownerContactId: contactId,
        target: 'type',
        currentValue: contact.type,
        suggestedValue: result.typeSuggestion.value,
        ...(result.typeSuggestion.reason !== undefined && { reason: result.typeSuggestion.reason }),
        conversationId,
        ...(cursorTsMsgId !== undefined && { tsMsgId: cursorTsMsgId }),
        ...(ctx.runId !== undefined && { runId: ctx.runId }),
        contactClassificationRevision: sourceRevision,
      });
      if (put.ok) {
        suggestionStateChanged = true;
        noteDisplaced('type', put.displaced);
        const reconciliation = await reconcileTypeSuggestionAfterPut(deps, put.item, sourceRevision);
        if (reconciliation.state === 'pending') {
          suggested.push('type');
          decide({
            target: 'type',
            outcome: 'suggested',
            proposedValue: result.typeSuggestion.value,
            coercedValue: result.typeSuggestion.value,
            previousValue: contact.type,
            ...(result.typeSuggestion.reason !== undefined && { reason: result.typeSuggestion.reason }),
          });
        } else {
          decide({
            target: 'type',
            outcome: 'dropped',
            dropReason: reconciliation.dropReason,
            proposedValue: result.typeSuggestion.value,
            ...(result.typeSuggestion.reason !== undefined && { reason: result.typeSuggestion.reason }),
          });
        }
      } else {
        decide({
          target: 'type',
          outcome: 'dropped',
          dropReason: put.dropReason,
          proposedValue: result.typeSuggestion.value,
        });
      }
    } else {
      logger.debug({ contactId, contactType: contact.type }, 'typeSuggestion ignored (contact already classified)');
      decide({
        target: 'type',
        outcome: 'dropped',
        dropReason: 'type_already_classified',
        proposedValue: result.typeSuggestion.value,
        ...(result.typeSuggestion.reason !== undefined && { reason: result.typeSuggestion.reason }),
      });
    }
  }

  // --- 7. phoneAddition ----------------------------------------------------
  if (result.phoneAddition) {
    const e164 = normalizeToE164(result.phoneAddition.phone);
    if (e164 === undefined) {
      logger.debug({ contactId }, 'phoneAddition ignored (not canonicalizable)');
      decide({
        target: 'phone',
        outcome: 'dropped',
        dropReason: 'phone_not_canonicalizable',
        proposedValue: result.phoneAddition.phone,
        ...(result.phoneAddition.reason !== undefined && { reason: result.phoneAddition.reason }),
      });
    } else if (contactPhones(contact).some((p) => p.phone === e164)) {
      logger.debug({ contactId }, 'phoneAddition ignored (already owned by contact)');
      decide({
        target: 'phone',
        outcome: 'dropped',
        dropReason: 'phone_already_owned',
        proposedValue: result.phoneAddition.phone,
        coercedValue: e164,
        ...(result.phoneAddition.reason !== undefined && { reason: result.phoneAddition.reason }),
      });
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
        decide({
          target: 'phone',
          outcome: 'dropped',
          dropReason: 'phone_owned_by_other',
          proposedValue: result.phoneAddition.phone,
          coercedValue: e164,
          ...(result.phoneAddition.reason !== undefined && { reason: result.phoneAddition.reason }),
        });
      } else {
        const label = result.phoneAddition.label;
        const reason = result.phoneAddition.reason;
        const combinedReason =
          label !== undefined && reason !== undefined
            ? `${label}: ${reason}`
            : (label ?? reason);
        const put = await putSuggestionSafe(deps, {
          ownerContactId: contactId,
          target: 'phone',
          suggestedValue: e164,
          ...(combinedReason !== undefined && { reason: combinedReason }),
          conversationId,
          ...(cursorTsMsgId !== undefined && { tsMsgId: cursorTsMsgId }),
          ...(ctx.runId !== undefined && { runId: ctx.runId }),
        });
        if (put.ok) {
          suggested.push('phone');
          noteDisplaced('phone', put.displaced);
          decide({
            target: 'phone',
            outcome: 'suggested',
            proposedValue: result.phoneAddition.phone,
            coercedValue: e164,
            ...(combinedReason !== undefined && { reason: combinedReason }),
          });
        } else {
          decide({
            target: 'phone',
            outcome: 'dropped',
            dropReason: put.dropReason,
            proposedValue: result.phoneAddition.phone,
          });
        }
      }
    }
  }

  // --- 8. noteLines --------------------------------------------------------
  // Every value rule lives in filterNoteLines (B1 spec D4, PR4): clamp, the
  // confidence floor, the postal filter, the F1 retry guard (before the cap),
  // the system lines, the five-line cap and the demotion rule. This block only
  // reads the snapshot and writes what it returns.
  let notedLines = 0;
  let appendedLines: string[] = [];
  // Read-modify-write on the ctx.contact snapshot. This can lose a concurrent
  // human notes edit made between the snapshot read and this write; the race
  // is ACCEPTED (single scalar attribute, low write frequency) rather than
  // paying for an optimistic-concurrency retry loop on a low-stakes field.
  const existing = typeof contact.notes === 'string' ? contact.notes.trim() : '';
  const prefix = autoPrefix(at);
  const filtered = filterNoteLines({
    modelLines: result.noteLines,
    systemLines: noteStrings,
    floor: deps.factMinConfidence,
    existingNotes: existing,
    prefix,
    demoted: ctx.hasInferredRoleContent === true,
  });
  if (filtered.demoted > 0) {
    logger.debug({ contactId, withheld: filtered.demoted }, 'extraction note lines withheld (unknown-speaker window)');
  }
  if (filtered.append.length > 0) {
    const joined = filtered.append.map((line) => `${prefix} ${line}`).join('\n');
    const nextNotes = existing.length > 0 ? `${existing}\n${joined}` : joined;
    try {
      await deps.contacts.update(contactId, { notes: nextNotes });
      notedLines = filtered.append.length;
      // WP1 B1 spec D5.3 (S5 C4): every line appended, model then system,
      // exactly as joined into nextNotes - the job counts feedback lines over it.
      appendedLines = filtered.append;
    } catch (err) {
      logger.warn({ contactId, err }, 'extraction notes append failed');
    }
  }

  // --- 10. emit once when anything changed ---------------------------------
  if (wrote.length + suggested.length + notedLines > 0 || suggestionStateChanged) {
    deps.events.emit('suggestion.updated', { contactId });
  }

  return {
    wrote, suggested, notedLines, appendedLines,
    notesBelowFloor: filtered.belowFloor, notesDemoted: filtered.demoted,
    displaced, decisions,
  };
}

/**
 * Best-effort putSuggestion. The displaced row remains available to the job,
 * while a failure remains isolated from the rest of the apply pass.
 */
const TYPE_RECONCILE_ATTEMPTS = 4;

type TypeReconcileOutcome =
  | { state: 'pending' }
  | {
      state: 'dropped';
      dropReason: 'type_already_classified' | 'type_classification_changed';
    };

async function reconcileTypeSuggestionAfterPut(
  deps: ApplyDeps,
  item: SuggestionItem,
  sourceRevision: number,
): Promise<TypeReconcileOutcome> {
  let liveRevision: number | undefined;
  try {
    for (let attempt = 0; attempt < TYPE_RECONCILE_ATTEMPTS; attempt += 1) {
      const live = await deps.contacts.getById(item.ownerContactId, { consistentRead: true });
      if (live === undefined) {
        deps.logger.warn(
          { contactId: item.ownerContactId, sourceRevision },
          'type suggestion reconciliation found no live contact (best-effort)',
        );
        return { state: 'pending' };
      }

      liveRevision = contactClassificationRevision(live);
      if (live.type === 'unknown' && liveRevision === sourceRevision) {
        return { state: 'pending' };
      }

      const deleted = await deps.extraction
        .deleteTypeSuggestionIfCurrentAtContactRevision(item, liveRevision);
      if (deleted === 'deleted') {
        return {
          state: 'dropped',
          dropReason: live.type === 'unknown'
            ? 'type_classification_changed'
            : 'type_already_classified',
        };
      }
      if (deleted === 'suggestion_changed_or_absent') return { state: 'pending' };
    }
  } catch {
    deps.logger.warn(
      {
        contactId: item.ownerContactId,
        sourceRevision,
        ...(liveRevision !== undefined && { liveRevision }),
      },
      'type suggestion reconciliation failed (best-effort)',
    );
  }
  return { state: 'pending' };
}

type SafePutResult =
  | { ok: true; item: SuggestionItem; displaced?: SuggestionItem }
  | { ok: false; dropReason: 'dismissed_before' | 'repo_error' };

async function putSuggestionSafe(
  deps: ApplyDeps,
  s: Parameters<ApplyDeps['extraction']['putSuggestion']>[0],
  alsoDismissedAs: readonly string[] = [],
): Promise<SafePutResult> {
  try {
    // Dismissal tombstone check (single choke point for EVERY suggest path):
    // a value a human already rejected for this target is never re-suggested
    // (permanent by ruling 2026-07-21); a different value still comes through.
    // The suggestion's own key is checked first; then each distinct key of
    // `alsoDismissedAs` - other texts that name the SAME value (worklist RG-2:
    // a housing authority suggested under its list name is also suppressed by
    // a dismissal of a spelling that names it alone - ruling B-3 - or of the
    // model's own text). `s` itself is stored as is.
    const norm = normalizeSuggestionValue(s.target, s.suggestedValue);
    const keys = [norm];
    for (const alt of alsoDismissedAs) {
      const key = normalizeSuggestionValue(s.target, alt);
      if (!keys.includes(key)) keys.push(key);
    }
    for (const key of keys) {
      if (await deps.extraction.hasDismissal(s.ownerContactId, s.target, key)) {
        deps.logger.debug(
          { contactId: s.ownerContactId, target: s.target },
          'suggestion suppressed (previously dismissed value)',
        );
        return { ok: false, dropReason: 'dismissed_before' };
      }
    }
    const { item, displaced } = await deps.extraction.putSuggestion(s);
    return { ok: true, item, ...(displaced !== undefined && { displaced }) };
  } catch (err) {
    if (err instanceof SuggestionDismissedError) {
      deps.logger.debug(
        { contactId: s.ownerContactId, target: s.target },
        'suggestion suppressed (dismissal won writer fence)',
      );
      return { ok: false, dropReason: 'dismissed_before' };
    }
    deps.logger.warn({ contactId: s.ownerContactId, target: s.target, err }, 'putSuggestion failed');
    return { ok: false, dropReason: 'repo_error' };
  }
}
