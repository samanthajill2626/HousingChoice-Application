// services/orgNames.ts (spec D5, D10, D12, D13; plan 3.4, 3.4b, 3.5). This
// first block covers what the org services and the router share: the
// control-character rule, the refusal mappings, the store-failure mapping and
// the rewrite-lock test. Tasks 3.6-3.7 append the OrgNamesService itself.
import { describe, expect, it } from 'vitest';
import type { OrgEntry } from '../src/lib/orgNames.js';
import { OrgListBusyError, OrgListFullError, type OrgRewriteState } from '../src/repos/orgListRepo.js';
import {
  asOrgHttpError,
  checkNewOrgName,
  checkOrgSpelling,
  createOrgNamesService,
  hasOrgControlChar,
  isOrgRewriteRunning,
  nameProblemError,
  OrgHttpError,
  rewriteRunningError,
  spellingProblemError,
  toOrgRef,
} from '../src/services/orgNames.js';
import {
  ATLANTA,
  AUGUSTA,
  DCA,
  ORG_FIXTURE,
  STEP_UP,
  VASH,
  orgEntry,
  orgListItem,
  orgRef,
  quietLogger,
  runningRewrite,
} from './helpers/orgFixtures.js';
import { createOrgListFake } from './helpers/orgListFake.js';

const NL = String.fromCharCode(10);

describe('hasOrgControlChar (spec D13)', () => {
  it('flags a newline, a tab, other C0 and C1 controls, DEL and the line separators', () => {
    for (const code of [0, 7, 9, 10, 13, 27, 0x7f, 0x85, 0x9f, 0x2028, 0x2029]) {
      expect(hasOrgControlChar(`Atlanta${String.fromCharCode(code)}Housing`)).toBe(true);
    }
  });
  it('accepts names with punctuation, digits and non-ASCII letters', () => {
    expect(hasOrgControlChar('Macon-Bibb County Housing Authority')).toBe(false);
    expect(hasOrgControlChar('Atlanta (AHA), 2nd office')).toBe(false);
    expect(hasOrgControlChar(`Caf${String.fromCharCode(0xe9)} Housing`)).toBe(false);
  });
});

describe('checkNewOrgName / checkOrgSpelling - the control-character rule runs first (plan 3.5)', () => {
  it('refuses a name or a spelling that holds a newline as invalid', () => {
    expect(checkNewOrgName(ORG_FIXTURE, `Fulton${NL}County`)).toEqual({ code: 'org_name_invalid' });
    expect(checkOrgSpelling(ORG_FIXTURE, DCA, `GA${NL}DCA`)).toEqual({ problem: 'invalid' });
  });
  it('otherwise answers exactly what the S1 rules answer', () => {
    expect(checkNewOrgName(ORG_FIXTURE, 'Fulton County Housing Authority')).toBeNull();
    expect(checkNewOrgName(ORG_FIXTURE, 'atlanta housing')).toEqual({ code: 'org_name_taken', entry: ATLANTA });
    expect(checkNewOrgName(ORG_FIXTURE, '   ')).toEqual({ code: 'org_name_empty' });
    expect(checkNewOrgName(ORG_FIXTURE, 'Atlanta Housing', { excludeOrgId: ATLANTA.orgId })).toBeNull();
    expect(checkOrgSpelling(ORG_FIXTURE, DCA, 'AHA')).toEqual({
      problem: 'shared_same_kind',
      entries: [ATLANTA, AUGUSTA],
    });
  });
});

