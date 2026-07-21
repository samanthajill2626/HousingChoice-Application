// Contact routes — triage (M1.4) + full list/create CRUD (M1.5). Mounted under
// /api/contacts (behind requireAuth; VAs run day-to-day, so NO admin gate).
//
//   GET   /api/contacts?type=&status=&phone=&limit=&cursor=  → { contacts, nextCursor }   (M1.5)
//   POST  /api/contacts  { type, firstName, lastName, phone, … }  → 201 { contact } | 409  (M1.5)
//   GET   /api/contacts/:contactId   → { contact }                                          (M1.4)
//   PATCH /api/contacts/:contactId   { type?, firstName?, lastName?, voucherSize?, status?, notes? }
//                                    → { contact }                                          (M1.4)
//
// THE M1.5 SEAM the honest-identity deviation left (README 2026-06-12):
// resolving a contact's type to tenant/landlord PROPAGATES that to the linked
// conversation(s)' type (unknown_1to1 → tenant_1to1/landlord_1to1). Triage
// happens HERE, so the propagation is implemented HERE.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Router } from 'express';
import { parseContactName } from '../lib/contactName.js';
import {
  appEvents,
  toConversationUpdatedEvent,
  toPlacementUpdatedEvent,
  type EventBus,
} from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { mergeContext } from '../lib/context.js';
import { normalizeToE164 } from '../lib/phone.js';
import { parseRole, parseRelationships, parseCustomFields } from '../lib/contactProfile.js';
import {
  LANDLORD_STATUS_LABELS,
  LANDLORD_STATUSES,
  NON_TENANT_STATUSES,
  statusAllowlistFor,
  TENANT_STATUS_LABELS,
  TENANT_STATUSES,
  TERMINAL_STAGES,
} from '../lib/statusModel.js';
import { createPlacementsRepo, type PlacementsRepo } from '../repos/placementsRepo.js';
import {
  createPlacementDeadlinesRepo,
  soonestDeadline,
  type PlacementDeadlinesRepo,
} from '../repos/placementDeadlinesRepo.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  contactEmails,
  contactPhones,
  createContactsRepo,
  PrimaryEmailRemovalError,
  PrimaryPhoneRemovalError,
  type ContactItem,
  type ContactsRepo,
  type ContactType,
  type ListContactsOpts,
} from '../repos/contactsRepo.js';
import { isValidEmailAddress, normalizeEmailAddress } from '../lib/email.js';
import { loadConfig } from '../lib/config.js';
import { HUMAN_CONSENT_METHODS, type ConsentMethod } from '../lib/smsCompliance.js';
import {
  createConversationsRepo,
  getOwner,
  type ConversationParticipant,
  type ConversationsRepo,
  type ConversationType,
  type RelayOwner,
} from '../repos/conversationsRepo.js';
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import {
  createActivityEventsRepo,
  type ActivityEventsRepo,
} from '../repos/activityEventsRepo.js';
import {
  createListingSendsRepo,
  toListingSendRow,
  type ListingSendsRepo,
} from '../repos/listingSendsRepo.js';
import { createToursRepo, type TourItem, type ToursRepo } from '../repos/toursRepo.js';
import { deriveTourSignal } from '../lib/listingSendTour.js';
import {
  createContactVocabularyRepo,
  type ContactVocabularyRepo,
} from '../repos/contactVocabularyRepo.js';
import { createExtractionRepo, type ExtractionRepo } from '../repos/extractionRepo.js';
import { PROVENANCE_FIELDS } from '../services/extraction/schema.js';

export interface ContactsRouterDeps {
  logger?: Logger;
  contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;
  /** BE5/C5: aggregate a contact's media across their conversations (GET /:id/media). */
  messagesRepo?: MessagesRepo;
  auditRepo?: AuditRepo;
  /** BE2/C2: emit a `number_added` milestone on a successful phone add. */
  activityEventsRepo?: ActivityEventsRepo;
  /** BE4/C4: serve a contact's "Properties sent" (GET /:id/listings-sent). */
  listingSendsRepo?: ListingSendsRepo;
  /**
   * listing-response-tour-chip: GET /:id/listings-sent derives a per-row tour
   * chip from the tenant's tours (byTenant GSI). Best-effort join - a query
   * failure degrades to chipless rows, never a 500.
   */
  toursRepo?: ToursRepo;
  /** Task 4: auto-suggest vocabulary (roles, relationship roles, field labels). */
  vocabularyRepo?: ContactVocabularyRepo;
  /**
   * Voucher sync (placement-deadline-model §6): a voucher_expiration_date edit
   * upserts/retires the `voucher_expiration` deadline on the tenant's ACTIVE
   * placements. Default to the real repos.
   */
  placementsRepo?: PlacementsRepo;
  placementDeadlinesRepo?: PlacementDeadlinesRepo;
  /**
   * conversation-fact-extraction (T8): a human field edit clears AI provenance +
   * best-effort deletes any pending suggestion for the changed field(s). Injected
   * in tests (a no-network fake); defaults to the real repo.
   */
  extractionRepo?: ExtractionRepo;
  /**
   * Kill switch for the triage re-extraction hook (config.aiExtractionEnabled):
   * a triage flip to tenant schedules an immediate 'triage' extraction run so
   * tenant-only facts (voucherSize/housingAuthority/...) already present in the
   * conversation window are picked up without waiting for the next inbound.
   * Defaults to the config value when not injected.
   */
  aiExtractionEnabled?: boolean;
  /** SSE live-update bus (M1.2); the process singleton by default. */
  events?: EventBus;
}

/**
 * BE5/C5 wire shape (VERBATIM — the frontend imports identical field names).
 * One mirrored media attachment surfaced on the contact's Media panel: its S3
 * key + normalized content-type, the source message's provider_ts, and the 1:1
 * conversation it lives on. NO URL is generated — the frontend fetches bytes via
 * the existing GET /api/messages/:sid/media/:idx endpoint using s3Key.
 */
interface ContactMediaItem {
  s3Key: string;
  contentType: string;
  /** ISO 8601 — the source message's provider_ts (the sort key). */
  at: string;
  conversationId: string;
}

/**
 * Wire shape (VERBATIM — the frontend imports identical field names). One
 * relay-group membership row for the contact page's "Group texts" card: the
 * thread + its open/closed status, the pool number fronting it (absent once
 * closed — close clears it), roster size, last activity, the owning entity
 * (tour/placement — the dashboard's link target, from getOwner()), the
 * operator tag, and the OTHER members' resolved display names (known names
 * only, NEVER a phone — least data that makes the row readable). Carrying
 * numbers/names to the authed client matches the M1.7 relay posture; LOG
 * LINES stay IDs/counts only (doc §9).
 */
interface RelayGroupRow {
  conversationId: string;
  status: 'open' | 'closed';
  poolNumber?: string;
  memberCount: number;
  /** ISO 8601 — the conversation's last_activity_at. */
  lastActivityAt: string;
  owner: RelayOwner;
  tag?: string;
  otherMemberNames: string[];
}

/**
 * Bound on messages pulled per conversation when aggregating media. The contact
 * media panel is a recent-media view, not an archive; a single page per
 * conversation at this scale covers the working set. If a conversation has more
 * than this, the older media is dropped — and that drop is LOGGED (no silent
 * truncation). Generous (a thread rarely has hundreds of MMS).
 */
const MEDIA_SCAN_PAGE_LIMIT = 200;

/** The contact types triage may set (the full union incl. 'unknown'). */
const CONTACT_TYPES: readonly ContactType[] = [
  'tenant',
  'landlord',
  'partner',
  'team_member',
  'unknown',
] as const;

function isContactType(value: unknown): value is ContactType {
  return typeof value === 'string' && (CONTACT_TYPES as readonly string[]).includes(value);
}

/**
 * A2P/CTIA consent capture (spec §3.3 / §3.4). Validate + extract the
 * client-supplied consent fields from a create/patch body into `out`. Only the
 * four HUMAN consent methods are accepted from these human paths — a client may
 * NOT set web_form/inbound_text (those are stamped automatically by the public
 * form / inbound-text seams). `consent_captured_by` is NEVER read from the
 * client here — the route stamps it from the session user server-side. Returns
 * `{ hasConsent }` on success (whether a consent_method was supplied) or
 * `{ error }` on a bad value (never silently dropped). Absent fields are a
 * no-op (consent is optional on both paths).
 */
function applyConsentFields(
  b: Record<string, unknown>,
  out: Record<string, unknown>,
): { hasConsent: boolean } | { error: string } {
  let hasConsent = false;
  if ('consent_method' in b && b['consent_method'] !== undefined && b['consent_method'] !== null) {
    const m = b['consent_method'];
    if (typeof m !== 'string' || !HUMAN_CONSENT_METHODS.has(m as ConsentMethod)) {
      return {
        error: `consent_method must be one of: ${[...HUMAN_CONSENT_METHODS].join(', ')}`,
      };
    }
    out['consent_method'] = m;
    hasConsent = true;
  }
  if ('consent_at' in b && b['consent_at'] !== undefined && b['consent_at'] !== null) {
    const at = b['consent_at'];
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
      return { error: 'consent_at must be an ISO 8601 date string' };
    }
    out['consent_at'] = at;
  }
  if ('consent_note' in b && b['consent_note'] !== undefined && b['consent_note'] !== null) {
    const note = b['consent_note'];
    if (typeof note !== 'string') return { error: 'consent_note must be a string' };
    out['consent_note'] = note;
  }
  // A client-supplied consent_captured_by is IGNORED (never trusted) — the route
  // stamps it from the session. Guardrail: reject it loudly so the client learns
  // the field is server-owned rather than silently seeing it dropped.
  if ('consent_captured_by' in b && b['consent_captured_by'] !== undefined) {
    return { error: 'consent_captured_by is set by the server, not the client' };
  }
  return { hasConsent };
}

