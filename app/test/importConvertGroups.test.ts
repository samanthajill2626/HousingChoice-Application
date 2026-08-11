// The bulk group-text migration runner (S7 / T7.4, spec 9 + 15.4).
//
// The claims: parity refuses the WHOLE run in either direction before anything
// is touched, every expected id is driven to the FULL end state on EVERY run
// (never skipped for being already converted), the rail step is an injectable
// dependency S6 wires later, and a run that died halfway is completed by the
// next one.
import { describe, expect, it, vi } from 'vitest';
import {
  GroupIdentityParityError,
  RAIL_STEP_NOT_WIRED,
  checkGroupIdentityParity,
  runConvertGroups,
  type ConvertGroupsOptions,
  type GroupRailEnsurer,
  type GroupRailResult,
} from '../src/lib/import/convertGroups.js';
import { contactIdForPhone, conversationIdForGroup } from '../src/lib/import/ids.js';
import type { ContactItem, ContactsRepo } from '../src/repos/contactsRepo.js';
import type {
  ConversationItem,
  ConversationParticipant,
  ConversationsRepo,
} from '../src/repos/conversationsRepo.js';

const OUR_NUMBER = '+15550100000';
const SECOND_ORG_NUMBER = '+15550100001';
const MEMBERS = [
  ['+15550100008', '+15550100004'],
  ['+15550100009', '+15550100005'],
] as const;
const AT = '2026-08-17T12:00:00.000Z';

function importedRow(members: readonly string[]): ConversationItem {
  return {
    conversationId: conversationIdForGroup([...members]),
    type: 'relay_group',
    status: 'connecting',
    relay_status: 'relay_group#connecting',
    last_activity_at: '2026-07-26T10:00:00.000Z',
    created_at: '2026-07-25T10:00:00.000Z',
    ai_mode: 'manual',
    participants: members.map((phone) => ({ contactId: '', phone })),
    imported_from: 'quo-airtable-import',
  };
}

interface World {
  conversations: Map<string, ConversationItem>;
  contacts: Map<string, ContactItem>;
  base: Omit<ConvertGroupsOptions, 'expected'>;
}

function world(rows: ConversationItem[]): World {
  const conversations = new Map(rows.map((r) => [r.conversationId, r]));
  const contacts = new Map<string, ContactItem>();
  for (const row of rows) {
    for (const member of row.participants ?? []) {
      const contactId = contactIdForPhone(member.phone);
      contacts.set(contactId, { contactId, phone: member.phone, type: 'unknown' } as ContactItem);
    }
  }

  const conversationsRepo = {
    async getById(id: string) {
      return conversations.get(id);
    },
    async convertRelayGroupToGroupText(id: string, members: ConversationParticipant[]) {
      const conv = conversations.get(id);
      if (!conv || conv.type !== 'relay_group' || conv.status !== 'connecting') return undefined;
      const next: ConversationItem = {
        ...conv,
        type: 'group_text',
        status: 'group_open',
        participants: members,
      };
      delete next.relay_status;
      conversations.set(id, next);
      return next;
    },
    async backfillGroupTextRoster(id: string, members: ConversationParticipant[]) {
      const conv = conversations.get(id);
      if (!conv || conv.type !== 'group_text') return undefined;
      const next = { ...conv, participants: members };
      conversations.set(id, next);
      return next;
    },
  } as unknown as ConversationsRepo;

  const contactsRepo = {
    async getById(contactId: string) {
      return contacts.get(contactId);
    },
    async stampGroupParticipation(contactId: string, at: string) {
      const contact = contacts.get(contactId);
      if (!contact) return 'missing' as const;
      if (typeof contact.group_participation_at === 'string') return 'already' as const;
      contact.group_participation_at = at;
      return 'stamped' as const;
    },
  } as unknown as ContactsRepo;

  return {
    conversations,
    contacts,
    base: {
      conversationsRepo,
      contactsRepo,
      ownNumbers: [OUR_NUMBER, SECOND_ORG_NUMBER],
      exclusions: {
        businessPhoneNumber: OUR_NUMBER,
        poolNumbers: [],
        configuredNumbers: [SECOND_ORG_NUMBER],
      },
      at: AT,
    },
  };
}

const expectedFor = (rows: ConversationItem[]): { conversationId: string; rowKey: string }[] =>
  rows.map((r, i) => ({
    conversationId: r.conversationId,
    rowKey: `GRP-${String(i + 1).padStart(4, '0')}`,
  }));

