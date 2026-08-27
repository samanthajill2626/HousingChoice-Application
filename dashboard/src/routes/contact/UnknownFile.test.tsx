import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { UnknownFile } from './UnknownFile.js';
import type { SuggestedContactKind } from './contactProfile.js';
import type { Contact, GroupThreadRow, SuggestionItem } from '../../api/index.js';

const UNKNOWN: Contact = {
  contactId: 'u9',
  type: 'unknown',
  status: 'needs_review',
  phone: '+15550100001',
};

function typeSuggestion(suggestedValue: string): SuggestionItem {
  return {
    itemId: 'sugg#u9#type', ownerContactId: 'u9', target: 'type', suggestedValue,
    reason: 'stated role', conversationId: 'conv-1', createdAt: '2026-08-26T10:00:00.000Z',
  };
}

function renderIt(opts: {
  suggestions?: SuggestionItem[];
  groupThreads?: GroupThreadRow[];
  onTriage?: (kind: SuggestedContactKind) => void;
  triaging?: boolean;
} = {}): void {
  render(
    <MemoryRouter>
      <UnknownFile
        contact={UNKNOWN}
        phones={[{ phone: '+15550100001', primary: true }]}
        placements={[]}
        units={[]}
        media={[]}
        suggestions={opts.suggestions ?? []}
        onTriage={opts.onTriage ?? vi.fn()}
        triaging={opts.triaging}
        groupThreadsPending={false}
        groupThreads={opts.groupThreads ?? []}
        groupThreadsTruncated={false}
      />
    </MemoryRouter>,
  );
}

describe('UnknownFile AI type recommendation', () => {
  it('shows an "AI suggests: Tenant - <reason>" line when a type suggestion exists', () => {
    renderIt({ suggestions: [
      {
        itemId: 'sugg#u9#type',
        ownerContactId: 'u9',
        target: 'type',
        suggestedValue: 'tenant',
        reason: 'looking for a home',
        conversationId: 'conv-1',
        createdAt: '2026-07-16T10:00:00.000Z',
      },
    ] });
    expect(screen.getByText(/AI suggests:\s*Tenant/i)).toBeInTheDocument();
    expect(screen.getByText(/looking for a home/i)).toBeInTheDocument();
    // The Mark-as buttons remain the action.
    expect(screen.getByRole('button', { name: /Mark as Tenant/i })).toBeEnabled();
  });

  it('shows no AI line when there is no type suggestion', () => {
    renderIt();
    expect(screen.queryByText(/AI suggests:/i)).not.toBeInTheDocument();
  });
});

describe('UnknownFile classification actions', () => {
  it.each([
    ['partner', 'Partner'],
    ['property_manager', 'Property Manager'],
  ] as const)('shows the exact %s suggestion label', (value, label) => {
    renderIt({ suggestions: [typeSuggestion(value)] });
    expect(screen.getByText(`AI suggests: ${label} - stated role`)).toBeInTheDocument();
  });

  it('renders four actions in KindPicker order and reports canonical kinds', async () => {
    const onTriage = vi.fn();
    const user = userEvent.setup();
    renderIt({ onTriage });
    const buttons = screen.getAllByRole('button').filter((button) => button.textContent?.startsWith('Mark as '));
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Mark as Tenant', 'Mark as Landlord', 'Mark as Partner', 'Mark as Property Manager',
    ]);
    await user.click(screen.getByRole('button', { name: 'Mark as Partner' }));
    await user.click(screen.getByRole('button', { name: 'Mark as Property Manager' }));
    expect(onTriage).toHaveBeenNthCalledWith(1, 'partner');
    expect(onTriage).toHaveBeenNthCalledWith(2, 'property_manager');
  });

  it('disables all four actions during one in-flight classification', () => {
    renderIt({ triaging: true });
    for (const name of ['Mark as Tenant', 'Mark as Landlord', 'Mark as Partner', 'Mark as Property Manager']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });
});

// C13 / conformance F13. `unknown` + `needs_review` is EXACTLY the state every
// detection-minted group member stub is in (app/src/services/groupMembers.ts),
// and useContactFile already pays for the /group-threads read on every contact -
// so this was the one page most likely to need the card and the one page that
// did not have it.
describe('UnknownFile group threads', () => {
  it('shows the Group threads card - a detected group member starts life untriaged', () => {
    renderIt({ groupThreads: [
      {
        conversationId: 'gt-1',
        memberCount: 3,
        lastActivityAt: '2026-06-17T10:00:00.000Z',
        title: 'With Ann & Marcus',
        otherMemberNames: ['Ann Tenant', 'Marcus Landlord'],
      },
    ] });
    expect(screen.getByRole('heading', { name: 'Group threads' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /With Ann & Marcus/ })).toHaveAttribute(
      'href',
      '/conversations/gt-1',
    );
  });

  it('shows the card empty rather than hiding it when they are in no group texts', () => {
    renderIt();
    expect(screen.getByRole('heading', { name: 'Group threads' })).toBeInTheDocument();
    expect(screen.getByText('No group texts yet.')).toBeInTheDocument();
  });
});
