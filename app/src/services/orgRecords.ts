// Record access for the organization lists (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D3, D10, D11; plan sections 3.4 and 3.4b): which records USE an entry,
// every stored value that is NOT on the list, the records holding one value,
// and (Task 3.5) the per-field rewrite pass behind rename, merge and every
// "Not on the list" action. Shared by the /api/organizations routes, the
// org.rewrite job (jobs/orgRewrite.ts) and the cleanup script.
//
// READS. Every contact of every type, active AND deleted, page by page through
// contactsRepo.listByType: the contacts table also holds phone/email POINTER
// rows (no type, so never on byTypeStatus) and no repo scans it; the
// byTypeStatus GSI projects every attribute. Every unit, active AND deleted,
// through unitsRepo.list (a Scan). Each list is paged until its cursor runs
// out - a page can come back short or EMPTY with a cursor (the deleted filter
// applies after Limit), so the loops follow the cursor, never the item count.
//
// USES (D3) count a field of the entry's kind holding the exact name.
// Branch B: a contact's organization holding an entry of EITHER kind is a use
// in its own column. The distinct-record totals decide Delete (inUse) and
// a kind change (kindLocked, which organization never joins - spec D17). A
// unit that stores only the legacy `jurisdiction` holds no list: it is neither
// a use nor a "Not on the list" row (the cleanup script backfills it).
//
// THE REWRITE PASS. One call is ONE pass over ONE field (`def.field`); the
// org.rewrite job runs one pass per member of `lastRewrite.fields` (fixed when
// the rewrite started - recordFieldsForKind for a rename/merge, organization
// last). A record's
// value is rewritten when its NORMALIZED text is a from-text (D11) - or, for a
// value action whose from-text normalizes to '' (a stored "-"), when it is
// that EXACT text - through contactsRepo.rewriteOrgFields /
// unitsRepo.rewriteAcceptedAuthorities - each conditional on the record still
// holding exactly what was read, so a record changed meanwhile (or a stale GSI
// page) is counted `skipped`, never overwritten. Unit writes never stamp
// updated_at. A rename/merge/use pass leaves a value already equal to
// `toName` alone. Every field a write changes gets its own audit event (Move
// and Split write two). The heartbeat runs at most every 20 s, counted from the
// start of THIS pass, and is checked BEFORE every record visited - so a record
// after a stall inside the pass is never written unchecked (code review
// R3-BE-1); a stall before the pass starts is not seen
// (docs/issues/org-rewrite-pass-start-pacing-gap.md). When it answers false
// the lock is no longer the caller's, and the pass writes nothing more
// (OrgRewriteLockLostError).
// PRECONDITION for callers: no from-text may normalize equal to the exact
// NAME of an entry of the field's kind other than `toName` - the pass has no
// list to test "on the list" against, and such a value would be rewritten too
// (services/orgRewrite.ts refuses those definitions - and re-checks one whose
// lock lapsed before the job runs it - and OrgNamesService.add refuses a new
// name that is a running rewrite's from-text; the cleanup script must keep to
// the same rule).
import { formatAddress } from '../lib/address.js';
import { contactDisplayName } from '../lib/contactName.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  isOnListFor,
  KINDS_FOR_FIELD,
  normalizeOrgText,
  resolveOrgText,
  type OrgEntry,
  type OrgKind,
  type OrgRef,
  type OrgResolution,
} from '../lib/orgNames.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  createContactsRepo,
  isDeleted as isContactDeleted,
  type ContactItem,
  type ContactType,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import type { OrgRecordField, OrgRewriteAction, OrgRewriteState } from '../repos/orgListRepo.js';
import {
  createUnitsRepo,
  isDeleted as isUnitDeleted,
  type UnitItem,
  type UnitsRepo,
} from '../repos/unitsRepo.js';
import { toOrgRef } from './orgNames.js';

export type HolderRecord =
  | { kind: 'contact'; contactId: string; name: string | null; type: string; deleted: boolean }
  | { kind: 'unit'; unitId: string; address: string | null; deleted: boolean };