/** A rail ensurer that records its calls and answers with a scripted outcome. */
function railStub(
  answer: (conversationId: string) => GroupRailResult,
): GroupRailEnsurer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async ensureGroupRail({ conversationId }) {
      calls.push(conversationId);
      return answer(conversationId);
    },
  };
}

describe('checkGroupIdentityParity', () => {
  it('accepts the healthy case: ownNumbers minus the business number', () => {
    const parity = checkGroupIdentityParity([OUR_NUMBER, SECOND_ORG_NUMBER], {
      businessPhoneNumber: OUR_NUMBER,
      configuredNumbers: [SECOND_ORG_NUMBER],
    });
    expect(parity.ok).toBe(true);
  });

  it('normalizes both sides, so a formatted config value still matches', () => {
    const parity = checkGroupIdentityParity([OUR_NUMBER, SECOND_ORG_NUMBER], {
      businessPhoneNumber: '(555) 010-0000',
      configuredNumbers: ['(555) 010-0001'],
    });
    expect(parity.ok).toBe(true);
  });

  it('reports a number the export has and the runtime does not', () => {
    // This one mints a DIFFERENT id for the same group.
    const parity = checkGroupIdentityParity([OUR_NUMBER, SECOND_ORG_NUMBER], {
      businessPhoneNumber: OUR_NUMBER,
      configuredNumbers: [],
    });
    expect(parity.ok).toBe(false);
    expect(parity.missingFromRuntime).toEqual([SECOND_ORG_NUMBER]);
    expect(parity.extraInRuntime).toEqual([]);
  });

  it('reports a number the runtime has and the export does not', () => {
    // This one silently subtracts a real member from every roster.
    const parity = checkGroupIdentityParity([OUR_NUMBER], {
      businessPhoneNumber: OUR_NUMBER,
      configuredNumbers: ['+15550100777'],
    });
    expect(parity.ok).toBe(false);
    expect(parity.missingFromRuntime).toEqual([]);
    expect(parity.extraInRuntime).toEqual(['+15550100777']);
  });

  it('ignores pool numbers on both sides', () => {
    const parity = checkGroupIdentityParity([OUR_NUMBER, '+15550199999'], {
      businessPhoneNumber: OUR_NUMBER,
      poolNumbers: ['+15550199999'],
      configuredNumbers: [],
    });
    expect(parity.ok).toBe(true);
  });
});

