import { describe, expect, it } from 'vitest';
import { collectGroupRosters, tallyRosterDrift } from '../src/lib/rosterDriftTally.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';

describe('tallyRosterDrift', () => {
  it('classifies every member exactly once', () => {
    const tally = tallyRosterDrift(
      [
        [
          { contactId: 'c-ok', phone: '+1', name: 'Ada Ok' },
          { contactId: 'c-missing', phone: '+2' },
          { contactId: 'c-drift', phone: '+3', name: 'Old Name' },
          { contactId: 'c-dangling', phone: '+4', name: 'Ghost' },
          { contactId: 'c-deleted', phone: '+6', name: 'Was Here' },
          // R2-4: the inverse of nameMissingButKnown. The contact is readable
          // and NOT deleted but carries no display name, while the roster still
          // stores one - the population T5 made permanent by no longer deleting
          // the stored name. It used to fall through every branch and be
          // counted nowhere past withContactId.
          { contactId: 'c-nameless', phone: '+7', name: 'Kept Name' },
          { contactId: '', phone: '+5', name: 'Bare' },
        ],
        [{ contactId: 'c-ok', phone: '+1', name: 'Ada Ok' }],
      ],
      new Map([
        ['c-ok', { contactId: 'c-ok', firstName: 'Ada', lastName: 'Ok' }],
        ['c-missing', { contactId: 'c-missing', firstName: 'Has', lastName: 'Name' }],
        ['c-drift', { contactId: 'c-drift', firstName: 'New', lastName: 'Name' }],
        ['c-deleted', { contactId: 'c-deleted', firstName: 'Re', lastName: 'Named', deleted_at: '2026-01-01T00:00:00.000Z' }],
        ['c-nameless', { contactId: 'c-nameless', phone: '+7' }],
      ]),
    );
    expect(tally).toEqual({
      rosters: 2, members: 8, withContactId: 7,
      nameMissingButKnown: 1, nameDrift: 1, nameOnlyStored: 1,
      danglingContactId: 1, deletedContact: 1, noContactId: 1,
    });
  });
});

describe('collectGroupRosters', () => {
  it('sources group_text pages AND every relay partition - the walk the old audit never did', async () => {
    const conv = (id: string, participants: { contactId: string; phone: string }[]): ConversationItem =>
      ({ conversationId: id, participants, type: 'group_text', status: 'group_open', last_activity_at: 'x', created_at: 'x', ai_mode: 'manual' }) as ConversationItem;
    const relayCalls: string[] = [];
    const out = await collectGroupRosters({
      async listGroupTexts(opts) {
        return opts?.cursor === undefined
          ? { items: [conv('gt-1', [{ contactId: 'a', phone: '+1' }])], nextCursor: 'page2', truncated: false }
          : { items: [conv('gt-2', [{ contactId: 'b', phone: '+2' }])], truncated: false };
      },
      async listRelayGroups(status) {
        relayCalls.push(status);
        return { items: [conv(`rg-${status}`, [{ contactId: status, phone: '+9' }])], truncated: status === 'closed' };
      },
    });
    expect(out.rosters).toHaveLength(5);
    expect(relayCalls).toEqual(['open', 'connecting', 'closed']);
    expect(out.relayTruncated).toEqual(['closed']);
    expect(out.groupTextTruncated).toBe(false);
  });
});
