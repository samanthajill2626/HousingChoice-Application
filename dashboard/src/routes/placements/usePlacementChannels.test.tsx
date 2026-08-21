// usePlacementChannels tests - resolves the GROUP channel to a conversationId +
// unread, each PERSON channel (keyed by contactId) to a SUMMED unread over that
// contact's non-relay threads, the two mark-read paths (group = single
// conversation, person = inbox fan-out), group id injection, and a live
// conversation.updated refetch. Structural mirror of
// tours/useTourChannels.test.tsx (the group source is placement.group_thread and
// the people are placement.tenantId + the unit's landlordId).
import { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary, EventStreamHandlers, PlacementItem } from '../../api/index.js';

const getUnreadCounts = vi.fn();
const markConversationRead = vi.fn();
const markInboxRead = vi.fn();
const noteRowsCleared = vi.fn();
const rollbackRowsCleared = vi.fn();
let streamHandlers: EventStreamHandlers | null = null;

// Stub the nav badge context rather than mounting a real UnreadProvider: a real
// one would fire its own count + unmatched-email fetches and would fight for the
// shared `streamHandlers` capture below. The functions are do-nothing spies,
// which is also exactly what the provider-less no-op defaults are - so every
// assertion here holds for a bare render too (the REAL defaults are pinned in
// app/UnreadContext.test.tsx and by PlacementDetail/PlacementConversation, which
// mount this hook with no provider at all).
vi.mock('../../app/UnreadContext.js', () => ({
  useUnread: () => ({ unread: null, unmatchedUnread: null, noteRowsCleared, rollbackRowsCleared }),
}));

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getUnreadCounts: (...a: unknown[]) => getUnreadCounts(...a),
    markConversationRead: (...a: unknown[]) => markConversationRead(...a),
    markInboxRead: (...a: unknown[]) => markInboxRead(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers = h;
    },
  };
});

import {
  usePlacementChannels,
  type PersonChannelInput,
  type PlacementChannelsState,
} from './usePlacementChannels.js';

function makePlacement(over: Partial<PlacementItem> = {}): PlacementItem {
  return { placementId: 'p1', tenantId: 'ten-1', unitId: 'u1', stage: 'send_application', ...over };
}

function conv(conversationId: string, contactId: string, unread: number, type: string): ConversationSummary {
  return {
    conversationId,
    type,
    participant_phone: '+14045550111',
    participants: [{ contactId, phone: '+14045550111' }],
    preview: null,
    last_activity_at: '2026-07-05T00:00:00Z',
    unread_count: unread,
    sms_opt_out: false,
    participant_display_name: null,
  } as ConversationSummary;
}

/** An EMAIL-keyed 1:1 row: no participant_phone on the wire (email-channel v1),
 *  so the participants ROSTER is the only handle the dashboard has on it
 *  (`participant_email` is not a dashboard type). It must count toward the tab. */
function emailConv(conversationId: string, contactId: string, unread: number): ConversationSummary {
  return {
    conversationId,
    type: 'tenant_1to1',
    participants: [{ contactId, phone: '' }],
    preview: null,
    last_activity_at: '2026-07-04T00:00:00Z',
    unread_count: unread,
    sms_opt_out: false,
    participant_display_name: null,
  } as ConversationSummary;
}

/** WHAT THE PAGE PASSES: the tenant + the unit's landlord when there is one,
 *  keyed by contactId and labelled with the display name. */
function peopleFor(placement: PlacementItem, landlordId?: string): PersonChannelInput[] {
  return [
    { contactId: placement.tenantId, label: 'Ann Tenant' },
    ...(landlordId !== undefined ? [{ contactId: landlordId, label: 'Lon Landlord' }] : []),
  ];
}

/** The channel's unread for a person, 0 when they are not on the channels. */
function unreadOf(s: PlacementChannelsState, contactId: string): number {
  return s.people.find((p) => p.contactId === contactId)?.unread ?? 0;
}

