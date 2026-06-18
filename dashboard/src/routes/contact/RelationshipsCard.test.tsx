import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { RelationshipsCard } from './RelationshipsCard.js';
import type { Relationship } from '../../api/index.js';

function renderCard(
  relationships: Relationship[] | undefined,
  onEdit?: () => void,
) {
  return render(
    <MemoryRouter>
      <RelationshipsCard relationships={relationships} onEdit={onEdit} />
    </MemoryRouter>,
  );
}

describe('RelationshipsCard', () => {
  it('renders a linked relationship when contactId is present', () => {
    const rel: Relationship = { role: 'Spouse', name: 'Dana Reed', contactId: 'c42' };
    renderCard([rel], () => {});
    const link = screen.getByRole('link', { name: /Dana Reed/ });
    expect(link).toHaveAttribute('href', '/contacts/c42');
    expect(screen.getByText('Spouse')).toBeInTheDocument();
  });

  it('renders the name as plain text (no link) when contactId is absent', () => {
    const rel: Relationship = { role: 'Employer', name: 'Acme Corp' };
    renderCard([rel], () => {});
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Acme Corp/ })).not.toBeInTheDocument();
  });

  it('returns null (renders nothing) when empty with no onEdit', () => {
    const { container } = renderCard([], undefined);
    expect(container.firstChild).toBeNull();
  });

  it('returns null (renders nothing) when undefined with no onEdit', () => {
    const { container } = renderCard(undefined, undefined);
    expect(container.firstChild).toBeNull();
  });

  it('renders an empty card with Edit affordance when empty + onEdit provided', () => {
    renderCard([], () => {});
    expect(screen.getByText('Relationships')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
  });

  it('renders the card title "Relationships"', () => {
    const rel: Relationship = { role: 'Agent', name: 'Bob Smith', contactId: 'c1' };
    renderCard([rel], () => {});
    expect(screen.getByText('Relationships')).toBeInTheDocument();
  });
});
