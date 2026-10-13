// units repo (M1.5) — the landlord units the share-broadcast (M1.6) fans out
// and the flyer endpoint exposes a safe subset of (doc §5).
//
// Items stay FLEXIBLE documents — only keys + GSI key attributes are
// contractual (lib/tables.ts): PK unitId, plus the byLandlord (landlordId),
// byStatus (status) and byProperty (propertyId) GSIs. Everything else
// (rents, beds, the never-standardized per-unit tour/application processes)
// is a free-form attribute, so schema churn during the build needs no
// migration — exactly the §5 posture.
//
// NO GEOCODING (kickoff "no geocoding — out of scope"): `address` is a
// STRUCTURED postal address (lib/address.ts Address: line1/line2/city/state/zip,
// all optional) and `accepted_authorities` is a plain operator-set list of
// strings; section 5's "geocoded address" is intentionally NOT implemented here
// (README deviation row). The Address type is reused for tenant/contact
// addresses later.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  ScanCommand,
  type ScanCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Address } from '../lib/address.js';
import type { TourType } from '../lib/toursModel.js';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import {
  LISTING_STATUSES,
  SHAREABLE,
  type ListingStatus,
  type TransitionSource,
} from '../lib/statusModel.js';
import { UNIT_MEDIA_MAX } from '../lib/unitMedia.js';
import type { RosterContactsRead } from '../lib/propertyContact.js';
import { isDeleted as isContactDeleted } from './contactsRepo.js';
import type { RepoDeps } from './conversationsRepo.js';

/**
 * Property (unit) lifecycle status (byStatus GSI hash; also gates the public
 * flyer). The full enum lives in lib/statusModel.ts (LISTING_STATUSES, §6); the
 * route allowlists these so the GSI partition key never takes an arbitrary
 * value. `available` is the only publicly shareable status (SHAREABLE_STATUSES).
 * Most non-`setup`/`available` values are DERIVED from the committed placement.
 */
export type UnitStatus = ListingStatus;

export const UNIT_STATUSES: readonly UnitStatus[] = LISTING_STATUSES;

/** Statuses whose unit may be exposed by the public flyer endpoint (§6: only `available`). */
export const SHAREABLE_STATUSES: ReadonlySet<string> = SHAREABLE;

/**
 * One contact on a unit's roster (BE3/C3 — contract verbatim; the frontend
 * imports the same shape). A unit has a many-to-many roster of the people who
 * own/manage it: the landlord, a property manager, the owner, or anyone else
 * relevant. At most one entry across the roster is `primaryContact: true` (the
 * primary - the property's default contact: the roster resolvers behind relay
 * groups and tour copy take the row marked primary, else the landlord of
 * record, and a masked call dials the live thread's participants without
 * reading the unit; see unitsRepo.addContact, which keeps the
 * `primary_contact` scalar consistent with it - nothing routes on the
 * scalar). `name`/`company` are DENORMALIZED at write time (the route resolves
 * them from the contact) so the roster row is self-describing without a join.
 */
export interface UnitContact {
  contactId: string;
  role: 'landlord' | 'pm' | 'owner' | 'other';
  /** The ☎ primary — at most one true across the roster. */
  primaryContact: boolean;
  name?: string;
  company?: string;
}

/** The valid roster roles (C3 `UnitContact.role`). */
export const UNIT_CONTACT_ROLES: readonly UnitContact['role'][] = [
  'landlord',
  'pm',
  'owner',
  'other',
] as const;

/**
 * A related unit (BE3/C3 — contract verbatim): a sibling in the same property
 * (building/duplex group) or another unit owned by the same landlord. Fields
 * reuse the legacy unit shape (address/status) so the dashboard can render a
 * related-property card without a second fetch.
 */
export interface RelatedUnit {
  unitId: string;
  address?: Address | string;
  status: UnitStatus;
  relation: 'same_property' | 'same_landlord';
  label?: string;
}

/**
 * Thrown by removeContact when the target contactId === the unit's legacy
 * `landlordId` (the LANDLORD OF RECORD: who owns the unit). The landlord of
 * record must remain in the roster — the operator reassigns `landlordId` first
 * (a unit PATCH). The route maps this to a 409 `cannot_remove_landlord_of_record`.
 */
export class CannotRemoveLandlordOfRecordError extends Error {
  constructor(message = "cannot remove the unit's landlord of record; reassign landlordId first") {
    super(message);
    this.name = 'CannotRemoveLandlordOfRecordError';
  }
}

/**
 * Thrown by addContact when a different landlord of record already owns the
 * unit. A roster role must never silently transfer ownership; reassignment is a
 * separate, explicit operation.
 */
export class LandlordReassignmentRequiredError extends Error {
  constructor(message = "property already has a landlord of record; reassign landlordId first") {
    super(message);
    this.name = 'LandlordReassignmentRequiredError';
  }
}

/**
 * Thrown by addContact when a CASEWORKER would take a NEW contact-list seat:
 * the attempt's own read of the unit has no row for the contact
 * (caseworker-integrity I4, spec 2026-10-12 section 4 "Contact list"). The
 * route maps it to 409 contact_list_caseworker.
 */
export class ContactListCaseworkerError extends Error {
  constructor(message = 'a caseworker cannot take a new seat on a property contact list') {
    super(message);
    this.name = 'ContactListCaseworkerError';
  }
}

/**
 * Thrown by addContact when a role-landlord add would CLAIM the vacant
 * landlord-of-record slot (no landlordId attribute on the attempt's own read)
 * for a contact that is not typed landlord (caseworker-integrity I3, spec
 * 2026-10-12 section 4 "Landlord of record"). The route maps it to 409
 * landlord_not_landlord.
 */
export class LandlordClaimNotLandlordError extends Error {
  constructor(message = 'only a contact typed landlord can claim a property landlord of record') {
    super(message);
    this.name = 'LandlordClaimNotLandlordError';
  }
}

/**
 * What the caller read about the contact being added to a property's contact
 * list (caseworker-integrity spec 2026-10-12 section 4; fix wave 2 FW2-1) -
 * facts about the CONTACT, which the unit cannot tell addContact. The
 * contact-list route reads the contact consistently and states both;
 * addContact applies them on EACH attempt's own read of the unit, so the unit
 * side of every rule is decided on the roster and landlordId the conditional
 * write is fenced on. Only the contact's type is a read before the write
 * (spec L1).
 */
export interface ContactListFacts {
  /** isCaseworker(contact) (lib/caseworkers.ts): a caseworker never takes a NEW seat (I4). */
  caseworker: boolean;
  /**
   * contact.type === 'landlord' (a property manager or an owner is a landlord
   * with a role): required to claim the vacant landlord slot (I3).
   */
  landlordTyped: boolean;
  /**
   * The contact is eligible for an AUTOMATIC routing choice - the one rule
   * (lib/propertyContact.ts `isAutoRoutingEligible`, shared with the heir
   * function): typed landlord, not soft-deleted, not a phone or email routing
   * pointer. Only such a contact is made primary by auto-primary
   * (caseworker-integrity spec revision 6, final review A4, fix wave FWF-3;
   * revision 5 / FW2-11 keyed it on the type alone).
   */
  autoPrimaryEligible: boolean;
  /**
   * The contact is soft-deleted (contactsRepo `isDeleted`) -
   * primary-contact-integrity spec 4.4: such a contact is never made the
   * primary unless its row already is (PrimaryContactDeletedError). Optional:
   * absent means not deleted.
   */
  contactDeleted?: boolean;
}

/**
 * restoreWithLandlord's input (caseworker-integrity spec 2026-10-12 section 4
 * "Restore"). `expectLandlordId` is the landlordId the caller read (undefined:
 * ownerless); `next` is the new landlord of record, or null for a restore
 * WITHOUT a landlord - which also carries the caller's sole-landlord promotion
 * (spec revision 5; fix wave 2 FW2-12) and the contact list it was decided
 * from.
 */
