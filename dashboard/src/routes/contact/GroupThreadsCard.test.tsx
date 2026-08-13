import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { GroupThreadRow } from '../../api/index.js';
import {
  GroupThreadsCard,
  groupThreadCardLabel,
  groupThreadLink,
} from './GroupThreadsCard.js';

function mkGroup(over: Partial<GroupThreadRow> = {}): GroupThreadRow {
  return {
    conversationId: 'gt-1',
    memberCount: 3,
    lastActivityAt: '2026-06-17T10:00:00.000Z',
    otherMemberNames: ['Ann Tenant', 'Marcus Landlord'],
    ...over,
  };
}

function renderIt(props: {
  pending: boolean;
  groups: GroupThreadRow[];
  truncated?: boolean;
}): void {
  render(
    <MemoryRouter>
      <GroupThreadsCard {...props} />
    </MemoryRouter>,
  );
}

describe('GroupThreadsCard', () => {
  it('renders its own heading, distinct from the relay card', () => {
    renderIt({ pending: false, groups: [] });
    expect(screen.getByRole('heading', { name: 'Group threads' })).toBeInTheDocument();
  });

  it('lists each thread with its member count, linking to the thread view', () => {
    renderIt({ pending: false, groups: [mkGroup()] });
    const link = screen.getByRole('link', { name: /With Ann Tenant & Marcus Landlord/ });
    expect(link).toHaveAttribute('href', '/conversations/gt-1');
    expect(screen.getByText('3 members')).toBeInTheDocument();
  });

  it('singularizes a one-member count', () => {
    renderIt({ pending: false, groups: [mkGroup({ memberCount: 1 })] });
    expect(screen.getByText('1 member')).toBeInTheDocument();
  });

  it('shows the empty state when the contact is in no group texts', () => {
    renderIt({ pending: false, groups: [] });
    expect(screen.getByText('No group texts yet.')).toBeInTheDocument();
  });

  it('shows the pending panel before the slice resolves', () => {
    renderIt({ pending: true, groups: [] });
    expect(screen.queryByText('No group texts yet.')).toBeNull();
  });

  it('SURFACES a truncated read instead of implying the list is complete', () => {
    renderIt({ pending: false, groups: [mkGroup()], truncated: true });
    expect(screen.getByText(/older ones may be missing/)).toBeInTheDocument();
  });

  it('shows no truncation note on a complete read', () => {
    renderIt({ pending: false, groups: [mkGroup()], truncated: false });
    expect(screen.queryByText(/older ones may be missing/)).toBeNull();
  });
});

describe('groupThreadCardLabel / groupThreadLink', () => {
  it('names the OTHER members', () => {
    expect(groupThreadCardLabel(mkGroup())).toBe('With Ann Tenant & Marcus Landlord');
  });

  it('falls back to a plain label when no other member has a resolved name', () => {
    // Names only, never a phone - the row would otherwise leak a number the
    // relay card deliberately does not show either.
    expect(groupThreadCardLabel(mkGroup({ otherMemberNames: [] }))).toBe('Group text');
  });

  it('links to the conversation, not a contact', () => {
    expect(groupThreadLink(mkGroup())).toBe('/conversations/gt-1');
  });
});