function Probe({
  placement,
  landlordId,
}: {
  placement: PlacementItem;
  landlordId?: string;
}): React.JSX.Element {
  const s = usePlacementChannels(placement, peopleFor(placement, landlordId));
  const tenantUnread = unreadOf(s, placement.tenantId);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="group">{`${s.group.conversationId ?? '-'}/${s.group.unread}`}</span>
      <span data-testid="tenant">{`unread:${tenantUnread}`}</span>
      <span data-testid="landlord">{`unread:${unreadOf(s, landlordId ?? '')}`}</span>
      <button type="button" onClick={() => s.markPersonRead(placement.tenantId, tenantUnread)}>
        markTenant
      </button>
      <button type="button" onClick={() => s.markPersonRead(undefined, tenantUnread)}>
        markTenantUnresolved
      </button>
      <button type="button" onClick={() => s.markPersonRead('', tenantUnread)}>
        markTenantEmptyId
      </button>
      <button type="button" onClick={() => s.markGroupRead(s.group.conversationId, s.group.unread)}>
        markGroup
      </button>
      <button type="button" onClick={() => s.setGroupConversationId('c-injected')}>inject</button>
    </div>
  );
}

// Mirrors PlacementDetail's PARENT (hosts usePlacementChannels) / CHILD
// (PlacementConversation fires the on-view mark-read effect) split, so the
// mark-read effect runs as a CHILD effect - the exact ordering that made a
// ref-based markRead read a stale value and skip the initial active tab. The
// child passes the active channel's fresh values as arguments.
function MarkReadHarness({
  placement,
  landlordId,
  activeKey,
}: {
  placement: PlacementItem;
  landlordId?: string;
  activeKey: string;
}): React.JSX.Element {
  const channels = usePlacementChannels(placement, peopleFor(placement, landlordId));
  return (
    <div>
      <span data-testid="status">{channels.status}</span>
      <span data-testid="group">{`${channels.group.conversationId ?? '-'}/${channels.group.unread}`}</span>
      <span data-testid="tenant">{`unread:${unreadOf(channels, placement.tenantId)}`}</span>
      <span data-testid="landlord">{`unread:${unreadOf(channels, landlordId ?? '')}`}</span>
      <MarkReadChild channels={channels} activeKey={activeKey} />
    </div>
  );
}
function MarkReadChild({
  channels,
  activeKey,
}: {
  channels: PlacementChannelsState;
  activeKey: string;
}): React.JSX.Element {
  const active = channels.people.find((p) => p.contactId === activeKey);
  const contactId = active?.contactId;
  const unread = active === undefined ? channels.group.unread : active.unread;
  useEffect(() => {
    if (activeKey === 'group') {
      channels.markGroupRead(channels.group.conversationId, channels.group.unread);
      return;
    }
    channels.markPersonRead(contactId, unread);
  }, [activeKey, contactId, unread, channels]);
  return <span />;
}


/** FIXTURE PLUMBING ONLY. These tests already describe the world as inbox
 *  summaries; this projects them into the shape GET /api/unread-counts returns,
 *  so the cases below can keep asserting what they were written to assert
 *  (mark-read fan-out, badge clears, SSE refresh).
 *
 *  It deliberately does NOT re-test the 1:1 rules - relay_group / group_text
 *  exclusion and multi-key thread resolution now live SERVER-side and are
 *  covered in app/test/unreadCountsApi.test.ts. Asserting them against this
 *  local reimplementation would only prove the test agrees with itself. */
function countsFrom(
  summaries: ConversationSummary[],
): { byContact: Record<string, number>; byConversation: Record<string, number> } {
  const byContact: Record<string, number> = {};
  const byConversation: Record<string, number> = {};
  for (const s of summaries) {
    byConversation[s.conversationId] = s.unread_count;
    if (s.type === 'relay_group' || s.type === 'group_text') continue;
    for (const p of s.participants ?? []) {
      if (p.contactId) byContact[p.contactId] = (byContact[p.contactId] ?? 0) + s.unread_count;
    }
  }
  return { byContact, byConversation };
}

beforeEach(() => {
  getUnreadCounts.mockReset();
  markConversationRead.mockReset();
  markInboxRead.mockReset();
  noteRowsCleared.mockReset();
  rollbackRowsCleared.mockReset();
  streamHandlers = null;
  markConversationRead.mockResolvedValue(undefined);
  markInboxRead.mockResolvedValue(undefined);
  getUnreadCounts.mockResolvedValue(countsFrom([]));
});
afterEach(() => vi.restoreAllMocks());

