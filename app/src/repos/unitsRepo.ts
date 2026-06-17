// units repo (M1.5) — the landlord units the share-broadcast (M1.6) fans out
// and the flyer endpoint exposes a safe subset of (doc §5).
//
// Items stay FLEXIBLE documents — only keys + GSI key attributes are
// contractual (lib/tables.ts): PK unitId, plus the byLandlord (landlordId),
// byStatus (status) and byJurisdiction (jurisdiction) GSIs. Everything else
// (rents, beds, the never-standardized per-unit tour/application processes)
// is a free-form attribute, so schema churn during the build needs no
// migration — exactly the §5 posture.
//
// NO GEOCODING (kickoff "no geocoding — out of scope"): `address` is a
// STRUCTURED postal address (lib/address.ts Address: line1/line2/city/state/zip,
// all optional) and `jurisdiction` is a plain string the operator sets; §5's
// "geocoded address" is intentionally NOT implemented here (README deviation
// row). The Address type is reused for tenant/contact addresses later.
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  ScanCommand,
  type ScanCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Address } from '../lib/address.js';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

/**
 * Unit lifecycle status (byStatus GSI hash; also gates the public flyer). The
 * doc gives examples, not a closed enum (units are flexible documents), but the
 * codebase WRITES exactly these — the route allowlists them so the GSI
 * partition key never takes an arbitrary value. 'available' is the only
 * publicly shareable status (see SHAREABLE_STATUSES).
 */
export type UnitStatus = 'available' | 'placed' | 'inactive';

export const UNIT_STATUSES: readonly UnitStatus[] = ['available', 'placed', 'inactive'] as const;

/** Statuses whose unit may be exposed by the public flyer endpoint. */
export const SHAREABLE_STATUSES: ReadonlySet<string> = new Set<UnitStatus>(['available']);

/**
 * One contact on a unit's roster (BE3/C3 — contract verbatim; the frontend
 * imports the same shape). A unit has a many-to-many roster of the people who
 * own/manage it: the landlord, a property manager, the owner, or anyone else
 * relevant. Exactly one entry across the roster is `primaryVoice: true` (the ☎
 * primary — the landlord-side person a masked tenant→landlord call routes to;
 * see unitsRepo.addContact, which keeps `primary_voice_contact` consistent with
 * it). `name`/`company` are DENORMALIZED at write time (the route resolves them
 * from the contact) so the roster row is self-describing without a join.
 */
