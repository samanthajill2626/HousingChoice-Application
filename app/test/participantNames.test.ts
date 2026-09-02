import { describe, expect, it, vi } from 'vitest';
import {
  collectRosterContactIds,
  hydrateConversationRosters,
  resolveRosterNames,
  withLiveNames,
} from '../src/lib/participantNames.js';
import type { ContactDisplayItem } from '../src/repos/contactsRepo.js';
import type { ConversationItem, ConversationParticipant } from '../src/repos/conversationsRepo.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

const log = createLogger({ destination: createLogCapture().stream });

const display = (contactId: string, firstName?: string, lastName?: string, deleted_at?: string): ContactDisplayItem => ({
  contactId,
  ...(firstName !== undefined && { firstName }),
  ...(lastName !== undefined && { lastName }),
  ...(deleted_at !== undefined && { deleted_at }),
});

const roster: ConversationParticipant[] = [
  { contactId: 'c-1', phone: '+15550100001', name: 'Old One' },
  { contactId: 'c-2', phone: '+15550100002' },
  { contactId: '', phone: '+15550100003', name: 'Bare Phone' },
  { contactId: 'c-4', phone: '+15550100004', name: 'Stays Stored' },
];

describe('collectRosterContactIds', () => {
  it('collects unique non-empty contactIds across conversations', () => {
    const convs = [
      { participants: roster },
      { participants: [{ contactId: 'c-1', phone: '+1' }, { contactId: 'c-9', phone: '+2' }] },
      { participants: undefined },
    ];
    expect(collectRosterContactIds(convs).sort()).toEqual(['c-1', 'c-2', 'c-4', 'c-9']);
  });
});

describe('withLiveNames', () => {
  const names = new Map<string, ContactDisplayItem>([
    ['c-1', display('c-1', 'New', 'One')],
    ['c-2', display('c-2', ' Two ', '')],
    ['c-4', display('c-4', undefined, undefined)],
  ]);

  it('live name wins; stored name on map miss or empty live name; bare-phone untouched', () => {
    const out = withLiveNames(roster, names);
    expect(out.map((p) => p.name)).toEqual(['New One', 'Two', 'Bare Phone', 'Stays Stored']);
  });

  it('never touches phone and never mutates its input', () => {
    const before = JSON.stringify(roster);
    const out = withLiveNames(roster, names);
    expect(out.map((p) => p.phone)).toEqual(roster.map((p) => p.phone));
    expect(JSON.stringify(roster)).toBe(before);
    expect(out[0]).not.toBe(roster[0]);
  });

  it('a soft-deleted contact supplies no name', () => {
    const deleted = new Map([['c-1', display('c-1', 'Gone', 'Person', '2026-01-01T00:00:00.000Z')]]);
    expect(withLiveNames(roster, deleted)[0]?.name).toBe('Old One');
  });

  it('undefined participants -> empty array', () => {
    expect(withLiveNames(undefined, names)).toEqual([]);
  });
});

describe('resolveRosterNames / hydrateConversationRosters', () => {
  const conv = (conversationId: string, participants: ConversationParticipant[]): ConversationItem =>
    ({ conversationId, type: 'relay_group', status: 'open', participants, last_activity_at: 'x', created_at: 'x', ai_mode: 'manual' }) as ConversationItem;

  it('issues ONE batch with the unique ids and hydrates every row', async () => {
    const getDisplaysByIds = vi.fn(async (ids: string[]) =>
      new Map(ids.map((id) => [id, display(id, 'Live', id)] as const)),
    );
    const convs = [conv('a', roster), conv('b', [{ contactId: 'c-1', phone: '+1' }])];
    const out = await hydrateConversationRosters(convs, { getDisplaysByIds }, log);
    expect(getDisplaysByIds).toHaveBeenCalledTimes(1);
    expect(new Set(getDisplaysByIds.mock.calls[0]![0])).toEqual(new Set(['c-1', 'c-2', 'c-4']));
    expect(out[0]!.participants!.map((p) => p.name)).toEqual(['Live c-1', 'Live c-2', 'Bare Phone', 'Live c-4']);
    expect(out[1]!.participants![0]!.name).toBe('Live c-1');
    expect(out[0]).not.toBe(convs[0]);
  });

  it('a partial map leaves unresolved members on their stored names', async () => {
    const getDisplaysByIds = vi.fn(async () => new Map([['c-1', display('c-1', 'Live', 'One')]]));
    const out = await hydrateConversationRosters([conv('a', roster)], { getDisplaysByIds }, log);
    expect(out[0]!.participants!.map((p) => p.name)).toEqual(['Live One', undefined, 'Bare Phone', 'Stays Stored']);
  });

  // The REAL getDisplaysByIds never rejects - it swallows a failed chunk and returns a SHORT map
  // (contactsRepo.ts:824-852) - so this guards the module's never-reject contract against a fake
  // or a future repo that DOES throw, not against today's implementation.
  it('a throwing batch yields an empty map and the input names, never a rejection', async () => {
    const getDisplaysByIds = vi.fn(async () => { throw new Error('ProvisionedThroughputExceededException'); });
    const names = await resolveRosterNames([conv('a', roster)], { getDisplaysByIds }, log);
    expect(names.size).toBe(0);
    const out = await hydrateConversationRosters([conv('a', roster)], { getDisplaysByIds }, log);
    expect(out[0]!.participants!.map((p) => p.name)).toEqual(roster.map((p) => p.name));
  });

  it('no ids -> no batch call', async () => {
    const getDisplaysByIds = vi.fn(async () => new Map());
    await resolveRosterNames([conv('a', [{ contactId: '', phone: '+1' }])], { getDisplaysByIds }, log);
    expect(getDisplaysByIds).not.toHaveBeenCalled();
  });
});
