// StatusMenu component tests — the interactive status pill shared by the
// property / placement / contact headers. Locks in:
//   - menu-button semantics (aria-expanded, aria-label "<label>: <current>",
//     menuitemradio + aria-checked on exactly the current item)
//   - selection behavior (onChange once for a NEW value, never for the current)
//   - dismissal (Escape, outside mousedown; an item mousedown must NOT dismiss)
//   - the error/menu overlap rule (never both at once — they share the anchor slot)
//   - grouped mode (role=group per section)
//   - disabled blocks opening
//   - APG keyboard pattern (focus into menu on open, arrow roving with wrap,
//     Enter selects, focus returns to the trigger)
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StatusMenu, type StatusMenuGroup } from './StatusMenu.js';

const OPTIONS = [
  { value: 'setup', label: 'Setup' },
  { value: 'available', label: 'Available' },
  { value: 'on_hold', label: 'On hold' },
];

function renderMenu(over: Partial<React.ComponentProps<typeof StatusMenu>> = {}) {
  const onChange = vi.fn();
  render(
    <StatusMenu
      value="available"
      options={OPTIONS}
      onChange={onChange}
      tone="available"
      label="Property status"
      {...over}
    />,
  );
  return { onChange };
}

const trigger = (): HTMLElement => screen.getByRole('button', { name: /Property status/ });

