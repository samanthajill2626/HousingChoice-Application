// The fix script (spec D2) against DynamoDB Local: dry run writes nothing;
// apply enables only one-to-one `manual` rows (typeless included, group rows
// and pointer items never); breaker-tripped rows are skipped unless included;
// single mode refuses a group thread or an unknown id as a USAGE error; a
// re-run changes nothing; every change is audited, and a lost audit write is
// named and counted; the conditional write loses to a concurrent change.
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import {
  enableConversationAutomation,
  reportEnableRun,
  UsageError,
} from '../scripts/enable-conversation-automation.js';
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
if (!reachable) console.warn(`[enableConversationAutomation] SKIPPED - no DynamoDB Local at ${endpoint}.`);

const NOW = '2026-09-25T12:00:00.000Z';
const ERROR = 50;

describe.skipIf(!reachable)('enable-conversation-automation against DynamoDB Local', () => {
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const created: string[] = [];

  afterEach(async () => {
    for (const table of created.splice(0)) await deleteTableIfExists(client, table);
  }, 120_000);

  async function seedWorld() {
    const env = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
    for (const base of ['conversations', 'audit_events'] as const) {
      await ensureTable(client, getTableSpec(base), tableName(base, env));
      created.push(tableName(base, env));
    }
    const put = (item: Record<string, unknown>) =>
      doc.send(new PutCommand({ TableName: tableName('conversations', env), Item: item }));
    await put({ conversationId: 'c-import', participant_phone: '+15550000001', status: 'open', last_activity_at: NOW, type: 'unknown_1to1', ai_mode: 'manual', imported_from: 'quo-airtable-import', created_at: NOW });
    await put({ conversationId: 'c-typeless', participant_phone: '+15550000002', status: 'open', last_activity_at: NOW, ai_mode: 'manual', created_at: NOW });
    await put({ conversationId: 'c-breaker', participant_phone: '+15550000003', status: 'open', last_activity_at: NOW, type: 'tenant_1to1', ai_mode: 'manual', created_at: NOW });
    await createAuditRepo({ doc, env }).append('conversations#c-breaker', 'mode_changed', { from: 'auto', to: 'manual', reason: 'breaker_trip' });
    await put({ conversationId: 'c-auto', participant_phone: '+15550000004', status: 'open', last_activity_at: NOW, type: 'tenant_1to1', ai_mode: 'auto', created_at: NOW });
    await put({ conversationId: 'c-unset', participant_phone: '+15550000005', status: 'open', last_activity_at: NOW, type: 'tenant_1to1', created_at: NOW });
    await put({ conversationId: 'c-relay', status: 'open', relay_status: 'relay_group#open', last_activity_at: NOW, type: 'relay_group', ai_mode: 'manual', pool_number: '+15550009001', participant_phone: '+15550009001', created_at: NOW });
    await put({ conversationId: 'c-group', status: 'group_open', last_activity_at: NOW, type: 'group_text', ai_mode: 'manual', created_at: NOW });
    await put({ conversationId: 'phone#+15550000001', ref_conversationId: 'c-import' });
    const mode = async (id: string): Promise<unknown> =>
      (await doc.send(new GetCommand({ TableName: tableName('conversations', env), Key: { conversationId: id } }))).Item?.ai_mode;
    const modeEvents = async (id: string) =>
      ((await doc.send(new ScanCommand({ TableName: tableName('audit_events', env) }))).Items ?? []).filter(
        (e) => e.entityKey === `conversations#${id}` && e.event_type === 'mode_changed',
      );
    return { env, mode, modeEvents };
  }

  it('dry run: plans the one-to-one manual rows (breaker-tripped excluded) and writes NOTHING', async () => {
    const w = await seedWorld();
    const result = await enableConversationAutomation({ doc, env: w.env, now: NOW });
    expect(result).toMatchObject({
      scanned: 8,
      pointerRows: 1,
      groupRows: 2,
      alreadyOn: 1,
      unset: 1,
      breakerTrippedExcluded: 1,
      planned: 2,
      enabled: 0,
      skippedOnCondition: 0,
      auditFailed: 0,
      failed: 0,
    });
    expect(result.byType).toEqual({ unknown_1to1: 1, '(none)': 1 });
    // The Scan paging loop: two rows a page walks every page to the same plan.
    expect(await enableConversationAutomation({ doc, env: w.env, now: NOW, scanLimit: 2 })).toEqual(result);
    expect(await w.mode('c-import')).toBe('manual');
    expect(await w.mode('c-typeless')).toBe('manual');
    expect(await w.modeEvents('c-import')).toHaveLength(0);
    expect(reportEnableRun(result, false)).toBe(0);
  }, 120_000);

  it('apply: enables exactly the planned rows with an audit event each; a SECOND run is a no-op', async () => {
    const w = await seedWorld();
    const first = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true });
    expect(first).toMatchObject({ planned: 2, enabled: 2, breakerTrippedExcluded: 1, skippedOnCondition: 0, auditFailed: 0, failed: 0 });
    expect(await w.mode('c-import')).toBe('auto');
    expect(await w.mode('c-typeless')).toBe('auto');
    // Untouched: breaker-tripped, already-on, unset, group threads, pointer.
    expect(await w.mode('c-breaker')).toBe('manual');
    expect(await w.mode('c-auto')).toBe('auto');
    expect(await w.mode('c-unset')).toBeUndefined();
    expect(await w.mode('c-relay')).toBe('manual');
    expect(await w.mode('c-group')).toBe('manual');
    expect(await w.mode('phone#+15550000001')).toBeUndefined();
    const events = await w.modeEvents('c-import');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      from: 'manual',
      to: 'auto',
      reason: 'bulk_enable',
      script: 'enable-conversation-automation',
    });
    const second = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true });
    expect(second).toMatchObject({ planned: 0, enabled: 0, alreadyOn: 3 });
    expect(await w.modeEvents('c-import')).toHaveLength(1);
  }, 120_000);

  it('apply with --include-breaker-tripped also enables the tripped row, with the same reason', async () => {
    const w = await seedWorld();
    const result = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, includeBreakerTripped: true });
    expect(result).toMatchObject({ planned: 3, enabled: 3, breakerTrippedExcluded: 0 });
    expect(await w.mode('c-breaker')).toBe('auto');
  }, 120_000);

  it('single mode: resumes ONE conversation with the operator_resume reason and names it; refuses a group thread and an unknown id as usage errors', async () => {
    const w = await seedWorld();
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const resumed = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, conversationId: 'c-breaker', logger: log });
    expect(resumed).toMatchObject({ planned: 1, enabled: 1, scanned: 1 });
    expect(await w.mode('c-breaker')).toBe('auto');
    expect((await w.modeEvents('c-breaker')).map((e) => (e.payload as { reason: string }).reason)).toEqual([
      'breaker_trip',
      'operator_resume',
    ]);
    // The targeted id is printed up front (spec D2: single mode reports the one id).
    expect(capture.atLevel(30).some((l) => l['conversationId'] === 'c-breaker' && String(l['msg']).includes('single mode'))).toBe(true);
    // Already on: nothing written, reported as alreadyOn.
    const again = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, conversationId: 'c-breaker' });
    expect(again).toMatchObject({ planned: 0, enabled: 0, alreadyOn: 1 });
    await expect(
      enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, conversationId: 'c-relay' }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, conversationId: 'c-missing' }),
    ).rejects.toThrow(/not found/);
    expect(await w.mode('c-relay')).toBe('manual');
  }, 120_000);

  it('a row the breaker switches OFF again mid-run keeps the runtime outcome: the conditional write loses and is counted', async () => {
    const w = await seedWorld();
    // Between the Scan and the write, flip c-import to a state the condition
    // rejects (auto here stands in for "the runtime moved it").
    let raced = false;
    const racingDoc = {
      send: async (command: unknown) => {
        const out = await (doc as DynamoDBDocumentClient).send(command as never);
        if (command instanceof ScanCommand && !raced) {
          raced = true;
          await doc.send(
            new UpdateCommand({
              TableName: tableName('conversations', w.env),
              Key: { conversationId: 'c-import' },
              UpdateExpression: 'SET ai_mode = :auto',
              ExpressionAttributeValues: { ':auto': 'auto' },
            }),
          );
        }
        return out;
      },
      destroy: () => {},
    } as unknown as DynamoDBDocumentClient;
    const result = await enableConversationAutomation({ doc: racingDoc, env: w.env, now: NOW, apply: true });
    expect(raced).toBe(true);
    expect(result.skippedOnCondition).toBe(1);
    expect(result.enabled).toBe(1); // c-typeless still landed
    expect(await w.modeEvents('c-import')).toHaveLength(0); // no audit for a lost write
  }, 120_000);

  it('a lost AUDIT write is named at ERROR, counted, and exits 1 - the switch stays on (I6 is reported, never hidden)', async () => {
    const w = await seedWorld();
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const auditFailingDoc = {
      send: async (command: unknown) => {
        if (command instanceof PutCommand && String((command as PutCommand).input.TableName).endsWith('audit_events')) {
          throw new Error('audit-boom');
        }
        return await (doc as DynamoDBDocumentClient).send(command as never);
      },
      destroy: () => {},
    } as unknown as DynamoDBDocumentClient;
    const result = await enableConversationAutomation({ doc: auditFailingDoc, env: w.env, now: NOW, apply: true, logger: log });
    expect(result).toMatchObject({ planned: 2, enabled: 2, auditFailed: 2 });
    expect(await w.mode('c-import')).toBe('auto');
    expect(await w.mode('c-typeless')).toBe('auto');
    const errors = capture.atLevel(ERROR).filter((l) => String(l['msg']).includes('audit NOT written'));
    expect(errors.map((l) => l['conversationId']).sort()).toEqual(['c-import', 'c-typeless']);
    expect(reportEnableRun(result, true)).toBe(1);
  }, 120_000);

  it('a WRITE failure aborts the run (systemic until proven otherwise) and is reported as FAILED', async () => {
    const w = await seedWorld();
    const failingDoc = {
      send: async (command: unknown) => {
        if (command instanceof UpdateCommand) throw new Error('update-boom');
        return await (doc as DynamoDBDocumentClient).send(command as never);
      },
      destroy: () => {},
    } as unknown as DynamoDBDocumentClient;
    await expect(
      enableConversationAutomation({ doc: failingDoc, env: w.env, now: NOW, apply: true }),
    ).rejects.toThrow('update-boom');
    expect(await w.mode('c-import')).toBe('manual');
    expect(await w.mode('c-typeless')).toBe('manual');
  }, 120_000);
});
