// BroadcastResults tests (§8) — the live results view. Covers: StatChips from
// stats + per-recipient DeliveryBadge rows; a recipient row links to
// /contacts/:contactId; a phone-only row renders link-less; a failed row shows
// the error class + the "open conversation to retry" affordance; manual Refresh;
// a live broadcast.updated SSE overlays status/stats AND triggers a refetch that
// picks up updated recipients.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type {
  BroadcastResults as BroadcastResultsType,
  BroadcastUpdatedEvent,
  EventStreamHandlers,
} from '../../api/index.js';

const getBroadcastResults = vi.fn();
let sse: EventStreamHandlers = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getBroadcastResults: (...a: unknown[]) => getBroadcastResults(...a),
    useEventStream: (h: EventStreamHandlers) => {
      sse = h;
    },
  };
});

import { BroadcastResults } from './BroadcastResults.js';
import { resetServerClockForTests } from '../../api/serverClock.js';
import styles from './BroadcastResults.module.css';

/** share-sent-outcome D3: an original send's message id, and a retry's. */
const TS_ROOT = '2026-07-01T11:50:00.000Z#SMroot1';
const TS_RETRY = '2026-07-01T11:55:00.000Z#SMretry1';

function results(over: Partial<BroadcastResultsType> = {}): BroadcastResultsType {
  return {
    broadcastId: 'bcast_1',
    status: 'sending',
    unitId: 'unit-0001',
    audience_filter: { contact_type: 'tenant', bedroomSize: 2 },
    stats: { audience: 3, sent: 1, delivered: 1, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 1 },
    recipients: {
      c1: { status: 'delivered' },
      c2: { status: 'queued' },
    },
    created_at: '2026-06-30T14:00:00.000Z',
    ...over,
  };
}