export interface UnitContact {
  contactId: string;
  role: 'landlord' | 'pm' | 'owner' | 'other';
  /** The ☎ primary — exactly one true across the roster. */
  primaryVoice: boolean;
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
 * related-listing card without a second fetch.
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
 * `landlordId` (the primary landlord). The primary landlord must remain in the
 * roster — the operator reassigns `landlordId` first (a unit PATCH). The route
 * maps this to a 409 `cannot_remove_primary_landlord`.
 */
export class CannotRemovePrimaryLandlordError extends Error {
  constructor(message = 'cannot remove the primary landlord; reassign landlordId first') {
    super(message);
    this.name = 'CannotRemovePrimaryLandlordError';
  }
}

/**
 * The contractual + commonly read attributes; items stay flexible documents
 * (only unitId + the three GSI keys are contractual). All listing facts are
 * optional — a unit can be created as a stub and filled in over time, exactly
 * like a contact.
 */
export interface UnitItem {
  unitId: string;
  /** byLandlord GSI: the owning landlord's contactId (a contacts row). */
  landlordId: string;
  /** byStatus GSI: lifecycle status (UNIT_STATUSES). */
  status: string;
  /** byJurisdiction GSI: the primary HCV jurisdiction string (free text, no geocoding). */
  jurisdiction?: string;
  /**
   * Structured postal address (lib/address.ts) — NO geocoding (out of scope,
   * kickoff). All sub-fields optional. Legacy dev units may still hold a plain
   * string here; reads tolerate both (see units route / frontend display).
   */
  address?: Address;
  /** HCV programs this unit accepts (e.g. GHV, Step Up); §13 question pending. */
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
  /** Utilities arrangement — free-form (string). */
  utilities?: string;
  /** Accessibility notes — free-form. */
  accessibility?: string;
  /** Pets policy — free-form (string or boolean). */
  pets?: string | boolean;
  /** Listing priority — free-form. */
  priority?: string;
  /** Photo/media references — S3 keys or URLs. */
  media?: string[];
  /** Public flyer link. */
  listing_link?: string;
  /** The never-standardized per-unit tour process (free text). INTERNAL. */
  tour_process?: string;
  /** The never-standardized per-unit application process (free text). INTERNAL. */
  application_process?: string;
  /**
   * Per-unit primary voice contact for masked calling (CO1): the
   * landlord-side person a masked tenant→landlord call routes to. Stored as a
   * contactId. PENDING FOUNDER CONFIRMATION — may move to per-placement (CO1
   * notes routing comes "from the per-unit process" today; a later change
   * order may relocate this onto the case/placement). INTERNAL — never exposed
   * by the public flyer.
   */
  primary_voice_contact?: string;
  /**
   * BE3/C3: the roster of contacts who own/manage this unit (landlord, PM,
   * owner, …). When ABSENT, reads serve the back-compat roster derived from the
   * legacy `landlordId` (see unitContacts()) — never mutated on read. Exactly
   * one entry is primaryVoice, kept consistent with `primary_voice_contact`.
   */
  contacts?: UnitContact[];
  /**
   * BE3/C3: the PARENT property/building group (a duplex/building), NOT a single
   * dwelling (GLOSSARY: a `property` is the parent of units). Optional — only
   * set when the operator groups siblings. Indexed by the sparse `byProperty`
   * GSI for the related-units same_property lookup.
   */
  propertyId?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/**
 * Pure back-compat read serializer (BE3/C3). Returns the unit's `contacts` when
 * present & non-empty; else, when a legacy `landlordId` exists, the derived
 * single-row roster `[{ contactId: landlordId, role: 'landlord', primaryVoice:
 * true }]`; else []. NEVER mutates the stored item (mirrors contactPhones).
 */
export function unitContacts(
  unit: Pick<UnitItem, 'contacts' | 'landlordId'>,
): UnitContact[] {
  if (Array.isArray(unit.contacts) && unit.contacts.length > 0) return unit.contacts;
  if (typeof unit.landlordId === 'string' && unit.landlordId.length > 0) {
    return [{ contactId: unit.landlordId, role: 'landlord', primaryVoice: true }];
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
  getById(unitId: string): Promise<UnitItem | undefined>;
  /**
   * SET-merge update: only the supplied fields are written; omitted fields are
   * LEFT as stored (never blanked) — the same no-overwrite contract as
   * contactsRepo.update. Returns the post-update item (ALL_NEW). Throws
   * ConditionalCheckFailedException for unknown units.
   */
  update(unitId: string, patch: Record<string, unknown>): Promise<UnitItem>;
  /** All units for a landlord via the byLandlord GSI. */
  listByLandlord(landlordId: string, opts?: ListUnitsOpts): Promise<UnitsPage>;
  /** All units in a status via the byStatus GSI. */
  listByStatus(status: string, opts?: ListUnitsOpts): Promise<UnitsPage>;
  /** All units in a jurisdiction via the byJurisdiction GSI. */
  listByJurisdiction(jurisdiction: string, opts?: ListUnitsOpts): Promise<UnitsPage>;
  /** All units in a property group via the sparse byProperty GSI (BE3). */
  listByProperty(propertyId: string, opts?: ListUnitsOpts): Promise<UnitsPage>;
  /**
   * BE3/C3: add (or update) a contact on the unit's roster. Loads the unit
   * (throws ConditionalCheckFailedException when missing). Seeds `contacts[]`
   * from the legacy `landlordId` (via unitContacts) when absent. Idempotent on
   * (unitId, contactId): an already-present contact has its role/primaryVoice/
   * name/company updated in place. Maintains EXACTLY ONE primaryVoice across the
   * roster (when this contact is primaryVoice, every other is demoted). When the
   * roster's primaryVoice changes, the unit's `primary_voice_contact` (the
   * voice-routing field the masked-call bridge reads) is kept consistent =
   * the primaryVoice contact's contactId. Persists contacts[] + the voice field.
   */
  addContact(
    unitId: string,
    contact: {
      contactId: string;
      role: UnitContact['role'];
      primaryVoice?: boolean;
      name?: string;
      company?: string;
    },
  ): Promise<UnitItem>;
  /**
   * BE3/C3: remove a contact from the unit's roster. REJECTS removing the
   * primary landlord (contactId === unit.landlordId) with
   * CannotRemovePrimaryLandlordError (route 409). A contact not on the roster
   * throws ConditionalCheckFailedException (route 404). When the removed contact
   * was the current primaryVoice, the roster flag and the `primary_voice_contact`
   * scalar are kept in AGREEMENT: with a `landlordId`, the landlord row is
   * promoted to the lone primaryVoice and the scalar points at it; with NO
   * `landlordId`, both are cleared (the scalar is REMOVEd, never left dangling at
   * the removed contact, and no row stays primaryVoice). Persists contacts[] +
   * the voice field. Returns the unit.
   */
  removeContact(unitId: string, contactId: string): Promise<UnitItem>;
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
    const input: QueryCommandInput = {
      TableName: table,
      IndexName: indexName,
      KeyConditionExpression: '#k = :v',
      ExpressionAttributeNames: { '#k': keyName },
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

    async getById(unitId) {
      const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { unitId } }));
      return Item as UnitItem | undefined;
    },

