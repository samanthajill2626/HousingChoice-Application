// Cross-workspace caseworker-role MIRROR DRIFT GUARD (spec 2026-10-06 D16,
// D22; plan 3.1; planner rulings R1-F14, R4-16).
//
// caseworkerRole.ts HAND-COPIES the caseworker role rules from
// app/src/lib/caseworkers.ts (the dashboard is a separate package and cannot
// import app code at runtime). Two unpinned copies of a matching rule drift
// silently: a role the server's Caseworkers tab counts that the dashboard's
// KindPicker datalist still offers on a tenant (or the reverse) is exactly
// the record the Possible caseworkers list exists to clean up.
//
// MECHANISM: the mediaTypeMirror.test.ts one - import both copies and compare
// RESOLVED answers over one table. The app module is a LEAF: it imports only
// the import-free lib/orgNames.ts and itself DEFINES CASEWORKER_ROLE
// (contactKinds.ts re-exports it), so the dashboard typecheck compiles two
// app files and never the repos, adapters or lib/config.ts. Import nothing
// else from app/ here.
import { describe, expect, it } from 'vitest';
import {
  CASEWORKER_ROLE as APP_CASEWORKER_ROLE,
  isCaseworkerRole as appIsCaseworkerRole,
  mentionsCaseworker as appMentionsCaseworker,
} from '../../../../app/src/lib/caseworkers.js';
import { CASEWORKER_ROLE, isCaseworkerRole, mentionsCaseworker } from './caseworkerRole.js';

/** A Unicode hyphen built at run time, so this file stays ASCII (U+2010). */
const UNICODE_HYPHEN = String.fromCharCode(0x2010);

const ROLES: readonly unknown[] = [
  'Caseworker',
  'caseworker',
  '  CASEWORKER  ',
  'Case worker',
  'case-worker',
  'Case  Worker.',
  'Case_Worker',
  `Case${UNICODE_HYPHEN}worker`,
  'Caseworkers',
  'Senior Caseworker',
  'Caseworker - DFCS',
  'Case worker 2',
  'Case Manager',
  'case-manager',
  'Housing Case Manager',
  'Case Mgr',
  'Case management',
  'Casework',
  'Social worker',
  'Property Manager',
  '',
  '   ',
  undefined,
  null,
  42,
];

describe('dashboard caseworker role rules mirror app/src/lib/caseworkers.ts', () => {
  it('the preset role is byte-identical', () => {
    expect(CASEWORKER_ROLE).toBe(APP_CASEWORKER_ROLE);
    expect(CASEWORKER_ROLE).toBe('Caseworker');
  });

  it.each(ROLES.map((role) => [role]))('isCaseworkerRole(%o) agrees with the app', (role) => {
    expect(isCaseworkerRole(role)).toBe(appIsCaseworkerRole(role));
  });

  it.each(ROLES.map((role) => [role]))('mentionsCaseworker(%o) agrees with the app', (role) => {
    expect(mentionsCaseworker(role)).toBe(appMentionsCaseworker(role));
  });

  it('does not compare constant answers', () => {
    // The floor that stops the agreement above passing VACUOUSLY: each rule
    // says yes and no somewhere in the table, and mentions is the wider rule.
    const tab = ROLES.filter((role) => isCaseworkerRole(role)).length;
    const mentions = ROLES.filter((role) => mentionsCaseworker(role)).length;
    expect(tab).toBeGreaterThan(0);
    expect(tab).toBeLessThan(ROLES.length);
    expect(mentions).toBeGreaterThan(tab);
    expect(mentions).toBeLessThan(ROLES.length);
  });
});