function renderResults(id = 'bcast_1'): void {
  render(
    <MemoryRouter initialEntries={[`/broadcasts/${id}`]}>
      <Routes>
        <Route path="/broadcasts/:broadcastId" element={<BroadcastResults />} />
        <Route path="/contacts/:contactId" element={<div>Contact page</div>} />
        <Route path="*" element={<div />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The header's lifecycle pill text (the span beside the page h1). */
function pillLabel(): string {
  const top = screen.getByRole('heading', { level: 1 }).parentElement as HTMLElement;
  return Array.from(top.children)
    .filter((el) => el.tagName !== 'H1')
    .map((el) => el.textContent ?? '')
    .join('');
}

/** One StatChips count, read by its exact label. */
function chipCount(label: string): number {
  const dt = within(screen.getByLabelText('Delivery stats')).getByText(label, { exact: true });
  return Number((dt.closest('div') as HTMLElement).querySelector('dd')?.textContent);
}

beforeEach(() => {
  getBroadcastResults.mockReset();
  sse = {};
  resetServerClockForTests();
});
afterEach(() => vi.restoreAllMocks());

describe('BroadcastResults — render', () => {
  it('renders the StatChips + per-recipient rows with delivery badges', async () => {
    getBroadcastResults.mockResolvedValue(results());
    renderResults();
    // Stat chips.
    const chips = await screen.findByLabelText('Delivery stats');
    expect(within(within(chips).getByText('Recipients').closest('div') as HTMLElement).getByText('3')).toBeInTheDocument();
    // Recipient rows + a delivery badge each.
    const list = screen.getByRole('list', { name: 'Recipients' });
    expect(within(list).getByText('Delivered')).toBeInTheDocument();
    expect(within(list).getByText('Sending…')).toBeInTheDocument();
  });

  it('a recipient row links to /contacts/:contactId', async () => {
    getBroadcastResults.mockResolvedValue(results({ recipients: { c1: { status: 'delivered' } } }));
    renderResults();
    const list = await screen.findByRole('list', { name: 'Recipients' });
    const link = within(list).getByRole('link');
    expect(link).toHaveAttribute('href', '/contacts/c1');
  });

  it('shows the tenant name (primary) + formatted phone (secondary), link preserved', async () => {
    getBroadcastResults.mockResolvedValue(
      results({
        recipients: {
          c1: { status: 'delivered', firstName: 'Jane', lastName: 'Doe', phone: '+14040000007' },
        },
      }),
    );
    renderResults();
    const list = await screen.findByRole('list', { name: 'Recipients' });
    expect(within(list).getByText('Jane Doe')).toBeInTheDocument();
    expect(within(list).getByText('(404) 000-0007')).toBeInTheDocument();
    // The row still links to the contact's comms.
    expect(within(list).getByRole('link', { name: /Jane Doe/ })).toHaveAttribute(
      'href',
      '/contacts/c1',
    );
  });

  it('falls back to the phone as the label when no name resolves', async () => {
    getBroadcastResults.mockResolvedValue(
      results({ recipients: { c1: { status: 'sent', phone: '+14040000007' } } }),
    );
    renderResults();
    const list = await screen.findByRole('list', { name: 'Recipients' });
    // Phone is the primary label (no duplicate secondary line).
    expect(within(list).getAllByText('(404) 000-0007')).toHaveLength(1);
  });

  it('falls back to "Tenant" when neither name nor phone resolves (deleted contact)', async () => {
    getBroadcastResults.mockResolvedValue(
      results({ recipients: { c1: { status: 'queued' } } }),
    );
    renderResults();
    const list = await screen.findByRole('list', { name: 'Recipients' });
    expect(within(list).getByText('Tenant')).toBeInTheDocument();
    // Still a link to the contact page (contactId key).
    expect(within(list).getByRole('link')).toHaveAttribute('href', '/contacts/c1');
  });

  it('a phone-only recipient row renders WITHOUT a link', async () => {
    getBroadcastResults.mockResolvedValue(
      results({ recipients: { 'phone#+14040000007': { status: 'delivered' } } }),
    );
    renderResults();
    const list = await screen.findByRole('list', { name: 'Recipients' });
    expect(within(list).queryByRole('link')).not.toBeInTheDocument();
    expect(within(list).getByText('(404) 000-0007')).toBeInTheDocument();
  });

  // share-sent-outcome D3: the hint appears only when the conversation would
  // offer Retry - the recipient's newest attempt has a MESSAGE ROW. A failed
  // slot with neither a message id nor a newer attempt (a synchronous
  // rejection, a fence, a cap, an enqueue failure) has nothing to retry.
  it('a failed row with NO message row shows the error class but NO "open conversation to retry" affordance', async () => {
    getBroadcastResults.mockResolvedValue(
      results({ recipients: { c1: { status: 'failed', errorCode: '30003' } } }),
    );
    renderResults();
    const list = await screen.findByRole('list', { name: 'Recipients' });
    // Error class surfaced through the badge reason.
    expect(within(list).getByText(/Phone unreachable/i)).toBeInTheDocument();
    // Still a link to the contact's comms, but not a retry affordance.
    expect(within(list).getByRole('link')).toHaveAttribute('href', '/contacts/c1');
    expect(within(list).queryByRole('link', { name: /open conversation to retry/i })).toBeNull();
    expect(list.textContent ?? '').not.toContain('open conversation to retry');
  });

  it('a failed row WITH a message row and no live promise shows the error class + the "open conversation to retry" affordance (ASCII copy)', async () => {
    getBroadcastResults.mockResolvedValue(
      results({
        recipients: {
          c1: { status: 'failed', errorCode: '30007', conversationId: 'conv-1', tsMsgId: TS_ROOT },
          // The newest attempt is a retry row: it too is a row the thread can retry.
          c2: { status: 'failed', errorCode: '30003', conversationId: 'conv-2', latestAttempt: TS_RETRY },
        },
      }),
    );
    renderResults();
    const list = await screen.findByRole('list', { name: 'Recipients' });
    expect(within(list).getByText(/Carrier filtered the message/i)).toBeInTheDocument();
    // The conversation-only disposition affordance is NAME-RESOLVABLE on the link:
    // its inner "open conversation to retry" hint contributes to the accessible
    // name (not aria-hidden), so a role+name lookup resolves the failed-row link.
    const retryLinks = within(list).getAllByRole('link', { name: /open conversation to retry/i });
    // The rows link to the contacts' comms (the in-thread Retry lives there).
    expect(retryLinks.map((l) => l.getAttribute('href')).sort()).toEqual(['/contacts/c1', '/contacts/c2']);
    // The copy is plain ASCII - no glyph in front of it.
    for (const link of retryLinks) {
      const hint = within(link).getByText('open conversation to retry');
      expect(hint.textContent).toBe('open conversation to retry');
    }
  });

  it('no hint while the promise is live - the badge promises "will retry" instead', async () => {
    getBroadcastResults.mockResolvedValue(
      results({
        recipients: {
          // The Date pin (test/setup.ts) is 2026-07-01T12:00:00Z; due at 12:03.
          c1: {
            status: 'failed',
            errorCode: '30003',
            conversationId: 'conv-1',
            tsMsgId: TS_ROOT,
            retryDueAt: '2026-07-01T12:03:00.000Z',
            retryPending: true,
          },
        },
      }),
    );
    renderResults();
    const list = await screen.findByRole('list', { name: 'Recipients' });
    expect(within(list).getByText(/Phone unreachable - will retry \(error 30003\)/)).toBeInTheDocument();
    expect(within(list).queryByRole('link', { name: /open conversation to retry/i })).toBeNull();
  });

  it('no hint when the chain ended unresolved (retryOutcome unconfirmed) - the badge reads "retry not confirmed"', async () => {
    getBroadcastResults.mockResolvedValue(
      results({
        recipients: {
          c1: {
            status: 'failed',
            errorCode: '30003',
            conversationId: 'conv-1',
            tsMsgId: TS_ROOT,
            retryDueAt: '1970-01-01T00:00:00.000Z',
            retryOutcome: 'unconfirmed',
          },
        },
      }),
    );
    renderResults();
    const list = await screen.findByRole('list', { name: 'Recipients' });
    expect(within(list).getByText(/Phone unreachable - retry not confirmed \(error 30003\)/)).toBeInTheDocument();
    expect(within(list).queryByRole('link', { name: /open conversation to retry/i })).toBeNull();
  });

  // SOR D22. A recipient the platform could not confirm reads "Not confirmed"
  // with its reason, keeps the failed styling and the failures-first sort (a
  // danger-toned row sorted first is right), stays a link to the contact - and
  // offers NO "open conversation to retry": the text may have gone out, and a
  // resend is the double text this branch exists to prevent.
  it('an unconfirmed row reads Not confirmed with its reason, keeps the failed styling and sort, and offers no retry hint', async () => {
    getBroadcastResults.mockResolvedValue(
      results({
        stats: {
          audience: 2,
          sent: 0,
          delivered: 1,
          failed: 0,
          unconfirmed: 1,
          skipped_opted_out: 0,
          skipped_no_consent: 0,
          queued: 0,
        },
        recipients: {
          // Delivered FIRST in the map, so only the sort can put Ana on top.
          c2: { status: 'delivered', firstName: 'Bo' },
          c1: { status: 'failed', errorCode: 'send_unconfirmed', firstName: 'Ana' },
        },
      }),
    );
    renderResults();
    // Scoped to the Recipients list: the stats chip carries the same label.
    const list = await screen.findByRole('list', { name: 'Recipients' });
    const [first] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('Ana');
    expect(within(first as HTMLElement).getByText('Not confirmed')).toBeInTheDocument();
    expect(
      within(first as HTMLElement).getByText(/Couldn't confirm whether this text went out/),
    ).toBeInTheDocument();
    expect(first).toHaveClass(styles.recipientFailed!);
    expect(within(first as HTMLElement).queryByText('Failed')).not.toBeInTheDocument();
    // Still a link to the contact, but not a retry affordance.
    expect(within(list).getByRole('link', { name: /Ana/ })).toHaveAttribute('href', '/contacts/c1');
    expect(within(list).queryByRole('link', { name: /open conversation to retry/i })).toBeNull();
    expect(list.textContent ?? '').not.toContain('open conversation to retry');
    // The chip counts it apart from Failed.
    const chips = screen.getByLabelText('Delivery stats');
    expect(
      within(within(chips).getByText('Not confirmed').closest('div') as HTMLElement).getByText('1'),
    ).toBeInTheDocument();
  });
});

describe('BroadcastResults — not found', () => {
  it('shows the deleted/missing state on a 404', async () => {
    const { ApiError } = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
    getBroadcastResults.mockRejectedValue(new ApiError(404, 'broadcast_not_found', 'gone'));
    renderResults();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/doesn't exist/i);
    expect(within(alert).getByRole('link', { name: /Back to Matching/i })).toBeInTheDocument();
  });
});

describe('BroadcastResults — manual refresh', () => {
  it('refetches when Refresh is clicked', async () => {
    getBroadcastResults.mockResolvedValue(results());
    renderResults();
    await screen.findByRole('list', { name: 'Recipients' });
    expect(getBroadcastResults).toHaveBeenCalledTimes(1);
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(getBroadcastResults).toHaveBeenCalledTimes(2));
  });
});

describe('BroadcastResults — live broadcast.updated SSE', () => {
  it('overlays status+stats instantly AND refetches for the updated recipients', async () => {
    // First load: sending, c2 queued.
    getBroadcastResults.mockResolvedValueOnce(results());
    renderResults();
    await screen.findByRole('list', { name: 'Recipients' });
    // The header pill starts at "Sending" — scope OUTSIDE the stats dl, where
    // "Sending" now also appears as the in-flight chip's label.
    const chipsEl = screen.getByLabelText('Delivery stats');
    expect(
      screen.getAllByText('Sending').filter((el) => !chipsEl.contains(el)).length,
    ).toBeGreaterThan(0);

    // The refetch the SSE triggers returns the SENT rollup with c2 now delivered.
    getBroadcastResults.mockResolvedValueOnce(
      results({
        status: 'sent',
        stats: { audience: 3, sent: 0, delivered: 3, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 },
        recipients: { c1: { status: 'delivered' }, c2: { status: 'delivered' } },
      }),
    );

    const event: BroadcastUpdatedEvent = {
      broadcastId: 'bcast_1',
      status: 'sent',
      stats: { audience: 3, sent: 0, delivered: 3, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 },
    };
    act(() => sse.onBroadcastUpdated?.(event));

    // Instant overlay: the Delivered chip flips to 3 (the live rollup) without a
    // refetch having resolved yet. (Scope to the chips dl — "Sent" appears both as
    // a chip label and, now, the status pill.)
    const chips = screen.getByLabelText('Delivery stats');
    await waitFor(() =>
      expect(
        within(within(chips).getByText('Delivered').closest('div') as HTMLElement).getByText('3'),
      ).toBeInTheDocument(),
    );
    // The status pill flips to "Sent" — it lives OUTSIDE the stats dl.
    const pillSent = screen.getAllByText('Sent').filter((el) => !chips.contains(el));
    expect(pillSent.length).toBeGreaterThan(0);

    // And the debounced refetch fires (per-recipient detail).
    await waitFor(() => expect(getBroadcastResults).toHaveBeenCalledTimes(2));
  });

  it('ignores a broadcast.updated for a DIFFERENT broadcast', async () => {
    getBroadcastResults.mockResolvedValue(results());
    renderResults();
    await screen.findByRole('list', { name: 'Recipients' });
    expect(getBroadcastResults).toHaveBeenCalledTimes(1);
    act(() =>
      sse.onBroadcastUpdated?.({
        broadcastId: 'someone_else',
        status: 'sent',
        stats: { audience: 1, sent: 0, delivered: 1, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 },
      }),
    );
    // No overlay, no refetch. (The pill lives outside the stats dl, where
    // "Sending" also appears as the in-flight chip's label.)
    const chipsEl = screen.getByLabelText('Delivery stats');
    expect(
      screen.getAllByText('Sending').filter((el) => !chipsEl.contains(el)).length,
    ).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(getBroadcastResults).toHaveBeenCalledTimes(1);
  });
});

// share-sent-outcome D4: the stored last_error explains a share that reached
// nobody for a reason of its own - it shows under "Not sent" only.
describe('BroadcastResults - last_error', () => {
  const none = { sent: 0, delivered: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 };

  it('shows the stored last_error when the pill reads Not sent', async () => {
    getBroadcastResults.mockResolvedValue(
      results({
        status: 'failed',
        last_error: 'Every text failed',
        stats: { ...none, audience: 1, failed: 1, retry_pending: 0 },
        recipients: { c1: { status: 'failed', errorCode: '30007', tsMsgId: TS_ROOT } },
      }),
    );
    renderResults();
    await screen.findByRole('list', { name: 'Recipients' });
    expect(pillLabel()).toBe('Not sent');
    expect(screen.getByRole('alert')).toHaveTextContent('Every text failed');
  });

  it('hides it under Not confirmed', async () => {
    getBroadcastResults.mockResolvedValueOnce(
      results({
        status: 'failed',
        last_error: "Couldn't confirm any text went out",
        stats: { ...none, audience: 1, failed: 0, unconfirmed: 1, retry_pending: 0 },
        recipients: { c1: { status: 'failed', errorCode: 'send_unconfirmed' } },
      }),
    );
    renderResults();
    await screen.findByRole('list', { name: 'Recipients' });
    expect(pillLabel()).toBe('Not confirmed');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText("Couldn't confirm any text went out")).toBeNull();
  });

  it('hides it under Sent (someone was reached)', async () => {
    getBroadcastResults.mockResolvedValueOnce(
      results({
        status: 'sent',
        last_error: 'One text failed',
        stats: { ...none, audience: 2, delivered: 1, failed: 1, retry_pending: 0 },
        recipients: { c1: { status: 'delivered' }, c2: { status: 'failed', errorCode: '30007' } },
      }),
    );
    renderResults();
    await screen.findByRole('list', { name: 'Recipients' });
    expect(pillLabel()).toBe('Sent');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// share-sent-outcome D3/D4 (deviation 14): the page re-judges every promise on
// the SERVER clock on a 60 s ticker, and ONLY on a tick recounts retry_pending
// from its own rows, so the header and the chips never outlive a lapsed promise
// and never flash between an SSE event and its refetch.
describe('BroadcastResults - the server-clock ticker', () => {
  const none = { sent: 0, delivered: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 };
  /** Live at 12:00:00 (due + the 2-minute grace = 12:00:30); lapsed by the 60 s tick. */
  const DUE_SOON = '2026-07-01T11:58:30.000Z';

  beforeEach(() => {
    vi.useRealTimers(); // release the global Date pin (test/setup.ts) first
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance the fake clock (and every timer) by `ms`, flushing the fetches. */
  async function flush(ms = 0): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  function pendingShare(recipientOver: Partial<BroadcastResultsType['recipients'][string]> = {}): BroadcastResultsType {
    return results({
      status: 'sent',
      stats: { ...none, audience: 1, failed: 1, retry_pending: 1 },
      recipients: {
        c1: {
          status: 'failed',
          errorCode: '30003',
          conversationId: 'conv-1',
          tsMsgId: TS_ROOT,
          retryDueAt: DUE_SOON,
          retryPending: true,
          ...recipientOver,
        },
      },
    });
  }

  it('a tick past the promise shows the hint AND moves the pill from Sending to Not sent with the Retrying chip at 0 - fetching nothing', async () => {
    getBroadcastResults.mockResolvedValue(pendingShare());
    renderResults();
    await flush();
    const list = screen.getByRole('list', { name: 'Recipients' });
    expect(pillLabel()).toBe('Sending');
    expect(chipCount('Retrying')).toBe(1);
    expect(chipCount('Failed')).toBe(0);
    expect(within(list).getByText(/will retry/)).toBeInTheDocument();
    expect(within(list).queryByRole('link', { name: /open conversation to retry/i })).toBeNull();

    await flush(60_000);
    expect(within(list).queryByText(/will retry/)).toBeNull();
    expect(within(list).getByText(/Phone unreachable \(error 30003\)/)).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: /open conversation to retry/i })).toHaveAttribute('href', '/contacts/c1');
    expect(pillLabel()).toBe('Not sent');
    expect(chipCount('Retrying')).toBe(0);
    expect(chipCount('Failed')).toBe(1);
    expect(getBroadcastResults).toHaveBeenCalledTimes(1);
  });

  it('a row marked retryPending with NO retryDueAt (its row read failed) is still counted on a tick', async () => {
    getBroadcastResults.mockResolvedValue(pendingShare({ retryDueAt: undefined }));
    renderResults();
    await flush();
    expect(pillLabel()).toBe('Sending');
    await flush(60_000);
    expect(pillLabel()).toBe('Sending');
    expect(chipCount('Retrying')).toBe(1);
  });

  it('an SSE overlay carrying retry_pending 1 before its refetch keeps Sending - a tick in between does not recount the stale rows', async () => {
    // Loaded: c1 failed for good, nothing pending - Not sent.
    getBroadcastResults.mockResolvedValueOnce(
      results({
        status: 'sent',
        stats: { ...none, audience: 1, failed: 1, retry_pending: 0 },
        recipients: { c1: { status: 'failed', errorCode: '30003', conversationId: 'conv-1', tsMsgId: TS_ROOT } },
      }),
    );
    renderResults();
    await flush();
    expect(pillLabel()).toBe('Not sent');
    // The refetch the event schedules brings c1's retry promise.
    getBroadcastResults.mockResolvedValueOnce(pendingShare({ retryDueAt: '2026-07-01T12:05:00.000Z' }));
    await flush(59_800);
    // The rollup's emit for the retry it just scheduled: its own lower bound.
    act(() =>
      sse.onBroadcastUpdated?.({
        broadcastId: 'bcast_1',
        status: 'sent',
        stats: { ...none, audience: 1, failed: 1, retry_pending: 1 },
      }),
    );
    expect(pillLabel()).toBe('Sending');
    // The 60 s tick lands BEFORE the 400 ms refetch: the stale rows (nothing
    // pending) must not recount the event's count away.
    await flush(200);
    expect(pillLabel()).toBe('Sending');
    await flush(200);
    expect(getBroadcastResults).toHaveBeenCalledTimes(2);
    expect(pillLabel()).toBe('Sending');
    expect(chipCount('Retrying')).toBe(1);
  });

  it('after a tick recounted to 0, an overlay with the count UNSET keeps 0; one CARRYING retry_pending 1 replaces it', async () => {
    getBroadcastResults.mockResolvedValue(pendingShare());
    renderResults();
    await flush();
    await flush(60_000);
    expect(pillLabel()).toBe('Not sent');
    // A receipt for another recipient: the emit leaves the count unset, and
    // the hook keeps the load's (now stale) 1 - the tick's 0 must stand.
    act(() =>
      sse.onBroadcastUpdated?.({
        broadcastId: 'bcast_1',
        status: 'sent',
        stats: { ...none, audience: 1, failed: 1 },
      }),
    );
    expect(pillLabel()).toBe('Not sent');
    expect(chipCount('Retrying')).toBe(0);
    // A NEW pending recipient: the rollup's own count outranks the recount.
    act(() =>
      sse.onBroadcastUpdated?.({
        broadcastId: 'bcast_1',
        status: 'sent',
        stats: { ...none, audience: 1, failed: 1, retry_pending: 1 },
      }),
    );
    expect(pillLabel()).toBe('Sending');
    expect(chipCount('Retrying')).toBe(1);
  });

  it('a refetch replaces the recount with the route truth', async () => {
    getBroadcastResults.mockResolvedValueOnce(pendingShare());
    renderResults();
    await flush();
    await flush(60_000);
    expect(pillLabel()).toBe('Not sent');
    // A manual Refresh: the route now reads a NEW live promise for c1.
    getBroadcastResults.mockResolvedValueOnce(pendingShare({ retryDueAt: '2026-07-01T12:06:00.000Z' }));
    act(() => screen.getByRole('button', { name: 'Refresh' }).click());
    await flush();
    expect(getBroadcastResults).toHaveBeenCalledTimes(2);
    expect(pillLabel()).toBe('Sending');
    expect(chipCount('Retrying')).toBe(1);
  });
});