    async update(unitId, patch) {
      // SET each supplied non-null field; REMOVE each explicit-null field (the
      // only way to truly CLEAR an attribute — e.g. removeContact dropping a
      // dangling primary_voice_contact when no landlord remains; mirrors
      // casesRepo.update). Omitted (undefined) fields are LEFT untouched (the
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

    async listByLandlord(landlordId, opts = {}) {
      return queryIndex('byLandlord', 'landlordId', landlordId, opts);
    },

    async listByStatus(status, opts = {}) {
      return queryIndex('byStatus', 'status', status, opts);
    },

    async listByJurisdiction(jurisdiction, opts = {}) {
      return queryIndex('byJurisdiction', 'jurisdiction', jurisdiction, opts);
    },

    async listByProperty(propertyId, opts = {}) {
      return queryIndex('byProperty', 'propertyId', propertyId, opts);
    },

    async addContact(unitId, contact) {
      const unit = await this.getById(unitId);
      if (!unit) {
        throw new ConditionalCheckFailedException({
          message: `unit ${unitId} not found`,
          $metadata: {},
        });
      }
      // Seed the roster from the legacy landlordId when absent (so the primary
      // landlord is always represented), then upsert this contact by contactId.
      const roster = unitContacts(unit).map((c) => ({ ...c }));
      const existing = roster.find((c) => c.contactId === contact.contactId);
      // The owning landlord's role is STRUCTURAL: a row for the unit's
      // landlordId is always 'landlord', regardless of the supplied role — a
      // non-'landlord' add must never overwrite it (BE3/C3 FIX C).
      const isPrimaryLandlord =
        typeof unit.landlordId === 'string' && contact.contactId === unit.landlordId;
      const role: UnitContact['role'] = isPrimaryLandlord ? 'landlord' : contact.role;
      const next: UnitContact = {
        contactId: contact.contactId,
        role,
        primaryVoice: contact.primaryVoice === true,
        ...(contact.name !== undefined ? { name: contact.name } : {}),
        ...(contact.company !== undefined ? { company: contact.company } : {}),
      };
      if (existing) {
        existing.role = next.role; // pinned to 'landlord' for the owning landlord
        existing.primaryVoice = next.primaryVoice;
        // Denormalized fields: update when supplied, preserve otherwise.
        if (contact.name !== undefined) existing.name = contact.name;
        if (contact.company !== undefined) existing.company = contact.company;
      } else {
        roster.push(next);
      }

      // EXACTLY-ONE-primaryVoice: when this contact is the primary, demote every
      // other. (When it isn't, leave any existing primary as-is — a roster may
      // legitimately have its primary on another row.)
      if (next.primaryVoice) {
        for (const c of roster) c.primaryVoice = c.contactId === contact.contactId;
      }

      // Keep the voice-routing field (primary_voice_contact — the contactId the
      // masked-call landlord leg dials, see routes/webhooks/voice.ts) consistent
      // with the roster's primaryVoice. Only rewrite it when there IS a primary
      // on the roster; never blank it here (a roster-less unit keeps routing to
      // the legacy landlordId fallback in the bridge).
      const primary = roster.find((c) => c.primaryVoice);
      const patch: Record<string, unknown> = { contacts: roster };
      if (primary !== undefined) patch['primary_voice_contact'] = primary.contactId;

      const updated = await this.update(unitId, patch);
      log.info(
        { unitId, contactId: contact.contactId, rosterSize: roster.length, primaryVoice: next.primaryVoice },
        'unit contact added',
      );
      return updated;
    },

    async removeContact(unitId, contactId) {
      const unit = await this.getById(unitId);
      if (!unit) {
        throw new ConditionalCheckFailedException({
          message: `unit ${unitId} not found`,
          $metadata: {},
        });
      }
      // The primary landlord (legacy landlordId) must remain in the roster —
      // reassign landlordId first (typed error → route 409).
      if (typeof unit.landlordId === 'string' && unit.landlordId === contactId) {
        throw new CannotRemovePrimaryLandlordError();
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
      const removedWasPrimaryVoice = target.primaryVoice;
      const next = roster.filter((c) => c.contactId !== contactId);

      const patch: Record<string, unknown> = { contacts: next };
      // When the removed contact was the ☎ primary, keep the roster flag and the
      // scalar `primary_voice_contact` in AGREEMENT (BE3/C3 FIX B) — a frontend
      // deriving "which is the ☎ primary" from either source must get the same
      // answer, and the scalar must never dangle at the removed contact.
      if (removedWasPrimaryVoice) {
        const landlordId = typeof unit.landlordId === 'string' ? unit.landlordId : '';
        if (landlordId.length > 0) {
          // Promote the landlord row to the ☎ primary (exactly one) and point
          // the scalar at it. The landlord can't be removed (guarded above), so
          // its row is still present in `next`.
          for (const c of next) c.primaryVoice = c.contactId === landlordId;
          patch['primary_voice_contact'] = landlordId;
        } else {
          // No landlord to fall back to: clear the scalar (never leave it
          // dangling at the removed contact) and leave the roster with no ☎
          // primary. null → UpdateExpression REMOVE (see update()).
          for (const c of next) c.primaryVoice = false;
          patch['primary_voice_contact'] = null;
        }
      }

      const updated = await this.update(unitId, patch);
      log.info(
        { unitId, contactId, rosterSize: next.length, removedPrimaryVoice: removedWasPrimaryVoice },
        'unit contact removed',
      );
      return updated;
    },

    async list(opts = {}) {
      // Paginated Scan — the no-filter fallback only (see the interface note on
      // why a Scan is acceptable at this scale, doc §5.1).
      const input: ScanCommandInput = {
        TableName: table,
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
  };
}

/** Re-export so callers needn't import ConditionalCheckFailedException separately. */
export { ConditionalCheckFailedException };
