// Unit tests for the unread-flag backfill's PURE planner (design 2026-08-16
// section 7.2). No database: every rule, and the precedence BETWEEN rules, is
// decided by planUnreadBackfill alone - the runner's job is only to execute the
// verdict and to resolve a `probe` with one message read.
//
// The precedence is the contract, not an implementation detail: rules 2 and 3
// (the retroactive close/delete resets) deliberately outrank rule 4 (stamp), so
// legacy invisible residents are cleaned rather than suddenly surfaced into the
// badge.
import { describe, it, expect } from 'vitest';
import {
  NO_DELETED_CONTACTS,
  deletedAtForItem,
  planUnreadBackfill,
  resolveProbe,
  type DeletedContactKeys,
} from '../scripts/backfill-unread-flag.js';
import { UNREAD_FLAG_VALUE } from '../src/repos/conversationsRepo.js';

const DELETED_PHONE = '+15550100999';
const DELETED_EMAIL = 'gone@example.test';
const DELETED_AT = '2026-08-10T00:00:00.000Z';

const DELETED: DeletedContactKeys = {
  phones: new Set([DELETED_PHONE]),
  emails: new Set([DELETED_EMAIL]),
  deletedAtByKey: new Map([
    [DELETED_PHONE, DELETED_AT],
    [DELETED_EMAIL, DELETED_AT],
  ]),
};

/** A plain 1:1 conversation row as a Scan returns it (raw, untyped document). */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId: 'conv-0001',
    type: 'tenant_1to1',
    status: 'open',
    participant_phone: '+15550100001',
    last_activity_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('planUnreadBackfill', () => {
  describe('rule 1 - pointer/claim partitions', () => {
    it.each(['phone#+15550100001', 'email#someone@example.test', 'token#abc123'])(
      'skips %s (key-only rows that can never enter the index)',
      (conversationId) => {
        // Deliberately give it unread-looking attributes: the prefix alone must
        // decide, because a pointer row is not a conversation.
        expect(
          planUnreadBackfill(
            { conversationId, ref_conversationId: 'conv-0001', unread_count: 5 },
            DELETED,
          ),
        ).toEqual({ kind: 'skip' });
      },
    );
  });

  describe('rule 2 - relay group closed while unread', () => {
    it('resets a CLOSED relay_group carrying unread', () => {
      expect(
        planUnreadBackfill(
          row({ type: 'relay_group', status: 'closed', unread_count: 3 }),
          NO_DELETED_CONTACTS,
        ),
      ).toEqual({ kind: 'reset' });
    });

    it('resets it even when it is already flagged (the flag is not the point)', () => {
      expect(
        planUnreadBackfill(
          row({
            type: 'relay_group',
            status: 'closed',
            unread_count: 3,
            unread_flag: UNREAD_FLAG_VALUE,
          }),
          NO_DELETED_CONTACTS,
        ),
      ).toEqual({ kind: 'reset' });
    });

    it('OUTRANKS the stamp rule - a closed unread relay is never surfaced', () => {
      // Precedence proof: this row satisfies rule 4 too (unread > 0, no flag).
      const closedUnread = row({ type: 'relay_group', status: 'closed', unread_count: 3 });
      expect(planUnreadBackfill(closedUnread, NO_DELETED_CONTACTS).kind).not.toBe('stamp');
    });

    it('leaves an OPEN relay group alone - it stamps like any unread thread', () => {
      expect(
        planUnreadBackfill(
          row({ type: 'relay_group', status: 'open', unread_count: 3 }),
          NO_DELETED_CONTACTS,
        ),
      ).toEqual({ kind: 'stamp' });
    });

    it('a closed relay with NO unread just drops a stray flag', () => {
      expect(
        planUnreadBackfill(
          row({
            type: 'relay_group',
            status: 'closed',
            unread_count: 0,
            unread_flag: UNREAD_FLAG_VALUE,
          }),
          NO_DELETED_CONTACTS,
        ),
      ).toEqual({ kind: 'remove' });
    });
  });

  describe('rule 3 - soft-deleted contact threads', () => {
    it('probes an unread thread whose participant PHONE belongs to a deleted contact', () => {
      expect(
        planUnreadBackfill(row({ participant_phone: DELETED_PHONE, unread_count: 2 }), DELETED),
      ).toEqual({ kind: 'probe' });
    });

    it('probes an unread thread matched by participant EMAIL', () => {
      expect(
        planUnreadBackfill(
          row({ participant_phone: undefined, participant_email: DELETED_EMAIL, unread_count: 2 }),
          DELETED,
        ),
      ).toEqual({ kind: 'probe' });
    });

    it('OUTRANKS the stamp rule, so a deleted contact never surfaces unprobed', () => {
      const deletedUnread = row({ participant_phone: DELETED_PHONE, unread_count: 2 });
      expect(planUnreadBackfill(deletedUnread, DELETED).kind).not.toBe('stamp');
      // ...and the SAME row against a live contact stamps, which is what makes
      // this a precedence test rather than a restatement of rule 4.
      expect(planUnreadBackfill(deletedUnread, NO_DELETED_CONTACTS)).toEqual({ kind: 'stamp' });
    });

    it('a closed relay whose participant is deleted still takes the CLOSE rule (2 before 3)', () => {
      expect(
        planUnreadBackfill(
          row({
            type: 'relay_group',
            status: 'closed',
            participant_phone: DELETED_PHONE,
            unread_count: 2,
          }),
          DELETED,
        ),
      ).toEqual({ kind: 'reset' });
    });

    it('does not probe a READ thread of a deleted contact - it just drops the flag', () => {
      expect(
        planUnreadBackfill(
          row({
            participant_phone: DELETED_PHONE,
            unread_count: 0,
            unread_flag: UNREAD_FLAG_VALUE,
          }),
          DELETED,
        ),
      ).toEqual({ kind: 'remove' });
    });
  });

  describe('rule 4 - stamp', () => {
    it('stamps an unread row with no flag (the migration proper)', () => {
      expect(planUnreadBackfill(row({ unread_count: 1 }), NO_DELETED_CONTACTS)).toEqual({
        kind: 'stamp',
      });
    });

    it('is idempotent: an already-flagged unread row is skipped, not re-stamped', () => {
      expect(
        planUnreadBackfill(
          row({ unread_count: 1, unread_flag: UNREAD_FLAG_VALUE }),
          NO_DELETED_CONTACTS,
        ),
      ).toEqual({ kind: 'skip' });
    });

    it('stamps a legacy row with no `type` at all', () => {
      // ConversationItem.type is REQUIRED in the type system, but the rows this
      // script exists for are RAW legacy documents that predate it - the planner
      // takes Record<string, unknown> precisely so it can decide about them.
      const legacy: Record<string, unknown> = {
        conversationId: 'conv-legacy',
        status: 'open',
        participant_phone: '+15550100002',
        unread_count: 4,
      };
      expect(planUnreadBackfill(legacy, NO_DELETED_CONTACTS)).toEqual({ kind: 'stamp' });
    });
  });

  describe('rule 5 - remove a stale flag', () => {
    it('removes the flag when the count is 0', () => {
      expect(
        planUnreadBackfill(
          row({ unread_count: 0, unread_flag: UNREAD_FLAG_VALUE }),
          NO_DELETED_CONTACTS,
        ),
      ).toEqual({ kind: 'remove' });
    });

    it('removes the flag when the count attribute is ABSENT entirely', () => {
      expect(
        planUnreadBackfill(row({ unread_flag: UNREAD_FLAG_VALUE }), NO_DELETED_CONTACTS),
      ).toEqual({ kind: 'remove' });
    });
  });

  describe('rule 6 - already correct', () => {
    it('skips a read row with no flag', () => {
      expect(planUnreadBackfill(row({ unread_count: 0 }), NO_DELETED_CONTACTS)).toEqual({
        kind: 'skip',
      });
    });

    it('skips a freshly imported row that carries no unread attributes at all', () => {
      expect(planUnreadBackfill(row(), NO_DELETED_CONTACTS)).toEqual({ kind: 'skip' });
    });

    it('treats a non-numeric unread_count as zero rather than throwing', () => {
      expect(
        planUnreadBackfill(row({ unread_count: 'two' }), NO_DELETED_CONTACTS),
      ).toEqual({ kind: 'skip' });
    });
  });
});

