// orgCopy tests - the organization lists' shared client vocabulary (spec
// 2026-10-06 D3-D13): the code -> copy map and its parity list, the body-aware
// refusal copy, the normalization mirror, and the rewrite-status helpers.
import { describe, expect, it } from 'vitest';
import { ApiError, type OrgRewriteState } from '../../api/index.js';
import {
  ORG_GENERIC_ERROR,
  canRunAgain,
  describeRewrite,
  isOnList,
  isRewriteLive,
  nameProblemCopy,
  normalizeOrgText,
  notOnListMessage,
  orgErrorCopy,
  orgErrorMessage,
  orgListLoadError,
  orgNotOnListBody,
  resolutionText,
  rewriteStatusText,
  spellingProblemCopy,
  usageBreakdown,
  usageText,
} from './orgCopy.js';

// Every { error } code /api/organizations and the D5 writers can answer with
// (plan sections 3.5 and 3.6). Listed, not imported, so DELETING an entry from
// the map fails here instead of silently falling back to the generic sentence.
const ORG_SERVER_CODES = [
  'org_not_on_list',
  'org_name_empty',
  'org_name_too_long',
  'org_name_invalid',
  'org_notes_too_long',
  'org_name_taken',
  'org_name_compound',
  'org_spelling_refused',
  'org_spelling_shared',
  'org_spellings_full',
  'org_in_use',
  'org_not_found',
  'org_rewrite_running',
  'org_rewrite_not_rerunnable',
  'org_rewrite_target_gone',
  'org_value_is_name_variant',
  'org_list_full',
  'org_list_busy',
  'one_change_per_request',
];

const ATL = { orgId: 'o1', kind: 'housing_authority' as const, name: 'Atlanta Housing Authority' };
const AUG = { orgId: 'o2', kind: 'housing_authority' as const, name: 'Augusta Housing Authority' };
const STEP = { orgId: 'o3', kind: 'agency' as const, name: 'Step Up' };

describe('orgErrorMessage', () => {
  it('covers every code with its own sentence', () => {
    for (const code of ORG_SERVER_CODES) {
      expect(orgErrorMessage(code), code).not.toBe(ORG_GENERIC_ERROR);
    }
  });

  it('never puts a machine token in front of staff', () => {
    for (const code of [...ORG_SERVER_CODES, 'some_future_code']) {
      const copy = orgErrorMessage(code);
      expect(copy, code).not.toContain('_');
      expect(copy, code).not.toContain(code);
    }
  });

  it('falls back to the generic sentence for an unknown code', () => {
    expect(orgErrorMessage('some_future_code')).toBe(ORG_GENERIC_ERROR);
  });

  it('one sentence covers both Run again refusals for a changed list', () => {
    // Build ruling B-2: org_rewrite_target_gone answers a target that left the
    // list or changed kind AND a from-text that has since become a listed name.
    expect(orgErrorMessage('org_rewrite_target_gone')).toBe(
      'The list changed since this update started, so it cannot run again - start a new one from the list.',
    );
  });
});

describe('normalizeOrgText (hand mirror of app/src/lib/orgNames.ts)', () => {
  it('folds case, punctuation and underscores exactly like the server', () => {
    expect(normalizeOrgText('  Atlanta (AHA) ')).toBe('atlanta aha');
    expect(normalizeOrgText('atlanta_housing')).toBe('atlanta housing');
    expect(normalizeOrgText('HUD-VASH')).toBe('hud vash');
    expect(normalizeOrgText('Hope & Help, Inc.')).toBe('hope and help inc');
  });
});

describe('isOnList (spec D3)', () => {
  const entries = [ATL, STEP];
  it('is the exact text of an entry of an accepted kind, nothing else', () => {
    expect(isOnList(entries, 'Atlanta Housing Authority', ['housing_authority'])).toBe(true);
    expect(isOnList(entries, 'atlanta housing authority', ['housing_authority'])).toBe(false);
    expect(isOnList(entries, 'Step Up', ['housing_authority'])).toBe(false);
    expect(isOnList(entries, 'Step Up', ['agency'])).toBe(true);
  });
});