/**
 * Validate + canonicalize the optional `voucher_expiration_date`
 * (placement-deadline-model §6) with the placements idiom: an empty string or
 * null CLEARS it (→ null, a REMOVE), any other value must parse as a date and is
 * canonicalized to ISO 8601; anything else is a 400. Returns `{ value }` (string
 * or null) when the field was present, `undefined` when absent (untouched), or
 * `{ error }` on a bad value. Not type-gated (mirrors voucherSize/consent_at;
 * tenant-only stays a UI guarantee).
 */
function parseVoucherExpirationDate(
  b: Record<string, unknown>,
): { value: string | null } | { error: string } | undefined {
  if (!('voucher_expiration_date' in b)) return undefined;
  const v = b['voucher_expiration_date'];
  if (v === null || v === '') return { value: null }; // clear
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
    return { error: 'voucher_expiration_date must be an ISO 8601 date string (or empty to clear)' };
  }
  return { value: new Date(v).toISOString() };
}

/**
 * Structured landlord deal-term fields (onboarding call). First-class optional
 * fields validated only when supplied — NOT type-gated (they mirror how
 * voucherSize/pets are plain optional fields). snake_case names are contractual:
 * the dashboard + e2e suite read them verbatim.
 */
const CONTRACT_STATUSES = ['unsigned', 'signed'] as const;
type ContractStatus = (typeof CONTRACT_STATUSES)[number];
function isContractStatus(value: unknown): value is ContractStatus {
  return typeof value === 'string' && (CONTRACT_STATUSES as readonly string[]).includes(value);
}

/** The landlord boolean deal terms / approval criteria (all optional). */
const LANDLORD_BOOLEAN_FIELDS = [
  'registered_landlord',
  'rta_within_48h',
  'pass_inspection_first_try',
  'income_includes_voucher',
] as const;

// NOTE (2026-07-10): the landlord preference fields (accepts_programs /
// lease_terms / pet_policy) and expected_rent MOVED to the UNIT (GLOSSARY —
// they are per-property facts: accepted_programs / lease_terms / pets /
// rent_min-rent_max on UnitItem). The contact parsers no longer accept them;
// unknown keys are ignored, so a stale client sending them simply no-ops.

// The type-scoped status allowlist (a TENANT's §5 lifecycle, a LANDLORD's lead
// lifecycle, else needs_review|active) is centralized in lib/statusModel.ts
// (statusAllowlistFor) so BOTH status-setting paths — this generic PATCH and the
// /tenant-status transition route — share ONE source of truth. NON_TENANT_STATUSES
// (needs_review|active) is imported for the "no explicit type" fallback union.

// --- M1.5 list pagination + cursor -----------------------------------------
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

/** Parse ?limit= into 1..MAX_PAGE_LIMIT (default). undefined ⇒ 400 upstream. */
function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  if (typeof raw !== 'string') return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) return undefined;
  return limit;
}

function encodeCursor(lastEvaluatedKey: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString('base64url');
}

/**
 * Decode a byTypeStatus cursor. The ExclusiveStartKey carries the base-table
 * key (contactId) plus the GSI keys (type, status) — a small flat scalar
 * object. Validate the SHAPE (1..3 string attributes) before it becomes a
 * DynamoDB key; a tampered cursor must never reach DynamoDB malformed.
 */
function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const key = parsed as Record<string, unknown>;
    const entries = Object.entries(key);
    if (entries.length < 1 || entries.length > 3) return undefined;
    for (const [, v] of entries) if (typeof v !== 'string') return undefined;
    return key;
  } catch {
    return undefined;
  }
}

/**
 * Decode a URL-encoded :phone route param to a normalized E.164, or undefined
 * when it's missing/malformed/uncanonicalizable. decodeURIComponent throws
 * URIError on a malformed %-sequence (e.g. `%E0%A4%A`) — caught here so the
 * route returns a 400 (invalid phone) instead of a 500 + an error-logs alarm.
 */
function decodePhoneParam(raw: unknown): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(String(raw ?? ''));
  } catch {
    // URIError on a malformed escape → treat as an invalid phone (400).
    return undefined;
  }
  return normalizeToE164(decoded);
}

/**
 * Decode + normalize a URL-encoded :email path param (email-channel A1 - the
 * decodePhoneParam analog). Returns the normalized address when valid, else
 * undefined (a malformed %-escape OR an invalid address -> route 400, never a
 * 500 + error-logs alarm).
 */
function decodeEmailParam(raw: unknown): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(String(raw ?? ''));
  } catch {
    return undefined;
  }
  const normalized = normalizeEmailAddress(decoded);
  return isValidEmailAddress(normalized) ? normalized : undefined;
}

/** A resolved-identity 1:1 type for the conversation, or undefined when not propagatable. */
function conversationTypeFor(contactType: ContactType): ConversationType | undefined {
  if (contactType === 'tenant') return 'tenant_1to1';
  if (contactType === 'landlord') return 'landlord_1to1';
  if (contactType === 'partner') return 'partner_1to1';
  // team_member/unknown have no 1:1 conversation type to propagate.
  return undefined;
}

/**
 * The denormalized inbox display name from a contact's resolved fields:
 * `firstName`/`lastName` joined and trimmed → a non-empty string, else null.
 * HONEST: returns null when no name is known — the inbox falls back to the
 * phone; a name is NEVER invented. PII (doc §9): the name is data, never
 * logged here.
 */
function displayNameOf(contact: ContactItem): string | null {
  // Part-wise trim BEFORE the join: a legacy padded part ("Cameron   ") must
  // never render an interior gap ("Cameron   Abt"). New writes arrive trimmed
  // (trimJsonBody), but stored data predating it may not be.
  const first = typeof contact.firstName === 'string' ? contact.firstName.trim() : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName.trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : null;
}

interface TriagePatch {
  patch: Record<string, unknown>;
  /** The fields actually changed (for the audit event). */
  changedFields: string[];
  /** True when this patch records SMS consent (route stamps consent_captured_by). */
  consentCaptured?: boolean;
}

/**
 * Validate the triage body into a contacts patch. Returns the patch + the
 * list of changed field names, or an error message. Accepts EITHER structured
 * fields OR a raw "First Last - N Bed" string (parsed via the one true
 * parser). Never blanks a name that was set unless explicitly cleared (empty
 * string clears; absent leaves untouched — the repo's SET-merge enforces it).
 */
function parseTriageBody(body: unknown): TriagePatch | { error: string } {
  if (typeof body !== 'object' || body === null) {
    return { error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  const changedFields: string[] = [];

  // A raw "First Last - N Bed" convention string the dashboard may send
  // instead of structured fields — parse it with the one true parser.
  if ('contactName' in b) {
    const raw = b['contactName'];
    if (typeof raw !== 'string') return { error: 'contactName must be a string' };
    const parsed = parseContactName(raw);
    if (parsed === undefined) {
      return { error: 'contactName does not match the "First Last - N Bed" convention' };
    }
    patch['firstName'] = parsed.firstName;
    patch['lastName'] = parsed.lastName;
    patch['voucherSize'] = parsed.voucherSize;
    changedFields.push('firstName', 'lastName', 'voucherSize');
  }

  if ('type' in b) {
    if (!isContactType(b['type'])) {
      return { error: `type must be one of: ${CONTACT_TYPES.join(', ')}` };
    }
    patch['type'] = b['type'];
    changedFields.push('type');
  }
  if ('firstName' in b) {
    const v = b['firstName'];
    if (typeof v !== 'string') return { error: 'firstName must be a string' };
    patch['firstName'] = v;
    changedFields.push('firstName');
  }
  if ('lastName' in b) {
    const v = b['lastName'];
    if (typeof v !== 'string') return { error: 'lastName must be a string' };
    patch['lastName'] = v;
    changedFields.push('lastName');
  }
  if ('voucherSize' in b) {
    const v = b['voucherSize'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 12) {
      return { error: 'voucherSize must be an integer 0..12' };
    }
    patch['voucherSize'] = v;
    changedFields.push('voucherSize');
  }
  if ('status' in b) {
    const v = b['status'];
    // Type-aware allowlist (status-model unification). When this triage sets
    // `type` too, validate against THAT type's allowlist now. When it doesn't,
    // the effective type is the STORED one (unknown here) — accept any known
    // status value and let the route re-validate against the stored type.
    const patchType = patch['type'];
    const allow = isContactType(patchType)
      ? statusAllowlistFor(patchType)
      : ([...TENANT_STATUSES, ...LANDLORD_STATUSES, ...NON_TENANT_STATUSES] as readonly string[]);
    if (typeof v !== 'string' || !allow.includes(v)) {
      return { error: `status must be one of: ${allow.join(', ')}` };
    }
    patch['status'] = v;
    changedFields.push('status');
  }
  if ('notes' in b) {
    const v = b['notes'];
    if (typeof v !== 'string') return { error: 'notes must be a string' };
    patch['notes'] = v;
    changedFields.push('notes');
  }
  // Landlord park reason (edit form). Free text captured when a landlord lead is
  // moved to `parked`. Normally written by the /tenant-status route on the parked
  // move; also settable here so the edit form can persist it alongside a status
  // change. Empty string clears it.
  if ('park_reason' in b) {
    const v = b['park_reason'];
    if (typeof v !== 'string') return { error: 'park_reason must be a string' };
    patch['park_reason'] = v;
    changedFields.push('park_reason');
  }
  // Landlord company name (edit form). Free text; empty string clears it.
  if ('company' in b) {
    const v = b['company'];
    if (typeof v !== 'string') return { error: 'company must be a string' };
    patch['company'] = v;
    changedFields.push('company');
  }
  // Tenant housing authority (edit form). camelCase — it's the byHousingAuthority
  // GSI hash key, so writing it re-indexes the contact for broadcast targeting.
  if ('housingAuthority' in b) {
    const v = b['housingAuthority'];
    if (typeof v !== 'string') return { error: 'housingAuthority must be a string' };
    patch['housingAuthority'] = v;
    changedFields.push('housingAuthority');
  }
  // Structured postal address (edit form). Every part optional; we store only the
  // non-empty parts (a SET-merge replaces the whole address object).
  if ('address' in b) {
    const v = b['address'];
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return { error: 'address must be an object' };
    }
    const a = v as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const key of ['line1', 'line2', 'city', 'state', 'zip'] as const) {
      const part = a[key];
      if (part !== undefined) {
        if (typeof part !== 'string') return { error: `address.${key} must be a string` };
        const trimmed = part.trim();
        if (trimmed.length > 0) out[key] = trimmed;
      }
    }
    patch['address'] = out;
    changedFields.push('address');
  }

  if ('role' in b) {
    const r = parseRole(b['role']);
    if (typeof r !== 'string') return r;
    patch['role'] = r.length > 0 ? r : null;  // null → REMOVE the attribute (clear the role)
    changedFields.push('role');
  }
  if ('relationships' in b) {
    const rels = parseRelationships(b['relationships']);
    if (!Array.isArray(rels)) return rels;
    patch['relationships'] = rels;
    changedFields.push('relationships');
  }
  if ('customFields' in b) {
    const cf = parseCustomFields(b['customFields']);
    if (!Array.isArray(cf)) return cf;
    patch['customFields'] = cf;
    changedFields.push('customFields');
  }

  // Structured intake fields (free-text + a boolean LIF flag). First-class fields,
  // not customFields, so eligibility is reportable/filterable later.
  for (const key of ['pets', 'evictions', 'tenure'] as const) {
    if (key in b) {
      const v = b[key];
      if (typeof v !== 'string') return { error: `${key} must be a string` };
      patch[key] = v;
      changedFields.push(key);
    }
  }
  if ('lifEligible' in b) {
    const v = b['lifEligible'];
    if (typeof v !== 'boolean') return { error: 'lifEligible must be a boolean' };
    patch['lifEligible'] = v;
    changedFields.push('lifEligible');
  }

  // Structured landlord deal terms + approval criteria (onboarding call). Like the
  // tenant intake fields above, these are first-class optional fields validated only
  // when supplied — NOT type-gated (mirrors voucherSize/pets).
  if ('contract_status' in b) {
    const v = b['contract_status'];
    if (!isContractStatus(v)) {
      return { error: `contract_status must be one of: ${CONTRACT_STATUSES.join(', ')}` };
    }
    patch['contract_status'] = v;
    changedFields.push('contract_status');
  }
  for (const key of LANDLORD_BOOLEAN_FIELDS) {
    if (key in b) {
      const v = b[key];
      if (typeof v !== 'boolean') return { error: `${key} must be a boolean` };
      patch[key] = v;
      changedFields.push(key);
    }
  }

  // A2P/CTIA consent (spec §3.4): the JIT record-consent PATCH carries the four
  // HUMAN consent fields. Validated here; consent_captured_by is stamped by the
  // route (session user), never trusted from the client.
  const consent = applyConsentFields(b, patch);
  if ('error' in consent) return { error: consent.error };
  if ('consent_method' in patch) changedFields.push('consent_method');
  if ('consent_at' in patch) changedFields.push('consent_at');
  if ('consent_note' in patch) changedFields.push('consent_note');

  // Voucher expiration date (placement-deadline-model §6) — the SOURCE of the
  // voucher_expiration placement deadline; the PATCH handler syncs it after the write.
  const voucher = parseVoucherExpirationDate(b);
  if (voucher !== undefined) {
    if ('error' in voucher) return { error: voucher.error };
    patch['voucher_expiration_date'] = voucher.value; // string | null (null → REMOVE)
    changedFields.push('voucher_expiration_date');
  }

  if (changedFields.length === 0) {
    return { error: 'no updatable fields supplied' };
  }
  return { patch, changedFields, ...(consent.hasConsent && { consentCaptured: true }) };
}

