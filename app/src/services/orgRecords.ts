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
// USES (D3) count only a field of the entry's kind holding the exact name. A
// unit that stores only the legacy `jurisdiction` holds no list: it is neither
// a use nor a "Not on the list" row (the cleanup script backfills it).
import { formatAddress } from '../lib/address.js';
import { contactDisplayName } from '../lib/contactName.js';
import type { Logger } from '../lib/logger.js';
import {
  isOnListFor,
  KINDS_FOR_FIELD,
  resolveOrgText,
  type OrgEntry,
  type OrgRef,
  type OrgResolution,
} from '../lib/orgNames.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import {
  createContactsRepo,
  isDeleted as isContactDeleted,
  type ContactItem,
  type ContactType,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import type { OrgRecordField } from '../repos/orgListRepo.js';
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

export interface OrgUsage {
  /** orgId -> counts of records whose field of the entry's kind holds the exact name. */
  [orgId: string]: { tenants: number; otherContacts: number; properties: number; deleted: number };
}

/** Plan 3.4 - the reads. Task 3.5 adds rewrite(). */
export interface OrgRecordsService {
  usage(entries: readonly OrgEntry[]): Promise<OrgUsage>;
  notOnList(entries: readonly OrgEntry[]): Promise<NotOnListRow[]>;
  holders(field: OrgRecordField, value: string): Promise<HolderRecord[]>;
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
const FIELD_ORDER: Record<OrgRecordField, number> = { housingAuthority: 0, agency: 1, accepted_authorities: 2 };

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

export function createOrgRecordsService(deps: OrgRecordsDeps = {}): OrgRecordsService {
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });

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
      for (const e of entries) out[e.orgId] = { tenants: 0, otherContacts: 0, properties: 0, deleted: 0 };
      const haIds = new Map(entries.filter((e) => e.kind === 'housing_authority').map((e) => [e.name, e.orgId] as const));
      const agencyIds = new Map(entries.filter((e) => e.kind === 'agency').map((e) => [e.name, e.orgId] as const));
      const count = (
        orgId: string | undefined,
        column: 'tenants' | 'otherContacts' | 'properties',
        deleted: boolean,
      ): void => {
        const row = orgId === undefined ? undefined : out[orgId];
        if (row === undefined) return;
        if (deleted) row.deleted += 1;
        else row[column] += 1;
      };
      for await (const c of everyContact()) {
        const deleted = isContactDeleted(c);
        const column = c.type === 'tenant' ? 'tenants' : 'otherContacts';
        const ha = c['housingAuthority'];
        if (typeof ha === 'string') count(haIds.get(ha), column, deleted);
        const agency = c['agency'];
        if (typeof agency === 'string') count(agencyIds.get(agency), column, deleted);
      }
      for await (const u of everyUnit()) {
        const deleted = isUnitDeleted(u);
        // One property is one use, however often its list repeats the name.
        const members = new Set((storedAuthorities(u) ?? []).filter((m): m is string => typeof m === 'string'));
        for (const m of members) count(haIds.get(m), 'properties', deleted);
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
  };
}