describe('usePlacementChannels', () => {
  // The 1:1 RULES that used to be asserted here - a relay_group never counts
  // toward a 1:1 tab, a native group_text never does either (one roster matches
  // every member, so counting it would multiply the same unread across all of
  // them), and a contact's threads resolve across every phone AND email they own
  // - now live SERVER-side behind GET /api/unread-counts, and are covered in
  // app/test/unreadCountsApi.test.ts. They are deliberately NOT re-asserted here:
  // this file can only reach them through `countsFrom`, its own local stand-in,
  // so such a test would prove the fixture agrees with itself and nothing more.

  it('asks ONLY about this roster - the people and the group thread, never the inbox', async () => {
    // The point of the endpoint: an O(people) question costs an O(people) read.
    getUnreadCounts.mockResolvedValue(countsFrom([]));
    render(<Probe placement={makePlacement({ group_thread: 'g1' })} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    const arg = getUnreadCounts.mock.calls[0]?.[0] as {
      contactIds?: string[];
      conversationIds?: string[];
    };
    expect(arg.contactIds).toContain('lord-1');
    expect(arg.conversationIds).toEqual(['g1']);
  });

  it('maps the group thread and each roster member unread from the counts read', async () => {
    getUnreadCounts.mockResolvedValue(countsFrom([
        conv('g1', 'ten-1', 1, 'relay_group'),
        conv('c-ten', 'ten-1', 3, 'tenant_1to1'),
        conv('c-lord', 'lord-1', 0, 'landlord_1to1'),
      ]));
    render(<Probe placement={makePlacement({ group_thread: 'g1' })} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('group')).toHaveTextContent('g1/1');
    // The relay_group involving ten-1 is EXCLUDED from the 1:1 unread.
    expect(screen.getByTestId('tenant')).toHaveTextContent('unread:3');
    expect(screen.getByTestId('landlord')).toHaveTextContent('unread:0');
  });




  it('a channel with no thread resolves to null / zero unread', async () => {
    getUnreadCounts.mockResolvedValue(countsFrom([]));
    render(<Probe placement={makePlacement()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('tenant')).toHaveTextContent('unread:0');
    expect(screen.getByTestId('group')).toHaveTextContent('-/0');
  });

  it('markPersonRead fans the read out to the CONTACT + zeroes unread; never the single-conversation read', async () => {
    getUnreadCounts.mockResolvedValue(countsFrom([
        conv('c-ten-sms', 'ten-1', 2, 'tenant_1to1'),
        emailConv('c-ten-email', 'ten-1', 3),
      ]));
    render(<Probe placement={makePlacement()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('unread:5'));
    await userEvent.click(screen.getByRole('button', { name: 'markTenant' }));
    // Contact-page parity: ONE fan-out clears every thread the person owns.
    expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'ten-1' });
    expect(markConversationRead).not.toHaveBeenCalled();
    expect(screen.getByTestId('tenant')).toHaveTextContent('unread:0');
  });

  it('markPersonRead no-ops at unread 0 (the effect re-runs on every render)', async () => {
    getUnreadCounts.mockResolvedValue(countsFrom([conv('c-ten', 'ten-1', 0, 'tenant_1to1')]));
    render(<Probe placement={makePlacement()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    await userEvent.click(screen.getByRole('button', { name: 'markTenant' }));
    expect(markInboxRead).not.toHaveBeenCalled();
  });

  it('markPersonRead no-ops when the contact is unresolved (undefined id)', async () => {
    getUnreadCounts.mockResolvedValue(countsFrom([conv('c-ten', 'ten-1', 3, 'tenant_1to1')]));
    render(<Probe placement={makePlacement()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('unread:3'));
    await userEvent.click(screen.getByRole('button', { name: 'markTenantUnresolved' }));
    expect(markInboxRead).not.toHaveBeenCalled();
    // ...and the unread stays put (nothing was read).
    expect(screen.getByTestId('tenant')).toHaveTextContent('unread:3');
  });

  it('markPersonRead no-ops on an EMPTY contactId (never POST /api/inbox//read)', async () => {
    // The guard is falsy, not `=== undefined`: PlacementDetail really does build
    // a loading placeholder with tenantId: '' for this hook, so '' has to be
    // rejected too.
    getUnreadCounts.mockResolvedValue(countsFrom([conv('c-ten', 'ten-1', 3, 'tenant_1to1')]));
    render(<Probe placement={makePlacement()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('unread:3'));
    await userEvent.click(screen.getByRole('button', { name: 'markTenantEmptyId' }));
    expect(markInboxRead).not.toHaveBeenCalled();
    expect(screen.getByTestId('tenant')).toHaveTextContent('unread:3');
  });

  it('markGroupRead still marks the SINGLE group conversation read', async () => {
    getUnreadCounts.mockResolvedValue(countsFrom([conv('g1', 'ten-1', 4, 'relay_group')]));
    render(<Probe placement={makePlacement({ group_thread: 'g1' })} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('group')).toHaveTextContent('g1/4'));
    await userEvent.click(screen.getByRole('button', { name: 'markGroup' }));
    expect(markConversationRead).toHaveBeenCalledWith('g1');
    // The group read must NEVER fan out (it would clear the 1:1 tabs).
    expect(markInboxRead).not.toHaveBeenCalled();
    expect(screen.getByTestId('group')).toHaveTextContent('g1/0');
  });

  it('an INJECTED group thread gets its unread refreshed - it is asked about, not assumed 0', async () => {
    // REGRESSION (adversarial review, 2026-08-20). The rail reads
    // `byConversation[resolved]` where `resolved` can come from the injected id,
    // but the request only named `groupThreadId`. On the placement side the
    // record is never refetched after an open, so `group_thread` stays undefined
    // forever: the injected id was READ but never ASKED about, `?? 0` applied,
    // and the group dot was pinned at zero for the life of the page.
    //
    // The all-zeros fixture in the sibling test cannot see this - every
    // observable is 0 on both sides of the refetch. This one gives the injected
    // thread real unread, so it fails if that id drops out of the request.
    getUnreadCounts.mockResolvedValue(countsFrom([]));
    render(<Probe placement={makePlacement()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    await userEvent.click(screen.getByRole('button', { name: 'inject' }));
    expect(screen.getByTestId('group')).toHaveTextContent('c-injected/0');

    // The thread now has unread. A refetch must SEE it.
    getUnreadCounts.mockResolvedValue({ byContact: {}, byConversation: { 'c-injected': 4 } });
    act(() =>
      streamHandlers?.onConversationUpdated?.({
        conversationId: 'c-injected',
        last_activity_at: '2026-07-06T00:00:00Z',
        unread_count: 4,
        type: 'relay_group',
        participant_display_name: null,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('group')).toHaveTextContent('c-injected/4'));

    // ...and it must have been ASKED about, not merely echoed back.
    const lastArg = getUnreadCounts.mock.calls.at(-1)?.[0] as { conversationIds?: string[] };
    expect(lastArg.conversationIds).toContain('c-injected');
  });

  it('setGroupConversationId injects a just-provisioned group thread id (survives a refetch)', async () => {
    // Empty inbox: the group has no thread yet, so a refetch cannot re-resolve one.
    getUnreadCounts.mockResolvedValue(countsFrom([]));
    render(<Probe placement={makePlacement()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('group')).toHaveTextContent('-/0');
    await userEvent.click(screen.getByRole('button', { name: 'inject' }));
    expect(screen.getByTestId('group')).toHaveTextContent('c-injected/0');

    // A conversation.updated fires a refetch; the injected id (not on the inbox
    // page) must survive so the freshly-opened thread never unmounts.
    getUnreadCounts.mockResolvedValue(countsFrom([]));
    act(() =>
      streamHandlers?.onConversationUpdated?.({
        conversationId: 'c-injected',
        last_activity_at: '2026-07-06T00:00:00Z',
        unread_count: 0,
        type: 'relay_group',
        participant_display_name: null,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('group')).toHaveTextContent('c-injected/0'));
  });

  it('a conversation.updated refetches and refreshes unread', async () => {
    getUnreadCounts.mockResolvedValueOnce(countsFrom([conv('c-ten', 'ten-1', 1, 'tenant_1to1')]));
    render(<Probe placement={makePlacement()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('unread:1'));

    getUnreadCounts.mockResolvedValueOnce(countsFrom([conv('c-ten', 'ten-1', 5, 'tenant_1to1')]));
    act(() =>
      streamHandlers?.onConversationUpdated?.({
        conversationId: 'c-ten',
        last_activity_at: '2026-07-06T00:00:00Z',
        unread_count: 5,
        type: 'tenant_1to1',
        participant_display_name: null,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('unread:5'));
  });
});

// mark-read must fire for the INITIAL active tab (no click) and on a later inbound
// to the ACTIVE tab, but never for a tab that is not active.
describe('usePlacementChannels - initial active tab auto-mark-read', () => {
  it('marks the initial ACTIVE tab read on the loading->ready commit (unread>0), exactly once', async () => {
    getUnreadCounts.mockResolvedValue(countsFrom([conv('c-ten', 'ten-1', 3, 'tenant_1to1')]));
    render(<MarkReadHarness placement={makePlacement()} landlordId="lord-1" activeKey="ten-1" />);
    // Fires WITHOUT any interaction - the regression the ref-based version missed.
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'ten-1' }));
    expect(markInboxRead).toHaveBeenCalledTimes(1);
    // The 1:1 tabs read the PERSON, never a single conversation.
    expect(markConversationRead).not.toHaveBeenCalled();
  });

  it('marks read AGAIN when an inbound raises unread on the ACTIVE tab', async () => {
    getUnreadCounts.mockResolvedValue(countsFrom([conv('c-ten', 'ten-1', 1, 'tenant_1to1')]));
    render(<MarkReadHarness placement={makePlacement()} landlordId="lord-1" activeKey="ten-1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(1));

    getUnreadCounts.mockResolvedValue(countsFrom([conv('c-ten', 'ten-1', 4, 'tenant_1to1')]));
    act(() =>
      streamHandlers?.onConversationUpdated?.({
        conversationId: 'c-ten',
        last_activity_at: '2026-07-06T00:00:00Z',
        unread_count: 4,
        type: 'tenant_1to1',
        participant_display_name: null,
      }),
    );
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(2));
    expect(markInboxRead).toHaveBeenLastCalledWith({ contactId: 'ten-1' });
  });

  it('does NOT mark read a tab that is not active when its unread rises', async () => {
    getUnreadCounts.mockResolvedValue(countsFrom([
        conv('c-ten', 'ten-1', 0, 'tenant_1to1'),
        conv('c-lord', 'lord-1', 0, 'landlord_1to1'),
      ]));
    render(<MarkReadHarness placement={makePlacement()} landlordId="lord-1" activeKey="ten-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    // Active (tenant) tab loaded at unread 0 -> no mark-read.
    expect(markInboxRead).not.toHaveBeenCalled();

    getUnreadCounts.mockResolvedValue(countsFrom([
        conv('c-ten', 'ten-1', 0, 'tenant_1to1'),
        conv('c-lord', 'lord-1', 5, 'landlord_1to1'),
      ]));
    act(() =>
      streamHandlers?.onConversationUpdated?.({
        conversationId: 'c-lord',
        last_activity_at: '2026-07-06T00:00:00Z',
        unread_count: 5,
        type: 'landlord_1to1',
        participant_display_name: null,
      }),
    );
    // The inactive landlord tab's unread rises...
    await waitFor(() => expect(screen.getByTestId('landlord')).toHaveTextContent('unread:5'));
    // ...but only the ACTIVE (tenant) tab is ever auto-marked.
    expect(markInboxRead).not.toHaveBeenCalled();
    expect(markConversationRead).not.toHaveBeenCalled();
  });
});

// The nav badge's optimistic layer. These calls are SOUND ONLY BECAUSE of the
// close-reset ruling: closing a relay group zeroes its unread, so any group that
// gets past the `unread <= 0` guard is open/connecting - a row the badge counts.
// The keys are KIND-FREE and match what useInbox mints for the same thread
// (`cv:` for either group kind, `c:` for a contact), so a duplicate clear from
// two surfaces dedupes instead of double-decrementing.
describe('usePlacementChannels - nav badge clears', () => {
  it('markGroupRead clears the group by its cv: key', async () => {
    getUnreadCounts.mockResolvedValue(countsFrom([conv('g1', 'ten-1', 4, 'relay_group')]));
    render(<Probe placement={makePlacement({ group_thread: 'g1' })} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('group')).toHaveTextContent('g1/4'));
    await userEvent.click(screen.getByRole('button', { name: 'markGroup' }));
    expect(noteRowsCleared).toHaveBeenCalledTimes(1);
    expect(noteRowsCleared).toHaveBeenCalledWith(['cv:g1']);
    expect(rollbackRowsCleared).not.toHaveBeenCalled();
  });

  it('markPersonRead clears the contact by its c: key', async () => {
    getUnreadCounts.mockResolvedValue(countsFrom([conv('c-ten-sms', 'ten-1', 2, 'tenant_1to1')]));
    render(<Probe placement={makePlacement()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('unread:2'));
    await userEvent.click(screen.getByRole('button', { name: 'markTenant' }));
    expect(noteRowsCleared).toHaveBeenCalledTimes(1);
    expect(noteRowsCleared).toHaveBeenCalledWith(['c:ten-1']);
    expect(rollbackRowsCleared).not.toHaveBeenCalled();
  });

  it('NEVER touches the badge at or below the guards', async () => {
    getUnreadCounts.mockResolvedValue(countsFrom([conv('c-ten', 'ten-1', 0, 'tenant_1to1')]));
    render(<Probe placement={makePlacement()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    // unread 0, an unresolved contact, an empty id, and a group with no thread.
    await userEvent.click(screen.getByRole('button', { name: 'markTenant' }));
    await userEvent.click(screen.getByRole('button', { name: 'markTenantUnresolved' }));
    await userEvent.click(screen.getByRole('button', { name: 'markTenantEmptyId' }));
    await userEvent.click(screen.getByRole('button', { name: 'markGroup' }));
    expect(noteRowsCleared).not.toHaveBeenCalled();
    expect(rollbackRowsCleared).not.toHaveBeenCalled();
  });

  it('rolls the badge clear back when the group mark-read fails', async () => {
    getUnreadCounts.mockResolvedValue(countsFrom([conv('g1', 'ten-1', 4, 'relay_group')]));
    markConversationRead.mockRejectedValue(new Error('nope'));
    render(<Probe placement={makePlacement({ group_thread: 'g1' })} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('group')).toHaveTextContent('g1/4'));
    await userEvent.click(screen.getByRole('button', { name: 'markGroup' }));
    await waitFor(() => expect(rollbackRowsCleared).toHaveBeenCalledWith(['cv:g1']));
  });

  it('rolls the badge clear back when the person fan-out fails', async () => {
    getUnreadCounts.mockResolvedValue(countsFrom([conv('c-ten-sms', 'ten-1', 2, 'tenant_1to1')]));
    markInboxRead.mockRejectedValue(new Error('nope'));
    render(<Probe placement={makePlacement()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('unread:2'));
    await userEvent.click(screen.getByRole('button', { name: 'markTenant' }));
    await waitFor(() => expect(rollbackRowsCleared).toHaveBeenCalledWith(['c:ten-1']));
  });

  it('does not fire the mark-read effect in a loop once the badge functions are wired', async () => {
    // A11 in its concrete form: the badge functions flow into markGroupRead /
    // markPersonRead deps, which flow into this hook's returned object, which is
    // MarkReadChild's effect dependency. A churning identity POSTs forever.
    getUnreadCounts.mockResolvedValue(countsFrom([conv('c-ten', 'ten-1', 3, 'tenant_1to1')]));
    render(<MarkReadHarness placement={makePlacement()} landlordId="lord-1" activeKey="ten-1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(markInboxRead).toHaveBeenCalledTimes(1);
    expect(noteRowsCleared).toHaveBeenCalledTimes(1);
  });
});
