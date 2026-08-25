// GroupTextView - the NATIVE group-text thread view, exercised THROUGH
// ConversationDetail so the type dispatch is covered by the same tests (the
// dangerous failure this replaces was a silent redirect, not a crash).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type {
  ConversationHeader,
  EventStreamHandlers,
  GroupMemberRow,
  Message,
} from '../../api/index.js';

const getConversation = vi.fn();
const getConversationMembers = vi.fn();
const getGroupMembers = vi.fn();
const getConversationMessages = vi.fn();
const getConversationScheduled = vi.fn();
const markConversationRead = vi.fn();
const markConversationUnread = vi.fn();
const sendMessageMock = vi.fn();
const getAllContacts = vi.fn();
const noteRowsCleared = vi.fn();
const rollbackRowsCleared = vi.fn();
// `sse` is a DISPATCHER, not a single-slot capture. Production registers every
// useEventStream caller separately with the provider, so all of them receive a
// given event; a `sse = handlers` capture is last-writer-wins and silently
// stopped reaching the earlier callers the moment S7 added a second
// conversation.updated listener (the header's live unread count, alongside
// useGroupThread's thread filter). Handlers are useCallback-stable, so each Set
// holds one entry per caller.
const messagePersistedHandlers = new Set<(e: unknown) => void>();
const conversationUpdatedHandlers = new Set<(e: unknown) => void>();
const sse: EventStreamHandlers = {
  onMessagePersisted: (event) => {
    for (const handler of [...messagePersistedHandlers]) handler(event);
  },
  onConversationUpdated: (event) => {
    for (const handler of [...conversationUpdatedHandlers]) handler(event);
  },
};

// The nav badge's optimistic layer, spied so the mount-mark below can assert it
// stays UNWIRED (adversarial A10). If a future edit wires noteRowsCleared into
// that effect, this spy is what catches it.
vi.mock('../../app/UnreadContext.js', () => ({
  useUnread: () => ({ unread: null, unmatchedUnread: null, noteRowsCleared, rollbackRowsCleared }),
}));

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getConversation: (...a: unknown[]) => getConversation(...a),
    getConversationMembers: (...a: unknown[]) => getConversationMembers(...a),
    getGroupMembers: (...a: unknown[]) => getGroupMembers(...a),
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    getConversationScheduled: (...a: unknown[]) => getConversationScheduled(...a),
    markConversationRead: (...a: unknown[]) => markConversationRead(...a),
    markConversationUnread: (...a: unknown[]) => markConversationUnread(...a),
    sendMessage: (...a: unknown[]) => sendMessageMock(...a),
    getAllContacts: (...a: unknown[]) => getAllContacts(...a),
    useEventStream: (h: EventStreamHandlers) => {
      if (h.onMessagePersisted !== undefined) {
        messagePersistedHandlers.add(h.onMessagePersisted as (e: unknown) => void);
      }
      if (h.onConversationUpdated !== undefined) {
        conversationUpdatedHandlers.add(h.onConversationUpdated as (e: unknown) => void);
      }
    },
  };
});

import { ConversationDetail } from './ConversationDetail.js';
import { MEMBERS_REFRESH_MS } from './GroupTextView.js';

const ANN: GroupMemberRow = {
  contactId: 'c-ann',
  phone: '+14045550111',
  name: 'Ann Tenant',
  suppressed: false,
  suppressionScope: 'primary',
};
const MARCUS: GroupMemberRow = {
  contactId: 'c-marcus',
  phone: '+14045550112',
  name: 'Marcus Landlord',
  suppressed: false,
  suppressionScope: 'primary',
};

function groupHeader(over: Partial<ConversationHeader> = {}): ConversationHeader {
  return {
    conversationId: 'gt-1',
    type: 'group_text',
    status: 'group_open',
    participants: [
      { contactId: ANN.contactId, phone: ANN.phone, name: ANN.name },
      { contactId: MARCUS.contactId, phone: MARCUS.phone, name: MARCUS.name },
    ],
    ...over,
  };
}

function renderAt(conversationId: string) {
  return render(
    <MemoryRouter initialEntries={[`/conversations/${conversationId}`]}>
      <Routes>
        <Route path="/conversations/:conversationId" element={<ConversationDetail />} />
        <Route path="/contacts/:contactId" element={<div>CONTACT PAGE</div>} />
        <Route path="/inbox" element={<div>INBOX</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Deliver one conversation.updated to EVERY registered listener. The dispatch
 *  originates outside React's event system, so it is act-wrapped here. */
function emitConversationUpdated(event: Record<string, unknown>): void {
  act(() => {
    sse.onConversationUpdated?.(event as never);
  });
}

beforeEach(() => {
  messagePersistedHandlers.clear();
  conversationUpdatedHandlers.clear();
  markConversationUnread.mockReset().mockResolvedValue(undefined);
  getConversation.mockReset();
  getConversationMembers.mockReset();
  getGroupMembers.mockReset();
  getConversationMessages.mockReset().mockResolvedValue([]);
  getConversationScheduled.mockReset().mockResolvedValue({ scheduled: [] });
  markConversationRead.mockReset().mockResolvedValue(undefined);
  sendMessageMock.mockReset().mockResolvedValue({
    conversationId: 'gt-1',
    providerSid: 'IMsent1',
    tsMsgId: '2026-06-17T11:00:00.000Z#IMsent1',
    status: 'queued',
  });
  getAllContacts.mockReset().mockResolvedValue([]);
  getGroupMembers.mockResolvedValue([ANN, MARCUS]);
  getConversation.mockResolvedValue(groupHeader());
});
afterEach(() => {
  // UNMOUNT BEFORE RESTORING (fix wave 2). The members effect now re-runs on the
  // debounced SSE refetch signal, so a timer scheduled by one test can fire
  // while a component is still mounted at teardown - and if the api mocks have
  // already been restored, `getGroupMembers(...)` returns undefined and the
  // effect crashes on `.then`, failing whichever test happens to be running.
  // Explicit cleanup makes the ordering deterministic instead of dependent on
  // which afterEach was registered first.
  cleanup();
  vi.restoreAllMocks();
});

describe('ConversationDetail dispatch - group_text', () => {
  it('renders the group text view and NEVER redirects to a roster member', async () => {
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());
    // The pre-S4 `!== 'relay_group'` redirect would have landed here instead.
    expect(screen.queryByText('CONTACT PAGE')).toBeNull();
    expect(screen.getByText('With Ann & Marcus')).toBeInTheDocument();
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('gt-1'));
    // ...and DELIBERATELY does not touch the nav badge's optimistic layer
    // (adversarial A10). This mount-mark fires BLIND, with no unread knowledge,
    // exactly like useMarkContactRead - so an optimistic decrement here could
    // subtract a row the badge never counted. It reconciles through the cheap
    // count refetch the mark-read's own SSE event triggers. The asymmetry is
    // real and intended: opening this thread from an Inbox ROW decrements
    // instantly (useInbox knows that row's unread), opening it from Today or a
    // deep link does not.
    expect(noteRowsCleared).not.toHaveBeenCalled();
    expect(rollbackRowsCleared).not.toHaveBeenCalled();
  });

  it('reads the roster from the GROUP members route, never the relay members route', async () => {
    renderAt('gt-1');
    await waitFor(() => expect(getGroupMembers).toHaveBeenCalled());
    // /conversations/:id/members is relay-only by a positive type guard: calling
    // it here would 404 and blank the panel.
    expect(getConversationMembers).not.toHaveBeenCalled();
  });

  it('states in the header that the group is unmasked', async () => {
    renderAt('gt-1');
    await waitFor(() =>
      expect(
        screen.getByText(/Everyone in this group text sees everyone's real number/),
      ).toBeInTheDocument(),
    );
  });

  it('ships a working composer (S5) - and no leftover "coming next" note', async () => {
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());
    expect(await screen.findByLabelText('Reply message')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Send$/ })).toBeInTheDocument();
    expect(screen.queryByText(/Replying to a group text is coming next/)).toBeNull();
  });

  it('offers no roster editing, close, or reopen (a different roster is a different thread)', async () => {
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Add member/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Close/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/i })).toBeNull();
  });
});