export interface NotOnListResolution {
  status: OrgResolution['status'];
  match?: OrgRef;          // status 'match': the value resolves to one entry but is not its exact name
  candidates?: OrgRef[];   // status 'ambiguous'
  otherKind?: OrgRef[];    // status 'other_kind'
  compound?: OrgRef[][];   // status 'compound'
  close?: OrgRef[];        // status 'unknown'
}

export interface NotOnListRow {
  field: OrgRecordField;
  value: string;
  count: number;          // active records
  deletedCount: number;   // deleted records
  resolution: NotOnListResolution;
}

/** A count of DISTINCT records, active and deleted (spec D10; R2-F1). */
export interface OrgUseTotal {
  active: number;
  deleted: number;
}

/**
 * One entry's uses (plan 3.6). The columns are for DISPLAY: each counts the
 * active records holding the exact name in its fields (a field of the
 * entry's kind; `organization` - a contact's organization, any type, either
 * kind), so one record can count in two columns; `deleted` counts deleted
 * holders the same way, once per column hit - kept on the wire for
 * compatibility only: the dashboard shows the distinct `inUse.deleted`
 * (plan review R1 ruling A10). The two totals count DISTINCT
 * records and are what the refusals read: `inUse` - any field, organization
 * included (Delete); `kindLocked` - a field of the entry's kind only, so an
 * organization holder never blocks a kind change (spec D17).
 */
export interface OrgUsageCounts {
  tenants: number;
  otherContacts: number;
  properties: number;
  organization: number;
  deleted: number;
  inUse: OrgUseTotal;
  kindLocked: OrgUseTotal;
}

export interface OrgUsage {
  [orgId: string]: OrgUsageCounts;
}

export interface OrgRecordsService {
  usage(entries: readonly OrgEntry[]): Promise<OrgUsage>;
  notOnList(entries: readonly OrgEntry[]): Promise<NotOnListRow[]>;
  holders(field: OrgRecordField, value: string): Promise<HolderRecord[]>;
  /** Rewrite every record (all contact types and units, active and deleted)
   *  per the definition; conditional per record; audits each field written
   *  with `auditType` ('org_name_rewrite' for the job, 'org_name_cleanup' for
   *  the script); calls `heartbeat` before a record, at most every 20 s, and
   *  stops with OrgRewriteLockLostError when it answers false; returns counts.
   *  ONE pass over `def.field`, which is required (see the header). */
  rewrite(
    def: OrgRewriteState,
    opts: { auditType: 'org_name_rewrite' | 'org_name_cleanup'; actor?: string; heartbeat?: () => Promise<boolean> },
  ): Promise<Record<string, number>>;
}

/** Plan 3.4b: every dep optional, defaulting to the real repo. */
export interface OrgRecordsDeps {
  contactsRepo?: ContactsRepo;
  unitsRepo?: UnitsRepo;
  auditRepo?: AuditRepo;
  logger?: Logger;
}

/**
 * Every ContactType as the keys of a Record, so a type added later that is not
 * listed here is a COMPILE error - never a silently unread partition.
 */
const CONTACT_TYPE_KEYS: Record<ContactType, true> = {
  tenant: true,
  landlord: true,
  partner: true,
  team_member: true,
  unknown: true,
};
const CONTACT_TYPES = Object.keys(CONTACT_TYPE_KEYS) as ContactType[];

/** "Not on the list" rows sort by field in this order, then most records first, then value. */
const FIELD_ORDER: Record<OrgRecordField, number> = { housingAuthority: 0, agency: 1, accepted_authorities: 2, organization: 3 };

function resolutionOf(entries: readonly OrgEntry[], field: OrgRecordField, value: string): NotOnListResolution {
  const r = resolveOrgText(entries, value, KINDS_FOR_FIELD[field]);
  switch (r.status) {
    case 'match':
      return { status: 'match', match: toOrgRef(r.entry) };
    case 'ambiguous':
      return { status: 'ambiguous', candidates: r.candidates.map(toOrgRef) };
    case 'other_kind':
      return { status: 'other_kind', otherKind: r.entries.map(toOrgRef) };
    case 'compound':
      return { status: 'compound', compound: r.spans.map((span) => span.map(toOrgRef)) };
    case 'unknown':
      return { status: 'unknown', close: r.close.map(toOrgRef) };
  }
}

