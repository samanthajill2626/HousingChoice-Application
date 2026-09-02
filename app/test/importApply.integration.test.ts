// import:apply integration tests against DynamoDB Local.
//
// The claims that matter for the 8/10 cutover, each exercised for real:
//   - a full apply writes contacts, threads, messages and calls
//   - re-running is idempotent (no duplicates, same item counts)
//   - a re-run does NOT revert work done in the app after the import
//   - `drop` in the workbook excludes a person and their traffic
//   - a STOP sender imports suppressed
//   - an applied unit records its authorities as a canonical list
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
import { normalizeAddress } from '../src/lib/import/addresses.js';
import { housingAuthorityFor, runApply, splitReviewedName } from '../src/lib/import/apply.js';
import { runPlan } from '../src/lib/import/plan.js';
import { conversationIdFor1to1, conversationIdForGroup, contactIdForPhone, unitIdForAddress } from '../src/lib/import/ids.js';
import { parseWorkbook } from '../src/lib/import/workbook.js';
import { OUR_NUMBER, PHONES, writeFixture } from './importFixture.js';

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
  // the shared `hc-local-` tables once broke a neighbouring shared-tables suite
  // (the since-deleted devOutbox.integration) mid-run.
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
      // firstName/lastName, NOT display_name - see the name-fields regression
      // test above for why that distinction matters.
      firstName: 'Marlon',
      lastName: 'Pike',
      status: 'active',
      status_source: 'import',
    });
  });

  it('writes the name fields the app actually renders from', async () => {
    // REGRESSION. The import used to write a single `display_name`, which nothing
    // reads: routes/contacts.ts displayNameOf() joins firstName + lastName and
    // returns null when both are absent, and a null name renders as the phone
    // number. Every imported contact would have shown as a bare phone, throwing
    // away all 539 resolved names including the ~117 reviewed by hand.
    //
    // This asserts the STORED SHAPE satisfies that resolver, reproducing its
    // logic rather than trusting that some field is populated.
    const displayNameOf = (c: Record<string, unknown>): string | null => {
      const first = typeof c.firstName === 'string' ? c.firstName.trim() : '';
      const last = typeof c.lastName === 'string' ? c.lastName.trim() : '';
      const joined = [first, last].filter((p) => p.length > 0).join(' ');
      return joined.length > 0 ? joined : null;
    };

    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });

    const multiToken = await doc.send(
      new GetCommand({
        TableName: table('contacts'),
        Key: { contactId: contactIdForPhone(PHONES.landlord) },
      }),
    );
    expect(multiToken.Item).toMatchObject({ firstName: 'Marlon', lastName: 'Pike' });
    expect(displayNameOf(multiToken.Item!)).toBe('Marlon Pike');
    // The dead field is gone, not merely supplemented.
    expect(multiToken.Item!.display_name).toBeUndefined();

    // A single-token name (122 of the founder's are first-name-only) must render
    // as just that name, not as "Angela " with a trailing space.
    const singleToken = await doc.send(
      new GetCommand({
        TableName: table('contacts'),
        Key: { contactId: contactIdForPhone(PHONES.roleClash) },
      }),
    );
    expect(displayNameOf(singleToken.Item!)).toBe('Landlord Larry');
  });

  it('keeps an honorific attached so broadcasts do not greet someone "Hi Ms."', () => {
    // firstName is NOT display-only: lib/mergeFields.ts renderBody substitutes
    // [TenantName] with firstName ALONE, so a naive first-token split sends a
    // real tenant a text saying "Hi Ms.,". Ten of the founder's 478 named
    // tenants are titled (Ms. Cooper, Miss Johnson, Ms Kendrick...).
    expect(splitReviewedName('Ms. Cooper')).toEqual({ firstName: 'Ms. Cooper', lastName: '' });
    expect(splitReviewedName('Miss Johnson')).toEqual({ firstName: 'Miss Johnson', lastName: '' });
    expect(splitReviewedName('Ms Kendrick')).toEqual({ firstName: 'Ms Kendrick', lastName: '' });
    // An honorific with a full name keeps the remainder as the surname.
    expect(splitReviewedName('Dr. Maya Fernandez')).toEqual({
      firstName: 'Dr. Maya',
      lastName: 'Fernandez',
    });
    // Ordinary names are unaffected - first token is the first name.
    expect(splitReviewedName('Candy Faulk')).toEqual({ firstName: 'Candy', lastName: 'Faulk' });
    // Multi-word surnames survive intact rather than being dropped.
    expect(splitReviewedName('Mary-Jo Van Der Berg')).toEqual({
      firstName: 'Mary-Jo',
      lastName: 'Van Der Berg',
    });
    // Single token: whole name is the first name, empty surname.
    expect(splitReviewedName('Angela')).toEqual({ firstName: 'Angela', lastName: '' });
    // A bare honorific has nothing to attach to - treated as the name itself.
    expect(splitReviewedName('Ms.')).toEqual({ firstName: 'Ms.', lastName: '' });
  });

  it('normalizes the Airtable program to one canonical spelling per authority', async () => {
    // FREE FIELD (Cameron 2026-08-09), but consistently spelled: broadcast
    // audience resolution does an exact hash match on the byHousingAuthority
    // GSI, so two spellings of one authority are two audiences invisible to
    // each other. Known variants collapse to one form; unknown values pass
    // through verbatim instead of being dropped.
    expect(housingAuthorityFor('Atlanta, aha, Atlanta housing')).toBe('Atlanta (AHA)');
    expect(housingAuthorityFor('Jonesboro, JHA, Jonesboro housing')).toBe('Jonesboro (JHA)');
    expect(housingAuthorityFor('Dekalb County Housing')).toBe('Dekalb County Housing');
    expect(housingAuthorityFor('DCA, Department of Community Affairs')).toBe('DCA');
    expect(housingAuthorityFor('Georgia Housing Voucher, GHV')).toBe(
      'Georgia Housing Voucher (GHV)',
    );
    expect(housingAuthorityFor('HUD VASH')).toBe('HUD VASH');
    expect(housingAuthorityFor('Hope Atlanta')).toBe('Hope Atlanta');
    // Free field: an unknown value is WRITTEN (whitespace-collapsed), not lost.
    expect(housingAuthorityFor('Some New Authority')).toBe('Some New Authority');
    expect(housingAuthorityFor('  odd   spacing ')).toBe('odd spacing');
    expect(housingAuthorityFor('')).toBeUndefined();
    expect(housingAuthorityFor(undefined)).toBeUndefined();

    // And it lands on the contact: the fixture's caseworker carries Hope Atlanta.
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });
    const item = await doc.send(
      new GetCommand({
        TableName: table('contacts'),
        Key: { contactId: contactIdForPhone(PHONES.caseworker) },
      }),
    );
    expect(item.Item!.housingAuthority).toBe('Hope Atlanta');
  });

  it('writes an applied unit a canonical accepted_authorities list, never jurisdiction', async () => {
    // Spec section 8: the unit-side field is the accepted-authorities LIST, and
    // the founder's raw "Voucher Type" cell goes through the SAME canonicalizer
    // the contact side uses - so the properties facet and the tenants facet group
    // one authority under one spelling instead of two. The retired `jurisdiction`
    // string is never written again.
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });

    // The unit key is derived exactly as upsertUnit derives it, from the reviewed
    // row - not hardcoded, so a change to either helper surfaces here.
    const row = [...cleanReview().units.values()].find((r) => (r.housing_authority ?? '') !== '')!;
    expect(row.housing_authority).toBe('Atlanta Housing'); // the RAW Airtable cell
    const unitId = unitIdForAddress(normalizeAddress((row.address ?? '').trim()));

    const stored = await doc.send(
      new GetCommand({ TableName: table('units'), Key: { unitId } }),
    );
    expect(stored.Item).toBeDefined();
    expect(stored.Item!.accepted_authorities).toEqual(['Atlanta (AHA)']);
    expect(stored.Item!.jurisdiction).toBeUndefined();
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

  it('keeps evidence-free imported carrier history schema-absent', async () => {
    const id = conversationIdFor1to1(PHONES.tenantBusy);
    const rows = await doc.send(new QueryCommand({
      TableName: table('messages'),
      KeyConditionExpression: 'conversationId = :conversationId',
      ExpressionAttributeValues: { ':conversationId': id },
    }));
    const carrier = (rows.Items ?? []).filter((item) => item['type'] === 'sms' || item['type'] === 'mms');
    expect(carrier.length).toBeGreaterThan(0);
    for (const item of carrier) {
      expect(item).not.toHaveProperty('transport_schema_version');
      expect(item).not.toHaveProperty('requested_transport');
      expect(item).not.toHaveProperty('actual_transport');
    }
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
      firstName: 'Rey',
      lastName: 'Okonkwo',
      voucherSize: 4,
      type: 'tenant',
    });
  });

  it('a RETYPED row never stores the old type vocabulary - it lands needs_review', async () => {
    // REGRESSION. The per-type status guard checked the workbook column but
    // trusted `suggestedStatus` blindly - and the suggestion was derived from
    // the EXPORT's type signals, so a review that retypes a row (her "Keep
    // tenant" answers) left it speaking the old type's vocabulary. The guard
    // then rejected the illegal column value and stored an equally illegal
    // fallback ("active" on a tenant), off-vocabulary for the byTypeStatus GSI
    // the type's own facets query.
    const review = cleanReview();
    const row = [...review.contacts.values()].find((r) => r.phone === PHONES.landlord)!;
    // The generated workbook pre-fills his landlord suggestion ("active");
    // retype him to tenant, where that value is not in the vocabulary.
    row.type = 'tenant';

    const report = await runApply({ doc, plan, review, importedAt, env: testEnv });

    const item = await doc.send(
      new GetCommand({
        TableName: table('contacts'),
        Key: { contactId: contactIdForPhone(PHONES.landlord) },
      }),
    );
    expect(item.Item).toMatchObject({ type: 'tenant', status: 'needs_review' });
    expect(report.warnings.some((w) => w.includes('not a legal tenant status'))).toBe(true);

    // Restore the fixture shape for the tests that follow.
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });
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

  it('sweeps up a later export without disturbing what is already there', async () => {
    // THE CUTOVER PLAN'S CORE MANOEUVRE. Rather than making Sam stop working in
    // Quo before Sunday's export, we export on 8/09, import, let her review, then
    // export again after the number ports and re-import to collect the gap.
    // This asserts that actually works: the newer messages land, the existing
    // ones are untouched, and nothing duplicates.
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });

    const id = conversationIdFor1to1(PHONES.tenantBusy);
    const before = await countMessages(id);

    // A later export: same corpus, plus two messages that arrived in the gap.
    const laterFixture = writeFixture([
      {
        id: 'AC900',
        conv: 'CN001',
        body: 'sent after the first export',
        to: OUR_NUMBER,
        from: PHONES.tenantBusy,
        dir: 'incoming',
        at: '2026-08-08T10:00:00.000Z',
      },
      {
        id: 'AC901',
        conv: 'CN001',
        body: 'and one more',
        to: PHONES.tenantBusy,
        from: OUR_NUMBER,
        dir: 'outgoing',
        at: '2026-08-09T10:00:00.000Z',
      },
    ]);
    const laterPlan = runPlan({
      quoDir: laterFixture.quoDir,
      airtableDir: laterFixture.airtableDir,
    });
    const laterReview = parseWorkbook({
      contacts: laterPlan.files['contacts.csv'],
      groups: laterPlan.files['groups.csv'],
      units: laterPlan.files['units.csv'],
    });

    await runApply({
      doc,
      plan: laterPlan,
      review: laterReview,
      importedAt: '2026-08-11T00:00:00.000Z',
      env: testEnv,
    });

    // Exactly the two gap messages were added — nothing duplicated.
    expect(await countMessages(id)).toBe(before + 2);

    // And the thread's last activity moved forward to the newer message.
    const conv = await doc.send(
      new GetCommand({ TableName: table('conversations'), Key: { conversationId: id } }),
    );
    expect(conv.Item!.last_activity_at).toBe('2026-08-09T10:00:00.000Z');
  });

  it('a dropped group keeps its whole thread out - conversation and messages', async () => {
    // 2026-08-09: all groups continue by default; drop=Y is the exclusion path
    // and it must exclude the MESSAGES too, not just the conversation row.
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });
    const id = conversationIdForGroup([PHONES.groupTenant, PHONES.landlord]);
    expect(await countMessages(id)).toBeGreaterThan(0);

    // Fresh tables so the exclusion is observable (the group was written above).
    for (const t of TABLES) {
      await deleteTableIfExists(client, table(t));
      await ensureTable(client, getTableSpec(t), table(t));
    }

    const review = cleanReview();
    [...review.groups.values()][0]!.drop = 'Y';
    const report = await runApply({ doc, plan, review, importedAt, env: testEnv });
    expect(report.conversations.droppedGroups).toBe(1);

    const conv = await doc.send(
      new GetCommand({ TableName: table('conversations'), Key: { conversationId: id } }),
    );
    expect(conv.Item).toBeUndefined();
    expect(await countMessages(id)).toBe(0);
  });

  it('leaves a native group_text thread byte-identical on every field it owns', async () => {
    // THE RE-RUN-UNDER-TRAFFIC CASE (group-texting spec section 9). After the
    // migration (or after live detection minted the same derived id), the group
    // row is a native group_text thread. A later import re-run must not be able
    // to drag it back into relay shape.
    for (const t of TABLES) {
      await deleteTableIfExists(client, table(t));
      await ensureTable(client, getTableSpec(t), table(t));
    }
    const id = conversationIdForGroup([PHONES.groupTenant, PHONES.landlord]);
    const { PutCommand: Put } = await import('@aws-sdk/lib-dynamodb');

    const converted = {
      conversationId: id,
      type: 'group_text',
      status: 'group_open',
      last_activity_at: '2026-09-01T00:00:00.000Z',
      created_at: '2026-07-25T10:00:00.000Z',
      ai_mode: 'manual',
      participants: [
        { contactId: contactIdForPhone(PHONES.groupTenant), phone: PHONES.groupTenant },
        { contactId: contactIdForPhone(PHONES.landlord), phone: PHONES.landlord },
      ],
      twilio_conversation_sid: 'CH00000000000000000000000000000001',
      twilio_participant_map: { MB0000000000000000000000000000001: `phone#${PHONES.landlord}` },
    };
    await doc.send(new Put({ TableName: table('conversations'), Item: converted }));

    const review = cleanReview();
    for (const row of review.groups.values()) row.connect_day_one = 'Y';
    await runApply({ doc, plan, review, importedAt, env: testEnv });

    const conv = await doc.send(
      new GetCommand({ TableName: table('conversations'), Key: { conversationId: id } }),
    );
    const item = conv.Item!;
    // Everything the native thread owns is untouched.
    expect(item.type).toBe('group_text');
    expect(item.status).toBe('group_open');
    expect(item.participants).toEqual(converted.participants);
    expect(item.ai_mode).toBe('manual');
    expect(item.created_at).toBe(converted.created_at);
    expect(item.twilio_conversation_sid).toBe(converted.twilio_conversation_sid);
    expect(item.twilio_participant_map).toEqual(converted.twilio_participant_map);
    // And nothing relay-shaped or import-owned was stamped onto it. relay_status
    // is the sneaky one: `if_not_exists` protects nothing on a row that
    // deliberately has none, so without the skip this row would have joined the
    // byRelayStatus GSI and reappeared as a connecting relay group.
    expect(item.relay_status).toBeUndefined();
    expect(item.imported_from).toBeUndefined();
    expect(item.imported_at).toBeUndefined();
    expect(item.import_connect_requested).toBeUndefined();
    expect(item.pool_number).toBeUndefined();
    // KNOWN, ACCEPTED residual: the second write (the guarded last_activity_at
    // advance) is not type-guarded, so a re-run whose export is NEWER than the
    // stored activity reorders the group in the inbox. Here the stored value is
    // newer, so it stays put.
    expect(item.last_activity_at).toBe(converted.last_activity_at);

    // Messages still import normally - they are separately keyed.
    expect(await countMessages(id)).toBeGreaterThan(0);
  });

  it('advances a converted group thread last_activity_at when the export is newer', async () => {
    // The one write that still reaches a native group thread. Pinned rather than
    // fixed: moving last_activity_at forward is correct behavior, and the only
    // consequence is inbox ORDER (group_open is a byLastActivity partition).
    for (const t of TABLES) {
      await deleteTableIfExists(client, table(t));
      await ensureTable(client, getTableSpec(t), table(t));
    }
    const id = conversationIdForGroup([PHONES.groupTenant, PHONES.landlord]);
    const { PutCommand: Put } = await import('@aws-sdk/lib-dynamodb');
    await doc.send(
      new Put({
        TableName: table('conversations'),
        Item: {
          conversationId: id,
          type: 'group_text',
          status: 'group_open',
          last_activity_at: '2020-01-01T00:00:00.000Z',
          created_at: '2020-01-01T00:00:00.000Z',
          ai_mode: 'manual',
          participants: [],
        },
      }),
    );

    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });

    const conv = await doc.send(
      new GetCommand({ TableName: table('conversations'), Key: { conversationId: id } }),
    );
    expect(conv.Item!.last_activity_at).toBe('2026-07-26T10:00:00.000Z');
    expect(conv.Item!.status).toBe('group_open');
  });

  it('refuses to drop a contact a native group text roster references', async () => {
    for (const t of TABLES) {
      await deleteTableIfExists(client, table(t));
      await ensureTable(client, getTableSpec(t), table(t));
    }
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });

    const memberId = contactIdForPhone(PHONES.groupTenant);
    const { PutCommand: Put } = await import('@aws-sdk/lib-dynamodb');
    await doc.send(
      new Put({
        TableName: table('conversations'),
        Item: {
          conversationId: conversationIdForGroup([PHONES.groupTenant, PHONES.landlord]),
          type: 'group_text',
          status: 'group_open',
          last_activity_at: '2026-09-01T00:00:00.000Z',
          created_at: '2026-07-25T10:00:00.000Z',
          ai_mode: 'manual',
          participants: [
            { contactId: memberId, phone: PHONES.groupTenant },
            { contactId: contactIdForPhone(PHONES.landlord), phone: PHONES.landlord },
          ],
        },
      }),
    );

    const review = cleanReview();
    [...review.contacts.values()].find((r) => r.phone === PHONES.groupTenant)!.drop = 'Y';
    const report = await runApply({ doc, plan, review, importedAt, env: testEnv });

    const contact = await doc.send(
      new GetCommand({ TableName: table('contacts'), Key: { contactId: memberId } }),
    );
    expect(contact.Item).toBeDefined();
    expect(report.warnings.some((w) => w.includes('KEPT (GROUP MEMBER)'))).toBe(true);
  });

  it('refuses to drop a contact stamped as a group member after the roster walk', async () => {
    // THE RACE. The roster walk runs once at the start of the drop pass, so a
    // thread created after it would be invisible; the ConditionExpression on the
    // delete is evaluated by DynamoDB and cannot be raced.
    for (const t of TABLES) {
      await deleteTableIfExists(client, table(t));
      await ensureTable(client, getTableSpec(t), table(t));
    }
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });

    const memberId = contactIdForPhone(PHONES.groupTenant);
    const { UpdateCommand: Update } = await import('@aws-sdk/lib-dynamodb');
    // No group_open row exists - only the consent-basis stamp, exactly the state
    // a detection that landed between the walk and the delete would leave.
    await doc.send(
      new Update({
        TableName: table('contacts'),
        Key: { contactId: memberId },
        UpdateExpression: 'SET group_participation_at = :at',
        ExpressionAttributeValues: { ':at': '2026-08-12T00:00:00.000Z' },
      }),
    );

    const review = cleanReview();
    [...review.contacts.values()].find((r) => r.phone === PHONES.groupTenant)!.drop = 'Y';
    const report = await runApply({ doc, plan, review, importedAt, env: testEnv });

    const contact = await doc.send(
      new GetCommand({ TableName: table('contacts'), Key: { contactId: memberId } }),
    );
    expect(contact.Item).toBeDefined();
    expect(report.warnings.some((w) => w.includes('while this import was running'))).toBe(true);
    // Nothing half-retracted: their own thread history is still there.
    expect(await countMessages(conversationIdFor1to1(PHONES.groupTenant))).toBeGreaterThan(0);
  });

  it('never RESURRECTS a contact deleted between the read and the retract marker', async () => {
    // adversarial 14. The marker `UpdateCommand` conditioned only on
    // `attribute_not_exists(group_participation_at)`, and DynamoDB's UpdateItem
    // CREATES an absent item - a condition an absent item satisfies. Two
    // overlapping runs (the RUNBOOK says re-running is safe and expected) both
    // read the row; A hard-deletes it; B's marker then MINTS a phantom carrying
    // only `{contactId, import_retract_started_at}`. With no phone, type or
    // status it is on neither GSI, and every future run's `imported_from` check
    // refuses to touch it - so it is permanent residue no run can ever see.
    for (const t of TABLES) {
      await deleteTableIfExists(client, table(t));
      await ensureTable(client, getTableSpec(t), table(t));
    }
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });

    const target = contactIdForPhone(PHONES.tenantBusy);
    const { DeleteCommand: Delete, UpdateCommand: Update } = await import('@aws-sdk/lib-dynamodb');
    let stolen = false;
    let afterMarker: Record<string, unknown> | undefined;
    const racingDoc = {
      send: async (command: unknown) => {
        const input = (command as { input: Record<string, any> }).input;
        const isTargetGet =
          command instanceof GetCommand &&
          input.TableName === table('contacts') &&
          input.Key?.contactId === target;
        let result: unknown;
        let thrown: unknown;
        try {
          result = await doc.send(command as never);
        } catch (err) {
          thrown = err;
        }
        if (isTargetGet && !stolen) {
          // The OTHER run finishes and hard-deletes the contact, right here.
          stolen = true;
          await doc.send(new Delete({ TableName: table('contacts'), Key: { contactId: target } }));
        }
        if (command instanceof Update && input.Key?.contactId === target) {
          const probe = await doc.send(
            new GetCommand({ TableName: table('contacts'), Key: { contactId: target } }),
          );
          afterMarker = probe.Item;
        }
        if (thrown !== undefined) throw thrown;
        return result;
      },
    } as unknown as typeof doc;

    const review = cleanReview();
    [...review.contacts.values()].find((r) => r.phone === PHONES.tenantBusy)!.drop = 'Y';
    const report = await runApply({ doc: racingDoc, plan, review, importedAt, env: testEnv });

    expect(stolen).toBe(true);
    // THE PHANTOM WAS NEVER CREATED.
    expect(afterMarker).toBeUndefined();
    const after = await doc.send(
      new GetCommand({ TableName: table('contacts'), Key: { contactId: target } }),
    );
    expect(after.Item).toBeUndefined();
    // And the operator is not told a group-membership story that did not happen.
    expect(report.warnings.some((w) => w.includes('joined a native group text'))).toBe(false);
  });

  it('states what ACTUALLY happened to the contact, re-checked after the deletes', async () => {
    // adversarial 25. The foreign-message warning was flipped to "the thread was
    // KEPT, the contact was removed" to match the new destruction order - but
    // the contact delete happens 30 lines later and can REFUSE, so the sentence
    // became a prediction that can be false. Here the person joins a native
    // group text between the marker and the delete, so BOTH the thread and the
    // contact survive; neither warning may claim otherwise.
    for (const t of TABLES) {
      await deleteTableIfExists(client, table(t));
      await ensureTable(client, getTableSpec(t), table(t));
    }
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });

    const target = contactIdForPhone(PHONES.tenantBusy);
    const conversationId = conversationIdFor1to1(PHONES.tenantBusy);
    const { PutCommand: Put, UpdateCommand: Update } = await import('@aws-sdk/lib-dynamodb');
    await doc.send(
      new Put({
        TableName: table('messages'),
        Item: {
          conversationId,
          tsMsgId: '2026-08-12T00:00:00.000Z#LIVE-9',
          type: 'sms',
          direction: 'inbound',
          body: 'arrived after cutover',
          provider_sid: 'LIVE-9',
          provider_ts: '2026-08-12T00:00:00.000Z',
          delivery_status: 'received',
          created_at: '2026-08-12T00:00:00.000Z',
        },
      }),
    );

    let stamped = false;
    const racingDoc = {
      send: async (command: unknown) => {
        const input = (command as { input: Record<string, any> }).input;
        const isMarker =
          command instanceof Update &&
          input.TableName === table('contacts') &&
          input.Key?.contactId === target &&
          String(input.UpdateExpression ?? '').includes('import_retract_started_at');
        const result = await doc.send(command as never);
        if (isMarker && !stamped) {
          // Detection stamps the group consent basis right after our marker.
          stamped = true;
          await doc.send(
            new Update({
              TableName: table('contacts'),
              Key: { contactId: target },
              UpdateExpression: 'SET group_participation_at = :at',
              ExpressionAttributeValues: { ':at': '2026-08-12T01:00:00.000Z' },
            }),
          );
        }
        return result;
      },
    } as unknown as typeof doc;

    const review = cleanReview();
    [...review.contacts.values()].find((r) => r.phone === PHONES.tenantBusy)!.drop = 'Y';
    const report = await runApply({ doc: racingDoc, plan, review, importedAt, env: testEnv });

    expect(stamped).toBe(true);
    const survivor = await doc.send(
      new GetCommand({ TableName: table('contacts'), Key: { contactId: target } }),
    );
    expect(survivor.Item).toBeDefined();
    // NO warning may say the contact was removed, because it was not.
    expect(report.warnings.some((w) => w.includes('the contact was removed'))).toBe(false);
    expect(report.warnings.some((w) => w.includes('contact record was removed'))).toBe(false);
    // NO warning may say the 1:1 thread was already removed, because the foreign
    // message kept it.
    expect(report.warnings.some((w) => w.includes('thread was already removed'))).toBe(false);
    expect(await countMessages(conversationId)).toBeGreaterThan(0);
    // The marker does not persist forever on a live group member's contact.
    expect(survivor.Item!.import_retract_started_at).toBeUndefined();
  });

  it('READS import_retract_started_at: a retract that died halfway is reported and resumed', async () => {
    // conformance F6 / adversarial 35. The field was a write with ZERO readers -
    // the exact defect class this same commit indicted `imported_sender_phone`
    // for - while its own comment promised "a contact carrying
    // import_retract_started_at and still having a thread is exactly a retract
    // that died halfway". This is that reader.
    for (const t of TABLES) {
      await deleteTableIfExists(client, table(t));
      await ensureTable(client, getTableSpec(t), table(t));
    }
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });

    const target = contactIdForPhone(PHONES.tenantBusy);
    const { UpdateCommand: Update } = await import('@aws-sdk/lib-dynamodb');
    await doc.send(
      new Update({
        TableName: table('contacts'),
        Key: { contactId: target },
        UpdateExpression: 'SET import_retract_started_at = :at',
        ExpressionAttributeValues: { ':at': '2026-08-11T09:00:00.000Z' },
      }),
    );

    const review = cleanReview();
    [...review.contacts.values()].find((r) => r.phone === PHONES.tenantBusy)!.drop = 'Y';
    const report = await runApply({ doc, plan, review, importedAt, env: testEnv });

    expect(
      report.warnings.some(
        (w) => w.includes('2026-08-11T09:00:00.000Z') && w.includes('did NOT finish'),
      ),
    ).toBe(true);
    // Resumed, not skipped.
    const gone = await doc.send(
      new GetCommand({ TableName: table('contacts'), Key: { contactId: target } }),
    );
    expect(gone.Item).toBeUndefined();
    expect(await countMessages(conversationIdFor1to1(PHONES.tenantBusy))).toBe(0);
  });

  // THE DEFECT THIS PINS (fix wave 4, item 6). The resume sentence was pushed
  // BEFORE the guarded marker write that can refuse the whole retract, so a
  // person who had joined a native group text got a report saying "RESUMING it
  // now - their imported thread and messages are being removed again"
  // immediately followed by "the contact was KEPT (GROUP MEMBER)": two
  // contradictory sentences about one person, the first of them false, in the
  // document the founder reads to decide whether the import went right. The same
  // commit states the rule thirty lines further down - record the outcome, state
  // it once, when it is a fact.
  it('does NOT claim a half-finished retract was resumed when the group-member guard refuses it', async () => {
    for (const t of TABLES) {
      await deleteTableIfExists(client, table(t));
      await ensureTable(client, getTableSpec(t), table(t));
    }
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });

    const target = contactIdForPhone(PHONES.tenantBusy);
    const { UpdateCommand: Update } = await import('@aws-sdk/lib-dynamodb');
    // A retract died halfway AND the person has since joined a group text, so
    // the guarded marker write refuses and nothing is retracted at all.
    await doc.send(
      new Update({
        TableName: table('contacts'),
        Key: { contactId: target },
        UpdateExpression:
          'SET import_retract_started_at = :at, group_participation_at = :joined',
        ExpressionAttributeValues: {
          ':at': '2026-08-11T09:00:00.000Z',
          ':joined': '2026-08-12T00:00:00.000Z',
        },
      }),
    );

    const review = cleanReview();
    [...review.contacts.values()].find((r) => r.phone === PHONES.tenantBusy)!.drop = 'Y';
    const report = await runApply({ doc, plan, review, importedAt, env: testEnv });

    // The report says they were KEPT...
    expect(report.warnings.some((w) => w.includes('KEPT (GROUP MEMBER)'))).toBe(true);
    // ...and never that their thread and messages were being removed again.
    expect(report.warnings.some((w) => w.includes('did NOT finish'))).toBe(false);
    expect(report.warnings.some((w) => w.includes('RESUMING it now'))).toBe(false);
    // And the words match the world: nothing was destroyed.
    const survivor = await doc.send(
      new GetCommand({ TableName: table('contacts'), Key: { contactId: target } }),
    );
    expect(survivor.Item).toBeDefined();
    expect(await countMessages(conversationIdFor1to1(PHONES.tenantBusy))).toBeGreaterThan(0);
  });

  it('does not blame group text detection for a row the import itself created', async () => {
    // adversarial 37. import:convert-groups re-mints a dropped group member as a
    // group-scoped stub carrying `origin: group_detection`, and every later
    // import:apply then reported "their contact record was created by group text
    // detection, not by the import" - about a row the import's own convert-groups
    // step created. The refusal is right; the attribution was not.
    for (const t of TABLES) {
      await deleteTableIfExists(client, table(t));
      await ensureTable(client, getTableSpec(t), table(t));
    }
    await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });

    const target = contactIdForPhone(PHONES.tenantBusy);
    const { UpdateCommand: Update } = await import('@aws-sdk/lib-dynamodb');
    await doc.send(
      new Update({
        TableName: table('contacts'),
        Key: { contactId: target },
        UpdateExpression: 'SET origin = :o',
        ExpressionAttributeValues: { ':o': 'group_detection' },
      }),
    );

    const review = cleanReview();
    [...review.contacts.values()].find((r) => r.phone === PHONES.tenantBusy)!.drop = 'Y';
    const report = await runApply({ doc, plan, review, importedAt, env: testEnv });

    const line = report.warnings.find((w) => w.includes('GROUP MEMBER'));
    expect(line).toBeDefined();
    expect(line).not.toContain('not by the import');
    expect(line).toContain('group text detection or by this import');
    const kept = await doc.send(
      new GetCommand({ TableName: table('contacts'), Key: { contactId: target } }),
    );
    expect(kept.Item).toBeDefined();
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

  // -----------------------------------------------------------------------
  // Unit property facts - canonical field names, and who owns a field
  // -----------------------------------------------------------------------
  describe('unit property facts', () => {
    /** The fixture's Airtable property: Beds "3 Bed", Bathrooms "2 Bathroom". */
    const lavenderRow = (review: ReturnType<typeof cleanReview>) =>
      [...review.units.values()].find((r) => (r.address ?? '').includes('Lavender'))!;
    const lavenderId = () =>
      unitIdForAddress(normalizeAddress((lavenderRow(cleanReview()).address ?? '').trim()));

    const freshTables = async (): Promise<void> => {
      for (const t of TABLES) {
        await deleteTableIfExists(client, table(t));
        await ensureTable(client, getTableSpec(t), table(t));
      }
    };
    const storedUnit = async () =>
      (await doc.send(new GetCommand({ TableName: table('units'), Key: { unitId: lavenderId() } })))
        .Item;

    it('stores bed and bath counts under the names the app READS', async () => {
      // REGRESSION (2026-08-17). These were written as `bedrooms`/`bathrooms`,
      // which NOTHING reads - `UnitItem` (repos/unitsRepo.ts), the flyer
      // projection (lib/unitFields.ts) and the dashboard all read `beds`/`baths`.
      // 65 imported units on dev AND prod stored their counts where no reader
      // would ever look and rendered blank in the property list. Same class as
      // the v1 `display_name` bug: the producer's field name was never asserted
      // against the consumer's resolver. `seedData.test.ts` has carried this
      // exact guard for seed data all along; the importer had none.
      await freshTables();
      await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });

      const item = await storedUnit();
      expect(item).toBeDefined();
      expect(item!.beds).toBe(3);
      expect(item!.baths).toBe(2);
      expect(item).not.toHaveProperty('bedrooms');
      expect(item).not.toHaveProperty('bathrooms');
    });

    it('takes the first value of a multi-select cell instead of concatenating it', async () => {
      // Airtable multi-selects arrive comma-joined. Stripping every non-digit
      // turned the two apartment BUILDINGS in the real book into 123-bathroom
      // properties.
      await freshTables();
      const review = cleanReview();
      const row = lavenderRow(review);
      row.baths = '1 Bathroom,2 Bathroom,3 Bathroom';

      const report = await runApply({ doc, plan, review, importedAt, env: testEnv });

      expect((await storedUnit())!.baths).toBe(1);
      expect(
        report.warnings.some((w) => w.includes('Lavender') && w.includes('more than one value')),
      ).toBe(true);
    });

    it('never overwrites a unit a human edited, but still fills what she left empty', async () => {
      // The whole reason a re-import is safe to run. `unitsRepo.update` stamps
      // `updated_at` on every dashboard write and the import never does, so its
      // presence means "a person owns this row now" - permanently, by Cameron's
      // call on 2026-08-17. Absent fields are still filled, which is how an
      // already-edited row picks up a corrected field name.
      await freshTables();
      await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });

      const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
      await doc.send(
        new UpdateCommand({
          TableName: table('units'),
          Key: { unitId: lavenderId() },
          // Dashboard work, exactly as it looked on prod: a hand-corrected bath
          // count, a unit number the workbook address does not carry, and a
          // hand-curated multi-authority list. `beds` is cleared so there is
          // something genuinely absent left for the import to fill.
          UpdateExpression:
            'SET baths = :baths, address = :address, accepted_authorities = :auth, updated_at = :now REMOVE beds',
          ExpressionAttributeValues: {
            ':baths': 9,
            ':address': { line1: '1460 Lavender Dr NW', line2: 'Unit 2B', zip: '30314' },
            ':auth': ['Atlanta (AHA)', 'DCA', 'Georgia Housing Voucher'],
            ':now': '2026-08-17T18:00:00.000Z',
          },
        }),
      );

      const report = await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });
      expect(report.units.humanOwned).toBeGreaterThan(0);

      const item = await storedUnit();
      expect(item!.baths).toBe(9); // hers, not the workbook's 2
      expect(item!.address).toMatchObject({ line2: 'Unit 2B' }); // survives
      expect(item!.accepted_authorities).toHaveLength(3); // not collapsed to one
      expect(item!.beds).toBe(3); // absent -> filled, which is the point
    });
  });
});
