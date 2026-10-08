// The caseworker matching rules (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D16, D22 "Matching"; plan 3.2). PURE - no I/O. A caseworker is a
// `type: 'partner'` contact whose role satisfies isCaseworkerRole; there is no
// caseworker ContactType (D16). Three tiers, each owned here or beside it:
//   - the kind canonicalizer (services/extraction/contactKinds.ts) takes
//     role EXACTLY CASEWORKER_ROLE;
//   - the Caseworkers tab: isCaseworkerRole - the D4 form (normalizeOrgText)
//     is "caseworker" or "case worker";
//   - the Possible caseworkers list, the relationship signal and the
//     KindPicker datalist filter: mentionsCaseworker - the D4 form CONTAINS
//     "caseworker", "case worker" or "case manager".
// Only `role` counts (`role_title` is ignored). The dashboard copy is
// dashboard/src/routes/contact/caseworkerRole.ts, pinned to this module by
// caseworkerRoleMirror.test.ts - change both together.
//
// LEAF MODULE: import nothing but lib/orgNames.ts (itself import-free). The
// dashboard mirror test imports this file, so an import of anything that
// reaches the repos, the adapters or lib/config.ts drags the app's AWS and
// Anthropic graph into the dashboard typecheck (plan 3.2).
import { normalizeOrgText } from './orgNames.js';

/**
 * The caseworker preset role (spec 2026-10-06 D16), byte-exact like
 * PROPERTY_MANAGER_ROLE. A caseworker is `type: 'partner'` with a role that
 * satisfies isCaseworkerRole; this exact text is the role the KindPicker
 * preset and the caseworker conversion write. DEFINED here, in a leaf
 * module, and re-exported by services/extraction/contactKinds.ts (never the
 * reverse: contactKinds.ts type-imports the AWS and Anthropic graph, and the
 * dashboard mirror test imports THIS file). The dashboard copy lives in
 * dashboard/src/routes/contact/caseworkerRole.ts (caseworkerRoleMirror.test.ts
 * pins the two together).
 */
export const CASEWORKER_ROLE = 'Caseworker';

/** The Possible caseworkers row signals (plan 3.2), in wire/declaration order. */
export type PossibleSignal = 'role_mentions' | 'ai_note' | 'relationship' | 'partner_no_role';

const TAB_ROLES: readonly string[] = ['caseworker', 'case worker'];
const MENTIONS: readonly string[] = ['caseworker', 'case worker', 'case manager'];

/** The extraction's own note prefix, `[Auto - Jul 16]` (extraction/apply.ts autoPrefix). */
const AUTO_PREFIX = /^\[Auto - [^\]]+\]\s*/;
const AI_NOTE_STARTS: readonly string[] = [
  'identified as a caseworker',
  'identified as caseworker',
  'identified as a case worker',
  'identified as case worker',
];

/** The tab rule (D16): the D4 form of the role is "caseworker" or "case worker". */
export function isCaseworkerRole(role: unknown): boolean {
  if (typeof role !== 'string') return false;
  return TAB_ROLES.includes(normalizeOrgText(role));
}

/**
 * The "mentions" rule (D22): the D4 form of the role contains "caseworker",
 * "case worker" or "case manager" - and nothing else counts ("case mgr" and
 * "case management" do not).
 */
export function mentionsCaseworker(role: unknown): boolean {
  if (typeof role !== 'string') return false;
  const normalized = normalizeOrgText(role);
  return MENTIONS.some((m) => normalized.includes(m));
}

/**
 * The AI-note signal (D22): some line of `notes` starts with the extraction
 * prefix `[Auto - <date>]` and its text after the prefix, in D4 form, starts
 * with "identified as" + "a caseworker" / "caseworker" / "a case worker" /
 * "case worker". A line without the prefix never counts: staff edit `notes`
 * freely, and a tenant's notes routinely mention the tenant's OWN caseworker.
 */
export function hasAiCaseworkerNote(notes: unknown): boolean {
  if (typeof notes !== 'string') return false;
  return notes.split('\n').some((line) => {
    const prefix = AUTO_PREFIX.exec(line);
    if (prefix === null) return false;
    const rest = normalizeOrgText(line.slice(prefix[0].length));
    return AI_NOTE_STARTS.some((start) => rest.startsWith(start));
  });
}

/** "A caseworker", everywhere in the design: a partner whose role satisfies isCaseworkerRole. */
export function isCaseworker(c: { type?: unknown; role?: unknown }): boolean {
  return c.type === 'partner' && isCaseworkerRole(c.role);
}