/** The unit's STORED accepted_authorities list, or undefined when none is stored. */
function storedAuthorities(unit: UnitItem): unknown[] | undefined {
  const list: unknown = unit.accepted_authorities;
  return Array.isArray(list) ? list : undefined;
}

/** A pass heartbeats at most this often (plan 3.4). */
export const ORG_REWRITE_HEARTBEAT_MS = 20_000;

/** A unit audit's `from` / `to`: the WHOLE list joined with ', ' (planner ruling - strings only). */
function listText(members: readonly unknown[]): string {
  return members.filter((m): m is string => typeof m === 'string').join(', ');
}

/**
 * The record fields that hold an entry of each kind: one pass each. A
 * contact's organization accepts EITHER kind (spec D17), so a rename or
 * merge of either kind rewrites it too - always LAST: Run again and the
 * job's claim read the rewrite's kind from its first non-organization
 * field (services/orgRewrite.ts rewriteTargetKinds; R2-F2).
 */
export function recordFieldsForKind(kind: OrgKind): OrgRecordField[] {
  return kind === 'housing_authority'
    ? ['housingAuthority', 'accepted_authorities', 'organization']
    : ['agency', 'organization'];
}

/** A pass stopped part-way (a read or a write threw). `counts` are the writes that landed. */
export class OrgRewriteAbortedError extends Error {
  constructor(
    readonly counts: Record<string, number>,
    cause: unknown,
  ) {
    super(`org rewrite stopped: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'OrgRewriteAbortedError';
  }
}

/**
 * A pass stopped because its heartbeat answered that the lock is no longer the
 * caller's (spec D11: a newer rewrite took it over, a duplicate run already
 * finished it, or it lapsed - code review R2-BE-1 - or the caller's local
 * lease ran out while its heartbeats failed - R3-BE-1). Nothing was written
 * after that answer; `counts` are the writes that landed before it. The caller
 * must not finish() - the lock is not its own, or may not be.
 */
export class OrgRewriteLockLostError extends Error {
  constructor(readonly counts: Record<string, number>) {
    super('org rewrite stopped: the lock is no longer this run');
    this.name = 'OrgRewriteLockLostError';
  }
}

/** The plan-3.2 count keys, exactly. */
interface RewriteCounts {
  housingAuthority: number;
  agency: number;
  accepted_authorities: number;
  organization: number;
  /** The record changed between the read and the conditional write - left as it is. */
  skipped: number;
  /** Move / Split met a value already in the target field (spec D10). */
  conflicts: number;
}

/** Actions that may target a property list. */
const UNIT_ACTIONS: ReadonlySet<OrgRewriteAction> = new Set<OrgRewriteAction>(['rename', 'merge', 'use', 'clear']);
/** Actions that write the target name into the matched value's own field. */
const SAME_FIELD_ACTIONS: ReadonlySet<OrgRewriteAction> = new Set<OrgRewriteAction>(['rename', 'merge', 'use']);
/** The "Not on the list" value actions: their from-text is one stored value. */
const VALUE_ACTIONS: ReadonlySet<OrgRewriteAction> = new Set<OrgRewriteAction>([
  'use',
  'move_to_agency',
  'move_to_housing_authority',
  'split',
  'clear',
]);

/** The pass's field, or an Error naming what is wrong with the definition. */
function passField(def: OrgRewriteState): OrgRecordField {
  if (def.action === 'cleanup') throw new Error('a cleanup lock carries no rewrite definition');
  if (def.field === undefined) {
    throw new Error('a rewrite pass needs def.field (a rename or merge runs one pass per field of its kind)');
  }
  if (def.action !== 'clear' && (def.toName === undefined || def.toName === '')) {
    throw new Error(`a ${def.action} pass needs toName`);
  }
  if (def.action === 'split' && (def.agencyName === undefined || def.agencyName === '')) {
    throw new Error('a split pass needs agencyName');
  }
  if ((def.action === 'move_to_agency' || def.action === 'split') && def.field !== 'housingAuthority') {
    throw new Error(`${def.action} rewrites housingAuthority only`);
  }
  if (def.action === 'move_to_housing_authority' && def.field !== 'agency') {
    throw new Error('move_to_housing_authority rewrites agency only');
  }
  if (def.field === 'accepted_authorities' && !UNIT_ACTIONS.has(def.action)) {
    throw new Error(`${def.action} never rewrites a property list`);
  }
  return def.field;
}

/** One audit event: a field the write changes, from what to what ('' = absent or removed). */
interface FieldAudit {
  field: 'housingAuthority' | 'agency' | 'organization';
  from: string;
  to: string;
}

type ContactPlan =
  | {
      kind: 'write';
      expect: { housingAuthority?: string | null; agency?: string | null; organization?: string | null };
      next: { housingAuthority?: string | null; agency?: string; organization?: string | null };
      /** One event per field the write changes (plan 3.8): the matched field first. */
      audits: FieldAudit[];
      conflict: boolean;
    }
  | { kind: 'conflict' };

/**
 * One contact's write for `def` (spec D10/D11): what it must still hold, what
 * to write, what to audit, and whether it is a Move/Split conflict. `value` is
 * the matched text in `field`; the other field is read from `c` as the pass
 * saw it. An agency that already holds the SAME name is compatible, never a
 * conflict (plan 3.8): Move drops the now-redundant authority and counts it.
 * An organization value is only ever used, renamed, merged or cleared
 * (passField refuses Move and Split): SET the name, or REMOVE it (spec D17).
 */
function planContactRewrite(
  def: OrgRewriteState,
  field: 'housingAuthority' | 'agency' | 'organization',
  value: string,
  c: ContactItem,
): ContactPlan {
  const toName = def.toName ?? '';
  const rawAgency = c['agency'];
  const agency = typeof rawAgency === 'string' ? rawAgency : undefined;
  const rawHa = c['housingAuthority'];
  const housingAuthority = typeof rawHa === 'string' ? rawHa : undefined;
  const matched = (to: string): FieldAudit => ({ field, from: value, to });
  switch (def.action) {
    case 'clear':
      if (field === 'organization') {
        return { kind: 'write', expect: { organization: value }, next: { organization: null }, audits: [matched('')], conflict: false };
      }
      return field === 'housingAuthority'
        ? { kind: 'write', expect: { housingAuthority: value }, next: { housingAuthority: null }, audits: [matched('')], conflict: false }
        : { kind: 'write', expect: { agency: value }, next: { agency: '' }, audits: [matched('')], conflict: false };
    case 'move_to_agency':
      if (agency === undefined || agency === '') {
        return {
          kind: 'write',
          expect: { housingAuthority: value, agency: agency === undefined ? null : '' },
          next: { housingAuthority: null, agency: toName },
          audits: [matched(''), { field: 'agency', from: agency ?? '', to: toName }],
          conflict: false,
        };
      }
      if (agency === toName) {
        return {
          kind: 'write',
          expect: { housingAuthority: value, agency },
          next: { housingAuthority: null },
          audits: [matched('')],
          conflict: false,
        };
      }
      return { kind: 'conflict' };
    case 'move_to_housing_authority':
      if (housingAuthority === undefined) {
        return {
          kind: 'write',
          expect: { agency: value, housingAuthority: null },
          next: { housingAuthority: toName, agency: '' },
          audits: [matched(''), { field: 'housingAuthority', from: '', to: toName }],
          conflict: false,
        };
      }
      if (housingAuthority === toName) {
        return {
          kind: 'write',
          expect: { agency: value, housingAuthority },
          next: { agency: '' },
          audits: [matched('')],
          conflict: false,
        };
      }
      return { kind: 'conflict' };
    case 'split': {
      const agencyName = def.agencyName ?? '';
      if (agency === undefined || agency === '') {
        return {
          kind: 'write',
          expect: { housingAuthority: value, agency: agency === undefined ? null : '' },
          next: { housingAuthority: toName, agency: agencyName },
          audits: [matched(toName), { field: 'agency', from: agency ?? '', to: agencyName }],
          conflict: false,
        };
      }
      // The authority is still set; an agency that holds something else is kept and counted.
      return {
        kind: 'write',
        expect: { housingAuthority: value, agency },
        next: { housingAuthority: toName },
        audits: [matched(toName)],
        conflict: agency !== agencyName,
      };
    }
    default: // rename, merge, use
      if (field === 'organization') {
        return { kind: 'write', expect: { organization: value }, next: { organization: toName }, audits: [matched(toName)], conflict: false };
      }
      return field === 'housingAuthority'
        ? { kind: 'write', expect: { housingAuthority: value }, next: { housingAuthority: toName }, audits: [matched(toName)], conflict: false }
        : { kind: 'write', expect: { agency: value }, next: { agency: toName }, audits: [matched(toName)], conflict: false };
  }
}

export function createOrgRecordsService(deps: OrgRecordsDeps = {}): OrgRecordsService {
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const log = deps.logger ?? defaultLogger;

  /** Every contact of every type, active then deleted, following each cursor. */
  async function* everyContact(): AsyncGenerator<ContactItem> {
    for (const type of CONTACT_TYPES) {
      for (const deleted of [false, true]) {
        let cursor: Record<string, unknown> | undefined;
        do {
          const page = await contacts.listByType(type, {
            ...(deleted && { deleted: true }),
            ...(cursor !== undefined && { exclusiveStartKey: cursor }),
          });
          for (const item of page.items) {
            // Defensive: pointer rows carry no type, so the GSI never returns them.
            if (item.phone_ref === true || item.email_ref === true) continue;
            yield item;
          }
          cursor = page.lastEvaluatedKey;
        } while (cursor !== undefined);
      }
    }
  }

  /** Every unit, active then deleted, following each cursor. */
  async function* everyUnit(): AsyncGenerator<UnitItem> {
    for (const deleted of [false, true]) {
      let cursor: Record<string, unknown> | undefined;
      do {
        const page = await units.list({
          ...(deleted && { deleted: true }),
          ...(cursor !== undefined && { exclusiveStartKey: cursor }),
        });
        for (const item of page.items) yield item;
        cursor = page.lastEvaluatedKey;
      } while (cursor !== undefined);
    }
  }

  return {
    async usage(entries) {
      const out: OrgUsage = {};
      for (const e of entries) {
        out[e.orgId] = {
          tenants: 0,
          otherContacts: 0,
          properties: 0,
          organization: 0,
          deleted: 0,
          inUse: { active: 0, deleted: 0 },
          kindLocked: { active: 0, deleted: 0 },
        };
      }
      const haIds = new Map(entries.filter((e) => e.kind === 'housing_authority').map((e) => [e.name, e.orgId] as const));
      const agencyIds = new Map(entries.filter((e) => e.kind === 'agency').map((e) => [e.name, e.orgId] as const));
      // Names are unique across BOTH kinds (D4): one map serves the organization field.
      const anyIds = new Map(entries.map((e) => [e.name, e.orgId] as const));
      type Column = 'tenants' | 'otherContacts' | 'properties' | 'organization';
      /** One record's hits: a column per hit, and each DISTINCT entry once per total. */
      const tally = (
        hits: ReadonlyArray<{ orgId: string | undefined; column: Column; locksKind: boolean }>,
        deleted: boolean,
      ): void => {
        const used = new Set<OrgUsageCounts>();
        const locked = new Set<OrgUsageCounts>();
        for (const hit of hits) {
          const row = hit.orgId === undefined ? undefined : out[hit.orgId];
          if (row === undefined) continue;
          if (deleted) row.deleted += 1;
          else row[hit.column] += 1;
          used.add(row);
          if (hit.locksKind) locked.add(row);
        }
        const bump = (t: OrgUseTotal): void => {
          if (deleted) t.deleted += 1;
          else t.active += 1;
        };
        for (const row of used) bump(row.inUse);
        for (const row of locked) bump(row.kindLocked);
      };
      const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
      for await (const c of everyContact()) {
        const column = c.type === 'tenant' ? 'tenants' : 'otherContacts';
        const ha = text(c['housingAuthority']);
        const agency = text(c['agency']);
        const organization = text(c.organization);
        tally(
          [
            { orgId: ha === undefined ? undefined : haIds.get(ha), column, locksKind: true },
            { orgId: agency === undefined ? undefined : agencyIds.get(agency), column, locksKind: true },
            // Spec D17: the organization field accepts either kind - it never locks one.
            {
              orgId: organization === undefined ? undefined : anyIds.get(organization),
              column: 'organization',
              locksKind: false,
            },
          ],
          isContactDeleted(c),
        );
      }
      for await (const u of everyUnit()) {
        // One property is one use, however often its list repeats the name.
        const members = new Set((storedAuthorities(u) ?? []).filter((m): m is string => typeof m === 'string'));
        tally(
          [...members].map((m) => ({ orgId: haIds.get(m), column: 'properties' as const, locksKind: true })),
          isUnitDeleted(u),
        );
      }
      return out;
    },

    async notOnList(entries) {
      const rows = new Map<string, NotOnListRow>();
      const tally = (field: OrgRecordField, value: string, deleted: boolean): void => {
        const key = JSON.stringify([field, value]);
        let row = rows.get(key);
        if (row === undefined) {
          row = { field, value, count: 0, deletedCount: 0, resolution: resolutionOf(entries, field, value) };
          rows.set(key, row);
        }
        if (deleted) row.deletedCount += 1;
        else row.count += 1;
      };
      for await (const c of everyContact()) {
        const deleted = isContactDeleted(c);
        for (const field of ['housingAuthority', 'agency'] as const) {
          const value = c[field];
          // '' is a cleared agency, not a value (spec D5) - and so is text that
          // is only whitespace (pre-2026-07-14 data, before trimJsonBody): D5
          // treats it as a clear, the cleanup skips it, and no request could
          // name it (the body trim turns it into '').
          if (typeof value !== 'string' || value.trim() === '') continue;
          if (isOnListFor(entries, value, KINDS_FOR_FIELD[field])) continue;
          tally(field, value, deleted);
        }
      }
      for await (const u of everyUnit()) {
        const deleted = isUnitDeleted(u);
        const members = new Set(
          (storedAuthorities(u) ?? []).filter((m): m is string => typeof m === 'string' && m.trim() !== ''),
        );
        for (const m of members) {
          if (isOnListFor(entries, m, KINDS_FOR_FIELD.accepted_authorities)) continue;
          tally('accepted_authorities', m, deleted);
        }
      }
      return [...rows.values()].sort(
        (a, b) =>
          FIELD_ORDER[a.field] - FIELD_ORDER[b.field] ||
          b.count + b.deletedCount - (a.count + a.deletedCount) ||
          a.value.localeCompare(b.value),
      );
    },

    async holders(field, value) {
      const out: HolderRecord[] = [];
      if (field === 'accepted_authorities') {
        for await (const u of everyUnit()) {
          if (!(storedAuthorities(u) ?? []).includes(value)) continue;
          const address = formatAddress(u.address);
          out.push({ kind: 'unit', unitId: u.unitId, address: address === '' ? null : address, deleted: isUnitDeleted(u) });
        }
        return out;
      }
      for await (const c of everyContact()) {
        if (c[field] !== value) continue;
        out.push({
          kind: 'contact',
          contactId: c.contactId,
          name: contactDisplayName(c) ?? null,
          type: c.type,
          deleted: isContactDeleted(c),
        });
      }
      return out;
    },

    async rewrite(def, opts) {
      const counts: RewriteCounts = { housingAuthority: 0, agency: 0, accepted_authorities: 0, organization: 0, skipped: 0, conflicts: 0 };
      let lastBeat = Date.now();
      /** At most every 20 s; throws OrgRewriteLockLostError once the lock is not ours (spec D11). */
      const beat = async (): Promise<void> => {
        if (opts.heartbeat === undefined || Date.now() - lastBeat < ORG_REWRITE_HEARTBEAT_MS) return;
        lastBeat = Date.now();
        let ours: boolean;
        try {
          ours = await opts.heartbeat();
        } catch (err) {
          // A heartbeat that THREW (a busy or unreachable list) says nothing
          // about the lock: keep going. The caller's local lease answers false
          // instead once the lock was last refreshed too long ago
          // (jobs/orgRewrite.ts; code review R3-BE-1).
          log.warn({ err, jobId: def.jobId }, 'org rewrite: heartbeat failed - continuing');
          return;
        }
        if (!ours) {
          // A newer rewrite took the lock, a duplicate run finished it, it
          // lapsed, or the caller's lease ran out while its heartbeats failed:
          // stop writing records at once.
          log.warn({ jobId: def.jobId, ...counts }, 'org rewrite: the lock is no longer this run - stopping');
          throw new OrgRewriteLockLostError({ ...counts });
        }
      };
      // `from` and `to` are STRINGS (planner ruling): the property Activity
      // projection shows them only when they are (routes/units.ts:191-221).
      const record = async (entityKey: string, field: OrgRecordField, from: string, to: string): Promise<void> => {
        const payload =
          opts.auditType === 'org_name_rewrite'
            ? { field, from, to, action: def.action, ...(opts.actor !== undefined && { actor: opts.actor }) }
            : { field, from, to };
        try {
          await audit.append(entityKey, opts.auditType, payload);
        } catch (err) {
          log.error({ err, entityKey, jobId: def.jobId }, 'org rewrite: audit append failed (the record write landed)');
        }
      };
      try {
        const field = passField(def);
        // From-texts compare NORMALIZED (D4). One that normalizes to '' (a
        // stored "-" or "()") would match nothing that way, so a value action
        // matches that stored text instead - TRIMMED on both sides, because a
        // request's text arrives trimmed (trimJsonBody) while a stored " - "
        // may not be - so every "Not on the list" row can be settled. (Rename
        // and merge from-texts are entry names and spellings; a name never
        // normalizes to '' - D13.)
        const from = new Set<string>();
        const exact = new Set<string>();
        for (const text of def.fromTexts) {
          const n = normalizeOrgText(text);
          if (n !== '') from.add(n);
          else if (VALUE_ACTIONS.has(def.action) && text.trim() !== '') exact.add(text.trim());
        }
        const matches = (value: unknown): value is string =>
          typeof value === 'string' &&
          value !== '' &&
          (from.has(normalizeOrgText(value)) || exact.has(value.trim())) &&
          // Already the target (a case-only rename, a variant's own entry): nothing to do.
          !(SAME_FIELD_ACTIONS.has(def.action) && value === def.toName);
        if (field === 'accepted_authorities') {
          for await (const u of everyUnit()) {
            // BEFORE the record is matched and written (code review R3-BE-1):
            // a page read that hung past the lock's lapse is caught here.
            await beat();
            const stored = storedAuthorities(u);
            const hits: string[] = [];
            const next: unknown[] = [];
            for (const member of stored ?? []) {
              let kept: unknown = member;
              if (matches(member)) {
                hits.push(member);
                if (def.action === 'clear') continue;
                kept = def.toName;
              }
              // De-duplicated after the rewrite (D11): the first occurrence wins.
              if (!next.includes(kept)) next.push(kept);
            }
            if (stored !== undefined && hits.length > 0) {
              const outcome = await units.rewriteAcceptedAuthorities(u.unitId, stored as string[], next as string[]);
              if (outcome === 'skipped') counts.skipped += 1;
              else {
                counts.accepted_authorities += 1;
                await record(`units#${u.unitId}`, field, listText(stored), listText(next));
              }
            }
          }
        } else {
          for await (const c of everyContact()) {
            await beat(); // before the record, as above
            const value = c[field];
            if (matches(value)) {
              const plan = planContactRewrite(def, field, value, c);
              if (plan.kind === 'conflict') {
                counts.conflicts += 1;
              } else {
                const outcome = await contacts.rewriteOrgFields(c.contactId, plan.expect, plan.next);
                if (outcome === 'skipped') counts.skipped += 1;
                else {
                  counts[field] += 1;
                  if (plan.conflict) counts.conflicts += 1;
                  // One event per field the write changed (plan 3.8).
                  for (const a of plan.audits) await record(`contacts#${c.contactId}`, a.field, a.from, a.to);
                }
              }
            }
          }
        }
      } catch (err) {
        // Losing the lock is not a failure of the pass: the caller must not finish().
        if (err instanceof OrgRewriteLockLostError) throw err;
        throw new OrgRewriteAbortedError({ ...counts }, err);
      }
      log.info({ jobId: def.jobId, action: def.action, field: def.field, ...counts }, 'org rewrite pass finished');
      return { ...counts };
    },
  };
}
