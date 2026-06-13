// settings repo (M1.4 — DB-backed, founder-editable in-app). Stores the
// founder-editable templates Change Order 2 introduced: the missed-call
// auto-text and the missed-call quick-reply buttons (CO2 §7.1 / doc §7.1
// "Call triage at volume").
//
// NOT in the doc §5 9-table model — a deliberate deviation (README row
// 2026-06-12): CO2's editable templates need a DB home, and Parameter Store
// is the WRONG home (it's Terraform/operator-managed, not in-app editable).
// The `settings` table (lib/tables.ts) is that home. Singleton today: one item
// keyed `org`; PK `settingId` keeps the door open to per-user rows later.
//
// CONSUMED in M1.9 (the voice/call-triage milestone): M1.4 only STORES and
// EDITS these values — nothing reads them to send a text yet.
//
// Item is a flexible document; only the key (settingId) is contractual.
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

/** The singleton org-settings item id (per-user rows would use other ids later). */
export const ORG_SETTINGS_ID = 'org';

/** Audit entityKey for the org-settings item (auditRepo `<table>#<id>` convention). */
export const ORG_SETTINGS_ENTITY_KEY = `settings#${ORG_SETTINGS_ID}`;

/**
 * The founder-editable settings (CO2). Defaults are CO2's copy, applied by
 * getOrgSettings() when no item exists yet (a fresh stack reads sane values
 * without an admin first having to PUT them).
 */
export interface OrgSettings {
  /** The zero-tap missed-call auto-text body (CO2 zero-tap default). */
  missedCallAutoText: string;
  /** Whether the auto-text fires at all (CO2: ON by default). */
  missedCallAutoTextEnabled: boolean;
  /** The missed-call quick-reply buttons / canned-sheet options (CO2). */
  quickReplies: string[];
}

/** CO2's copy — the defaults a fresh stack reads before any admin edit. */
export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  missedCallAutoText: "Sorry I missed you — I'll call back soon; you can also text me here.",
  missedCallAutoTextEnabled: true,
  quickReplies: ['Please text me', "I'll call you back soon"],
};

export interface SettingsRepo {
  /** The org-settings item merged over DEFAULT_ORG_SETTINGS (defaults when absent). */
  getOrgSettings(): Promise<OrgSettings>;
  /**
   * Merge a partial patch onto the stored settings and return the result.
   * Field-level merge (a patch omitting a field leaves it untouched);
   * quickReplies is replaced wholesale when present (it's a list, not a map).
   */
  putOrgSettings(patch: Partial<OrgSettings>): Promise<OrgSettings>;
}

export function createSettingsRepo(deps: RepoDeps = {}): SettingsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('settings', deps.env);
  const log = deps.logger ?? defaultLogger;

  /** Project a stored item (or nothing) onto the typed shape, defaults filling gaps. */
  function toOrgSettings(item: Record<string, unknown> | undefined): OrgSettings {
    return {
      missedCallAutoText:
        typeof item?.['missedCallAutoText'] === 'string'
          ? (item['missedCallAutoText'] as string)
          : DEFAULT_ORG_SETTINGS.missedCallAutoText,
      missedCallAutoTextEnabled:
        typeof item?.['missedCallAutoTextEnabled'] === 'boolean'
          ? (item['missedCallAutoTextEnabled'] as boolean)
          : DEFAULT_ORG_SETTINGS.missedCallAutoTextEnabled,
      quickReplies: Array.isArray(item?.['quickReplies'])
        ? (item['quickReplies'] as string[])
        : DEFAULT_ORG_SETTINGS.quickReplies,
    };
  }

  return {
    async getOrgSettings() {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { settingId: ORG_SETTINGS_ID } }),
      );
      return toOrgSettings(Item as Record<string, unknown> | undefined);
    },

    async putOrgSettings(patch) {
      // Build a SET update from only the fields present in the patch — a merge,
      // not a replace (an omitted field is left as stored). An UpdateCommand
      // (not a Put) so a partial patch never blanks the other fields, and the
      // item is created on first write (upsert semantics, no condition).
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
        // Nothing to write — return the current merged view.
        return this.getOrgSettings();
      }
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { settingId: ORG_SETTINGS_ID },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      // Field names only (template copy is operator content, fine to omit; the
      // audit event records the actual change at the route).
      log.info({ fields: Object.keys(values).length }, 'org settings updated');
      return toOrgSettings(Attributes as Record<string, unknown> | undefined);
    },
  };
}