describe('nameProblemError / spellingProblemError (plan 3.5)', () => {
  it('maps each name problem to its status and body', () => {
    expect(nameProblemError({ code: 'org_name_empty' })).toMatchObject({ status: 400, body: { error: 'org_name_empty' } });
    expect(nameProblemError({ code: 'org_name_too_long' })).toMatchObject({
      status: 400,
      body: { error: 'org_name_too_long' },
    });
    expect(nameProblemError({ code: 'org_name_invalid' })).toMatchObject({
      status: 400,
      body: { error: 'org_name_invalid' },
    });
    expect(nameProblemError({ code: 'org_name_taken', entry: ATLANTA })).toMatchObject({
      status: 409,
      body: { error: 'org_name_taken', entry: orgRef(ATLANTA) },
    });
    const compound = nameProblemError({ code: 'org_name_compound', spans: [[DCA], [VASH]] });
    expect(compound.status).toBe(409);
    expect(compound.body).toEqual({ error: 'org_name_compound', spans: [[orgRef(DCA)], [orgRef(VASH)]] });
  });
  it('maps each spelling problem to its status and body', () => {
    expect(spellingProblemError('AHA', { problem: 'shared_same_kind', entries: [ATLANTA, AUGUSTA] }).body).toEqual({
      error: 'org_spelling_shared',
      spelling: 'AHA',
      entries: [orgRef(ATLANTA), orgRef(AUGUSTA)],
    });
    expect(spellingProblemError('x', { problem: 'too_many' })).toMatchObject({
      status: 409,
      body: { error: 'org_spellings_full' },
    });
    expect(spellingProblemError('VASH', { problem: 'cross_kind', entries: [VASH] }).body).toEqual({
      error: 'org_spelling_refused',
      spelling: 'VASH',
      problem: 'cross_kind',
      entries: [orgRef(VASH)],
    });
    expect(spellingProblemError('Step Up', { problem: 'equals_name', entries: [STEP_UP] }).body).toEqual({
      error: 'org_spelling_refused',
      spelling: 'Step Up',
      problem: 'equals_name',
      entries: [orgRef(STEP_UP)],
    });
    const invalid = spellingProblemError(`GA${NL}DCA`, { problem: 'invalid' });
    expect(invalid.status).toBe(409);
    expect(invalid.body).toEqual({ error: 'org_spelling_refused', spelling: `GA${NL}DCA`, problem: 'invalid' });
  });
  it('OrgHttpError is an Error whose message is its code; toOrgRef keeps only the public fields', () => {
    const err = new OrgHttpError(404, { error: 'org_not_found' });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('org_not_found');
    expect(toOrgRef(ATLANTA)).toEqual({ orgId: 'org-atl', kind: 'housing_authority', name: 'Atlanta Housing Authority' });
  });
});

describe('asOrgHttpError', () => {
  it('maps the store failures (plan 3.5) and passes an OrgHttpError through', () => {
    expect(asOrgHttpError(new OrgListFullError())).toMatchObject({ status: 409, body: { error: 'org_list_full' } });
    expect(asOrgHttpError(new OrgListBusyError())).toMatchObject({ status: 503, body: { error: 'org_list_busy' } });
    const refusal = new OrgHttpError(404, { error: 'org_not_found' });
    expect(asOrgHttpError(refusal)).toBe(refusal);
    expect(asOrgHttpError(new Error('boom'))).toBeUndefined();
  });
});

describe('isOrgRewriteRunning / rewriteRunningError (spec D11)', () => {
  const NOW = Date.parse('2026-10-06T12:00:00.000Z');
  const beatAt = (iso: string) => runningRewrite({ action: 'clear', field: 'agency', fromTexts: ['x'], heartbeatAt: iso });
  it('holds the lock only while running with a heartbeat under 15 minutes old', () => {
    expect(isOrgRewriteRunning(beatAt('2026-10-06T11:50:00.000Z'), NOW)).toBe(true);
    expect(isOrgRewriteRunning(beatAt('2026-10-06T11:45:00.000Z'), NOW)).toBe(false);
    expect(isOrgRewriteRunning({ ...beatAt('2026-10-06T11:59:00.000Z'), status: 'done' }, NOW)).toBe(false);
    expect(isOrgRewriteRunning({ ...beatAt('2026-10-06T11:59:00.000Z'), status: 'failed' }, NOW)).toBe(false);
    expect(isOrgRewriteRunning(undefined, NOW)).toBe(false);
  });
  it('the refusal carries the rewrite that holds the lock', () => {
    const last = beatAt('2026-10-06T11:59:00.000Z');
    expect(rewriteRunningError(last)).toMatchObject({ status: 409, body: { error: 'org_rewrite_running', lastRewrite: last } });
  });
});