export type RestoreWithLandlordInput =
  | {
      expectLandlordId: string | undefined;
      next: { contactId: string; name?: string; company?: string };
    }
  | {
      expectLandlordId: string | undefined;
      next: null;
      /**
       * The stored `contacts` attribute the caller read and decided `promote`
       * from (undefined: no list stored). The restore applies only to exactly
       * this list; any other answers RosterWriteConflictError.
       */
      expectContacts: UnitContact[] | undefined;
      /**
       * The caller's decision: the one remaining row whose contact is typed
       * landlord, made the sole primary when the cleared landlord was the
       * primary; null when zero or two-plus such rows remain (nobody).
       */
      promote: string | null;
    };

/** An optimistic roster mutation lost too many consecutive write races. */
export class RosterWriteConflictError extends Error {
  constructor(message = 'property contacts changed repeatedly; retry the roster change') {
    super(message);
    this.name = 'RosterWriteConflictError';
  }
}

const ROSTER_WRITE_MAX_ATTEMPTS = 3;

/**
 * primary-contact-integrity (spec 2026-10-12 sections 4.2 and 4.6): a roster
 * write that must hand the primary contact to an heir could not tell who is
 * live - the contacts liveness read threw or came back incomplete (either
 * shape: a raw chunk error or IncompleteBatchReadError, both of which
 * readRosterContacts answers as `{ ok: false }`), or the caller supplied no
 * read. Nothing was written. The routes map it to 503 roster_read_failed.
 */
export class RosterReadFailedError extends Error {
  constructor(message = 'could not read the property contacts to choose who takes over; nothing was changed') {
    super(message);
    this.name = 'RosterReadFailedError';
  }
}

/**
 * primary-contact-integrity (spec 2026-10-12 section 4.4): a contact-list
 * write would make a SOFT-DELETED contact the primary contact while its row
 * is not already the primary. Decided per attempt from the caller's
 * `ContactListFacts.contactDeleted`. Nothing was written. The route maps it
 * to 409 primary_contact_deleted.
 */
export class PrimaryContactDeletedError extends Error {
  constructor(message = 'a soft-deleted contact cannot be made the primary contact') {
    super(message);
    this.name = 'PrimaryContactDeletedError';
  }
}

/**
 * The liveness read for automatic primary decisions (spec 4.2): the caller
 * binds lib/propertyContact.ts readRosterContacts to its contacts repo. ONE
 * batch read with requireComplete; any failure answers `{ ok: false }`.
 */
export type ReadRosterContacts = (ids: string[]) => Promise<RosterContactsRead>;

/** A primary hand-off a roster write made, reported by that write itself so
 *  the caller can audit it (spec section 8) without a second read. */
export interface PrimaryHandoff {
  /** The contact whose primary flag went away (removed, or the old landlord). */
  from: string;
  /** The heir the write flagged primary. */
  to: string;
}

/** Options of the roster writes that can hand the primary contact off (spec 4.6). */
export interface RosterHandoffOpts {
  /**
   * The liveness read, called on EACH attempt after that attempt's consistent
   * unit read and before its conditional write (a retry reads again). Absent
   * = liveness unknown: a hand-off that needs it throws RosterReadFailedError.
   */
  readContacts?: ReadRosterContacts;
  /** Called once, after the successful write, when that write flagged an heir. */
  onPrimaryHandoff?: (handoff: PrimaryHandoff) => void;
}

/** handOffPrimaryFrom's answer (spec 4.6, contact delete). */
export type PrimaryHandOffResult =
  | { outcome: 'moved'; unit: UnitItem; to: string }
  | { outcome: 'unchanged' | 'not_primary' | 'unknown' };

/** The inputs of the P2 decision (spec 4.4), all from ONE attempt's read. */
export interface AutoPrimaryArgs {
  /** unitContacts(unit) of this attempt's read (a derived landlord row included). */
  roster: readonly UnitContact[];
  /** This attempt's non-empty landlordId, else undefined. */
  landlordId: string | undefined;
  /** X - the contact this roster write is for. */
  contactId: string;
  /** ContactListFacts.autoPrimaryEligible (the route's consistent read of X). */
  eligible: boolean;
  /** The request's own primaryContact flag. */
  requested: boolean;
}

/**
 * P2 step 1, PURE (primary-contact-integrity spec 4.4; shared by
 * unitsRepo.addContact and the API-test fake): the ids whose liveness decides
 * whether X is made the primary automatically - the flagged primary row's
 * contact and the landlord of record, each once - or null when no read can
 * change the answer: X is not eligible, the request already asks for primary,
 * X is itself the flagged primary (eligible means live, so a live primary
 * exists - an explicit `false` on X's own primary row still demotes it), or X
 * is the landlord of record (a live landlord of record). An empty list means
 * nothing is flagged and there is no landlord of record: no read is needed.
 */
export function autoPrimaryLivenessIds(args: AutoPrimaryArgs): string[] | null {
  if (!args.eligible || args.requested) return null;
  if (args.landlordId !== undefined && args.landlordId === args.contactId) return null;
  const flagged = args.roster.find((row) => row.primaryContact === true);
  if (flagged !== undefined && flagged.contactId === args.contactId) return null;
  const ids: string[] = [];
  if (flagged !== undefined) ids.push(flagged.contactId);
  if (args.landlordId !== undefined && !ids.includes(args.landlordId)) ids.push(args.landlordId);
  return ids;
}

/**
 * P2 step 2, PURE: 'promote' = X becomes the primary (on this attempt's read
 * there is no LIVE flagged primary and no LIVE landlord of record - a
 * soft-deleted or missing contact counts as absent); 'keep' = the request's
 * own flag stands; 'unknown' = the decision needed a liveness read that failed
 * or was not supplied - the write proceeds without a promotion (the route
 * WARNs). A write for X never promotes any other contact.
 */
export function decideAutoPrimary(
  args: AutoPrimaryArgs & { read: RosterContactsRead | undefined },
): 'promote' | 'keep' | 'unknown' {
  const ids = autoPrimaryLivenessIds(args);
  if (ids === null) return 'keep';
  if (ids.length === 0) return 'promote';
  const read = args.read;
  if (read === undefined || !read.ok) return 'unknown';
  const byId = read.byId;
  const anyLive = ids.some((id) => {
    const contact = byId.get(id);
    return contact !== undefined && !isContactDeleted(contact);
  });
  return anyLive ? 'keep' : 'promote';
}

/**
 * The contractual + commonly read attributes; items stay flexible documents
 * (only unitId + the three GSI keys are contractual). All property facts are
 * optional — a unit can be created as a stub and filled in over time, exactly
 * like a contact.
 */