describe('deletedAtForItem', () => {
  it('resolves by phone FIRST, matching the runtime hydration order', () => {
    const keys: DeletedContactKeys = {
      phones: new Set([DELETED_PHONE]),
      emails: new Set([DELETED_EMAIL]),
      deletedAtByKey: new Map([
        [DELETED_PHONE, '2026-08-01T00:00:00.000Z'],
        [DELETED_EMAIL, '2026-08-20T00:00:00.000Z'],
      ]),
    };
    expect(
      deletedAtForItem(
        row({ participant_phone: DELETED_PHONE, participant_email: DELETED_EMAIL }),
        keys,
      ),
    ).toBe('2026-08-01T00:00:00.000Z');
  });

  it('falls back to email when the phone is not a deleted key', () => {
    expect(
      deletedAtForItem(row({ participant_email: DELETED_EMAIL }), DELETED),
    ).toBe(DELETED_AT);
  });

  it('is undefined for a live contact', () => {
    expect(deletedAtForItem(row(), DELETED)).toBeUndefined();
  });
});

describe('resolveProbe (the runtime resurfacing predicate)', () => {
  it('probe -> STAMP when the newest message is inbound AFTER the delete', () => {
    expect(
      resolveProbe({ direction: 'inbound', created_at: '2026-08-11T00:00:00.000Z' }, DELETED_AT),
    ).toEqual({ kind: 'stamp' });
  });

  it('probe -> RESET when the newest inbound predates the delete', () => {
    expect(
      resolveProbe({ direction: 'inbound', created_at: '2026-08-09T00:00:00.000Z' }, DELETED_AT),
    ).toEqual({ kind: 'reset' });
  });

  it('probe -> RESET when the newest message is OUTBOUND, however recent', () => {
    // Outbound never resurfaces a deleted contact - only THEY can.
    expect(
      resolveProbe({ direction: 'outbound', created_at: '2026-09-01T00:00:00.000Z' }, DELETED_AT),
    ).toEqual({ kind: 'reset' });
  });

  it('probe -> RESET when the thread has no messages at all', () => {
    expect(resolveProbe(undefined, DELETED_AT)).toEqual({ kind: 'reset' });
  });

  it('probe -> RESET when created_at is missing (absent never counts as new)', () => {
    expect(resolveProbe({ direction: 'inbound' }, DELETED_AT)).toEqual({ kind: 'reset' });
  });

  it('an inbound EXACTLY at the delete instant does not resurface (strict >)', () => {
    expect(resolveProbe({ direction: 'inbound', created_at: DELETED_AT }, DELETED_AT)).toEqual({
      kind: 'reset',
    });
  });
});
