// The conversion claims that need REAL conditional writes (S7 / spec 9, 15.4):
// the atomic type transition, the bulk-vs-inbound-auto-convert race, the
// removal of every relay-only field, and the first-write-wins consent stamp.
//
// Self-skipping like the other integration suites (`npm run db:start`).
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createContactsRepo, isDeleted } from '../src/repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationParticipant,
} from '../src/repos/conversationsRepo.js';
import { convertConnectingRelayGroupToGroupText } from '../src/services/groupConvert.js';
import { contactIdForPhone, conversationIdForGroup } from '../src/lib/import/ids.js';
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
  console.warn(
    `[groupConvert.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const AT = '2026-08-17T12:00:00.000Z';

/** One imported group's fixture. The conversationId IS uuidv5 over the sorted
 *  roster (invariant 13.5) and conversion now REFUSES a row whose stored roster
 *  does not hash back to its own id, so every fixture derives its id from the
 *  members it seeds - which is also what a real imported row looks like. Each
 *  case gets its OWN member pair because these tests share one table. */
interface GroupFixture {
  id: string;
  memberA: string;
  memberB: string;
}

describe.skipIf(!reachable)('convertConnectingRelayGroupToGroupText against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const conversationsRepo = createConversationsRepo({ doc, env: testEnv, logger });
  const contactsRepo = createContactsRepo({ doc, env: testEnv, logger });
  const opts = { conversationsRepo, contactsRepo, at: AT, logger };
  const conversationsTable = tableName('conversations', testEnv);
  const contactsTable = tableName('contacts', testEnv);

  let seq = 0;
  const nextGroup = (): GroupFixture => {
    const n = ++seq;
    const memberA = `+1555010${2000 + n * 2}`;
    const memberB = `+1555010${2001 + n * 2}`;
    return { id: conversationIdForGroup([memberA, memberB]), memberA, memberB };
  };

  /** The row exactly as the importer writes it, plus whatever the case needs. */
  const seedImportedGroup = async (
    group: GroupFixture,
    over: Record<string, unknown> = {},
  ): Promise<void> => {
    await doc.send(
      new PutCommand({
        TableName: conversationsTable,
        Item: {
          conversationId: group.id,
          type: 'relay_group',
          status: 'connecting',
          relay_status: 'relay_group#connecting',
          last_activity_at: '2026-07-26T10:00:00.000Z',
          created_at: '2026-07-25T10:00:00.000Z',
          ai_mode: 'manual',
          participants: [
            { contactId: '', phone: group.memberA },
            { contactId: '', phone: group.memberB },
          ],
          imported_from: 'quo-airtable-import',
          imported_at: '2026-08-05T00:00:00.000Z',
          ...over,
        },
      }),
    );
  };

  const seedContact = async (phone: string): Promise<string> => {
    const contactId = contactIdForPhone(phone);
    await doc.send(
      new PutCommand({
        TableName: contactsTable,
        Item: { contactId, phone, type: 'unknown', status: 'needs_review' },
      }),
    );
    return contactId;
  };

  const readConversation = async (conversationId: string): Promise<Record<string, unknown>> => {
    const { Item } = await doc.send(
      new GetCommand({ TableName: conversationsTable, Key: { conversationId } }),
    );
    return Item as Record<string, unknown>;
  };

  beforeAll(async () => {
    for (const t of ['conversations', 'contacts'] as const) {
      await ensureTable(client, getTableSpec(t), tableName(t, testEnv));
    }
  }, 60_000);

  afterAll(async () => {
    for (const t of ['conversations', 'contacts'] as const) {
      await deleteTableIfExists(client, tableName(t, testEnv));
    }
    client.destroy();
  }, 60_000);

  it('strips every relay-only field in the same write as the type flip', async () => {
    const g = nextGroup();
    await seedImportedGroup(g, {
      participants_version: 3,
      relay_opted_out_members: { [`phone#${g.memberA}`]: { at: AT } },
      close_nag_next_at: '2026-09-01T00:00:00.000Z',
      close_announced_at: '2026-08-01T00:00:00.000Z',
      participant_phone: '+15550199999',
      placementId: 'placement-1',
      owner: { type: 'placement', id: 'placement-1' },
    });
    await seedContact(g.memberA);
    await seedContact(g.memberB);

    const result = await convertConnectingRelayGroupToGroupText(g.id, opts);
    expect(result.outcome).toBe('converted');

    const stored = await readConversation(g.id);
    expect(stored.type).toBe('group_text');
    expect(stored.status).toBe('group_open');
    for (const relayOnly of [
      'relay_status',
      'pool_number',
      'participant_phone',
      'participants_version',
      'relay_opted_out_members',
      'close_nag_next_at',
      'close_announced_at',
      'ever_member_phones',
      'placementId',
      'owner',
    ]) {
      expect(stored[relayOnly]).toBeUndefined();
    }
    // Import provenance is KEPT: it is what makes the connect flag reportable on
    // a re-run, and it is not a relay mechanism.
    expect(stored.imported_from).toBe('quo-airtable-import');
    expect(stored.participants).toEqual([
      { contactId: contactIdForPhone(g.memberA), phone: g.memberA },
      { contactId: contactIdForPhone(g.memberB), phone: g.memberB },
    ]);
  });

  it('lets exactly one of two concurrent converters win, and the loser converges', async () => {
    // Bulk migration vs inbound auto-convert on the same thread at the same
    // instant. Both callers must end up reporting a converged thread.
    const g = nextGroup();
    await seedImportedGroup(g);
    await seedContact(g.memberA);
    await seedContact(g.memberB);

    const [left, right] = await Promise.all([
      convertConnectingRelayGroupToGroupText(g.id, opts),
      convertConnectingRelayGroupToGroupText(g.id, opts),
    ]);

    const outcomes = [left.outcome, right.outcome].sort();
    expect(outcomes).toEqual(['already_converted', 'converted']);
    const stored = await readConversation(g.id);
    expect(stored.type).toBe('group_text');
    expect(stored.relay_status).toBeUndefined();
    // Whoever lost still finished the job: the stamp exists exactly once.
    const contact = await doc.send(
      new GetCommand({
        TableName: contactsTable,
        Key: { contactId: contactIdForPhone(g.memberA) },
      }),
    );
    expect(contact.Item!.group_participation_at).toBe(AT);
  });

  it('never rewrites an existing group_participation_at', async () => {
    const g = nextGroup();
    await seedImportedGroup(g);
    const contactId = await seedContact(g.memberA);
    await seedContact(g.memberB);
    expect(await contactsRepo.stampGroupParticipation(contactId, '2026-01-01T00:00:00.000Z')).toBe(
      'stamped',
    );

    const result = await convertConnectingRelayGroupToGroupText(g.id, opts);
    expect(result.membersAlreadyStamped).toBeGreaterThanOrEqual(1);
    const contact = await doc.send(
      new GetCommand({ TableName: contactsTable, Key: { contactId } }),
    );
    expect(contact.Item!.group_participation_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('RE-MINTS a group-scoped stub for a member whose contact record is absent', async () => {
    // Against the real conditional create. A roster slot with no row behind it
    // makes groupSend refuse EVERY outbound on the thread forever, and nothing
    // re-resolves an existing thread's roster - so conversion mints the stub
    // detection would have minted, minus anything that grants SMS consent.
    const g = nextGroup();
    const known = g.memberA;
    const orphan = g.memberB;
    await seedImportedGroup(g);
    await seedContact(known);

    const result = await convertConnectingRelayGroupToGroupText(g.id, opts);
    expect(result.membersMissing).toEqual([]);
    expect(result.membersReminted).toBe(1);
    const contact = await doc.send(
      new GetCommand({
        TableName: contactsTable,
        Key: { contactId: contactIdForPhone(orphan) },
      }),
    );
    expect(contact.Item).toBeDefined();
    expect(contact.Item!.origin).toBe('group_detection');
    expect(contact.Item!.phone).toBe(orphan);
    expect(contact.Item!.type).toBe('unknown');
    expect(contact.Item!.status).toBe('needs_review');
    expect(typeof contact.Item!.group_participation_at).toBe('string');
    // The consent fields detection deliberately never writes.
    expect(contact.Item!.consent_method).toBeUndefined();
    expect(contact.Item!.consent_at).toBeUndefined();
    expect(contact.Item!.capture_source).toBeUndefined();
  });

  it('resolves a known phone through the byPhone index instead of minting a DUPLICATE', async () => {
    // adversarial 4, against the real GSI. `stubFor` was copied from
    // groupMembers.ts without the `findByPhone` that module mandates ahead of
    // it, and `createIfAbsent` conditions on `attribute_not_exists(contactId)`
    // - which structurally cannot see a same-phone row under a hand-made id. A
    // duplicate is not merely untidy: groupSend resolves members BY PHONE, and
    // `findByPhone` returns whichever row the index yields FIRST, so a fresh
    // stub can be handed to the send path in place of the staff-deleted real
    // contact and silently bypass its soft-delete fence.
    const g = nextGroup();
    const handMadeId = `contact-hand-made-${randomUUID().slice(0, 8)}`;
    await seedImportedGroup(g);
    await seedContact(g.memberA);
    await doc.send(
      new PutCommand({
        TableName: contactsTable,
        Item: {
          contactId: handMadeId,
          phone: g.memberB,
          type: 'tenant',
          status: 'active',
          deleted_at: '2026-08-01T00:00:00.000Z',
        },
      }),
    );

    const result = await convertConnectingRelayGroupToGroupText(g.id, opts);

    expect(result.membersReminted).toBe(0);
    expect(result.membersMissing).toEqual([]);
    // The derived id has no row of its own - nothing was minted.
    const derived = await doc.send(
      new GetCommand({
        TableName: contactsTable,
        Key: { contactId: contactIdForPhone(g.memberB) },
      }),
    );
    expect(derived.Item).toBeUndefined();
    // The person we already had got the group consent basis.
    const known = await doc.send(
      new GetCommand({ TableName: contactsTable, Key: { contactId: handMadeId } }),
    );
    expect(known.Item!.group_participation_at).toBe(AT);
    // THE SOFT-DELETE FENCE STILL SEES THEM: the phone resolves to the deleted
    // contact, which is exactly what groupSend reads before it refuses.
    const resolved = await contactsRepo.findByPhone(g.memberB);
    expect(resolved?.contactId).toBe(handMadeId);
    expect(isDeleted(resolved!)).toBe(true);
  });

  it('re-running the conversion does not re-mint or overwrite the stub', async () => {
    const g = nextGroup();
    await seedImportedGroup(g);
    await seedContact(g.memberA);

    const first = await convertConnectingRelayGroupToGroupText(g.id, opts);
    expect(first.membersReminted).toBe(1);
    const stubId = contactIdForPhone(g.memberB);
    const after = await doc.send(
      new GetCommand({ TableName: contactsTable, Key: { contactId: stubId } }),
    );

    const second = await convertConnectingRelayGroupToGroupText(g.id, opts);
    expect(second.membersReminted).toBe(0);
    expect(second.membersMissing).toEqual([]);
    const again = await doc.send(
      new GetCommand({ TableName: contactsTable, Key: { contactId: stubId } }),
    );
    expect(again.Item!.group_participation_at).toBe(after.Item!.group_participation_at);
  });

  it('REFUSES a roster write whose prior roster changed under it - a real ConditionalCheckFailed', async () => {
    // adversarial 24. `participants = :prior` is a list-of-maps equality
    // precondition, and it had ZERO real-DynamoDB coverage: the webhook harness
    // declares `backfillGroupTextRoster(conversationId, members)` and DROPS the
    // third argument, so every test through it passes whether the condition
    // works, always fails, or never fails. If DynamoDB answered a
    // ValidationException instead of a ConditionalCheckFailedException the repo
    // would RETHROW, `converge` would throw, the bulk runner would book the row
    // `refused`, and `complete` could never become true - on the one command
    // that runs at cutover. A RESOLVED `undefined` is the proof it is a CCFE:
    // the repo swallows that one exception and rethrows everything else.
    const g = nextGroup();
    await seedImportedGroup(g);
    await seedContact(g.memberA);
    await seedContact(g.memberB);
    await convertConnectingRelayGroupToGroupText(g.id, opts);

    const stored = (await readConversation(g.id)).participants as ConversationParticipant[];
    expect(stored).toHaveLength(2);

    // Somebody else rewrote the roster after we read it (a `name` resolved by a
    // concurrent converge is the realistic version).
    const winner = stored.map((m) => ({ ...m, name: 'Winner' }));
    expect(await conversationsRepo.backfillGroupTextRoster(g.id, winner, stored)).toBeDefined();

    // Our write, still carrying the roster we read, must be REFUSED rather than
    // clobbering the winner wholesale.
    const loser = stored.map((m) => ({ ...m, name: 'Loser' }));
    const refused = await conversationsRepo.backfillGroupTextRoster(g.id, loser, stored);
    expect(refused).toBeUndefined();
    const after = (await readConversation(g.id)).participants as ConversationParticipant[];
    expect(after.map((m) => m.name)).toEqual(['Winner', 'Winner']);

    // ...and the SAME call with the roster that is actually stored succeeds, so
    // the refusal above is the precondition working rather than it never passing.
    const accepted = await conversationsRepo.backfillGroupTextRoster(g.id, loser, winner);
    expect(accepted).toBeDefined();
    expect(
      ((await readConversation(g.id)).participants as ConversationParticipant[]).map((m) => m.name),
    ).toEqual(['Loser', 'Loser']);
  });

  it('refuses a connected relay group and leaves the row untouched', async () => {
    const g = nextGroup();
    await seedImportedGroup(g, {
      status: 'open',
      relay_status: 'relay_group#open',
      pool_number: '+15550199999',
    });

    const result = await convertConnectingRelayGroupToGroupText(g.id, opts);
    expect(result.outcome).toBe('refused');
    const stored = await readConversation(g.id);
    expect(stored.type).toBe('relay_group');
    expect(stored.status).toBe('open');
    expect(stored.pool_number).toBe('+15550199999');
  });

  it('REFUSES a row whose stored roster does not hash back to its own id, and writes nothing', async () => {
    // The workbook-`drop` shape: the importer derives the id from ALL
    // participants but writes a roster filtered by the founder's drops, so the
    // row lands under a 3-person id carrying a 2-person roster. Converting it
    // would propagate the lie into detection, whose own sender could then be a
    // non-member of the thread its message lands on.
    const g = nextGroup();
    const dropped = '+15550109999';
    const fullSetId = conversationIdForGroup([g.memberA, g.memberB, dropped]);
    await seedImportedGroup({ ...g, id: fullSetId });
    await seedContact(g.memberA);
    await seedContact(g.memberB);

    const result = await convertConnectingRelayGroupToGroupText(fullSetId, opts);
    expect(result.outcome).toBe('refused');
    expect(result.refusal).toBe('roster_id_mismatch');
    expect(result.refusedReason).toContain('does not hash back');

    // NOTHING was written - not the type flip, not the contactId backfill.
    const stored = await readConversation(fullSetId);
    expect(stored.type).toBe('relay_group');
    expect(stored.status).toBe('connecting');
    expect(stored.participants).toEqual([
      { contactId: '', phone: g.memberA },
      { contactId: '', phone: g.memberB },
    ]);
  });
});
