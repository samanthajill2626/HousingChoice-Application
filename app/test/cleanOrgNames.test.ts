// The one-time organization-name cleanup (spec 2026-10-06 section 8, D14):
// automatic mappings only. The PURE planners first: what each record would
// become, its audit payloads, its change counts and what it leaves for the
// Settings page's "Not on the list" section.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GetCommand, PutCommand, ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import type { OrgEntry } from '../src/lib/orgNames.js';
import { buildStartingEntries } from '../src/lib/orgStartingList.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createOrgListRepo, type OrgListItem, type OrgRewriteState } from '../src/repos/orgListRepo.js';
import {
  buildCleanupDeps,
  CLEANUP_ARGS,
  cleanOrgNames,
  CleanupLockLostError,
  CleanupRefusedError,
  formatSummary,
  planContact,
  planUnit,
  reportCleanupRun,
  type CleanupDeps,
  type CleanupLeftover,
  type CleanupResult,
} from '../scripts/clean-org-names.js';
import { parseStageArgs } from '../scripts/lib/stageClient.js';
import { createLogCapture } from './helpers/logCapture.js';

const LIST_AT = '2026-10-06T00:00:00.000Z';
let ids = 0;
/** The starting list (spec Appendix A). */
const ENTRIES: OrgEntry[] = buildStartingEntries(LIST_AT, () => `org-${(ids += 1)}`);

const NOTHING = { audits: [], changes: {}, leftovers: [] };

describe('planContact (spec section 8: automatic mappings only)', () => {
  it('rewrites a housing authority spelling to the exact name', () => {
    const plan = planContact({ housingAuthority: 'Atlanta (AHA)' }, ENTRIES);
    expect(plan.write).toEqual({
      expect: { housingAuthority: 'Atlanta (AHA)', agency: null },
      next: { housingAuthority: 'Atlanta Housing Authority' },
    });
    expect(plan.audits).toEqual([{ field: 'housingAuthority', from: 'Atlanta (AHA)', to: 'Atlanta Housing Authority' }]);
    expect(plan.changes).toEqual({ housingAuthorityRewritten: 1 });
    expect(plan.leftovers).toEqual([]);
  });

  it('moves an agency named as the housing authority into an EMPTY agency (absent or "") and removes the housing authority', () => {
    for (const agency of [undefined, ''] as const) {
      const plan = planContact({ housingAuthority: 'Hope Atlanta', ...(agency !== undefined && { agency }) }, ENTRIES);
      expect(plan.write).toEqual({
        expect: { housingAuthority: 'Hope Atlanta', agency: agency ?? null },
        next: { housingAuthority: null, agency: 'HOPE Atlanta' },
      });
      // Strings only (plan 3.8): '' for the removed housing authority and the empty agency.
      expect(plan.audits).toEqual([
        { field: 'housingAuthority', from: 'Hope Atlanta', to: '' },
        { field: 'agency', from: '', to: 'HOPE Atlanta' },
      ]);
      expect(plan.changes).toEqual({ movedToAgency: 1 });
    }
  });

  it('an agency that already names the same organization is compatible: only the housing authority goes', () => {
    const plan = planContact(
      { housingAuthority: 'HUD VASH', agency: 'HUD-Veterans Affairs Supportive Housing (HUD-VASH)' },
      ENTRIES,
    );
    expect(plan.write?.next).toEqual({ housingAuthority: null });
    expect(plan.audits).toEqual([{ field: 'housingAuthority', from: 'HUD VASH', to: '' }]);
    expect(plan.changes).toEqual({ movedToAgency: 1 });
  });

  it('counts a conflict and leaves both when agency holds another value', () => {
    const plan = planContact({ housingAuthority: 'HUD VASH', agency: 'Step Up' }, ENTRIES);
    expect(plan.write).toBeUndefined();
    expect(plan.changes).toEqual({ agencyConflicts: 1 });
    expect(plan.leftovers).toEqual([{ field: 'housingAuthority', value: 'HUD VASH', resolution: 'other_kind' }]);
  });

  it('rewrites an agency spelling, and moves a housing-authority agency onto the rewritten one', () => {
    expect(planContact({ agency: 'Caring Works' }, ENTRIES)).toMatchObject({
      write: { expect: { housingAuthority: null, agency: 'Caring Works' }, next: { agency: 'CaringWorks' } },
      audits: [{ field: 'agency', from: 'Caring Works', to: 'CaringWorks' }],
      changes: { agencyRewritten: 1 },
    });
    const both = planContact({ housingAuthority: 'Claratel', agency: 'claratel' }, ENTRIES);
    expect(both.write?.next).toEqual({ housingAuthority: null, agency: 'Claratel Behavioral Health' });
    expect(both.changes).toEqual({ agencyRewritten: 1, movedToAgency: 1 });
  });

  it('leaves ambiguous, compound, unknown and other-kind values for the Settings page, untouched', () => {
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [{ housingAuthority: 'AHA' }, { field: 'housingAuthority', value: 'AHA', resolution: 'ambiguous' }],
      [{ housingAuthority: 'DCA HUD-VASH' }, { field: 'housingAuthority', value: 'DCA HUD-VASH', resolution: 'compound' }],
      [
        { housingAuthority: 'Smyrna Housing Office' },
        { field: 'housingAuthority', value: 'Smyrna Housing Office', resolution: 'unknown' },
      ],
      [{ agency: 'Atlanta Housing Authority' }, { field: 'agency', value: 'Atlanta Housing Authority', resolution: 'other_kind' }],
    ];
    for (const [contact, leftover] of cases) {
      const plan = planContact(contact, ENTRIES);
      expect(plan.write).toBeUndefined();
      expect(plan.leftovers).toEqual([leftover]);
    }
  });

  it('plans nothing for exact list names and empty values', () => {
    expect(planContact({ housingAuthority: 'Atlanta Housing Authority', agency: 'Mercy Care' }, ENTRIES)).toEqual(NOTHING);
    expect(planContact({ agency: '' }, ENTRIES)).toEqual(NOTHING);
    expect(planContact({}, ENTRIES)).toEqual(NOTHING);
  });

  it('refuses to plan a malformed value (the run counts the record failed)', () => {
    expect(() => planContact({ housingAuthority: 42 }, ENTRIES)).toThrow();
    expect(() => planContact({ agency: ['x'] }, ENTRIES)).toThrow();
  });
});

