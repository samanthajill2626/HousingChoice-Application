// GroupTextsCard — pending / honest-empty / row rendering, label preference
// (other members' names > tag > pool number > "Group text"), owner links
// (tour / placement / standalone-unlinked), and the Closed right-hand label.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

function renderIt(props: { pending: boolean; groups: RelayGroupRow[] }) {
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
    expect(screen.getByText('No group texts yet.')).toBeInTheDocument();
  });

  it('renders a row per group with the member count and a count aside', () => {
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
    // The heading count chip.
    expect(screen.getByRole('heading', { name: /Group texts\s*2/ })).toBeInTheDocument();
  });

  it('links a tour-owned group to the tour and a placement-owned group to the placement', () => {
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
    expect(hrefs).toContain('/tours/tour-1');
    expect(hrefs).toContain('/placements/k9');
  });

  it('renders a standalone (unowned) group UNLINKED', () => {
    renderIt({ pending: false, groups: [makeGroup({ otherMemberNames: ['Lars Landlord'] })] });
    expect(screen.getByText('With Lars Landlord')).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('shows "Closed" (not the member count) for a closed group', () => {
    renderIt({
      pending: false,
      groups: [makeGroup({ status: 'closed', memberCount: 2 })],
    });
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByText('2 members')).not.toBeInTheDocument();
  });

  it('label preference: names > tag > pool number > "Group text"', () => {
    expect(groupLabel(makeGroup({ otherMemberNames: ['A'], tag: 'T' }))).toBe('With A');
    expect(groupLabel(makeGroup({ tag: 'Maple St tour' }))).toBe('Maple St tour');
    expect(groupLabel(makeGroup({ poolNumber: '+15550190001' }))).toBe('(555) 019-0001');
    const bare = makeGroup({ status: 'closed' });
    delete bare.poolNumber;
    expect(groupLabel(bare)).toBe('Group text');
  });

  it('groupLink: owner → route; standalone → undefined', () => {
    expect(groupLink({ type: 'tour', id: 't1' })).toBe('/tours/t1');
    expect(groupLink({ type: 'placement', id: 'p1' })).toBe('/placements/p1');
    expect(groupLink({ type: null })).toBeUndefined();
  });
});
