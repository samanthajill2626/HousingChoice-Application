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
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { isValidHhMm, isValidIanaTimezone } from '../lib/quietHours.js';
import { FOUNDER_MISSED_CALL_AUTOTEXT } from '../lib/smsCompliance.js';
import {
  GroupFingerprintCorruptError,
  type GroupFingerprintClaim,
} from '../services/groupIdentityFingerprint.js';
import type { RepoDeps } from './conversationsRepo.js';

/** The singleton org-settings item id (per-user rows would use other ids later). */
export const ORG_SETTINGS_ID = 'org';

/** Audit entityKey for the org-settings item (auditRepo `<table>#<id>` convention). */
export const ORG_SETTINGS_ENTITY_KEY = `settings#${ORG_SETTINGS_ID}`;

/**
 * Settings item holding the group-identity exclusion fingerprint (native group
 * texting, spec 4.1). NOTE the underscores: the two older records use hyphens
 * (`org`, `contact-vocabulary`); this id is the one adjudicated in the mission
 * worklist and is shared with the other group records, so it is kept verbatim.
 */
export const GROUP_IDENTITY_FINGERPRINT_ID = 'group_identity_fingerprint';

/**
 * Liveness records for the group-texting cross-check (spec 8.2). Both hold ONE
 * ISO instant and nothing else:
 *  - `group_railed_inbound_last_at` - the newest classic-webhook inbound filed
 *    onto a RAILED group thread (written by detection, T3.3);
 *  - `group_crosscheck_last_event_at` - the newest carrier-sourced Conversations
 *    event the cross-check endpoint accepted (written by S6).
 * The daily sweep WARNs when the first advanced while the second did not, which
 * is what "the monitor is dead" looks like from the outside.
 */
export const GROUP_RAILED_INBOUND_LAST_AT_ID = 'group_railed_inbound_last_at';
export const GROUP_CROSSCHECK_LAST_EVENT_AT_ID = 'group_crosscheck_last_event_at';

/** The two liveness record ids - a closed union, NOT a generic named-record API. */
export type GroupTimestampRecordId =
  | typeof GROUP_RAILED_INBOUND_LAST_AT_ID
  | typeof GROUP_CROSSCHECK_LAST_EVENT_AT_ID;

/**
 * CADENCE records for the guardrail duties (T6.3). Each holds the instant its
 * duty last ran, and is CLAIMED conditionally so a duty runs once per elapsed
 * period no matter how many pollers are looking at it.
 *
 * These exist because hermetic e2e lanes spawn a REAL worker process alongside
 * the app (worklist A16): the worker polls on its shared interval against the same lane data
 * an e2e spec drives through a `__dev` tick, so the period claim is what stops
 * one from stealing the other's work - and the tick's `force` flag is what lets
 * a spec bypass a period the worker just claimed.
 */
export const GROUP_CROSSCHECK_SWEEP_LAST_RUN_AT_ID = 'group_crosscheck_sweep_last_run_at';
export const GROUP_SEND_STALENESS_LAST_RUN_AT_ID = 'group_send_staleness_last_run_at';
export const GROUP_CHANNEL_QUIET_LAST_RUN_AT_ID = 'group_channel_quiet_last_run_at';
export const GROUP_INBOUND_HEARTBEAT_LAST_RUN_AT_ID = 'group_inbound_heartbeat_last_run_at';

/**
 * The abandoned-journal sweep's cadence record (log-hygiene spec 9.3). It rides
 * the SAME claim mechanism as the four ids above despite not carrying their
 * GROUP_ naming: the mechanism is generic - one conditional write per elapsed
 * period - and the names are historical, because the first four duties on it
 * happened to be group-texting duties. Do not read the prefix as a scope.
 */
export const JOURNAL_SWEEP_LAST_RUN_AT_ID = 'journal_sweep_last_run_at';

/** The five cadence record ids - closed, like the liveness union above. */
export type GroupPeriodRecordId =
  | typeof GROUP_CROSSCHECK_SWEEP_LAST_RUN_AT_ID
  | typeof GROUP_SEND_STALENESS_LAST_RUN_AT_ID
  | typeof GROUP_CHANNEL_QUIET_LAST_RUN_AT_ID
  | typeof GROUP_INBOUND_HEARTBEAT_LAST_RUN_AT_ID
  | typeof JOURNAL_SWEEP_LAST_RUN_AT_ID;