describe('planUnit', () => {
  it('rewrites members, drops an agency when others remain, and de-duplicates', () => {
    const stored = ['Atlanta Housing', 'Hope Atlanta', 'Atlanta Housing Authority'];
    const plan = planUnit({ accepted_authorities: stored }, ENTRIES);
    expect(plan.write).toEqual({ expected: stored, next: ['Atlanta Housing Authority'] });
    expect(plan.changes).toEqual({ unitMembersRewritten: 1, unitAgencyMembersDropped: 1, unitDuplicatesRemoved: 1 });
    expect(plan.audits).toEqual([
      {
        field: 'accepted_authorities',
        from: 'Atlanta Housing, Hope Atlanta, Atlanta Housing Authority',
        to: 'Atlanta Housing Authority',
      },
    ]);
    expect(plan.leftovers).toEqual([]);
  });

  it('keeps an agency member that is the only one, and reports it', () => {
    const plan = planUnit({ accepted_authorities: ['Step Up'] }, ENTRIES);
    expect(plan.write).toBeUndefined();
    expect(plan.changes).toEqual({ unitAgencyMembersKept: 1 });
    expect(plan.leftovers).toEqual([{ field: 'accepted_authorities', value: 'Step Up', resolution: 'other_kind' }]);
  });

  it('keeps ambiguous and unknown members in place and reports them', () => {
    const plan = planUnit({ accepted_authorities: ['DCA', 'MHA', 'Smyrna Housing Office'] }, ENTRIES);
    expect(plan.write?.next).toEqual(['Georgia Department of Community Affairs', 'MHA', 'Smyrna Housing Office']);
    expect(plan.leftovers).toEqual([
      { field: 'accepted_authorities', value: 'MHA', resolution: 'ambiguous' },
      { field: 'accepted_authorities', value: 'Smyrna Housing Office', resolution: 'unknown' },
    ]);
  });

  it('backfills a jurisdiction-only unit from its resolved value, or the raw value', () => {
    // The audit is about the LIST, which was absent: from '' (plan 3.8) - so
    // even a raw backfill never reads "X -> X" on the property's Activity tab.
    expect(planUnit({ jurisdiction: 'East Point' }, ENTRIES)).toEqual({
      write: { expected: null, next: ['East Point Housing Authority'] },
      audits: [{ field: 'accepted_authorities', from: '', to: 'East Point Housing Authority' }],
      changes: { jurisdictionBackfilled: 1 },
      leftovers: [],
    });
    const raw = planUnit({ jurisdiction: 'Smyrna Housing Office' }, ENTRIES);
    expect(raw.write).toEqual({ expected: null, next: ['Smyrna Housing Office'] });
    expect(raw.audits).toEqual([{ field: 'accepted_authorities', from: '', to: 'Smyrna Housing Office' }]);
    expect(raw.leftovers).toEqual([{ field: 'accepted_authorities', value: 'Smyrna Housing Office', resolution: 'unknown' }]);
  });

  it('never uses jurisdiction once the unit stores a list - even an empty one (ruling R1-F1)', () => {
    expect(planUnit({ accepted_authorities: [], jurisdiction: 'East Point' }, ENTRIES)).toEqual(NOTHING);
  });

  it('plans nothing for a list of exact names', () => {
    expect(
      planUnit({ accepted_authorities: ['Atlanta Housing Authority', 'Georgia Department of Community Affairs'] }, ENTRIES),
    ).toEqual(NOTHING);
  });

  it('refuses to plan a list holding a non-string member', () => {
    expect(() => planUnit({ accepted_authorities: ['Atlanta Housing Authority', 42] }, ENTRIES)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The run, against DynamoDB Local (self-skipping like the template's tests)
// ---------------------------------------------------------------------------

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}
const reachable = await endpointReachable();
if (!reachable) console.warn(`[cleanOrgNames] SKIPPED - no DynamoDB Local at ${endpoint}.`);

const NOW = '2026-10-06T12:00:00.000Z';
const HUMAN_AT = '2026-09-01T09:00:00.000Z';
const READ_COMMANDS = new Set(['ScanCommand', 'QueryCommand', 'GetCommand']);
const silent = createLogger({ level: 'silent' });

/** A client that records every command's class name, then sends it for real. */
function recordingClient(inner: DynamoDBDocumentClient): { doc: DynamoDBDocumentClient; sent: string[] } {
  const sent: string[] = [];
  const doc = {
    send: async (command: { constructor: { name: string } }) => {
      sent.push(command.constructor.name);
      return await inner.send(command as never);
    },
    destroy: () => {},
  } as unknown as DynamoDBDocumentClient;
  return { doc, sent };
}

/** What the seeded world's run plans (dry run) and writes (apply). */
const CHANGES = {
  housingAuthorityRewritten: 1,
  movedToAgency: 2,
  agencyConflicts: 1,
  agencyRewritten: 1,
  unitMembersRewritten: 2,
  unitAgencyMembersDropped: 1,
  unitAgencyMembersKept: 1,
  unitDuplicatesRemoved: 1,
  jurisdictionBackfilled: 2,
};

/** ...and what it leaves for the Settings page (by field, most held first, then by value). */
const LEFTOVERS: CleanupLeftover[] = [
  { field: 'housingAuthority', value: 'AHA', count: 1, deletedCount: 1, resolution: 'ambiguous' },
  { field: 'housingAuthority', value: 'HUD VASH', count: 1, deletedCount: 0, resolution: 'other_kind' },
  { field: 'housingAuthority', value: 'Smyrna Housing Office', count: 1, deletedCount: 0, resolution: 'unknown' },
  { field: 'accepted_authorities', value: 'MHA', count: 1, deletedCount: 0, resolution: 'ambiguous' },
  { field: 'accepted_authorities', value: 'Smyrna Housing Office', count: 0, deletedCount: 1, resolution: 'unknown' },
  { field: 'accepted_authorities', value: 'Step Up', count: 1, deletedCount: 0, resolution: 'other_kind' },
];

/** One org_name_cleanup event per changed field: [entityKey, payload] - strings only, '' = absent or removed. */
const EVENTS: Array<[string, Record<string, unknown>]> = [
  ['contacts#c-spelling', { field: 'housingAuthority', from: 'Atlanta (AHA)', to: 'Atlanta Housing Authority' }],
  ['contacts#c-agency-as-ha', { field: 'housingAuthority', from: 'Hope Atlanta', to: '' }],
  ['contacts#c-agency-as-ha', { field: 'agency', from: '', to: 'HOPE Atlanta' }],
  ['contacts#c-agency-empty', { field: 'housingAuthority', from: 'Claratel', to: '' }],
  ['contacts#c-agency-empty', { field: 'agency', from: '', to: 'Claratel Behavioral Health' }],
  ['contacts#c-agency-spelling', { field: 'agency', from: 'Caring Works', to: 'CaringWorks' }],
  [
    'units#u-import-owned',
    {
      field: 'accepted_authorities',
      from: 'Atlanta Housing, Hope Atlanta, Atlanta Housing Authority',
      to: 'Atlanta Housing Authority',
    },
  ],
  [
    'units#u-human-owned',
    { field: 'accepted_authorities', from: 'DCA, MHA', to: 'Georgia Department of Community Affairs, MHA' },
  ],
  ['units#u-legacy', { field: 'accepted_authorities', from: '', to: 'East Point Housing Authority' }],
  ['units#u-legacy-deleted', { field: 'accepted_authorities', from: '', to: 'Smyrna Housing Office' }],
];

const eventKey = ([entityKey, payload]: [unknown, unknown]): string =>
  `${String(entityKey)}|${String((payload as { field?: unknown }).field)}`;
const sortEvents = (list: Array<[unknown, unknown]>): Array<[unknown, unknown]> =>
  [...list].sort((a, b) => (eventKey(a) < eventKey(b) ? -1 : eventKey(a) > eventKey(b) ? 1 : 0));

describe.skipIf(!reachable)('clean-org-names against DynamoDB Local', () => {
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const created: string[] = [];

  afterEach(async () => {
    for (const table of created.splice(0)) await deleteTableIfExists(client, table);
  }, 120_000);

  /** A fresh table set under its own prefix, one record per case. */
  async function seedWorld(opts: { orgList?: OrgListItem } = {}) {
    const env = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
    for (const base of ['contacts', 'units', 'settings', 'audit_events'] as const) {
      await ensureTable(client, getTableSpec(base), tableName(base, env));
      created.push(tableName(base, env));
    }
    const put = (base: 'contacts' | 'units', item: Record<string, unknown>) =>
      doc.send(new PutCommand({ TableName: tableName(base, env), Item: item }));
    const contact = (contactId: string, fields: Record<string, unknown>) =>
      put('contacts', { contactId, type: 'tenant', status: 'searching', created_at: NOW, ...fields });
    const unit = (unitId: string, fields: Record<string, unknown>) =>
      put('units', { unitId, landlordId: 'c-landlord', status: 'available', created_at: NOW, ...fields });

    await contact('c-spelling', { housingAuthority: 'Atlanta (AHA)' });
    await contact('c-agency-as-ha', { type: 'partner', status: 'active', housingAuthority: 'Hope Atlanta' });
    await contact('c-agency-empty', { housingAuthority: 'Claratel', agency: '' });
    await contact('c-conflict', { housingAuthority: 'HUD VASH', agency: 'Step Up' });
    await contact('c-ambiguous', { housingAuthority: 'AHA' });
    await contact('c-ambiguous-deleted', { housingAuthority: 'AHA', deleted_at: NOW });
    await contact('c-unknown', { type: 'landlord', status: 'active', housingAuthority: 'Smyrna Housing Office' });
    await contact('c-on-list', { housingAuthority: 'Atlanta Housing Authority', agency: 'Mercy Care' });
    await contact('c-agency-spelling', { agency: 'Caring Works' });
    await put('contacts', { contactId: 'phoneref#+15550000009', phone: '+15550000009', phone_ref: true, phone_ref_owner: 'c-on-list' });
    await unit('u-import-owned', { accepted_authorities: ['Atlanta Housing', 'Hope Atlanta', 'Atlanta Housing Authority'] });
    await unit('u-human-owned', { accepted_authorities: ['DCA', 'MHA'], updated_at: HUMAN_AT });
    await unit('u-only-agency', { accepted_authorities: ['Step Up'] });
    await unit('u-legacy', { jurisdiction: 'East Point' });
    await unit('u-legacy-deleted', { status: 'off_market', jurisdiction: 'Smyrna Housing Office', deleted_at: NOW });
    if (opts.orgList !== undefined) await createOrgListRepo({ doc, env }).putForSeed(opts.orgList);

    const keyName = { contacts: 'contactId', units: 'unitId' } as const;
    const get = async (base: 'contacts' | 'units', id: string): Promise<Record<string, unknown> | undefined> =>
      (await doc.send(new GetCommand({ TableName: tableName(base, env), Key: { [keyName[base]]: id } }))).Item;
    const scanTable = async (base: string): Promise<string[]> =>
      ((await doc.send(new ScanCommand({ TableName: tableName(base, env) }))).Items ?? [])
        .map((item) => JSON.stringify(item))
        .sort();
    const cleanupEvents = async (): Promise<Record<string, unknown>[]> =>
      ((await doc.send(new ScanCommand({ TableName: tableName('audit_events', env) }))).Items ?? []).filter(
        (e) => e['event_type'] === 'org_name_cleanup',
      );
    return { env, get, scanTable, cleanupEvents, orgList: createOrgListRepo({ doc, env }) };
  }

  it('dry run: plans the automatic mappings, lists what it leaves, and writes NOTHING - not even the org-list item', async () => {
    const w = await seedWorld();
    const before = {
      contacts: await w.scanTable('contacts'),
      units: await w.scanTable('units'),
      settings: await w.scanTable('settings'),
      audit: await w.scanTable('audit_events'),
    };
    const recorder = recordingClient(doc);
    const result = await cleanOrgNames({ doc: recorder.doc, env: w.env, logger: silent });
    expect(result).toEqual({
      listSource: 'starting', // no item stored yet: the pre-deploy dry run
      contactsScanned: 9,
      unitsScanned: 5,
      pointerRows: 1,
      recordsPlanned: 8,
      recordsWritten: 0,
      skippedOnCondition: 0,
      failed: 0,
      auditFailed: 0,
      changes: CHANGES,
      contactsMissingTypeOrStatus: 0,
      leftovers: LEFTOVERS,
    });
    // The Scan paging loop: two rows a page reaches the same plan.
    expect(await cleanOrgNames({ doc: recorder.doc, env: w.env, logger: silent, scanLimit: 2 })).toEqual(result);
    // WRITES NOTHING, three ways: only reads were sent, not one item changed,
    // and the org-list item was never created.
    expect(recorder.sent).toContain('ScanCommand');
    expect(recorder.sent.filter((name) => !READ_COMMANDS.has(name))).toEqual([]);
    expect(await w.scanTable('contacts')).toEqual(before.contacts);
    expect(await w.scanTable('units')).toEqual(before.units);
    expect(await w.scanTable('settings')).toEqual(before.settings);
    expect(await w.scanTable('audit_events')).toEqual(before.audit);
    expect(await w.orgList.peek()).toBeNull();
    expect(reportCleanupRun(result, false, silent)).toBe(0);
    expect(reportCleanupRun({ ...result, failed: 1 }, false, silent)).toBe(1);
  }, 120_000);

  it('counts contacts holding an organization value but lacking type or status (invisible to Settings; expected 0) - and still plans them', async () => {
    const w = await seedWorld();
    // Legacy rows with no byTypeStatus key: this base-table Scan sees them, but
    // the rewrite job, the usage counts and "Not on the list" never do.
    const put = (item: Record<string, unknown>) =>
      doc.send(new PutCommand({ TableName: tableName('contacts', w.env), Item: item }));
    await put({ contactId: 'c-no-type', status: 'active', housingAuthority: 'Atlanta (AHA)' });
    await put({ contactId: 'c-no-status', type: 'tenant', agency: 'Mercy Care' });
    // Holding nothing (a blank agency): not counted.
    await put({ contactId: 'c-no-type-blank', status: 'active', agency: '' });
    const result = await cleanOrgNames({ doc, env: w.env, logger: silent });
    // Counted only - the plan is unchanged: c-no-type's spelling is still mapped.
    expect(result).toMatchObject({ contactsScanned: 12, contactsMissingTypeOrStatus: 2, recordsPlanned: 9 });
  }, 120_000);

  it('apply: takes the lock, writes each change conditionally with one audit event per field, never stamps updated_at, releases the lock done', async () => {
    const w = await seedWorld();
    const result = await cleanOrgNames({ doc, env: w.env, apply: true, logger: silent });
    expect(result).toEqual({
      listSource: 'stored', // taking the lock created the item (create-only)
      contactsScanned: 9,
      unitsScanned: 5,
      pointerRows: 1,
      recordsPlanned: 8,
      recordsWritten: 8,
      skippedOnCondition: 0,
      failed: 0,
      auditFailed: 0,
      changes: CHANGES,
      contactsMissingTypeOrStatus: 0,
      leftovers: LEFTOVERS,
    });

    // Contacts: spellings rewritten; agencies moved out of the housing authority.
    expect(await w.get('contacts', 'c-spelling')).toMatchObject({ housingAuthority: 'Atlanta Housing Authority' });
    const moved = await w.get('contacts', 'c-agency-as-ha');
    expect(moved?.['housingAuthority']).toBeUndefined();
    expect(moved?.['agency']).toBe('HOPE Atlanta');
    const fromEmpty = await w.get('contacts', 'c-agency-empty');
    expect(fromEmpty?.['housingAuthority']).toBeUndefined();
    expect(fromEmpty?.['agency']).toBe('Claratel Behavioral Health');
    expect(await w.get('contacts', 'c-conflict')).toMatchObject({ housingAuthority: 'HUD VASH', agency: 'Step Up' });
    expect(await w.get('contacts', 'c-ambiguous')).toMatchObject({ housingAuthority: 'AHA' });
    expect(await w.get('contacts', 'c-agency-spelling')).toMatchObject({ agency: 'CaringWorks' });

    // Units: rewritten, agency dropped, de-duplicated, backfilled - updated_at NEVER stamped.
    const imported = await w.get('units', 'u-import-owned');
    expect(imported?.['accepted_authorities']).toEqual(['Atlanta Housing Authority']);
    expect(imported?.['updated_at']).toBeUndefined();
    expect(await w.get('units', 'u-human-owned')).toMatchObject({
      accepted_authorities: ['Georgia Department of Community Affairs', 'MHA'],
      updated_at: HUMAN_AT,
    });
    expect(await w.get('units', 'u-only-agency')).toMatchObject({ accepted_authorities: ['Step Up'] });
    const legacy = await w.get('units', 'u-legacy');
    expect(legacy).toMatchObject({ accepted_authorities: ['East Point Housing Authority'], jurisdiction: 'East Point' });
    expect(legacy?.['updated_at']).toBeUndefined();
    expect(await w.get('units', 'u-legacy-deleted')).toMatchObject({ accepted_authorities: ['Smyrna Housing Office'] });

    // Audit: one org_name_cleanup event per changed field - exactly { field, from, to }, no actor.
    const events = await w.cleanupEvents();
    expect(sortEvents(events.map((e) => [e['entityKey'], e['payload']]))).toEqual(sortEvents(EVENTS));
    for (const e of events) {
      expect(e['actorId']).toBeUndefined();
      expect(Object.keys(e['payload'] as object).sort()).toEqual(['field', 'from', 'to']);
    }

    // The lock: taken as `cleanup`, finished `done` with the counts.
    const lock = (await w.orgList.peek())?.lastRewrite;
    expect(lock).toMatchObject({ action: 'cleanup', status: 'done', startedBy: 'clean-org-names' });
    expect(lock?.counts).toMatchObject({ recordsWritten: 8, movedToAgency: 2 });

    // Re-running is safe: nothing left to change, no new event.
    const again = await cleanOrgNames({ doc, env: w.env, apply: true, logger: silent });
    expect(again).toMatchObject({ recordsPlanned: 0, recordsWritten: 0, leftovers: LEFTOVERS });
    expect(await w.cleanupEvents()).toHaveLength(EVENTS.length);
  }, 120_000);

  it('apply refuses while another rewrite holds the lock (fresh heartbeat): nothing is read or written', async () => {
    const at = new Date().toISOString();
    const running: OrgRewriteState = {
      jobId: 'job-rename',
      action: 'rename',
      fromTexts: ['Old Name'],
      fields: ['housingAuthority', 'accepted_authorities'],
      toName: 'New Name',
      status: 'running',
      heartbeatAt: at,
      startedAt: at,
      startedBy: 'user-0001',
    };
    const w = await seedWorld({ orgList: { settingId: 'org-list', version: 1, entries: ENTRIES, lastRewrite: running } });
    const before = await w.scanTable('contacts');
    await expect(cleanOrgNames({ doc, env: w.env, apply: true, logger: silent })).rejects.toBeInstanceOf(
      CleanupRefusedError,
    );
    expect(await w.scanTable('contacts')).toEqual(before);
    expect((await w.orgList.peek())?.lastRewrite).toEqual(running);
  }, 120_000);

  it('apply takes over a STALE lock (no heartbeat for over 15 minutes - a hard-killed run)', async () => {
    const stale = new Date(Date.now() - 16 * 60_000).toISOString();
    const killed: OrgRewriteState = {
      jobId: 'job-killed',
      action: 'cleanup',
      fromTexts: [],
      fields: ['housingAuthority', 'agency', 'accepted_authorities'],
      status: 'running',
      heartbeatAt: stale,
      startedAt: stale,
      startedBy: 'clean-org-names',
    };
    const w = await seedWorld({ orgList: { settingId: 'org-list', version: 1, entries: ENTRIES, lastRewrite: killed } });
    const result = await cleanOrgNames({ doc, env: w.env, apply: true, logger: silent });
    expect(result.recordsWritten).toBe(8);
    const lock = (await w.orgList.peek())?.lastRewrite;
    expect(lock).toMatchObject({ action: 'cleanup', status: 'done' });
    expect(lock?.jobId).not.toBe('job-killed');
  }, 120_000);

  it('an abort logs a PARTIAL report, releases the lock as failed, and rethrows; a re-run finishes the job', async () => {
    const w = await seedWorld();
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const boom = new Error('units table unavailable');
    await expect(
      cleanOrgNames({
        doc,
        env: w.env,
        apply: true,
        logger: log,
        deps: {
          units: {
            rewriteAcceptedAuthorities: async () => {
              throw boom;
            },
          },
        },
      }),
    ).rejects.toBe(boom);
    expect(capture.atLevel(50).some((l) => String(l['msg']).includes('PARTIAL result'))).toBe(true);
    const lock = (await w.orgList.peek())?.lastRewrite;
    expect(lock).toMatchObject({ action: 'cleanup', status: 'failed' });
    expect(lock?.error).toContain('units table unavailable');
    // Contacts are walked first, so theirs landed before the abort...
    expect(await w.get('contacts', 'c-spelling')).toMatchObject({ housingAuthority: 'Atlanta Housing Authority' });
    // ...and a re-run (the failed lock does not block) writes the four units.
    const rerun = await cleanOrgNames({ doc, env: w.env, apply: true, logger: silent });
    expect(rerun).toMatchObject({ recordsWritten: 4, failed: 0 });
  }, 120_000);

  // Code review R1-ADV-BE-4: the append runs AFTER the record write landed, so
  // aborting on it left a permanent gap - a re-run finds the record clean and
  // never writes the event. Logged WARN with the record key, counted, and the
  // run goes on (as the org.rewrite pass does).
  it.each([
    {
      what: 'a contact (its other event still lands)',
      failKey: 'contacts#c-agency-as-ha',
      base: 'contacts',
      id: 'c-agency-as-ha',
      after: { agency: 'HOPE Atlanta' },
    },
    {
      what: 'a unit',
      failKey: 'units#u-legacy',
      base: 'units',
      id: 'u-legacy',
      after: { accepted_authorities: ['East Point Housing Authority'] },
    },
  ] as const)(
    'an audit append that fails for $what is logged WARN and counted auditFailed; the apply completes',
    async ({ failKey, base, id, after }) => {
      const w = await seedWorld();
      const real = buildCleanupDeps(doc, w.env, silent);
      const capture = createLogCapture();
      const log = createLogger({ level: 'info', destination: capture.stream });
      let thrown = false;
      const result = await cleanOrgNames({
        doc,
        env: w.env,
        apply: true,
        logger: log,
        deps: {
          audit: {
            async append(entityKey, eventType, payload) {
              if (entityKey === failKey && !thrown) {
                thrown = true;
                throw new Error('Rate exceeded');
              }
              await real.audit.append(entityKey, eventType, payload);
            },
          },
        },
      });
      // Completed: every record written, the one gap counted - no PARTIAL, exit 0, the lock done.
      expect(result).toMatchObject({ recordsWritten: 8, failed: 0, auditFailed: 1 });
      expect(capture.atLevel(50).some((l) => String(l['msg']).includes('PARTIAL result'))).toBe(false);
      expect(capture.atLevel(40).filter((l) => l['entityKey'] === failKey)).toHaveLength(1);
      expect(reportCleanupRun(result, true, silent)).toBe(0);
      expect((await w.orgList.peek())?.lastRewrite).toMatchObject({ action: 'cleanup', status: 'done' });
      // The record was rewritten all the same...
      expect(await w.get(base, id)).toMatchObject(after);
      // ...and every OTHER event landed: only the first event of that record is missing.
      const gap = EVENTS.findIndex(([entityKey]) => entityKey === failKey);
      const events = await w.cleanupEvents();
      expect(sortEvents(events.map((e) => [e['entityKey'], e['payload']]))).toEqual(
        sortEvents(EVENTS.filter((_, i) => i !== gap)),
      );
    },
    120_000,
  );

  it('a record it cannot plan is stepped over and counted failed: COMPLETED WITH FAILURES, lock finished failed', async () => {
    const w = await seedWorld();
    await doc.send(
      new PutCommand({
        TableName: tableName('units', w.env),
        Item: { unitId: 'u-broken', landlordId: 'c-landlord', status: 'available', accepted_authorities: ['Atlanta Housing Authority', 42] },
      }),
    );
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const result = await cleanOrgNames({ doc, env: w.env, apply: true, logger: log });
    expect(result).toMatchObject({ failed: 1, recordsWritten: 8 });
    expect(capture.atLevel(50).some((l) => l['unitId'] === 'u-broken')).toBe(true);
    expect(reportCleanupRun(result, true, silent)).toBe(1);
    expect((await w.orgList.peek())?.lastRewrite).toMatchObject({ action: 'cleanup', status: 'failed' });
  }, 120_000);

  it('a record that changes between the read and the write is skipped (conditional write) - never overwritten', async () => {
    const w = await seedWorld();
    const real = buildCleanupDeps(doc, w.env, silent);
    const racing: CleanupDeps['contacts'] = {
      async rewriteOrgFields(contactId, expected, next) {
        if (contactId === 'c-spelling') {
          // Staff picked another authority after the Scan read the row.
          await doc.send(
            new UpdateCommand({
              TableName: tableName('contacts', w.env),
              Key: { contactId },
              UpdateExpression: 'SET housingAuthority = :v',
              ExpressionAttributeValues: { ':v': 'Decatur Housing Authority' },
            }),
          );
        }
        return real.contacts.rewriteOrgFields(contactId, expected, next);
      },
    };
    const result = await cleanOrgNames({ doc, env: w.env, apply: true, logger: silent, deps: { contacts: racing } });
    expect(result).toMatchObject({ skippedOnCondition: 1, recordsWritten: 7 });
    expect(await w.get('contacts', 'c-spelling')).toMatchObject({ housingAuthority: 'Decatur Housing Authority' });
    expect((await w.cleanupEvents()).some((e) => e['entityKey'] === 'contacts#c-spelling')).toBe(false);
  }, 120_000);

  it('heartbeats the lock on elapsed time, before records it does not write too, under its own job id', async () => {
    const w = await seedWorld();
    const real = buildCleanupDeps(doc, w.env, silent);
    const beats: string[] = [];
    let clock = 0;
    const result = await cleanOrgNames({
      doc,
      env: w.env,
      apply: true,
      logger: silent,
      now: () => (clock += 30_000),
      deps: {
        lock: {
          acquireForCleanup: (actor) => real.lock.acquireForCleanup(actor),
          heartbeat: async (jobId) => {
            beats.push(jobId);
            return real.lock.heartbeat(jobId);
          },
          finish: (jobId, outcome) => real.lock.finish(jobId, outcome),
        },
      },
    });
    expect(result.recordsWritten).toBe(8);
    // Every row read is 30 s later on this clock, so EVERY row beats first -
    // the eight it writes and the seven it does not (the pointer row included):
    // nine contacts, one pointer row, five units.
    expect(beats).toHaveLength(9 + 1 + 5);
    expect(new Set(beats)).toEqual(new Set([(await w.orgList.peek())?.lastRewrite?.jobId]));
  }, 120_000);

  it('stops writing at once when a heartbeat finds the lock gone, and never finishes a lock that is not its own', async () => {
    const w = await seedWorld();
    const real = buildCleanupDeps(doc, w.env, silent);
    const before = { contacts: await w.scanTable('contacts'), units: await w.scanTable('units') };
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const finished: string[] = [];
    let clock = 0;
    await expect(
      cleanOrgNames({
        doc,
        env: w.env,
        apply: true,
        logger: log,
        now: () => (clock += 30_000),
        deps: {
          lock: {
            acquireForCleanup: (actor) => real.lock.acquireForCleanup(actor),
            // Another rewrite took the lock over: the heartbeat says it is not ours.
            heartbeat: async () => false,
            finish: async (jobId, outcome) => {
              finished.push(jobId);
              await real.lock.finish(jobId, outcome);
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(CleanupLockLostError);
    // The first row's heartbeat stopped it: nothing written at all.
    expect(await w.scanTable('contacts')).toEqual(before.contacts);
    expect(await w.scanTable('units')).toEqual(before.units);
    expect(capture.atLevel(50).some((l) => String(l['msg']).includes('PARTIAL result'))).toBe(true);
    expect(finished).toEqual([]);
    expect((await w.orgList.peek())?.lastRewrite).toMatchObject({ action: 'cleanup', status: 'running' });
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The CLI and what it prints
// ---------------------------------------------------------------------------

const SUMMARY_RESULT: CleanupResult = {
  listSource: 'starting',
  contactsScanned: 9,
  unitsScanned: 5,
  pointerRows: 1,
  recordsPlanned: 8,
  recordsWritten: 0,
  skippedOnCondition: 0,
  failed: 0,
  auditFailed: 0,
  changes: CHANGES,
  contactsMissingTypeOrStatus: 0,
  leftovers: [
    { field: 'housingAuthority', value: 'AHA', count: 1, deletedCount: 1, resolution: 'ambiguous' },
    { field: 'agency', value: 'Atlanta Housing Authority', count: 1, deletedCount: 0, resolution: 'other_kind' },
    { field: 'accepted_authorities', value: 'Step Up', count: 1, deletedCount: 0, resolution: 'other_kind' },
  ],
};

describe('formatSummary - what the CLI prints (organization values only, never a person)', () => {
  it('prints every change count, then each value left with its counts and why', () => {
    const lines = formatSummary(SUMMARY_RESULT, false);
    expect(lines[0]).toBe('Automatic changes this run WOULD make (dry run):');
    expect(lines).toContain('       2  agency named as housing authority -> moved to Agency');
    expect(lines).toContain('Left for Settings > Housing authorities & agencies > Not on the list (3 value(s)):');
    expect(lines).toContain('  housingAuthority  "AHA"  x1 (+1 deleted)  - a spelling more than one listed name shares');
    expect(lines).toContain('  agency  "Atlanta Housing Authority"  x1  - a housing authority, not an agency');
    expect(lines).toContain('  accepted_authorities  "Step Up"  x1  - an agency, not a housing authority');
    expect(formatSummary(SUMMARY_RESULT, true)[0]).toBe('Automatic changes made:');
    expect(formatSummary({ ...SUMMARY_RESULT, leftovers: [] }, true)).toContain(
      'Nothing is left for Settings > Housing authorities & agencies: every value is a list name.',
    );
    // Beside the leftovers (worklist RG-5), with or without any: the contacts
    // the Settings page cannot see. Expected 0.
    expect(lines.at(-1)).toBe(
      'Contacts missing type or status but holding a housing authority or agency: 0 (expected 0 - Settings cannot see or rewrite them)',
    );
    expect(formatSummary({ ...SUMMARY_RESULT, leftovers: [], contactsMissingTypeOrStatus: 2 }, true).at(-1)).toBe(
      'Contacts missing type or status but holding a housing authority or agency: 2 (expected 0 - Settings cannot see or rewrite them)',
    );
    // An apply's audit gaps (code review R1-ADV-BE-4), under the change
    // counts. A dry run appends no event, so it prints no such line.
    const AUDIT_LINE =
      'Audit events that could not be written: 1 (expected 0 - each record change landed; each gap is named in a WARN line)';
    const applied = formatSummary({ ...SUMMARY_RESULT, auditFailed: 1 }, true);
    expect(applied[applied.indexOf('       1  housing authority spelling -> its list name') + 9]).toBe(AUDIT_LINE);
    expect(lines.some((l) => l.startsWith('Audit events'))).toBe(false);
  });
});

describe('the CLI', () => {
  it('dry run by default; --apply writes; --lane is local only; anything else is a usage error', () => {
    const dry = parseStageArgs(['--env', 'prod'], CLEANUP_ARGS);
    if ('usage' in dry) throw new Error('expected a parse');
    expect(dry.target).toBe('prod');
    expect(dry.flags.has('--apply')).toBe(false);
    const lane = parseStageArgs(['--env', 'local', '--lane', '4', '--apply'], CLEANUP_ARGS);
    if ('usage' in lane) throw new Error('expected a parse');
    expect(lane).toMatchObject({ target: 'local', lane: 4 });
    expect(lane.flags.has('--apply')).toBe(true);
    for (const argv of [
      ['--env', 'dev', '--dry-run'],
      ['--env', 'dev', '--lane', '2'],
      ['--env', 'dev', '--apply', '--apply'],
      ['--apply'],
      ['--env', 'dev', '--merge'],
    ]) {
      expect(parseStageArgs(argv, CLEANUP_ARGS)).toEqual({ usage: true });
    }
  });

  it('resolves the stage before any read, exits 2 on usage, and maps the lock refusal', () => {
    const source = readFileSync(join(process.cwd(), 'scripts', 'clean-org-names.ts'), 'utf8');
    expect(source).toContain('parseStageArgs(process.argv.slice(2), CLEANUP_ARGS)');
    expect(source).toContain('process.exit(2)');
    expect(source.indexOf('resolveStageClient(')).toBeGreaterThan(-1);
    expect(source.indexOf('resolveStageClient(')).toBeLessThan(source.indexOf('await cleanOrgNames('));
    expect(source).toContain('err instanceof CleanupRefusedError');
    expect(source).toContain('stage.doc.destroy()');
    // The CLI names the failure itself; it never claims a PARTIAL report that
    // only a mid-run abort logs.
    expect(source).toContain('FAILED: ${err instanceof Error ? err.message : String(err)}');
    expect(source).not.toContain('see the PARTIAL report above');
  });
});
