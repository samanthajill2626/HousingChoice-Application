// Contact vocabulary repo (Task 4): one singleton item in the `settings` table
// (id `contact-vocabulary`) that accumulates free-text tokens for auto-suggest:
// roles, relationship roles, and custom-field labels. Uses DynamoDB String Sets
// (ADD UpdateExpression) so every write is a non-destructive union — concurrent
// creates never clobber each other.
//
// The write-path calls add() after a successful POST/PATCH; it is best-effort
// (catch-and-log) and NEVER fails the response.
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

/** The three vocabulary groups stored on the singleton item. */
export interface ContactVocabulary {
  roles: string[];
  relationshipRoles: string[];
  fieldLabels: string[];
}

/** The singleton settingId used to key the vocabulary item. */
const VOCAB_ID = 'contact-vocabulary';

/** Groups whose token arrays may be passed to add(). */
type VocabGroup = 'roles' | 'relationshipRoles' | 'fieldLabels';

export interface ContactVocabularyRepo {
  /**
   * Union-merge tokens into the stored vocabulary. Only groups with non-empty
   * token lists are written (DynamoDB rejects empty string sets). A no-op when
   * all groups are empty.
   */
  add(tokens: Partial<Record<VocabGroup, string[]>>): Promise<void>;
  /**
   * Read the stored vocabulary. Missing item or absent attributes return [].
   * Each group is a sorted, deduped array.
   */
  get(): Promise<ContactVocabulary>;
}

/** Convert a DynamoDB string-set attribute (a JS Set after unmarshalling) or
 * an array to a sorted, deduped string array. Missing → []. */
function toSortedArray(v: unknown): string[] {
  if (v instanceof Set) {
    return [...v].filter((x): x is string => typeof x === 'string').sort();
  }
  if (Array.isArray(v)) {
    return [...new Set(v.filter((x): x is string => typeof x === 'string'))].sort();
  }
  return [];
}

export function createContactVocabularyRepo(deps: RepoDeps = {}): ContactVocabularyRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('settings', deps.env);
  const log = deps.logger ?? defaultLogger;

  return {
    async add(tokens) {
      // Build the ADD expression dynamically from only the non-empty groups.
      // DynamoDB rejects an ADD with an empty string set — guard each group.
      const addClauses: string[] = [];
      const values: Record<string, unknown> = {};

      const groups: [VocabGroup, string][] = [
        ['roles', ':roles'],
        ['relationshipRoles', ':rr'],
        ['fieldLabels', ':fl'],
      ];

      for (const [group, placeholder] of groups) {
        const raw = tokens[group];
        if (!Array.isArray(raw) || raw.length === 0) continue;
        const deduped = [...new Set(raw.filter((t) => typeof t === 'string' && t.length > 0))];
        if (deduped.length === 0) continue;
        addClauses.push(`${group} ${placeholder}`);
        values[placeholder] = new Set(deduped);
      }

      if (addClauses.length === 0) {
        // Nothing to write — avoid an invalid empty-SET call.
        return;
      }

      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { settingId: VOCAB_ID },
          UpdateExpression: `ADD ${addClauses.join(', ')}`,
          ExpressionAttributeValues: values,
        }),
      );
      log.info({ groups: addClauses.map((c) => c.split(' ')[0]) }, 'contact vocabulary updated');
    },

    async get() {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { settingId: VOCAB_ID } }),
      );
      const item = Item as Record<string, unknown> | undefined;
      return {
        roles: toSortedArray(item?.['roles']),
        relationshipRoles: toSortedArray(item?.['relationshipRoles']),
        fieldLabels: toSortedArray(item?.['fieldLabels']),
      };
    },
  };
}