describe('runConvertGroups', () => {
  it('converges every expected group and reports per row', async () => {
    const rows = MEMBERS.map((m) => importedRow(m));
    const w = world(rows);
    const rail = railStub(() => ({ status: 'created', twilioConversationSid: 'CH1' }));

    const report = await runConvertGroups({ ...w.base, expected: expectedFor(rows), rail });

    expect(report.totals).toMatchObject({
      expected: 2,
      converted: 2,
      alreadyConverted: 0,
      refused: 0,
      railsCreated: 2,
    });
    expect(report.complete).toBe(true);
    expect(report.rows[0]).toMatchObject({
      rowKey: 'GRP-0001',
      outcome: 'converted',
      rail: 'created',
      railSid: 'CH1',
      contactIdsBackfilled: 2,
      membersStamped: 2,
    });
  });

  it('REFUSES the whole run on a parity mismatch, before touching anything', async () => {
    const rows = MEMBERS.map((m) => importedRow(m));
    const w = world(rows);

    await expect(
      runConvertGroups({
        ...w.base,
        exclusions: { businessPhoneNumber: OUR_NUMBER, configuredNumbers: [] },
        expected: expectedFor(rows),
      }),
    ).rejects.toBeInstanceOf(GroupIdentityParityError);

    for (const row of rows) {
      expect(w.conversations.get(row.conversationId)!.type).toBe('relay_group');
    }
  });

  it('names both mismatch directions in the refusal', async () => {
    const rows = [importedRow(MEMBERS[0])];
    const w = world(rows);
    const err = await runConvertGroups({
      ...w.base,
      ownNumbers: [OUR_NUMBER, SECOND_ORG_NUMBER],
      exclusions: { businessPhoneNumber: OUR_NUMBER, configuredNumbers: ['+15550100777'] },
      expected: expectedFor(rows),
    }).catch((e: unknown) => e as GroupIdentityParityError);

    expect(err).toBeInstanceOf(GroupIdentityParityError);
    expect((err as GroupIdentityParityError).parity.missingFromRuntime).toEqual([
      SECOND_ORG_NUMBER,
    ]);
    expect((err as GroupIdentityParityError).parity.extraInRuntime).toEqual(['+15550100777']);
    expect((err as GroupIdentityParityError).message).toContain('Nothing was converted');
  });

  it('re-runs the FULL end state for an already-converted thread', async () => {
    const rows = MEMBERS.map((m) => importedRow(m));
    const w = world(rows);
    const rail = railStub(() => ({ status: 'existing', twilioConversationSid: 'CH1' }));
    const expected = expectedFor(rows);

    await runConvertGroups({
      ...w.base,
      expected,
      rail: railStub(() => ({ status: 'created' })),
    });
    const second = await runConvertGroups({ ...w.base, expected, rail });

    expect(second.totals.alreadyConverted).toBe(2);
    expect(second.totals.converted).toBe(0);
    // The rail step ran for BOTH rows on the second pass. "Already converted"
    // must never mean "skip the rest".
    expect(rail.calls).toHaveLength(2);
    expect(second.complete).toBe(true);
  });

  it('completes a run that died after conversion but before stamping and railing', async () => {
    // The exact partial-failure the convergence rule exists for.
    const rows = MEMBERS.map((m) => importedRow(m));
    const w = world(rows);
    const expected = expectedFor(rows);

    // Pass 1: the rail service is down and the stamps never happened (model it
    // by converting through the repo directly, as a crashed run would leave it).
    for (const row of rows) {
      await w.base.conversationsRepo.convertRelayGroupToGroupText(
        row.conversationId,
        (row.participants ?? []).map((m) => ({ ...m, contactId: contactIdForPhone(m.phone) })),
      );
    }
    for (const contact of w.contacts.values()) {
      expect(contact.group_participation_at).toBeUndefined();
    }

    const rail = railStub(() => ({ status: 'created' }));
    const report = await runConvertGroups({ ...w.base, expected, rail });

    expect(report.totals.alreadyConverted).toBe(2);
    expect(report.totals.membersStamped).toBe(4);
    expect(rail.calls).toHaveLength(2);
    expect(report.complete).toBe(true);
    for (const contact of w.contacts.values()) {
      expect(contact.group_participation_at).toBe(AT);
    }
  });

  it('records a rail failure per row without stopping the rest', async () => {
    const rows = MEMBERS.map((m) => importedRow(m));
    const w = world(rows);
    const failing = rows[0]!.conversationId;
    const rail = railStub((id) =>
      id === failing
        ? { status: 'failed', reason: 'twilio 50407' }
        : { status: 'created', twilioConversationSid: 'CH2' },
    );

    const report = await runConvertGroups({ ...w.base, expected: expectedFor(rows), rail });

    expect(report.totals.converted).toBe(2);
    expect(report.totals.railsFailed).toBe(1);
    expect(report.totals.railsCreated).toBe(1);
    expect(report.complete).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('50407'))).toBe(true);
  });

  it('turns a THROWN rail error into a failed row, never a failed run', async () => {
    const rows = MEMBERS.map((m) => importedRow(m));
    const w = world(rows);
    const rail: GroupRailEnsurer = {
      ensureGroupRail: vi.fn(async () => {
        throw new Error('conversations API unreachable');
      }),
    };

    const report = await runConvertGroups({ ...w.base, expected: expectedFor(rows), rail });
    expect(report.totals.railsFailed).toBe(2);
    expect(report.rows[0]!.railReason).toContain('unreachable');
    expect(report.complete).toBe(false);
  });

  it('reports the rail step as UNAVAILABLE until S6 wires it', async () => {
    const rows = [importedRow(MEMBERS[0])];
    const w = world(rows);

    const report = await runConvertGroups({
      ...w.base,
      expected: expectedFor(rows),
      rail: RAIL_STEP_NOT_WIRED,
    });

    expect(report.totals.railsUnavailable).toBe(1);
    expect(report.rows[0]!.railReason).toContain('not wired yet');
    // Deliberately incomplete: nothing was attempted, so the run is not done.
    expect(report.complete).toBe(false);
  });

  it('refuses a row that is not a convertible relay group and never rails it', async () => {
    const rows = [importedRow(MEMBERS[0]), importedRow(MEMBERS[1])];
    rows[1]!.status = 'open';
    rows[1]!.pool_number = '+15550199999';
    const w = world(rows);
    const rail = railStub(() => ({ status: 'created' }));

    const report = await runConvertGroups({ ...w.base, expected: expectedFor(rows), rail });

    expect(report.totals.refused).toBe(1);
    expect(rail.calls).toEqual([rows[0]!.conversationId]);
    expect(report.rows[1]!.railReason).toContain('not attempted');
    expect(report.complete).toBe(false);
  });

  it('reports an expected id with no row at all rather than skipping it', async () => {
    const w = world([]);
    const report = await runConvertGroups({
      ...w.base,
      expected: [{ conversationId: 'missing-group', rowKey: 'GRP-0009' }],
      rail: railStub(() => ({ status: 'created' })),
    });

    expect(report.totals.refused).toBe(1);
    expect(report.warnings[0]).toContain('GRP-0009');
    expect(report.complete).toBe(false);
  });

  it('reports members with no contact record and stays incomplete-free about it', async () => {
    const rows = [importedRow(MEMBERS[0])];
    const w = world(rows);
    w.contacts.delete(contactIdForPhone(MEMBERS[0]![1]!));

    const report = await runConvertGroups({
      ...w.base,
      expected: expectedFor(rows),
      rail: railStub(() => ({ status: 'created' })),
    });

    expect(report.totals.membersMissing).toBe(1);
    expect(report.warnings.some((warning) => warning.includes('no contact record'))).toBe(true);
    // A dropped person with no contact record is a data fact, not a failed
    // migration step - the run is still complete.
    expect(report.complete).toBe(true);
  });

  it('processes a duplicated expected id exactly once', async () => {
    const rows = [importedRow(MEMBERS[0])];
    const w = world(rows);
    const rail = railStub(() => ({ status: 'created' }));
    const one = expectedFor(rows)[0]!;

    const report = await runConvertGroups({ ...w.base, expected: [one, one], rail });
    expect(report.rows).toHaveLength(1);
    expect(rail.calls).toHaveLength(1);
  });
});

