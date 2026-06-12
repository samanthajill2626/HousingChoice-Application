// contacts repo — MINIMAL for M1.1: resolve a phone to a person (the hottest
// lookup in the system, doc §5) and set messaging flags. Full auto-capture
// ("First Last - N Bed" phone saving etc.) is M1.2 — deliberately not here.
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

export interface ContactItem {
  contactId: string;
  type: string;
  status?: string;
  /** E.164 (byPhone GSI). */
  phone?: string;
  sms_opt_out?: boolean;
  sms_unreachable?: boolean;
  [key: string]: unknown;
}

export interface ContactsRepo {
  /** Phone (E.164) → contact via the byPhone GSI; undefined when unknown. */
  findByPhone(phone: string): Promise<ContactItem | undefined>;
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
