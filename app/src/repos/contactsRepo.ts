// contacts repo — resolve a phone to a person (the hottest lookup in the
// system, doc §5), set messaging flags, and (M1.2) the conditional-create
// primitive auto-capture is built on. Items stay flexible documents; only
// keys/GSI attributes are contractual (lib/tables.ts).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
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
import type { RepoDeps } from './conversationsRepo.js';

/**
 * Messaging suppression flags (doc §7.1 error-class handling):
 * sms_opt_out — STOP/21610 suppression; sends are REFUSED.
 * sms_unreachable — 30005/30006 (invalid number / landline); prompt voice.
 */
export type ContactFlag = 'sms_opt_out' | 'sms_unreachable';

/**
 * Contact types (doc §5, plus `unknown` — 2026-06-12 deviation): auto-capture
 * NEVER records guessed identity as fact, so stubs are created as `unknown`
 * with status `needs_review`. On the byTypeStatus GSI, (type=unknown,
 * status=needs_review) IS the human triage queue, resolved by the M1.4/M1.5
 * review flows.
 */
export type ContactType = 'tenant' | 'landlord' | 'pm' | 'team_member' | 'unknown';

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

export interface ContactItem {
  contactId: string;
  type: ContactType;
  status?: string;
  /** E.164 (byPhone GSI) — the PRIMARY number (back-compat scalar). */
  phone?: string;
  /**
   * BE1/C1: all numbers this contact owns. When ABSENT, treat as
   * `[{ phone, primary: true }]` (the legacy scalar) — see contactPhones().
   * Never mutated on read; serialized via contactPhones() on read responses.
   */
  phones?: ContactPhone[];
  sms_opt_out?: boolean;
  sms_unreachable?: boolean;
  /** How the record came to exist (M1.2 auto-capture: 'inbound_sms'). */
  capture_source?: string;
  /** When auto-capture created the stub (ISO 8601). */
  captured_at?: string;
  created_at?: string;
  /**
   * Phone-pointer marker (BE1). A pointer item carries `phone_ref: true`,
   * `phone_ref_owner` (the real contactId), and the indexed scalar `phone`,
   * but NO type/status/housing_authority — so it is invisible to byTypeStatus /
   * byHousingAuthority (never in lists/triage) yet findable via byPhone. The
   * primary number has NO pointer (it resolves via the owner's own scalar).
   */
  phone_ref?: boolean;
  phone_ref_owner?: string;
  [key: string]: unknown;
}

/** contactId prefix for a phone-pointer item: `phoneref#<E.164>`. */
export const PHONE_REF_PREFIX = 'phoneref#';

/** The pointer item's primary key (contactId) for a given E.164 number. */
export function phoneRefId(phone: string): string {
  return `${PHONE_REF_PREFIX}${phone}`;
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
}

export interface ContactsRepo {
  /** Phone (E.164) → contact via the byPhone GSI; undefined when unknown. */
  findByPhone(phone: string): Promise<ContactItem | undefined>;
  getById(contactId: string): Promise<ContactItem | undefined>;
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
}

export function createContactsRepo(deps: RepoDeps = {}): ContactsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('contacts', deps.env);
  const log = deps.logger ?? defaultLogger;

  // --- BE1/C1 internal helpers (closures; NOT part of the public interface) -
  const getByIdImpl = async (contactId: string): Promise<ContactItem | undefined> => {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { contactId } }));
    return Item as ContactItem | undefined;
  };

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
  const seededPhones = (contact: ContactItem): ContactPhone[] => {
    if (Array.isArray(contact.phones) && contact.phones.length > 0) {
      return contact.phones.map((p) => ({ ...p }));
    }
    if (typeof contact.phone === 'string' && contact.phone.length > 0) {
      return [
        {
          phone: contact.phone,
          primary: true,
          ...(typeof contact.created_at === 'string' && { firstSeenAt: contact.created_at }),
          lastSeenAt: new Date().toISOString(),
        },
      ];
    }
    return [];
  };

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

    async getById(contactId) {
      return getByIdImpl(contactId);
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
      const input: QueryCommandInput = {
        TableName: table,
        IndexName: 'byTypeStatus',
        KeyConditionExpression: keyExpr,
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
      // ONE Query on byHousingAuthority (hash = housing_authority). Sparse +
      // tenant-only by data convention — only tenant contacts carry the
      // attribute. Pagination via the raw LastEvaluatedKey (route opaque-cursors
      // it). `status`/`type` are not key attrs here, so no expression aliasing.
      const input: QueryCommandInput = {
        TableName: table,
        IndexName: 'byHousingAuthority',
        KeyConditionExpression: 'housing_authority = :ha',
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

    async update(contactId, patch) {
      // SET-only merge: each supplied field is written; omitted fields are
      // untouched (no-overwrite of a name a prior triage set). Names are
      // expression-aliased so reserved words (`status`, `type`) are legal.
      const sets: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      let i = 0;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        const nameKey = `#k${i}`;
        const valueKey = `:v${i}`;
        names[nameKey] = key;
        values[valueKey] = value;
        sets.push(`${nameKey} = ${valueKey}`);
        i += 1;
      }
      if (sets.length === 0) {
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
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { contactId },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(contactId)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ contactId, fields: Object.keys(values).length }, 'contact updated');
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
      const entry: ContactPhone = {
        phone,
        primary: false,
        firstSeenAt: now,
        lastSeenAt: now,
        ...(label !== undefined && { label }),
      };
      const next = [...phones, entry];
      const updated = await persistPhones(contactId, next);
      // Non-primary number → make it resolvable via a pointer.
      await putPointer(phone, contactId);
      log.info({ contactId, phoneCount: next.length }, 'contact phone added');
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

      let scalarSwap: string | undefined;
      const oldPrimary = phones.find((p) => p.primary && p.phone !== phone);
      if (primary === true && !target.primary) {
        for (const p of phones) p.primary = p.phone === phone;
        scalarSwap = phone;
      }

      const updated = await persistPhones(contactId, phones, scalarSwap);

      // Reconcile pointers AFTER the item write (so a crash leaves a recoverable
      // state: the source of truth is phones[]/scalar, pointers self-heal on a
      // retried setPhone). The new primary loses its pointer; the demoted old
      // primary gains one.
      if (scalarSwap !== undefined) {
        await deletePointer(phone);
        if (oldPrimary) await putPointer(oldPrimary.phone, contactId);
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
  };
}
