// usePlacementChannels tests - resolves the three channels (group / tenant /
// landlord) to conversationIds + unread, the SINGLE-conversation mark-read, id
// injection, and a live conversation.updated refetch. Structural mirror of
// tours/useTourChannels.test.tsx (the group source is placement.group_thread and
// the 1:1 targets are placement.tenantId + the unit's landlordId).
import { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary, EventStreamHandlers, PlacementItem } from '../../api/index.js';

const getConversations = vi.fn();
const markConversationRead = vi.fn();
const markInboxRead = vi.fn();
let streamHandlers: EventStreamHandlers | null = null;

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getConversations: (...a: unknown[]) => getConversations(...a),
    markConversationRead: (...a: unknown[]) => markConversationRead(...a),
    markInboxRead: (...a: unknown[]) => markInboxRead(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers = h;
    },
  };
});

import {
  usePlacementChannels,
  type PlacementChannelKey,
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

function Probe({
  placement,
  landlordId,
}: {
  placement: PlacementItem;
  landlordId?: string;
}): React.JSX.Element {
  const s = usePlacementChannels(placement, landlordId);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="group">{`${s.group.conversationId ?? '-'}/${s.group.unread}`}</span>
      <span data-testid="tenant">{`${s.tenant.conversationId ?? '-'}/${s.tenant.unread}`}</span>
      <span data-testid="landlord">{`${s.landlord.conversationId ?? '-'}/${s.landlord.unread}`}</span>
      <button type="button" onClick={() => s.markRead('tenant', s.tenant.conversationId, s.tenant.unread)}>
        markTenant
      </button>
      <button type="button" onClick={() => s.setConversationId('group', 'c-injected')}>
        inject
      </button>
    </div>
  );
}

// Mirrors PlacementDetail's PARENT (hosts usePlacementChannels) / CHILD
// (PlacementConversation fires the on-view mark-read effect) split, so the
// mark-read effect runs as a CHILD effect - the exact ordering that made a
// ref-based markRead read a stale value and skip the initial active tab. The
// child passes the active channel's fresh conversationId + unread as arguments.
function MarkReadHarness({
  placement,
  landlordId,
  activeKey,
}: {
  placement: PlacementItem;
  landlordId?: string;
  activeKey: PlacementChannelKey;
}): React.JSX.Element {
  const channels = usePlacementChannels(placement, landlordId);
  return (
    <div>
      <span data-testid="status">{channels.status}</span>
      <span data-testid="tenant">{`${channels.tenant.conversationId ?? '-'}/${channels.tenant.unread}`}</span>
      <span data-testid="landlord">{`${channels.landlord.conversationId ?? '-'}/${channels.landlord.unread}`}</span>
      <MarkReadChild channels={channels} activeKey={activeKey} />
    </div>
  );
}
function MarkReadChild({
  channels,
  activeKey,
}: {
  channels: PlacementChannelsState;
  activeKey: PlacementChannelKey;
}): React.JSX.Element {
  const active = channels[activeKey];
  useEffect(() => {
    channels.markRead(activeKey, active.conversationId, active.unread);
  }, [activeKey, active.conversationId, active.unread, channels]);
  return <span />;
}

beforeEach(() => {
  getConversations.mockReset();
  markConversationRead.mockReset();
  markInboxRead.mockReset();
  streamHandlers = null;
  markConversationRead.mockResolvedValue(undefined);
  getConversations.mockResolvedValue({ conversations: [], nextCursor: null });
});
afterEach(() => vi.restoreAllMocks());

