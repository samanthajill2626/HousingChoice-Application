// contacts repo — resolve a phone to a person (the hottest lookup in the
// system, doc §5), set messaging flags, and (M1.2) the conditional-create
// primitive auto-capture is built on. Items stay flexible documents; only
// keys/GSI attributes are contractual (lib/tables.ts).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { getTableSpec } from '../lib/tables.js';
import type { ConsentMethod } from '../lib/smsCompliance.js';
import type { TransitionSource } from '../lib/statusModel.js';
import type { RepoDeps } from './conversationsRepo.js';

/**
 * Suppression flags (doc §7.1 error-class handling + Voice Phase 1 §8):
 * sms_opt_out — STOP/21610 suppression; sends are REFUSED.
 * sms_unreachable — 30005/30006 (invalid number / landline); prompt voice.
 * voice_opt_out — staff-set company do-not-call; originate paths REFUSE.
 *   INDEPENDENT of sms_opt_out (someone may allow texts but not calls).
 * email_opt_out - SES Complaint (recipient marked spam); email sends REFUSE.
 * email_unreachable - SES permanent Bounce (bad address); email sends REFUSE.
 *   Both email flags are set by the B5 event pipeline (services/emailEvents.ts)
 *   and gate the A5 send -> 409 email_suppressed. INDEPENDENT of the sms flags.
 * setFlag/clearFlag handle any value generically (the flag IS the attribute
 * name), so this union is the single place a new suppression flag is added.
 */
export type ContactFlag =
  | 'sms_opt_out'
  | 'sms_unreachable'
  | 'voice_opt_out'
  | 'email_opt_out'
  | 'email_unreachable';

/**
 * Contact types (doc §5, plus `unknown` — 2026-06-12 deviation): auto-capture
 * NEVER records guessed identity as fact, so stubs are created as `unknown`
 * with status `needs_review`. On the byTypeStatus GSI, (type=unknown,
 * status=needs_review) IS the human triage queue, resolved by the M1.4/M1.5
 * review flows.
 */
export type ContactType = 'tenant' | 'landlord' | 'partner' | 'team_member' | 'unknown';

/**
 * One phone number a contact owns (BE1/C1 — contract verbatim; the frontend
 * imports the same shape). Exactly one entry is `primary: true`. The primary
 * is mirrored onto the legacy scalar `phone` (the byPhone-indexed attribute,
 * back-compat); non-primary numbers are made resolvable via phone-pointer
 * items (see PHONE_REF_PREFIX / findByPhone).
 */
export interface ContactPhone {
  /** E.164. */
  phone: string;
  label?: string;
  /** Exactly one true across a contact's phones[]. */
  primary: boolean;
  /** ISO 8601 — when first observed. */
  firstSeenAt?: string;
  /** ISO 8601 — most recent inbound/outbound on this number. */
  lastSeenAt?: string;
}

/**
 * One email address a contact owns (email-channel A1 - the ContactPhone analog;
 * the frontend imports the same shape). Exactly one entry is `primary: true`.
 * The primary is mirrored onto the legacy scalar `email` (the byEmail-indexed
 * attribute); non-primary addresses are made resolvable via email-pointer items
 * (see EMAIL_REF_PREFIX / findByEmail), exactly as phones do.
 */
export interface ContactEmail {
  /** Normalized: trim + lowercase (lib/email.ts). */
  email: string;
  label?: string;
  /** Exactly one true across a contact's emails[]. */
  primary: boolean;
  /** ISO 8601 - when first observed. */
  firstSeenAt?: string;
  /** ISO 8601 - most recent inbound/outbound on this address. */
  lastSeenAt?: string;
}