export interface UnitItem {
  unitId: string;
  /** byLandlord GSI: the owning landlord's contactId (a contacts row). */
  landlordId: string;
  /** byStatus GSI: lifecycle status (UNIT_STATUSES). */
  status: string;
  /**
   * LEGACY - read-only. The pre-consolidation single jurisdiction string (free
   * text, no geocoding). No longer writable: `accepted_authorities` below
   * replaced it, and reads go through `authoritiesOf` (lib/unitFields.ts), which
   * synthesizes this value into a one-item list. See spec section 8:
   * docs/superpowers/specs/2026-08-06-tenant-list-visibility-design.md.
   */
  jurisdiction?: string;
  /**
   * The authorities whose vouchers this unit accepts - ONE list replacing BOTH
   * `jurisdiction` and `accepted_programs` (spec section 8). At least one entry
   * on a new write, chosen by the landlord. Read via `authoritiesOf` so legacy
   * units synthesize instead of needing a backfill.
   */
  accepted_authorities?: string[];
  /**
   * Structured postal address (lib/address.ts) — NO geocoding (out of scope,
   * kickoff). All sub-fields optional. Legacy dev units may still hold a plain
   * string here; reads tolerate both (see units route / frontend display).
   */
  address?: Address;
  /**
   * LEGACY - read-only. The dissolved "program" concept (HCV / Section 8 / VASH
   * are program-type labels, NOT authorities), superseded by
   * `accepted_authorities` (spec section 8). No longer writable and no longer
   * rendered; stored values stay on the document untouched.
   */
  accepted_programs?: string[];
  beds?: number;
  baths?: number;
  /** Sub-market / neighborhood label (free text). */
  area?: string;
  subzone?: string;
  rent_min?: number;
  rent_max?: number;
  payment_standard?: number;
  deposit?: number;
  /** Landlord incentive fee (LIF). */
  lif?: number;
  /**
   * Status-model (§4): the accepted rent, written onto the property when
   * `Awaiting rent acceptance` clears (the landlord accepts the determined
   * rent) — used for billing. Finite, non-negative. Set by the transition
   * service on the rent-acceptance move.
   */
  final_rent?: number;
  /** Status-model (§8): the source of the current `status` write (provenance/precedence). */
  status_source?: TransitionSource;
  /**
   * TENANT-PAID utilities — free-form (string), e.g. "Electric and gas". The
   * semantics are "which utilities the tenant must pay" (human label
   * "Tenant-paid utilities"); the storage key stays `utilities`.
   */
  utilities?: string;
  /** Accessibility notes — free-form. */
  accessibility?: string;
  /**
   * Internal staff notes — free-form, the contact-`notes` counterpart (e.g.
   * "In-unit washer/dryer", "No dishwasher"). NEVER on the flyer projections
   * (unitFields.ts allowlists exclude it by construction).
   */
  notes?: string;
  /**
   * Lease terms — free-form per-unit fact ("12-month minimum, month-to-month
   * after"). Moved off the landlord contact 2026-07-10 (GLOSSARY). Internal
   * only — never on the flyer projections.
   */
  lease_terms?: string;
  /** Pets policy — free-form (string or boolean). */
  pets?: string | boolean;
  /** Property priority — free-form. */
  priority?: string;
  /** Photo/media references — S3 keys or URLs. */
  media?: string[];
  /** Public flyer link. */
  listing_link?: string;
  /** Public flyer details (public-pages §3): a tour video link. Shareable. */
  video_url?: string;
  /** Public flyer details (public-pages §3): the application fee in dollars (>= 0). Shareable. */
  application_fee?: number;
  /** Public flyer details (public-pages §3): same-day RTA available. Shareable. */
  same_day_rta?: boolean;
  /**
   * Landlord-onboarding: the voucher size (bedroom size) this unit ACCEPTS —
   * a stored, writable number (>= 0), DISTINCT from `beds` (a 3bd unit may
   * accept a 2BR voucher). Read it through `acceptedVoucherSizes`
   * (lib/unitFields.ts), which falls back to `beds`. The key is never on the
   * public flyer; its value drives the flyer's derived `voucher_size`.
   */
  voucher_size_accepted?: number;
  /** The never-standardized per-unit tour process (free text). INTERNAL. */
  tour_process?: string;
  /**
   * Structured, optional per-unit tour type (self_guided / landlord_led /
   * pm_team) - the prefill source for the Schedule-a-tour modal. INTERNAL:
   * NEVER exposed on the public flyer projection. Absent = unset (the modal's
   * fallback chain covers it).
   */
  tour_type?: TourType;
  /** The never-standardized per-unit application process (free text). INTERNAL. */
  application_process?: string;
  /**
   * The unit's primary contact (CO1), kept consistent with the contact-list
   * row marked primary (see unitsRepo.addContact). Nothing routes on this
   * scalar today: the roster resolvers (lib/rosterResolution.ts,
   * lib/tourContacts.ts, services/rosterProvision.ts) take the row marked
   * primary, else the landlordId, and a masked call dials the live thread's
   * participants without reading the unit (routes/webhooks/voice.ts). Stored
   * as a contactId. PENDING FOUNDER CONFIRMATION - may move to per-placement (CO1
   * notes routing comes "from the per-unit process" today; a later change
   * order may relocate this onto the placement). INTERNAL — never exposed
   * by the public flyer.
   */
  primary_contact?: string;
  /**
   * BE3/C3: the roster of contacts who own/manage this unit (landlord, PM,
   * owner, …). When ABSENT, reads serve the back-compat roster derived from the
   * legacy `landlordId` (see unitContacts()) — never mutated on read. At most
   * one entry is primaryContact, kept consistent with `primary_contact`.
   */
  contacts?: UnitContact[];
  /**
   * BE3/C3: the PARENT property/building group (a duplex/building), NOT a single
   * dwelling (GLOSSARY: a `property` is the parent of units). Optional — only
   * set when the operator groups siblings. Indexed by the sparse `byProperty`
   * GSI for the related-units same_property lookup.
   */
  propertyId?: string;
  /**
   * Soft-delete marker (ISO 8601). PRESENT → the property is "deleted": hidden
   * from the property lists (and the landlord's properties card, related/similar),
   * but the record and ALL its data are retained so it can be restored (clear the
   * stamp). Mirrors the contact soft-delete.
   */
  deleted_at?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/**
 * A unit is soft-deleted when it carries a non-empty `deleted_at` stamp. Shared
 * by the repo (query filters) and any route hydration, so "deleted" is defined in
 * exactly one place.
 */
export function isDeleted(unit: Pick<UnitItem, 'deleted_at'>): boolean {
  return typeof unit.deleted_at === 'string' && unit.deleted_at.length > 0;
}

/**
 * Pure back-compat read serializer (BE3/C3). Returns the unit's `contacts` when
 * present & non-empty; else, when a legacy `landlordId` exists, the derived
 * single-row roster `[{ contactId: landlordId, role: 'landlord', primaryContact:
 * true }]`; else []. NEVER mutates the stored item (mirrors contactPhones).
 */
export function unitContacts(
  unit: Pick<UnitItem, 'contacts' | 'landlordId'>,
): UnitContact[] {
  if (Array.isArray(unit.contacts) && unit.contacts.length > 0) return unit.contacts;
  if (typeof unit.landlordId === 'string' && unit.landlordId.length > 0) {
    return [{ contactId: unit.landlordId, role: 'landlord', primaryContact: true }];
  }
  return [];
}

/** One page of a list query (opaque cursor handled at the route). */
export interface UnitsPage {
  items: UnitItem[];
  lastEvaluatedKey?: Record<string, unknown>;
}

export interface ListUnitsOpts {
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
  /**
   * Soft-delete scope. Omitted/false → exclude deleted properties (every normal
   * list). true → return ONLY soft-deleted properties (the "Deleted" view). Applied
   * as a FilterExpression on `deleted_at`.
   */
  //
  // 'any' (caseworkers, plan 3.3 as amended): NO soft-delete filter - live
  // and deleted units in one read. The caseworker conversion's
  // landlord-of-record and roster refusals count deleted properties (spec
  // 2026-10-06 D22: a restored property must not come back with a
  // caseworker on it).
  deleted?: boolean | 'any';
}

/**
 * The soft-delete FilterExpression (over `#del` = deleted_at) for a
 * ListUnitsOpts scope: live only (omitted/false), deleted only (true), or none
 * ('any' - and then the caller must not send the `#del` name either: DynamoDB
 * rejects an unused ExpressionAttributeNames entry).
 */
function deletedScopeFilter(deleted: ListUnitsOpts['deleted']): string | undefined {
  if (deleted === 'any') return undefined;
  return deleted === true ? 'attribute_exists(#del)' : 'attribute_not_exists(#del)';
}

/** The fields a staff-facing property label needs (the All tab's name map). */
export interface UnitDisplayItem {
  unitId: string;
  address?: UnitItem['address'];
}

/**
 * Create input: landlordId + status are required (the owning landlord and the
 * lifecycle/GSI status); everything else is optional and flows through as a
 * flexible-document attribute. unitId/created_at are repo-generated unless
 * supplied (tests pass fixed ids).
 */
export type CreateUnitInput = Partial<UnitItem> & { landlordId: string; status: string };

export interface UnitsRepo {
  /** Create a unit (generates unitId); returns the stored item. */
  create(input: CreateUnitInput): Promise<UnitItem>;
  /** `consistentRead` for a caller that decides a write from this read (the
   *  D5 "already held" check of the units PATCH); default eventually consistent. */
  getById(unitId: string, opts?: { consistentRead?: boolean }): Promise<UnitItem | undefined>;
  /**
   * Batch-read the display fields (unitId, address) of many units by primary
   * key - BEST-EFFORT, like contactsRepo.getDisplaysByIds: 100-key chunks,
   * UnprocessedKeys retried, keys still unread after the retries (or a chunk
   * whose request failed) are dropped with a WARN (counts only). A short map
   * is a missing LABEL, never an error. Soft-deleted units still answer.
   */
  getDisplaysByIds(unitIds: string[]): Promise<Map<string, UnitDisplayItem>>;
  /**
   * SET-merge update: only the supplied fields are written; omitted fields are
   * LEFT as stored (never blanked) — the same no-overwrite contract as
   * contactsRepo.update. Returns the post-update item (ALL_NEW). Throws
   * ConditionalCheckFailedException for unknown units.
   */
  update(unitId: string, patch: Record<string, unknown>): Promise<UnitItem>;
  /**
   * Soft-delete: stamp `deleted_at` (ISO 8601 `at`) so the property is hidden from
   * the lists / landlord card / related / similar while every field is retained.
   * ConditionExpression guards existence (route → 404). Returns ALL_NEW.
   */
  softDelete(unitId: string, at: string): Promise<UnitItem>;
  /** Restore a soft-deleted property: REMOVE `deleted_at`. ALL_NEW; 404-guarded. */
  restore(unitId: string): Promise<UnitItem>;
  /** All units for a landlord via the byLandlord GSI. */
  listByLandlord(landlordId: string, opts?: ListUnitsOpts): Promise<UnitsPage>;
  /** All units in a status via the byStatus GSI. */
  listByStatus(status: string, opts?: ListUnitsOpts): Promise<UnitsPage>;
  /** All units in a property group via the sparse byProperty GSI (BE3). */
  listByProperty(propertyId: string, opts?: ListUnitsOpts): Promise<UnitsPage>;
  /**
   * BE3/C3: add (or update) a contact on the unit's roster. Loads the unit
   * (throws ConditionalCheckFailedException when missing). Seeds `contacts[]`
   * from the legacy `landlordId` (via unitContacts) when absent. Idempotent on
   * (unitId, contactId): an already-present contact has its role/primaryContact/
   * name/company updated in place. Maintains AT MOST ONE primaryContact across
   * the roster (when this contact is primaryContact, every other is demoted).
   * This contact is primaryContact when the request asks for it, or - auto-
   * primary, caseworker-integrity spec revisions 4-6 as widened by
   * primary-contact-integrity spec 4.4 - when, as that attempt read the unit,
   * there is no LIVE flagged primary and no LIVE landlord of record (a
   * soft-deleted or missing contact counts as absent; the liveness comes from
   * `opts.readContacts`, called per attempt for exactly the flagged primary
   * and the landlordId - decideAutoPrimary), whatever its role (a
   * role-`landlord` claim of the vacant slot included) and whether it is a
   * NEW seat or an edit of its own row, provided it is eligible for automatic
   * routing (`facts.autoPrimaryEligible`: typed landlord, not soft-deleted,
   * not a routing pointer). A write for this contact never promotes another.
   * With no `opts.readContacts`, or a read that failed, liveness is unknown
   * and nothing is promoted unless no row is flagged and there is no
   * landlordId (main's rule). Decided inside the conditional retry loop from
   * each attempt's own read, so two racing writes never both promote.
   * A soft-deleted contact (`facts.contactDeleted`) asked to be primary on a
   * row that is not already the primary throws PrimaryContactDeletedError
   * (after the I4 / I3 refusals, before the reassignment refusal).
   * The contact-list rules (caseworker-integrity spec section 4), decided on
   * each attempt's own read from `facts` (ContactListFacts), in this order and
   * before the reassignment refusal below: a caseworker never takes a NEW seat
   * (ContactListCaseworkerError), and a claim of the vacant landlord slot needs
   * a contact typed landlord (LandlordClaimNotLandlordError). A refusal
   * writes nothing.
   * Adding role `landlord` to an ownerless legacy unit claims `landlordId` in
   * the same conditional write as contacts[]; a different existing or racing
   * owner throws LandlordReassignmentRequiredError instead of being replaced.
   * All roster writes optimistically compare landlordId + contacts[], retry up
   * to three times, then throw RosterWriteConflictError under sustained races.
   * The unit's `primary_contact` scalar is kept consistent with the roster:
   * the flagged row's contactId (a soft-deleted contact still flagged
   * included - flag and scalar never split), or REMOVEd when no row is
   * flagged after the write (nothing routes on the scalar: the
   * property-contact lookup, lib/propertyContact.ts, takes the LIVE row
   * marked primary, else the LIVE landlord of record, skipping a
   * soft-deleted or missing contact).
   * Persists contacts[] + the scalar.
   */
  addContact(
    unitId: string,
    contact: {
      contactId: string;
      role: UnitContact['role'];
      primaryContact?: boolean;
      name?: string;
      company?: string;
    },
    facts: ContactListFacts,
    opts?: { readContacts?: ReadRosterContacts },
  ): Promise<UnitItem>;
  /**
   * BE3/C3: remove a contact from the unit's roster. REJECTS removing the
   * LANDLORD OF RECORD (contactId === unit.landlordId) with
   * CannotRemoveLandlordOfRecordError (route 409). A contact not on the roster
   * throws ConditionalCheckFailedException (route 404). When the removed contact
   * was the current primaryContact, the roster flag and the `primary_contact`
   * scalar are kept in AGREEMENT: with a `landlordId`, the landlord row is
   * promoted to the lone primaryContact and the scalar points at it; with NO
   * `landlordId`, both are cleared (the scalar is REMOVEd, never left dangling at
   * the removed contact, and no row stays primaryContact). Persists contacts[] +
   * the scalar. Uses the same bounded optimistic roster guard as addContact.
   * Returns the unit.
   */
  removeContact(unitId: string, contactId: string): Promise<UnitItem>;
  /**
   * Property photos (unit-photos S1): ATOMIC append of new media keys onto
   * `media[]`. ONE UpdateItem - `list_append(if_not_exists(media, []), keys)` -
   * so concurrent appends never lose an entry (no read-modify-write). The write
   * is cap-guarded by a ConditionExpression on the CURRENT size (attribute
   * absent, or size <= cap - keys.length), so it can never push the array past
   * the cap even under a race; a violation throws
   * ConditionalCheckFailedException. `cap` defaults to UNIT_MEDIA_MAX. Returns
   * ALL_NEW. First array entry is the cover.
   */
  appendMedia(unitId: string, keys: string[], cap?: number): Promise<UnitItem>;
  /**
   * Property photos (unit-photos S1): remove one entry (an S3 key or legacy URL)
   * from `media[]`. Read-modify-write (single-operator action) conditioned on the
   * entry being present - an absent entry (or unknown unit) throws
   * ConditionalCheckFailedException (route 404). Returns ALL_NEW.
   */
  removeMedia(unitId: string, entry: string): Promise<UnitItem>;
  /**
   * Property photos (unit-photos S1): move `entry` to the FRONT of `media[]` (the
   * cover = hero + flyer lead photo). Read-modify-write. A no-op success when the
   * entry is already the cover (returns the unit unchanged). An absent entry (or
   * unknown unit) throws ConditionalCheckFailedException (route 404). ALL_NEW.
   */
  makeCover(unitId: string, entry: string): Promise<UnitItem>;
  /**
   * Unfiltered list — a paginated Scan. ACCEPTED at this scale (doc §5.1: the
   * whole active-units working set is hundreds to low thousands of small
   * items). When a status filter is supplied the route uses listByStatus (a
   * Query) instead; this Scan is only the no-filter fallback. The upgrade path
   * if units ever exceed tens of thousands is the same as the matching engine's
   * (§5.1): stream-fed indexes. Commented so the Scan is a known, bounded
   * choice, not an oversight.
   */
  list(opts?: ListUnitsOpts): Promise<UnitsPage>;
  /**
   * Organization-name rewrite (spec 2026-10-06 D11; plan 3.7): SET
   * `accepted_authorities` to `next` only while the stored list is EXACTLY
   * `expected` (whole-list equality, the updateRosterIfCurrent precedent) or,
   * for `expected` null, while no list is stored. NEVER stamps updated_at - a
   * machine write must not flip the importer's human-ownership signal
   * (lib/import/apply.ts). Answers 'skipped' on a lost condition (the list
   * changed, or there is no such unit).
   */
  rewriteAcceptedAuthorities(
    unitId: string,
    expected: string[] | null,
    next: string[],
  ): Promise<'written' | 'skipped'>;
  /**
   * caseworker-integrity (spec 2026-10-12 section 4 "Restore"): restore a
   * soft-deleted property AND change its landlord of record in one
   * conditional write. Reads the unit (consistent). When it is not
   * soft-deleted (restore never reassigns a LIVE property's landlord), or its
   * landlordId is no longer `expectLandlordId` (undefined = ownerless), throws
   * RosterWriteConflictError and writes nothing. Otherwise REMOVEs deleted_at,
   * sets landlordId to `next.contactId` (or REMOVEs it for `next` null), drops
   * the old landlord's contact-list row, upserts `next` with role pinned
   * 'landlord' (kept when already seated; name/company updated when supplied),
   * and keeps `primary_contact` consistent: when the old landlord was the
   * primary (roster flag or scalar), `next` becomes the sole primary, or with
   * no landlord the caller's sole-landlord promotion (`promote`, spec revision
   * 5) becomes the sole primary when it names a remaining row, else the scalar
   * is REMOVEd and no row stays primary (removeContact's rule). The write is
   * conditioned on the landlordId AND contacts[] it read
   * (updateRosterIfCurrent) and on deleted_at still existing, so a restore
   * landing after the read re-reads into RosterWriteConflictError; a
   * contacts-only race re-reads and retries up to
   * ROSTER_WRITE_MAX_ATTEMPTS, then RosterWriteConflictError - except for
   * `next` null, whose every read must show exactly the contact list the
   * caller decided its promotion from (`expectContacts`), so a contact-list
   * change answers RosterWriteConflictError, never a retry. A missing unit
   * throws ConditionalCheckFailedException (route 404). Returns ALL_NEW.
   */
  restoreWithLandlord(unitId: string, input: RestoreWithLandlordInput): Promise<UnitItem>;
}

export function createUnitsRepo(deps: RepoDeps = {}): UnitsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('units', deps.env);
  const log = deps.logger ?? defaultLogger;

