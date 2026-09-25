// The fix script (spec D2) against DynamoDB Local: dry run writes nothing;
// apply enables only one-to-one `manual` rows (typeless included, group rows
// and pointer items never); breaker-tripped rows - by audit event OR by the
// breaker's send counter - are skipped unless included; single mode refuses a
// group thread or an unknown id as a USAGE error; a re-run changes nothing;
// every change is audited in ONE transaction with its switch (both land or
// neither; any other failure aborts the run); the conditional write loses to a
// row switched on elsewhere and, in bulk mode, to a breaker trip landing
// between the Scan and the write.
import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import { createConversationsRepo, minuteBucket } from '../src/repos/conversationsRepo.js';
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
    // A trip with NO audit event (its append failed, or is not readable yet):
    // `manual` plus the breaker's send counter, which only an automated send on
    // a switched-on row stamps - so it is a trip, audited or not.
    await put({ conversationId: 'c-counter', participant_phone: '+15550000006', status: 'open', last_activity_at: NOW, type: 'tenant_1to1', ai_mode: 'manual', outbound_minute_bucket: '2026-09-25T11:59', outbound_minute_count: 11, created_at: NOW });
    await put({ conversationId: 'c-auto', participant_phone: '+15550000004', status: 'open', last_activity_at: NOW, type: 'tenant_1to1', ai_mode: 'auto', created_at: NOW });
    await put({ conversationId: 'c-unset', participant_phone: '+15550000005', status: 'open', last_activity_at: NOW, type: 'tenant_1to1', created_at: NOW });
    await put({ conversationId: 'c-relay', status: 'open', relay_status: 'relay_group#open', last_activity_at: NOW, type: 'relay_group', ai_mode: 'manual', pool_number: '+15550009001', participant_phone: '+15550009001', created_at: NOW });
    await put({ conversationId: 'c-group', status: 'group_open', last_activity_at: NOW, type: 'group_text', ai_mode: 'manual', created_at: NOW });
    await put({ conversationId: 'phone#+15550000001', ref_conversationId: 'c-import' });
    const mode = async (id: string): Promise<unknown> =>
      (await doc.send(new GetCommand({ TableName: tableName('conversations', env), Key: { conversationId: id } }))).Item?.ai_mode;
    const allModeEvents = async () =>
      ((await doc.send(new ScanCommand({ TableName: tableName('audit_events', env) }))).Items ?? []).filter(
        (e) => e.event_type === 'mode_changed',
      );
    const modeEvents = async (id: string) =>
      (await allModeEvents()).filter((e) => e.entityKey === `conversations#${id}`);
    const reasonOf = (e: Record<string, unknown>): unknown => (e.payload as { reason?: unknown } | undefined)?.reason;
    return { env, mode, modeEvents, allModeEvents, reasonOf };
  }

  it('dry run: plans the one-to-one manual rows (breaker-tripped excluded, by audit event or send counter) and writes NOTHING', async () => {
    const w = await seedWorld();
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const result = await enableConversationAutomation({ doc, env: w.env, now: NOW, logger: log });
    expect(result).toMatchObject({
      scanned: 9,
      pointerRows: 1,
      groupRows: 2,
      alreadyOn: 1,
      unset: 1,
      breakerTrippedExcluded: 2,
      planned: 2,
      enabled: 0,
      skippedOnCondition: 0,
      failed: 0,
    });
    expect(result.byType).toEqual({ unknown_1to1: 1, '(none)': 1 });
    // Each excluded row is named with the evidence that excluded it.
    const excluded = capture
      .atLevel(30)
      .filter((l) => String(l['msg']).includes('breaker-tripped row excluded'))
      .map((l) => [l['conversationId'], l['evidence']]);
    expect(excluded.sort()).toEqual([
      ['c-breaker', 'audit_event'],
      ['c-counter', 'send_counter'],
    ]);
    // The Scan paging loop: two rows a page walks every page to the same plan.
    expect(await enableConversationAutomation({ doc, env: w.env, now: NOW, scanLimit: 2 })).toEqual(result);
    expect(await w.mode('c-import')).toBe('manual');
    expect(await w.mode('c-typeless')).toBe('manual');
    expect(await w.modeEvents('c-import')).toHaveLength(0);
    expect(reportEnableRun(result, false)).toBe(0);
    // Exit 1 only when a row could not be planned.
    expect(reportEnableRun({ ...result, failed: 1 }, false, createLogger({ level: 'silent' }))).toBe(1);
  }, 120_000);

  it('apply: enables exactly the planned rows with an audit event each; a SECOND run is a no-op', async () => {
    const w = await seedWorld();
    const first = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true });
    expect(first).toMatchObject({ planned: 2, enabled: 2, breakerTrippedExcluded: 2, skippedOnCondition: 0, failed: 0 });
    // On an apply, byType counts rows actually switched on (sums to enabled).
    expect(first.byType).toEqual({ unknown_1to1: 1, '(none)': 1 });
    expect(await w.mode('c-import')).toBe('auto');
    expect(await w.mode('c-typeless')).toBe('auto');
    // Untouched: breaker-tripped (audited, and by send counter only), already-on,
    // unset, group threads, pointer.
    expect(await w.mode('c-breaker')).toBe('manual');
    expect(await w.mode('c-counter')).toBe('manual');
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
    // The item auditRepo builds (ONE place for the key format): the `ts` sort
    // key `<ISO instant>#<8-hex suffix>`, and no actorId for a system action.
    expect(events[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#[0-9a-f]{8}$/);
    expect(events[0]!).not.toHaveProperty('actorId');
    const second = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true });
    expect(second).toMatchObject({ planned: 0, enabled: 0, alreadyOn: 3 });
    expect(await w.modeEvents('c-import')).toHaveLength(1);
  }, 120_000);

  it('apply with --include-breaker-tripped also enables the tripped rows (audited and send-counter), with the same reason', async () => {
    const w = await seedWorld();
    const result = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, includeBreakerTripped: true });
    expect(result).toMatchObject({ planned: 4, enabled: 4, breakerTrippedExcluded: 0 });
    expect(await w.mode('c-breaker')).toBe('auto');
    expect(await w.mode('c-counter')).toBe('auto');
    expect((await w.modeEvents('c-counter')).map((e) => (e.payload as { reason: string }).reason)).toEqual(['bulk_enable']);
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
    // A trip known only by its send counter resumes the same way: single mode
    // is the path FOR tripped rows, whatever the evidence.
    const counterResume = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, conversationId: 'c-counter' });
    expect(counterResume).toMatchObject({ planned: 1, enabled: 1, breakerTrippedExcluded: 0, skippedOnCondition: 0 });
    expect(await w.mode('c-counter')).toBe('auto');
    expect((await w.modeEvents('c-counter')).map((e) => (e.payload as { reason: string }).reason)).toEqual(['operator_resume']);
    await expect(
      enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, conversationId: 'c-relay' }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, conversationId: 'c-missing' }),
    ).rejects.toThrow(/not found/);
    expect(await w.mode('c-relay')).toBe('manual');
  }, 120_000);

  it('a row switched ON elsewhere mid-run (another run, or a resume) loses the conditional write and is counted - no second audit event', async () => {
    const w = await seedWorld();
    // Between the Scan and the write, another writer switches c-import on
    // (a concurrent run or an operator resume). The condition requires the
    // switch still OFF, so this run writes nothing for it.
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
    // byType counts what the apply actually switched on, not what it planned.
    expect(result.planned).toBe(2);
    expect(result.byType).toEqual({ '(none)': 1 });
    expect(await w.modeEvents('c-import')).toHaveLength(0); // no audit for a lost write
  }, 120_000);

  it('a breaker trip that lands between the Scan and the write loses the conditional write: the bulk write requires no send counter', async () => {
    const w = await seedWorld();
    const conversations = createConversationsRepo({ doc, env: w.env });
    const audit = createAuditRepo({ doc, env: w.env });
    // A trip WRITES `manual`, so the switch condition alone cannot see one.
    // The only way a trip reaches a row the Scan saw `manual` without a
    // counter: it is switched on elsewhere, counts automated sends, and the
    // breaker trips it - replayed with the breaker's REAL writes, setMode
    // first and the audit append second (sendMessage.ts). The append lands
    // AFTER this run's trip Query for the row, so planning cannot see the
    // trip; only the write's send-counter clause can.
    let scanned = false;
    let appended = false;
    const racingDoc = {
      send: async (command: unknown) => {
        const out = await (doc as DynamoDBDocumentClient).send(command as never);
        if (command instanceof ScanCommand && !scanned) {
          scanned = true;
          await conversations.setMode('c-import', 'auto');
          await conversations.incrementAutomatedSendCount('c-import', minuteBucket(new Date(NOW)));
          await conversations.setMode('c-import', 'manual');
        }
        if (
          command instanceof QueryCommand &&
          command.input.ExpressionAttributeValues?.[':e'] === 'conversations#c-import' &&
          !appended
        ) {
          appended = true;
          await audit.append('conversations#c-import', 'mode_changed', { from: 'auto', to: 'manual', reason: 'breaker_trip' });
        }
        return out;
      },
      destroy: () => {},
    } as unknown as DynamoDBDocumentClient;
    const result = await enableConversationAutomation({ doc: racingDoc, env: w.env, apply: true });
    expect(scanned && appended).toBe(true);
    expect(result).toMatchObject({ planned: 2, enabled: 1, skippedOnCondition: 1 });
    expect(await w.mode('c-import')).toBe('manual');
    expect(await w.mode('c-typeless')).toBe('auto');
    // The trip's own event only: no bulk_enable for the row that stayed off.
    expect((await w.modeEvents('c-import')).map((e) => (e.payload as { reason: string }).reason)).toEqual(['breaker_trip']);
  }, 120_000);

  it('the switch and its audit event are ONE transaction: an audit Put DynamoDB refuses rolls the switch back, and the run aborts', async () => {
    const w = await seedWorld();
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    // Make DynamoDB itself refuse the AUDIT half (its condition rewritten to
    // one that cannot hold) while the switch half's own condition passes.
    // Two separate writes would leave the row on with no event; one
    // transaction must cancel both.
    let rewritten = 0;
    const auditRefusingDoc = {
      send: async (command: unknown) => {
        if (command instanceof TransactWriteCommand) {
          rewritten += 1;
          const items = command.input.TransactItems ?? [];
          return await doc.send(
            new TransactWriteCommand({
              TransactItems: items.map((item) =>
                item.Put ? { Put: { ...item.Put, ConditionExpression: 'attribute_exists(entityKey)' } } : item,
              ),
            }),
          );
        }
        return await (doc as DynamoDBDocumentClient).send(command as never);
      },
      destroy: () => {},
    } as unknown as DynamoDBDocumentClient;
    const err = await enableConversationAutomation({ doc: auditRefusingDoc, env: w.env, apply: true, logger: log }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(rewritten).toBe(1); // the first transaction aborts the run
    expect(err).toBeInstanceOf(TransactionCanceledException);
    // The switch half passed its condition; only the audit half failed - and
    // DynamoDB rolled BOTH back. Not a row-condition loss, so not "skipped".
    expect((err as TransactionCanceledException).CancellationReasons?.map((r) => r.Code)).toEqual(['None', 'ConditionalCheckFailed']);
    expect(await w.mode('c-import')).toBe('manual');
    expect(await w.mode('c-typeless')).toBe('manual');
    expect((await w.allModeEvents()).map(w.reasonOf)).toEqual(['breaker_trip']); // the seeded trip only
    expect(capture.lines.some((l) => String(l['msg']).includes('conversation switched on'))).toBe(false);
    const partial = capture.atLevel(ERROR).find((l) => String(l['msg']).includes('PARTIAL'));
    expect(partial).toMatchObject({ planned: 1, enabled: 0, skippedOnCondition: 0 });
  }, 120_000);

  it('a transaction failure other than the row condition ABORTS the run with a PARTIAL report: every planned row stays manual, no mode_changed event is written', async () => {
    const w = await seedWorld();
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const failingDoc = {
      send: async (command: unknown) => {
        if (command instanceof TransactWriteCommand) throw new Error('transact-boom');
        return await (doc as DynamoDBDocumentClient).send(command as never);
      },
      destroy: () => {},
    } as unknown as DynamoDBDocumentClient;
    await expect(
      enableConversationAutomation({ doc: failingDoc, env: w.env, apply: true, logger: log }),
    ).rejects.toThrow('transact-boom');
    expect(await w.mode('c-import')).toBe('manual');
    expect(await w.mode('c-typeless')).toBe('manual');
    expect((await w.allModeEvents()).map(w.reasonOf)).toEqual(['breaker_trip']); // the seeded trip only
    expect(capture.atLevel(ERROR).some((l) => String(l['msg']).includes('PARTIAL'))).toBe(true);
  }, 120_000);
});
