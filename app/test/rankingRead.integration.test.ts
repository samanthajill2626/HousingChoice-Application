// The ranking read on DynamoDB Local (WP1 B2a spec D9, D13; WI18, WI11):
// the real repositories, the real gatherer (assembleRanking) and the real
// read, on a throwaway TABLE_PREFIX.
//
// WI18 (PR24): a 150-tenant property read. The 5 s budget is asserted under
// RANKING_READ_BUDGET=1 (the S6 report's measurement, this file run alone);
// inside the shared npm test run a 20 s ceiling is asserted, because a
// wall-clock budget under suite-wide DynamoDB Local contention measures the
// neighbours, not the read. Every run prints the timings.
//
// WI11: matches are written with the CURRENT fingerprints, the stored facts
// are mutated, and the read decides: a bare send, a re-send that re-orders,
// a ninth send that pushes an entry off the listed ones, the first send of a
// home a Notes line already names, a tour roster change, and an edit to a
// home with feedback only change NOTHING; a decline, a tour, a feedback line
// on any property, and an edit to a declined seen home change the tenant
// card; a decline of the pair itself changes its pair history.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BatchWriteCommand,
  PutCommand,
  UpdateCommand,
  type BatchWriteCommandInput,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { loadConfig, tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createMatchesRepo, type MatchRow } from '../src/repos/matchesRepo.js';
import { assembleRanking, createAssembleDeps } from '../src/services/ranking/assemble.js';
import { EXAMPLES_VERSION } from '../src/services/ranking/examples.js';
import { isVerified } from '../src/services/ranking/job.js';
import { createRankingReadDeps, currentRankingModel, readRanking } from '../src/services/ranking/readRanking.js';
import { RUBRIC_VERSION } from '../src/services/ranking/rubric.js';
import { createLogCapture } from './helpers/logCapture.js';

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
if (!reachable) {
  console.warn(`[rankingRead.integration] DynamoDB Local is required at ${endpoint}`);
}

const TABLES = ['contacts', 'units', 'listing_sends', 'tours', 'placements', 'settings', 'matches', 'ai_runs'] as const;
const DAY_MS = 86_400_000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

async function batchPut(doc: DynamoDBDocumentClient, table: string, items: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    let pending: NonNullable<BatchWriteCommandInput['RequestItems']> = {
      [table]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })),
    };
    let written = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const out = await doc.send(new BatchWriteCommand({ RequestItems: pending }));
      const left = out.UnprocessedItems?.[table];
      if (left === undefined || left.length === 0) {
        written = true;
        break;
      }
      pending = { [table]: left } as NonNullable<BatchWriteCommandInput['RequestItems']>;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
    // A seeding shortfall fails HERE, never later as a ranking defect (WORKLIST WL-S6-2).
    if (!written) throw new Error(`batchPut: items for ${table} still unprocessed after 10 attempts`);
  }
}