export interface ContactItem {
  contactId: string;
  type: ContactType;
  /**
   * The contact's SINGLE lifecycle status — type-scoped (STATUS-MODEL.md §5):
   *   - tenant: the §5 lifecycle (TENANT_STATUSES) —
   *     needs_review/onboarding/searching/placing/placed/on_hold/inactive.
   *   - non-tenant (landlord/team_member/unknown): needs_review | active
   *     (they have no lifecycle).
   * A tenant has ONE status, not two — the lifecycle lives HERE, on the same
   * field that is the byTypeStatus GSI range key (partition=type, range=status).
   * That is safe: tenants live in the type='tenant' partition, so tenant
   * lifecycle values can never pollute the triage queue (type='unknown',
   * status='needs_review'). The GSI re-indexes on every status write (it is the
   * range key). Written directly (manual create / triage) or via the transition
   * service (statusTransition.ts) for the tenant lifecycle.
   */
  status?: string;
  /**
   * Status-model (§8): the source of the current `status` write
   * (provenance/precedence — TransitionSource). `derived` is lowest precedence;
   * a non-derived (manual/ai/automation/import) write pins and wins. Drives the
   * tenant lifecycle's derive-vs-override behavior; unset on plain non-tenant
   * contacts (whose status is set directly without provenance tracking).
   */
  status_source?: TransitionSource;
  /**
   * Status-model (§5): the porting flag — the voucher/RTA is being moved
   * between jurisdictions ("not ready"). INFORMATIONAL only: as of the
   * 2026-06-19 product decision it gates NOTHING (the RTA-in-hand→`searching`
   * gate was removed — the admin advances the tenant when the prerequisite is
   * satisfied). Porting lives on the TENANT, never as a placement stage.
   */
  porting?: boolean;
  /**
   * Landlord lead lifecycle (docs/issues/landlord-lead-status-and-park.md): the
   * free-text reason captured when a landlord contact is moved to the terminal
   * `parked` status (declined / not-a-fit / never-signed). Written by the
   * transition service on the `parked` move (from the supplied `reason`); unset
   * on non-parked contacts. Tenants never set it.
   */
  park_reason?: string;
  /** E.164 (byPhone GSI) — the PRIMARY number (back-compat scalar). */
  phone?: string;
  /**
   * BE1/C1: all numbers this contact owns. When ABSENT, treat as
   * `[{ phone, primary: true }]` (the legacy scalar) — see contactPhones().
   * Never mutated on read; serialized via contactPhones() on read responses.
   */
  phones?: ContactPhone[];
  /**
   * Email-channel A1: the PRIMARY email (byEmail GSI hash + back-compat scalar).
   * The email analog of `phone`. Normalized (trim + lowercase). ABSENT until the
   * contact has an address.
   */
  email?: string;
  /**
   * Email-channel A1: all addresses this contact owns. When ABSENT, treat as
   * `[{ email, primary: true }]` (the scalar) - see contactEmails(). Never
   * mutated on read; serialized via contactEmails() on read responses.
   */
  emails?: ContactEmail[];
  sms_opt_out?: boolean;
  sms_unreachable?: boolean;
  /**
   * Email suppression (email-channel B5): set by the SES event pipeline
   * (services/emailEvents.ts). email_opt_out = a Complaint (recipient marked our
   * mail as spam); email_unreachable = a permanent Bounce (undeliverable address).
   * Either REFUSES the A5 email send (409 email_suppressed). Set via the generic
   * setFlag/clearFlag('email_opt_out'|'email_unreachable'). Absent = allowed.
   */
  email_opt_out?: boolean;
  email_unreachable?: boolean;
  /**
   * Voice Phase 1 (spec §8): staff-set company do-not-call. Honored by every
   * outbound originate path (409 contact_voice_opted_out) and the CallMenu.
   * INDEPENDENT of sms_opt_out — a contact may allow texts but not calls (or
   * vice-versa). Set/cleared via setFlag/clearFlag('voice_opt_out').
   */
  voice_opt_out?: boolean;
  /**
   * Soft-delete marker (ISO 8601). PRESENT → the contact is "deleted": hidden
   * from the normal lists, today, and broadcast targeting, but the record
   * and ALL its data are retained so it can be restored (clear the stamp). Phone
   * routing (findByPhone) deliberately ignores it, so an inbound from a deleted
   * contact's number still maps to their record rather than spawning a duplicate.
   * The INBOX hides them too, with ONE exception: a deleted contact resurfaces
   * (row flagged `deleted`) while an UNREAD inbound newer than this stamp exists
   * — deleted-contact resurfacing, 2026-08-03 spec (see routes/inbox.ts).
   */
  deleted_at?: string;
  /** How the record came to exist (M1.2 auto-capture: 'inbound_sms'). */
  capture_source?: string;
  /** When auto-capture created the stub (ISO 8601). */
  captured_at?: string;
  created_at?: string;
  /**
   * A2P/CTIA consent model (spec §2). All OPTIONAL so a fast add stays fast; the
   * flexible-doc create/update path persists them without any special wiring.
   * "Has SMS consent" is derived off a non-empty `consent_method`
   * (lib/smsCompliance.ts → hasSmsConsent) — the single predicate the JIT gate
   * and broadcast fence read.
   */
  /** How consent was obtained (spec §2). web_form/inbound_text are stamped
   *  automatically; the other four are only ever set by a human. */
  consent_method?: ConsentMethod;
  /** When consent was obtained (ISO 8601) — may differ from created_at. */
  consent_at?: string;
  /**
   * First observed participation in a native group text (ISO 8601;
   * group-texting spec 4.4). A DISTINCT field from `consent_method` on purpose:
   * being added to a carrier group by someone else is NOT consent to be
   * messaged, so this must never make hasSmsConsent true. Written ONLY by the
   * group paths (migration conversion, detection member stubs), never rewritten
   * once set, and it is what the import retract guard conditions its contact
   * delete on.
   */
  group_participation_at?: string;
  /**
   * How a non-import, non-auto-capture record came to exist. Today the only
   * value is `'group_detection'` (services/groupMembers.ts), the marker the
   * import's `retractImported` refuses to delete a contact through. Distinct
   * from `capture_source`, which `consentMethodFromCaptureSource` maps back to
   * a CONSENT METHOD - overloading that field would smuggle consent in by the
   * back door for exactly the members the group ruling keeps consent-less.
   */
  origin?: string;
  /**
   * IN-PROGRESS IMPORT RETRACT (ISO 8601; lib/import/apply.ts). Written as the
   * non-destructive atomic guard at the top of a workbook `drop` retract, and
   * removed again if the retract ends up KEEPING the contact. A contact that
   * still carries it is a retract that DIED HALFWAY, which the next
   * `import:apply` reports and resumes - that read is the field's reason to
   * exist, and a write with no reader would be the very defect the same change
   * removed `imported_sender_phone` for.
   */
  import_retract_started_at?: string;
  /**
   * Staff-set tenant voucher expiration (ISO 8601) — the SOURCE of the
   * `voucher_expiration` placement deadline (placement-deadline-model §6). Set via
   * the contact create/triage API (allowlisted, canonicalized like consent_at);
   * a change syncs the deadline onto the tenant's active placements. Tenant-only
   * is a UI guarantee (not repo-gated). Distinct from the deadline TYPE
   * `voucher_expiration` and the unrelated camelCase `voucherSize`.
   */
  voucher_expiration_date?: string;
  /** The disclosure version shown on the web form (e.g. `ctia-2026-06`);
   *  absent for non-form methods. */
  consent_version?: string;
  /** Optional free-text note ("said OK to texts at fair"). */
  consent_note?: string;
  /** Actor userId when staff-entered; unset for automatic (form/inbound) methods. */
  consent_captured_by?: string;
  /**
   * Phone-pointer marker (BE1). A pointer item carries `phone_ref: true`,
   * `phone_ref_owner` (the real contactId), and the indexed scalar `phone`,
   * but NO type/status/housingAuthority — so it is invisible to byTypeStatus /
   * byHousingAuthority (never in lists/triage) yet findable via byPhone. The
   * primary number has NO pointer (it resolves via the owner's own scalar).
   */
  phone_ref?: boolean;
  phone_ref_owner?: string;
  /**
   * Email-pointer marker (email-channel A1 - the phone_ref analog). A pointer
   * item carries `email_ref: true`, `email_ref_owner` (the real contactId), and
   * the indexed scalar `email`, but NO type/status - invisible to byTypeStatus /
   * byHousingAuthority (never in lists/triage) yet findable via byEmail. The
   * primary address has NO pointer (it resolves via the owner's own scalar).
   */
  email_ref?: boolean;
  email_ref_owner?: string;
  /**
   * Eligibility intake (tenant onboarding). Free-text answers to the narrow LIF
   * questions, plus a boolean LIF-eligibility flag. First-class fields (not
   * customFields) so eligibility is reportable/filterable later.
   */
  pets?: string;
  evictions?: string;
  /** Time at current address (free text, e.g. "3 years"). */
  tenure?: string;
  lifEligible?: boolean;
  /**
   * Structured landlord deal terms + approval criteria (onboarding call —
   * docs/issues/landlord-onboarding-record-fields.md). First-class optional
   * fields, NOT type-gated: set/returned via the contact API, validated only
   * when supplied. `contract_status` records whether the (external) DocuSign
   * contract was signed; the booleans capture registration + approval criteria.
   */
  contract_status?: 'unsigned' | 'signed';
  registered_landlord?: boolean;
  rta_within_48h?: boolean;
  pass_inspection_first_try?: boolean;
  income_includes_voucher?: boolean;
  // NOTE (2026-07-10): expected_rent + the landlord preference defaults
  // (accepts_programs / lease_terms / pet_policy) MOVED to the UNIT — they are
  // per-property facts (rent_min-rent_max / accepted_authorities / lease_terms /
  // pets on UnitItem; GLOSSARY "Feature & label notes"). Rows written before
  // the move may still carry the attributes; flexible-doc posture — they
  // simply go unread.
  [key: string]: unknown;
}

/** The only contact fields needed to label another record in staff UI. */
export interface ContactDisplayItem {
  contactId: string;
  firstName?: unknown;
  lastName?: unknown;
  phone?: string;
}

/**
 * A contact is soft-deleted when it carries a non-empty `deleted_at` stamp.
 * Shared by the repo (query filters) and the inbox/today routes (hydration
 * filters) so "deleted" is defined in exactly one place.
 */
export function isDeleted(contact: Pick<ContactItem, 'deleted_at'>): boolean {
  return typeof contact.deleted_at === 'string' && contact.deleted_at.length > 0;
}

/** contactId prefix for a phone-pointer item: `phoneref#<E.164>`. */
export const PHONE_REF_PREFIX = 'phoneref#';

/** The pointer item's primary key (contactId) for a given E.164 number. */
export function phoneRefId(phone: string): string {
  return `${PHONE_REF_PREFIX}${phone}`;
}

/** contactId prefix for an email-pointer item: `emailref#<addr>` (A1). */
export const EMAIL_REF_PREFIX = 'emailref#';

/** The pointer item's primary key (contactId) for a given (normalized) email. */
export function emailRefId(email: string): string {
  return `${EMAIL_REF_PREFIX}${email}`;
}

/**
 * Back-compat read serializer (BE1/C1). Returns the contact's phones[] when
 * present & non-empty, else `[{ phone, primary: true }]` when only the legacy
 * scalar exists, else []. Pure — never mutates the stored item.
 */
export function contactPhones(contact: Pick<ContactItem, 'phone' | 'phones'>): ContactPhone[] {
  if (Array.isArray(contact.phones) && contact.phones.length > 0) return contact.phones;
  if (typeof contact.phone === 'string' && contact.phone.length > 0) {
    return [{ phone: contact.phone, primary: true }];
  }
  return [];
}

/**
 * The phones[] a WRITER must persist (BE1/C1): the stored array (copied) when
 * present and non-empty, else the legacy scalar materialized as the primary
 * entry, keeping its firstSeenAt (created_at) and stamping lastSeenAt.
 *
 * Pure, and the clock is a parameter: addPhone/setPhone pass the wall clock,
 * while the phase-fenced suggestion resolver passes the journal's claimedAt so
 * a replayed write produces identical bytes. Never persist contactPhones() -
 * that read serializer carries no timestamps and would destroy them.
 */
