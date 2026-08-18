// GroupTextsCard — pending / honest-empty / row rendering, label preference
// (other members' names > tag > pool number > "Relay group"), conversation links
// (every row → /conversations/:conversationId), and the Closed right-hand label.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { GroupTextsCard, groupLabel, groupLink } from './GroupTextsCard.js';
import type { RelayGroupRow } from '../../api/index.js';

function makeGroup(overrides: Partial<RelayGroupRow> = {}): RelayGroupRow {
  return {
    conversationId: 'conv-g1',
    status: 'open',
    poolNumber: '+15550190001',
    memberCount: 2,
    lastActivityAt: '2026-07-01T10:00:00.000Z',
    owner: { type: null },
    otherMemberNames: [],
    ...overrides,
  };
}

// `onCreate` is deliberately NOT defaulted here: CardAction's aria-label lands
// inside the heading's accessible name, so passing it by default would break the
// bare-heading assertion below. Only the two dedicated cases pass it.
function renderIt(props: { pending: boolean; groups: RelayGroupRow[]; onCreate?: () => void }) {
  return render(
    <MemoryRouter>
      <GroupTextsCard {...props} />
    </MemoryRouter>,
  );
}

describe('GroupTextsCard', () => {
  it('renders the pending state while the slice loads (or the backend lacks the route)', () => {
    renderIt({ pending: true, groups: [] });
    expect(screen.getByText(/Arrives with the backend/i)).toBeInTheDocument();
  });

  it('renders the honest empty state when ready with no groups', () => {
    renderIt({ pending: false, groups: [] });
    expect(screen.getByText('No relay groups yet.')).toBeInTheDocument();
  });

  it('renders a row per group with the member count; the heading carries no count', () => {
    renderIt({
      pending: false,
      groups: [
        makeGroup({ otherMemberNames: ['Lars Landlord'] }),
        makeGroup({ conversationId: 'conv-g2', memberCount: 3, otherMemberNames: ['Ann A', 'Bob B'] }),
      ],
    });
    expect(screen.getByText('With Lars Landlord')).toBeInTheDocument();
    expect(screen.getByText('With Ann A & Bob B')).toBeInTheDocument();
    expect(screen.getByText('2 members')).toBeInTheDocument();
    expect(screen.getByText('3 members')).toBeInTheDocument();
    // The heading is the bare title — count asides were removed 2026-08-03.
    expect(screen.getByRole('heading', { name: 'Relay groups' })).toBeInTheDocument();
  });

  it('links every row to its own conversation view, regardless of owner', () => {
    renderIt({
      pending: false,
      groups: [
        makeGroup({ owner: { type: 'tour', id: 'tour-1' }, otherMemberNames: ['Lars Landlord'] }),
        makeGroup({
          conversationId: 'conv-g2',
          owner: { type: 'placement', id: 'k9' },
          otherMemberNames: ['Tina Tenant'],
        }),
      ],
    });
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/conversations/conv-g1');
    expect(hrefs).toContain('/conversations/conv-g2');
  });

  it('links a standalone (unowned) group to its conversation too', () => {
    renderIt({ pending: false, groups: [makeGroup({ otherMemberNames: ['Lars Landlord'] })] });
    expect(screen.getByRole('link', { name: /With Lars Landlord/ })).toHaveAttribute(
      'href',
      '/conversations/conv-g1',
    );
  });

  it('shows "Closed" (not the member count) for a closed group', () => {
    renderIt({
      pending: false,
      groups: [makeGroup({ status: 'closed', memberCount: 2 })],
    });
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByText('2 members')).not.toBeInTheDocument();
  });

  it('label preference: names > tag > pool number > "Relay group"', () => {
    expect(groupLabel(makeGroup({ otherMemberNames: ['A'], tag: 'T' }))).toBe('With A');
    expect(groupLabel(makeGroup({ tag: 'Maple St tour' }))).toBe('Maple St tour');
    expect(groupLabel(makeGroup({ poolNumber: '+15550190001' }))).toBe('(555) 019-0001');
    const bare = makeGroup({ status: 'closed' });
    delete bare.poolNumber;
    expect(groupLabel(bare)).toBe('Relay group');
  });

  // The create action. CardAction's `label` REPLACES the visible "+ Create
  // group" text as the accessible name, so the query is the aria-label.
  it('renders the create action when onCreate is set, and fires it on click', async () => {
    const onCreate = vi.fn();
    renderIt({ pending: false, groups: [], onCreate });
    await userEvent.click(screen.getByRole('button', { name: 'Create a relay group' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('renders NO create action when onCreate is absent', () => {
    renderIt({ pending: false, groups: [makeGroup({ otherMemberNames: ['Lars Landlord'] })] });
    expect(screen.queryByRole('button', { name: 'Create a relay group' })).toBeNull();
  });

  it('groupLink: always the row\'s own conversation view', () => {
    expect(groupLink(makeGroup({ conversationId: 'conv-x' }))).toBe('/conversations/conv-x');
    expect(groupLink(makeGroup({ conversationId: 'conv-y', owner: { type: 'tour', id: 't1' } }))).toBe(
      '/conversations/conv-y',
    );
  });
});