describe('the 422 org_not_on_list body', () => {
  const refused = (extra: Record<string, unknown>): ApiError =>
    new ApiError(422, 'org_not_on_list', 'org_not_on_list', {
      error: 'org_not_on_list',
      field: 'housingAuthority',
      candidates: [],
      close: [],
      ...extra,
    });

  it('narrows only a 422 org_not_on_list with a usable body', () => {
    expect(orgNotOnListBody(new Error('x'))).toBeNull();
    expect(orgNotOnListBody(new ApiError(409, 'org_name_taken', 'org_name_taken', {}))).toBeNull();
    expect(orgNotOnListBody(refused({ text: 'AHA', candidates: [ATL, AUG] }))?.candidates).toEqual([ATL, AUG]);
  });

  it('explains each resolution in staff words', () => {
    const say = (extra: Record<string, unknown>): string => {
      const body = orgNotOnListBody(refused(extra));
      if (body === null) throw new Error('not narrowed');
      return notOnListMessage(body);
    };
    expect(say({ text: 'AHA', candidates: [ATL, AUG] })).toBe(
      'AHA is a spelling of more than one housing authority (Atlanta Housing Authority, Augusta Housing Authority) - pick one.',
    );
    expect(say({ text: 'Step Up', otherKind: [STEP] })).toBe('Step Up is an agency, not a housing authority.');
    expect(say({ text: 'Atlnta', close: [ATL] })).toBe('Atlnta is not on the list. Did you mean Atlanta Housing Authority?');
    expect(say({ text: 'Nowhere' })).toBe('Nowhere is not on the list - pick a name from the list or add it.');
  });
});

describe('orgErrorCopy (body-aware)', () => {
  it('names the entry that already holds a name', () => {
    const err = new ApiError(409, 'org_name_taken', 'org_name_taken', { error: 'org_name_taken', entry: ATL });
    expect(orgErrorCopy(err)).toBe('That name is already on the list as Atlanta Housing Authority.');
  });

  it('says how many deleted records still hold an entry (spec D10)', () => {
    const err = new ApiError(409, 'org_in_use', 'org_in_use', { error: 'org_in_use', uses: { active: 3, deleted: 2 } });
    expect(orgErrorCopy(err)).toBe('5 records still hold this name (2 deleted), so it cannot be changed this way.');
  });

  it('names what a compound name contains and points to Split (spec D13)', () => {
    const err = new ApiError(409, 'org_name_compound', 'org_name_compound', {
      error: 'org_name_compound',
      spans: [[{ orgId: 'o4', kind: 'housing_authority', name: 'Georgia Department of Community Affairs' }], [{ orgId: 'o5', kind: 'agency', name: 'HUD-VASH' }]],
    });
    expect(orgErrorCopy(err)).toBe(
      'That names more than one organization (Georgia Department of Community Affairs and HUD-VASH), so it cannot be one entry. Use Split instead.',
    );
  });

  it('confirms a shared spelling in D12 words', () => {
    const err = new ApiError(409, 'org_spelling_shared', 'org_spelling_shared', {
      error: 'org_spelling_shared',
      spelling: 'AHA',
      entries: [AUG],
    });
    expect(orgErrorCopy(err)).toBe('AHA is now shared with Augusta Housing Authority - it will no longer be applied automatically.');
  });

  it('a name variant can only be settled with Use <its entry> (spec D10)', () => {
    const err = new ApiError(409, 'org_value_is_name_variant', 'org_value_is_name_variant', {
      error: 'org_value_is_name_variant',
      entry: ATL,
    });
    expect(orgErrorCopy(err)).toBe(
      'That value is Atlanta Housing Authority written differently - settle it with Use Atlanta Housing Authority.',
    );
  });

  it('a non-API failure is the generic sentence', () => {
    expect(orgErrorCopy(new Error('boom'))).toBe(ORG_GENERIC_ERROR);
  });
});