export function seedPhonesForWrite(
  contact: Pick<ContactItem, 'phone' | 'phones' | 'created_at'>,
  nowIso: string,
): ContactPhone[] {
  if (Array.isArray(contact.phones) && contact.phones.length > 0) {
    return contact.phones.map((p) => ({ ...p }));
  }
  if (typeof contact.phone === 'string' && contact.phone.length > 0) {
    return [
      {
        phone: contact.phone,
        primary: true,
        ...(typeof contact.created_at === 'string' && { firstSeenAt: contact.created_at }),
        lastSeenAt: nowIso,
      },
    ];
  }
  return [];
}

/**
 * Back-compat read serializer (email-channel A1 - the contactPhones() analog).
 * Returns the contact's emails[] when present & non-empty, else
 * `[{ email, primary: true }]` when only the scalar exists, else []. Pure -
 * never mutates the stored item.
 */
export function contactEmails(contact: Pick<ContactItem, 'email' | 'emails'>): ContactEmail[] {
  if (Array.isArray(contact.emails) && contact.emails.length > 0) return contact.emails;
  if (typeof contact.email === 'string' && contact.email.length > 0) {
    return [{ email: contact.email, primary: true }];
  }
  return [];
}

/**
 * Thrown by removePhone when the target is the PRIMARY number while other
 * numbers remain — the route maps this to a 409 ("promote another number
 * first"). A contact must never be left with zero primary.
 */
export class PrimaryPhoneRemovalError extends Error {
  constructor(message = 'cannot remove the primary phone; promote another number first') {
    super(message);
    this.name = 'PrimaryPhoneRemovalError';
  }
}

/**
 * Thrown by removeEmail when the target is the PRIMARY address while other
 * addresses remain (email-channel A1 - the PrimaryPhoneRemovalError analog) -
 * the route maps this to a 409. A contact must never be left with zero primary.
 */
export class PrimaryEmailRemovalError extends Error {
  constructor(message = 'cannot remove the primary email; promote another address first') {
    super(message);
    this.name = 'PrimaryEmailRemovalError';
  }
}

/**
 * Every GSI key attribute on the contacts table, derived from the ONE table
 * spec so a GSI added later is covered without touching this file.
 * Currently: phone, email, type, status, housingAuthority.
 *
 * Exported so the in-memory test double can enforce the same rule — a fake that
 * accepts what real DynamoDB refuses is worse than no fake.
 */
export const INDEX_KEY_ATTRIBUTES: ReadonlySet<string> = new Set(
  getTableSpec('contacts').gsis.flatMap((gsi) =>
    gsi.rangeKey ? [gsi.hashKey.name, gsi.rangeKey.name] : [gsi.hashKey.name],
  ),
);

/**
 * The index-key attributes a contact may never be WITHOUT - a STRICT SUBSET of
 * INDEX_KEY_ATTRIBUTES above.
 *
 * `byTypeStatus` is (hash: `type`, range: `status`), and DynamoDB does not index
 * an item that is missing a key attribute. Every read that ENUMERATES contacts
 * of a kind goes through that index - the Unknown triage tab, the Today triage
 * block, `GET /api/contacts?type=`, and audienceResolution - so a row that loses
 * `type` or `status` still reads back fine by id while ceasing to exist for all
 * of them. No error, no empty page, no counter: silent invisibility, which is
 * the worst failure class this codebase has met.
 *
 * The other three contacts GSIs are deliberately NOT here. byPhone, byEmail and
 * byHousingAuthority key on OPTIONAL attributes, and leaving their partition is
 * the CORRECT meaning of clearing the field: the contact edit form clears
 * housingAuthority with exactly this null -> REMOVE (routes/contacts.ts), and
 * removePhone/removeEmail unset those scalars by design. Guarding them would
 * break the very convention EmptyIndexKeyError's own message tells callers to
 * use.
 *
 * Derived from the table spec by index name rather than hand-listed; the
 * contents are PINNED in contactsRepo.integration.test.ts so renaming that
 * index cannot quietly empty the set and take the guard with it.
 */
const typeStatusGsi = getTableSpec('contacts').gsis.find(
  (gsi) => gsi.indexName === 'byTypeStatus',
);
export const REQUIRED_INDEX_KEY_ATTRIBUTES: ReadonlySet<string> = new Set(
  typeStatusGsi === undefined
    ? []
    : [
        typeStatusGsi.hashKey.name,
        ...(typeStatusGsi.rangeKey ? [typeStatusGsi.rangeKey.name] : []),
      ],
);

/**
 * Base for the two ways one update() patch can break a contact's GSI
 * membership. One family so a caller or a test double can catch the whole
 * class; each subclass names WHICH way and what to do instead.
 */
export class IndexKeyWriteError extends Error {
  constructor(
    public readonly attribute: string,
    message: string,
  ) {
    super(message);
    this.name = 'IndexKeyWriteError';
  }
}

/**
 * Thrown by update() when a patch would SET '' on a GSI key attribute.
 *
 * DynamoDB rejects that with a ValidationException ("The AttributeValue for a
 * key attribute cannot contain an empty string") whose stack points into the
 * SDK, not at the caller that meant "clear this field" — which is exactly how
 * the contact edit form's housingAuthority clear reached production as an
 * unhandled 500. Callers clear an indexed attribute with null (→ REMOVE), which
 * also correctly drops the item out of the sparse index. Non-key attributes are
 * unaffected: DynamoDB has allowed empty strings there since 2020, and the
 * plain text fields (notes/company/agency/...) rely on that.
 */
export class EmptyIndexKeyError extends IndexKeyWriteError {
  constructor(attribute: string) {
    super(
      attribute,
      `cannot set the indexed attribute '${attribute}' to an empty string; ` +
        'pass null to REMOVE it instead',
    );
    this.name = 'EmptyIndexKeyError';
  }
}

/**
 * Thrown by update() when a patch would REMOVE (null) an index key a contact
 * may not be without - today `type` or `status`, the byTypeStatus keys.
 *
 * The sibling above refuses ONE way of un-indexing a row ('' on a key
 * attribute); this refuses the other. They sat in ADJACENT LINES with only the
 * first guarded, so `update(id, { status: null })` returned a healthy-looking
 * ContactItem for a contact that had just stopped existing for every listByType
 * reader - the Unknown tab included - with no throw, no log and no counter.
 *
 * Deliberately NOT raised for phone/email/housingAuthority, whose sparse
 * partitions a contact is meant to be able to leave. See
 * REQUIRED_INDEX_KEY_ATTRIBUTES.
 */
export class RequiredIndexKeyRemovalError extends IndexKeyWriteError {
  constructor(
    attribute: string,
    public readonly contactId: string,
  ) {
    super(
      attribute,
      `cannot REMOVE the indexed attribute '${attribute}' from contact ${contactId}: ` +
        'it is a byTypeStatus key, so a contact missing it is invisible to every ' +
        'listByType read (the Unknown tab, triage, GET /api/contacts?type=) while ' +
        'still reading back by id. Write a real value instead, or soft-delete the ' +
        'contact if it should leave the lists.',
    );
    this.name = 'RequiredIndexKeyRemovalError';
  }
}

/**
 * A batch read could not fetch every key it was asked for - DynamoDB left keys
 * in `UnprocessedKeys` past the retries, or a chunk's request failed. Raised
 * ONLY for callers that passed `requireComplete`, because for them a short map
 * is a wrong ANSWER rather than a thin one: the broadcast send path would
 * silently drop the unread tenants from the send.
 *
 * This is emphatically NOT "a contact was not found" - a key the table answered
 * with no row is a complete read of an absent contact, and never raises this.
 */
