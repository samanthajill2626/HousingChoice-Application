// Fix-wave regressions on the IMPORT side of group texting, driven over the
// same recording stub doc client importGroupGuards.test.ts uses (runApply takes
// its client by parameter, so the whole importer is drivable without DynamoDB).
//
// Three claims, one per adjudicated finding:
//   A1  imported GROUP messages carry `relay_sender_key` in the SAME shape live
//       traffic writes, so migrated history is attributable in the thread view.
//   A8  `import:apply` runs the group-identity parity gate BEFORE its first
//       write, not only downstream in the conversion.
//   A9  `retractImported` destroys the contact LAST, so a mid-retract failure
//       leaves residue the NEXT run can still find and finish.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { runApply } from '../src/lib/import/apply.js';
import {
  assertGroupIdentityParity,
  GroupIdentityParityError,
} from '../src/lib/import/convertGroups.js';
import { runPlan } from '../src/lib/import/plan.js';
import { contactIdForPhone, conversationIdForGroup, conversationIdFor1to1 } from '../src/lib/import/ids.js';
import { parseWorkbook } from '../src/lib/import/workbook.js';
import { TEAM_SENDER_KEY } from '../src/jobs/relayFanOut.js';
import { groupMemberKey } from '../src/services/groupMembers.js';
import { OUR_NUMBER, PHONES, writeFixture } from './importFixture.js';

const fixture = writeFixture();
const plan = runPlan({ quoDir: fixture.quoDir, airtableDir: fixture.airtableDir });
const importedAt = '2026-08-05T00:00:00.000Z';
const GROUP_ID = conversationIdForGroup([PHONES.groupTenant, PHONES.landlord]);

const cleanReview = (): ReturnType<typeof parseWorkbook> =>
  parseWorkbook({
    contacts: plan.files['contacts.csv'],
    groups: plan.files['groups.csv'],
    units: plan.files['units.csv'],
  });

interface RecordedCommand {
  name: string;
  input: Record<string, unknown>;
}

function ccfe(): Error {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

function stubDoc(onSend?: (cmd: RecordedCommand) => unknown): {
  doc: DynamoDBDocumentClient;
  sent: RecordedCommand[];
} {
  const sent: RecordedCommand[] = [];
  const doc = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const recorded = { name: command.constructor.name, input: command.input };
      sent.push(recorded);
      const override = onSend?.(recorded);
      if (override !== undefined) return override;
      if (recorded.name === 'BatchWriteCommand') return { UnprocessedItems: {} };
      if (recorded.name === 'QueryCommand') return { Items: [] };
      return {};
    },
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, sent };
}

/** Every message item the run batched, flattened out of its BatchWriteCommands. */
function writtenMessages(sent: RecordedCommand[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const cmd of sent) {
    if (cmd.name !== 'BatchWriteCommand') continue;
    const byTable = cmd.input.RequestItems as Record<
      string,
      { PutRequest?: { Item?: Record<string, unknown> } }[]
    >;
    for (const requests of Object.values(byTable)) {
      for (const r of requests) if (r.PutRequest?.Item) items.push(r.PutRequest.Item);
    }
  }
  return items;
}

const onThread = (
  sent: RecordedCommand[],
  conversationId: string,
): Record<string, unknown>[] =>
  writtenMessages(sent).filter((m) => m.conversationId === conversationId);

