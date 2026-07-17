import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the two relay endpoints the dialog drives; ApiError + types stay real.
const closeConversation = vi.fn();
const deferCloseNag = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    closeConversation: (...a: unknown[]) => closeConversation(...a),
    deferCloseNag: (...a: unknown[]) => deferCloseNag(...a),
  };
});

import { RelayCloseAskDialog } from './RelayCloseAskDialog.js';

beforeEach(() => {
  closeConversation.mockReset().mockResolvedValue({});
  deferCloseNag.mockReset().mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

describe('RelayCloseAskDialog', () => {
  it('renders a dialog named for the members with both actions', () => {
    render(<RelayCloseAskDialog conversationId="g1" memberSummary="Ann & Marcus" onDone={vi.fn()} />);
    expect(
      screen.getByRole('dialog', { name: /Also close the group text with Ann & Marcus\?/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close group text' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep it open' })).toBeInTheDocument();
  });

  it('falls back to a generic title when there is no member summary', () => {
    render(<RelayCloseAskDialog conversationId="g1" memberSummary="" onDone={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: /Also close the group text\?/i })).toBeInTheDocument();
  });

  it('Close group text PATCHes closed:true then calls onDone (defer never fires)', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<RelayCloseAskDialog conversationId="g1" memberSummary="Ann" onDone={onDone} />);
    await user.click(screen.getByRole('button', { name: 'Close group text' }));
    expect(closeConversation).toHaveBeenCalledWith('g1', true);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(deferCloseNag).not.toHaveBeenCalled();
  });

  it('Keep it open POSTs the defer then calls onDone (close never fires)', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<RelayCloseAskDialog conversationId="g1" memberSummary="Ann" onDone={onDone} />);
    await user.click(screen.getByRole('button', { name: 'Keep it open' }));
    expect(deferCloseNag).toHaveBeenCalledWith('g1');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(closeConversation).not.toHaveBeenCalled();
  });

  it('on an endpoint failure shows an inline error and stays dismissible (never un-saves the outcome)', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    closeConversation.mockRejectedValue(new Error('boom'));
    render(<RelayCloseAskDialog conversationId="g1" memberSummary="Ann" onDone={onDone} />);
    await user.click(screen.getByRole('button', { name: 'Close group text' }));
    // The failed close surfaces an inline error and does NOT fire onDone (the
    // recorded outcome must not look like it failed).
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
    // ...but the operator can still dismiss it (the outcome was already saved).
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDone).toHaveBeenCalled();
  });
});