export class IncompleteBatchReadError extends Error {
  constructor(
    public readonly unprocessed: number,
    public readonly requested: number,
  ) {
    super(
      `contacts batch read incomplete: ${unprocessed} of ${requested} keys unread ` +
        'after retries; the caller requires a complete read',
    );
    this.name = 'IncompleteBatchReadError';
  }
}

/** One page of a contacts list query (opaque cursor handled at the route). */
export interface ContactsPage {
  items: ContactItem[];
  lastEvaluatedKey?: Record<string, unknown>;
}

export interface ListContactsOpts {
  /** Narrow to a single status within the type partition (byTypeStatus range). */
  status?: string;
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
  /**
   * Soft-delete scope. Omitted/false → exclude deleted contacts (the default for
   * every normal list). true → return ONLY soft-deleted contacts (the Contacts
   * "Deleted" view). Applied as a FilterExpression on `deleted_at`.
   */
  deleted?: boolean;
  /**
   * Drop rows carrying this `origin` (fix wave 2, adversarial 6). A
   * FilterExpression, so it saves the CALLER work but NOT the page slot -
   * DynamoDB applies `Limit` at the index first. A caller that must not go blind
   * behind a wall of excluded rows therefore also has to page (see today.ts).
   */
  excludeOrigin?: string;
}

export interface ContactsRepo {
  /** Phone (E.164) → contact via the byPhone GSI; undefined when unknown. */
  findByPhone(phone: string): Promise<ContactItem | undefined>;
  getById(contactId: string, opts?: { consistentRead?: boolean }): Promise<ContactItem | undefined>;
  /** Read only the fields needed for a staff-facing contact label. */
  getDisplayById(contactId: string): Promise<ContactDisplayItem | undefined>;
  /** Batch-read display fields by primary key. Missing ids are absent from the map. */
  getDisplaysByIds(contactIds: string[]): Promise<Map<string, ContactDisplayItem>>;
  /**
   * Batch-read WHOLE contacts by primary key - the `getById` fan-out killer for
   * callers that read attributes outside the display projection (roster
   * `company`; the broadcast send path's `type`/`sms_opt_out`/`sms_unreachable`
   * re-fence). Prefer `getDisplaysByIds` when only a label is needed: same round
   * trips, far less data. Missing ids are absent from the map, exactly like
   * `getById` returning undefined - callers keep their own not-found handling.
   *
   * `requireComplete` throws IncompleteBatchReadError when the read could not
   * fetch every key (throttle/failure), rather than returning a short map. Pass
   * it when an absent key changes an OUTCOME rather than a label - a send that
   * silently skips tenants is not the same bug as a row without a name.
   */
  getManyByIds(
    contactIds: string[],
    opts?: { requireComplete?: boolean },
  ): Promise<Map<string, ContactItem>>;
  /**
   * List/filter via the byTypeStatus GSI (M1.5): all contacts of a type,
   * optionally narrowed by status (the (type=unknown, status=needs_review)
   * partition IS the triage queue). ONE Query per page — never a Scan.
   */
  listByType(type: ContactType, opts?: ListContactsOpts): Promise<ContactsPage>;
  /**
   * List tenants administered by a housing authority via the byHousingAuthority
   * GSI (M1.8a share-broadcast audience resolution). A voucher is administered
   * by exactly one authority at a time (doc §5), so this GSI is single-attribute
   * and tenant-sparse — ONE Query per page, never a Scan. The caller applies any
   * further in-memory filtering (bedroom size, opt-out/unreachable).
   */
  listByHousingAuthority(
    housingAuthority: string,
    opts?: ListContactsOpts,
  ): Promise<ContactsPage>;
  /**
   * Manual create (M1.5): generate a contactId and conditionally put it. Phone
   * dedupe is the CALLER's job (findByPhone first) — this is the raw create
   * once the route has decided a new contact is warranted. Returns the stored
   * item. The contactId is fresh + random, so the attribute_not_exists
   * condition effectively never fails (it's belt-and-braces).
   */
  create(input: Partial<ContactItem> & { type: ContactType }): Promise<ContactItem>;
  /**
   * Conditional create (attribute_not_exists(contactId)): true when THIS
   * call created the item, false when the contact already existed. An
   * existing contact's fields are NEVER overwritten — this is the M1.2
   * auto-capture no-overwrite guarantee, enforced at the write.
   */
  createIfAbsent(item: ContactItem): Promise<boolean>;
  setFlag(contactId: string, flag: ContactFlag): Promise<void>;
  /** Clear a flag (START/UNSTOP re-subscribes after a STOP, doc §7.1). */
  clearFlag(contactId: string, flag: ContactFlag): Promise<void>;
  /**
   * Soft-delete: stamp `deleted_at` (ISO 8601 `at`) so the contact is hidden from
   * lists/inbox/today/broadcasts while every field is retained. ConditionExpression
   * guards existence (route → 404). Returns the post-update item (ALL_NEW).
   * Inbox caveat: the thread resurfaces while an unread post-deletion inbound
   * exists (deleted-contact resurfacing, 2026-08-03 spec).
   */
  softDelete(contactId: string, at: string): Promise<ContactItem>;
  /** Restore a soft-deleted contact: REMOVE `deleted_at`. ALL_NEW; 404-guarded. */
  restore(contactId: string): Promise<ContactItem>;
  /**
   * Merge-update a contact (M1.4 triage). Only the supplied fields are
   * written (a SET update, never a full Put) — an absent field is LEFT as
   * stored, so a triage that sets only `type` never blanks a name. Pass a
   * field explicitly to clear it (the route decides what an empty value
   * means). Returns the post-update item (ALL_NEW). Throws
   * ConditionalCheckFailedException for unknown contacts.
   */
  update(contactId: string, patch: Record<string, unknown>): Promise<ContactItem>;

  /**
   * BE1/C1: attach a number to a contact. `phone` MUST already be normalized
   * E.164 (the route validates). Loads the contact (throws
   * ConditionalCheckFailedException when missing). If phones[] is absent, SEEDS
   * it from the legacy scalar (the existing primary). An already-present number
   * is an idempotent no-op. Otherwise appends a non-primary entry, persists
   * phones[], and writes the phone-pointer item (conditional put; a duplicate
   * pointer is swallowed). Returns the updated contact.
   */
  addPhone(contactId: string, opts: { phone: string; label?: string }): Promise<ContactItem>;
  /**
   * BE1/C1: update a number already in phones[] (else
   * ConditionalCheckFailedException → route 404). Sets `label` when supplied.
   * When `primary: true` and it isn't already primary: demotes the old primary,
   * promotes this one, swaps the scalar `phone`, and reconciles pointers
   * (delete this number's pointer, create one for the old primary). Maintains
   * exactly-one-primary. Returns the updated contact.
   */
  setPhone(
    contactId: string,
    phone: string,
    opts: { primary?: boolean; label?: string },
  ): Promise<ContactItem>;
  /**
   * BE1/C1: remove a non-primary number (drops its pointer). Removing the
   * PRIMARY while other numbers remain throws PrimaryPhoneRemovalError (route
   * 409). A number not in phones[] throws ConditionalCheckFailedException
   * (route 404). Returns the updated contact.
   */
  removePhone(contactId: string, phone: string): Promise<ContactItem>;
  /**
   * BE1: best-effort lastSeenAt bump for a number on inbound. No-op when
   * phones[] is absent (do NOT churn-seed a legacy/stub contact on every
   * inbound) or the number isn't in phones[]. Never throws on a missing entry.
   */
  touchPhoneLastSeen(contactId: string, phone: string, at: string): Promise<void>;