describe('GroupTextView - member panel', () => {
  it('links each known member to their contact page', async () => {
    renderAt('gt-1');
    const roster = await screen.findByRole('list', { name: 'Group members' });
    expect(within(roster).getByRole('link', { name: 'Ann Tenant' })).toHaveAttribute(
      'href',
      '/contacts/c-ann',
    );
    expect(within(roster).getByText('(404) 555-0111')).toBeInTheDocument();
  });

  it('renders an unknown-number member as plain text', async () => {
    getGroupMembers.mockResolvedValue([
      ANN,
      { contactId: '', phone: '+14045550113', suppressed: false, suppressionScope: 'no_contact' },
    ]);
    renderAt('gt-1');
    const roster = await screen.findByRole('list', { name: 'Group members' });
    await waitFor(() => expect(within(roster).getByText('(404) 555-0113')).toBeInTheDocument());
    expect(within(roster).queryByRole('link', { name: '(404) 555-0113' })).toBeNull();
  });

  it('chips a PRIMARY-number opt-out as the member opting out', async () => {
    getGroupMembers.mockResolvedValue([
      { ...ANN, suppressed: true, suppressionScope: 'primary' },
      MARCUS,
    ]);
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('Opted out')).toBeInTheDocument());
  });

  it('chips a SECONDARY-number opt-out as THIS NUMBER only', async () => {
    // The number-scoped seam's whole point: the contact may be perfectly
    // reachable on their primary number. Saying "opted out" flatly would be a
    // lie staff would act on.
    getGroupMembers.mockResolvedValue([
      { ...ANN, suppressed: true, suppressionScope: 'secondary' },
      MARCUS,
    ]);
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('This number opted out')).toBeInTheDocument());
    expect(screen.queryByText('Opted out')).toBeNull();
  });

  it('shows no suppression chip for a reachable member', async () => {
    renderAt('gt-1');
    await screen.findByRole('list', { name: 'Group members' });
    expect(screen.queryByText(/Opted out/i)).toBeNull();
  });

  it('surfaces a DELETED member and what it means for sending', async () => {
    getGroupMembers.mockResolvedValue([{ ...ANN, deleted: true }, MARCUS]);
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('Deleted')).toBeInTheDocument());
    expect(screen.getByText(/Sending is refused while they are deleted/)).toBeInTheDocument();
  });

  // A15 / adversarial 13. The panel used to be fetched once on mount while the
  // delivery chips beside it updated live off SSE, so a member who texted STOP
  // stayed chipless and the left-pane banner stayed silent until a reload. One
  // screen, two contradictory statements, on the screen staff use to decide
  // whether to text a group.
  it('refetches the member panel on the SAME live signal that refetches the transcript', async () => {
    renderAt('gt-1');
    await screen.findByRole('list', { name: 'Group members' });
    await waitFor(() => expect(getGroupMembers).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Opted out')).toBeNull();

    // A member texts STOP; the receipts path records the suppression and emits
    // message.persisted - the same event that drives the transcript refetch.
    getGroupMembers.mockResolvedValue([
      { ...ANN, suppressed: true, suppressionScope: 'primary' },
      MARCUS,
    ]);
    act(() => {
      sse.onMessagePersisted?.({
        conversationId: 'gt-1',
        tsMsgId: '2026-06-17T10:05:00.000Z#SM2',
        direction: 'outbound',
      } as never);
    });

    // The roster chip lights up...
    await waitFor(() => expect(screen.getByText('Opted out')).toBeInTheDocument());
    // ...and so does the left-pane banner, with no reload.
    await waitFor(() =>
      expect(
        screen.getAllByRole('status').some((el) => /One member has opted out/.test(el.textContent ?? '')),
      ).toBe(true),
    );
  });

  it('does not let a slow member fetch overwrite a newer one', async () => {
    // Guarding the refetch means guarding the ORDER: the first (stale) response
    // must never land on top of the second.
    let releaseFirst: (rows: GroupMemberRow[]) => void = () => {};
    getGroupMembers.mockImplementationOnce(
      () => new Promise<GroupMemberRow[]>((res) => { releaseFirst = res; }),
    );
    renderAt('gt-1');
    await waitFor(() => expect(getGroupMembers).toHaveBeenCalledTimes(1));

    getGroupMembers.mockResolvedValue([
      { ...ANN, suppressed: true, suppressionScope: 'primary' },
      MARCUS,
    ]);
    act(() => {
      sse.onMessagePersisted?.({
        conversationId: 'gt-1',
        tsMsgId: '2026-06-17T10:06:00.000Z#SM3',
        direction: 'inbound',
      } as never);
    });
    await waitFor(() => expect(screen.getByText('Opted out')).toBeInTheDocument());

    // The FIRST request finally resolves, carrying the pre-STOP roster.
    act(() => releaseFirst([ANN, MARCUS]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('Opted out')).toBeInTheDocument();
  });

  it('keeps the membership visible when the member-state read fails, and says state is missing', async () => {
    getGroupMembers.mockRejectedValue(new ApiError(500, 'http_500', 'boom'));
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // Membership comes from the header, which is immutable - it must not blank.
    const roster = screen.getByRole('list', { name: 'Group members' });
    expect(within(roster).getByRole('link', { name: 'Ann Tenant' })).toBeInTheDocument();
    expect(screen.getByText(/Opt-out state may be missing/)).toBeInTheDocument();
  });

  // Adversarial 19 / conformance F8. A15 tied the panel to the SSE tick and set
  // `loading` on every one of them - but there is no `loading` branch in the
  // render, so each tick silently WITHDREW the alert for the duration of the
  // in-flight request. With /group-members failing under steady org SSE
  // traffic, once latency exceeded the inter-tick gap the alert never rendered
  // at all, and the panel showed a stale roster with `suppressed:false` and no
  // indication anything was wrong - the exact false negative A27 exists to
  // prevent, reintroduced by A15 in the same commit.
  it('keeps the member-state alert up while a later read is still in flight', async () => {
    getGroupMembers.mockRejectedValue(new ApiError(500, 'http_500', 'boom'));
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    // The next tick's request hangs (the slow-and-failing case that made this
    // alert disappear entirely).
    getGroupMembers.mockImplementationOnce(() => new Promise<GroupMemberRow[]>(() => {}));
    act(() => {
      sse.onMessagePersisted?.({
        conversationId: 'gt-1',
        tsMsgId: '2026-06-17T10:07:00.000Z#SM4',
        direction: 'inbound',
      } as never);
    });
    await waitFor(() => expect(getGroupMembers).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Opt-out state may be missing/)).toBeInTheDocument();
  });

  it('does not re-announce the alert on every refetch tick', async () => {
    getGroupMembers.mockRejectedValue(new ApiError(500, 'http_500', 'boom'));
    renderAt('gt-1');
    const alert = await screen.findByRole('alert');
    act(() => {
      sse.onMessagePersisted?.({
        conversationId: 'gt-1',
        tsMsgId: '2026-06-17T10:08:00.000Z#SM5',
        direction: 'inbound',
      } as never);
    });
    await waitFor(() => expect(getGroupMembers).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 50));
    // The SAME node, never unmounted and remounted - an alert torn down and
    // rebuilt is re-announced by a screen reader every cycle.
    expect(screen.getByRole('alert')).toBe(alert);
  });

  it('keeps the last-good roster on screen when a later read fails, and says so', async () => {
    getGroupMembers.mockResolvedValueOnce([
      { ...ANN, suppressed: true, suppressionScope: 'primary' as const },
      MARCUS,
    ]);
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('Opted out')).toBeInTheDocument());

    getGroupMembers.mockRejectedValue(new ApiError(500, 'http_500', 'boom'));
    act(() => {
      sse.onMessagePersisted?.({
        conversationId: 'gt-1',
        tsMsgId: '2026-06-17T10:09:00.000Z#SM6',
        direction: 'inbound',
      } as never);
    });
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // The last answer we actually got is still rendered - blanking it would
    // trade a stale truth for no truth at all.
    expect(screen.getByText('Opted out')).toBeInTheDocument();
  });

  it('clears the member-state alert only on a SUCCESSFUL read', async () => {
    getGroupMembers.mockRejectedValueOnce(new ApiError(500, 'http_500', 'boom'));
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    getGroupMembers.mockResolvedValue([ANN, MARCUS]);
    act(() => {
      sse.onMessagePersisted?.({
        conversationId: 'gt-1',
        tsMsgId: '2026-06-17T10:10:00.000Z#SM7',
        direction: 'inbound',
      } as never);
    });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// Fix wave 4, item 3 - a sticky alert with no way out is a dead end
// ---------------------------------------------------------------------------
//
// The alert is raised by a failure and lowered only by a SUCCESS, which is
// right. What was missing is any way to PRODUCE a success: the panel's only
// beat was the debounced SSE tick, and SSE ticks only for events emitted on
// THIS thread. A quiet group text produces none, so an operator whose read
// failed once was stuck looking at "opt-out state may be missing" until they
// reloaded the page - on the screen they use to decide whether to text a group.
//
// The same three beats also BOUND (they do not close) the number-scoped
// suppression gap: a member texting STOP to their own 1:1 thread flips their
// suppression through THAT conversation and emits nothing here. See
// MEMBERS_REFRESH_MS in the component.
describe('GroupTextView - recovering the member panel', () => {
  it('offers a RETRY on the sticky alert, and a successful retry clears it', async () => {
    getGroupMembers.mockRejectedValueOnce(new ApiError(500, 'http_500', 'boom'));
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    getGroupMembers.mockResolvedValue([
      { ...ANN, suppressed: true, suppressionScope: 'primary' as const },
      MARCUS,
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    // ...and the retry really re-read: the state it was missing is now on screen.
    expect(screen.getByText('Opted out')).toBeInTheDocument();
  });

  it('re-reads the panel when the operator comes back to the tab', async () => {
    renderAt('gt-1');
    await waitFor(() => expect(getGroupMembers).toHaveBeenCalledTimes(1));

    // A member texted STOP to their own 1:1 thread while this tab was in the
    // background. Nothing was emitted on THIS thread, so no SSE tick will ever
    // arrive to say so.
    getGroupMembers.mockResolvedValue([
      { ...ANN, suppressed: true, suppressionScope: 'primary' as const },
      MARCUS,
    ]);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByText('Opted out')).toBeInTheDocument());
  });

  it('re-reads the panel on a slow interval while it is open and visible', async () => {
    // The suite's setup already mocks the system clock, so this drives the timer
    // through its REGISTRATION rather than by advancing time: what matters is
    // that an interval is armed at the documented cadence and that firing it
    // refetches. Both halves are asserted.
    const ticks: { fn: () => void; ms: number }[] = [];
    const setInterval = vi
      .spyOn(window, 'setInterval')
      .mockImplementation(((fn: () => void, ms: number) => {
        ticks.push({ fn, ms });
        return 1 as unknown as ReturnType<typeof window.setInterval>;
      }) as never);
    try {
      renderAt('gt-1');
      await waitFor(() => expect(getGroupMembers).toHaveBeenCalledTimes(1));
      expect(ticks.some((t) => t.ms === MEMBERS_REFRESH_MS)).toBe(true);

      getGroupMembers.mockResolvedValue([
        { ...ANN, suppressed: true, suppressionScope: 'primary' as const },
        MARCUS,
      ]);
      act(() => {
        for (const tick of ticks) if (tick.ms === MEMBERS_REFRESH_MS) tick.fn();
      });

      await waitFor(() => expect(screen.getByText('Opted out')).toBeInTheDocument());
    } finally {
      setInterval.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial 18 - one person, one fact
// ---------------------------------------------------------------------------

describe('GroupTextView - suppressed AND unknown is ONE member', () => {
  // Reachable through a real server path: api.ts's `contacts.findByPhone` throws
  // (-> suppressionUnknown), and the suppression read that follows still answers
  // `suppressed: true` off the conversations GSI for someone who really did text
  // STOP. The two header filters were not disjoint and applied no precedence,
  // unlike the panel chip, so the screen stated two contradictory facts about
  // one person and the chip corroborated neither.
  const conflicted: GroupMemberRow = {
    ...ANN,
    suppressed: true,
    suppressionScope: 'primary',
    suppressionUnknown: true,
  };

  it('counts them ONCE on the header, as UNKNOWN (the panel chip precedence)', async () => {
    getGroupMembers.mockResolvedValue([conflicted, MARCUS]);
    renderAt('gt-1');
    const header = (await screen.findByText('Group text')).closest('header');
    await waitFor(() =>
      expect(within(header!).getByText(/Opt-out state unknown for 1 member/)).toBeInTheDocument(),
    );
    expect(within(header!).queryByText(/member opted out/i)).toBeNull();
  });

  it('counts them ONCE in the left-pane banners too', async () => {
    getGroupMembers.mockResolvedValue([conflicted, MARCUS]);
    renderAt('gt-1');
    await waitFor(() =>
      expect(
        screen.getAllByRole('status').some((el) => /could not be read for 1 member/i.test(el.textContent ?? '')),
      ).toBe(true),
    );
    // (The unknown notice itself says "may or may not have opted out", so the
    // matcher is anchored on the CLAIM: "<N> member(s) has/have opted out".)
    expect(
      screen
        .getAllByRole('status')
        .some((el) => /members? (has|have) opted out/.test(el.textContent ?? '')),
    ).toBe(false);
  });

  it('still counts a genuinely-suppressed member beside an unknown one', async () => {
    getGroupMembers.mockResolvedValue([
      conflicted,
      { ...MARCUS, suppressed: true, suppressionScope: 'primary' as const },
    ]);
    renderAt('gt-1');
    const header = (await screen.findByText('Group text')).closest('header');
    await waitFor(() =>
      expect(within(header!).getByText(/Opt-out state unknown for 1 member/)).toBeInTheDocument(),
    );
    // One each, not two and one: every member is counted exactly once.
    expect(within(header!).getByText('1 member opted out')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// A13 (dashboard half) - ONE naming rule, ONE input
// ---------------------------------------------------------------------------

describe('GroupTextView - the header title', () => {
  // A13, CORRECTED by adversarial 17. A13 stopped the header titling itself
  // from the /group-members resolve, which fixed the header-vs-INBOX
  // disagreement and created a header-vs-PANEL one on the SAME screen: after
  // the migration every imported roster is nameless, so the header read "With
  // (404) 555-0111 & ..." while the panel two inches right read the real names,
  // for the life of the mount. The route already converges the snapshot
  // server-side (api.ts backfillGroupTextRoster), so the honest fix is for the
  // header to adopt that same convergence rather than ignore it: ONE derivation
  // (groupThreadLabel) over ONE roster (the snapshot, converged), which is
  // exactly what the inbox row reads after the write-back.
  it('converges the header title with the panel when the resolve finds fresher names', async () => {
    getConversation.mockResolvedValue(
      groupHeader({
        participants: [
          { contactId: ANN.contactId, phone: ANN.phone },
          { contactId: MARCUS.contactId, phone: MARCUS.phone },
        ],
      }),
    );
    renderAt('gt-1');
    // It opens on the snapshot it was handed - numbers, because the migrated
    // roster is nameless.
    await waitFor(() =>
      expect(screen.getByText('With (404) 555-0111 & (404) 555-0112')).toBeInTheDocument(),
    );
    // The panel resolves the real names...
    expect(await screen.findByRole('link', { name: 'Ann Tenant' })).toBeInTheDocument();
    // ...and the header says the SAME thing, rather than contradicting the panel
    // beside it for the life of the mount.
    await waitFor(() => expect(screen.getByText('With Ann & Marcus')).toBeInTheDocument());
    expect(screen.queryByText(/With \(404\) 555-0111/)).toBeNull();
  });

  it('leaves the title alone when the resolve adds nothing the snapshot lacks', async () => {
    // The convergence is not a re-title on every tick: a snapshot that already
    // carries the current names must render byte-identically start to finish.
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('With Ann & Marcus')).toBeInTheDocument());
    await screen.findByRole('list', { name: 'Group members' });
    expect(screen.getByText('With Ann & Marcus')).toBeInTheDocument();
  });

  it('still titles a nameless snapshot by formatted numbers', async () => {
    getConversation.mockResolvedValue(
      groupHeader({
        participants: [
          { contactId: 'c-a', phone: '+14045550111' },
          { contactId: 'c-b', phone: '+14045550112' },
        ],
      }),
    );
    renderAt('gt-1');
    await waitFor(() =>
      expect(screen.getByText('With (404) 555-0111 & (404) 555-0112')).toBeInTheDocument(),
    );
  });
});

describe('GroupTextView - the send cap', () => {
  const bigRoster: GroupMemberRow[] = Array.from({ length: 10 }, (_, i) => ({
    contactId: `c-${i}`,
    phone: `+140455501${String(20 + i)}`,
    name: `Member${i}`,
    suppressed: false,
    suppressionScope: 'primary' as const,
  }));

  it('marks a >9-member thread read-only and names the 1:1 links as the fallback', async () => {
    getGroupMembers.mockResolvedValue(bigRoster);
    renderAt('gt-1');
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        /10 members, more than the 9 a group send can reach/,
      ),
    );
    expect(screen.getByRole('status')).toHaveTextContent(/one at a time from their contact pages/);
  });

  it('renders no read-only banner at or under the cap', async () => {
    renderAt('gt-1');
    await screen.findByRole('list', { name: 'Group members' });
    expect(screen.queryByText(/group send can reach/)).toBeNull();
  });
});

describe('GroupTextView - the transcript', () => {
  function msg(over: Partial<Message> = {}): Message {
    return {
      conversationId: 'gt-1',
      tsMsgId: '2026-06-17T10:00:00.000Z#SM1',
      direction: 'inbound',
      author: 'tenant',
      type: 'sms',
      body: 'On my way',
      delivery_status: 'delivered',
      provider_ts: '2026-06-17T10:00:00.000Z',
      ...over,
    } as Message;
  }

  it('attributes a member message by its PHONE-SCOPED sender key', async () => {
    getConversationMessages.mockResolvedValue([msg({ relay_sender_key: 'phone#+14045550112' })]);
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('On my way')).toBeInTheDocument());
    // Resolved through the shared attribution renderer, against the group roster:
    // the name appears TWICE - once as the bubble's sender chip, once in the
    // member panel (which renders it as a link).
    await waitFor(() => expect(screen.getAllByText('Marcus Landlord')).toHaveLength(2));
    expect(
      screen.getAllByText('Marcus Landlord').some((el) => el.tagName !== 'A'),
    ).toBe(true);
  });

  // LIVE QA ROUND 2, L6. Every member a carrier group detects is a bare stub
  // with no name, so this - not the named case above - is what a real group
  // thread renders. It used to attribute NOTHING, for every member, always.
  it('attributes a NAMELESS member by their formatted number, not by nothing', async () => {
    const nameless: GroupMemberRow = {
      contactId: 'c-stub',
      phone: '+16174707727',
      suppressed: false,
      suppressionScope: 'no_contact',
    };
    getGroupMembers.mockResolvedValue([ANN, nameless]);
    getConversation.mockResolvedValue(
      groupHeader({
        participants: [
          { contactId: ANN.contactId, phone: ANN.phone, name: ANN.name },
          { contactId: nameless.contactId, phone: nameless.phone },
        ],
      }),
    );
    getConversationMessages.mockResolvedValue([msg({ relay_sender_key: 'phone#+16174707727' })]);
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('On my way')).toBeInTheDocument());
    // Twice, for the same reason the named case is twice: the bubble's sender
    // chip and the member panel's row, both spelling the number identically.
    await waitFor(() => expect(screen.getAllByText('(617) 470-7727')).toHaveLength(2));
  });

  it('refetches the transcript on a live message event', async () => {
    renderAt('gt-1');
    await waitFor(() => expect(getConversationMessages).toHaveBeenCalledTimes(1));
    getConversationMessages.mockResolvedValue([msg({ body: 'Just landed' })]);
    act(() => {
      sse.onMessagePersisted?.({
        conversationId: 'gt-1',
        tsMsgId: '2026-06-17T10:05:00.000Z#SM2',
        direction: 'inbound',
      } as never);
    });
    await waitFor(() => expect(screen.getByText('Just landed')).toBeInTheDocument());
  });

  // Adversarial 20. `/api/events` is an ORG-WIDE firehose: every message to
  // every thread in the org reaches every open browser. `scheduleRefetch`
  // ignored the payload, so an unrelated 1:1 re-read this thread's transcript
  // AND (since A15 tied the member panel to the same tick) fired the
  // ~18-DynamoDB-read `/group-members` endpoint, which also carries a
  // conditional roster write. Both events carry `conversationId`; nothing about
  // another thread is news to this view.
  it('ignores a live event for a DIFFERENT conversation', async () => {
    renderAt('gt-1');
    await waitFor(() => expect(getConversationMessages).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getGroupMembers).toHaveBeenCalledTimes(1));

    act(() => {
      sse.onMessagePersisted?.({
        conversationId: 'some-other-thread',
        tsMsgId: '2026-06-17T10:05:00.000Z#SM9',
        direction: 'inbound',
      } as never);
      sse.onConversationUpdated?.({
        conversationId: 'another-thread-entirely',
        last_activity_at: '2026-06-17T11:00:00.000Z',
        unread_count: 1,
        type: 'tenant_1to1',
        participant_display_name: 'Someone Else',
      } as never);
    });
    // Past the debounce window, with room to spare.
    await new Promise((r) => setTimeout(r, 400));
    expect(getConversationMessages).toHaveBeenCalledTimes(1);
    expect(getGroupMembers).toHaveBeenCalledTimes(1);
  });

  it('never asks for a scheduled bucket (group threads have no automated sends)', async () => {
    renderAt('gt-1');
    await waitFor(() => expect(getConversationMessages).toHaveBeenCalled());
    expect(getConversationScheduled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// S5 - the composer
// ---------------------------------------------------------------------------

describe('GroupTextView - the composer (S5)', () => {
  async function typeAndSend(text: string): Promise<void> {
    const box = await screen.findByLabelText('Reply message');
    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
  }

  it('POSTs the reply to the thread and shows the bubble optimistically', async () => {
    renderAt('gt-1');
    await typeAndSend('on my way');

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledWith('gt-1', { body: 'on my way' }));
    // The optimistic bubble is on screen before any refetch resolves.
    await waitFor(() => expect(screen.getByText('on my way')).toBeInTheDocument());
  });

  it('names the GROUP TEXT in the reply note, never "relay group"', async () => {
    renderAt('gt-1');
    await screen.findByLabelText('Reply message');
    expect(screen.getByText(/everyone in this group text/)).toBeInTheDocument();
    expect(screen.queryByText(/everyone in this relay group/)).toBeNull();
  });

  it('offers NO attach control - outbound group media is not supported in v1', async () => {
    renderAt('gt-1');
    await screen.findByLabelText('Reply message');
    expect(screen.queryByRole('button', { name: /Attach a file/i })).toBeNull();
  });

  it('surfaces a refused send and restores the draft rather than losing it', async () => {
    sendMessageMock.mockRejectedValue(
      new ApiError(409, 'group_member_deleted', 'Marcus is a deleted contact'),
    );
    renderAt('gt-1');
    await typeAndSend('on my way');

    await waitFor(() =>
      expect(screen.getByText(/Someone in this group text is a deleted contact/)).toBeInTheDocument(),
    );
    // The words are not lost to a 409.
    expect(await screen.findByLabelText('Reply message')).toHaveValue('on my way');
    // ...and the optimistic bubble is gone, so nothing implies it was sent: the
    // only place that text survives is the restored draft itself.
    const occurrences = screen.getAllByText('on my way');
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.tagName).toBe('TEXTAREA');
  });

  it('explains a no-consent refusal specifically', async () => {
    sendMessageMock.mockRejectedValue(new ApiError(409, 'group_member_no_consent', 'no basis'));
    renderAt('gt-1');
    await typeAndSend('hello');
    await waitFor(() =>
      expect(screen.getByText(/has no recorded consent basis/)).toBeInTheDocument(),
    );
  });

  it('explains a rail-not-ready refusal specifically', async () => {
    sendMessageMock.mockRejectedValue(new ApiError(409, 'group_rail_unavailable', 'no rail'));
    renderAt('gt-1');
    await typeAndSend('hello');
    await waitFor(() =>
      expect(screen.getByText(/not connected for sending yet/)).toBeInTheDocument(),
    );
  });

  it('REPLACES the composer on an over-cap thread rather than offering a dead one', async () => {
    getGroupMembers.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        contactId: `c-${i}`,
        phone: `+140455501${String(20 + i)}`,
        name: `Member${i}`,
        suppressed: false,
        suppressionScope: 'primary' as const,
      })),
    );
    renderAt('gt-1');
    await waitFor(() =>
      expect(screen.getByRole('note')).toHaveTextContent(/Too many members to send as a group/),
    );
    expect(screen.queryByLabelText('Reply message')).toBeNull();
  });

  it('KEEPS the composer live when a member is deleted, and says why sending will be refused', async () => {
    // A deleted member is a SERVER refusal, not a structural impossibility: the
    // contact can be restored while the operator is looking at the thread.
    getGroupMembers.mockResolvedValue([{ ...ANN, deleted: true }, MARCUS]);
    renderAt('gt-1');
    expect(await screen.findByLabelText('Reply message')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('status')
          .some((el) => /Sending is refused while a member is a deleted contact/.test(el.textContent ?? '')),
      ).toBe(true),
    );
  });

  it('says a suppressed member will not receive the send, without blocking it', async () => {
    getGroupMembers.mockResolvedValue([{ ...ANN, suppressed: true, suppressionScope: 'primary' }, MARCUS]);
    renderAt('gt-1');
    expect(await screen.findByLabelText('Reply message')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getAllByRole('status').some((el) => /One member has opted out/.test(el.textContent ?? '')),
      ).toBe(true),
    );
  });

  // LIVE QA ROUND 2, L5. The notice blamed the CARRIER for dropping the message.
  // The live evidence says otherwise: Twilio skips the participant, so no leg is
  // ever created and no carrier ever sees it. An operator told "their carrier
  // drops it" would go hunting a carrier failure that does not exist.
  it('does NOT blame the carrier for an opt-out - Twilio never sends the leg', async () => {
    getGroupMembers.mockResolvedValue([{ ...ANN, suppressed: true, suppressionScope: 'primary' }, MARCUS]);
    renderAt('gt-1');
    const notice = await waitFor(() => {
      const el = screen
        .getAllByRole('status')
        .find((n) => /opted out/.test(n.textContent ?? ''));
      if (!el) throw new Error('the opt-out notice never rendered');
      return el;
    });
    expect(notice.textContent).not.toMatch(/carrier drops it/i);
    expect(notice.textContent).toMatch(/Twilio skips them/i);
  });

  // LIVE QA ROUND 2, L5 (layout). `twoPaneShell .left` is `display: flex` with
  // the default ROW direction, so a notice rendered as a SIBLING of the timeline
  // became its own column beside the conversation and squeezed the messages into
  // a narrow slice. The pane must therefore hold exactly ONE flex child - the
  // stack - with every notice inside it, above the timeline.
  it('stacks the notices ABOVE the conversation instead of beside it', async () => {
    getGroupMembers.mockResolvedValue([
      { ...ANN, suppressed: true, suppressionScope: 'primary' },
      { ...MARCUS, deleted: true },
    ]);
    renderAt('gt-1');
    const composer = await screen.findByLabelText('Reply message');
    const notice = await waitFor(() => {
      const el = screen.getAllByRole('status').find((n) => /opted out/.test(n.textContent ?? ''));
      if (!el) throw new Error('the opt-out notice never rendered');
      return el;
    });
    const stack = notice.parentElement;
    expect(stack).not.toBeNull();
    // Every notice AND the conversation live in the one stack...
    expect(stack!.contains(composer)).toBe(true);
    expect(
      screen.getAllByRole('status').filter((n) => n.parentElement === stack).length,
    ).toBeGreaterThan(1);
    // ...and the flex-ROW pane above it has exactly that one child, so nothing
    // can ever sit BESIDE the conversation again.
    expect(stack!.parentElement!.children).toHaveLength(1);
  });

  // A27(b) / adversarial 22. `suppressionUnknown` means a read behind that
  // member FAILED server-side, so `suppressed:false` is the absence of an answer.
  // Counting only `suppressed === true` in the banner made that member invisible
  // everywhere except a chip in the Details pane - the pane hidden on a phone.
  it('names members whose opt-out state could NOT be read, without claiming they opted out', async () => {
    getGroupMembers.mockResolvedValue([{ ...ANN, suppressionUnknown: true }, MARCUS]);
    renderAt('gt-1');
    const notice = await waitFor(() => {
      const el = screen
        .getAllByRole('status')
        .find((n) => /could not be read/i.test(n.textContent ?? ''));
      if (!el) throw new Error('the unknown-opt-out-state notice never rendered');
      return el;
    });
    expect(notice.textContent).toMatch(/1 member/);
    // HONEST: it must not assert they opted out - we do not know.
    expect(
      screen.queryAllByRole('status').some((el) => /members? (has|have) opted out/.test(el.textContent ?? '')),
    ).toBe(false);
  });

  it('counts suppressed and unknown-state members separately', async () => {
    getGroupMembers.mockResolvedValue([
      { ...ANN, suppressed: true, suppressionScope: 'primary' as const },
      { ...MARCUS, suppressionUnknown: true },
    ]);
    renderAt('gt-1');
    await waitFor(() =>
      expect(
        screen.getAllByRole('status').some((el) => /One member has opted out/.test(el.textContent ?? '')),
      ).toBe(true),
    );
    expect(
      screen.getAllByRole('status').some((el) => /could not be read/i.test(el.textContent ?? '')),
    ).toBe(true);
  });

  // A27(c) / adversarial 22. The Details pane is display:none at <=860px and the
  // left-pane banner sits inside the Conversation pane, so on a phone the thread
  // looked entirely normal with zero indication. The HEADER renders at every
  // width - the state has to be there too.
  it('surfaces the suppression state on the thread HEADER (visible at every width)', async () => {
    getGroupMembers.mockResolvedValue([
      { ...ANN, suppressed: true, suppressionScope: 'primary' as const },
      MARCUS,
    ]);
    renderAt('gt-1');
    const header = (await screen.findByText('Group text')).closest('header');
    expect(header).not.toBeNull();
    await waitFor(() => expect(within(header!).getByText(/opted out/i)).toBeInTheDocument());
  });

  it('surfaces UNREAD opt-out state on the header too', async () => {
    getGroupMembers.mockResolvedValue([{ ...ANN, suppressionUnknown: true }, MARCUS]);
    renderAt('gt-1');
    const header = (await screen.findByText('Group text')).closest('header');
    await waitFor(() =>
      expect(within(header!).getByText(/opt-out state unknown/i)).toBeInTheDocument(),
    );
  });

  it('puts nothing on the header when every member is reachable', async () => {
    renderAt('gt-1');
    const header = (await screen.findByText('Group text')).closest('header');
    await screen.findByRole('list', { name: 'Group members' });
    expect(within(header!).queryByText(/opted out/i)).toBeNull();
    expect(within(header!).queryByText(/unknown/i)).toBeNull();
  });

  it('renders the per-member delivery rollup on an outbound group message', async () => {
    getConversationMessages.mockResolvedValue([
      {
        conversationId: 'gt-1',
        tsMsgId: '2026-06-17T10:00:00.000Z#IM1',
        direction: 'outbound',
        author: 'teammate',
        type: 'sms',
        body: 'heading over',
        delivery_status: 'queued',
        provider_ts: '2026-06-17T10:00:00.000Z',
        delivery_recipients: {
          'phone#+14045550111': { status: 'delivered' },
          'phone#+14045550112': { status: 'sent' },
        },
      } as unknown as Message,
    ]);
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('heading over')).toBeInTheDocument());
    // TIGHTENED (S5). This used to read `getByText(/delivered 1\/2/)`, an
    // unanchored substring regex - and this fixture's `+...0112` leg is `sent`
    // with NO `sentAt`, so it ages from `msg.at`, which `messageInstant` takes
    // from `provider_ts` (2026-06-17), fourteen days before setup.ts's pinned
    // 2026-07-01T12:00:00Z. The chip therefore escalates to
    // `delivered 1/2 - 1 not confirmed`, and RTL joins the span's text nodes
    // before regex-testing, so the OLD locator matched the escalated string too
    // and could not fail either way. Assert the whole string: the escalation on
    // a quiet leg IS the feature, and this is the one assertion on this surface
    // that proves it.
    expect(screen.getByText('delivered 1/2 - 1 not confirmed')).toBeInTheDocument();
  });

  // The GROUP-TEXT key convention, end to end through the real view. Timeline's
  // own suite covers phone-keyed rows against a hand-built roster prop; this
  // proves the roster GroupTextView actually derives from `getGroupMembers`
  // (GroupTextView.tsx:310-314) resolves a `phone#<E164>` slot to the member's
  // NAME - the failure this feature exists to prevent is a founder reading a
  // bare number, or a blank row, on the surface where every key is phone-scoped.
  //
  // Mocks: only `getConversationMessages` is overridden, and `beforeEach`
  // already re-arms it with `.mockReset().mockResolvedValue([])` (:133), so a
  // plain `.mockResolvedValue([...])` here leaves no undefined window. That is
  // the file's established idiom and the thing that keeps
  // `conversationdetail-members-mock-suite-flake` unreachable - do NOT call
  // `mockReset()` inside a test without re-arming it.
  it('names each phone-keyed recipient and their state once the bubble is revealed', async () => {
    getConversationMessages.mockResolvedValue([
      {
        conversationId: 'gt-1',
        tsMsgId: '2026-06-17T10:00:00.000Z#IM2',
        direction: 'outbound',
        author: 'teammate',
        type: 'sms',
        body: 'we are five minutes out',
        delivery_status: 'sent',
        provider_ts: '2026-06-17T10:00:00.000Z',
        delivery_recipients: {
          // Reverse of roster order on purpose: the rows must come back in
          // ROSTER order, not map order.
          'phone#+14045550112': { status: 'sent' },
          'phone#+14045550111': { status: 'delivered' },
        },
      } as unknown as Message,
    ]);
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('we are five minutes out')).toBeInTheDocument());
    // The list is CONDITIONALLY rendered, so the absence check is only
    // meaningful beside the reveal that follows it.
    expect(screen.queryByRole('list', { name: 'Delivery by recipient' })).not.toBeInTheDocument();
    // The bubble is a bare div with no role or name; clicking the body text
    // bubbles up to its toggleMeta.
    fireEvent.click(screen.getByText('we are five minutes out'));
    const list = await screen.findByRole('list', { name: 'Delivery by recipient' });
    const recipients = within(list).getAllByRole('listitem');
    expect(recipients).toHaveLength(2);
    // Scoped to the rows: the Details pane's member list carries these names too.
    expect(recipients[0]).toHaveTextContent('Ann Tenant');
    expect(recipients[0]).toHaveTextContent('Delivered');
    expect(recipients[1]).toHaveTextContent('Marcus Landlord');
    expect(recipients[1]).toHaveTextContent('Sent - not confirmed');
    // No row claims a membership it cannot know - both keys match the roster.
    expect(within(list).queryByText(/former member/)).not.toBeInTheDocument();
  });
});

