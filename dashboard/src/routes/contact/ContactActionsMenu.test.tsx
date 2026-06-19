import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ContactActionsMenu } from './ContactActionsMenu.js';

function setup(props: Partial<React.ComponentProps<typeof ContactActionsMenu>> = {}) {
  const onEdit = props.onEdit ?? vi.fn();
  const onToggleOptOut = props.onToggleOptOut ?? vi.fn();
  const onDelete = props.onDelete ?? vi.fn();
  const onRestore = props.onRestore ?? vi.fn();
  render(
    <ContactActionsMenu
      onEdit={onEdit}
      optedOut={props.optedOut ?? false}
      onToggleOptOut={onToggleOptOut}
      deleted={props.deleted ?? false}
      onDelete={onDelete}
      onRestore={onRestore}
      {...(props.optOutBusy !== undefined && { optOutBusy: props.optOutBusy })}
      {...(props.deleteBusy !== undefined && { deleteBusy: props.deleteBusy })}
    />,
  );
  return { onEdit, onToggleOptOut, onDelete, onRestore };
}

describe('ContactActionsMenu', () => {
  it('opens on click and lists Edit / Copy link / opt-out', async () => {
    const user = userEvent.setup();
    setup();
    // Closed: no menu items visible.
    expect(screen.queryByRole('menuitem', { name: /Edit contact details/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.getByRole('menuitem', { name: /Edit contact details/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Copy link to contact/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Mark Do-Not-Contact/i })).toBeInTheDocument();
  });

  it('Edit calls onEdit and closes the menu', async () => {
    const user = userEvent.setup();
    const { onEdit } = setup();
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Edit contact details/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menuitem', { name: /Edit contact details/i })).toBeNull();
  });

  it('reflects the opt-out state in the toggle label and fires onToggleOptOut', async () => {
    const user = userEvent.setup();
    const { onToggleOptOut } = setup({ optedOut: true });
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    // Already opted out → the action offers to RE-enable SMS.
    const item = screen.getByRole('menuitem', { name: /Allow SMS \(clear opt-out\)/i });
    await user.click(item);
    expect(onToggleOptOut).toHaveBeenCalledTimes(1);
  });

  it('disables the opt-out item while a request is in flight', async () => {
    const user = userEvent.setup();
    setup({ optOutBusy: true });
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.getByRole('menuitem', { name: /Mark Do-Not-Contact/i })).toBeDisabled();
  });

  it('shows Delete (not Restore) for a live contact and fires onDelete', async () => {
    const user = userEvent.setup();
    const { onDelete } = setup();
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.queryByRole('menuitem', { name: /Restore contact/i })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: /Delete contact/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('shows Restore (not Delete) for a deleted contact and fires onRestore', async () => {
    const user = userEvent.setup();
    const { onRestore } = setup({ deleted: true });
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.queryByRole('menuitem', { name: /Delete contact/i })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: /Restore contact/i }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('disables the delete/restore item while a request is in flight', async () => {
    const user = userEvent.setup();
    setup({ deleteBusy: true });
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.getByRole('menuitem', { name: /Delete contact/i })).toBeDisabled();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
