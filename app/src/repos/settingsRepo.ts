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
import { isValidHhMm, isValidIanaTimezone } from '../lib/quietHours.js';
import { DEFAULT_MISSED_CALL_AUTOTEXT } from '../lib/smsCompliance.js';
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
  /**
   * LOAD-BEARING founder call-triage timing (M1.9b / CO2 §7.1): the <Pause>
   * (whole seconds) inserted BEFORE the founder-bridge <Dial> so the pre-ring
   * push lands on the founder's phone ~this-many seconds AHEAD of the cell
   * ringing. Founder-editable (CO2: founder-editable values live here, NOT
   * Parameter Store). Defaults to 2; a sane range is 0..10.
   */
  preRingPauseSeconds: number;
  /** Quiet hours (spec 2026-08-03): automated sends DEFER during this window. */
  quietHoursEnabled: boolean;
  /** "HH:MM" 24h local wall clock - window start (start-inclusive). */
  quietHoursStart: string;
  /** "HH:MM" 24h local wall clock - window end (end-exclusive). */
  quietHoursEnd: string;
  /** IANA org timezone - the FIRST server-side timezone; also used by the
   *  morning_of tour reminder. Per-recipient override rides the
   *  resolveQuietHoursTimezone seam (lib/quietHours.ts), not extra fields here. */
  timezone: string;
  /**
   * OPTIONAL — the housing-fair welcome SMS body; {firstName} is interpolated.
   * Unset → public.ts falls back to WELCOME_TEXT_TEMPLATE. There is no sensible
   * default welcome string HERE (the constant lives in public.ts), so this stays
   * absent by default and is projected only when actually stored.
   */
  welcomeText?: string;
}

/** CO2's copy — the defaults a fresh stack reads before any admin edit. */
export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  // A2P/CTIA (spec §5): the missed-call auto-text is a FIRST-CONTACT template, so
  // its default carries brand identity + opt-out language. Sourced from the
  // single source of truth (lib/smsCompliance.ts) — the CO2 helpful content is
  // preserved, with the identity prefix + "Reply STOP to opt out." added.
  missedCallAutoText: DEFAULT_MISSED_CALL_AUTOTEXT,
  missedCallAutoTextEnabled: true,
  quickReplies: ['Please text me', "I'll call you back soon"],
  preRingPauseSeconds: 2,
  // Quiet hours default ON (spec 2026-08-03): the safe posture is that a fresh
  // stack never sends an automated text at 4am. Turn the feature OFF with
  // quietHoursEnabled: false, never with a zero-length window.
  quietHoursEnabled: true,
  quietHoursStart: '21:00',
  quietHoursEnd: '08:00',
  timezone: 'America/New_York',
};

/** A settings patch. `welcomeText` may be `null` — an explicit CLEAR that issues a
 *  DynamoDB REMOVE so the attribute is deleted (getOrgSettings then projects no
 *  welcomeText and public.ts falls back to WELCOME_TEXT_TEMPLATE). Every other
 *  field keeps its OrgSettings type. */
export type OrgSettingsPatch = Partial<Omit<OrgSettings, 'welcomeText'>> & {
  welcomeText?: string | null;
};

export interface SettingsRepo {
  /** The org-settings item merged over DEFAULT_ORG_SETTINGS (defaults when absent). */
  getOrgSettings(): Promise<OrgSettings>;
  /**
   * Merge a partial patch onto the stored settings and return the result.
   * Field-level merge (a patch omitting a field leaves it untouched);
   * quickReplies is replaced wholesale when present (it's a list, not a map).
   * A `null`-valued field (today only welcomeText) is REMOVEd (cleared).
   */
  putOrgSettings(patch: OrgSettingsPatch): Promise<OrgSettings>;
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
      // LOAD-BEARING triage timing: an existing item without it (or a malformed
      // value) reads as the 2s default — the same defaulting posture as above.
      preRingPauseSeconds:
        typeof item?.['preRingPauseSeconds'] === 'number' &&
        Number.isInteger(item['preRingPauseSeconds']) &&
        (item['preRingPauseSeconds'] as number) >= 0
          ? (item['preRingPauseSeconds'] as number)
          : DEFAULT_ORG_SETTINGS.preRingPauseSeconds,
      // Quiet hours: same defensive posture - a malformed stored window (bad
      // HH:MM, unresolvable timezone) reads as the DEFAULT window, never as a
      // disabled gate, so garbage in the item can never license a 4am send.
      quietHoursEnabled:
        typeof item?.['quietHoursEnabled'] === 'boolean'
          ? (item['quietHoursEnabled'] as boolean)
          : DEFAULT_ORG_SETTINGS.quietHoursEnabled,
      quietHoursStart:
        typeof item?.['quietHoursStart'] === 'string' &&
        isValidHhMm(item['quietHoursStart'] as string)
          ? (item['quietHoursStart'] as string)
          : DEFAULT_ORG_SETTINGS.quietHoursStart,
      quietHoursEnd:
        typeof item?.['quietHoursEnd'] === 'string' && isValidHhMm(item['quietHoursEnd'] as string)
          ? (item['quietHoursEnd'] as string)
          : DEFAULT_ORG_SETTINGS.quietHoursEnd,
      timezone:
        typeof item?.['timezone'] === 'string' && isValidIanaTimezone(item['timezone'] as string)
          ? (item['timezone'] as string)
          : DEFAULT_ORG_SETTINGS.timezone,
      // welcomeText is OPTIONAL (no default): project it ONLY when a string is
      // actually stored — an unset value stays absent so public.ts falls back
      // to its WELCOME_TEXT_TEMPLATE constant.
      ...(typeof item?.['welcomeText'] === 'string' && {
        welcomeText: item['welcomeText'] as string,
      }),
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
      // Build a SET (and, for null-valued fields, REMOVE) update from only the
      // fields present in the patch — a merge, not a replace (an omitted field is
      // left as stored). An UpdateCommand (not a Put) so a partial patch never
      // blanks the other fields, and the item is created on first write (upsert
      // semantics, no condition). A `null` value (today only welcomeText) REMOVEs
      // the attribute so getOrgSettings no longer projects it (revert to default).
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
      if (sets.length === 0 && removes.length === 0) {
        // Nothing to write — return the current merged view.
        return this.getOrgSettings();
      }
      const clauses: string[] = [];
      if (sets.length > 0) clauses.push(`SET ${sets.join(', ')}`);
      if (removes.length > 0) clauses.push(`REMOVE ${removes.join(', ')}`);
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { settingId: ORG_SETTINGS_ID },
          UpdateExpression: clauses.join(' '),
          ExpressionAttributeNames: names,
          // ALL update expressions reference names; only SET clauses carry values.
          ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
          ReturnValues: 'ALL_NEW',
        }),
      );
      // Field names only (template copy is operator content, fine to omit; the
      // audit event records the actual change at the route).
      log.info({ fields: sets.length + removes.length }, 'org settings updated');
      return toOrgSettings(Attributes as Record<string, unknown> | undefined);
    },
  };
}