describe('A1 - imported group messages carry relay_sender_key (attribution)', () => {
  it('stamps an INBOUND group message with the sender member key live traffic uses', async () => {
    const { doc, sent } = stubDoc();
    await runApply({ doc, plan, review: cleanReview(), importedAt });

    const inbound = onThread(sent, GROUP_ID).filter((m) => m.direction === 'inbound');
    expect(inbound.length).toBeGreaterThan(0);
    for (const m of inbound) {
      // Byte-identical to webhooks/twilio.ts:1300 - `phone#<E164>`, never
      // relayMemberKey (spec 15.6). Anything else renders no sender chip.
      expect(m.relay_sender_key).toBe(groupMemberKey(PHONES.groupTenant));
      expect(m.relay_sender_key).toBe(`phone#${PHONES.groupTenant}`);
    }
  });

  it('resolves that key against the roster entry the conversion writes', async () => {
    // The dashboard's senderLabel rule (memberAttribution.senderLabel) matches a
    // roster member on EITHER its contactId or its `phone#<E164>` key, then
    // renders the member's name or its formatted number. Asserting the app-side
    // half of that here - the key IS the roster member's phone key - is what
    // makes the migrated bubble attributable; the dashboard module itself is
    // deliberately not imported into an app test.
    const { doc, sent } = stubDoc();
    await runApply({ doc, plan, review: cleanReview(), importedAt });

    const rosterPhones = [PHONES.groupTenant, PHONES.landlord];
    const keys = new Set(rosterPhones.map((p) => `phone#${p}`));
    const inbound = onThread(sent, GROUP_ID).filter((m) => m.direction === 'inbound');
    for (const m of inbound) expect(keys.has(String(m.relay_sender_key))).toBe(true);
    // And the roster the conversion fills in derives the SAME member ids, so the
    // chip resolves whichever key convention the reader tries.
    for (const phone of rosterPhones) expect(contactIdForPhone(phone)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stamps an OUTBOUND group message with the TEAM sentinel', async () => {
    const { doc, sent } = stubDoc();
    await runApply({ doc, plan, review: cleanReview(), importedAt });

    const outbound = onThread(sent, GROUP_ID).filter((m) => m.direction === 'outbound');
    expect(outbound.length).toBeGreaterThan(0);
    for (const m of outbound) expect(m.relay_sender_key).toBe('team');
  });

  it('pins the team sentinel to the ONE definition the app sends with', () => {
    // apply.ts keeps a local literal rather than importing jobs/relayFanOut into
    // the import CLI (that module pulls the adapters and registers job handlers
    // on import). This is the anti-drift assertion that makes the duplicate safe.
    expect(TEAM_SENDER_KEY).toBe('team');
  });

  it('leaves 1:1 imported messages completely unchanged', async () => {
    const { doc, sent } = stubDoc();
    await runApply({ doc, plan, review: cleanReview(), importedAt });

    const oneToOne = onThread(sent, conversationIdFor1to1(PHONES.tenantBusy));
    expect(oneToOne.length).toBeGreaterThan(0);
    for (const m of oneToOne) expect(m.relay_sender_key).toBeUndefined();
  });

  it('keeps imported_sender_phone as provenance on the same rows', async () => {
    const { doc, sent } = stubDoc();
    await runApply({ doc, plan, review: cleanReview(), importedAt });

    const inbound = onThread(sent, GROUP_ID).filter((m) => m.direction === 'inbound');
    for (const m of inbound) expect(m.imported_sender_phone).toBe(PHONES.groupTenant);
    // Calls never carry a sender key - they are not multi-party bubbles.
    const calls = writtenMessages(sent).filter((m) => m.type === 'call');
    for (const c of calls) expect(c.relay_sender_key).toBeUndefined();
  });

  it('never writes a sender key on a message with no resolvable author', async () => {
    // Outbound is always the team; inbound from our own number cannot happen on
    // a group thread (own numbers are the exclusion set), so every group inbound
    // must produce a member-shaped key.
    const { doc, sent } = stubDoc();
    await runApply({ doc, plan, review: cleanReview(), importedAt });
    for (const m of onThread(sent, GROUP_ID)) {
      expect(String(m.relay_sender_key)).not.toBe(`phone#${OUR_NUMBER}`);
    }
  });
});

describe('A8 - import:apply refuses on a group-identity parity mismatch', () => {
  it('assertGroupIdentityParity throws the shared refusal on a mismatch', () => {
    expect(() =>
      assertGroupIdentityParity([OUR_NUMBER, '+15550100099'], {
        businessPhoneNumber: undefined,
        poolNumbers: [],
        configuredNumbers: [OUR_NUMBER],
      }),
    ).toThrow(GroupIdentityParityError);
  });

  it('assertGroupIdentityParity passes when the two sides agree', () => {
    expect(() =>
      assertGroupIdentityParity([OUR_NUMBER], {
        businessPhoneNumber: undefined,
        poolNumbers: [],
        configuredNumbers: [OUR_NUMBER],
      }),
    ).not.toThrow();
  });

  it('the import:apply CLI runs that gate BEFORE its first write', () => {
    // The script is a thin top-level-await CLI (it calls process.exit), so the
    // wire assertion is on the code path: the gate must be reached before
    // runApply, or 132 group threads are written at ids the conversion will
    // then refuse to touch (adversarial finding 6).
    const source = readFileSync(join(process.cwd(), 'scripts', 'import-apply.ts'), 'utf8');
    expect(source).toContain('assertGroupIdentityParity');
    const gateAt = source.indexOf('assertGroupIdentityParity(');
    const applyAt = source.indexOf('await runApply(');
    expect(gateAt).toBeGreaterThan(-1);
    expect(applyAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(applyAt);
    // Reused, never reimplemented.
    expect(source).toMatch(/from '\.\.\/src\/lib\/import\/convertGroups\.js'/);
  });
});

describe('A9/C9 - retractImported destroys the contact LAST', () => {
  const DROPPED_PHONE = PHONES.groupTenant;
  const DROPPED_CONTACT_ID = contactIdForPhone(DROPPED_PHONE);
  const DROPPED_THREAD = conversationIdFor1to1(DROPPED_PHONE);

  const reviewDropping = (): ReturnType<typeof parseWorkbook> => {
    const review = cleanReview();
    for (const row of review.contacts.values()) {
      if (row.phone === DROPPED_PHONE) row.drop = 'Y';
    }
    return review;
  };

  interface RetractWorld {
    /** Throw a transient failure on the conversation read that follows the message deletes. */
    failAfterMessageDeletes?: boolean;
    /** Make the atomic guard lose its condition (detection stamped mid-run). */
    guardLoses?: boolean;
  }

  function retractStub(world: RetractWorld = {}): {
    doc: DynamoDBDocumentClient;
    sent: RecordedCommand[];
  } {
    return stubDoc((cmd) => {
      const table = String(cmd.input.TableName ?? '');
      if (cmd.name === 'QueryCommand' && cmd.input.IndexName === 'byLastActivity') {
        return { Items: [] };
      }
      if (
        cmd.name === 'GetCommand' &&
        table.includes('contacts') &&
        (cmd.input.Key as { contactId?: string }).contactId === DROPPED_CONTACT_ID
      ) {
        return {
          Item: {
            contactId: DROPPED_CONTACT_ID,
            phone: DROPPED_PHONE,
            imported_from: 'quo-airtable-import',
          },
        };
      }
      if (
        world.guardLoses &&
        cmd.name === 'UpdateCommand' &&
        table.includes('contacts') &&
        (cmd.input.Key as { contactId?: string }).contactId === DROPPED_CONTACT_ID &&
        String(cmd.input.ConditionExpression ?? '').includes('group_participation_at')
      ) {
        throw ccfe();
      }
      if (
        cmd.name === 'QueryCommand' &&
        table.includes('messages') &&
        (cmd.input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[':c'] ===
          DROPPED_THREAD
      ) {
        return { Items: [{ tsMsgId: '2026-03-01T10:00:00.000Z#AC012', imported_from: 'quo-airtable-import' }] };
      }
      if (
        world.failAfterMessageDeletes &&
        cmd.name === 'GetCommand' &&
        table.includes('conversations') &&
        (cmd.input.Key as { conversationId?: string }).conversationId === DROPPED_THREAD
      ) {
        throw new Error('ProvisionedThroughputExceededException');
      }
      return undefined;
    });
  }

  const contactDeletes = (sent: RecordedCommand[]): RecordedCommand[] =>
    sent.filter(
      (c) =>
        c.name === 'DeleteCommand' &&
        String(c.input.TableName ?? '').includes('contacts') &&
        (c.input.Key as { contactId?: string }).contactId === DROPPED_CONTACT_ID,
    );

  const messageDeletes = (sent: RecordedCommand[]): RecordedCommand[] =>
    sent.filter(
      (c) => c.name === 'DeleteCommand' && String(c.input.TableName ?? '').includes('messages'),
    );

  it('deletes messages, then the thread, then the contact', async () => {
    const { doc, sent } = retractStub();
    await runApply({ doc, plan, review: reviewDropping(), importedAt });

    const order = sent.map((c) => `${c.name}:${String(c.input.TableName ?? '')}`);
    const firstMessageDelete = sent.indexOf(messageDeletes(sent)[0]!);
    const contactDelete = sent.indexOf(contactDeletes(sent)[0]!);
    expect(firstMessageDelete).toBeGreaterThan(-1);
    expect(contactDelete).toBeGreaterThan(firstMessageDelete);
    expect(order.length).toBeGreaterThan(0);
    // The contact delete keeps its atomic group guard.
    expect(contactDeletes(sent)[0]!.input.ConditionExpression).toBe(
      'attribute_not_exists(group_participation_at)',
    );
  });

  it('a mid-retract failure leaves the contact behind, so a re-run finishes the job', async () => {
    // The regression: with the contact deleted FIRST, this same throw left the
    // 1:1 thread and its messages orphaned AND invisible - the next run's
    // contact Get found nothing and returned early forever.
    const first = retractStub({ failAfterMessageDeletes: true });
    await expect(
      runApply({ doc: first.doc, plan, review: reviewDropping(), importedAt }),
    ).rejects.toThrow('ProvisionedThroughputExceededException');
    expect(contactDeletes(first.sent)).toHaveLength(0);

    // Re-run against a world where the contact is (still) there: the retract
    // completes, contact included.
    const second = retractStub();
    await runApply({ doc: second.doc, plan, review: reviewDropping(), importedAt });
    expect(messageDeletes(second.sent).length).toBeGreaterThan(0);
    expect(contactDeletes(second.sent)).toHaveLength(1);
  });

  it('still refuses BEFORE destroying anything when the atomic guard loses', async () => {
    const { doc, sent } = retractStub({ guardLoses: true });
    const report = await runApply({ doc, plan, review: reviewDropping(), importedAt });

    expect(messageDeletes(sent)).toHaveLength(0);
    expect(contactDeletes(sent)).toHaveLength(0);
    const warning = report.warnings.find((w) => w.includes(DROPPED_PHONE));
    expect(warning).toContain('GROUP MEMBER');
    expect(warning).toContain('while this import was running');
  });
});
