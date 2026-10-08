// The Possible caseworkers list (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D19, D22; plan 3.4): computed on the server from ONE read each of the
// tenant, landlord and partner partitions - no index exists for any signal
// (the tours-tabs cost precedent; filed in section 12). Live (listByType
// excludes deleted), not dismissed, not already a caseworker:
//   role_mentions   - a tenant or landlord whose role "mentions" (D22)
//   ai_note         - a tenant whose `notes` carry the AI's own prefixed line
//   relationship    - a tenant another listed contact links as its caseworker
//                     (a relationship row with a contactId whose role mentions)
//   partner_no_role - a partner with no role
// Only `role` counts; `role_title` and `staff_notes` are never read.
import {
  hasAiCaseworkerNote,
  isCaseworker,
  mentionsCaseworker,
  type PossibleSignal,
} from '../lib/caseworkers.js';
import { isDeleted, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import type { PossibleCaseworkerRow } from './caseworkerConversion.js';

const BASES = ['tenant', 'landlord', 'partner'] as const;

async function readPartition(
  contacts: Pick<ContactsRepo, 'listByType'>,
  type: (typeof BASES)[number],
): Promise<ContactItem[]> {
  const out: ContactItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await contacts.listByType(type, {
      ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
    });
    out.push(...page.items);
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return out;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function sortKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function listPossibleCaseworkers(deps: {
  contacts: Pick<ContactsRepo, 'listByType'>;
}): Promise<PossibleCaseworkerRow[]> {
  const all: ContactItem[] = [];
  for (const type of BASES) all.push(...(await readPartition(deps.contacts, type)));

  // Contacts some listed contact links as its caseworker (D22: the row's role
  // mentions). Rows held by unknown or team_member contacts are not seen
  // (accepted, D19).
  const linked = new Set<string>();
  for (const holder of all) {
    const rows: unknown = holder['relationships'];
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Array<Record<string, unknown>>) {
      const target = row['contactId'];
      // C3: D19 says another contact's relationship; self-links do not count.
      if (typeof target === 'string' && target !== '' && target !== holder.contactId && mentionsCaseworker(row['role'])) {
        linked.add(target);
      }
    }
  }

  const out: PossibleCaseworkerRow[] = [];
  for (const c of all) {
    if (isDeleted(c) || c['caseworker_review'] === 'dismissed' || isCaseworker(c)) continue;
    const signals: PossibleSignal[] = [];
    const role = text(c['role']);
    if ((c.type === 'tenant' || c.type === 'landlord') && mentionsCaseworker(role)) signals.push('role_mentions');
    if (c.type === 'tenant' && hasAiCaseworkerNote(c['notes'])) signals.push('ai_note');
    if (c.type === 'tenant' && linked.has(c.contactId)) signals.push('relationship');
    if (c.type === 'partner' && role === undefined) signals.push('partner_no_role');
    if (signals.length === 0) continue;
    const firstName = text(c['firstName']);
    const lastName = text(c['lastName']);
    const phone = text(c.phone);
    out.push({
      contactId: c.contactId,
      ...(firstName !== undefined && { firstName }),
      ...(lastName !== undefined && { lastName }),
      ...(phone !== undefined && { phone }),
      type: c.type as PossibleCaseworkerRow['type'],
      ...(role !== undefined && { role }),
      signals,
    });
  }
  return out.sort((a, b) =>
    compare(sortKey(a.lastName), sortKey(b.lastName))
    || compare(sortKey(a.firstName), sortKey(b.firstName))
    || compare(a.contactId, b.contactId),
  );
}
