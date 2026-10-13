// FollowUpView tests (last-heard-from 5.6): grouping and order, the row
// content (dates, the N-days chips), the actions (Interested route / form,
// partner Request a tour, Not interested + Undo, Text), the error lines, and
// the empty / error / truncated states.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError } from '../../api/index.js';
import type { FollowUpItem } from '../../api/index.js';
import { formatHeardFrom } from '../../lib/heardFrom.js';

const getFollowUps = vi.fn();
const setListingSendOutcome = vi.fn();
const ensureContactConversation = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getFollowUps: (...a: unknown[]) => getFollowUps(...a),
    setListingSendOutcome: (...a: unknown[]) => setListingSendOutcome(...a),
    ensureContactConversation: (...a: unknown[]) => ensureContactConversation(...a),
  };
});

import { FollowUpView } from './FollowUpView.js';
import { useFollowUps } from './useFollowUps.js';

const NOW = new Date('2026-10-12T15:00:00.000Z');

function item(over: Partial<FollowUpItem> = {}): FollowUpItem {
  return {
    unitId: 'u1',
    unitLabel: '672 Cameron Alexander Blvd A',
    contactId: 'c1',
    name: 'Dario Vance',
    type: 'tenant',
    sentAt: '2026-10-02T12:00:00.000Z',
    outcome: 'no_reply',
    interestedSupported: true,
    interestedMode: 'route',
    waitingSince: '2026-10-02T12:00:00.000Z',
    ...over,
  };
}
const MARCUS = item({ unitId: 'u2', unitLabel: '1427 Griffin St, downstairs', contactId: 'c2', name: 'Marcus Dale', sentAt: '2026-10-06T12:00:00.000Z', waitingSince: '2026-10-06T12:00:00.000Z' });
const TASHA = item({ unitId: 'u2', unitLabel: '1427 Griffin St, downstairs', contactId: 'c3', name: 'Tasha Reed', outcome: 'replied', sentAt: '2026-10-06T12:00:00.000Z', lastHeardFromAt: '2026-10-07T12:00:00.000Z', waitingSince: '2026-10-07T12:00:00.000Z' });

