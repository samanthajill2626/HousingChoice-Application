// import:apply integration tests against DynamoDB Local.
//
// The claims that matter for the 8/10 cutover, each exercised for real:
//   - a full apply writes contacts, threads, messages and calls
//   - re-running is idempotent (no duplicates, same item counts)
//   - a re-run does NOT revert work done in the app after the import
//   - `drop` in the workbook excludes a person and their traffic
//   - a STOP sender imports suppressed
//
// Self-skipping like the other integration suites: without DynamoDB Local at
// DYNAMODB_ENDPOINT the suite is skipped so `npm test` stays green offline.
import { randomUUID } from 'node:crypto';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { runApply } from '../src/lib/import/apply.js';
import { runPlan } from '../src/lib/import/plan.js';
import { conversationIdFor1to1, conversationIdForGroup, contactIdForPhone } from '../src/lib/import/ids.js';
import { parseWorkbook } from '../src/lib/import/workbook.js';
import { PHONES, writeFixture } from './importFixture.js';

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
    `[importApply.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const TABLES = ['contacts', 'conversations', 'messages', 'units'] as const;

describe.skipIf(!reachable)('import:apply', () => {
  const client = createDynamoClient({ endpoint });
  // createDocumentClient takes CreateDynamoOptions, not a client — handing it
  // the client above yields a confusing "Region is missing" at first send.
  const doc = createDocumentClient({ endpoint });

  // OUR OWN table prefix, as the other integration suites do. This suite drops
  // and recreates its tables, and vitest runs files in parallel — doing that to
  // the shared `hc-local-` tables broke devOutbox.integration mid-run.
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const table = (base: string): string => tableName(base, testEnv);
  const fixture = writeFixture();
  const plan = runPlan({ quoDir: fixture.quoDir, airtableDir: fixture.airtableDir });
  const importedAt = '2026-08-05T00:00:00.000Z';

  /** The generated workbook, unedited — the founder-accepts-everything case. */
  const cleanReview = () =>
    parseWorkbook({
      contacts: plan.files['contacts.csv'],
      groups: plan.files['groups.csv'],
      units: plan.files['units.csv'],
    });

  beforeAll(async () => {
    for (const t of TABLES) {
      await deleteTableIfExists(client, table(t));
      await ensureTable(client, getTableSpec(t), table(t));
    }
  }, 60_000);

  afterAll(async () => {
    for (const t of TABLES) await deleteTableIfExists(client, table(t));
    client.destroy();
  }, 60_000);

  const countMessages = async (conversationId: string): Promise<number> => {
    const res = await doc.send(
      new QueryCommand({
        TableName: table('messages'),
        KeyConditionExpression: 'conversationId = :c',
        ExpressionAttributeValues: { ':c': conversationId },
      }),
    );
    return res.Items?.length ?? 0;
  };

  it('writes contacts, threads, messages and calls', async () => {
    const report = await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });

    expect(report.contacts.written).toBe(plan.merge.people.length);
    expect(report.messages.written).toBe(plan.quo.messages.length);
    expect(report.calls.written).toBe(plan.quo.calls.length);
    expect(report.conversations.groups).toBe(1);

    const contact = await doc.send(
      new GetCommand({
        TableName: table('contacts'),
        Key: { contactId: contactIdForPhone(PHONES.landlord) },
      }),
    );
    expect(contact.Item).toMatchObject({
      type: 'landlord',
      phone: PHONES.landlord,
      display_name: 'Marlon Pike',
      status: 'active',
      status_source: 'import',
    });
  });

  it('folds two Quo conversations for one phone into a single thread', async () => {
    const id = conversationIdFor1to1(PHONES.tenantBusy);
    const conv = await doc.send(
      new GetCommand({ TableName: table('conversations'), Key: { conversationId: id } }),
    );
    expect(conv.Item).toMatchObject({ type: 'unknown_1to1', participant_phone: PHONES.tenantBusy });
    // 3 messages across CN001+CN002, plus 1 call.
    expect(await countMessages(id)).toBe(4);
  });

  it('imports a multi-party thread as a `connecting` relay group with no pool number', async () => {
    // Full history and roster at zero Twilio/A2P cost; the founder connects on
    // demand (spec section 3.6).
    const id = conversationIdForGroup([PHONES.groupTenant, PHONES.landlord]);
    const conv = await doc.send(
      new GetCommand({ TableName: table('conversations'), Key: { conversationId: id } }),
    );
    expect(conv.Item).toMatchObject({
      type: 'relay_group',
      status: 'connecting',
      relay_status: 'relay_group#connecting',
    });
    expect(conv.Item!.pool_number).toBeUndefined();
    expect(conv.Item!.participants).toHaveLength(2);
  });

  it('suppresses SMS for the STOP sender', async () => {
    const contact = await doc.send(
      new GetCommand({
        TableName: table('contacts'),
        Key: { contactId: contactIdForPhone(PHONES.optedOut) },
      }),
    );
    expect(contact.Item!.sms_opt_out).toBe(true);
  });

  it('stamps consent only where the person texted us first', async () => {
    const fetchContact = (phone: string) =>
      doc.send(
        new GetCommand({
          TableName: table('contacts'),
          Key: { contactId: contactIdForPhone(phone) },
        }),
      );
    const inbound = await fetchContact(PHONES.tenantBusy);
    const noTraffic = await fetchContact(PHONES.noTraffic);
    expect(inbound.Item!.consent_method).toBe('import');
    expect(noTraffic.Item!.consent_method).toBeUndefined();
  });

  it('is idempotent - a second run duplicates nothing', async () => {
    const id = conversationIdFor1to1(PHONES.tenantBusy);
    const before = await countMessages(id);

    const second = await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });

    expect(await countMessages(id)).toBe(before);
    expect(second.messages.written).toBe(plan.quo.messages.length);
  });

  it('does NOT revert a status a human set after the import', async () => {
    // The scenario the re-run exists for: apply at cutover, Sam works, we
    // re-apply to fix something. Her decisions must survive.
    const contactId = contactIdForPhone(PHONES.tenantBusy);
    const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
    await doc.send(
      new UpdateCommand({
        TableName: table('contacts'),
        Key: { contactId },
        UpdateExpression: 'SET #s = :s, status_source = :src',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': 'placed', ':src': 'manual' },
      }),
    );

    const report = await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });
    expect(report.contacts.statusPreserved).toBeGreaterThan(0);

    const after = await doc.send(
      new GetCommand({ TableName: table('contacts'), Key: { contactId } }),
    );
    expect(after.Item).toMatchObject({ status: 'placed', status_source: 'manual' });
  });

  it("honours the founder's edits over our suggestions", async () => {
    const review = cleanReview();
    const row = [...review.contacts.values()].find((r) => r.phone === PHONES.tenantConflict)!;
    row.name = 'Rey Okonkwo';
    row.voucher_beds = '4';
    row.type = 'tenant';

    await runApply({ doc, plan, review, importedAt, env: testEnv });

    const item = await doc.send(
      new GetCommand({
        TableName: table('contacts'),
        Key: { contactId: contactIdForPhone(PHONES.tenantConflict) },
      }),
    );
    expect(item.Item).toMatchObject({
      display_name: 'Rey Okonkwo',
      voucherSize: 4,
      type: 'tenant',
    });
  });

  it('excludes a dropped person and skips their thread', async () => {
    const review = cleanReview();
    const row = [...review.contacts.values()].find((r) => r.phone === PHONES.orphan)!;
    row.drop = 'Y';

    const report = await runApply({ doc, plan, review, importedAt, env: testEnv });
    expect(report.contacts.skippedDropped).toBe(1);

    const item = await doc.send(
      new GetCommand({
        TableName: table('contacts'),
        Key: { contactId: contactIdForPhone(PHONES.orphan) },
      }),
    );
    expect(item.Item).toBeUndefined();
  });

  it('retracts a person dropped in a LATER review, not just skips them', async () => {
    // The gap this closes: an earlier run already imported them, so skipping the
    // write alone would leave the row behind and "drop" would quietly do nothing.
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });
    const contactId = contactIdForPhone(PHONES.tenantBusy);
    const conversationId = conversationIdFor1to1(PHONES.tenantBusy);
    expect(await countMessages(conversationId)).toBeGreaterThan(0);

    const review = cleanReview();
    [...review.contacts.values()].find((r) => r.phone === PHONES.tenantBusy)!.drop = 'Y';
    await runApply({ doc, plan, review, importedAt, env: testEnv });

    const gone = await doc.send(
      new GetCommand({ TableName: table('contacts'), Key: { contactId } }),
    );
    expect(gone.Item).toBeUndefined();
    expect(await countMessages(conversationId)).toBe(0);
  });

  it('NEVER destroys conversation history the import did not create', async () => {
    // Dropping a spreadsheet row must not be able to delete a real message that
    // arrived after cutover. The contact goes; the thread stays; we say so.
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });
    const conversationId = conversationIdFor1to1(PHONES.tenantConflict);
    const { PutCommand: Put } = await import('@aws-sdk/lib-dynamodb');
    await doc.send(
      new Put({
        TableName: table('messages'),
        Item: {
          conversationId,
          tsMsgId: '2026-08-11T00:00:00.000Z#LIVE-1',
          type: 'sms',
          direction: 'inbound',
          body: 'arrived after cutover',
          provider_sid: 'LIVE-1',
          provider_ts: '2026-08-11T00:00:00.000Z',
          delivery_status: 'received',
          created_at: '2026-08-11T00:00:00.000Z',
        },
      }),
    );

    const review = cleanReview();
    [...review.contacts.values()].find((r) => r.phone === PHONES.tenantConflict)!.drop = 'Y';
    const report = await runApply({ doc, plan, review, importedAt, env: testEnv });

    // The live message survives, and the operator is told rather than left to
    // discover it.
    expect(await countMessages(conversationId)).toBeGreaterThan(0);
    expect(report.warnings.some((w) => w.includes('KEPT'))).toBe(true);
  });

  it('records connect-day-one as intent without provisioning a number', async () => {
    // Buying a Twilio number has real cost and A2P consequences; it is never a
    // side effect of a spreadsheet cell.
    const review = cleanReview();
    const groupRow = [...review.groups.values()][0]!;
    groupRow.connect_day_one = 'Y';

    const report = await runApply({ doc, plan, review, importedAt, env: testEnv });
    expect(report.conversations.connectedDayOne).toBe(1);

    const id = conversationIdForGroup([PHONES.groupTenant, PHONES.landlord]);
    const conv = await doc.send(
      new GetCommand({ TableName: table('conversations'), Key: { conversationId: id } }),
    );
    expect(conv.Item!.import_connect_requested).toBe(true);
    expect(conv.Item!.pool_number).toBeUndefined();
    expect(conv.Item!.status).toBe('connecting');
  });

  it('writes nothing on a dry run', async () => {
    for (const t of TABLES) {
      await deleteTableIfExists(client, table(t));
      await ensureTable(client, getTableSpec(t), table(t));
    }
    const report = await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv, dryRun: true });
    expect(report.contacts.written).toBeGreaterThan(0);

    const item = await doc.send(
      new GetCommand({
        TableName: table('contacts'),
        Key: { contactId: contactIdForPhone(PHONES.landlord) },
      }),
    );
    expect(item.Item).toBeUndefined();
  });
});
