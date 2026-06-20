import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MovePromptModal, parseFinalRent } from './MovePromptModal.js';

afterEach(() => vi.restoreAllMocks());

describe('parseFinalRent', () => {
  it('rejects ≤0, NaN, and empty; accepts positive', () => {
    expect(parseFinalRent('')).toBeNull();
    expect(parseFinalRent('0')).toBeNull();
    expect(parseFinalRent('-5')).toBeNull();
    expect(parseFinalRent('abc')).toBeNull();
    expect(parseFinalRent('1550')).toBe(1550);
  });
});

describe('MovePromptModal (finalRent)', () => {
  it('keeps confirm disabled until a positive rent is entered, then confirms with it', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<MovePromptModal mode="finalRent" onClose={() => {}} onConfirm={onConfirm} />);

    const confirm = screen.getByRole('button', { name: 'Confirm move' });
    expect(confirm).toBeDisabled();

    const input = screen.getByLabelText(/Final contract rent/i);
    await user.type(input, '0');
    expect(confirm).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/greater than 0/i);

    await user.clear(input);
    await user.type(input, '1550');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ finalRent: 1550 });
  });
});

describe('MovePromptModal (inspectionOutcome)', () => {
  it('requires an outcome pick, then confirms with it', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<MovePromptModal mode="inspectionOutcome" onClose={() => {}} onConfirm={onConfirm} />);

    const confirm = screen.getByRole('button', { name: 'Confirm move' });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: 'Pass' }));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ inspectionOutcome: 'pass' });
  });
});
