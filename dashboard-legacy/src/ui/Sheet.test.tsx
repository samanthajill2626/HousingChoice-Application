// Sheet primitive tests — focus on L2: the open dialog traps Tab focus
// (cycling first↔last) and Escape still closes. Rendered into a portal on
// document.body, which Testing Library queries by default.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from './Sheet.js';

function renderSheet(onClose = vi.fn()): { onClose: ReturnType<typeof vi.fn> } {
  render(
    <Sheet open onClose={onClose} title="Test sheet">
      <button type="button">First</button>
      <button type="button">Last</button>
    </Sheet>,
  );
  return { onClose };
}

describe('<Sheet> focus trap (L2)', () => {
  it('wraps Tab from the last focusable back to the first', () => {
    renderSheet();
    const first = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'Last' });

    last.focus();
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(document, { key: 'Tab' });
    // Cycled back to the first focusable (the Close button leads the panel).
    expect(document.activeElement).toBe(first);
  });

  it('wraps Shift+Tab from the first focusable to the last', () => {
    renderSheet();
    const first = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'Last' });

    first.focus();
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('still closes on Escape', () => {
    const { onClose } = renderSheet();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