  /** Shared GSI query (one partition, optional pagination). */
  async function queryIndex(
    indexName: string,
    keyName: string,
    keyValue: string,
    opts: ListUnitsOpts,
  ): Promise<UnitsPage> {
    const scopeFilter = deletedScopeFilter(opts.deleted);
    const input: QueryCommandInput = {
      TableName: table,
      IndexName: indexName,
      KeyConditionExpression: '#k = :v',
      // Soft-delete scope (FilterExpression — GSIs project ALL, so deleted_at is
      // filterable). Default HIDES deleted; deleted:true shows ONLY deleted.
      // deleted:'any' sends neither the filter nor its #del name.
      ...(scopeFilter !== undefined && { FilterExpression: scopeFilter }),
      ExpressionAttributeNames: { '#k': keyName, ...(scopeFilter !== undefined && { '#del': 'deleted_at' }) },
      ExpressionAttributeValues: { ':v': keyValue },
      ...(opts.limit !== undefined && { Limit: opts.limit }),
      ...(opts.exclusiveStartKey !== undefined && {
        ExclusiveStartKey: opts.exclusiveStartKey as QueryCommandInput['ExclusiveStartKey'],
      }),
    };
    const { Items, LastEvaluatedKey } = await doc.send(new QueryCommand(input));
    return {
      items: (Items ?? []) as UnitItem[],
      ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
    };
  }

