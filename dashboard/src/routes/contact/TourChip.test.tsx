import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TourChip } from './Card.js';

function renderChip(state: 'requested' | 'scheduled' | 'toured', tourId = 'tour-9'): void {
  render(
    <MemoryRouter>
      <TourChip tourId={tourId} state={state} />
    </MemoryRouter>,
  );
}

describe('TourChip', () => {
  it('renders "Tour requested" as a link to the tour', () => {
    renderChip('requested', 'tour-req');
    const link = screen.getByRole('link', { name: 'Tour requested' });
    expect(link).toHaveAttribute('href', '/tours/tour-req');
  });

  it('renders "Tour scheduled" as a link to the tour', () => {
    renderChip('scheduled', 'tour-sch');
    const link = screen.getByRole('link', { name: 'Tour scheduled' });
    expect(link).toHaveAttribute('href', '/tours/tour-sch');
  });

  it('renders "Toured" as a link to the tour', () => {
    renderChip('toured', 'tour-done');
    const link = screen.getByRole('link', { name: 'Toured' });
    expect(link).toHaveAttribute('href', '/tours/tour-done');
  });
});