describe('runConvertGroups: the report survives a bad row', () => {
  it('isolates a THROWING row as a refusal and finishes the run', async () => {
    // The rail step beside it is explicitly hardened against exactly this ("one
    // bad thread must not stop the other 131"); the conversion step was not, so
    // ONE DynamoDB throttle anywhere in the 132 x (1 + N members) calls threw
    // out of the whole run, past the script's parity-only catch, and the
    // operator got a stack trace INSTEAD OF THE REPORT - on a step that runs
    // once, on cutover day. THE REPORT IS THE CUTOVER GATE (spec 14).
    const rows = [importedRow(MEMBERS[0]), importedRow(MEMBERS[1])];
    const w = world(rows);
    const doomed = rows[1]!.conversationId;
    const realGetById = w.base.conversationsRepo.getById.bind(w.base.conversationsRepo);
    w.base.conversationsRepo.getById = (async (id: string) => {
      if (id === doomed) throw new Error('ProvisionedThroughputExceededException');
      return realGetById(id);
    }) as typeof w.base.conversationsRepo.getById;

    const report = await runConvertGroups({ ...w.base, expected: expectedFor(rows) });

    // BOTH rows are in the report - the healthy one converted, the bad one told
    // the operator what broke.
    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]?.outcome).toBe('converted');
    expect(report.rows[1]?.outcome).toBe('refused');
    expect(report.rows[1]?.refusedReason).toContain('ProvisionedThroughputExceeded');
    expect(report.complete).toBe(false);
    expect(w.conversations.get(rows[0]!.conversationId)?.type).toBe('group_text');
  });

  it('counts `expected` from the EXPORT, not from the rows it got through', async () => {
    const rows = [importedRow(MEMBERS[0])];
    const w = world(rows);
    const dup = expectedFor(rows)[0]!;

    const report = await runConvertGroups({ ...w.base, expected: [dup, { ...dup }] });

    // `seen` dedupes the second copy, so one row was processed - but the export
    // named two ids, and the report must say so.
    expect(report.rows).toHaveLength(1);
    expect(report.totals.expected).toBe(2);
  });

  it('never reports COMPLETE for an EMPTY expected set', async () => {
    const w = world([]);

    const report = await runConvertGroups({ ...w.base, expected: [] });

    expect(report.complete).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('EMPTY'))).toBe(true);
  });

  it('REFUSES a row whose stored roster does not hash back to its own id', async () => {
    // The workbook-`drop` shape: the importer derives the id from ALL
    // participants but writes a roster filtered by the founder's drops.
    const row = importedRow(MEMBERS[0]);
    row.conversationId = conversationIdForGroup([...MEMBERS[0], '+15550109999']);
    const w = world([row]);

    const report = await runConvertGroups({ ...w.base, expected: expectedFor([row]) });

    expect(report.rows[0]?.outcome).toBe('refused');
    expect(report.rows[0]?.refusedReason).toContain('does not hash back');
    expect(report.complete).toBe(false);
    // NOTHING was written.
    expect(w.conversations.get(row.conversationId)?.type).toBe('relay_group');
  });

  it('backfills member NAMES so a migrated roster does not render as phone numbers', async () => {
    // Imported rosters carry no `name`, and the group title is DERIVED from the
    // roster - so without this every migrated group reads as a row of numbers in
    // the inbox and on the contact card while the thread view shows real names.
    const row = importedRow(MEMBERS[0]);
    const w = world([row]);
    const first = w.contacts.get(contactIdForPhone(MEMBERS[0][0]))!;
    first.firstName = 'Marcus';
    first.lastName = 'Landlord';

    await runConvertGroups({ ...w.base, expected: expectedFor([row]) });

    const roster = w.conversations.get(row.conversationId)?.participants ?? [];
    expect(roster.find((m) => m.phone === MEMBERS[0][0])?.name).toBe('Marcus Landlord');
  });

  it('COUNTS the name backfill - the largest data change the run makes', async () => {
    // The report IS the cutover gate, and the name backfill touches every one of
    // the 132 rosters. A counter that does not exist cannot be reconciled.
    const row = importedRow(MEMBERS[0]);
    const w = world([row]);
    for (const phone of MEMBERS[0]) {
      w.contacts.get(contactIdForPhone(phone))!.firstName = 'Ada';
    }

    const report = await runConvertGroups({
      ...w.base,
      expected: expectedFor([row]),
      rail: railStub(() => ({ status: 'created' })),
    });

    expect(report.rows[0]?.namesBackfilled).toBe(2);
    expect(report.totals.namesBackfilled).toBe(2);
  });

  it('reports ZERO names backfilled when every member is nameless', async () => {
    const row = importedRow(MEMBERS[0]);
    const w = world([row]);

    const report = await runConvertGroups({
      ...w.base,
      expected: expectedFor([row]),
      rail: railStub(() => ({ status: 'created' })),
    });

    expect(report.totals.namesBackfilled).toBe(0);
  });

  it('the totals RECONCILE on a duplicated expected id, and say so', async () => {
    // `expected` counts the ids the EXPORT says must exist; every other total
    // counts the rows walked, and the `seen` dedupe makes those differ. The
    // printed report invites the operator to reconcile them, so the difference
    // has to be a NAMED number rather than a silent gap.
    const rows = MEMBERS.map((m) => importedRow(m));
    const w = world(rows);
    const expected = [
      ...expectedFor(rows),
      { conversationId: rows[0]!.conversationId, rowKey: 'GRP-0003' },
    ];

    const report = await runConvertGroups({
      ...w.base,
      expected,
      rail: railStub(() => ({ status: 'created' })),
    });

    expect(report.totals.expected).toBe(3);
    expect(report.totals.duplicateIds).toBe(1);
    expect(report.totals.processed).toBe(2);
    expect(report.totals.expected).toBe(report.totals.processed + report.totals.duplicateIds);
    expect(
      report.totals.converted + report.totals.alreadyConverted + report.totals.refused,
    ).toBe(report.totals.processed);
    expect(report.warnings.some((line) => line.includes('appeared more than once'))).toBe(true);
  });

  it('reports no duplicates and a closing sum on an ordinary run', async () => {
    const rows = MEMBERS.map((m) => importedRow(m));
    const w = world(rows);

    const report = await runConvertGroups({
      ...w.base,
      expected: expectedFor(rows),
      rail: railStub(() => ({ status: 'created' })),
    });

    expect(report.totals.duplicateIds).toBe(0);
    expect(report.totals.processed).toBe(report.totals.expected);
    expect(report.warnings.some((line) => line.includes('appeared more than once'))).toBe(false);
  });
});