  /**
   * Email-channel A1 (the findByPhone analog): normalized email -> contact via
   * the byEmail GSI, pointer-aware (a non-primary address resolves to the owner
   * via its email-pointer item); undefined when unknown or a dangling pointer.
   */
  findByEmail(email: string): Promise<ContactItem | undefined>;
  /**
   * Email-channel A1 (the addPhone analog): attach an address to a contact.
   * `email` MUST already be normalized (the route validates). Loads the contact
   * (throws ConditionalCheckFailedException when missing). If emails[] is absent,
   * SEEDS it from the scalar (the existing primary). An already-present address
   * is an idempotent no-op. The first address becomes primary and is mirrored
   * to the scalar without a pointer. Later addresses are appended as
   * non-primary entries with email-pointer items. Returns the updated contact.
   * The route enforces the cross-contact `email_in_use` conflict (findByEmail).
   */
  addEmail(contactId: string, opts: { email: string; label?: string }): Promise<ContactItem>;
  /**
   * Email-channel A1 (the setPhone analog): update an address already in
   * emails[] (else ConditionalCheckFailedException -> route 404). Sets `label`
   * when supplied. When `primary: true` and it isn't already primary: demotes the
   * old primary, promotes this one, swaps the scalar `email`, and reconciles
   * pointers. `primary: false` is intentionally IGNORED. Maintains
   * exactly-one-primary. Returns the updated contact.
   */
  setPrimaryEmail(
    contactId: string,
    email: string,
    opts: { primary?: boolean; label?: string },
  ): Promise<ContactItem>;
  /**
   * Email-channel A1 (the removePhone analog): remove a non-primary address
   * (drops its pointer). Removing the PRIMARY while other addresses remain throws
   * PrimaryEmailRemovalError (route 409). An address not in emails[] throws
   * ConditionalCheckFailedException (route 404). Returns the updated contact.
   */
  removeEmail(contactId: string, email: string): Promise<ContactItem>;
  /**
   * Email-channel A1 (the touchPhoneLastSeen analog): best-effort lastSeenAt bump
   * for an address on inbound. No-op when emails[] is absent or the address isn't
   * in emails[]. Never throws on a missing entry.
   */
  touchEmailLastSeen(contactId: string, email: string, at: string): Promise<void>;
  /**
   * Stamp `group_participation_at` - the DISTINCT consent basis for a native
   * group text member (group-texting spec section 4.4 / worklist naming table).
   *
   * `consent_method` is NEVER touched by any group path: being silently added to
   * a carrier group is participation, not consent to be messaged 1:1, and
   * stamping it would hand every silent member SMS consent through
   * hasSmsConsent.
   *
   * Conditional and therefore idempotent: it only ever writes the FIRST
   * participation instant, so a migration re-run cannot rewrite the basis date.
   * Returns which happened, so a caller can converge and report without a
   * second read: `stamped` (this call wrote it), `already` (a stamp was already
   * there), `missing` (no contact record - reported, never created here).
   */
  stampGroupParticipation(
    contactId: string,
    at: string,
  ): Promise<'stamped' | 'already' | 'missing'>;
}

