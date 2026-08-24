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

describe('MovePromptModal (prefill from recorded value)', () => {
  it('prefills finalRent so the move confirms without re-entry', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <MovePromptModal
        mode="finalRent"
        initial={{ finalRent: 1875 }}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByLabelText('Final contract rent (monthly)')).toHaveValue(1875);
    await user.click(screen.getByRole('button', { name: 'Confirm move' }));
    expect(onConfirm).toHaveBeenCalledWith({ finalRent: 1875 });
  });

  it('prefills the determined rent and the inspection date', () => {
    render(
      <MovePromptModal
        mode="rentDetermined"
        initial={{ rentDetermined: 1850 }}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByLabelText('Determined rent (monthly)')).toHaveValue(1850);
  });

  it('prefills a recorded inspection outcome', () => {
    render(
      <MovePromptModal
        mode="inspectionOutcome"
        initial={{ inspectionOutcome: 'fail' }}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Fail' })).toBeChecked();
  });
});

describe('MovePromptModal draftStore - typed values survive a remount', () => {
  // The 2026-08-24 e2e gate caught the loss in the wild: the Schedule-inspection
  // dialog's filled date was EMPTY (Confirm disabled) moments after a successful
  // fill - the modal subtree had re-initialized from `initial` while its owner's
  // `pending` state survived. The parent-owned draftStore removes the class:
  // initializers read it first, setters write through, so a remount restores
  // exactly what the human had typed. The exact production remount trigger is
  // load-dependent and unproven, so the test drives the remount DIRECTLY -
  // unmount, re-render with the same store - which is the invariant the fix
  // claims, independent of trigger.
  // See docs/issues/move-prompt-modal-loses-filled-date-under-load.md.
  it('the filled inspection date survives unmount + remount with the same store', async () => {
    const user = userEvent.setup();
    const draftStore: { current: import('./MovePromptModal.js').MovePromptDraft | undefined } = {
      current: undefined,
    };
    const { unmount } = render(
      <MovePromptModal mode="inspectionDate" onClose={() => {}} onConfirm={() => {}} draftStore={draftStore} />,
    );
    await user.type(screen.getByLabelText('Inspection date'), '2026-09-15');
    expect(screen.getByRole('button', { name: 'Confirm move' })).toBeEnabled();

    unmount(); // the load-dependent trigger, driven directly

    const onConfirm = vi.fn();
    render(
      <MovePromptModal mode="inspectionDate" onClose={() => {}} onConfirm={onConfirm} draftStore={draftStore} />,
    );
    expect(screen.getByLabelText('Inspection date')).toHaveValue('2026-09-15');
    const confirm = screen.getByRole('button', { name: 'Confirm move' });
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ inspectionDate: '2026-09-15' });
  });

  it('WITHOUT a store the same remount loses the date - the class the store exists for', async () => {
    // The negative control: proves the survival above comes from the store, not
    // from some other mechanism, and documents what every storeless mount risks.
    const user = userEvent.setup();
    const { unmount } = render(
      <MovePromptModal mode="inspectionDate" onClose={() => {}} onConfirm={() => {}} />,
    );
    await user.type(screen.getByLabelText('Inspection date'), '2026-09-15');
    unmount();
    render(<MovePromptModal mode="inspectionDate" onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.getByLabelText('Inspection date')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Confirm move' })).toBeDisabled();
  });

  it('a draft WINS over the recorded prefill after a remount (the human typed something newer)', async () => {
    const user = userEvent.setup();
    const draftStore: { current: import('./MovePromptModal.js').MovePromptDraft | undefined } = {
      current: undefined,
    };
    const { unmount } = render(
      <MovePromptModal
        mode="inspectionDate"
        onClose={() => {}}
        onConfirm={() => {}}
        initial={{ inspectionDate: '2026-09-01' }}
        draftStore={draftStore}
      />,
    );
    const input = screen.getByLabelText('Inspection date');
    expect(input).toHaveValue('2026-09-01');
    await user.clear(input);
    await user.type(input, '2026-09-20');
    unmount();

    render(
      <MovePromptModal
        mode="inspectionDate"
        onClose={() => {}}
        onConfirm={() => {}}
        initial={{ inspectionDate: '2026-09-01' }}
        draftStore={draftStore}
      />,
    );
    expect(screen.getByLabelText('Inspection date')).toHaveValue('2026-09-20');
  });
});
