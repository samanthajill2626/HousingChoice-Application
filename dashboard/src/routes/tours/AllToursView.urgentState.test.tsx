// The All tab's filters must never wait for the router (spec
// docs/superpowers/specs/2026-10-06-tour-list-design.md 4.7, #1's model).
// react-router 7 applies every URL change inside a transition, so a control
// that READ the URL would lag the event that changed it - a second tap before
// the first committed would drop the first. This suite freezes the URL
// outright, as ListingsList.urgentState.test.tsx does: `useSearchParams`
// reports an empty query forever and only RECORDS writes. If the filters are
// urgent local state, every control still responds at once and each write
// carries every earlier choice; a URL-driven control would sit unchanged and
// the last write would hold only the last tap.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const writes: string[] = [];

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  const frozen = new URLSearchParams('');
  return {
    ...actual,
    useSearchParams: () => [frozen, (next: URLSearchParams) => void writes.push(next.toString())],
  };
});

// The first page never answers: these cases are about the controls alone.
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, listTours: () => new Promise(() => undefined) };
});

import { AllToursView } from './AllToursView.js';

function renderView(): void {
  render(
    <MemoryRouter initialEntries={['/tours/all']}>
      <AllToursView />
    </MemoryRouter>,
  );
}

const chip = (name: string): HTMLElement =>
  within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name });

beforeEach(() => {
  writes.length = 0;
});

describe('AllToursView filters do not wait for the router', () => {
  it('two chip taps both apply at once, and the second write carries both', () => {
    renderView();
    fireEvent.click(chip('Scheduled'));
    fireEvent.click(chip('Toured'));
    expect(chip('Scheduled')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('Toured')).toHaveAttribute('aria-pressed', 'true');
    expect(writes).toEqual(['status=scheduled', 'status=scheduled%2Ctoured']);
  });

  it('a chip write carries search text the box never saved', () => {
    renderView();
    // fireEvent moves no focus, so the box never blurs: only the chip writes.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'Smith' } });
    fireEvent.click(chip('Toured'));
    expect(writes).toEqual(['status=toured&q=Smith']);
  });
});
