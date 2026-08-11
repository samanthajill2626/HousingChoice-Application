// The ONE `conversation.updated` SSE payload builder (group-texting T3.8).
//
// Every emit site goes through toConversationUpdatedEvent, so a change here
// changes the wire shape for the inbox, the relay thread view and the group
// thread view at once. The relay and 1:1 payloads are pinned by EXACT equality
// (not toMatchObject): a new key leaking onto them would be invisible to a
// subset assertion, and invariant 13.6 requires relay payloads byte-identical.
import { describe, expect, it } from 'vitest';

import { toConversationUpdatedEvent } from '../src/lib/events.js';
import { GROUP_TEXT_STATUS, type ConversationItem } from '../src/repos/conversationsRepo.js';

const BASE = {
  last_activity_at: '2026-08-10T12:00:00.000Z',
  created_at: '2026-08-01T00:00:00.000Z',
  ai_mode: 'manual' as const,
};

const MEMBERS = [
  { contactId: 'c-1', phone: '+15550100001', name: 'Ann' },
  { contactId: 'c-2', phone: '+15550100002' },
];

describe('toConversationUpdatedEvent', () => {
  it('RELAY payload is byte-identical (status, pool_number, members)', () => {
    const relay = {
      ...BASE,
      conversationId: 'conv-relay',
      type: 'relay_group',
      status: 'open',
      pool_number: '+15559990001',
      participants: MEMBERS,
      unread_count: 3,
      last_message_preview: 'hi',
      participant_display_name: 'Relay group',
    } as ConversationItem;

    expect(toConversationUpdatedEvent(relay)).toEqual({
      conversationId: 'conv-relay',
      last_activity_at: BASE.last_activity_at,
      unread_count: 3,
      preview: 'hi',
      type: 'relay_group',
      participant_display_name: 'Relay group',
      status: 'open',
      pool_number: '+15559990001',
      members: MEMBERS,
    });
  });

  it('1:1 payload is byte-identical (no status, no pool_number, no members)', () => {
    const oneToOne = {
      ...BASE,
      conversationId: 'conv-1',
      type: 'tenant_1to1',
      status: 'open',
      participant_phone: '+15550100001',
      unread_count: 1,
    } as ConversationItem;

    expect(toConversationUpdatedEvent(oneToOne)).toEqual({
      conversationId: 'conv-1',
      last_activity_at: BASE.last_activity_at,
      unread_count: 1,
      type: 'tenant_1to1',
      participant_display_name: null,
    });
  });

  it('GROUP payload carries status + roster', () => {
    const group = {
      ...BASE,
      conversationId: 'conv-group',
      type: 'group_text',
      status: GROUP_TEXT_STATUS,
      participants: MEMBERS,
      unread_count: 2,
      last_message_preview: 'see you at 3',
    } as ConversationItem;

    expect(toConversationUpdatedEvent(group)).toEqual({
      conversationId: 'conv-group',
      last_activity_at: BASE.last_activity_at,
      unread_count: 2,
      preview: 'see you at 3',
      type: 'group_text',
      participant_display_name: null,
      status: GROUP_TEXT_STATUS,
      members: MEMBERS,
    });
  });

  it('GROUP payload NEVER carries pool_number (spec 4.2 forbids the field)', () => {
    const group = {
      ...BASE,
      conversationId: 'conv-group',
      type: 'group_text',
      status: GROUP_TEXT_STATUS,
      participants: MEMBERS,
    } as ConversationItem;

    expect('pool_number' in toConversationUpdatedEvent(group)).toBe(false);
  });

  it('GROUP payload degrades to an EMPTY roster rather than omitting members', () => {
    const group = {
      ...BASE,
      conversationId: 'conv-group',
      type: 'group_text',
      status: GROUP_TEXT_STATUS,
    } as ConversationItem;

    expect(toConversationUpdatedEvent(group).members).toEqual([]);
  });
});