/** A validated manual-create contact body (the fields actually persisted). */
interface CreateContactResult {
  /** The contact attributes to store (sans contactId — the repo generates it). */
  item: Partial<ContactItem> & { type: ContactType };
  /** Normalized E.164 phone (the dedupe key), when one was supplied. */
  phone?: string;
  /** Normalized email (the dedupe key - email-channel A1), when one was supplied. */
  email?: string;
  /** True when the body records SMS consent (route stamps consent_captured_by). */
  consentCaptured?: boolean;
}

/**
 * Validate the manual-create body (M1.5). Required: a valid `type`. Optional:
 * firstName/lastName/phone/voucherSize/notes/status, plus the "First Last - N
 * Bed" convenience string via `contactName` (the one true parser). Phone is
 * normalized to E.164 and rejected when it can't be canonicalized. A manual
 * create defaults status type-scoped (tenant -> 'onboarding', landlord ->
 * 'interested', else -> 'active') - the human entering it knows who it is,
 * unlike auto-capture stubs, which are 'needs_review'. An explicit status in
 * the body still wins.
 */
function parseCreateBody(body: unknown): CreateContactResult | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  if (!isContactType(b['type'])) {
    return { error: `type is required and must be one of: ${CONTACT_TYPES.join(', ')}` };
  }
  const item: Partial<ContactItem> & { type: ContactType } = { type: b['type'] };

  // Convenience: "First Last - N Bed" → firstName/lastName/voucherSize.
  if ('contactName' in b) {
    const raw = b['contactName'];
    if (typeof raw !== 'string') return { error: 'contactName must be a string' };
    const parsed = parseContactName(raw);
    if (parsed === undefined) {
      return { error: 'contactName does not match the "First Last - N Bed" convention' };
    }
    item.firstName = parsed.firstName;
    item.lastName = parsed.lastName;
    item.voucherSize = parsed.voucherSize;
  }

  if ('firstName' in b) {
    if (typeof b['firstName'] !== 'string') return { error: 'firstName must be a string' };
    item.firstName = b['firstName'];
  }
  if ('lastName' in b) {
    if (typeof b['lastName'] !== 'string') return { error: 'lastName must be a string' };
    item.lastName = b['lastName'];
  }
  if ('voucherSize' in b) {
    const v = b['voucherSize'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 12) {
      return { error: 'voucherSize must be an integer 0..12' };
    }
    item.voucherSize = v;
  }
  if ('notes' in b) {
    if (typeof b['notes'] !== 'string') return { error: 'notes must be a string' };
    item.notes = b['notes'];
  }
  if ('park_reason' in b) {
    if (typeof b['park_reason'] !== 'string') return { error: 'park_reason must be a string' };
    item.park_reason = b['park_reason'];
  }
  if ('status' in b) {
    const v = b['status'];
    const allow = statusAllowlistFor(item.type);
    if (typeof v !== 'string' || !allow.includes(v)) {
      return { error: `status must be one of: ${allow.join(', ')}` };
    }
    item.status = v;
  }

  let phone: string | undefined;
  if ('phone' in b && b['phone'] !== undefined && b['phone'] !== '') {
    if (typeof b['phone'] !== 'string') return { error: 'phone must be a string' };
    const normalized = normalizeToE164(b['phone']);
    if (normalized === undefined) {
      return { error: 'phone is not a valid phone number' };
    }
    phone = normalized;
    item.phone = normalized;
  }

  // Email-channel A1: optional email (the byEmail dedupe key). Normalized + a
  // pragmatic validity check, mirroring the phone branch above.
  let email: string | undefined;
  if ('email' in b && b['email'] !== undefined && b['email'] !== '') {
    if (typeof b['email'] !== 'string') return { error: 'email must be a string' };
    const normalized = normalizeEmailAddress(b['email']);
    if (!isValidEmailAddress(normalized)) {
      return { error: 'email is not a valid email address' };
    }
    email = normalized;
    item.email = normalized;
  }

  if ('company' in b) {
    if (typeof b['company'] !== 'string') return { error: 'company must be a string' };
    item.company = b['company'];
  }
  if ('role' in b) {
    const r = parseRole(b['role']);
    if (typeof r !== 'string') return r;            // { error }
    if (r.length > 0) item.role = r;
  }
  if ('relationships' in b) {
    const rels = parseRelationships(b['relationships']);
    if (!Array.isArray(rels)) return rels;          // { error }
    item.relationships = rels;
  }
  if ('customFields' in b) {
    const cf = parseCustomFields(b['customFields']);
    if (!Array.isArray(cf)) return cf;              // { error }
    item.customFields = cf;
  }

  for (const key of ['pets', 'evictions', 'tenure'] as const) {
    if (key in b) {
      const v = b[key];
      if (typeof v !== 'string') return { error: `${key} must be a string` };
      item[key] = v;
    }
  }
  if ('lifEligible' in b) {
    const v = b['lifEligible'];
    if (typeof v !== 'boolean') return { error: 'lifEligible must be a boolean' };
    item.lifEligible = v;
  }

  // Structured landlord deal terms + approval criteria (see parseTriageBody).
  if ('contract_status' in b) {
    const v = b['contract_status'];
    if (!isContractStatus(v)) {
      return { error: `contract_status must be one of: ${CONTRACT_STATUSES.join(', ')}` };
    }
    item.contract_status = v;
  }
  for (const key of LANDLORD_BOOLEAN_FIELDS) {
    if (key in b) {
      const v = b[key];
      if (typeof v !== 'boolean') return { error: `${key} must be a boolean` };
      item[key] = v;
    }
  }

  // A manual create asserts identity (past the front door, not needs_review).
  // The default is type-scoped (status-model unification — one `status` field):
  //   - tenant → 'onboarding': the §5 lifecycle starts here once identity is
  //     asserted (the operator is making this person; they are no longer at the
  //     'needs_review' front door).
  //   - landlord -> 'interested': a day-to-day manual create is a LEAD, not an
  //     onboarded landlord ('active' means their properties are onboarded). The
  //     M1.6 import sets landlord statuses explicitly, so it is unaffected.
  //   - other (team_member/unknown) -> 'active' (unchanged: no lifecycle).
  // We deliberately DO NOT stamp status_source here. The prior tenant_status
  // behavior left provenance UNSET on create, so the first placement transition
  // could still DERIVE the lifecycle forward (Onboarding → Placing). Stamping
  // 'manual' would pin it and block that derived write — exactly the create-pin
  // regression this work must not (re)introduce
  // (docs/issues/status-pin-vs-terminal-derivation.md). An explicit lifecycle
  // pin is the transition service's job (PATCH …/tenant-status), not create.
  if (item.status === undefined) {
    item.status =
      item.type === 'tenant' ? 'onboarding' : item.type === 'landlord' ? 'interested' : 'active';
  }

  // A2P/CTIA consent (spec §3.3): the optional "Consent to text" section on the
  // add-contact form. Only the four HUMAN methods are accepted here (never
  // web_form/inbound_text — those are automatic seams). consent_captured_by is
  // stamped by the route from the session, not read from the client.
  const consentOut: Record<string, unknown> = {};
  const consent = applyConsentFields(b, consentOut);
  if ('error' in consent) return { error: consent.error };
  Object.assign(item, consentOut);

  // Voucher expiration date (placement-deadline-model §6). On create there is no
  // placement yet to arm — the placement create-path reads this field when a
  // placement is later opened. Only STORE a real date; an empty/null clear is a
  // no-op on create (nothing to remove).
  const voucher = parseVoucherExpirationDate(b);
  if (voucher !== undefined) {
    if ('error' in voucher) return { error: voucher.error };
    if (voucher.value !== null) item.voucher_expiration_date = voucher.value;
  }

  return {
    item,
    ...(phone !== undefined && { phone }),
    ...(email !== undefined && { email }),
    ...(consent.hasConsent && { consentCaptured: true }),
  };
}