function harness(label: string) {
  // hc-test- so test/globalTeardown.ts's residue sweep covers an interrupted run (WORKLIST WL-S6-1).
  const env = { TABLE_PREFIX: `hc-test-rkread-${label}-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  // PR30: name the local endpoint, so S2's config resolves the local-table
  // defaults (outside production on real tables the driver would default to
  // anthropic and the worker poll to off).
  const config = loadConfig({ NODE_ENV: 'test', DYNAMODB_ENDPOINT: endpoint, ...env });
  const t = (base: (typeof TABLES)[number]): string => tableName(base, env);
  return {
    env, client, doc, logger, config, t,
    async setup() {
      for (const base of TABLES) await ensureTable(client, getTableSpec(base), t(base));
    },
    async teardown() {
      for (const base of TABLES) await deleteTableIfExists(client, t(base));
      doc.destroy();
      client.destroy();
    },
  };
}

let phoneSeq = 0;
function tenant(contactId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  phoneSeq += 1;
  return {
    contactId,
    type: 'tenant',
    status: 'searching',
    phone: `+1555${String(phoneSeq).padStart(7, '0')}`,
    firstName: `Synth${phoneSeq}`,
    lastName: 'Example',
    voucherSize: 2,
    last_heard_from_at: daysAgo(1),
    created_at: daysAgo(30),
    ...over,
  };
}

function unit(unitId: string, line1: string, status: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { unitId, landlordId: 'synthetic-landlord', status, address: { line1, city: 'Atlanta', state: 'GA', zip: '30301' }, created_at: daysAgo(60), ...over };
}

function send(unitId: string, contactId: string, sentAt: string): Record<string, unknown> {
  return { unitId, contactId, sentAt, via: 'broadcast', created_at: sentAt, updated_at: sentAt };
}

function tour(tenantId: string, unitId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tourId: `tour-${randomUUID().slice(0, 8)}`,
    tenantId,
    unitId,
    _schedPartition: 'tours',
    tourType: 'landlord_led',
    status: 'scheduled',
    scheduledAt: daysAgo(-2),
    createdAt: daysAgo(1),
    ...over,
  };
}

function currentRow(config: ReturnType<typeof loadConfig>, tenantId: string, unitId: string, fingerprints: MatchRow['fingerprints'], score: number): MatchRow {
  return {
    tenantId, unitId, schema: 2, score, for: [], against: [], missing: [], failedRequirements: [], fairHousingFlags: [],
    stage: 1, rubricVersion: RUBRIC_VERSION, examplesVersion: EXAMPLES_VERSION, promptFingerprint: 'fp-int',
    model: currentRankingModel(config), runId: 'int-run', jobGeneration: 'int-gen', computedAt: new Date().toISOString(),
    anchorSide: 'unit', fingerprints, inputSnapshot: '', expires_at: Math.floor(Date.now() / 1000) + 180 * 86_400,
  };
}

describe.skipIf(!reachable)('WI18: a 150-tenant property read on DynamoDB Local', () => {
  const h = harness('budget');
  const anchor = { kind: 'unit' as const, id: 'budget-anchor' };

  beforeAll(async () => {
    await h.setup();
    await batchPut(h.doc, h.t('units'), [
      unit(anchor.id, '100 Budget Ave', 'available'),
      ...[1, 2, 3, 4, 5].map((n) => unit(`budget-seen-${n}`, `${n} Seen Way`, 'occupied')),
    ]);
    const tenants = Array.from({ length: 150 }, (_, i) =>
      tenant(`budget-t-${i}`, i % 3 === 0 ? { notes: '[Auto - Oct 2] 1 Seen Way, Atlanta: liked the yard' } : {}),
    );
    await batchPut(h.doc, h.t('contacts'), tenants);
    await batchPut(
      h.doc,
      h.t('listing_sends'),
      tenants.flatMap((_, i) => [0, 1, 2].map((k) => send(`budget-seen-${((i + k) % 5) + 1}`, `budget-t-${i}`, daysAgo(10 - k)))),
    );
    await batchPut(
      h.doc,
      h.t('tours'),
      tenants.filter((_, i) => i % 4 === 0).map((_, j) => tour(`budget-t-${j * 4}`, 'budget-seen-1')),
    );
    const matches = createMatchesRepo({ doc: h.doc, env: h.env, logger: h.logger });
    const written = await matches.putMatches(
      tenants.map((_, i) => currentRow(h.config, `budget-t-${i}`, anchor.id, { tenantCard: 'x', unitCard: 'y', pairHistory: 'z' }, 40 + (i % 60))),
    );
    // putMatches never throws on a DynamoDB failure (PR37): a shortfall must fail the seed (WORKLIST WL-S6-2).
    expect(written.unwritten).toEqual([]);
  }, 300_000);

  afterAll(async () => h.teardown(), 120_000);

  it('reads all 150 rows (each with its match) and prints the time', async () => {
    const deps = createRankingReadDeps({ config: h.config, logger: h.logger, env: h.env, doc: h.doc });
    const timings: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      const read = await readRanking(anchor, { includeOlder: false, now: new Date() }, deps);
      timings.push(performance.now() - started);
      if (read.kind !== 'ok') throw new Error(`read failed: ${read.kind}`);
      expect(read.rows).toHaveLength(150);
      expect(read.rows.every((r) => r.match !== null)).toBe(true);
    }
    console.info(`[WI18] 150-tenant property read, ms: ${timings.map((t) => Math.round(t)).join(', ')}`);
    const ceiling = process.env.RANKING_READ_BUDGET === '1' ? 5_000 : 20_000;
    expect(Math.max(...timings)).toBeLessThan(ceiling);
  }, 120_000);
});

describe.skipIf(!reachable)('WI11: fingerprint invariants through the real gatherer and the read', () => {
  const h = harness('wi11');
  const anchor = { kind: 'unit' as const, id: 'wi11-anchor' };
  const home = (n: number): string => `wi11-h${n}`;
  const labelOf = (n: number): string => `${n} Seen St, Atlanta`;
  const reasons = new Map<string, string[] | undefined>();

  // Each case: its own tenant; the seed writes the before state, the mutation the change.
  const T = {
    bare: 'wi11-bare', resend: 'wi11-resend', ninth: 'wi11-ninth', named: 'wi11-named', roster: 'wi11-roster',
    feedbackOnlyEdit: 'wi11-fbo', decline: 'wi11-decline', tour: 'wi11-tour', feedback: 'wi11-feedback',
    declinedHomeEdit: 'wi11-dhe', pairDecline: 'wi11-pair',
  } as const;
  const rosterTourId = `tour-roster-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await h.setup();
    await batchPut(h.doc, h.t('units'), [
      unit(anchor.id, '200 Anchor Rd', 'available'),
      ...Array.from({ length: 10 }, (_, i) => unit(home(i + 1), `${i + 1} Seen St`, 'occupied', { rent_max: 1500 })),
    ]);
    await batchPut(h.doc, h.t('contacts'), [
      tenant(T.bare),
      tenant(T.resend),
      tenant(T.ninth),
      tenant(T.named, { notes: `[Auto - Oct 2] ${labelOf(3)}: liked the kitchen` }),
      tenant(T.roster),
      tenant(T.feedbackOnlyEdit, { notes: `[Auto - Oct 2] ${labelOf(10)}: too small` }),
      tenant(T.decline),
      tenant(T.tour),
      tenant(T.feedback),
      tenant(T.declinedHomeEdit),
      tenant(T.pairDecline),
    ]);
    await batchPut(h.doc, h.t('listing_sends'), [
      send(home(1), T.bare, daysAgo(10)),
      send(home(1), T.resend, daysAgo(10)),
      send(home(2), T.resend, daysAgo(5)),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => send(home(n), T.ninth, daysAgo(10 - n))),
      send(home(1), T.named, daysAgo(10)),
      send(home(1), T.roster, daysAgo(10)),
      send(home(10), T.feedbackOnlyEdit, daysAgo(10)),
      send(home(1), T.decline, daysAgo(10)),
      send(home(1), T.tour, daysAgo(10)),
      send(home(1), T.feedback, daysAgo(10)),
      { ...send(home(5), T.declinedHomeEdit, daysAgo(10)), declined: { at: daysAgo(9), by: 'staff' } },
      send(anchor.id, T.pairDecline, daysAgo(10)),
    ]);
    await batchPut(h.doc, h.t('tours'), [tour(T.roster, home(1), { tourId: rosterTourId })]);

    // A job "wrote" every pair with the CURRENT fingerprints.
    const assembleDeps = createAssembleDeps({ config: h.config, logger: h.logger, env: h.env, doc: h.doc });
    const before = await assembleRanking(anchor, { includeOlder: false, now: new Date() }, assembleDeps);
    if (!before.ok) throw new Error(`assemble failed: ${before.reason}`);
    const verified = before.candidates.filter(isVerified);
    expect(verified.map((c) => c.candidateId).sort()).toEqual(Object.values(T).sort());
    const matches = createMatchesRepo({ doc: h.doc, env: h.env, logger: h.logger });
    const written = await matches.putMatches(verified.map((c) => currentRow(h.config, c.tenantId, c.unitId, c.fingerprints, 70)));
    // WORKLIST WL-S6-2: a match that did not land must not read as a fingerprint defect.
    expect(written.unwritten).toEqual([]);

    // The mutations.
    const now = new Date().toISOString();
    const sends = h.t('listing_sends');
    await h.doc.send(new PutCommand({ TableName: sends, Item: send(home(2), T.bare, now) }));
    await h.doc.send(new UpdateCommand({
      TableName: sends, Key: { unitId: home(1), contactId: T.resend },
      UpdateExpression: 'SET sentAt = :now, updated_at = :now', ExpressionAttributeValues: { ':now': now },
    }));
    await h.doc.send(new PutCommand({ TableName: sends, Item: send(home(9), T.ninth, now) }));
    await h.doc.send(new PutCommand({ TableName: sends, Item: send(home(3), T.named, now) }));
    // The roster itself changes (roster / rosterVersion, toursRepo.ts), with the group link (WORKLIST WL-S6-3).
    await h.doc.send(new UpdateCommand({
      TableName: h.t('tours'), Key: { tourId: rosterTourId },
      UpdateExpression: 'SET groupThreadId = :g, rosterVersion = :v, #roster = :r',
      ExpressionAttributeNames: { '#roster': 'roster' },
      ExpressionAttributeValues: { ':g': 'conv-wi11-roster', ':v': 1, ':r': [{ contactId: T.roster }] },
    }));
    await h.doc.send(new UpdateCommand({
      TableName: h.t('units'), Key: { unitId: home(10) },
      UpdateExpression: 'SET rent_max = :r', ExpressionAttributeValues: { ':r': 1999 },
    }));
    await h.doc.send(new UpdateCommand({
      TableName: sends, Key: { unitId: home(1), contactId: T.decline },
      UpdateExpression: 'SET declined = :d', ExpressionAttributeValues: { ':d': { at: now, by: 'staff' } },
    }));
    await h.doc.send(new PutCommand({ TableName: h.t('tours'), Item: tour(T.tour, home(2)) }));
    await h.doc.send(new UpdateCommand({
      TableName: h.t('contacts'), Key: { contactId: T.feedback },
      UpdateExpression: 'SET notes = :n, notes_updated_at = :now',
      ExpressionAttributeValues: { ':n': `[Auto - Oct 28] ${labelOf(1)}: liked it`, ':now': now },
    }));
    await h.doc.send(new UpdateCommand({
      TableName: h.t('units'), Key: { unitId: home(5) },
      UpdateExpression: 'SET rent_max = :r', ExpressionAttributeValues: { ':r': 2100 },
    }));
    await h.doc.send(new UpdateCommand({
      TableName: sends, Key: { unitId: anchor.id, contactId: T.pairDecline },
      UpdateExpression: 'SET declined = :d', ExpressionAttributeValues: { ':d': { at: now, by: 'staff' } },
    }));

    const read = await readRanking(
      anchor,
      { includeOlder: false, now: new Date() },
      createRankingReadDeps({ config: h.config, logger: h.logger, env: h.env, doc: h.doc }),
    );
    if (read.kind !== 'ok') throw new Error(`read failed: ${read.kind}`);
    for (const row of read.rows) reasons.set(row.candidateId, row.match?.outOfDate);
  }, 300_000);

  afterAll(async () => h.teardown(), 120_000);

  it.each([
    ['a bare new send', T.bare],
    ['a re-send that re-orders', T.resend],
    ['a ninth send that pushes an entry off the listed ones', T.ninth],
    ['the first send of a home a Notes line already names', T.named],
    ['a tour roster change', T.roster],
    ['an edit to a home with feedback only', T.feedbackOnlyEdit],
  ])('%s changes nothing', (_label, tenantId) => {
    expect(reasons.get(tenantId)).toEqual([]);
  });

  it.each([
    ['a decline on another property', T.decline],
    ['a tour on another property', T.tour],
    ['a feedback line about another property', T.feedback],
    ['an edit to a card field of a declined seen home', T.declinedHomeEdit],
  ])('%s makes the match out of date (tenant card)', (_label, tenantId) => {
    expect(reasons.get(tenantId)).toContain('card');
  });

  it('a decline of the pair itself changes its pair history', () => {
    expect(reasons.get(T.pairDecline)).toContain('pairHistory');
  });
});
