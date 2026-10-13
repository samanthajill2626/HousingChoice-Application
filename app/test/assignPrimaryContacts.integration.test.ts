// assign-primary-contacts (primary-contact-integrity spec section 8; plan
// C12, tasks S5.3 / S5.4; build research worklist-deltas "S5 additions",
// finding S3-F3): the script's REAL wiring against DynamoDB Local. The script
// is a production post-merge operation, so it is not proven through injected
// fakes alone. `main` runs here with ONLY `resolveStage` injected (plus its
// print and log sinks), so its DEFAULT `run` - assignPrimaryContacts on
// buildAssignDeps(stage, logger) - builds every repo on the stage's doc
// client and env exactly as an operator's run does. A repo built without the
// stage env would resolve the ambient TABLE_PREFIX (no such table in this
// file's database), and one built without the stage doc would bypass the
// recording client below: either way this test fails.
//
// The stage is a throwaway `hc-test-<uuid>-` prefix in THIS file's own
// DynamoDB Local database (the per-file access key app/test/setup assigns).
// It is never resolveStageClient, whose local target is the human's live
// stack or an e2e lane; the argv below only has to parse.
//
// Self-skipping like the other integration suites when nothing answers at
// DYNAMODB_ENDPOINT (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { main } from '../scripts/assign-primary-contacts.js';
import type { StageClient, StageClientOpts, StageTarget } from '../scripts/lib/stageClient.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

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
  console.warn(
    `[assignPrimaryContacts.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const NOW = '2026-10-13T12:00:00.000Z';
/** The 470 Bolton contact's name: it must never reach a printed or logged line. */
const NAMES = ['Mark', 'Passmore'];
/** Any lane: resolveStage is injected, so the argv only has to parse. */
const LANE = ['--env', 'local', '--lane', '9'];

/** One command the stage client was asked to send. */
interface Sent {
  name: string;
  input: Record<string, unknown>;
}

describe.skipIf(!reachable)('assign-primary-contacts - the real wiring against DynamoDB Local', () => {
  const env = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const BASES = ['units', 'contacts', 'audit_events'] as const;

  beforeAll(async () => {
    for (const base of BASES) await ensureTable(client, getTableSpec(base), tableName(base, env));
  }, 120_000);

  afterAll(async () => {
    for (const base of BASES) await deleteTableIfExists(client, tableName(base, env));
    doc.destroy();
    client.destroy();
  }, 120_000);

  /** One CLI run: main with ONLY the stage injected; every command the run sends is recorded. */
  async function runCli(argv: string[]): Promise<{
    code: 0 | 1 | 2;
    sent: Sent[];
    resolved: Array<{ target: StageTarget; opts: StageClientOpts }>;
    printed: string[];
    capture: LogCapture;
    destroyed: number;
  }> {
    const sent: Sent[] = [];
    const resolved: Array<{ target: StageTarget; opts: StageClientOpts }> = [];
    const printed: string[] = [];
    const capture = createLogCapture();
    let destroyed = 0;
    const stage: StageClient = {
      doc: {
        send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          sent.push({ name: command.constructor.name, input: command.input });
          return await doc.send(command as never);
        },
        destroy: () => {
          destroyed += 1;
        },
      } as unknown as DynamoDBDocumentClient,
      env,
      endpoint,
      prefix: env.TABLE_PREFIX,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      describe: 'DynamoDB Local - this test file database',
    };
    const code = await main(argv, {
      resolveStage: async (target, opts) => {
        resolved.push({ target, opts });
        return stage;
      },
      print: (line) => {
        printed.push(line);
      },
      printError: (text) => {
        printed.push(text);
      },
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });
    return { code, sent, resolved, printed, capture, destroyed };
  }

  /** "<Command> <table>" for each command sent, in order. */
  const trace = (sent: Sent[]): string[] =>
    sent.map((s) => {
      const table =
        s.input['TableName'] ?? Object.keys((s.input['RequestItems'] ?? {}) as Record<string, unknown>)[0];
      return `${s.name} ${String(table)}`;
    });
  const unitOf = async (unitId: string): Promise<Record<string, unknown> | undefined> =>
    (await doc.send(new GetCommand({ TableName: tableName('units', env), Key: { unitId }, ConsistentRead: true })))
      .Item;
  const auditEvents = async (): Promise<Record<string, unknown>[]> =>
    (await doc.send(new ScanCommand({ TableName: tableName('audit_events', env), ConsistentRead: true }))).Items ?? [];

  it('a dry run, an --apply and a re-run, end to end: a 470 Bolton unit gets its only contact as the primary', async () => {
    // 470 Bolton: no landlord of record, one live landlord-typed contact on
    // the list, nobody primary.
    await doc.send(
      new PutCommand({
        TableName: tableName('contacts', env),
        Item: {
          contactId: 'c-mark',
          type: 'landlord',
          status: 'active',
          firstName: 'Mark',
          lastName: 'Passmore',
          created_at: NOW,
        },
      }),
    );
    await doc.send(
      new PutCommand({
        TableName: tableName('units', env),
        Item: {
          unitId: 'u-bolton',
          status: 'available',
          created_at: NOW,
          updated_at: NOW,
          contacts: [{ contactId: 'c-mark', role: 'pm', primaryContact: false }],
        },
      }),
    );
    const reads = [`ScanCommand ${tableName('units', env)}`, `BatchGetCommand ${tableName('contacts', env)}`];

    // DRY RUN (the default): plans the unit, sends only the two reads, writes nothing.
    const dry = await runCli(LANE);
    expect(dry.code).toBe(0);
    expect(dry.resolved).toEqual([{ target: 'local', opts: { lane: 9 } }]);
    expect(dry.printed[0]).toBe('Primary contacts - DRY RUN, nothing written:');
    expect(dry.printed).toContain('Properties that would get a primary contact: u-bolton');
    expect(trace(dry.sent)).toEqual(reads);
    // The Scan reads EVERY unit (no soft-delete filter), strongly consistently.
    expect(dry.sent[0]?.input).toMatchObject({ ConsistentRead: true });
    expect(dry.sent[0]?.input['FilterExpression']).toBeUndefined();
    expect(dry.destroyed).toBe(1);
    const untouched = await unitOf('u-bolton');
    expect(untouched?.['contacts']).toEqual([{ contactId: 'c-mark', role: 'pm', primaryContact: false }]);
    expect(untouched?.['primary_contact']).toBeUndefined();
    expect(untouched?.['updated_at']).toBe(NOW);
    expect(await auditEvents()).toEqual([]);

    // --apply: ONE conditional write and ONE backfill audit event, both through the stage client.
    const apply = await runCli([...LANE, '--apply']);
    expect(apply.code).toBe(0);
    expect(apply.printed[0]).toBe('Primary contacts - APPLIED:');
    expect(apply.printed).toContain('  Primary contacts assigned: 1');
    expect(trace(apply.sent)).toEqual([
      ...reads,
      `UpdateCommand ${tableName('units', env)}`,
      `PutCommand ${tableName('audit_events', env)}`,
    ]);
    expect(apply.destroyed).toBe(1);
    const assigned = await unitOf('u-bolton');
    expect(assigned?.['contacts']).toEqual([{ contactId: 'c-mark', role: 'pm', primaryContact: true }]);
    expect(assigned?.['primary_contact']).toBe('c-mark');
    expect(assigned !== undefined && Object.prototype.hasOwnProperty.call(assigned, 'landlordId')).toBe(false);
    expect(assigned?.['updated_at']).not.toBe(NOW);
    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityKey: 'units#u-bolton', event_type: 'unit_primary_contact_assigned' });
    expect(events[0]?.['payload']).toEqual({ contactId: 'c-mark', reason: 'backfill' });
    expect(events[0]?.['actorId']).toBeUndefined();

    // A re-run plans nothing and writes nothing (idempotent).
    const again = await runCli([...LANE, '--apply']);
    expect(again.code).toBe(0);
    expect(again.printed).toContain('  Planned a primary contact: 0 (0 on soft-deleted properties)');
    expect(again.printed).toContain('  Already fine: 1');
    expect(trace(again.sent)).toEqual(reads);
    expect(await auditEvents()).toHaveLength(1);

    // Ids only: no printed or logged line names the contact. pino stamps the
    // machine's hostname on every line - not ours to check.
    for (const run of [dry, apply, again]) {
      const out =
        JSON.stringify(run.capture.lines.map(({ hostname: _hostname, ...line }) => line)) + run.printed.join('\n');
      for (const name of NAMES) expect(out).not.toContain(name);
    }
  }, 120_000);
});