describe('StatusMenu', () => {
  it('re-selecting the current value closes without calling onChange', async () => {
    const user = userEvent.setup();
    const { onChange } = renderMenu();
    await user.click(trigger());
    await user.click(screen.getByRole('menuitemradio', { name: 'Available' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('selecting a different value calls onChange exactly once and closes', async () => {
    const user = userEvent.setup();
    const { onChange } = renderMenu();
    await user.click(trigger());
    await user.click(screen.getByRole('menuitemradio', { name: 'On hold' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('on_hold');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Escape and outside mousedown close; a mousedown INSIDE the menu does not', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(trigger());
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(trigger());
    // Inside mousedown (on an item) must not dismiss-without-selecting.
    fireEvent.mouseDown(screen.getByRole('menuitemradio', { name: 'Setup' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // Outside mousedown dismisses.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('exposes menu-button semantics: aria-expanded, name "<label>: <current>", one checked item', async () => {
    const user = userEvent.setup();
    renderMenu();
    const btn = screen.getByRole('button', { name: 'Property status: Available' });
    expect(btn).toHaveAttribute('aria-haspopup', 'menu');
    expect(btn).toHaveAttribute('aria-expanded', 'false');

    await user.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    const items = screen.getAllByRole('menuitemradio');
    expect(items).toHaveLength(3);
    expect(items.filter((el) => el.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(screen.getByRole('menuitemradio', { name: 'Available' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('grouped mode renders one role=group per section', async () => {
    const user = userEvent.setup();
    const groups: StatusMenuGroup[] = [
      { label: 'Application', options: [{ value: 'a1', label: 'Send application' }] },
      { label: 'Closure', options: [{ value: 'available', label: 'Available' }, { value: 'c2', label: 'Lost' }] },
    ];
    renderMenu({ groups, options: undefined });
    await user.click(trigger());
    expect(screen.getByRole('group', { name: 'Application' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Closure' })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3);
  });

  it('renders the error as role=alert, but NEVER while the menu is open (shared anchor slot)', async () => {
    const user = userEvent.setup();
    renderMenu({ error: 'Transition rejected' });
    expect(screen.getByRole('alert')).toHaveTextContent('Transition rejected');

    await user.click(trigger());
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('disabled blocks opening', async () => {
    const user = userEvent.setup();
    renderMenu({ disabled: true });
    expect(trigger()).toBeDisabled();
    await user.click(trigger()).catch(() => {
      /* user-event refuses to click disabled controls in some versions */
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keyboard: open focuses the checked item; arrows rove with wrap; Enter selects and refocuses the trigger', async () => {
    const user = userEvent.setup();
    const { onChange } = renderMenu();
    trigger().focus();
    await user.keyboard('{ArrowDown}'); // opens
    // Focus landed on the CHECKED item (Available, index 1).
    expect(screen.getByRole('menuitemradio', { name: 'Available' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: 'On hold' })).toHaveFocus();
    await user.keyboard('{ArrowDown}'); // wraps to the first
    expect(screen.getByRole('menuitemradio', { name: 'Setup' })).toHaveFocus();
    await user.keyboard('{ArrowUp}'); // wraps back to the last
    expect(screen.getByRole('menuitemradio', { name: 'On hold' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitemradio', { name: 'Setup' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('menuitemradio', { name: 'On hold' })).toHaveFocus();

    await user.keyboard('{Enter}'); // select the focused item
    expect(onChange).toHaveBeenCalledWith('on_hold');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('Escape returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    expect(screen.getByRole('menuitemradio', { name: 'Available' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(trigger()).toHaveFocus();
  });

  // The placement stage ladder is 18 items in 7 phase groups — ~880px tall. With
  // no cap the menu ran off the bottom of the window and grew its scroll
  // container, so the page sprouted a second scrollbar (worse on a phone, where
  // the menu was TALLER than the viewport). The menu must bound itself to the
  // room actually below the trigger and scroll internally instead.
  describe('viewport clamping', () => {
    /** Open with the trigger's rect and the window height under our control, and
     *  hand back the inline max-height the component computed. jsdom reports 0 for
     *  every rect, so the geometry has to be faked to test the arithmetic. */
    async function openWithGeometry(triggerBottom: number, innerHeight: number): Promise<string> {
      const user = userEvent.setup();
      const spy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({
          top: triggerBottom - 20,
          bottom: triggerBottom,
          left: 0,
          right: 100,
          width: 100,
          height: 20,
          x: 0,
          y: triggerBottom - 20,
          toJSON: () => ({}),
        } as DOMRect);
      const original = window.innerHeight;
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
      try {
        renderMenu();
        await user.click(trigger());
        return screen.getByRole('menu').style.maxHeight;
      } finally {
        spy.mockRestore();
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: original });
      }
    }

    it('caps the menu to the space below the trigger', async () => {
      // Trigger sits 500px down a 700px window => ~188px of room under it once the
      // bottom gutter is taken off. Well under the design cap, so the room wins.
      const maxHeight = await openWithGeometry(500, 700);
      expect(maxHeight).not.toBe('');
      expect(parseFloat(maxHeight)).toBeLessThanOrEqual(700 - 500);
    });

    it('never collapses to an unusably short menu when the trigger is near the bottom', async () => {
      // Trigger 30px off the bottom: clamping alone would leave a few pixels, so a
      // floor keeps enough rows visible to be worth opening (it scrolls inside).
      const maxHeight = await openWithGeometry(670, 700);
      expect(parseFloat(maxHeight)).toBeGreaterThanOrEqual(180);
    });

    // Capping the menu made it scrollable, which introduced a new way to be
    // unhelpful: the placement ladder's current stage sits ~11 items down, so the
    // menu opened showing the TOP of the list with the checked item scrolled out
    // of sight. You open "Move to" precisely to move off the current stage, so it
    // has to be the thing you see.
    it('scrolls the checked item into view on open', async () => {
      const user = userEvent.setup();
      // setup.ts stubs scrollIntoView (jsdom has none); spy on that stub so the
      // spy composes with it instead of replacing and deleting it.
      const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
      try {
        renderMenu();
        await user.click(trigger());
        const checked = screen.getByRole('menuitemradio', { name: 'Available' });
        expect(checked).toHaveFocus();
        expect(scrollIntoView).toHaveBeenCalled();
        // It is the CHECKED item that gets revealed, not just any menu row.
        expect(scrollIntoView.mock.instances).toContain(checked);
      } finally {
        scrollIntoView.mockRestore();
      }
    });

    it('does not exceed the design cap on a tall window', async () => {
      // Lots of room below => the design cap (min(60vh, 480px)) is what binds, so
      // the menu never becomes a full-height wall of options.
      const maxHeight = await openWithGeometry(100, 2000);
      expect(parseFloat(maxHeight)).toBeLessThanOrEqual(480);
    });
  });
});
