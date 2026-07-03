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

describe('MovePromptModal (inspectionDate)', () => {
  it('requires a date, then confirms with it', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<MovePromptModal mode="inspectionDate" onClose={() => {}} onConfirm={onConfirm} />);

    const confirm = screen.getByRole('button', { name: 'Confirm move' });
    expect(confirm).toBeDisabled();

    const input = screen.getByLabelText(/Inspection date/i);
    await user.type(input, '2026-08-15');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ inspectionDate: '2026-08-15' });
  });
});

describe('MovePromptModal (rentDetermined)', () => {
  it('keeps confirm disabled until a positive rent is entered, then confirms with it', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<MovePromptModal mode="rentDetermined" onClose={() => {}} onConfirm={onConfirm} />);

    const confirm = screen.getByRole('button', { name: 'Confirm move' });
    expect(confirm).toBeDisabled();

    const input = screen.getByLabelText(/Determined rent \(monthly\)/i);
    await user.type(input, '0');
    expect(confirm).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/greater than 0/i);

    await user.clear(input);
    await user.type(input, '1450');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ rentDetermined: 1450 });
  });
});

describe('MovePromptModal (moveInReady)', () => {
  it('confirms with no payload', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<MovePromptModal mode="moveInReady" onClose={() => {}} onConfirm={onConfirm} />);

    const confirm = screen.getByRole('button', { name: 'Confirm move' });
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({});
  });

  it('shows the LIF-pending note only when lifPending is true', () => {
    const { rerender } = render(
      <MovePromptModal mode="moveInReady" onClose={() => {}} onConfirm={() => {}} />,
    );
    expect(screen.queryByText(/LIF is not marked/i)).not.toBeInTheDocument();

    rerender(
      <MovePromptModal mode="moveInReady" onClose={() => {}} onConfirm={() => {}} lifPending />,
    );
    expect(screen.getByText(/LIF is not marked/i)).toBeInTheDocument();
  });
});
