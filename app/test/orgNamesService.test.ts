// services/orgNames.ts (spec D5, D10, D12, D13; plan 3.4, 3.4b, 3.5). This
// first block covers what the org services and the router share: the
// control-character rule, the refusal mappings, the store-failure mapping and
// the rewrite-lock test. Tasks 3.6-3.7 append the OrgNamesService itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  type OrgNamesService,
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

/** A service over the STARTING list (spec Appendix A): the fake creates it on the first read. */
function startingListService() {
  const repo = createOrgListFake();
  return { repo, svc: createOrgNamesService({ orgListRepo: repo, logger: quietLogger() }) };
}

async function startingEntry(svc: OrgNamesService, name: string): Promise<OrgEntry> {
  const entry = (await svc.read()).entries.find((e) => e.name === name);
  if (entry === undefined) throw new Error(`no starting-list entry named ${name}`);
  return entry;
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

describe('OrgNamesService - list writes (plan 3.4, 3.5)', () => {
  const T1 = '2026-10-06T12:00:00.000Z';
  const NL = String.fromCharCode(10);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T1));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('add() appends a fresh entry with its notes and authorship in ONE list write', async () => {
    const { repo, svc } = await namesService();
    const entry = await svc.add({ kind: 'agency', name: ' Mercy Care ', notes: ' Clinic partner ', actor: 'usr_va' });
    expect(entry).toEqual({
      orgId: expect.any(String),
      kind: 'agency',
      name: 'Mercy Care',
      spellings: [],
      notes: 'Clinic partner',
      createdAt: T1,
      createdBy: 'usr_va',
      updatedAt: T1,
      updatedBy: 'usr_va',
    });
    const stored = await repo.peek();
    expect(stored?.version).toBe(2);
    expect(stored?.entries.at(-1)).toEqual(entry);
  });

  it('add() refuses every name problem with its plan-3.5 code, and writes nothing', async () => {
    const { repo, svc } = await namesService();
    await expect(svc.add({ kind: 'housing_authority', name: 'aha', actor: 'u' })).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_name_taken', entry: orgRef(ATLANTA) },
    });
    await expect(svc.add({ kind: 'housing_authority', name: 'DCA VASH', actor: 'u' })).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_name_compound', spans: [[orgRef(DCA)], [orgRef(VASH)]] },
    });
    await expect(svc.add({ kind: 'agency', name: '  ', actor: 'u' })).rejects.toMatchObject({
      status: 400,
      body: { error: 'org_name_empty' },
    });
    await expect(svc.add({ kind: 'agency', name: 'x'.repeat(121), actor: 'u' })).rejects.toMatchObject({
      status: 400,
      body: { error: 'org_name_too_long' },
    });
    await expect(svc.add({ kind: 'agency', name: `Mercy${NL}Care`, actor: 'u' })).rejects.toMatchObject({
      status: 400,
      body: { error: 'org_name_invalid' },
    });
    await expect(svc.add({ kind: 'agency', name: 'Mercy Care', notes: 'n'.repeat(501), actor: 'u' })).rejects.toMatchObject({
      status: 400,
      body: { error: 'org_notes_too_long' },
    });
    expect((await repo.peek())?.version).toBe(1);
  });

  // Review R1-ADV-BE-1 / R1-ADV-FE-3: a rewrite pass matches its from-texts
  // NORMALIZED and has no list to test "on the list" against, so a name added
  // while it runs that is one of them would be rewritten away - together with
  // every record that holds it. add() waits for exactly that rewrite.
  it('add() refuses 409 org_rewrite_running when a running rewrite has the new name among its from-texts, and writes nothing', async () => {
    const clearing = runningRewrite({ action: 'clear', field: 'housingAuthority', fromTexts: ['Metro HA'], heartbeatAt: T1 });
    const { repo, svc } = await namesService({ lastRewrite: clearing });
    await expect(svc.add({ kind: 'housing_authority', name: 'Metro HA', actor: 'usr_va' })).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_rewrite_running', lastRewrite: clearing },
    });
    // Compared as the pass compares (D4): case and punctuation do not matter.
    await expect(svc.add({ kind: 'housing_authority', name: 'metro-ha', actor: 'usr_va' })).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_rewrite_running' },
    });
    expect((await repo.peek())?.version).toBe(1);
  });

  it('(PIN) add() of any other name goes ahead while that rewrite runs - adds are not rewrites (D10)', async () => {
    const clearing = runningRewrite({ action: 'clear', field: 'housingAuthority', fromTexts: ['Metro HA'], heartbeatAt: T1 });
    const { repo, svc } = await namesService({ lastRewrite: clearing });
    const entry = await svc.add({ kind: 'housing_authority', name: 'Fulton County Housing Authority', actor: 'usr_va' });
    expect(entry.name).toBe('Fulton County Housing Authority');
    const stored = await repo.peek();
    expect(stored?.version).toBe(2);
    expect(stored?.lastRewrite).toEqual(clearing);
  });

  it('(PIN) add() of that same name goes ahead once the rewrite no longer holds the lock - finished, or stale', async () => {
    for (const last of [
      runningRewrite({
        action: 'clear',
        field: 'housingAuthority',
        fromTexts: ['Metro HA'],
        status: 'done',
        heartbeatAt: T1,
        finishedAt: T1,
      }),
      // No heartbeat for 16 minutes: the lock is free (D11).
      runningRewrite({
        action: 'clear',
        field: 'housingAuthority',
        fromTexts: ['Metro HA'],
        heartbeatAt: '2026-10-06T11:44:00.000Z',
      }),
    ]) {
      const { svc } = await namesService({ lastRewrite: last });
      expect((await svc.add({ kind: 'housing_authority', name: 'Metro HA', actor: 'usr_va' })).name).toBe('Metro HA');
    }
  });

  it('updateNotes() sets or (blank) removes the notes; over 500 characters and unknown ids are refused', async () => {
    const { svc } = await namesService();
    const noted = await svc.updateNotes('org-dca', ' Runs vouchers statewide. ', 'usr_va');
    expect(noted).toEqual({ ...DCA, notes: 'Runs vouchers statewide.', updatedAt: T1, updatedBy: 'usr_va' });
    expect(await svc.updateNotes('org-dca', '', 'usr_va')).not.toHaveProperty('notes');
    await expect(svc.updateNotes('org-dca', 'n'.repeat(501), 'u')).rejects.toMatchObject({
      status: 400,
      body: { error: 'org_notes_too_long' },
    });
    await expect(svc.updateNotes('org-nope', 'x', 'u')).rejects.toMatchObject({
      status: 404,
      body: { error: 'org_not_found' },
    });
  });

  it('updateSpellings() replaces the list, drops blanks and duplicates, and checks only NEW spellings', async () => {
    const { svc } = await namesService();
    // AHA (shared with Augusta since the starting list) is KEPT without a confirm.
    const entry = await svc.updateSpellings(
      'org-atl',
      ['AHA', 'Atlanta Housing', ' atlanta housing ', 'Housing Authority of the City of Atlanta', ''],
      { confirmShared: false, actor: 'usr_admin' },
    );
    expect(entry.spellings).toEqual(['AHA', 'Atlanta Housing', 'Housing Authority of the City of Atlanta']);
    expect(entry.updatedBy).toBe('usr_admin');
  });

  it('updateSpellings() refuses each D12 problem; a same-kind share lands only with confirmShared', async () => {
    const refusals: Array<[string, Record<string, unknown>]> = [
      ['VASH', { error: 'org_spelling_refused', spelling: 'VASH', problem: 'cross_kind', entries: [orgRef(VASH)] }],
      ['Step Up', { error: 'org_spelling_refused', spelling: 'Step Up', problem: 'equals_name', entries: [orgRef(STEP_UP)] }],
      [DCA.name, { error: 'org_spelling_refused', spelling: DCA.name, problem: 'duplicate' }],
      ['Atlanta Housing VASH', { error: 'org_spelling_refused', spelling: 'Atlanta Housing VASH', problem: 'compound' }],
      [`GA${NL}DCA`, { error: 'org_spelling_refused', spelling: `GA${NL}DCA`, problem: 'invalid' }],
      ['AHA', { error: 'org_spelling_shared', spelling: 'AHA', entries: [orgRef(ATLANTA), orgRef(AUGUSTA)] }],
    ];
    const { repo, svc } = await namesService();
    for (const [spelling, body] of refusals) {
      await expect(
        svc.updateSpellings('org-dca', ['DCA', spelling], { confirmShared: false, actor: 'a' }),
      ).rejects.toMatchObject({ status: 409, body });
    }
    expect((await repo.peek())?.version).toBe(1);
    const shared = await svc.updateSpellings('org-dca', ['DCA', 'AHA'], { confirmShared: true, actor: 'a' });
    expect(shared.spellings).toEqual(['DCA', 'AHA']);
  });

  it('updateSpellings() past 20 spellings is org_spellings_full', async () => {
    const { svc } = await namesService();
    const many = Array.from({ length: 21 }, (_, i) => `Agency Spelling ${i}`);
    await expect(svc.updateSpellings('org-stepup', many, { confirmShared: false, actor: 'a' })).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_spellings_full' },
    });
  });

  // A NEW spelling is checked against the entry AS IT WILL BE (build ruling
  // B-1): the D4 compound test must see the entry's own spellings.
  it('updateSpellings() refuses "AHA DCA" on DCA as compound - AHA (Atlanta, Augusta) + DCA (DCA itself) (D4, D12)', async () => {
    const { repo, svc } = startingListService();
    const dca = await startingEntry(svc, 'Georgia Department of Community Affairs');
    // POST /check already answers compound for it.
    expect(await svc.check({ kind: 'housing_authority', text: 'AHA DCA', spellingFor: dca.orgId })).toMatchObject({
      spellingProblem: 'compound',
    });
    await expect(
      svc.updateSpellings(dca.orgId, [...dca.spellings, 'AHA DCA'], { confirmShared: false, actor: 'usr_admin' }),
    ).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_spelling_refused', spelling: 'AHA DCA', problem: 'compound' },
    });
    expect((await repo.peek())?.version).toBe(1);
  });

  it('updateSpellings() accepts "Atlanta Housing Authority AHA" on Atlanta - Atlanta matches both spans, so it is not compound (D4)', async () => {
    const { svc } = startingListService();
    const atlanta = await startingEntry(svc, 'Atlanta Housing Authority');
    const wanted = [...atlanta.spellings, 'Atlanta Housing Authority AHA'];
    const out = await svc.updateSpellings(atlanta.orgId, wanted, { confirmShared: false, actor: 'usr_admin' });
    expect(out.spellings).toEqual(wanted);
    expect(await svc.checkScalar('housingAuthority', 'Atlanta Housing Authority AHA', undefined)).toEqual({
      ok: true,
      value: atlanta.name,
    });
  });

  it('(PIN) updateSpellings() re-sending each entry current spellings unchanged succeeds with no confirm', async () => {
    const { svc } = startingListService();
    // AHA and MHA are shared since the starting list: kept spellings are never re-checked.
    for (const entry of (await svc.read()).entries) {
      const out = await svc.updateSpellings(entry.orgId, [...entry.spellings], { confirmShared: false, actor: 'usr_admin' });
      expect(out.spellings).toEqual(entry.spellings);
    }
  });

  it('(PIN) updateSpellings() at the 20 cap may swap one spelling for a new one - the entry as it will be, not as it is', async () => {
    const full = orgEntry({
      orgId: 'org-full',
      kind: 'agency',
      name: 'Full Agency',
      spellings: Array.from({ length: 20 }, (_, i) => `Full Spelling ${i}`),
    });
    const { svc } = await namesService({ entries: [...ORG_FIXTURE, full] });
    const swapped = [...full.spellings.slice(1), 'Full Spelling New'];
    const out = await svc.updateSpellings('org-full', swapped, { confirmShared: false, actor: 'usr_admin' });
    expect(out.spellings).toEqual(swapped);
  });

  it('changeKind() refuses a spelling shared with the old kind and a running rewrite; otherwise changes the kind', async () => {
    const shared = await namesService();
    await expect(shared.svc.changeKind('org-aug', 'agency', 'usr_admin')).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_spelling_refused', spelling: 'AHA', problem: 'cross_kind', entries: [orgRef(ATLANTA)] },
    });
    const running = await namesService({
      lastRewrite: runningRewrite({ action: 'clear', field: 'agency', fromTexts: ['x'], heartbeatAt: T1 }),
    });
    await expect(running.svc.changeKind('org-stepup', 'housing_authority', 'usr_admin')).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_rewrite_running' },
    });
    const free = await namesService();
    expect(await free.svc.changeKind('org-stepup', 'housing_authority', 'usr_admin')).toEqual({
      ...STEP_UP,
      kind: 'housing_authority',
      updatedAt: T1,
      updatedBy: 'usr_admin',
    });
    // The same kind answers the entry and writes nothing.
    const before = (await free.repo.peek())?.version;
    expect((await free.svc.changeKind('org-dca', 'housing_authority', 'usr_admin')).kind).toBe('housing_authority');
    expect((await free.repo.peek())?.version).toBe(before);
  });

  it('remove() refuses while a rewrite runs; removes an unused entry; 404s an unknown one', async () => {
    const running = await namesService({
      lastRewrite: runningRewrite({ action: 'rename', fromTexts: ['x'], toName: STEP_UP.name, heartbeatAt: T1 }),
    });
    await expect(running.svc.remove('org-stepup', 'usr_admin')).rejects.toMatchObject({
      status: 409,
      body: { error: 'org_rewrite_running' },
    });
    const free = await namesService();
    await free.svc.remove('org-stepup', 'usr_admin');
    expect((await free.repo.peek())?.entries.map((e) => e.orgId)).toEqual(['org-atl', 'org-aug', 'org-dca', 'org-vash']);
    await expect(free.svc.remove('org-stepup', 'usr_admin')).rejects.toMatchObject({
      status: 404,
      body: { error: 'org_not_found' },
    });
  });
});
