// caseworkerRole - the dashboard copy of the caseworker role rules (spec
// 2026-10-06 D16, D22; plan 3.1). HAND MIRROR of app/src/lib/caseworkers.ts
// (the dashboard cannot import app code at runtime); caseworkerRoleMirror.test.ts
// pins the two copies together - change both together.
//
// A caseworker is a `partner` whose role satisfies isCaseworkerRole (the
// Caseworkers tab, the offer gate on the STORED contact, R4-15). The preset
// lights on the exact CASEWORKER_ROLE. mentionsCaseworker is the looser rule
// the KindPicker "Other" datalist filter uses (D22).
//
// IMPORT RULE: this module imports only the D4 normalizer mirror. orgCopy.ts
// imports contactProfile.ts, so contactProfile.ts must never import this
// module (an import cycle).
import { normalizeOrgText } from '../orgs/orgCopy.js';

/** The caseworker preset role, byte-exact (the server's CASEWORKER_ROLE). */
export const CASEWORKER_ROLE = 'Caseworker';

const TAB_ROLES: readonly string[] = ['caseworker', 'case worker'];
const MENTIONS: readonly string[] = ['caseworker', 'case worker', 'case manager'];

/** The tab rule: the D4 form of the role is "caseworker" or "case worker". */
export function isCaseworkerRole(role: unknown): boolean {
  if (typeof role !== 'string') return false;
  return TAB_ROLES.includes(normalizeOrgText(role));
}

/** The mentions rule: the D4 form contains "caseworker", "case worker" or "case manager". */
export function mentionsCaseworker(role: unknown): boolean {
  if (typeof role !== 'string') return false;
  const normalized = normalizeOrgText(role);
  return MENTIONS.some((m) => normalized.includes(m));
}

/**
 * "A caseworker", everywhere in this design (spec D16): a partner whose role
 * satisfies isCaseworkerRole. Hosts pass the STORED contact (ruling R4-15).
 * Structurally typed, so this module keeps its import rule (the D4
 * normalizer only); a dashboard `Contact` satisfies it. Every importer
 * imports it from HERE (assembly ruling S8-7), never from CaseworkerDialog.
 */
export function isCaseworkerContact(contact: { type?: unknown; role?: unknown }): boolean {
  return contact.type === 'partner' && isCaseworkerRole(contact.role);
}