export function createContactsRepo(deps: RepoDeps = {}): ContactsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('contacts', deps.env);
  const log = deps.logger ?? defaultLogger;

  // --- BE1/C1 internal helpers (closures; NOT part of the public interface) -
  const getByIdImpl = async (contactId: string, consistentRead = false): Promise<ContactItem | undefined> => {
    const { Item } = await doc.send(new GetCommand({
      TableName: table,
      Key: { contactId },
      ...(consistentRead && { ConsistentRead: true }),
    }));
    return Item as ContactItem | undefined;
  };

  /**
   * Shared BatchGetItem walk for the two by-primary-key batch reads. Chunks at
   * the 100-key BatchGetItem limit and retries `UnprocessedKeys` (DynamoDB
   * returns them on throttle or a 16MB response) with the same backoff the
   * messages repo uses.
   *
   * A key we FAILED TO READ is not the same fact as a contact that DOES NOT
   * EXIST, even though a short map represents both (adversarial review r1
   * finding 1). Which one a caller can tolerate is the caller's call:
   *
   * - DEFAULT (best-effort): keys still unprocessed after the retries, and any
   *   chunk whose request throws outright, are counted and DROPPED. The caller
   *   gets a short map. Right for display enrichment - a row renders without a
   *   name. Chunks that already succeeded are KEPT (r1 finding 2): one late
   *   throttle must not discard names we already paid for.
   * - `requireComplete`: an incomplete READ throws IncompleteBatchReadError.
   *   For callers where an absent key changes an outcome rather than a label -
   *   the broadcast send path, where it means a tenant never gets the message.
   *   A genuinely missing row is NOT incomplete and never throws.
   *
   * NOTE: base-table primary keys ONLY. BatchGetItem cannot read a GSI, so this
   * is no help to findByPhone/findByEmail (see
   * docs/issues/unread-badge-request-round-trip-cost.md).
   */
  const batchGetByIds = async <T extends { contactId: string }>(
    contactIds: string[],
    opts: {
      /** MUST project `contactId` - the returned map is keyed on it. */
      projection?: { ProjectionExpression: string; ExpressionAttributeNames: Record<string, string> };
      requireComplete?: boolean;
    } = {},
  ): Promise<Map<string, T>> => {
    const found = new Map<string, T>();
    // BatchGetItem REJECTS a request carrying duplicate keys, and several
    // callers legitimately present the same id twice (a roster row, a tenant
    // sent to N times). De-duping here is load-bearing, not tidiness.
    const uniqueIds = [...new Set(contactIds)];
    let unprocessed = 0;
    for (let i = 0; i < uniqueIds.length; i += 100) {
      let keys = uniqueIds.slice(i, i + 100).map((contactId) => ({ contactId }));
      try {
        for (let attempt = 0; attempt < 4 && keys.length > 0; attempt += 1) {
          if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** (attempt - 1)));
          }
          const response = await doc.send(
            new BatchGetCommand({ RequestItems: { [table]: { Keys: keys, ...opts.projection } } }),
          );
          for (const item of (response.Responses?.[table] ?? []) as T[]) {
            found.set(item.contactId, item);
          }
          keys = (response.UnprocessedKeys?.[table]?.Keys ?? []) as Array<{ contactId: string }>;
        }
      } catch (err) {
        // A thrown chunk is an unread chunk - same fact as unprocessed keys, so
        // it takes the same path. Rethrow only where short is not survivable.
        if (opts.requireComplete === true) throw err;
        log.warn({ err, chunkKeys: keys.length }, 'contacts: BatchGet chunk failed - keys dropped');
      }
      unprocessed += keys.length;
    }
    if (unprocessed > 0) {
      const detail = { unprocessed, requested: uniqueIds.length, projected: opts.projection !== undefined };
      if (opts.requireComplete === true) throw new IncompleteBatchReadError(unprocessed, uniqueIds.length);
      log.warn(detail, 'contacts: BatchGet left keys unprocessed after retries');
    }
    return found;
  };

  /** The display projection, shared by getDisplayById and getDisplaysByIds. */
  const DISPLAY_PROJECTION = {
    ProjectionExpression: '#contactId, #firstName, #lastName, #phone',
    ExpressionAttributeNames: {
      '#contactId': 'contactId',
      '#firstName': 'firstName',
      '#lastName': 'lastName',
      '#phone': 'phone',
    },
  } as const;

  /** Load a contact or throw the same conditional error update() throws. */
  const requireContact = async (contactId: string): Promise<ContactItem> => {
    const contact = await getByIdImpl(contactId);
    if (!contact) {
      throw new ConditionalCheckFailedException({
        message: `contact ${contactId} not found`,
        $metadata: {},
      });
    }
    return contact;
  };

  /** The phones[] in canonical form: seed (copy) from the scalar when absent. */
  const seededPhones = (contact: ContactItem): ContactPhone[] =>
    seedPhonesForWrite(contact, new Date().toISOString());

  /** Write a phone-pointer item for a non-primary number (idempotent). */
  const putPointer = async (phone: string, ownerContactId: string): Promise<void> => {
    try {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            contactId: phoneRefId(phone),
            phone,
            phone_ref: true,
            phone_ref_owner: ownerContactId,
          },
          ConditionExpression: 'attribute_not_exists(contactId)',
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return; // already present
      throw err;
    }
  };

  /** Delete a phone-pointer item (idempotent; no condition). */
  const deletePointer = async (phone: string): Promise<void> => {
    await doc.send(new DeleteCommand({ TableName: table, Key: { contactId: phoneRefId(phone) } }));
  };

  /** Persist phones[] (and an optional scalar swap) on the owner contact. */
  const persistPhones = async (
    contactId: string,
    phones: ContactPhone[],
    scalar?: string,
  ): Promise<ContactItem> => {
    const names: Record<string, string> = { '#phones': 'phones' };
    const values: Record<string, unknown> = { ':phones': phones };
    let expr = 'SET #phones = :phones';
    if (scalar !== undefined) {
      names['#phone'] = 'phone';
      values[':phone'] = scalar;
      expr += ', #phone = :phone';
    }
    const { Attributes } = await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { contactId },
        UpdateExpression: expr,
        ConditionExpression: 'attribute_exists(contactId)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return Attributes as ContactItem;
  };

  // --- Email-channel A1 internal helpers (the phone-helper analogs) ---------
  /** The emails[] in canonical form: seed (copy) from the scalar when absent. */
  const seededEmails = (contact: ContactItem): ContactEmail[] => {
    if (Array.isArray(contact.emails) && contact.emails.length > 0) {
      return contact.emails.map((e) => ({ ...e }));
    }
    if (typeof contact.email === 'string' && contact.email.length > 0) {
      return [
        {
          email: contact.email,
          primary: true,
          ...(typeof contact.created_at === 'string' && { firstSeenAt: contact.created_at }),
          lastSeenAt: new Date().toISOString(),
        },
      ];
    }
    return [];
  };

  /** Write an email-pointer item for a non-primary address (idempotent). */
  const putEmailPointer = async (email: string, ownerContactId: string): Promise<void> => {
    try {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            contactId: emailRefId(email),
            email,
            email_ref: true,
            email_ref_owner: ownerContactId,
          },
          ConditionExpression: 'attribute_not_exists(contactId)',
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return; // already present
      throw err;
    }
  };

  /** Delete an email-pointer item (idempotent; no condition). */
  const deleteEmailPointer = async (email: string): Promise<void> => {
    await doc.send(new DeleteCommand({ TableName: table, Key: { contactId: emailRefId(email) } }));
  };

  /** Persist emails[] (and an optional scalar swap) on the owner contact. */
  const persistEmails = async (
    contactId: string,
    emails: ContactEmail[],
    scalar?: string,
  ): Promise<ContactItem> => {
    const names: Record<string, string> = { '#emails': 'emails' };
    const values: Record<string, unknown> = { ':emails': emails };
    let expr = 'SET #emails = :emails';
    if (scalar !== undefined) {
      names['#email'] = 'email';
      values[':email'] = scalar;
      expr += ', #email = :email';
    }
    const { Attributes } = await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { contactId },
        UpdateExpression: expr,
        ConditionExpression: 'attribute_exists(contactId)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return Attributes as ContactItem;
  };

  return {
    async findByPhone(phone) {
      // Accepted risk: duplicate phones return the FIRST item the GSI yields
      // (arbitrary order). M1.2 auto-capture only prevents NEW duplicates
      // per phone (the conversation participants claim is the anchor);
      // pre-existing duplicates (e.g. imports) stay first-match until the
      // M1.6 import dedupe resolves them.
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byPhone',
          KeyConditionExpression: 'phone = :p',
          ExpressionAttributeValues: { ':p': phone },
        }),
      );
      const hit = (Items as ContactItem[] | undefined)?.[0];
      if (!hit) return undefined;
      // BE1: pointer-aware resolution. A non-primary number is indexed by a
      // phone-pointer item (phone_ref) whose phone_ref_owner is the real
      // contact — hop to it so EVERY existing caller transparently gains
      // multi-number resolution. A dangling pointer (owner deleted) → undefined.
      if (hit.phone_ref === true) {
        const owner =
          typeof hit.phone_ref_owner === 'string' ? hit.phone_ref_owner : undefined;
        if (owner === undefined) return undefined;
        return getByIdImpl(owner);
      }
      return hit;
    },

    async findByEmail(email) {
      // Email analog of findByPhone (A1). The byEmail GSI hashes the scalar
      // `email` - carried by BOTH a contact's primary (the owner) and every
      // non-primary email-pointer item - so ONE address resolves to exactly one
      // row. A pointer hit (email_ref) hops to its owner, giving every existing
      // caller multi-address resolution transparently. A dangling pointer
      // (owner deleted) -> undefined.
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byEmail',
          KeyConditionExpression: 'email = :e',
          ExpressionAttributeValues: { ':e': email },
        }),
      );
      const hit = (Items as ContactItem[] | undefined)?.[0];
      if (!hit) return undefined;
      if (hit.email_ref === true) {
        const owner =
          typeof hit.email_ref_owner === 'string' ? hit.email_ref_owner : undefined;
        if (owner === undefined) return undefined;
        return getByIdImpl(owner);
      }
      return hit;
    },

    async getById(contactId, opts) {
      return getByIdImpl(contactId, opts?.consistentRead);
    },

    async getDisplayById(contactId) {
      const response = await doc.send(
        new GetCommand({ TableName: table, Key: { contactId }, ...DISPLAY_PROJECTION }),
      );
      return response.Item as ContactDisplayItem | undefined;
    },

    async getDisplaysByIds(contactIds) {
      return batchGetByIds<ContactDisplayItem>(contactIds, { projection: DISPLAY_PROJECTION });
    },

    async getManyByIds(contactIds, opts) {
      return batchGetByIds<ContactItem>(contactIds, { requireComplete: opts?.requireComplete });
    },

    async listByType(type, opts = {}) {
      // ONE Query on byTypeStatus: hash = type, optional range = status. `type`
      // and `status` are DynamoDB reserved words → expression-aliased.
      const names: Record<string, string> = { '#t': 'type' };
      const values: Record<string, unknown> = { ':t': type };
      let keyExpr = '#t = :t';
      if (opts.status !== undefined) {
        names['#s'] = 'status';
        values[':s'] = opts.status;
        keyExpr += ' AND #s = :s';
      }
      // Soft-delete scope (FilterExpression — byTypeStatus projects ALL attrs, so
      // deleted_at is filterable). Default HIDES deleted; deleted:true shows ONLY
      // deleted (the Contacts "Deleted" view).
      names['#del'] = 'deleted_at';
      const deletedFilter =
        opts.deleted === true ? 'attribute_exists(#del)' : 'attribute_not_exists(#del)';
      const filters = [deletedFilter];
      if (opts.excludeOrigin !== undefined) {
        names['#origin'] = 'origin';
        values[':excludedOrigin'] = opts.excludeOrigin;
        filters.push('(attribute_not_exists(#origin) OR #origin <> :excludedOrigin)');
      }
      const input: QueryCommandInput = {
        TableName: table,
        IndexName: 'byTypeStatus',
        KeyConditionExpression: keyExpr,
        FilterExpression: filters.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ...(opts.limit !== undefined && { Limit: opts.limit }),
        ...(opts.exclusiveStartKey !== undefined && {
          ExclusiveStartKey: opts.exclusiveStartKey as QueryCommandInput['ExclusiveStartKey'],
        }),
      };
      const { Items, LastEvaluatedKey } = await doc.send(new QueryCommand(input));
      return {
        items: (Items ?? []) as ContactItem[],
        ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
      };
    },

    async listByHousingAuthority(housingAuthority, opts = {}) {
      // ONE Query on byHousingAuthority (hash = housingAuthority). Sparse +
      // tenant-only by data convention — only tenant contacts carry the
      // attribute. Pagination via the raw LastEvaluatedKey (route opaque-cursors
      // it). `status`/`type` are not key attrs here, so no expression aliasing.
      const input: QueryCommandInput = {
        TableName: table,
        IndexName: 'byHousingAuthority',
        KeyConditionExpression: 'housingAuthority = :ha',
        // Broadcast targeting must never reach a soft-deleted contact — always
        // exclude them here (no "deleted" view on this index).
        FilterExpression: 'attribute_not_exists(#del)',
        ExpressionAttributeNames: { '#del': 'deleted_at' },
        ExpressionAttributeValues: { ':ha': housingAuthority },
        ...(opts.limit !== undefined && { Limit: opts.limit }),
        ...(opts.exclusiveStartKey !== undefined && {
          ExclusiveStartKey: opts.exclusiveStartKey as QueryCommandInput['ExclusiveStartKey'],
        }),
      };
      const { Items, LastEvaluatedKey } = await doc.send(new QueryCommand(input));
      return {
        items: (Items ?? []) as ContactItem[],
        ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
      };
    },

    async create(input) {
      const now = new Date().toISOString();
      const item: ContactItem = {
        ...input,
        contactId: input.contactId ?? `contact-${randomUUID()}`,
        type: input.type,
        created_at: input.created_at ?? now,
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(contactId)',
        }),
      );
      log.info({ contactId: item.contactId, type: item.type }, 'contact created (manual)');
      return item;
    },

    async createIfAbsent(item) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: item,
            ConditionExpression: 'attribute_not_exists(contactId)',
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // Already exists — by contract we never overwrite a single field.
          return false;
        }
        throw err;
      }
      log.info({ contactId: item.contactId, type: item.type }, 'contact created');
      return true;
    },

    async setFlag(contactId, flag) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { contactId },
          UpdateExpression: 'SET #flag = :true',
          ConditionExpression: 'attribute_exists(contactId)',
          ExpressionAttributeNames: { '#flag': flag },
          ExpressionAttributeValues: { ':true': true },
        }),
      );
      log.info({ contactId, flag }, 'contact flag set');
    },

    async clearFlag(contactId, flag) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { contactId },
          UpdateExpression: 'SET #flag = :false',
          ConditionExpression: 'attribute_exists(contactId)',
          ExpressionAttributeNames: { '#flag': flag },
          ExpressionAttributeValues: { ':false': false },
        }),
      );
      log.info({ contactId, flag }, 'contact flag cleared');
    },

    async softDelete(contactId, at) {
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { contactId },
          UpdateExpression: 'SET #del = :at',
          ConditionExpression: 'attribute_exists(contactId)',
          ExpressionAttributeNames: { '#del': 'deleted_at' },
          ExpressionAttributeValues: { ':at': at },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ contactId }, 'contact soft-deleted');
      return Attributes as ContactItem;
    },

    async restore(contactId) {
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { contactId },
          UpdateExpression: 'REMOVE #del',
          ConditionExpression: 'attribute_exists(contactId)',
          ExpressionAttributeNames: { '#del': 'deleted_at' },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ contactId }, 'contact restored');
      return Attributes as ContactItem;
    },

    async update(contactId, patch) {
      // SET non-null fields; REMOVE explicit-null fields (the null → REMOVE
      // convention lets callers clear an attribute, e.g. role: null removes the
      // role attribute entirely rather than storing ''). Names are
      // expression-aliased so reserved words (`status`, `type`) are legal.
      const sets: string[] = [];
      const removes: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      let i = 0;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        // Fail at the seam, before the round trip: '' on an index key attribute
        // is a caller bug (they meant null → REMOVE), and DynamoDB's own error
        // for it names neither the field nor the caller. Throwing here aborts
        // before the single UpdateCommand is built, so one bad field refuses
        // the patch outright rather than half-applying the good ones.
        if (value === '' && INDEX_KEY_ATTRIBUTES.has(key)) {
          throw new EmptyIndexKeyError(key);
        }
        // The OTHER half of the same hazard, in the same place and for the same
        // reason. null is the documented REMOVE path, and on a byTypeStatus key
        // a REMOVE un-indexes the row: it still reads back by id and is gone
        // from every listByType (the Unknown tab included), silently. The
        // sparse lookup keys (phone/email/housingAuthority) stay clearable this
        // way on purpose - REQUIRED_INDEX_KEY_ATTRIBUTES is the narrow set.
        if (value === null && REQUIRED_INDEX_KEY_ATTRIBUTES.has(key)) {
          throw new RequiredIndexKeyRemovalError(key, contactId);
        }
        const nameKey = `#k${i}`;
        names[nameKey] = key;
        if (value === null) {
          removes.push(nameKey);
        } else {
          const valueKey = `:v${i}`;
          values[valueKey] = value;
          sets.push(`${nameKey} = ${valueKey}`);
        }
        i += 1;
      }
      if (sets.length === 0 && removes.length === 0) {
        // Nothing to change — read the current item back (still 404s if gone).
        const existing = await this.getById(contactId);
        if (!existing) {
          throw new ConditionalCheckFailedException({
            message: `contact ${contactId} not found`,
            $metadata: {},
          });
        }
        return existing;
      }
      const clauses: string[] = [];
      if (sets.length > 0) clauses.push(`SET ${sets.join(', ')}`);
      if (removes.length > 0) clauses.push(`REMOVE ${removes.join(', ')}`);
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { contactId },
          UpdateExpression: clauses.join(' '),
          ConditionExpression: 'attribute_exists(contactId)',
          ExpressionAttributeNames: names,
          // Omit ExpressionAttributeValues entirely when empty (REMOVE-only
          // update) — DynamoDB rejects an empty values map.
          ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ contactId, setFields: sets.length, removedFields: removes.length }, 'contact updated');
      return Attributes as ContactItem;
    },

    // --- BE1/C1 multi-phone primitives -----------------------------------
    // All phone-invariant maintenance is centralized here (helpers above):
    // exactly-one-primary, scalar `phone` == the primary, and phone-pointer
    // items for non-primary numbers (so the byPhone GSI resolves them). Pointer
    // reconciliation spans multiple item writes and is NOT a single transaction
    // — acceptable for low-frequency manual curation, and it self-heals on
    // retry (re-running addPhone/setPhone re-asserts the same pointers
    // idempotently; phones[]/scalar is the source of truth).

    async addPhone(contactId, { phone, label }) {
      const contact = await requireContact(contactId);
      const phones = seededPhones(contact);
      if (phones.some((p) => p.phone === phone)) {
        // Idempotent: number already attached. Persist the seed only if we just
        // materialized phones[] from the scalar (so reads are consistent).
        if (!Array.isArray(contact.phones)) return persistPhones(contactId, phones);
        return contact;
      }
      const now = new Date().toISOString();
      // A contact with NO phones has no primary to defer to, so the first
      // number becomes the primary: it is mirrored to the `phone` scalar (the
      // byPhone-indexed attribute) and gets NO pointer, exactly as the contract
      // above describes. Appending it as non-primary left phones[] with zero
      // primaries and the scalar unset - a state every reader has been quietly
      // compensating for with `find(p => p.primary) ?? phones[0]`.
      const isFirst = phones.length === 0;
      const entry: ContactPhone = {
        phone,
        primary: isFirst,
        firstSeenAt: now,
        lastSeenAt: now,
        ...(label !== undefined && { label }),
      };
      const next = [...phones, entry];
      const updated = await persistPhones(contactId, next, isFirst ? phone : undefined);
      // Only a NON-primary number needs a pointer; the primary is resolvable
      // through the scalar's byPhone GSI entry.
      if (!isFirst) await putPointer(phone, contactId);
      log.info({ contactId, phoneCount: next.length, primary: isFirst }, 'contact phone added');
      return updated;
    },

    async setPhone(contactId, phone, { primary, label }) {
      const contact = await requireContact(contactId);
      const phones = seededPhones(contact);
      const target = phones.find((p) => p.phone === phone);
      if (!target) {
        throw new ConditionalCheckFailedException({
          message: `contact ${contactId} has no phone ${phone}`,
          $metadata: {},
        });
      }
      if (label !== undefined) target.label = label;

      // NOTE: `primary: false` is intentionally IGNORED — the primary is changed
      // only by promoting ANOTHER number (primary: true on it), never by demoting
      // the current one in isolation. This guarantees we never create a
      // zero-primary state (a contact always has exactly one primary).
      let scalarSwap: string | undefined;
      const oldPrimary = phones.find((p) => p.primary && p.phone !== phone);
      if (primary === true && !target.primary) {
        for (const p of phones) p.primary = p.phone === phone;
        scalarSwap = phone;
      }

      // Crash-safe promote ordering (BE1): EVERY number must resolve to the owner
      // at EVERY step. Order:
      //   1. putPointer(oldPrimary) FIRST — while scalar still = old, so old now
      //      resolves via BOTH the scalar AND the new pointer (both → owner).
      //   2. persistPhones with the scalar swap → new (new now resolves via the
      //      scalar; old still resolves via its pointer from step 1).
      //   3. deletePointer(new) — the new primary no longer needs a pointer
      //      (it resolves via the scalar).
      // The earlier order (persist → deletePointer(new) → putPointer(old)) left a
      // window where the OLD primary resolved to NOBODY (scalar already moved off
      // it, its pointer not yet written). pointers self-heal on a retried
      // setPhone regardless (phones[]/scalar is the source of truth).
      if (scalarSwap !== undefined && oldPrimary) {
        await putPointer(oldPrimary.phone, contactId);
      }
      const updated = await persistPhones(contactId, phones, scalarSwap);
      if (scalarSwap !== undefined) {
        await deletePointer(phone);
        log.info({ contactId, newPrimary: phone }, 'contact primary phone changed');
      }
      return updated;
    },

    async removePhone(contactId, phone) {
      const contact = await requireContact(contactId);
      const phones = seededPhones(contact);
      const target = phones.find((p) => p.phone === phone);
      if (!target) {
        throw new ConditionalCheckFailedException({
          message: `contact ${contactId} has no phone ${phone}`,
          $metadata: {},
        });
      }
      if (target.primary) {
        // Never leave a contact with zero primary — the route maps this to 409.
        throw new PrimaryPhoneRemovalError();
      }
      const next = phones.filter((p) => p.phone !== phone);
      const updated = await persistPhones(contactId, next);
      await deletePointer(phone);
      log.info({ contactId, phoneCount: next.length }, 'contact phone removed');
      return updated;
    },

    async touchPhoneLastSeen(contactId, phone, at) {
      const contact = await getByIdImpl(contactId);
      // No-op when there's no contact, no phones[] (legacy/stub — do NOT
      // churn-seed on every inbound), or no matching entry. Never throws.
      if (!contact || !Array.isArray(contact.phones) || contact.phones.length === 0) return;
      const phones = contact.phones.map((p) => ({ ...p }));
      const target = phones.find((p) => p.phone === phone);
      if (!target) return;
      target.lastSeenAt = at;
      try {
        await persistPhones(contactId, phones);
      } catch {
        // Best-effort: a lost race must never throw on inbound.
      }
    },

    // --- Email-channel A1 email primitives (the multi-phone analogs) -------
    // Same invariant maintenance as phones: exactly-one-primary, scalar `email`
    // == the primary, and email-pointer items for non-primary addresses (so the
    // byEmail GSI resolves them). Multi-write, non-transactional, and self-heals
    // on retry - acceptable for low-frequency manual curation. Addresses are PII
    // (doc PII posture): logs carry contactId + counts, never the address.

    async addEmail(contactId, { email, label }) {
      const contact = await requireContact(contactId);
      const emails = seededEmails(contact);
      if (emails.some((e) => e.email === email)) {
        // Idempotent: address already attached. Persist the seed only if we just
        // materialized emails[] from the scalar (so reads are consistent).
        if (!Array.isArray(contact.emails)) return persistEmails(contactId, emails);
        return contact;
      }
      const now = new Date().toISOString();
      const isFirst = emails.length === 0;
      const entry: ContactEmail = {
        email,
        primary: isFirst,
        firstSeenAt: now,
        lastSeenAt: now,
        ...(label !== undefined && { label }),
      };
      const next = [...emails, entry];
      const updated = await persistEmails(contactId, next, isFirst ? email : undefined);
      // A primary resolves through the scalar; only a secondary needs a pointer.
      if (!isFirst) await putEmailPointer(email, contactId);
      log.info({ contactId, emailCount: next.length, primary: isFirst }, 'contact email added');
      return updated;
    },

    async setPrimaryEmail(contactId, email, { primary, label }) {
      const contact = await requireContact(contactId);
      const emails = seededEmails(contact);
      const target = emails.find((e) => e.email === email);
      if (!target) {
        throw new ConditionalCheckFailedException({
          message: `contact ${contactId} has no email ${email}`,
          $metadata: {},
        });
      }
      if (label !== undefined) target.label = label;

      // `primary: false` is intentionally IGNORED - the primary changes only by
      // promoting ANOTHER address (primary: true on it), never by demoting the
      // current one in isolation (this guarantees a contact always has exactly
      // one primary, never a zero-primary state).
      let scalarSwap: string | undefined;
      const oldPrimary = emails.find((e) => e.primary && e.email !== email);
      if (primary === true && !target.primary) {
        for (const e of emails) e.primary = e.email === email;
        scalarSwap = email;
      }

      // Crash-safe promote ordering (mirror setPhone): putEmailPointer(oldPrimary)
      // FIRST (old still resolves via BOTH the scalar AND the new pointer), THEN
      // persist the scalar swap, THEN deleteEmailPointer(new). Every address
      // resolves to the owner at every step; pointers self-heal on a retried call.
      if (scalarSwap !== undefined && oldPrimary) {
        await putEmailPointer(oldPrimary.email, contactId);
      }
      const updated = await persistEmails(contactId, emails, scalarSwap);
      if (scalarSwap !== undefined) {
        await deleteEmailPointer(email);
        log.info({ contactId }, 'contact primary email changed');
      }
      return updated;
    },

    async removeEmail(contactId, email) {
      const contact = await requireContact(contactId);
      const emails = seededEmails(contact);
      const target = emails.find((e) => e.email === email);
      if (!target) {
        throw new ConditionalCheckFailedException({
          message: `contact ${contactId} has no email ${email}`,
          $metadata: {},
        });
      }
      if (target.primary) {
        // Never leave a contact with zero primary - the route maps this to 409.
        throw new PrimaryEmailRemovalError();
      }
      const next = emails.filter((e) => e.email !== email);
      const updated = await persistEmails(contactId, next);
      await deleteEmailPointer(email);
      log.info({ contactId, emailCount: next.length }, 'contact email removed');
      return updated;
    },

    async touchEmailLastSeen(contactId, email, at) {
      const contact = await getByIdImpl(contactId);
      // No-op when there's no contact, no emails[] (do NOT churn-seed a
      // scalar-only contact on every inbound), or no matching entry. Never throws.
      if (!contact || !Array.isArray(contact.emails) || contact.emails.length === 0) return;
      const emails = contact.emails.map((e) => ({ ...e }));
      const target = emails.find((e) => e.email === email);
      if (!target) return;
      target.lastSeenAt = at;
      try {
        await persistEmails(contactId, emails);
      } catch {
        // Best-effort: a lost race must never throw on inbound.
      }
    },

    async stampGroupParticipation(contactId, at) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { contactId },
            UpdateExpression: 'SET group_participation_at = :at',
            ConditionExpression:
              'attribute_exists(contactId) AND attribute_not_exists(group_participation_at)',
            ExpressionAttributeValues: { ':at': at },
          }),
        );
        return 'stamped';
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Two very different outcomes share one exception; only a read tells
        // them apart, and the caller reports them differently (an absent
        // contact is a hole in the roster, an existing stamp is convergence).
        const existing = await getByIdImpl(contactId);
        return existing ? 'already' : 'missing';
      }
    },
  };
}
