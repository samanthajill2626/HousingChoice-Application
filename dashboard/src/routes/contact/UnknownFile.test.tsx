import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { UnknownFile } from './UnknownFile.js';
import type { Contact, SuggestionItem } from '../../api/index.js';

const UNKNOWN: Contact = {
  contactId: 'u9',
  type: 'unknown',
  status: 'needs_review',
  phone: '+15550100001',
};

function renderIt(suggestions: SuggestionItem[] = []): void {
  render(
    <MemoryRouter>
      <UnknownFile
        contact={UNKNOWN}
        phones={[{ phone: '+15550100001', primary: true }]}
        placements={[]}
        units={[]}
        media={[]}
        suggestions={suggestions}
        onTriage={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('UnknownFile AI type recommendation', () => {
  it('shows an "AI suggests: Tenant - <reason>" line when a type suggestion exists', () => {
    renderIt([
      {
        itemId: 'sugg#u9#type',
        ownerContactId: 'u9',
        target: 'type',
        suggestedValue: 'tenant',
        reason: 'looking for a home',
        conversationId: 'conv-1',
        createdAt: '2026-07-16T10:00:00.000Z',
      },
    ]);
    expect(screen.getByText(/AI suggests:\s*Tenant/i)).toBeInTheDocument();
    expect(screen.getByText(/looking for a home/i)).toBeInTheDocument();
    // The Mark-as buttons remain the action.
    expect(screen.getByRole('button', { name: /Mark as Tenant/i })).toBeEnabled();
  });

  it('shows no AI line when there is no type suggestion', () => {
    renderIt([]);
    expect(screen.queryByText(/AI suggests:/i)).not.toBeInTheDocument();
  });
});