/**
 * The abandoned-journal sweep's Scan cursor (log-hygiene spec 9.2). Its own
 * record, holding ONE `cursor` string - the JSON-encoded LastEvaluatedKey the
 * last run stopped on - so the next run RESUMES instead of restarting from the
 * table's internal ordering and permanently orphaning whatever hashes past the
 * page cap. Absent = start from the top of the table (also what a run that
 * exhausted the table writes: the cycle wraps).
 *
 * Separate from the cadence record on purpose: the cadence stamp is written by
 * a conditional claim that must not carry unrelated payload.
 */
export const JOURNAL_SWEEP_SCAN_CURSOR_ID = 'journal_sweep_scan_cursor';

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
  // FOUNDER DECISION 2026-08-18: the missed-call auto-text no longer carries the
  // "Reply STOP to opt out." line. Rationale + attribution live on
  // FOUNDER_MISSED_CALL_AUTOTEXT (lib/smsCompliance.ts); engineering advised
  // against it and was overruled, which is recorded there rather than repeated.
  //
  // THIS is the value that actually reaches a recipient - not the catalog
  // default. missedCallAutoText is a REQUIRED string, so settingsToOverrides()
  // always emits an override for `missed_call.autotext` and the catalog default
  // is never consulted. The two are pointed at the same constant deliberately;
  // change both or neither.
  //
  // An env whose stored settings item ALREADY carries a missedCallAutoText keeps
  // that stored value - this default only covers a stack that has never saved
  // one. Changing it there is a Settings > Templates edit, not a deploy.
  missedCallAutoText: FOUNDER_MISSED_CALL_AUTOTEXT,
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
  /**
   * Claim the group-identity exclusion fingerprint (native group texting).
   *
   * FIRST-WRITE RACE: this is a CONDITIONAL create
   * (`attribute_not_exists(settingId)`), NOT putOrgSettings' unconditional
   * upsert - two instances booting together must not both "win" and leave the
   * second one's list silently blessed. The conditional loser re-reads and
   * COMPARES: same hash -> `matched`, different -> `mismatch` (the caller then
   * refuses to start). Never throws on a lost race; only on a corrupt record.
   */
  claimGroupIdentityFingerprint(hash: string): Promise<GroupFingerprintClaim>;
  /**
   * Advance a group liveness record (spec 8.2). MONOTONIC: an older instant
   * losing a race is a no-op, never a rewind - the sweep compares two
   * high-water marks, so moving one backwards would manufacture a false alarm.
   */
  putGroupTimestamp(id: GroupTimestampRecordId, at: string): Promise<void>;
  /** The stored instant for a group liveness record, or undefined. */
  getGroupTimestamp(id: GroupTimestampRecordId): Promise<string | undefined>;
  /**
   * CLAIM one cadence period for a guardrail duty (T6.3). Conditional on the
   * stored instant being absent or no later than `notBefore` - so with
   * `notBefore = now - period` exactly one caller per elapsed period wins, and
   * every other poll in that window is a cheap no-op.
   *
   * `false` means someone else already claimed this period. A `__dev` tick
   * passes `notBefore = now` to bypass the gate on purpose (worklist A16: the
   * hermetic worker polls the same record, so without the bypass a spec would
   * race it).
   */
  claimGroupPeriod(id: GroupPeriodRecordId, at: string, notBefore: string): Promise<boolean>;
  /**
   * The abandoned-journal sweep's stored Scan cursor, or undefined when no run
   * has stored one (or the last run exhausted the table). See
   * JOURNAL_SWEEP_SCAN_CURSOR_ID.
   */
  getJournalSweepCursor(): Promise<string | undefined>;
  /**
   * Persist the sweep's Scan cursor. `undefined` CLEARS it (a REMOVE), which is
   * what a run that reached the end of the table writes so the next cycle wraps
   * to the top. Unconditional: one daily writer, and the last write is the
   * truth.
   */
  putJournalSweepCursor(cursor: string | undefined): Promise<void>;
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

    async claimGroupIdentityFingerprint(hash) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: { settingId: GROUP_IDENTITY_FINGERPRINT_ID, hash, at: new Date().toISOString() },
            ConditionExpression: 'attribute_not_exists(settingId)',
          }),
        );
        log.info({ settingId: GROUP_IDENTITY_FINGERPRINT_ID }, 'group identity fingerprint written');
        return { outcome: 'created' };
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Someone (an earlier boot, or the instance next to us) already holds it.
        // Re-read and compare - the house "loser re-reads" idiom.
        const { Item } = await doc.send(
          new GetCommand({
            TableName: table,
            Key: { settingId: GROUP_IDENTITY_FINGERPRINT_ID },
          }),
        );
        const stored = (Item as { hash?: unknown } | undefined)?.hash;
        if (typeof stored !== 'string' || stored.length === 0) {
          // TYPED, so the boot guard does not retry it three times and then
          // report a CORRUPT record as an availability problem (fix wave 2,
          // adversarial 33). The record is right there; reading it again will
          // return the same broken row every time.
          throw new GroupFingerprintCorruptError(
            'group identity fingerprint exists per the conditional put but carries no hash',
          );
        }
        return stored === hash ? { outcome: 'matched' } : { outcome: 'mismatch', storedHash: stored };
      }
    },

    async putGroupTimestamp(id, at) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { settingId: id },
            UpdateExpression: 'SET recorded_at = :at',
            // Monotonic: only ever move the high-water mark FORWARD.
            ConditionExpression: 'attribute_not_exists(recorded_at) OR recorded_at < :at',
            ExpressionAttributeValues: { ':at': at },
          }),
        );
      } catch (err) {
        // A newer instant is already stored - the expected outcome under
        // concurrency, not a failure.
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      }
    },

    async claimGroupPeriod(id, at, notBefore) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { settingId: id },
            UpdateExpression: 'SET recorded_at = :at',
            ConditionExpression: 'attribute_not_exists(recorded_at) OR recorded_at <= :notBefore',
            ExpressionAttributeValues: { ':at': at, ':notBefore': notBefore },
          }),
        );
        return true;
      } catch (err) {
        // The period is already claimed - the expected outcome on most polls.
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },

    async getGroupTimestamp(id) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { settingId: id } }),
      );
      const at = (Item as { recorded_at?: unknown } | undefined)?.recorded_at;
      return typeof at === 'string' && at.length > 0 ? at : undefined;
    },

    async putJournalSweepCursor(cursor) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { settingId: JOURNAL_SWEEP_SCAN_CURSOR_ID },
          // `cursor` is a DynamoDB RESERVED WORD - it has to be aliased in the
          // expression even though the stored attribute name is plain `cursor`.
          ExpressionAttributeNames: { '#cursor': 'cursor' },
          // REMOVE on an absent attribute (or an absent item) is a no-op, so
          // clearing an already-clear cursor never throws.
          ...(cursor === undefined
            ? { UpdateExpression: 'REMOVE #cursor' }
            : {
                UpdateExpression: 'SET #cursor = :cursor',
                ExpressionAttributeValues: { ':cursor': cursor },
              }),
        }),
      );
    },

    async getJournalSweepCursor() {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { settingId: JOURNAL_SWEEP_SCAN_CURSOR_ID } }),
      );
      // Same defensive projection as getGroupTimestamp: a malformed stored value
      // reads as "no cursor", i.e. a full rescan, never as a corrupt
      // ExclusiveStartKey the Scan would reject on every run.
      const cursor = (Item as { cursor?: unknown } | undefined)?.cursor;
      if (typeof cursor !== 'string' || cursor.length === 0) return undefined;
      // The type check alone did NOT keep that promise: the stored value is a
      // JSON-encoded ExclusiveStartKey that the Scan caller parses
      // (suggestionResolutionRepo.listActiveResolutionRows), so any non-empty
      // string passed this guard and then threw inside the Scan on page 1 of
      // every run, forever. Parse-check it here so an unparseable value really
      // does degrade to "no cursor" - a full rescan - as stated above.
      try {
        JSON.parse(cursor);
      } catch {
        return undefined;
      }
      return cursor;
    },
  };
}
