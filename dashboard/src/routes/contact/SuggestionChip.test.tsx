import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { SuggestionItem } from '../../api/index.js';
import { AutoBadge, formatSourceDate } from './AutoBadge.js';
import { SuggestionChip } from './SuggestionChip.js';

const SUGGESTION: SuggestionItem = {
  itemId: 'sugg#k1#voucherSize',
  ownerContactId: 'k1',
  target: 'voucherSize',
  currentValue: '2',
  suggestedValue: '3',
  reason: 'said a 3 bedroom',
  conversationId: 'conv-1',
  createdAt: '2026-07-16T10:00:00.000Z',
};

/** The chip carries a react-router <Link> (View conversation), so every render
 *  needs a Router context. */
function renderChip(ui: React.JSX.Element) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('AutoBadge', () => {
  it('renders the accessible name "Auto" and an extracted-from tooltip', () => {
    render(<AutoBadge at="2026-07-16T10:00:00.000Z" />);
    const badge = screen.getByRole('img', { name: 'Auto' });
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', expect.stringMatching(/^Extracted from a conversation on /));
  });
});

describe('SuggestionChip', () => {
  it('renders as a labelled group with the heard value, date, and Accept/Dismiss buttons', async () => {
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    renderChip(
      <SuggestionChip
        label="voucher size"
        suggestion={SUGGESTION}
        onAccept={onAccept}
        onDismiss={onDismiss}
      />,
    );
    const group = screen.getByRole('group', { name: 'AI suggestion for voucher size' });
    // `AI heard "3"` stays its OWN text node (exact match survives the added date).
    expect(within(group).getByText('AI heard "3"')).toBeInTheDocument();
    // The date rides a sibling span, same short style as the AutoBadge tooltip.
    expect(within(group).getByText(`(${formatSourceDate(SUGGESTION.createdAt)})`)).toBeInTheDocument();

    await userEvent.click(within(group).getByRole('button', { name: 'Accept' }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    await userEvent.click(within(group).getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('links View conversation to the suggestion conversation route', () => {
    renderChip(
      <SuggestionChip
        label="voucher size"
        suggestion={SUGGESTION}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const group = screen.getByRole('group', { name: 'AI suggestion for voucher size' });
    expect(within(group).getByRole('link', { name: 'View conversation' })).toHaveAttribute(
      'href',
      '/conversations/conv-1',
    );
  });

  it('surfaces an inline error on the chip', () => {
    renderChip(
      <SuggestionChip
        label="phone"
        suggestion={{ ...SUGGESTION, target: 'phone', suggestedValue: '+14045550123' }}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        error="That number already belongs to another contact."
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/already belongs to another contact/i);
  });

  it('disables the actions while busy', () => {
    renderChip(
      <SuggestionChip
        label="status"
        suggestion={{ ...SUGGESTION, target: 'status', suggestedValue: 'searching' }}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        busy
      />,
    );
    const group = screen.getByRole('group', { name: 'AI suggestion for status' });
    expect(within(group).getByText('AI heard "searching"')).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Accept' })).toBeDisabled();
    expect(within(group).getByRole('button', { name: 'Dismiss' })).toBeDisabled();
  });
});