  /**
   * Persist one read-modify-write roster mutation only while BOTH ownership and
   * the stored roster still match the caller's read. This keeps landlordId and
   * contacts[] structurally consistent across concurrent add/remove/claim
   * operations; callers re-read and retry a failed optimistic condition.
   * `requireSoftDeleted` (restoreWithLandlord only) also requires deleted_at to
   * still exist, so a restore landing after the caller's read loses the write.
   */
  async function updateRosterIfCurrent(
    unit: UnitItem,
    patch: Record<string, unknown>,
    opts: { requireSoftDeleted?: boolean } = {},
  ): Promise<UnitItem> {
    const sets: string[] = [];
    const removes: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    let i = 0;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
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
    names['#updatedAt'] = 'updated_at';
    values[':updatedAt'] = new Date().toISOString();
    sets.push('#updatedAt = :updatedAt');

    const conditions = ['attribute_exists(unitId)'];
    names['#expectedLandlordId'] = 'landlordId';
    if (Object.prototype.hasOwnProperty.call(unit, 'landlordId')) {
      values[':expectedLandlordId'] = unit.landlordId;
      conditions.push('#expectedLandlordId = :expectedLandlordId');
    } else {
      conditions.push('attribute_not_exists(#expectedLandlordId)');
    }
    names['#expectedContacts'] = 'contacts';
    if (Object.prototype.hasOwnProperty.call(unit, 'contacts')) {
      values[':expectedContacts'] = unit.contacts;
      conditions.push('#expectedContacts = :expectedContacts');
    } else {
      conditions.push('attribute_not_exists(#expectedContacts)');
    }
    if (opts.requireSoftDeleted === true) {
      names['#expectedDeletedAt'] = 'deleted_at';
      conditions.push('attribute_exists(#expectedDeletedAt)');
    }

    const clauses = [`SET ${sets.join(', ')}`];
    if (removes.length > 0) clauses.push(`REMOVE ${removes.join(', ')}`);
    const { Attributes } = await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { unitId: unit.unitId },
        UpdateExpression: clauses.join(' '),
        ConditionExpression: conditions.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return Attributes as UnitItem;
  }

