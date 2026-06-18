import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CustomFieldsCard } from './CustomFieldsCard.js';
import type { CustomField } from '../../api/index.js';

function renderCard(customFields: CustomField[] | undefined, onEdit?: () => void) {
  return render(<CustomFieldsCard customFields={customFields} onEdit={onEdit} />);
}

describe('CustomFieldsCard', () => {
  it('renders label→value rows for custom fields', () => {
    const fields: CustomField[] = [
      { label: 'Case number', value: 'HA-2026-001' },
      { label: 'Priority', value: 'High' },
    ];
    renderCard(fields, () => {});
    expect(screen.getByText('Case number')).toBeInTheDocument();
    expect(screen.getByText('HA-2026-001')).toBeInTheDocument();
    expect(screen.getByText('Priority')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
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
    expect(screen.getByText('Custom fields')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
  });

  it('renders the card title "Custom fields"', () => {
    const fields: CustomField[] = [{ label: 'Ref', value: '123' }];
    renderCard(fields, () => {});
    expect(screen.getByText('Custom fields')).toBeInTheDocument();
  });
});
