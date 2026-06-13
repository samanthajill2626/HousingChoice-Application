// contacts repo — resolve a phone to a person (the hottest lookup in the
// system, doc §5), set messaging flags, and (M1.2) the conditional-create
// primitive auto-capture is built on. Items stay flexible documents; only
// keys/GSI attributes are contractual (lib/tables.ts).
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

export interface ContactItem {
  contactId: string;
  type: ContactType;
  status?: string;
  /** E.164 (byPhone GSI). */
  phone?: string;
  sms_opt_out?: boolean;
  sms_unreachable?: boolean;
  /** How the record came to exist (M1.2 auto-capture: 'inbound_sms'). */
  capture_source?: string;
  /** When auto-capture created the stub (ISO 8601). */
  captured_at?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface ContactsRepo {
  /** Phone (E.164) → contact via the byPhone GSI; undefined when unknown. */
  findByPhone(phone: string): Promise<ContactItem | undefined>;
  getById(contactId: string): Promise<ContactItem | undefined>;
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
}

export function createContactsRepo(deps: RepoDeps = {}): ContactsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('contacts', deps.env);
  const log = deps.logger ?? defaultLogger;

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
      return (Items as ContactItem[] | undefined)?.[0];
    },

    async getById(contactId) {
      const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { contactId } }));
      return Item as ContactItem | undefined;
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
  };
}
