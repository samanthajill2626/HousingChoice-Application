// VoucherSizePicker - picker B (spec 2026-10-20 D4; plan 1.1 copy, 2.6).
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { VoucherSizePicker, acceptsSummary } from './VoucherSizePicker.js';

function Harness({
  initial = [],
  invalid = [],
  disabled = false,
  spy,
}: {
  initial?: number[];
  invalid?: unknown[];
  disabled?: boolean;
  spy?: (next: number[]) => void;
}): React.JSX.Element {
  const [value, setValue] = useState<number[]>(initial);
  return (
    <VoucherSizePicker
      value={value}
      invalid={invalid}
      disabled={disabled}
      onChange={(next) => {
        spy?.(next);
        setValue(next);
      }}
      labelAside={<span id="outside-tag">On flyer</span>}
      describedBy="outside-tag"
    />
  );
}

const group = (): HTMLElement => screen.getByRole('group', { name: 'Voucher sizes accepted' });
const chip = (name: string): HTMLElement => within(group()).getByRole('button', { name });
const chipNames = (): string[] => within(group()).getAllByRole('button').map((b) => b.textContent ?? '');

describe('VoucherSizePicker', () => {
  it('is a group of toggle buttons named "Voucher sizes accepted": Studio and 1-4 at first, none pressed', () => {
    render(<Harness />);
    expect(chipNames()).toEqual(['Studio', '1', '2', '3', '4']);
    for (const name of chipNames()) expect(chip(name)).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Accepts: none recorded')).toBeInTheDocument();
    // The host's tag and the summary describe the group; the tag is not part of its name.
    expect(group()).toHaveAccessibleDescription('On flyer Accepts: none recorded');
  });

  it('pressing chips toggles them; the list goes out ascending and the summary follows', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    await user.click(chip('3'));
    await user.click(chip('2'));
    expect(spy).toHaveBeenLastCalledWith([2, 3]);
    expect(chip('2')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Accepts: 2 BR, 3 BR')).toBeInTheDocument();
    await user.click(chip('Studio'));
    expect(spy).toHaveBeenLastCalledWith([0, 2, 3]);
    expect(screen.getByText('Accepts: Studio, 2 BR, 3 BR')).toBeInTheDocument();
    await user.click(chip('3'));
    expect(spy).toHaveBeenLastCalledWith([0, 2]);
  });

  it('emptying the picker reports an empty list', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={[2]} spy={spy} />);
    await user.click(chip('2'));
    expect(spy).toHaveBeenLastCalledWith([]);
    expect(screen.getByText('Accepts: none recorded')).toBeInTheDocument();
  });

  it('More sizes (5-12) shows chips 5 through 12; Fewer sizes hides them again while none is selected', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'More sizes (5-12)' }));
    expect(chipNames()).toEqual(['Studio', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    expect(screen.queryByRole('button', { name: 'More sizes (5-12)' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Fewer sizes' }));
    expect(chipNames()).toEqual(['Studio', '1', '2', '3', '4']);
  });

  it('a selected size of 5 or more keeps the larger chips open: no Fewer sizes until it is unselected', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'More sizes (5-12)' }));
    await user.click(chip('6'));
    expect(screen.queryByRole('button', { name: 'Fewer sizes' })).toBeNull();
    await user.click(chip('6'));
    expect(screen.getByRole('button', { name: 'Fewer sizes' })).toBeInTheDocument();
  });

  it('opens the larger chips by itself when a stored size is 5 or more', () => {
    render(<Harness initial={[2, 7]} />);
    expect(chip('7')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('12')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: 'More sizes (5-12)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fewer sizes' })).toBeNull();
    expect(screen.getByText('Accepts: 2 BR, 7 BR')).toBeInTheDocument();
  });

  it('lists stored values it has no chip for as not valid, removed when you save', () => {
    render(<Harness invalid={[2.5, 13]} />);
    expect(screen.getByText('Not a valid size, removed when you save: 2.5, 13')).toBeInTheDocument();
    expect(group()).toHaveAccessibleDescription(
      'On flyer Accepts: none recorded Not a valid size, removed when you save: 2.5, 13',
    );
  });

  it('disabled disables every chip and the More control', () => {
    render(<Harness disabled />);
    for (const name of chipNames()) expect(chip(name)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'More sizes (5-12)' })).toBeDisabled();
  });
});

describe('acceptsSummary', () => {
  it('lists the sizes ascending as Studio / <n> BR, or none recorded', () => {
    expect(acceptsSummary([])).toBe('Accepts: none recorded');
    expect(acceptsSummary([3, 0, 2])).toBe('Accepts: Studio, 2 BR, 3 BR');
  });
});