function LocationProbe(): React.JSX.Element {
  const loc = useLocation();
  return <span data-testid="path">{`${loc.pathname}${loc.search}`}</span>;
}
function Harness(): React.JSX.Element {
  const followUps = useFollowUps();
  return <FollowUpView followUps={followUps} now={NOW} />;
}
function renderView(items: FollowUpItem[], truncated = false): void {
  getFollowUps.mockResolvedValue({ items, byUnit: {}, truncated });
  render(
    <MemoryRouter initialEntries={['/broadcasts?tab=follow-up']}>
      <Routes>
        <Route path="/broadcasts" element={<Harness />} />
        <Route path="*" element={<div />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}
const group = (label: RegExp): HTMLElement => screen.getByRole('region', { name: label });
const rowOf = (name: string): HTMLElement => screen.getByRole('link', { name }).closest('li') as HTMLElement;

beforeEach(() => {
  getFollowUps.mockReset();
  setListingSendOutcome.mockReset();
  ensureContactConversation.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('FollowUpView - grouping and rows', () => {
  it('groups by property in server order (longest-waiting first), each with its own waiting count', async () => {
    renderView([item(), MARCUS, TASHA]);
    const headings = await screen.findAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([
      '672 Cameron Alexander Blvd A1 waiting',
      '1427 Griffin St, downstairs2 waiting',
    ]);
    const griffin = within(group(/1427 Griffin St/)).getAllByRole('listitem');
    expect(griffin.map((li) => within(li).getByRole('link').textContent)).toEqual(['Marcus Dale', 'Tasha Reed']);
  });

  it('a row: contact link, Sent / Last heard from dates, and the N-days chip', async () => {
    renderView([item(), TASHA]);
    const dario = await screen.findByRole('link', { name: 'Dario Vance' });
    expect(dario).toHaveAttribute('href', '/contacts/c1');
    const row = rowOf('Dario Vance');
    expect(row).toHaveTextContent(`Sent ${formatHeardFrom('2026-10-02T12:00:00.000Z', NOW).label}`);
    expect(row).toHaveTextContent('Last heard from Never');
    expect(within(row).getByText('No reply yet, 10 days')).toBeInTheDocument();
    expect(within(rowOf('Tasha Reed')).getByText('Replied, quiet 5 days')).toBeInTheDocument();
  });

  it('a date carries its full stamp as a title, and "Never" carries no title attribute (contract N1)', async () => {
    renderView([item()]);
    await screen.findByRole('link', { name: 'Dario Vance' });
    const row = rowOf('Dario Vance');
    const sent = within(row).getByText(formatHeardFrom('2026-10-02T12:00:00.000Z', NOW).label).closest('span') as HTMLElement;
    expect(sent).toHaveAttribute('title', formatHeardFrom('2026-10-02T12:00:00.000Z', NOW).title);
    const never = within(row).getByText('Never').closest('span') as HTMLElement;
    expect(never).not.toHaveAttribute('title');
  });

  it('one day reads "1 day"', async () => {
    renderView([item({ sentAt: '2026-10-11T12:00:00.000Z', waitingSince: '2026-10-11T12:00:00.000Z' })]);
    expect(await screen.findByText('No reply yet, 1 day')).toBeInTheDocument();
  });
});

describe('FollowUpView - actions', () => {
  it('Not interested marks the row and drops the count; Undo clears it back', async () => {
    const u = userEvent.setup();
    setListingSendOutcome.mockResolvedValue({ row: {} });
    renderView([item()]);
    await u.click(await screen.findByRole('button', { name: 'Mark Dario Vance not interested in 672 Cameron Alexander Blvd A' }));
    expect(setListingSendOutcome).toHaveBeenCalledWith('u1', 'c1', 'not_interested');
    const row = rowOf('Dario Vance');
    // Adjudication F10: wait for the Undo button - the pre-resolution
    // "Not interested" BUTTON already matches a bare findByText.
    const undo = await within(row).findByRole('button', { name: 'Undo not interested for Dario Vance' });
    expect(within(row).getByText('Not interested')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('0 waiting');
    await u.click(undo);
    expect(setListingSendOutcome).toHaveBeenLastCalledWith('u1', 'c1', 'clear');
    expect(await within(row).findByText('No reply yet, 10 days')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('1 waiting');
  });

  it('an actioned row stays IN PLACE for the session and leaves the list on the NEXT load', async () => {
    const u = userEvent.setup();
    setListingSendOutcome.mockResolvedValue({ row: {} });
    renderView([item(), MARCUS]);
    await u.click(await screen.findByRole('button', { name: /Mark Dario Vance not interested/ }));
    // In place: still listed, now with Undo; no refetch on an action.
    expect(await within(rowOf('Dario Vance')).findByRole('button', { name: 'Undo not interested for Dario Vance' })).toBeInTheDocument();
    expect(getFollowUps).toHaveBeenCalledTimes(1);
    // The next load (a fresh mount = a reload) is the server's truth, which no
    // longer serves the row: the row and its now-empty group are gone.
    cleanup();
    renderView([MARCUS]);
    expect(await screen.findByRole('link', { name: 'Marcus Dale' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Dario Vance' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /672 Cameron Alexander Blvd A/ })).toBeNull();
  });

  it('Interested (route) records it and shows the tour chip', async () => {
    const u = userEvent.setup();
    setListingSendOutcome.mockResolvedValue({ row: { tour: { tourId: 't1', state: 'requested' } } });
    renderView([item()]);
    await u.click(await screen.findByRole('button', { name: 'Mark Dario Vance interested in 672 Cameron Alexander Blvd A' }));
    expect(setListingSendOutcome).toHaveBeenCalledWith('u1', 'c1', 'interested');
    const chip = await within(rowOf('Dario Vance')).findByRole('link', { name: 'Tour requested' });
    expect(chip).toHaveAttribute('href', '/tours/t1');
    // In place: the row stays listed (no Interested / Not interested now); the count drops.
    expect(within(rowOf('Dario Vance')).queryByRole('button', { name: /interested in/ })).toBeNull();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('0 waiting');
  });

  it('Interested (route) with no tour on the response shows the chip "Interested"', async () => {
    const u = userEvent.setup();
    setListingSendOutcome.mockResolvedValue({ row: {} });
    renderView([item()]);
    await u.click(await screen.findByRole('button', { name: 'Mark Dario Vance interested in 672 Cameron Alexander Blvd A' }));
    const row = rowOf('Dario Vance');
    await waitFor(() => expect(within(row).queryByRole('button', { name: /interested in/ })).toBeNull());
    expect(within(row).getByText('Interested')).toBeInTheDocument();
    expect(within(row).queryByRole('link', { name: /^Tour / })).toBeNull();
  });

  it('Interested (form - no tour type on the property) opens the tour form, no API call', async () => {
    const u = userEvent.setup();
    renderView([item({ interestedMode: 'form' })]);
    await u.click(await screen.findByRole('button', { name: /Mark Dario Vance interested/ }));
    expect(setListingSendOutcome).not.toHaveBeenCalled();
    expect(screen.getByTestId('path')).toHaveTextContent('/listings/u1?tour=new&tenantId=c1');
  });

  it('a partner row offers Request a tour instead of Interested', async () => {
    renderView([item({ type: 'partner', interestedSupported: false, name: 'Renee Carter' })]);
    const link = await screen.findByRole('link', { name: 'Request a tour for Renee Carter at 672 Cameron Alexander Blvd A' });
    expect(link).toHaveAttribute('href', '/listings/u1?tour=new');
    // A partner can still be marked not interested; only Interested is replaced.
    expect(screen.getByRole('button', { name: 'Mark Renee Carter not interested in 672 Cameron Alexander Blvd A' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark Renee Carter interested/ })).toBeNull();
  });

  it('a landlord row (not a partner) shows NEITHER Interested NOR Request a tour (plan review R2 #1)', async () => {
    renderView([item({ type: 'landlord', interestedSupported: false, name: 'Keystone PM' })]);
    expect(await screen.findByRole('link', { name: 'Keystone PM' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Request a tour/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Mark Keystone PM interested/ })).toBeNull();
    // Not interested and Text stay available on any row.
    expect(screen.getByRole('button', { name: 'Mark Keystone PM not interested in 672 Cameron Alexander Blvd A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Text Keystone PM' })).toBeInTheDocument();
  });

  it('Text opens the 1:1 conversation', async () => {
    const u = userEvent.setup();
    ensureContactConversation.mockResolvedValue('conv-9');
    renderView([item()]);
    await u.click(await screen.findByRole('button', { name: 'Text Dario Vance' }));
    expect(ensureContactConversation).toHaveBeenCalledWith('c1');
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/conversations/conv-9'));
  });

  it('a failed Text says so on the row', async () => {
    const u = userEvent.setup();
    ensureContactConversation.mockRejectedValue(new Error('down'));
    renderView([item()]);
    await u.click(await screen.findByRole('button', { name: 'Text Dario Vance' }));
    expect(await within(rowOf('Dario Vance')).findByRole('alert')).toHaveTextContent("Couldn't open the conversation - try again.");
  });

  it('a 503 with saved:true reads "Saved - reload to see the change."; any other failure "Couldn\'t save - try again."', async () => {
    const u = userEvent.setup();
    setListingSendOutcome.mockRejectedValueOnce(new ApiError(503, 'outcome_unavailable', 'x', { error: 'outcome_unavailable', saved: true }));
    renderView([item()]);
    await u.click(await screen.findByRole('button', { name: /Mark Dario Vance not interested/ }));
    expect(await within(rowOf('Dario Vance')).findByRole('alert')).toHaveTextContent('Saved - reload to see the change.');
    setListingSendOutcome.mockRejectedValueOnce(new ApiError(500, 'internal', 'x'));
    await u.click(screen.getByRole('button', { name: /Mark Dario Vance not interested/ }));
    expect(await within(rowOf('Dario Vance')).findByRole('alert')).toHaveTextContent("Couldn't save - try again.");
  });

  it('disables the row actions while a call is in flight', async () => {
    const u = userEvent.setup();
    let release: (v: unknown) => void = () => {};
    setListingSendOutcome.mockReturnValue(new Promise((r) => { release = r; }));
    renderView([item()]);
    await u.click(await screen.findByRole('button', { name: /Mark Dario Vance not interested/ }));
    expect(screen.getByRole('button', { name: /Mark Dario Vance interested/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Text Dario Vance' })).toBeDisabled();
    release({ row: {} });
    // Adjudication F10: the Undo button proves the resolution landed.
    expect(await within(rowOf('Dario Vance')).findByRole('button', { name: 'Undo not interested for Dario Vance' })).toBeEnabled();
  });
});

describe('FollowUpView - states', () => {
  it('empty', async () => {
    renderView([]);
    expect(await screen.findByText('Nothing waiting on a reply.')).toBeInTheDocument();
  });
  it('error, then Retry refetches', async () => {
    const u = userEvent.setup();
    getFollowUps.mockRejectedValueOnce(new ApiError(503, 'outcome_unavailable', 'x'));
    render(
      <MemoryRouter initialEntries={['/broadcasts']}>
        <Routes>
          <Route path="/broadcasts" element={<Harness />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load follow-ups.");
    getFollowUps.mockResolvedValueOnce({ items: [item()], byUnit: { u1: 1 }, truncated: false });
    await u.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Dario Vance' })).toBeInTheDocument();
  });
  it('truncated', async () => {
    renderView([item()], true);
    expect(await screen.findByText('Showing follow-ups for the first 100 available properties.')).toBeInTheDocument();
  });
});
