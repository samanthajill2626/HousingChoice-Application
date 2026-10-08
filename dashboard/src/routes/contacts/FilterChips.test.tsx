import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChipGroup } from './FilterChips.js';

const OPTIONS = [
  { key: 'hope atlanta', label: 'Hope Atlanta', count: 2 },
  { key: 'step up', label: 'Step Up', count: 0 },
  { key: '__none__', label: 'Not recorded', count: 1 },
];

describe('FilterChips - ChipGroup', () => {
  it('names the group by its label and each chip by label and count', () => {
    render(
      <ChipGroup label="Organization" emptyLine={null} options={OPTIONS} selected={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />,
    );
    const group = screen.getByRole('group', { name: 'Organization' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Hope Atlanta (2)',
      'Step Up (0)',
      'Not recorded (1)',
    ]);
    // No Clear until something is selected.
    expect(within(group).queryByRole('button', { name: 'Clear organization filter' })).toBeNull();
  });

  it('toggles by key, keeps an unselected zero-count chip inert, and offers Clear once selected', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onClear = vi.fn();
    render(
      <ChipGroup
        label="Organization"
        emptyLine={null}
        options={OPTIONS}
        selected={new Set(['hope atlanta'])}
        onToggle={onToggle}
        onClear={onClear}
      />,
    );
    expect(screen.getByRole('button', { name: 'Hope Atlanta (2)' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Hope Atlanta (2)' }));
    expect(onToggle).toHaveBeenCalledWith('hope atlanta');
    const inert = screen.getByRole('button', { name: 'Step Up (0)' });
    expect(inert).toHaveAttribute('aria-disabled', 'true');
    await user.click(inert);
    expect(onToggle).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Clear organization filter' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('renders the empty line instead of chips', () => {
    render(
      <ChipGroup
        label="Organization"
        emptyLine="No organizations recorded yet"
        options={[]}
        selected={new Set()}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const group = screen.getByRole('group', { name: 'Organization' });
    expect(within(group).getByText('No organizations recorded yet')).toBeInTheDocument();
    expect(within(group).queryAllByRole('button')).toHaveLength(0);
  });
});
