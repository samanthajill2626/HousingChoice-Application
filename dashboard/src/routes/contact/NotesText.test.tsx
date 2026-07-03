// NotesText — full-text notes with the author's newlines preserved, clamped to
// ~6 lines, and a Show more/Show less toggle that appears only when the clamped
// text actually overflows. jsdom has no layout, so overflow is simulated by
// shadowing scrollHeight/clientHeight on HTMLElement.prototype.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { NotesText } from './Card.js';

function mockHeights(scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  });
}

afterEach(() => {
  // Remove the shadowing getters (the originals live on Element.prototype).
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)['scrollHeight'];
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)['clientHeight'];
});

describe('NotesText', () => {
  it('renders the FULL text with newlines preserved (no chip, no toggle when it fits)', () => {
    const text = 'Prefers ground floor.\nHas a cat.\nAvailable weekday mornings.';
    const { container } = render(<NotesText text={text} />);
    // The literal newlines are in the DOM text (pre-wrap renders them as breaks).
    expect(container.querySelector('p')?.textContent).toBe(text);
    // Fits within the clamp (jsdom heights are 0) → no toggle.
    expect(screen.queryByRole('button', { name: /Show more/i })).toBeNull();
  });

  it('shows "Show more" when the clamped text overflows, and expands/collapses', async () => {
    const user = userEvent.setup();
    mockHeights(300, 120); // scrollHeight > clientHeight → overflowing
    render(<NotesText text={'A long note that overflows the six-line clamp.'} />);

    const toggle = screen.getByRole('button', { name: /Show more/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(screen.getByRole('button', { name: /Show less/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    await user.click(screen.getByRole('button', { name: /Show less/i }));
    expect(screen.getByRole('button', { name: /Show more/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});