describe('usePlacementChannels', () => {
  it('resolves the group from group_thread and the 1:1s from the inbox, with unread', async () => {
    getConversations.mockResolvedValue({
      conversations: [
        conv('g1', 'ten-1', 1, 'relay_group'),
        conv('c-ten', 'ten-1', 3, 'tenant_1to1'),
        conv('c-lord', 'lord-1', 0, 'landlord_1to1'),
      ],
      nextCursor: null,
    });
    render(<Probe placement={makePlacement({ group_thread: 'g1' })} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('group')).toHaveTextContent('g1/1');
    // The relay_group involving ten-1 is EXCLUDED from the 1:1 resolution.
    expect(screen.getByTestId('tenant')).toHaveTextContent('c-ten/3');
    expect(screen.getByTestId('landlord')).toHaveTextContent('c-lord/0');
  });

  it('a channel with no thread resolves to null', async () => {
    getConversations.mockResolvedValue({ conversations: [], nextCursor: null });
    render(<Probe placement={makePlacement()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('tenant')).toHaveTextContent('-/0');
    expect(screen.getByTestId('group')).toHaveTextContent('-/0');
  });

  it('markRead marks the SINGLE conversation read + zeroes unread; never the inbox fan-out', async () => {
    getConversations.mockResolvedValue({
      conversations: [conv('c-ten', 'ten-1', 3, 'tenant_1to1')],
      nextCursor: null,
    });
    render(<Probe placement={makePlacement()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('c-ten/3'));
    await userEvent.click(screen.getByRole('button', { name: 'markTenant' }));
    expect(markConversationRead).toHaveBeenCalledWith('c-ten');
    expect(markInboxRead).not.toHaveBeenCalled();
    expect(screen.getByTestId('tenant')).toHaveTextContent('c-ten/0');
  });

  it('setConversationId injects a just-provisioned group thread id (survives a refetch)', async () => {
    // Empty inbox: the group has no thread yet, so a refetch cannot re-resolve one.
    getConversations.mockResolvedValue({ conversations: [], nextCursor: null });
    render(<Probe placement={makePlacement()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('group')).toHaveTextContent('-/0');
    await userEvent.click(screen.getByRole('button', { name: 'inject' }));
    expect(screen.getByTestId('group')).toHaveTextContent('c-injected/0');

    // A conversation.updated fires a refetch; the injected id (not on the inbox
    // page) must survive so the freshly-opened thread never unmounts.
    getConversations.mockResolvedValue({ conversations: [], nextCursor: null });
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
    getConversations.mockResolvedValueOnce({
      conversations: [conv('c-ten', 'ten-1', 1, 'tenant_1to1')],
      nextCursor: null,
    });
    render(<Probe placement={makePlacement()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('c-ten/1'));

    getConversations.mockResolvedValueOnce({
      conversations: [conv('c-ten', 'ten-1', 5, 'tenant_1to1')],
      nextCursor: null,
    });
    act(() =>
      streamHandlers?.onConversationUpdated?.({
        conversationId: 'c-ten',
        last_activity_at: '2026-07-06T00:00:00Z',
        unread_count: 5,
        type: 'tenant_1to1',
        participant_display_name: null,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('c-ten/5'));
  });
});

// mark-read must fire for the INITIAL active tab (no click) and on a later inbound
// to the ACTIVE tab, but never for a tab that is not active.
describe('usePlacementChannels - initial active tab auto-mark-read', () => {
  it('marks the initial ACTIVE tab read on the loading->ready commit (unread>0), exactly once', async () => {
    getConversations.mockResolvedValue({
      conversations: [conv('c-ten', 'ten-1', 3, 'tenant_1to1')],
      nextCursor: null,
    });
    render(<MarkReadHarness placement={makePlacement()} landlordId="lord-1" activeKey="tenant" />);
    // Fires WITHOUT any interaction - the regression the ref-based version missed.
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('c-ten'));
    expect(markConversationRead).toHaveBeenCalledTimes(1);
    // Single-conversation read only - never the contact-wide inbox fan-out.
    expect(markInboxRead).not.toHaveBeenCalled();
  });

  it('marks read AGAIN when an inbound raises unread on the ACTIVE tab', async () => {
    getConversations.mockResolvedValue({
      conversations: [conv('c-ten', 'ten-1', 1, 'tenant_1to1')],
      nextCursor: null,
    });
    render(<MarkReadHarness placement={makePlacement()} landlordId="lord-1" activeKey="tenant" />);
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledTimes(1));

    getConversations.mockResolvedValue({
      conversations: [conv('c-ten', 'ten-1', 4, 'tenant_1to1')],
      nextCursor: null,
    });
    act(() =>
      streamHandlers?.onConversationUpdated?.({
        conversationId: 'c-ten',
        last_activity_at: '2026-07-06T00:00:00Z',
        unread_count: 4,
        type: 'tenant_1to1',
        participant_display_name: null,
      }),
    );
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledTimes(2));
    expect(markConversationRead).toHaveBeenLastCalledWith('c-ten');
  });

  it('does NOT mark read a tab that is not active when its unread rises', async () => {
    getConversations.mockResolvedValue({
      conversations: [
        conv('c-ten', 'ten-1', 0, 'tenant_1to1'),
        conv('c-lord', 'lord-1', 0, 'landlord_1to1'),
      ],
      nextCursor: null,
    });
    render(<MarkReadHarness placement={makePlacement()} landlordId="lord-1" activeKey="tenant" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    // Active (tenant) tab loaded at unread 0 -> no mark-read.
    expect(markConversationRead).not.toHaveBeenCalled();

    getConversations.mockResolvedValue({
      conversations: [
        conv('c-ten', 'ten-1', 0, 'tenant_1to1'),
        conv('c-lord', 'lord-1', 5, 'landlord_1to1'),
      ],
      nextCursor: null,
    });
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
    await waitFor(() => expect(screen.getByTestId('landlord')).toHaveTextContent('c-lord/5'));
    // ...but only the ACTIVE (tenant) tab is ever auto-marked.
    expect(markConversationRead).not.toHaveBeenCalled();
  });
});