  return {
    async create(input) {
      const now = new Date().toISOString();
      const createdAt = typeof input.created_at === 'string' ? input.created_at : now;
      const item: UnitItem = {
        ...input,
        unitId: input.unitId ?? `unit-${randomUUID()}`,
        created_at: createdAt,
        updated_at: now,
      };
      // A null field value is the "clear" sentinel (see update's REMOVE below);
      // on create it means the attribute is simply absent, so drop it rather
      // than storing a literal NULL. Keeps create/update clear semantics
      // symmetric (a cleared optional field is ABSENT, never a null attribute).
      for (const key of Object.keys(item)) {
        if ((item as Record<string, unknown>)[key] === null) {
          delete (item as Record<string, unknown>)[key];
        }
      }
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          // Defensive: never silently overwrite an existing unit on create.
          ConditionExpression: 'attribute_not_exists(unitId)',
        }),
      );
      log.info({ unitId: item.unitId, landlordId: item.landlordId }, 'unit created');
      return item;
    },

    async getById(unitId, opts) {
      const { Item } = await doc.send(
        new GetCommand({
          TableName: table,
          Key: { unitId },
          ...(opts?.consistentRead === true && { ConsistentRead: true }),
        }),
      );
      return Item as UnitItem | undefined;
    },

    // TODO(units-contacts-batchget-walk-duplicated): one shared walk with its twin, contactsRepo's private batchGetByIds.
    async getDisplaysByIds(unitIds) {
      const found = new Map<string, UnitDisplayItem>();
      // BatchGetItem REJECTS duplicate keys; callers may repeat an id.
      const uniqueIds = [...new Set(unitIds)];
      let unprocessed = 0;
      for (let i = 0; i < uniqueIds.length; i += 100) {
        let keys = uniqueIds.slice(i, i + 100).map((unitId) => ({ unitId }));
        try {
          for (let attempt = 0; attempt < 4 && keys.length > 0; attempt += 1) {
            if (attempt > 0) {
              await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** (attempt - 1)));
            }
            const response = await doc.send(
              new BatchGetCommand({
                RequestItems: {
                  [table]: {
                    Keys: keys,
                    ProjectionExpression: '#unitId, #address',
                    ExpressionAttributeNames: { '#unitId': 'unitId', '#address': 'address' },
                  },
                },
              }),
            );
            for (const item of (response.Responses?.[table] ?? []) as UnitDisplayItem[]) {
              found.set(item.unitId, item);
            }
            keys = (response.UnprocessedKeys?.[table]?.Keys ?? []) as Array<{ unitId: string }>;
          }
        } catch (err) {
          log.warn({ err, chunkKeys: keys.length }, 'units: BatchGet chunk failed - keys dropped');
        }
        unprocessed += keys.length;
      }
      if (unprocessed > 0) {
        log.warn({ unprocessed, requested: uniqueIds.length }, 'units: BatchGet left keys unprocessed after retries');
      }
      return found;
    },

    async update(unitId, patch) {
      // SET each supplied non-null field; REMOVE each explicit-null field (the
      // only way to truly CLEAR an attribute — e.g. removeContact dropping a
      // dangling primary_contact when no landlord remains; mirrors
      // placementsRepo.update). Omitted (undefined) fields are LEFT untouched (the
      // no-overwrite contract). Names are expression-aliased so reserved words
      // (`status`, `priority`, `media`) are always legal. updated_at is always
      // bumped.
      const sets: string[] = [];
      const removes: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      let i = 0;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue; // omitted → untouched
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
      names['#updatedAt'] = 'updated_at';
      values[':updatedAt'] = new Date().toISOString();
      sets.push('#updatedAt = :updatedAt');

      const clauses = [`SET ${sets.join(', ')}`];
      if (removes.length > 0) clauses.push(`REMOVE ${removes.join(', ')}`);

      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { unitId },
          UpdateExpression: clauses.join(' '),
          ConditionExpression: 'attribute_exists(unitId)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ unitId, fields: sets.length - 1 + removes.length }, 'unit updated');
      return Attributes as UnitItem;
    },

    async softDelete(unitId, at) {
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { unitId },
          UpdateExpression: 'SET #del = :at, #updatedAt = :at',
          ConditionExpression: 'attribute_exists(unitId)',
          ExpressionAttributeNames: { '#del': 'deleted_at', '#updatedAt': 'updated_at' },
          ExpressionAttributeValues: { ':at': at },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ unitId }, 'unit soft-deleted');
      return Attributes as UnitItem;
    },

    async restore(unitId) {
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { unitId },
          UpdateExpression: 'REMOVE #del SET #updatedAt = :now',
          ConditionExpression: 'attribute_exists(unitId)',
          ExpressionAttributeNames: { '#del': 'deleted_at', '#updatedAt': 'updated_at' },
          ExpressionAttributeValues: { ':now': new Date().toISOString() },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ unitId }, 'unit restored');
      return Attributes as UnitItem;
    },

    async listByLandlord(landlordId, opts = {}) {
      return queryIndex('byLandlord', 'landlordId', landlordId, opts);
    },

    async listByStatus(status, opts = {}) {
      return queryIndex('byStatus', 'status', status, opts);
    },

    async listByProperty(propertyId, opts = {}) {
      return queryIndex('byProperty', 'propertyId', propertyId, opts);
    },

    async addContact(unitId, contact, facts, opts) {
      let attempts = 0;
      const write = async (): Promise<UnitItem> => {
        attempts += 1;
        // CONSISTENT (final review A7, fix wave FWF-5): the contact-list
        // refusals below are thrown on this read and write nothing, so no
        // conditional write ever confirms it - a lagging replica must not
        // refuse a state the route's own consistent read saw as allowed.
        const unit = await this.getById(unitId, { consistentRead: true });
        if (!unit) {
          throw new ConditionalCheckFailedException({
            message: `unit ${unitId} not found`,
            $metadata: {},
          });
        }
        // A sparse byLandlord GSI permits only a real string key or NO attribute;
        // ownerless therefore means landlordId is structurally absent, not an
        // empty/null/malformed value.
        const hasLandlordId = Object.prototype.hasOwnProperty.call(unit, 'landlordId');
        const landlordId =
          hasLandlordId && typeof unit.landlordId === 'string' && unit.landlordId.length > 0
            ? unit.landlordId
            : undefined;
        const claimsVacantLandlord = contact.role === 'landlord' && !hasLandlordId;
        // Seed the roster from the legacy landlordId when absent (so the primary
        // landlord is always represented), then upsert this contact by contactId.
        const roster = unitContacts(unit).map((c) => ({ ...c }));
        const existing = roster.find((c) => c.contactId === contact.contactId);
        // caseworker-integrity (spec 2026-10-12 section 4; R1 code review backend
        // finding 1, fix wave 2 FW2-1): the contact-list rules, decided again on
        // THIS attempt's read from the facts the caller read about the contact.
        // The route checks them first on its own read (the no-race answer, in
        // the spec's order); deciding them here too, where the write below is
        // conditioned on the landlordId and contacts[] this attempt read, means
        // a seat removed or a landlord cleared after the route's read is
        // refused - never re-created or claimed.
        //   I4: a caseworker never takes a NEW seat (no row for the contact).
        //   I3: claiming the vacant landlord slot needs a contact typed landlord.
        // Then primary-contact-integrity (spec 4.4): a soft-deleted contact is
        // never made the primary unless its row already is - re-sending true
        // for the current primary is never refused and changes nothing.
        if (existing === undefined && facts.caseworker) throw new ContactListCaseworkerError();
        if (claimsVacantLandlord && !facts.landlordTyped) throw new LandlordClaimNotLandlordError();
        if (
          contact.primaryContact === true &&
          facts.contactDeleted === true &&
          existing?.primaryContact !== true
        ) {
          throw new PrimaryContactDeletedError();
        }
        if (
          contact.role === 'landlord' &&
          !claimsVacantLandlord &&
          contact.contactId !== landlordId
        ) {
          throw new LandlordReassignmentRequiredError();
        }
        // Auto-primary (caseworker-integrity spec revisions 4-6, widened by
        // primary-contact-integrity spec 4.4, Cameron 2026-10-13): this write
        // for contact X - an add or an edit of X's own row - makes X, and only
        // X, the primary when X is eligible for automatic routing
        // (`facts.autoPrimaryEligible`) and THIS attempt's read has no LIVE
        // flagged primary and no LIVE landlord of record (soft-deleted or
        // missing counts as absent). The liveness is the caller's
        // `opts.readContacts`, called here - per attempt, after this attempt's
        // unit read and before its conditional write - for exactly the ids
        // autoPrimaryLivenessIds names; no read supplied, or a failed read, is
        // unknown: no promotion (the route WARNs). The decision is the shared
        // pure decideAutoPrimary (the API-test fake calls the same function).
        // The write below is conditioned on the landlordId and contacts[] this
        // attempt read, so of two racing writes only the first to commit can
        // promote; the loser re-reads and sees that primary.
        const autoArgs: AutoPrimaryArgs = {
          roster,
          landlordId,
          contactId: contact.contactId,
          eligible: facts.autoPrimaryEligible,
          requested: contact.primaryContact === true,
        };
        const livenessIds = autoPrimaryLivenessIds(autoArgs);
        const read =
          livenessIds !== null && livenessIds.length > 0 && opts?.readContacts !== undefined
            ? await opts.readContacts(livenessIds)
            : undefined;
        const decision = decideAutoPrimary({ ...autoArgs, read });
        const autoPrimary = decision === 'promote';
        // The owning landlord's role is STRUCTURAL: a row for the unit's
        // landlordId is always 'landlord', regardless of the supplied role - a
        // non-'landlord' add must never overwrite it (BE3/C3 FIX C).
        const isLandlordOfRecord =
          claimsVacantLandlord || contact.contactId === landlordId;
        const role: UnitContact['role'] = isLandlordOfRecord ? 'landlord' : contact.role;
        const next: UnitContact = {
          contactId: contact.contactId,
          role,
          primaryContact: contact.primaryContact === true || autoPrimary,
          ...(contact.name !== undefined ? { name: contact.name } : {}),
          ...(contact.company !== undefined ? { company: contact.company } : {}),
        };
        if (existing) {
          existing.role = next.role; // pinned to 'landlord' for the owning landlord
          existing.primaryContact = next.primaryContact;
          // Denormalized fields: update when supplied, preserve otherwise.
          if (contact.name !== undefined) existing.name = contact.name;
          if (contact.company !== undefined) existing.company = contact.company;
        } else {
          roster.push(next);
        }

        // EXACTLY-ONE-primaryContact: when this contact is the primary - asked for,
        // or made so by the auto-primary rule above - demote every other. When it
        // isn't, leave any existing primary as-is (a soft-deleted primary that
        // nobody replaced keeps its flag - spec 4.4).
        if (next.primaryContact) {
          for (const c of roster) c.primaryContact = c.contactId === contact.contactId;
        }

        // Keep the `primary_contact` scalar consistent with the roster's
        // primary row (nothing routes on the scalar: the property-contact
        // lookup, lib/propertyContact.ts, takes the LIVE row marked primary,
        // else the LIVE landlord of record, and a masked call dials the live
        // thread's participants without reading the unit). With a primary row
        // - a soft-deleted contact still flagged included, so flag and scalar
        // never split (spec 4.4) - the scalar names it; with NO row flagged
        // after this write the scalar is REMOVEd (null -> REMOVE), so a stale
        // value left by an earlier demotion never lingers.
        const primary = roster.find((c) => c.primaryContact);
        const patch: Record<string, unknown> = {
          contacts: roster,
          primary_contact: primary !== undefined ? primary.contactId : null,
        };
        if (claimsVacantLandlord) patch['landlordId'] = contact.contactId;

        let updated: UnitItem;
        try {
          updated = await updateRosterIfCurrent(unit, patch);
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
          // CONSISTENT, like each attempt's read (final review round 2 R2-4):
          // the reassignment refusal below is thrown on this re-read and
          // writes nothing, so no conditional write ever confirms it.
          const current = await this.getById(unitId, { consistentRead: true });
          if (current === undefined) throw err;
          const currentHasLandlordId = Object.prototype.hasOwnProperty.call(
            current,
            'landlordId',
          );
          if (
            contact.role === 'landlord' &&
            currentHasLandlordId &&
            current.landlordId !== contact.contactId
          ) {
            throw new LandlordReassignmentRequiredError();
          }
          if (attempts >= ROSTER_WRITE_MAX_ATTEMPTS) {
            throw new RosterWriteConflictError();
          }
          // Ownership or contacts[] changed after our read. Re-run from the
          // current item so no concurrent roster row is lost, deciding the
          // auto-primary again on a fresh liveness read.
          return write();
        }
        log.info(
          {
            unitId,
            contactId: contact.contactId,
            rosterSize: roster.length,
            primaryContact: next.primaryContact,
            autoPrimary,
            ...(decision === 'unknown' && { autoPrimaryUnknown: true }),
          },
          'unit contact added',
        );
        return updated;
      };
      return write();
    },

    async removeContact(unitId, contactId) {
      let attempts = 0;
      const write = async (): Promise<UnitItem> => {
        attempts += 1;
        const unit = await this.getById(unitId);
        if (!unit) {
          throw new ConditionalCheckFailedException({
            message: `unit ${unitId} not found`,
            $metadata: {},
          });
        }
        // The landlord of record (legacy landlordId) must remain in the roster —
        // reassign landlordId first (typed error → route 409).
        if (typeof unit.landlordId === 'string' && unit.landlordId === contactId) {
          throw new CannotRemoveLandlordOfRecordError();
        }
        const roster = unitContacts(unit).map((c) => ({ ...c }));
        const target = roster.find((c) => c.contactId === contactId);
        if (!target) {
          // Not on the roster (route 404). Mirrors the contacts removePhone 404.
          throw new ConditionalCheckFailedException({
            message: `unit ${unitId} has no roster contact ${contactId}`,
            $metadata: {},
          });
        }
        const removedWasPrimaryContact = target.primaryContact;
        const next = roster.filter((c) => c.contactId !== contactId);

        const patch: Record<string, unknown> = { contacts: next };
        // When the removed contact was the ☎ primary, keep the roster flag and the
        // scalar `primary_contact` in AGREEMENT (BE3/C3 FIX B) — a frontend
        // deriving "which is the ☎ primary" from either source must get the same
        // answer, and the scalar must never dangle at the removed contact.
        if (removedWasPrimaryContact) {
          const landlordId = typeof unit.landlordId === 'string' ? unit.landlordId : '';
          if (landlordId.length > 0) {
            // Promote the landlord row to the ☎ primary (exactly one) and point
            // the scalar at it. The landlord can't be removed (guarded above), so
            // its row is still present in `next`.
            for (const c of next) c.primaryContact = c.contactId === landlordId;
            patch['primary_contact'] = landlordId;
          } else {
            // No landlord to fall back to: clear the scalar (never leave it
            // dangling at the removed contact) and leave the roster with no ☎
            // primary. null → UpdateExpression REMOVE (see update()).
            for (const c of next) c.primaryContact = false;
            patch['primary_contact'] = null;
          }
        }

        let updated: UnitItem;
        try {
          updated = await updateRosterIfCurrent(unit, patch);
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
          const current = await this.getById(unitId);
          if (current === undefined) throw err;
          if (attempts >= ROSTER_WRITE_MAX_ATTEMPTS) {
            throw new RosterWriteConflictError();
          }
          // Ownership or contacts[] changed after our read. Re-run from the
          // current item so the removal applies without erasing the winner.
          return write();
        }
        log.info(
          {
            unitId,
            contactId,
            rosterSize: next.length,
            removedPrimaryContact: removedWasPrimaryContact,
          },
          'unit contact removed',
        );
        return updated;
      };
      return write();
    },

    async appendMedia(unitId, keys, cap = UNIT_MEDIA_MAX) {
      // The ConditionExpression's size() guard below only covers a PRESENT
      // `media` attribute - `if_not_exists` is an UpdateExpression-only
      // function, so a `size(if_not_exists(#media, :empty)) <= :room` condition
      // is NOT expressible and DynamoDB cannot size-guard the attribute-absent
      // (first-append) branch itself. Close that branch HERE: a batch larger
      // than the cap can never fit whatever the current size, so reject it
      // before the write (same exception type the condition throws, so callers
      // map it identically). Combined with the size() condition this makes the
      // cap invariant race-free: concurrent first appends serialize at
      // DynamoDB - the loser sees #media present and hits the size() guard.
      if (keys.length > cap) {
        throw new ConditionalCheckFailedException({
          message: `appendMedia: batch of ${keys.length} exceeds cap ${cap}`,
          $metadata: {},
        });
      }
      // ATOMIC append: one UpdateItem with list_append over if_not_exists (seeds
      // a missing `media`). The cap guard is a ConditionExpression on the CURRENT
      // size so the array can never exceed the cap even under a concurrent
      // append - `media` absent (safe: the batch bound above caps a first
      // append), OR its size <= cap - keys.length. A violation (or a missing
      // unit) throws ConditionalCheckFailedException.
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { unitId },
          UpdateExpression:
            'SET #media = list_append(if_not_exists(#media, :empty), :new), #updatedAt = :now',
          ConditionExpression:
            'attribute_exists(unitId) AND (attribute_not_exists(#media) OR size(#media) <= :room)',
          ExpressionAttributeNames: { '#media': 'media', '#updatedAt': 'updated_at' },
          ExpressionAttributeValues: {
            ':empty': [] as string[],
            ':new': keys,
            ':room': cap - keys.length,
            ':now': new Date().toISOString(),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ unitId, added: keys.length }, 'unit media appended');
      return Attributes as UnitItem;
    },

    async removeMedia(unitId, entry) {
      const unit = await this.getById(unitId);
      if (!unit) {
        throw new ConditionalCheckFailedException({ message: `unit ${unitId} not found`, $metadata: {} });
      }
      const media = Array.isArray(unit.media) ? unit.media.filter((e): e is string => typeof e === 'string') : [];
      if (!media.includes(entry)) {
        throw new ConditionalCheckFailedException({
          message: `unit ${unitId} has no media entry`,
          $metadata: {},
        });
      }
      const next = media.filter((e) => e !== entry);
      const updated = await this.update(unitId, { media: next });
      log.info({ unitId, remaining: next.length }, 'unit media removed');
      return updated;
    },

    async makeCover(unitId, entry) {
      const unit = await this.getById(unitId);
      if (!unit) {
        throw new ConditionalCheckFailedException({ message: `unit ${unitId} not found`, $metadata: {} });
      }
      const media = Array.isArray(unit.media) ? unit.media.filter((e): e is string => typeof e === 'string') : [];
      if (!media.includes(entry)) {
        throw new ConditionalCheckFailedException({
          message: `unit ${unitId} has no media entry`,
          $metadata: {},
        });
      }
      // Already the cover -> no-op success (return the unit unchanged, no write).
      if (media[0] === entry) return unit;
      const next = [entry, ...media.filter((e) => e !== entry)];
      const updated = await this.update(unitId, { media: next });
      log.info({ unitId }, 'unit media cover set');
      return updated;
    },

    async list(opts = {}) {
      // Paginated Scan — the no-filter fallback only (see the interface note on
      // why a Scan is acceptable at this scale, doc §5.1).
      const scopeFilter = deletedScopeFilter(opts.deleted);
      const input: ScanCommandInput = {
        TableName: table,
        // Soft-delete scope: default excludes deleted; deleted:true shows only
        // them; deleted:'any' scans with no filter (and no #del name).
        ...(scopeFilter !== undefined && {
          FilterExpression: scopeFilter,
          ExpressionAttributeNames: { '#del': 'deleted_at' },
        }),
        ...(opts.limit !== undefined && { Limit: opts.limit }),
        ...(opts.exclusiveStartKey !== undefined && {
          ExclusiveStartKey: opts.exclusiveStartKey as ScanCommandInput['ExclusiveStartKey'],
        }),
      };
      const { Items, LastEvaluatedKey } = await doc.send(new ScanCommand(input));
      return {
        items: (Items ?? []) as UnitItem[],
        ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
      };
    },

    async rewriteAcceptedAuthorities(unitId, expected, next) {
      const values: Record<string, unknown> = { ':next': next };
      const conditions = ['attribute_exists(unitId)'];
      if (expected === null) {
        conditions.push('attribute_not_exists(#aa)');
      } else {
        values[':expected'] = expected;
        conditions.push('#aa = :expected');
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { unitId },
            // Deliberately no updated_at (see the interface note).
            UpdateExpression: 'SET #aa = :next',
            ConditionExpression: conditions.join(' AND '),
            ExpressionAttributeNames: { '#aa': 'accepted_authorities' },
            ExpressionAttributeValues: values,
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return 'skipped';
        throw err;
      }
      log.info({ unitId, members: next.length }, 'unit accepted authorities rewritten');
      return 'written';
    },

    async restoreWithLandlord(unitId, input) {
      let attempts = 0;
      const write = async (): Promise<UnitItem> => {
        attempts += 1;
        const unit = await this.getById(unitId, { consistentRead: true });
        if (!unit) {
          throw new ConditionalCheckFailedException({
            message: `unit ${unitId} not found`,
            $metadata: {},
          });
        }
        // Restore only ever restores: a unit that is not soft-deleted (never
        // deleted, or restored by someone else since the caller's read) must
        // not have its landlord of record swapped or cleared here (R1 code
        // review, backend finding 2) - a concurrent change the caller must
        // re-read (route 409 unit_roster_conflict). The write below is
        // conditioned on deleted_at too, for a restore landing after this read.
        if (!isDeleted(unit)) throw new RosterWriteConflictError();
        const current =
          typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined;
        // The caller decided from THIS landlordId; any other owner now is a
        // concurrent change the caller must re-read (route 409 unit_roster_conflict).
        if (current !== input.expectLandlordId) throw new RosterWriteConflictError();
        // A restore WITHOUT a landlord carries the caller's sole-landlord
        // promotion (spec revision 5; fix wave 2 FW2-12), decided from the
        // contact list the caller read. On any other list - a contact-list
        // change since - that decision is stale: a conflict the caller must
        // re-read (route 409 unit_roster_conflict), never a retry that applies
        // it anyway. The write below is conditioned on this very list, so a
        // change landing after this read loses the write and re-reads into here.
        if (input.next === null && !isDeepStrictEqual(unit.contacts, input.expectContacts)) {
          throw new RosterWriteConflictError();
        }
        const old = input.expectLandlordId;
        const next = input.next;
        const promote = input.next === null ? input.promote : null;
        let primaryPromoted: string | undefined;
        // `next` naming the old landlord (only reachable when they became a
        // landlord again under a race) keeps their row instead of re-adding it.
        const keepsOld = next !== null && next.contactId === old;
        const roster = unitContacts(unit).map((c) => ({ ...c }));
        const oldRow = old !== undefined && !keepsOld ? roster.find((c) => c.contactId === old) : undefined;
        const oldWasPrimary =
          old !== undefined && !keepsOld && (oldRow?.primaryContact === true || unit.primary_contact === old);
        const nextRoster: UnitContact[] =
          old !== undefined && !keepsOld ? roster.filter((c) => c.contactId !== old) : roster;
        if (next !== null) {
          const seated = nextRoster.find((c) => c.contactId === next.contactId);
          if (seated) {
            seated.role = 'landlord'; // the landlord of record's role is structural
            if (next.name !== undefined) seated.name = next.name;
            if (next.company !== undefined) seated.company = next.company;
          } else {
            nextRoster.push({
              contactId: next.contactId,
              role: 'landlord',
              primaryContact: false,
              ...(next.name !== undefined ? { name: next.name } : {}),
              ...(next.company !== undefined ? { company: next.company } : {}),
            });
          }
        }
        const patch: Record<string, unknown> = {
          contacts: nextRoster,
          landlordId: next !== null ? next.contactId : null, // null -> REMOVE
          deleted_at: null, // null -> REMOVE: the restore itself
        };
        if (oldWasPrimary) {
          if (next !== null) {
            for (const c of nextRoster) c.primaryContact = c.contactId === next.contactId;
            patch['primary_contact'] = next.contactId;
          } else {
            // No landlord to fall back to. The caller's sole-landlord promotion
            // (Cameron's Q5, spec revision 5), when it names a remaining row,
            // becomes the sole primary in this same write; otherwise clear the
            // scalar (removeContact's rule), never leave it dangling at the
            // removed landlord.
            const promoted = promote === null ? undefined : nextRoster.find((c) => c.contactId === promote);
            for (const c of nextRoster) c.primaryContact = promoted !== undefined && c.contactId === promoted.contactId;
            patch['primary_contact'] = promoted !== undefined ? promoted.contactId : null;
            primaryPromoted = promoted?.contactId;
          }
        }
        let updated: UnitItem;
        try {
          updated = await updateRosterIfCurrent(unit, patch, { requireSoftDeleted: true });
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
          if (attempts >= ROSTER_WRITE_MAX_ATTEMPTS) throw new RosterWriteConflictError();
          // Re-read: a vanished unit throws (route 404), a unit restored or a
          // landlordId changed meanwhile throws RosterWriteConflictError, a
          // contacts-only race retries - or, for a restore without a landlord,
          // fails the contact-list check above (RosterWriteConflictError).
          return write();
        }
        log.info(
          {
            unitId,
            attempts,
            landlordCleared: next === null,
            ...(primaryPromoted !== undefined && { primaryPromoted }),
            rosterSize: nextRoster.length,
          },
          'unit restored with a landlord change',
        );
        return updated;
      };
      return write();
    },
  };
}

/** Re-export so callers needn't import ConditionalCheckFailedException separately. */
export { ConditionalCheckFailedException };
