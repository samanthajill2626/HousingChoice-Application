import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayCloseNag, TodayItem } from '../../api/index.js';

// Drive the page entirely through a mocked useToday so the render test is
// independent of fetching/SSE (those are covered in useToday.test.tsx).
let state: {
  status: string;
  items: TodayItem[];
  source: string;
  relayCloseNags?: RelayCloseNag[];
  dismissNag?: (id: string) => void;
} = {
  status: 'loading',
  items: [],
  source: 'server',
};
vi.mock('./useToday.js', () => ({ useToday: () => state }));

// The nag card drives the two relay endpoints directly; mock them, keep the rest.
const closeConversation = vi.fn();
const deferCloseNag = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    closeConversation: (...a: unknown[]) => closeConversation(...a),
    deferCloseNag: (...a: unknown[]) => deferCloseNag(...a),
  };
});

import { Today } from './Today.js';

function renderToday(): void {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Today />} />
        <Route path="/tours/:tourId" element={<div>TOUR PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function makeNag(over: Partial<RelayCloseNag> = {}): RelayCloseNag {
  return {
    conversationId: 'g1',
    poolNumber: '+15550190001',
    memberNames: ['Ann', 'Marcus'],
    ownerType: 'tour',
    ownerId: 'tour-1',
    nagDueAt: '2026-07-01T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  state = { status: 'loading', items: [], source: 'server' };
  closeConversation.mockReset().mockResolvedValue({});
  deferCloseNag.mockReset().mockResolvedValue({});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Today', () => {
  it('shows a Today heading and a spinner while loading', () => {
    state = { status: 'loading', items: [], source: 'server' };
    renderToday();
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an inline error message on error', () => {
    state = { status: 'error', items: [], source: 'server' };
    renderToday();
    expect(screen.getByText(/couldn.t load|something went wrong|try again/i)).toBeInTheDocument();
  });

  it('shows a friendly empty state when there is nothing to do', () => {
    state = { status: 'ready', items: [], source: 'server' };
    renderToday();
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
  });

  it('renders only the non-empty groups, with rows, urgency, tag, and links', () => {
    state = {
      status: 'ready',
      source: 'fallback',
      items: [
        {
          group: 'needs_you_now',
          refType: 'placement',
          refId: 'k1',
          who: 'Tasha Williams',
          why: 'RTA window closing',
          urgency: '2h left',
          tag: 'Placement - Touring',
        },
        {
          group: 'needs_you_now',
          refType: 'conversation',
          refId: 'cv1',
          who: '(404) 010-0007',
          why: 'New inbound — untriaged',
          tag: 'Contact - Unknown',
          attention: true,
        },
        {
          group: 'unreplied',
          refType: 'contact',
          refId: 'ct1',
          who: 'James Porter',
          why: 'Is the 2BR still open?',
          tag: 'Contact - Landlord',
        },
      ],
    };
    renderToday();

    // Group headings present for non-empty groups; absent groups are skipped.
    expect(screen.getByRole('heading', { name: /Needs you now/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Unreplied/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Tours today/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Follow-ups/i })).not.toBeInTheDocument();

    // A placement row links to /placements/:id and shows who / why / urgency / tag.
    const placementLink = screen.getByRole('link', { name: /Tasha Williams/ });
    expect(placementLink).toHaveAttribute('href', '/placements/k1');
    expect(within(placementLink).getByText('RTA window closing')).toBeInTheDocument();
    expect(within(placementLink).getByText('2h left')).toBeInTheDocument();
    expect(within(placementLink).getByText('Placement - Touring')).toBeInTheDocument();

    // refType drives the link target: conversation → /conversations/:id.
    expect(screen.getByRole('link', { name: /\(404\) 010-0007/ })).toHaveAttribute(
      'href',
      '/conversations/cv1',
    );
    // contact → /contacts/:id.
    expect(screen.getByRole('link', { name: /James Porter/ })).toHaveAttribute(
      'href',
      '/contacts/ct1',
    );
  });

  it('renders the AI suggestions group with its label and count', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [
        {
          group: 'ai_suggestions',
          refType: 'contact',
          refId: 'k1',
          who: 'Tasha Williams',
          why: '2 suggestion(s)',
        },
      ],
    };
    renderToday();
    expect(screen.getByRole('heading', { name: /AI suggestions to review/i })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Tasha Williams/ });
    expect(link).toHaveAttribute('href', '/contacts/k1');
    expect(within(link).getByText('2 suggestion(s)')).toBeInTheDocument();
  });

  it('exposes each group as a list of rows', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [
        { group: 'tours_today', refType: 'placement', refId: 'k1', who: 'A', why: 'Tour today' },
        { group: 'tours_today', refType: 'placement', refId: 'k2', who: 'B', why: 'Tour today' },
      ],
    };
    renderToday();
    const list = screen.getByRole('list', { name: /Tours today/i });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('Today - relay close-nag card (D5)', () => {
  it('renders a nag with its pool number, copy, and an Open deep-link', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [],
      relayCloseNags: [makeNag()],
      dismissNag: vi.fn(),
    };
    renderToday();
    // Its own section (not "all caught up", even though items is empty).
    expect(screen.getByRole('heading', { name: /Group texts to close/i })).toBeInTheDocument();
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
    // Pool number is display DATA (formatted), plus the close-it copy with members.
    expect(screen.getByText('(555) 019-0001')).toBeInTheDocument();
    expect(
      screen.getByText(/Group text for Ann & Marcus is still open - close it\?/i),
    ).toBeInTheDocument();
    // Open deep-links the owning tour.
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/tours/tour-1');
  });

  it('Close wires closeConversation(true) and removes the row', async () => {
    const user = userEvent.setup();
    const dismissNag = vi.fn();
    state = {
      status: 'ready',
      source: 'server',
      items: [],
      relayCloseNags: [makeNag()],
      dismissNag,
    };
    renderToday();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(closeConversation).toHaveBeenCalledWith('g1', true);
    await waitFor(() => expect(dismissNag).toHaveBeenCalledWith('g1'));
    expect(deferCloseNag).not.toHaveBeenCalled();
  });

  it('Keep open wires the 28-day defer and removes the row', async () => {
    const user = userEvent.setup();
    const dismissNag = vi.fn();
    state = {
      status: 'ready',
      source: 'server',
      items: [],
      relayCloseNags: [makeNag()],
      dismissNag,
    };
    renderToday();
    await user.click(screen.getByRole('button', { name: 'Keep open' }));
    expect(deferCloseNag).toHaveBeenCalledWith('g1');
    await waitFor(() => expect(dismissNag).toHaveBeenCalledWith('g1'));
    expect(closeConversation).not.toHaveBeenCalled();
  });

  it('a nag with a tag names the tag instead of the members', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [],
      relayCloseNags: [makeNag({ tag: 'Maple St tour', ownerType: null, ownerId: undefined })],
      dismissNag: vi.fn(),
    };
    renderToday();
    expect(
      screen.getByText(/Group text for Maple St tour is still open - close it\?/i),
    ).toBeInTheDocument();
    // No owner -> Open falls back to the conversation.
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/conversations/g1');
  });
});