/** A service over a fake list seeded with `entries` (and an optional rewrite lock). */
async function namesService(opts: { entries?: readonly OrgEntry[]; lastRewrite?: OrgRewriteState } = {}) {
  const repo = createOrgListFake();
  await repo.putForSeed(
    orgListItem(opts.entries ?? ORG_FIXTURE, opts.lastRewrite === undefined ? {} : { lastRewrite: opts.lastRewrite }),
  );
  return { repo, svc: createOrgNamesService({ orgListRepo: repo, logger: quietLogger() }) };
}

describe('OrgNamesService - read and the checks (plan 3.4)', () => {
  it('read() returns the stored item', async () => {
    const { svc } = await namesService();
    const item = await svc.read();
    expect(item.version).toBe(1);
    expect(item.entries.map((e) => e.orgId)).toEqual(['org-atl', 'org-aug', 'org-dca', 'org-vash', 'org-stepup']);
  });

  it('checkScalar applies D5 to the STORED list - an entry added a moment ago is accepted at once (no cache)', async () => {
    const { repo, svc } = await namesService();
    expect(await svc.checkScalar('housingAuthority', 'Georgia DCA', undefined)).toEqual({ ok: true, value: DCA.name });
    expect((await svc.checkScalar('housingAuthority', 'Fulton County Housing Authority', undefined)).ok).toBe(false);
    const fulton = orgEntry({ orgId: 'org-fulton', kind: 'housing_authority', name: 'Fulton County Housing Authority' });
    await repo.putForSeed(orgListItem([...ORG_FIXTURE, fulton], { version: 2 }));
    expect(await svc.checkScalar('housingAuthority', 'Fulton County Housing Authority', undefined)).toEqual({
      ok: true,
      value: fulton.name,
    });
  });

  it('checkList passes a held member (trimmed both sides) and resolves every other one', async () => {
    const { svc } = await namesService();
    expect(await svc.checkList('accepted_authorities', ['AHA', DCA.name], [' AHA '], undefined)).toEqual({
      ok: true,
      value: ['AHA', DCA.name],
    });
    // Not held: AHA must resolve on its own - and it is ambiguous.
    expect((await svc.checkList('accepted_authorities', ['AHA'], [], undefined)).ok).toBe(false);
  });

  it('check() reports the D4 resolution, the new-name problem and, with spellingFor, the spelling problem', async () => {
    const { svc } = await namesService();
    expect(await svc.check({ kind: 'housing_authority', text: 'AHA' })).toEqual({
      candidates: [orgRef(ATLANTA), orgRef(AUGUSTA)],
      close: [],
      nameProblem: 'org_name_taken',
    });
    expect(await svc.check({ kind: 'housing_authority', text: 'georgia dca', spellingFor: 'org-atl' })).toEqual({
      match: orgRef(DCA),
      candidates: [],
      close: [],
      nameProblem: 'org_name_taken',
      spellingProblem: 'shared_same_kind',
    });
    expect(await svc.check({ kind: 'housing_authority', text: 'HUD VASH' })).toEqual({
      candidates: [],
      close: [],
      otherKind: [orgRef(VASH)],
      nameProblem: 'org_name_taken',
    });
    expect(await svc.check({ kind: 'housing_authority', text: 'DCA HUD-VASH' })).toEqual({
      candidates: [],
      close: [],
      compound: [[orgRef(DCA)], [orgRef(VASH)]],
      nameProblem: 'org_name_compound',
    });
    expect(
      await svc.check({ kind: 'housing_authority', text: 'Fulton County Housing Authority', spellingFor: 'org-atl' }),
    ).toEqual({ candidates: [], close: [], spellingProblem: null });
    const nl = String.fromCharCode(10);
    expect(await svc.check({ kind: 'agency', text: `New${nl}Agency`, spellingFor: 'org-stepup' })).toMatchObject({
      nameProblem: 'org_name_invalid',
      spellingProblem: 'invalid',
    });
  });

  it('check() with an unknown spellingFor is 404 org_not_found', async () => {
    const { svc } = await namesService();
    await expect(svc.check({ kind: 'agency', text: 'x', spellingFor: 'org-nope' })).rejects.toMatchObject({
      status: 404,
      body: { error: 'org_not_found' },
    });
  });
});