describe('problem copy', () => {
  it('explains a name that cannot be added', () => {
    expect(nameProblemCopy('org_name_taken', { match: ATL, candidates: [], close: [] })).toBe(
      'It is already on the list as Atlanta Housing Authority.',
    );
    expect(nameProblemCopy('org_name_taken', { candidates: [ATL, AUG], close: [] })).toBe(
      'It is already a spelling of Atlanta Housing Authority, Augusta Housing Authority.',
    );
    expect(nameProblemCopy('org_name_compound')).toBe('It names more than one organization, so it cannot be one entry.');
  });

  it('explains a spelling that cannot be remembered, never with a machine token', () => {
    expect(spellingProblemCopy('shared_same_kind', [AUG])).toBe(
      'it is also a spelling of Augusta Housing Authority, and a shared spelling is never applied automatically',
    );
    for (const problem of ['empty', 'too_long', 'too_many', 'duplicate', 'equals_name', 'cross_kind', 'compound', 'shared_same_kind', 'invalid', 'something_new']) {
      expect(spellingProblemCopy(problem), problem).not.toContain('_');
    }
  });
});

describe('rewrite status', () => {
  // dashboard/src/test/setup.ts pins Date.now() to 2026-07-01T12:00:00Z.
  const base: OrgRewriteState = {
    jobId: 'j1',
    action: 'rename',
    fromTexts: ['Atlanta HA'],
    fields: ['housingAuthority', 'accepted_authorities'],
    toName: 'Atlanta Housing Authority',
    status: 'running',
    heartbeatAt: '2026-07-01T11:59:00.000Z',
    startedAt: '2026-07-01T11:58:00.000Z',
    startedBy: 'u1',
  };

  it('a running rewrite with a fresh heartbeat is live; a stale one can run again', () => {
    expect(isRewriteLive(base)).toBe(true);
    expect(canRunAgain(base)).toBe(false);
    const stale = { ...base, heartbeatAt: '2026-07-01T11:40:00.000Z' };
    expect(isRewriteLive(stale)).toBe(false);
    expect(canRunAgain(stale)).toBe(true);
    expect(canRunAgain({ ...base, status: 'failed' })).toBe(true);
    expect(canRunAgain({ ...base, status: 'done' })).toBe(false);
  });

  it('never offers Run again for the cleanup script (spec D11)', () => {
    expect(canRunAgain({ ...base, action: 'cleanup', status: 'failed' })).toBe(false);
    expect(rewriteStatusText({ ...base, action: 'cleanup', status: 'failed' })).toContain('Re-run the cleanup script');
  });

  it('describes each action and its counts in staff words', () => {
    expect(describeRewrite(base)).toBe('renaming Atlanta HA to Atlanta Housing Authority');
    expect(
      describeRewrite({ ...base, action: 'split', toName: 'Georgia Department of Community Affairs', agencyName: 'HUD-VASH' }),
    ).toBe('splitting Atlanta HA into Georgia Department of Community Affairs + HUD-VASH');
    expect(rewriteStatusText(base)).toBe('Updating records: renaming Atlanta HA to Atlanta Housing Authority.');
    expect(rewriteStatusText({ ...base, status: 'done', counts: { housingAuthority: 3, skipped: 1, conflicts: 0 } })).toBe(
      'Last update finished: renaming Atlanta HA to Atlanta Housing Authority. Housing authority fields: 3, Skipped (changed meanwhile): 1.',
    );
  });
});

describe('Settings counts and resolutions', () => {
  it('counts active records and shows deleted ones beside them', () => {
    expect(usageText(undefined)).toBe('-');
    expect(usageText({ tenants: 3, otherContacts: 1, properties: 0, deleted: 2 })).toBe(
      '3 tenants, 1 other contact, 0 properties (+2 deleted)',
    );
    expect(usageBreakdown({ tenants: 1, otherContacts: 0, properties: 1, deleted: 0 })).toBe(
      '1 tenant, 0 other contacts, 1 property, 0 deleted',
    );
  });

  it('names each resolution', () => {
    expect(resolutionText({ status: 'other_kind', otherKind: [STEP] }, 'housingAuthority')).toBe('An agency: Step Up');
    expect(resolutionText({ status: 'ambiguous', candidates: [ATL, AUG] }, 'housingAuthority')).toBe(
      'Shared spelling: Atlanta Housing Authority or Augusta Housing Authority',
    );
    expect(resolutionText({ status: 'unknown', close: [] }, 'agency')).toBe('Unknown');
  });

  it('words a picker load failure per kind', () => {
    expect(orgListLoadError(['housing_authority'])).toBe("Couldn't load housing authorities");
    expect(orgListLoadError(['agency'])).toBe("Couldn't load agencies");
  });
});
