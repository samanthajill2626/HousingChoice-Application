import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodayItem } from '../../api/index.js';

// Drive the page entirely through a mocked useToday so the render test is
// independent of fetching/SSE (those are covered in useToday.test.tsx).
let state: { status: string; items: TodayItem[]; source: string } = {
  status: 'loading',
  items: [],
  source: 'server',
};
vi.mock('./useToday.js', () => ({ useToday: () => state }));

import { Today } from './Today.js';

function renderToday(): void {
  render(
    <MemoryRouter>
      <Today />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state = { status: 'loading', items: [], source: 'server' };
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
