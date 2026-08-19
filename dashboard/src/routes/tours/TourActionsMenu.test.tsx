// TourActionsMenu component tests - the tour header kebab. Verifies the
// "Send no-show check-in" menu item: it renders (and calls back) only when the
// parent-computed canSendNoShowCheckin guard is true, and is a sibling of the
// other status-branch actions. The click behavior lives in TourDetail (passed in
// as onSendNoShowCheckin) so the trigger can move later.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TourActionsMenu } from './TourActionsMenu.js';

/** Render the menu with every guard OFF by default; the test flips just the ones
 *  it cares about (so a single true guard is enough to render the kebab). */
function renderMenu(over: Partial<React.ComponentProps<typeof TourActionsMenu>> = {}) {
  const props: React.ComponentProps<typeof TourActionsMenu> = {
    canReschedule: false,
    onReschedule: vi.fn(),
    canMarkAlreadyToured: false,
    onMarkAlreadyToured: vi.fn(),
    canCancel: false,
    onCancel: vi.fn(),
    canMarkNoShow: false,
    onMarkNoShow: vi.fn(),
    canOpenGroup: false,
    onOpenGroup: vi.fn(),
    canSendNoShowCheckin: false,
    onSendNoShowCheckin: vi.fn(),
    ...over,
  };
  return { props, ...render(<TourActionsMenu {...props} />) };
}

describe('TourActionsMenu - Send no-show check-in', () => {
  it('shows the item when canSendNoShowCheckin and calls onSendNoShowCheckin once', async () => {
    const onSendNoShowCheckin = vi.fn();
    renderMenu({ canSendNoShowCheckin: true, onSendNoShowCheckin });
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /send no-show check-in/i }));
    expect(onSendNoShowCheckin).toHaveBeenCalledTimes(1);
  });

  it('hides the item when canSendNoShowCheckin is false', async () => {
    // Keep the kebab visible via an unrelated guard so we can inspect the menu.
    renderMenu({ canMarkNoShow: true, canSendNoShowCheckin: false });
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.getByRole('menuitem', { name: /mark no-show/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: /send no-show check-in/i }),
    ).not.toBeInTheDocument();
  });

  it('counts toward the "nothing qualifies" short-circuit (kebab shows for it alone)', () => {
    // Only canSendNoShowCheckin is true -> the kebab must still render (not null).
    renderMenu({ canSendNoShowCheckin: true });
    expect(screen.getByRole('button', { name: /more actions/i })).toBeInTheDocument();
  });
});

describe('TourActionsMenu - Mark already toured', () => {
  it('shows the item when canMarkAlreadyToured and calls back once', async () => {
    const onMarkAlreadyToured = vi.fn();
    renderMenu({ canMarkAlreadyToured: true, onMarkAlreadyToured });
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /mark already toured/i }));
    expect(onMarkAlreadyToured).toHaveBeenCalledTimes(1);
  });

  it('hides the item when canMarkAlreadyToured is false', async () => {
    renderMenu({ canCancel: true, canMarkAlreadyToured: false });
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.getByRole('menuitem', { name: /cancel tour/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: /mark already toured/i }),
    ).not.toBeInTheDocument();
  });

  it('counts toward the "nothing qualifies" short-circuit (kebab shows for it alone)', () => {
    renderMenu({ canMarkAlreadyToured: true });
    expect(screen.getByRole('button', { name: /more actions/i })).toBeInTheDocument();
  });

  it('does NOT collide with the scheduled-tour "Mark no-show" item', async () => {
    // The two are mutually exclusive by status in TourDetail, but the labels are
    // near-neighbours - a name-based selector must not match both.
    renderMenu({ canMarkNoShow: true, canMarkAlreadyToured: false });
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    expect(screen.getByRole('menuitem', { name: /mark no-show/i })).toBeInTheDocument();
  });
});