export function createContactsRouter(deps: ContactsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const activityEvents =
    deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });
  const listingSends = deps.listingSendsRepo ?? createListingSendsRepo({ logger: deps.logger });
  const tours = deps.toursRepo ?? createToursRepo({ logger: deps.logger });
  const vocabulary = deps.vocabularyRepo ?? createContactVocabularyRepo({ logger: deps.logger });
  const placements = deps.placementsRepo ?? createPlacementsRepo({ logger: deps.logger });
  const placementDeadlines =
    deps.placementDeadlinesRepo ?? createPlacementDeadlinesRepo({ logger: deps.logger });
  const extraction = deps.extractionRepo ?? createExtractionRepo({ logger: deps.logger });
  const aiExtractionEnabled = deps.aiExtractionEnabled ?? loadConfig().aiExtractionEnabled;
  const events = deps.events ?? appEvents;

  const router = Router();

  // conversation-fact-extraction: the field names whose `<field>_source` provenance
  // a human edit clears - the eight AI-extractable scalars plus the compound
  // `address` (address-extraction slice 3).
  const PROVENANCE = new Set<string>(PROVENANCE_FIELDS);

  // GET /api/contacts?type=&status=&phone=&limit=&cursor= — list/filter (M1.5).
  // ?phone= is an exact byPhone lookup (returns 0 or 1) and takes priority;
  // otherwise ?type= drives a byTypeStatus Query (optionally narrowed by
  // ?status=). `type` is REQUIRED when not doing a phone lookup — a bare list
  // of ALL contacts would be an unbounded Scan, deliberately not offered.
  router.get('/', async (req, res) => {
    const rawPhone = req.query['phone'];
    if (typeof rawPhone === 'string' && rawPhone.length > 0) {
      const normalized = normalizeToE164(rawPhone);
      if (normalized === undefined) {
        res.status(400).json({ error: 'phone is not a valid phone number' });
        return;
      }
      const contact = await contacts.findByPhone(normalized);
      res.json({ contacts: contact ? [contact] : [], nextCursor: null });
      return;
    }

    const rawType = req.query['type'];
    if (typeof rawType !== 'string' || !isContactType(rawType)) {
      res.status(400).json({ error: `type must be one of: ${CONTACT_TYPES.join(', ')} (or pass phone=)` });
      return;
    }

    const limit = parseLimit(req.query['limit']);
    if (limit === undefined) {
      res.status(400).json({ error: `limit must be an integer 1..${MAX_PAGE_LIMIT}` });
      return;
    }

    const rawStatus = req.query['status'];
    let status: string | undefined;
    if (typeof rawStatus === 'string' && rawStatus.length > 0) {
      // Type-scoped allowlist (status-model unification): a tenant-typed filter
      // accepts the §5 lifecycle values; other types accept needs_review|active.
      const allow = statusAllowlistFor(rawType);
      if (!allow.includes(rawStatus)) {
        res.status(400).json({ error: `status must be one of: ${allow.join(', ')}` });
        return;
      }
      status = rawStatus;
    }

    let exclusiveStartKey: Record<string, unknown> | undefined;
    const rawCursor = req.query['cursor'];
    if (rawCursor !== undefined) {
      exclusiveStartKey = typeof rawCursor === 'string' ? decodeCursor(rawCursor) : undefined;
      if (exclusiveStartKey === undefined) {
        res.status(400).json({ error: 'invalid cursor' });
        return;
      }
    }

    // ?deleted=true → the Contacts "Deleted" view (ONLY soft-deleted contacts);
    // omitted/anything else → exclude deleted (every normal list).
    const rawDeleted = req.query['deleted'];
    const deleted = rawDeleted === 'true' || rawDeleted === '1';

    const opts: ListContactsOpts = {
      limit,
      ...(status !== undefined && { status }),
      ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
      ...(deleted && { deleted: true }),
    };
    const page = await contacts.listByType(rawType, opts);
    res.json({
      contacts: page.items,
      nextCursor:
        page.lastEvaluatedKey !== undefined ? encodeCursor(page.lastEvaluatedKey) : null,
    });
  });

  // POST /api/contacts — manual create with phone dedupe (M1.5). DEDUPE POLICY:
  // if a contact already exists for the (normalized) phone, return 409 with the
  // existing contact rather than creating a duplicate — the byPhone GSI is the
  // hottest lookup and one-contact-per-phone keeps it honest. A create without
  // a phone is always allowed (no dedupe key).
  router.post('/', async (req: AuthedRequest, res) => {
    const parsed = parseCreateBody(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    if (parsed.phone !== undefined) {
      const existing = await contacts.findByPhone(parsed.phone);
      if (existing) {
        // 409 + the existing record so the client can adopt it (the frontend
        // shows "this phone already exists" and links to it).
        res.status(409).json({ error: 'contact_exists', contact: existing });
        return;
      }
    }

    // Email-channel A1: same one-contact-per-address dedupe as phone (findByEmail
    // is pointer-aware). Only ONE of phone/email need collide to reject.
    if (parsed.email !== undefined) {
      const existing = await contacts.findByEmail(parsed.email);
      if (existing) {
        res.status(409).json({ error: 'contact_exists', contact: existing });
        return;
      }
    }

    // A2P/CTIA: when the create body records consent, stamp consent_captured_by
    // from the SESSION user server-side (never trusted from the client).
    if (parsed.consentCaptured === true) {
      parsed.item.consent_captured_by = req.user?.userId;
    }

    const contact = await contacts.create(parsed.item);
    await audit.append(`contacts#${contact.contactId}`, 'contact_created', {
      actor: req.user?.userId,
      type: contact.type,
      source: 'manual',
    });
    log.info(
      { contactId: contact.contactId, type: contact.type, actor: req.user?.userId },
      'contact created via api',
    );
    // Best-effort vocabulary write: collect tokens from the newly created contact.
    // Never fails the response — if DynamoDB is unavailable, the create still succeeds.
    try {
      const { item } = parsed;
      const vocabRoles =
        typeof item.role === 'string' && item.role.length > 0 ? [item.role] : [];
      const vocabRels = Array.isArray(item.relationships)
        ? item.relationships.map((r) => r.role)
        : [];
      const vocabCf = Array.isArray(item.customFields)
        ? item.customFields.map((c) => c.label)
        : [];
      await vocabulary.add({
        ...(vocabRoles.length > 0 && { roles: vocabRoles }),
        ...(vocabRels.length > 0 && { relationshipRoles: vocabRels }),
        ...(vocabCf.length > 0 && { fieldLabels: vocabCf }),
      });
    } catch (err) {
      log.warn({ err, contactId: contact.contactId }, 'vocabulary add failed (best-effort)');
    }
    res.status(201).json({ contact });
  });

  // GET /api/contacts/vocabulary — auto-suggest vocabulary (sorted, deduped).
  // MUST be registered BEFORE GET /:contactId so the literal segment `vocabulary`
  // is not captured as a contactId param.
  router.get('/vocabulary', async (_req, res) => {
    const vocab = await vocabulary.get();
    res.json({ vocabulary: vocab });
  });

  // GET /api/contacts/:contactId — the side-panel contact item. The returned
  // shape is a SUPERSET of the legacy one: the scalar `phone` stays intact and
  // `phones` (C1) is populated from contactPhones() (back-compat: a scalar-only
  // contact serializes as [{phone, primary:true}]). Never mutates stored items.
  router.get('/:contactId', async (req, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const contact = await contacts.getById(contactId);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    // BE1 hardening: a phone-pointer item (phone_ref) is an INTERNAL routing
    // record, not a contact — never surface it as one. (Repo getById stays
    // pointer-returning because the pointer-hop in findByPhone relies on it; the
    // guard lives at the route only.)
    if (contact.phone_ref === true) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    res.json({
      contact: { ...contact, phones: contactPhones(contact), emails: contactEmails(contact) },
    });
  });

  // GET /api/contacts/:contactId/listings-sent — the tenant page's "Properties
  // sent" (BE4/C4). Returns { sent: ListingSendRow[] } via listByContact
  // (newest-first by sentAt). Returns [] for none. A phone-pointer id (BE1's
  // internal routing record) is a 404 — never a contact, never a properties owner.
  // (`listings-sent` is a distinct segment from the bare :contactId routes, so
  // there is no route collision.)
  router.get('/:contactId/listings-sent', async (req, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const contact = await contacts.getById(contactId);
    if (!contact || contact.phone_ref === true) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    const rows = await listingSends.listByContact(contactId);
    // Derive the per-row tour chip from the tenant's tours (ONE byTenant GSI
    // query, grouped by unitId). Best-effort (E3): a tours-query failure serves
    // the rows WITHOUT any tour field and logs - never a 500 on the join.
    let toursByUnit: Map<string, TourItem[]> | undefined;
    try {
      const tenantTours = await tours.listByTenant(contactId);
      toursByUnit = new Map<string, TourItem[]>();
      for (const t of tenantTours) {
        const arr = toursByUnit.get(t.unitId);
        if (arr === undefined) toursByUnit.set(t.unitId, [t]);
        else arr.push(t);
      }
    } catch (err) {
      log.warn({ err, contactId }, 'listings-sent tour-chip hydration failed (best-effort)');
    }
    res.json({
      sent: rows.map((row) => {
        const pairing = toursByUnit?.get(row.unitId);
        const signal = pairing !== undefined ? deriveTourSignal(pairing) : undefined;
        return toListingSendRow(row, signal);
      }),
    });
  });

  // GET /api/contacts/:contactId/relay-groups → { groups: RelayGroupRow[] }.
  // The contact page's "Group texts" card: every relay_group thread whose
  // roster includes this contact — by roster contactId OR any of the contact's
  // numbers — open AND closed, newest-activity-first. There is NO
  // member→conversation index (a relay's participant_phone is the POOL number;
  // rosters live in the un-indexed participants list), so this reads the two
  // relay status partitions via listRelayGroups (a bounded byLastActivity
  // Query + type filter — never a Scan; 1:1 threads only ever write 'open', so
  // the 'closed' partition is relays-only) and matches rosters in code — the
  // today.ts precedent. 404 unknown contact / phone-pointer id (mirrors the
  // sibling routes); { groups: [] } for a contact in no groups.
  router.get('/:contactId/relay-groups', async (req, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const contact = await contacts.getById(contactId);
    if (!contact || contact.phone_ref === true) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }

    // Membership across ALL the contact's numbers (roster entries always carry
    // a phone; contactId may be '' for members added by bare phone).
    const phones = new Set(contactPhones(contact).map((p) => p.phone));
    const isSelf = (p: ConversationParticipant): boolean =>
      (p.contactId !== '' && p.contactId === contactId) || phones.has(p.phone);

    const groups: RelayGroupRow[] = [];
    for (const status of ['open', 'closed'] as const) {
      const { items, truncated } = await conversations.listRelayGroups(status);
      if (truncated) {
        // No silent truncation — the partition walk hit its page budget, so
        // groups with older last-activity were never considered.
        log.warn(
          { contactId, status },
          'contact relay-groups: partition walk hit the page budget — older groups not considered',
        );
      }
      for (const conv of items) {
        const roster = conv.participants ?? [];
        if (!roster.some(isSelf)) continue;
        const otherMemberNames = roster
          .filter((p) => !isSelf(p))
          .map((p) => p.name)
          .filter((n): n is string => typeof n === 'string' && n.length > 0);
        groups.push({
          conversationId: conv.conversationId,
          status,
          ...(typeof conv.pool_number === 'string' &&
            conv.pool_number.length > 0 && { poolNumber: conv.pool_number }),
          memberCount: roster.length,
          lastActivityAt: conv.last_activity_at,
          owner: getOwner(conv),
          ...(typeof conv['placement_tag'] === 'string' &&
            conv['placement_tag'].length > 0 && { tag: conv['placement_tag'] }),
          otherMemberNames,
        });
      }
    }
    // Newest activity first across BOTH partitions (each partition read is
    // already ordered; the merge is not).
    groups.sort((a, b) =>
      a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0,
    );

    log.info({ contactId, groupCount: groups.length }, 'contact relay groups served');
    res.json({ groups });
  });

  // GET /api/contacts/:contactId/media → { media: ContactMediaItem[] } (BE5/C5).
  // The tenant/landlord page's Media panel: every mirrored MMS attachment across
  // the contact's 1:1 conversations (ALL their numbers), newest-first. Reuses the
  // timeline's cross-phone resolution (contactPhones → findByParticipantPhone →
  // dedupe conversationIds) and EXCLUDES relay_group threads (those front a pool
  // number, never the contact's real 1:1 — group-text media is never inlined).
  // 404 unknown contact / phone-pointer id (mirrors BE1's GET). Returns [] for a
  // contact with no media (never a 404 for "no media"). NO URL is generated —
  // the frontend fetches bytes via GET /api/messages/:sid/media/:idx using s3Key.
  // Auth-gated (this router sits behind requireAuth via the /api mount).
  router.get('/:contactId/media', async (req, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const contact = await contacts.getById(contactId);
    if (!contact || contact.phone_ref === true) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }

    // Resolve the contact's 1:1 conversations across ALL their numbers — exactly
    // like the merged timeline. relay_group threads front a pool number (never
    // the contact's real phone), so they are excluded purely on type.
    const phones = contactPhones(contact).map((p) => p.phone);
    const convById = new Map<string, string>(); // conversationId → (presence)
    for (const phone of phones) {
      const linked = await conversations.findByParticipantPhone(phone);
      for (const conv of linked) {
        if (conv.type === 'relay_group') continue; // pool-number thread, not 1:1
        convById.set(conv.conversationId, conv.conversationId);
      }
    }

    // Single pass: collect every attachment of every media-bearing message.
    const media: ContactMediaItem[] = [];
    for (const conversationId of convById.keys()) {
      // Probe one PAST the cap (limit = cap + 1): if MORE than the cap came back
      // the thread is genuinely truncated; a thread of EXACTLY the cap is
      // complete (no false-positive warn). Process at most the newest `cap`.
      const fetched = await messages.listByConversation(conversationId, {
        limit: MEDIA_SCAN_PAGE_LIMIT + 1,
      });
      const truncated = fetched.length > MEDIA_SCAN_PAGE_LIMIT;
      const page = truncated ? fetched.slice(0, MEDIA_SCAN_PAGE_LIMIT) : fetched;
      if (truncated) {
        // No silent truncation — record that older media for this thread was not
        // scanned (the page is newest-first, so the dropped media is the oldest).
        log.warn(
          { contactId, conversationId, scanned: page.length, cap: MEDIA_SCAN_PAGE_LIMIT },
          'contact media: conversation hit the scan cap — older media not aggregated',
        );
      }
      for (const m of page) {
        const attachments = mediaAttachmentsOf(m);
        for (const a of attachments) {
          media.push({
            s3Key: a.s3Key,
            contentType: a.contentType,
            at: m.provider_ts,
            conversationId,
          });
        }
      }
    }

    // Newest-first by `at`; stable tie-break by s3Key so equal-timestamp items
    // (and multiple attachments on one message) order deterministically.
    media.sort((a, b) =>
      a.at < b.at ? 1 : a.at > b.at ? -1 : a.s3Key < b.s3Key ? -1 : a.s3Key > b.s3Key ? 1 : 0,
    );

    log.info({ contactId, conversationCount: convById.size, mediaCount: media.length }, 'contact media served');
    res.json({ media });
  });

  // PATCH /api/contacts/:contactId — triage an existing contact.
  router.patch('/:contactId', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });

    const parsed = parseTriageBody(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    // Read the pre-update contact ONCE, up front: it backs the type-scoped status
    // re-validation and the 404 checks below, and lets the post-update milestone
    // emit diff `status` against its prior value without a second fetch. Snapshot
    // the prior status as a primitive NOW — `contacts.update` may return/mutate the
    // same object graph, so reading `stored.status` after the write is unreliable.
    const stored = await contacts.getById(contactId);
    const priorStatus = typeof stored?.status === 'string' ? stored.status : undefined;

    // The resolved 1:1 type, if triage set type=tenant|landlord this PATCH.
    const newType = parsed.patch['type'];
    const convType = isContactType(newType) ? conversationTypeFor(newType) : undefined;

    // Type-scoped re-validation (status-model unification): when this triage
    // sets `status` but NOT `type`, parseTriageBody accepted any known status
    // value (it can't see the stored type). Re-check it against the STORED
    // contact's effective type so a tenant lifecycle value can't be written onto
    // a non-tenant (and vice-versa). 404 unknown contacts as the update would.
    if ('status' in parsed.patch && !('type' in parsed.patch)) {
      if (!stored) {
        res.status(404).json({ error: 'contact_not_found' });
        return;
      }
      const allow = statusAllowlistFor(stored.type);
      if (!allow.includes(String(parsed.patch['status']))) {
        res.status(400).json({ error: `status must be one of: ${allow.join(', ')}` });
        return;
      }
    }

    // AUTO-ADVANCE (Cluster A): resolving identity to tenant|landlord|partner
    // moves the contact off the needs_review triage front door at the moment the
    // identity is known — but only when the caller didn't set status itself (an
    // explicit status always wins). Type-scoped (status-model unification — one
    // `status` field): tenant -> 'onboarding' (the section 5 lifecycle starts past
    // the front door); landlord -> 'interested' (a freshly identified landlord is a
    // LEAD; 'active' means their properties are onboarded -
    // landlord-status-onboarding design D1); partner -> 'active' (partner has no
    // rich lifecycle — NON_TENANT_STATUSES needs_review|active — so a resolved
    // partner is simply off the front door). We do NOT stamp status_source -
    // leaving provenance unset keeps the tenant lifecycle DERIVABLE by the first
    // placement transition (a 'manual' pin would block it: the create-pin
    // regression - docs/issues/status-pin-vs-terminal-derivation.md). We never
    // auto-advance for unknown/team_member (no 1:1 identity) - and never
    // fabricate a name to do it.
    if (convType !== undefined && !('status' in parsed.patch)) {
      parsed.patch['status'] =
        newType === 'tenant' ? 'onboarding' : newType === 'landlord' ? 'interested' : 'active';
      parsed.changedFields.push('status');
    }

    // Re-typing without an explicit status: if the STORED status isn't valid for
    // the new type (e.g. a tenant lifecycle value like 'placing' lingering after
    // a tenant is re-typed to team_member), normalize it to the new type's
    // default so we never persist an invalid (type, status) pair.
    //
    // REACHABILITY (be precise - review 2026-07-13): convType is derived from the
    // TARGET type (conversationTypeFor above), so a re-type to tenant/landlord
    // ALWAYS takes the auto-advance branch and never reaches this fallback. The
    // only reachable targets here are team_member and unknown. The tenant/
    // landlord arms below are therefore UNREACHABLE defensive mappings, kept
    // type-correct so this branch stays safe if the auto-advance guard ever
    // changes:
    //   - unknown -> 'needs_review' (back to the front door)  [reachable]
    //   - team_member -> 'active' (no lifecycle)              [reachable]
    //   - tenant -> 'onboarding', landlord -> 'interested'    [defensive only]
    if (isContactType(newType) && convType === undefined && !('status' in parsed.patch)) {
      if (!stored) {
        res.status(404).json({ error: 'contact_not_found' });
        return;
      }
      if (!statusAllowlistFor(newType).includes(stored.status ?? '')) {
        parsed.patch['status'] =
          newType === 'unknown'
            ? 'needs_review'
            : newType === 'tenant'
              ? 'onboarding'
              : newType === 'landlord'
                ? 'interested'
                : 'active';
        parsed.changedFields.push('status');
      }
    }

    // A2P/CTIA: when this PATCH records consent, stamp consent_captured_by from
    // the SESSION user server-side (never a client-supplied value — the parser
    // rejects one). This is the JIT modal's record-consent write.
    if (parsed.consentCaptured === true) {
      parsed.patch['consent_captured_by'] = req.user?.userId;
      parsed.changedFields.push('consent_captured_by');
    }

    // Capture the PRIOR stored voucher date BEFORE the write so the voucher
    // sync below can fire only on a REAL change (see the sync block). Read once,
    // and only when the PATCH actually touches voucher_expiration_date.
    const priorVoucherDate =
      'voucher_expiration_date' in parsed.patch
        ? (await contacts.getById(contactId))?.voucher_expiration_date
        : undefined;

    // conversation-fact-extraction (T8): a human edit SUPERSEDES the AI. For every
    // changed extractable field, clear its `<field>_source` provenance (null ->
    // REMOVE) so the AutoBadge disappears - UNLESS the incoming patch itself carries
    // the provenance (future-proofing; the dashboard never sends one today).
    for (const f of parsed.changedFields) {
      if (PROVENANCE.has(f) && !(`${f}_source` in parsed.patch)) {
        parsed.patch[`${f}_source`] = null;
      }
    }

    let updated;
    try {
      updated = await contacts.update(contactId, parsed.patch);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'contact_not_found' });
        return;
      }
      throw err;
    }

    // conversation-fact-extraction (T8): a human edit supersedes any pending AI
    // suggestion for the same field (and a `type` change supersedes the type
    // recommendation). Best-effort - a suggestion-store hiccup never fails the PATCH.
    for (const f of parsed.changedFields) {
      try {
        await extraction.deleteSuggestion(contactId, f);
      } catch (err) {
        log.warn({ err, contactId, field: f }, 'extraction deleteSuggestion (human edit) failed (best-effort)');
      }
    }

    // VOUCHER SYNC (placement-deadline-model §6): when this PATCH changed
    // voucher_expiration_date, upsert/retire the `voucher_expiration` deadline on
    // the tenant's ACTIVE (non-terminal) placements and emit a placement.updated
    // (recomputed soonest) for each. BEST-EFFORT after the contact write — a
    // placement hiccup NEVER fails the PATCH (log.warn on failure). A `null`
    // patch value (cleared) retires; a string value (re)arms.
    if ('voucher_expiration_date' in parsed.patch) {
      const raw = parsed.patch['voucher_expiration_date'];
      const date = typeof raw === 'string' ? raw : undefined; // null → clear
      // Only sync on a REAL change: canonicalize the NEW value and the PRIOR
      // stored one identically (a valid date → its ISO instant; absent/'' → the
      // cleared sentinel) and compare. A raw-API caller that merely echoes the
      // same voucher_expiration_date must NOT trigger redundant arm/retire writes
      // + placement.updated SSE fan-out on every active placement.
      const canonicalVoucher = (v: unknown): string | undefined =>
        typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v))
          ? new Date(v).toISOString()
          : undefined;
      const voucherChanged = canonicalVoucher(raw) !== canonicalVoucher(priorVoucherDate);
      if (voucherChanged) {
        try {
          let exclusiveStartKey: Record<string, unknown> | undefined;
          do {
            const page = await placements.listByTenant(contactId, {
              ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
            });
            for (const p of page.items) {
              if (TERMINAL_STAGES.has(p.stage)) continue; // terminal untouched
              if (date !== undefined) {
                await placementDeadlines.arm(p.placementId, 'voucher_expiration', date);
              } else {
                await placementDeadlines.retire(p.placementId, 'voucher_expiration');
              }
              const ds = await placementDeadlines.listByPlacement(p.placementId);
              events.emit('placement.updated', toPlacementUpdatedEvent(p, soonestDeadline(ds)));
            }
            exclusiveStartKey = page.lastEvaluatedKey;
          } while (exclusiveStartKey !== undefined);
        } catch (err) {
          log.warn({ err, contactId }, 'voucher deadline sync failed (best-effort)');
        }
      }
    }

    // DENORMALIZE (Cluster D): the inbox is one Query and the conversation row
    // carries no name — copy the resolved "First Last" onto the linked
    // thread(s) so rows show the person, not the phone. HONEST: null when no
    // name is known (the inbox falls back to the phone, never a guess).
    const displayName = displayNameOf(updated);

    // PROPAGATE resolved identity + name to the linked conversation(s) (the
    // M1.5 seam) and EMIT a live conversation.updated for each touched thread
    // so connected inboxes update without a reload (Cluster C).
    let propagatedConversations = 0;
    const phone = typeof updated.phone === 'string' ? updated.phone : undefined;
    // Touch threads when EITHER identity resolved (flip unknown_1to1) OR a name
    // is known to denormalize (so naming a contact without typing it still
    // surfaces in the inbox).
    if (phone !== undefined && (convType !== undefined || displayName !== null)) {
      const linked = await conversations.findByParticipantPhone(phone);
      for (const conv of linked) {
        // Only FLIP an UNKNOWN thread — never re-type a thread already resolved
        // to a different identity (a triage conflict the human must reconcile,
        // never silently overwritten). The name still denormalizes onto it.
        const flipType = convType !== undefined && conv.type === 'unknown_1to1';
        if (!flipType && displayName === null) continue; // nothing to write
        const fresh = await conversations.applyTriage(conv.conversationId, {
          ...(flipType && { type: convType }),
          displayName, // null leaves the name untouched
        });
        if (flipType) propagatedConversations += 1;
        events.emit('conversation.updated', toConversationUpdatedEvent(fresh));
      }

      // Triage re-extraction: a flip to TENANT makes the tenant-only facts
      // (voucherSize/housingAuthority/pets/...) the apply layer IGNORED for the
      // unknown type applicable — schedule an IMMEDIATE 'triage' run per linked
      // thread so those facts land now, not on the next inbound. The 'triage'
      // channel bypasses the job's client-freshness gate (the content is
      // already behind the cursor). Tenant ONLY: landlord/team_member contacts
      // are ineligible in the job, so a row would be a guaranteed no-op.
      // Best-effort — a schedule failure never fails the triage response.
      if (aiExtractionEnabled && newType === 'tenant') {
        const nowIso = new Date().toISOString();
        for (const conv of linked) {
          try {
            await extraction.scheduleExtraction(conv.conversationId, 'triage', nowIso);
          } catch (err) {
            log.warn(
              { err, contactId, conversationId: conv.conversationId },
              'triage re-extraction schedule failed (best-effort)',
            );
          }
        }
      }
    }

    await audit.append(`contacts#${contactId}`, 'contact_updated', {
      fields: parsed.changedFields,
      actor: req.user?.userId,
      ...(propagatedConversations > 0 && { propagatedConversations, conversationType: convType }),
    });

    // Best-effort contact-timeline milestone on a REAL status change from the
    // edit form (closes the gap the transition-service path doesn't cover). The
    // handler may auto-set `status` even when the client didn't send it; the
    // `!== stored.status` diff guard suppresses a no-op milestone in that case.
    if (typeof parsed.patch.status === 'string' && stored && parsed.patch.status !== priorStatus) {
      const labels = stored.type === 'landlord' ? LANDLORD_STATUS_LABELS : TENANT_STATUS_LABELS;
      try {
        await activityEvents.record({
          contactId,
          type: 'contact_status_changed',
          label: `Status → ${(labels as Record<string, string>)[parsed.patch.status] ?? parsed.patch.status}`,
        });
      } catch (err) {
        log.error({ err, contactId }, 'contact_status_changed (edit) milestone record failed (best-effort)');
      }
    }
    log.info(
      { contactId, fields: parsed.changedFields, propagatedConversations, actor: req.user?.userId },
      'contact triaged',
    );

    // Best-effort vocabulary write: collect tokens from this patch.
    // Never fails the response.
    try {
      const patchRoles =
        typeof parsed.patch['role'] === 'string' && parsed.patch['role'].length > 0
          ? [parsed.patch['role']]
          : [];
      const patchRels = Array.isArray(parsed.patch['relationships'])
        ? (parsed.patch['relationships'] as { role: string }[]).map((r) => r.role)
        : [];
      const patchCf = Array.isArray(parsed.patch['customFields'])
        ? (parsed.patch['customFields'] as { label: string }[]).map((c) => c.label)
        : [];
      await vocabulary.add({
        ...(patchRoles.length > 0 && { roles: patchRoles }),
        ...(patchRels.length > 0 && { relationshipRoles: patchRels }),
        ...(patchCf.length > 0 && { fieldLabels: patchCf }),
      });
    } catch (err) {
      log.warn({ err, contactId }, 'vocabulary add failed on patch (best-effort)');
    }

    res.json({ contact: updated });
  });

  // POST /api/contacts/:contactId/opt-out { optOut: boolean } → 200 { contact }.
  // POST /api/contacts/:contactId/conversation → 200 { conversation }. Create-or-
  // get the 1:1 thread for the contact's PRIMARY number, so the dashboard can text
  // a BRAND-NEW contact that has never messaged us (no thread exists yet → the
  // reply box had nothing to send into and stayed disabled). Idempotent — the repo
  // primitive is the same one-active-conversation-per-phone claim every inbound
  // path uses, so a racing inbound never creates a duplicate. The type mirrors the
  // resolved-identity rule (tenant_1to1 / landlord_1to1, else unknown_1to1); the
  // contact's display name is denormalized on so the inbox row shows the person.
  router.post('/:contactId/conversation', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });

    const contact = await contacts.getById(contactId);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }

    const phones = contactPhones(contact);
    const primary = phones.find((p) => p.primary) ?? phones[0];
    if (!primary) {
      res.status(400).json({ error: 'contact_has_no_phone' });
      return;
    }

    const type = conversationTypeFor(contact.type) ?? 'unknown_1to1';
    const conversation = await conversations.createOrGetByParticipantPhone(primary.phone, type);
    mergeContext({ conversationId: conversation.conversationId });

    // Denormalize the contact's name onto the thread (best-effort; the inbox
    // falls back to the phone without it) — a NEW thread has no display name yet.
    const displayName = displayNameOf(contact);
    if (displayName !== null && conversation.participant_display_name !== displayName) {
      try {
        const fresh = await conversations.applyTriage(conversation.conversationId, { displayName });
        events.emit('conversation.updated', toConversationUpdatedEvent(fresh));
        res.json({ conversation: fresh });
        return;
      } catch (err) {
        log.warn({ err, contactId }, 'contact conversation: name denorm failed (best-effort)');
      }
    }
    res.json({ conversation });
  });

  // Manually mark a contact Do-Not-Contact (sms_opt_out=true) or clear it. The
  // contact-level flag is authoritative for send suppression — the send wrapper
  // refuses on contact.sms_opt_out (sendMessage.ts gate) — so setting it here
  // stops outbound texts immediately, mirroring an inbound STOP. Clearing it is a
  // staff override (e.g. the contact re-consented by phone); the audit trail
  // records who toggled it. (Conversation-level denorm isn't propagated here; the
  // contact flag governs suppression.)
  router.post('/:contactId/opt-out', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });

    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b['optOut'] !== 'boolean') {
      res.status(400).json({ error: 'optOut (boolean) is required' });
      return;
    }
    const optOut = b['optOut'];

    // Existence check up front so the 404 is independent of how setFlag signals a
    // missing row (the real repo throws ConditionalCheckFailedException).
    const existing = await contacts.getById(contactId);
    if (!existing) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }

    if (optOut) {
      await contacts.setFlag(contactId, 'sms_opt_out');
    } else {
      await contacts.clearFlag(contactId, 'sms_opt_out');
    }

    await audit.append(`contacts#${contactId}`, 'contact_opt_out_changed', {
      optOut,
      actor: req.user?.userId,
    });
    // Best-effort contact-timeline milestone (never fails the toggle route).
    try {
      await activityEvents.record({
        contactId,
        type: 'opt_out_changed',
        label: optOut ? 'Marked Do Not Contact' : 'Do Not Contact cleared',
      });
    } catch (err) {
      log.error({ err, contactId }, 'opt_out_changed (sms) milestone record failed (best-effort)');
    }
    log.info({ contactId, optOut, actor: req.user?.userId }, 'contact sms_opt_out toggled');
    // Reflect the new flag without a second round-trip.
    res.json({ contact: withPhones({ ...existing, sms_opt_out: optOut }) });
  });

  // POST /api/contacts/:contactId/voice-opt-out { optOut: boolean } → 200 { contact }
  // (Voice Phase 1, spec §8). The company DO-NOT-CALL toggle — honored by every
  // outbound originate path (409 contact_voice_opted_out) and the CallMenu.
  // INDEPENDENT of sms_opt_out (someone may allow texts but not calls). Mirrors
  // the sms opt-out route above.
  router.post('/:contactId/voice-opt-out', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });

    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b['optOut'] !== 'boolean') {
      res.status(400).json({ error: 'optOut (boolean) is required' });
      return;
    }
    const optOut = b['optOut'];

    const existing = await contacts.getById(contactId);
    if (!existing || existing.phone_ref === true) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }

    if (optOut) {
      await contacts.setFlag(contactId, 'voice_opt_out');
    } else {
      await contacts.clearFlag(contactId, 'voice_opt_out');
    }

    await audit.append(`contacts#${contactId}`, 'contact_voice_opt_out_changed', {
      optOut,
      actor: req.user?.userId,
    });
    // Best-effort contact-timeline milestone (never fails the toggle route).
    try {
      await activityEvents.record({
        contactId,
        type: 'opt_out_changed',
        label: optOut ? 'Marked Do Not Call' : 'Do Not Call cleared',
      });
    } catch (err) {
      log.error({ err, contactId }, 'opt_out_changed (voice) milestone record failed (best-effort)');
    }
    log.info({ contactId, optOut, actor: req.user?.userId }, 'contact voice_opt_out toggled');
    res.json({ contact: withPhones({ ...existing, voice_opt_out: optOut }) });
  });

  // Soft-delete/restore changes a contact's PRESENCE on the live views (Today
  // queue, inbox, placements board) without touching the conversation/placement
  // rows themselves — so nothing would emit an SSE and those views would keep a
  // stale card until a manual reload. Re-emit the existing conversation.updated +
  // placement.updated signals for the contact's threads + tenant placements: any
  // one triggers useToday's full refetch (which then filters the deleted contact),
  // and the inbox/board pick up their own rows too. BEST-EFFORT — the delete/restore
  // has already persisted; a fan-out hiccup must NEVER fail the request.
  const propagateContactPresenceChange = async (
    contactId: string,
    contact: ContactItem,
  ): Promise<void> => {
    try {
      const seen = new Set<string>();
      for (const p of contactPhones(contact)) {
        for (const conv of await conversations.findByParticipantPhone(p.phone)) {
          if (seen.has(conv.conversationId)) continue;
          seen.add(conv.conversationId);
          events.emit('conversation.updated', toConversationUpdatedEvent(conv));
        }
      }
    } catch (err) {
      log.warn({ err, contactId }, 'contact presence change: conversation fan-out failed (best-effort)');
    }
    // Cover a follow-up/deadline card whose contact has no 1:1 thread.
    try {
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await placements.listByTenant(contactId, {
          ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
        });
        for (const p of page.items) {
          const ds = await placementDeadlines.listByPlacement(p.placementId);
          events.emit('placement.updated', toPlacementUpdatedEvent(p, soonestDeadline(ds)));
        }
        exclusiveStartKey = page.lastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
    } catch (err) {
      log.warn({ err, contactId }, 'contact presence change: placement fan-out failed (best-effort)');
    }
  };

  // DELETE /api/contacts/:contactId → 200 { contact }. SOFT delete: stamps
  // deleted_at so the record + ALL its data are retained (POST .../restore brings
  // it back), but it's hidden from the contact lists, inbox, today, and broadcast
  // targeting. Phone routing still resolves the number to this record (no dupes on
  // re-contact). Audited. 404 when the contact doesn't exist.
  router.delete('/:contactId', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });

    const deletedAt = new Date().toISOString();
    let updated;
    try {
      updated = await contacts.softDelete(contactId, deletedAt);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'contact_not_found' });
        return;
      }
      throw err;
    }

    await audit.append(`contacts#${contactId}`, 'contact_deleted', {
      actor: req.user?.userId,
      deletedAt,
    });
    // Refresh the live views so this contact's Today/inbox cards drop without a reload.
    await propagateContactPresenceChange(contactId, updated);
    log.info({ contactId, actor: req.user?.userId }, 'contact soft-deleted');
    res.json({ contact: withPhones(updated) });
  });

  // POST /api/contacts/:contactId/restore → 200 { contact }. Clear deleted_at,
  // bringing a soft-deleted contact back into the normal views. Audited; 404 when
  // the contact doesn't exist.
  router.post('/:contactId/restore', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });

    let updated;
    try {
      updated = await contacts.restore(contactId);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'contact_not_found' });
        return;
      }
      throw err;
    }

    await audit.append(`contacts#${contactId}`, 'contact_restored', {
      actor: req.user?.userId,
    });
    // Refresh the live views so this contact's Today/inbox cards return without a reload.
    await propagateContactPresenceChange(contactId, updated);
    log.info({ contactId, actor: req.user?.userId }, 'contact restored');
    res.json({ contact: withPhones(updated) });
  });

  // --- BE1/C1 contact-phones CRUD (manual curation / merge) ------------------
  // The response always re-serializes phones via contactPhones() so the wire
  // shape is consistent with GET /:contactId (an addPhone that just materialized
  // phones[] from the scalar still returns the canonical array).
  function withPhones(contact: ContactItem): ContactItem & { phones: ReturnType<typeof contactPhones> } {
    return { ...contact, phones: contactPhones(contact) };
  }

  // POST /api/contacts/:contactId/phones { phone, label? } → 200 { contact }.
  // 200 (not 201): this is an idempotent upsert into the contact's phone roster
  // returning the parent contact (re-posting the same number is a no-op), NOT a
  // new top-level resource — consistent with POST /api/units/:id/contacts (BE3).
  // 404 unknown contact; 400 invalid body; 409 when the (normalized) number
  // already resolves to a DIFFERENT contact (one-number-per-contact, mirroring
  // the POST / dedupe policy).
  router.post('/:contactId/phones', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });

    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const b = body as Record<string, unknown>;
    if (typeof b['phone'] !== 'string') {
      res.status(400).json({ error: 'phone is required and must be a string' });
      return;
    }
    const normalized = normalizeToE164(b['phone']);
    if (normalized === undefined) {
      res.status(400).json({ error: 'phone is not a valid phone number' });
      return;
    }
    let label: string | undefined;
    if ('label' in b) {
      if (typeof b['label'] !== 'string') {
        res.status(400).json({ error: 'label must be a string' });
        return;
      }
      label = b['label'];
    }

    // Conflict guard: the number must not already resolve to another contact
    // (findByPhone is pointer-aware, so this covers BOTH a primary scalar AND a
    // pointer-attached number on some other contact). A number that already
    // resolves to THIS contact falls through to addPhone's idempotent no-op.
    const owner = await contacts.findByPhone(normalized);
    if (owner && owner.contactId !== contactId) {
      res.status(409).json({ error: 'phone_in_use', contact: owner });
      return;
    }

    // Was the number already attached? addPhone is an idempotent no-op for an
    // existing number — so we only emit the `number_added` milestone for a
    // genuinely NEW number (computed before the write, from the resolved owner
    // above: a known number resolving to THIS contact is already attached).
    const alreadyAttached = owner?.contactId === contactId;

    let updated: ContactItem;
    try {
      updated = await contacts.addPhone(contactId, {
        phone: normalized,
        ...(label !== undefined && { label }),
      });
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'contact_not_found' });
        return;
      }
      throw err;
    }

    await audit.append(`contacts#${contactId}`, 'contact_phone_added', {
      actor: req.user?.userId,
      phone: normalized,
    });
    // BE2/C2: a real number-add is a timeline milestone. Best-effort — a log
    // failure must never fail the curation action (the phone is already saved).
    if (!alreadyAttached) {
      try {
        await activityEvents.record({
          contactId,
          type: 'number_added',
          label: 'Number added',
        });
      } catch (err) {
        log.error({ err, contactId }, 'contact phone: recording number_added milestone failed');
      }
    }
    log.info({ contactId, actor: req.user?.userId }, 'contact phone added via api');
    res.status(200).json({ contact: withPhones(updated) });
  });

  // PATCH /api/contacts/:contactId/phones/:phone { primary?, label? } → { contact }.
  // :phone is a URL-encoded E.164; decode + normalize. 404 contact-or-phone
  // missing; 400 invalid body / no updatable field.
  router.patch('/:contactId/phones/:phone', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const normalized = decodePhoneParam(req.params['phone']);
    if (normalized === undefined) {
      res.status(400).json({ error: 'phone is not a valid phone number' });
      return;
    }

    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const b = body as Record<string, unknown>;
    const opts: { primary?: boolean; label?: string } = {};
    if ('primary' in b) {
      if (typeof b['primary'] !== 'boolean') {
        res.status(400).json({ error: 'primary must be a boolean' });
        return;
      }
      opts.primary = b['primary'];
    }
    if ('label' in b) {
      if (typeof b['label'] !== 'string') {
        res.status(400).json({ error: 'label must be a string' });
        return;
      }
      opts.label = b['label'];
    }
    if (opts.primary === undefined && opts.label === undefined) {
      res.status(400).json({ error: 'no updatable fields supplied (primary and/or label)' });
      return;
    }

    let updated: ContactItem;
    try {
      updated = await contacts.setPhone(contactId, normalized, opts);
    } catch (err) {
      // setPhone throws the conditional-check error for BOTH an unknown contact
      // and a phone not on the contact — either way the resource isn't there.
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'contact_or_phone_not_found' });
        return;
      }
      throw err;
    }

    await audit.append(`contacts#${contactId}`, 'contact_phone_updated', {
      actor: req.user?.userId,
      phone: normalized,
      ...(opts.primary !== undefined && { primary: opts.primary }),
    });
    log.info({ contactId, actor: req.user?.userId }, 'contact phone updated via api');
    res.json({ contact: withPhones(updated) });
  });

  // DELETE /api/contacts/:contactId/phones/:phone → 200 { contact }. 404
  // contact-or-phone missing; 409 when removing the primary while others remain.
  router.delete('/:contactId/phones/:phone', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const normalized = decodePhoneParam(req.params['phone']);
    if (normalized === undefined) {
      res.status(400).json({ error: 'phone is not a valid phone number' });
      return;
    }

    let updated: ContactItem;
    try {
      updated = await contacts.removePhone(contactId, normalized);
    } catch (err) {
      if (err instanceof PrimaryPhoneRemovalError) {
        res.status(409).json({ error: 'cannot_remove_primary' });
        return;
      }
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'contact_or_phone_not_found' });
        return;
      }
      throw err;
    }

    await audit.append(`contacts#${contactId}`, 'contact_phone_removed', {
      actor: req.user?.userId,
      phone: normalized,
    });
    log.info({ contactId, actor: req.user?.userId }, 'contact phone removed via api');
    res.json({ contact: withPhones(updated) });
  });

  // --- Email-channel A1 contact-emails CRUD (manual curation / merge) --------
  // The exact analog of the phone CRUD above; responses re-serialize emails via
  // contactEmails() so the wire shape matches GET /:contactId. Error codes
  // mirror the phone ones: email_in_use / cannot_remove_primary /
  // contact_or_email_not_found. Addresses are PII: the audit payload records the
  // address (system-of-record), but pino logs carry only contactId + actor.
  function withEmails(
    contact: ContactItem,
  ): ContactItem & { emails: ReturnType<typeof contactEmails> } {
    return { ...contact, emails: contactEmails(contact) };
  }

  // POST /api/contacts/:contactId/emails { email, label? } -> 200 { contact }.
  // 200 (idempotent upsert into the roster returning the parent contact), 404
  // unknown contact, 400 invalid body, 409 email_in_use when the (normalized)
  // address already resolves to a DIFFERENT contact (one-address-per-contact,
  // mirroring the POST / dedupe policy).
  router.post('/:contactId/emails', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });

    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const b = body as Record<string, unknown>;
    if (typeof b['email'] !== 'string') {
      res.status(400).json({ error: 'email is required and must be a string' });
      return;
    }
    const normalized = normalizeEmailAddress(b['email']);
    if (!isValidEmailAddress(normalized)) {
      res.status(400).json({ error: 'email is not a valid email address' });
      return;
    }
    let label: string | undefined;
    if ('label' in b) {
      if (typeof b['label'] !== 'string') {
        res.status(400).json({ error: 'label must be a string' });
        return;
      }
      label = b['label'];
    }

    // Conflict guard: the address must not already resolve to another contact
    // (findByEmail is pointer-aware, so this covers BOTH a primary scalar AND a
    // pointer-attached address on some other contact). An address that already
    // resolves to THIS contact falls through to addEmail's idempotent no-op.
    const owner = await contacts.findByEmail(normalized);
    if (owner && owner.contactId !== contactId) {
      res.status(409).json({ error: 'email_in_use', contact: owner });
      return;
    }

    let updated: ContactItem;
    try {
      updated = await contacts.addEmail(contactId, {
        email: normalized,
        ...(label !== undefined && { label }),
      });
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'contact_not_found' });
        return;
      }
      throw err;
    }

    await audit.append(`contacts#${contactId}`, 'contact_email_added', {
      actor: req.user?.userId,
      email: normalized,
    });
    log.info({ contactId, actor: req.user?.userId }, 'contact email added via api');
    res.status(200).json({ contact: withEmails(updated) });
  });

  // PATCH /api/contacts/:contactId/emails/:email { primary?, label? } -> { contact }.
  // :email is a URL-encoded address; decode + normalize. 404 contact-or-email
  // missing; 400 invalid body / no updatable field / invalid :email.
  router.patch('/:contactId/emails/:email', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const normalized = decodeEmailParam(req.params['email']);
    if (normalized === undefined) {
      res.status(400).json({ error: 'email is not a valid email address' });
      return;
    }

    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const b = body as Record<string, unknown>;
    const opts: { primary?: boolean; label?: string } = {};
    if ('primary' in b) {
      if (typeof b['primary'] !== 'boolean') {
        res.status(400).json({ error: 'primary must be a boolean' });
        return;
      }
      opts.primary = b['primary'];
    }
    if ('label' in b) {
      if (typeof b['label'] !== 'string') {
        res.status(400).json({ error: 'label must be a string' });
        return;
      }
      opts.label = b['label'];
    }
    if (opts.primary === undefined && opts.label === undefined) {
      res.status(400).json({ error: 'no updatable fields supplied (primary and/or label)' });
      return;
    }

    let updated: ContactItem;
    try {
      updated = await contacts.setPrimaryEmail(contactId, normalized, opts);
    } catch (err) {
      // setPrimaryEmail throws the conditional-check error for BOTH an unknown
      // contact and an address not on the contact - either way it isn't there.
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'contact_or_email_not_found' });
        return;
      }
      throw err;
    }

    await audit.append(`contacts#${contactId}`, 'contact_email_updated', {
      actor: req.user?.userId,
      email: normalized,
      ...(opts.primary !== undefined && { primary: opts.primary }),
    });
    log.info({ contactId, actor: req.user?.userId }, 'contact email updated via api');
    res.json({ contact: withEmails(updated) });
  });

  // DELETE /api/contacts/:contactId/emails/:email -> 200 { contact }. 404
  // contact-or-email missing; 409 when removing the primary while others remain.
  router.delete('/:contactId/emails/:email', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const normalized = decodeEmailParam(req.params['email']);
    if (normalized === undefined) {
      res.status(400).json({ error: 'email is not a valid email address' });
      return;
    }

    let updated: ContactItem;
    try {
      updated = await contacts.removeEmail(contactId, normalized);
    } catch (err) {
      if (err instanceof PrimaryEmailRemovalError) {
        res.status(409).json({ error: 'cannot_remove_primary' });
        return;
      }
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'contact_or_email_not_found' });
        return;
      }
      throw err;
    }

    await audit.append(`contacts#${contactId}`, 'contact_email_removed', {
      actor: req.user?.userId,
      email: normalized,
    });
    log.info({ contactId, actor: req.user?.userId }, 'contact email removed via api');
    res.json({ contact: withEmails(updated) });
  });

  return router;
}