// --- S7: the header mark-read / mark-unread toggle (D6) ---------------------
//
// The group-text header had NO actions container at all before this slice - only
// a back link and the identity block - so the toggle brought one with it, using
// the same shell.actions class the relay arm uses. A group text has no closed
// state in v1, so unlike the relay arm the toggle is always present here.
describe('GroupTextView - the header unread toggle (S7)', () => {
  const MARK_UNREAD = 'Mark Group text as unread';
  const MARK_READ = 'Mark Group text read';

  async function openGroup(over: Partial<ConversationHeader> = {}): Promise<void> {
    getConversation.mockResolvedValue(groupHeader(over));
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());
  }

  it('offers Mark unread - and NEVER Mark read - while the live count is 0', async () => {
    await openGroup({ unread_count: 0 });
    expect(await screen.findByRole('button', { name: MARK_UNREAD })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MARK_READ })).toBeNull();
  });

  it('offers Mark read - and NEVER Mark unread - while the live count is above 0', async () => {
    await openGroup({ unread_count: 2 });
    expect(await screen.findByRole('button', { name: MARK_READ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MARK_UNREAD })).toBeNull();
  });

  it('takes the count LIVE from conversation.updated, with no re-fetch of the header', async () => {
    await openGroup({ unread_count: 0 });
    expect(await screen.findByRole('button', { name: MARK_UNREAD })).toBeInTheDocument();
    emitConversationUpdated({
      conversationId: 'gt-1',
      last_activity_at: '2026-08-17T11:00:00.000Z',
      unread_count: 3,
    });
    expect(await screen.findByRole('button', { name: MARK_READ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MARK_UNREAD })).toBeNull();
    expect(getConversation).toHaveBeenCalledTimes(1);
  });

  it('survives a mount header with NO unread_count at all (0, never NaN)', async () => {
    await openGroup();
    expect(await screen.findByRole('button', { name: MARK_UNREAD })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MARK_READ })).toBeNull();
  });

  it('awaits the auto-read drain BEFORE issuing the mark-unread POST, then navigates', async () => {
    let releaseAutoRead: (() => void) | undefined;
    markConversationRead.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseAutoRead = resolve;
        }),
    );
    await openGroup({ unread_count: 0 });
    const button = await screen.findByRole('button', { name: MARK_UNREAD });
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('gt-1'));

    fireEvent.click(button);
    await act(async () => {
      await Promise.resolve();
    });
    expect(markConversationUnread).not.toHaveBeenCalled();

    await act(async () => {
      releaseAutoRead?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(markConversationUnread).toHaveBeenCalledWith('gt-1'));
    await waitFor(() => expect(screen.getByText('INBOX')).toBeInTheDocument());
  });

  it('does NOT navigate on Mark read', async () => {
    await openGroup({ unread_count: 2 });
    markConversationRead.mockClear();
    fireEvent.click(await screen.findByRole('button', { name: MARK_READ }));
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('gt-1'));
    expect(screen.queryByText('INBOX')).toBeNull();
  });

  it('renders the RETRYABLE copy on a 409 and leaves the action available', async () => {
    markConversationUnread.mockRejectedValue(
      new ApiError(409, 'thread_closed', 'thread_closed', { error: 'thread_closed' }),
    );
    await openGroup({ unread_count: 0 });
    fireEvent.click(await screen.findByRole('button', { name: MARK_UNREAD }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not mark unread - try again'),
    );
    expect(screen.queryByText('INBOX')).toBeNull();
    expect(screen.getByRole('button', { name: MARK_UNREAD })).toBeEnabled();
  });

  it('renders a pending state while the mark-unread request is outstanding', async () => {
    let releasePost: (() => void) | undefined;
    markConversationUnread.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releasePost = resolve;
        }),
    );
    await openGroup({ unread_count: 0 });
    fireEvent.click(await screen.findByRole('button', { name: MARK_UNREAD }));
    await waitFor(() => expect(screen.getByRole('button', { name: MARK_UNREAD })).toBeDisabled());
    expect(screen.getByText('Marking unread...')).toBeInTheDocument();
    await act(async () => {
      releasePost?.();
      await Promise.resolve();
    });
  });

  it('never touches the nav badge optimistic layer', async () => {
    await openGroup({ unread_count: 0 });
    fireEvent.click(await screen.findByRole('button', { name: MARK_UNREAD }));
    await waitFor(() => expect(markConversationUnread).toHaveBeenCalled());
    expect(noteRowsCleared).not.toHaveBeenCalled();
    expect(rollbackRowsCleared).not.toHaveBeenCalled();
  });
});
