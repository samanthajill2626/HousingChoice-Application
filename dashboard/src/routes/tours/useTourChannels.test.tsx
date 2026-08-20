// useTourChannels tests - resolves the GROUP channel to a conversationId + unread,
// each PERSON channel (keyed by contactId) to a SUMMED unread over that contact's
// non-relay threads, the two mark-read paths (group = single conversation,
// person = inbox fan-out), group id injection, and a live conversation.updated
// refetch.
import { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary, EventStreamHandlers, Tour } from '../../api/index.js';

const getAllConversations = vi.fn();
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
// app/UnreadContext.test.tsx and by TourDetail/TourConversation, which mount this
// hook with no provider at all).
vi.mock('../../app/UnreadContext.js', () => ({
  useUnread: () => ({ unread: null, unmatchedUnread: null, noteRowsCleared, rollbackRowsCleared }),
}));

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getAllConversations: (...a: unknown[]) => getAllConversations(...a),
    markConversationRead: (...a: unknown[]) => markConversationRead(...a),
    markInboxRead: (...a: unknown[]) => markInboxRead(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers = h;
    },
  };
});

import {
  useTourChannels,
  type PersonChannelInput,
  type TourChannelsState,
} from './useTourChannels.js';

function makeTour(over: Partial<Tour> = {}): Tour {
  return { tourId: 't1', tenantId: 'ten-1', unitId: 'u1', tourType: 'self_guided', status: 'scheduled', ...over };
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
function peopleFor(tour: Tour, landlordId?: string): PersonChannelInput[] {
  return [
    { contactId: tour.tenantId, label: 'Ann Tenant' },
    ...(landlordId !== undefined ? [{ contactId: landlordId, label: 'Lon Landlord' }] : []),
  ];
}

/** The channel's unread for a person, 0 when they are not on the channels. */
function unreadOf(s: TourChannelsState, contactId: string): number {
  return s.people.find((p) => p.contactId === contactId)?.unread ?? 0;
}

function Probe({ tour, landlordId }: { tour: Tour; landlordId?: string }): React.JSX.Element {
  const s = useTourChannels(tour, peopleFor(tour, landlordId));
  const tenantUnread = unreadOf(s, tour.tenantId);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="group">{`${s.group.conversationId ?? '-'}/${s.group.unread}`}</span>
      <span data-testid="tenant">{`unread:${tenantUnread}`}</span>
      <span data-testid="landlord">{`unread:${unreadOf(s, landlordId ?? '')}`}</span>
      <button type="button" onClick={() => s.markPersonRead(tour.tenantId, tenantUnread)}>
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

// Mirrors TourDetail's PARENT (TourDetailLoaded hosts useTourChannels) / CHILD
// (TourConversation fires the on-view mark-read effect) split, so the mark-read
// effect runs as a CHILD effect - the exact ordering that made a ref-based
// markRead read a stale value and skip the initial active tab (MAJOR 2). The
// child passes the active channel's fresh values as arguments.
function MarkReadHarness({
  tour,
  landlordId,
  activeKey,
}: {
  tour: Tour;
  landlordId?: string;
  activeKey: string;
}): React.JSX.Element {
  const channels = useTourChannels(tour, peopleFor(tour, landlordId));
  return (
    <div>
      <span data-testid="status">{channels.status}</span>
      <span data-testid="group">{`${channels.group.conversationId ?? '-'}/${channels.group.unread}`}</span>
      <span data-testid="tenant">{`unread:${unreadOf(channels, tour.tenantId)}`}</span>
      <span data-testid="landlord">{`unread:${unreadOf(channels, landlordId ?? '')}`}</span>
      <MarkReadChild channels={channels} activeKey={activeKey} />
    </div>
  );
}
function MarkReadChild({
  channels,
  activeKey,
}: {
  channels: TourChannelsState;
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

beforeEach(() => {
  getAllConversations.mockReset();
  markConversationRead.mockReset();
  markInboxRead.mockReset();
  noteRowsCleared.mockReset();
  rollbackRowsCleared.mockReset();
  streamHandlers = null;
  markConversationRead.mockResolvedValue(undefined);
  markInboxRead.mockResolvedValue(undefined);
  getAllConversations.mockResolvedValue({ items: [], truncated: false});
});
afterEach(() => vi.restoreAllMocks());

describe('useTourChannels', () => {
  it('resolves the group from groupThreadId and the 1:1 unread from the inbox', async () => {
    getAllConversations.mockResolvedValue({
      items: [
        conv('g1', 'ten-1', 1, 'relay_group'),
        conv('c-ten', 'ten-1', 3, 'tenant_1to1'),
        conv('c-lord', 'lord-1', 0, 'landlord_1to1'),
      ],
      truncated: false,
    });
    render(<Probe tour={makeTour({ groupThreadId: 'g1' })} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('group')).toHaveTextContent('g1/1');
    // The relay_group involving ten-1 is EXCLUDED from the 1:1 unread.
    expect(screen.getByTestId('tenant')).toHaveTextContent('unread:3');
    expect(screen.getByTestId('landlord')).toHaveTextContent('unread:0');
  });

  it('sums unread across ALL the contact non-relay threads (phone- AND email-keyed)', async () => {
    getAllConversations.mockResolvedValue({
      items: [
        conv('c-ten-sms', 'ten-1', 2, 'tenant_1to1'),
        emailConv('c-ten-email', 'ten-1', 3),
      ],
      truncated: false,
    });
    render(<Probe tour={makeTour()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    // The tab dot mirrors the contact's INBOX ROW (2 + 3), not one thread.
    expect(screen.getByTestId('tenant')).toHaveTextContent('unread:5');
  });

  it('never counts a relay_group toward a 1:1 tab, even at high unread', async () => {
    getAllConversations.mockResolvedValue({
      items: [
        conv('g1', 'ten-1', 7, 'relay_group'),
        conv('c-ten', 'ten-1', 2, 'tenant_1to1'),
      ],
      truncated: false,
    });
    render(<Probe tour={makeTour({ groupThreadId: 'g1' })} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    // The group's 7 belongs to the Group tab alone.
    expect(screen.getByTestId('group')).toHaveTextContent('g1/7');
    expect(screen.getByTestId('tenant')).toHaveTextContent('unread:2');
  });

  it('never counts a native group_text toward a 1:1 tab (one roster matches every member)', async () => {
    // Byte-identical hazard to the placement twin: a group roster names up to
    // nine contacts, so counting it would add the SAME unread to every member's
    // 1:1 dot, and no 1:1 mark-read could clear it.
    getAllConversations.mockResolvedValue({
      items: [
        {
          ...conv('gt-1', 'ten-1', 5, 'group_text'),
          participants: [
            { contactId: 'ten-1', phone: '+14045550111' },
            { contactId: 'lord-1', phone: '+14045550112' },
          ],
        },
        conv('c-ten', 'ten-1', 2, 'tenant_1to1'),
      ],
      truncated: false,
    });
    render(<Probe tour={makeTour()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('tenant')).toHaveTextContent('unread:2');
    expect(screen.getByTestId('landlord')).toHaveTextContent('unread:0');
  });

  it('a channel with no thread resolves to null / zero unread', async () => {
    getAllConversations.mockResolvedValue({ items: [], truncated: false});
    render(<Probe tour={makeTour()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('tenant')).toHaveTextContent('unread:0');
    expect(screen.getByTestId('group')).toHaveTextContent('-/0');
  });

  it('markPersonRead fans the read out to the CONTACT + zeroes unread; never the single-conversation read', async () => {
    getAllConversations.mockResolvedValue({
      items: [
        conv('c-ten-sms', 'ten-1', 2, 'tenant_1to1'),
        emailConv('c-ten-email', 'ten-1', 3),
      ],
      truncated: false,
    });
    render(<Probe tour={makeTour()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('unread:5'));
    await userEvent.click(screen.getByRole('button', { name: 'markTenant' }));
    // Contact-page parity: ONE fan-out clears every thread the person owns.
    expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'ten-1' });
    expect(markConversationRead).not.toHaveBeenCalled();
    expect(screen.getByTestId('tenant')).toHaveTextContent('unread:0');
  });

  it('markPersonRead no-ops at unread 0 (the effect re-runs on every render)', async () => {
    getAllConversations.mockResolvedValue({
      items: [conv('c-ten', 'ten-1', 0, 'tenant_1to1')],
      truncated: false,
    });
    render(<Probe tour={makeTour()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    await userEvent.click(screen.getByRole('button', { name: 'markTenant' }));
    expect(markInboxRead).not.toHaveBeenCalled();
  });

  it('markPersonRead no-ops when the contact is unresolved (undefined id)', async () => {
    getAllConversations.mockResolvedValue({
      items: [conv('c-ten', 'ten-1', 3, 'tenant_1to1')],
      truncated: false,
    });
    render(<Probe tour={makeTour()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('unread:3'));
    await userEvent.click(screen.getByRole('button', { name: 'markTenantUnresolved' }));
    expect(markInboxRead).not.toHaveBeenCalled();
    // ...and the unread stays put (nothing was read).
    expect(screen.getByTestId('tenant')).toHaveTextContent('unread:3');
  });

  it('markPersonRead no-ops on an EMPTY contactId (never POST /api/inbox//read)', async () => {
    // The guard is falsy, not `=== undefined`: the placement twin really does
    // build a loading placeholder with tenantId: '', so '' has to be rejected too.
    getAllConversations.mockResolvedValue({
      items: [conv('c-ten', 'ten-1', 3, 'tenant_1to1')],
      truncated: false,
    });
    render(<Probe tour={makeTour()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('unread:3'));
    await userEvent.click(screen.getByRole('button', { name: 'markTenantEmptyId' }));
    expect(markInboxRead).not.toHaveBeenCalled();
    expect(screen.getByTestId('tenant')).toHaveTextContent('unread:3');
  });

  it('markGroupRead still marks the SINGLE group conversation read', async () => {
    getAllConversations.mockResolvedValue({
      items: [conv('g1', 'ten-1', 4, 'relay_group')],
      truncated: false,
    });
    render(<Probe tour={makeTour({ groupThreadId: 'g1' })} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('group')).toHaveTextContent('g1/4'));
    await userEvent.click(screen.getByRole('button', { name: 'markGroup' }));
    expect(markConversationRead).toHaveBeenCalledWith('g1');
    // The group read must NEVER fan out (it would clear the 1:1 tabs).
    expect(markInboxRead).not.toHaveBeenCalled();
    expect(screen.getByTestId('group')).toHaveTextContent('g1/0');
  });

  it('setGroupConversationId injects a just-created group thread id', async () => {
    render(<Probe tour={makeTour()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('group')).toHaveTextContent('-/0');
    await userEvent.click(screen.getByRole('button', { name: 'inject' }));
    expect(screen.getByTestId('group')).toHaveTextContent('c-injected/0');
  });

  it('a conversation.updated refetches and refreshes unread', async () => {
    getAllConversations.mockResolvedValueOnce({
      items: [conv('c-ten', 'ten-1', 1, 'tenant_1to1')],
      truncated: false,
    });
    render(<Probe tour={makeTour()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('unread:1'));

    getAllConversations.mockResolvedValueOnce({
      items: [conv('c-ten', 'ten-1', 5, 'tenant_1to1')],
      truncated: false,
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
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('unread:5'));
  });
});

// MAJOR 2 regression: mark-read must fire for the INITIAL active tab (no click)
// and on a later inbound to the ACTIVE tab, but never for a tab that is not active.
describe('useTourChannels - initial active tab auto-mark-read (MAJOR 2)', () => {
  it('marks the initial ACTIVE tab read on the loading->ready commit (unread>0), exactly once', async () => {
    getAllConversations.mockResolvedValue({
      items: [conv('c-ten', 'ten-1', 3, 'tenant_1to1')],
      truncated: false,
    });
    render(<MarkReadHarness tour={makeTour()} landlordId="lord-1" activeKey="ten-1" />);
    // Fires WITHOUT any interaction - the regression the ref-based version missed.
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'ten-1' }));
    expect(markInboxRead).toHaveBeenCalledTimes(1);
    // The 1:1 tabs read the PERSON, never a single conversation.
    expect(markConversationRead).not.toHaveBeenCalled();
  });

  it('marks read AGAIN when an inbound raises unread on the ACTIVE tab', async () => {
    getAllConversations.mockResolvedValue({
      items: [conv('c-ten', 'ten-1', 1, 'tenant_1to1')],
      truncated: false,
    });
    render(<MarkReadHarness tour={makeTour()} landlordId="lord-1" activeKey="ten-1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(1));

    getAllConversations.mockResolvedValue({
      items: [conv('c-ten', 'ten-1', 4, 'tenant_1to1')],
      truncated: false,
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
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(2));
    expect(markInboxRead).toHaveBeenLastCalledWith({ contactId: 'ten-1' });
  });

  it('does NOT mark read a tab that is not active when its unread rises', async () => {
    getAllConversations.mockResolvedValue({
      items: [
        conv('c-ten', 'ten-1', 0, 'tenant_1to1'),
        conv('c-lord', 'lord-1', 0, 'landlord_1to1'),
      ],
      truncated: false,
    });
    render(<MarkReadHarness tour={makeTour()} landlordId="lord-1" activeKey="ten-1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    // Active (tenant) tab loaded at unread 0 -> no mark-read.
    expect(markInboxRead).not.toHaveBeenCalled();

    getAllConversations.mockResolvedValue({
      items: [
        conv('c-ten', 'ten-1', 0, 'tenant_1to1'),
        conv('c-lord', 'lord-1', 5, 'landlord_1to1'),
      ],
      truncated: false,
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
describe('useTourChannels - nav badge clears', () => {
  it('markGroupRead clears the group by its cv: key', async () => {
    getAllConversations.mockResolvedValue({
      items: [conv('g1', 'ten-1', 4, 'relay_group')],
      truncated: false,
    });
    render(<Probe tour={makeTour({ groupThreadId: 'g1' })} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('group')).toHaveTextContent('g1/4'));
    await userEvent.click(screen.getByRole('button', { name: 'markGroup' }));
    expect(noteRowsCleared).toHaveBeenCalledTimes(1);
    expect(noteRowsCleared).toHaveBeenCalledWith(['cv:g1']);
    expect(rollbackRowsCleared).not.toHaveBeenCalled();
  });

  it('markPersonRead clears the contact by its c: key', async () => {
    getAllConversations.mockResolvedValue({
      items: [conv('c-ten-sms', 'ten-1', 2, 'tenant_1to1')],
      truncated: false,
    });
    render(<Probe tour={makeTour()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('unread:2'));
    await userEvent.click(screen.getByRole('button', { name: 'markTenant' }));
    expect(noteRowsCleared).toHaveBeenCalledTimes(1);
    expect(noteRowsCleared).toHaveBeenCalledWith(['c:ten-1']);
    expect(rollbackRowsCleared).not.toHaveBeenCalled();
  });

  it('NEVER touches the badge at or below the guards', async () => {
    getAllConversations.mockResolvedValue({
      items: [conv('c-ten', 'ten-1', 0, 'tenant_1to1')],
      truncated: false,
    });
    render(<Probe tour={makeTour()} landlordId="lord-1" />);
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
    getAllConversations.mockResolvedValue({
      items: [conv('g1', 'ten-1', 4, 'relay_group')],
      truncated: false,
    });
    markConversationRead.mockRejectedValue(new Error('nope'));
    render(<Probe tour={makeTour({ groupThreadId: 'g1' })} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('group')).toHaveTextContent('g1/4'));
    await userEvent.click(screen.getByRole('button', { name: 'markGroup' }));
    await waitFor(() => expect(rollbackRowsCleared).toHaveBeenCalledWith(['cv:g1']));
  });

  it('rolls the badge clear back when the person fan-out fails', async () => {
    getAllConversations.mockResolvedValue({
      items: [conv('c-ten-sms', 'ten-1', 2, 'tenant_1to1')],
      truncated: false,
    });
    markInboxRead.mockRejectedValue(new Error('nope'));
    render(<Probe tour={makeTour()} landlordId="lord-1" />);
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('unread:2'));
    await userEvent.click(screen.getByRole('button', { name: 'markTenant' }));
    await waitFor(() => expect(rollbackRowsCleared).toHaveBeenCalledWith(['c:ten-1']));
  });

  it('does not fire the mark-read effect in a loop once the badge functions are wired', async () => {
    // A11 in its concrete form: the badge functions flow into markGroupRead /
    // markPersonRead deps, which flow into this hook's returned object, which is
    // MarkReadChild's effect dependency. A churning identity POSTs forever.
    getAllConversations.mockResolvedValue({
      items: [conv('c-ten', 'ten-1', 3, 'tenant_1to1')],
      truncated: false,
    });
    render(<MarkReadHarness tour={makeTour()} landlordId="lord-1" activeKey="ten-1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(markInboxRead).toHaveBeenCalledTimes(1);
    expect(noteRowsCleared).toHaveBeenCalledTimes(1);
  });
});
