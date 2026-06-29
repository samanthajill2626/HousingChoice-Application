import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ListingActionsMenu } from './ListingActionsMenu.js';

function setup(props: Partial<React.ComponentProps<typeof ListingActionsMenu>> = {}) {
  const onDelete = props.onDelete ?? vi.fn();
  const onRestore = props.onRestore ?? vi.fn();
  const onEdit = props.onEdit ?? vi.fn();
  render(
    <ListingActionsMenu
      triggerClassName="kebab"
      deleted={props.deleted ?? false}
      onDelete={onDelete}
      onRestore={onRestore}
      {...('onEdit' in props ? { onEdit: props.onEdit } : { onEdit })}
      {...(props.deleteBusy !== undefined && { deleteBusy: props.deleteBusy })}
    />,
  );
  return { onDelete, onRestore, onEdit };
}

describe('ListingActionsMenu', () => {
  it('shows Delete (not Restore) for a live property and fires onDelete', async () => {
    const user = userEvent.setup();
    const { onDelete } = setup();
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.queryByRole('menuitem', { name: /Restore property/i })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: /Delete property/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('shows Restore (not Delete) for a deleted property and fires onRestore', async () => {
    const user = userEvent.setup();
    const { onRestore } = setup({ deleted: true });
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.queryByRole('menuitem', { name: /Delete property/i })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: /Restore property/i }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('shows Edit property and fires onEdit (when onEdit is provided)', async () => {
    const user = userEvent.setup();
    const { onEdit } = setup();
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Edit property/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('omits Edit property when onEdit is not provided (e.g. a deleted property)', async () => {
    const user = userEvent.setup();
    setup({ onEdit: undefined, deleted: true });
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.queryByRole('menuitem', { name: /Edit property/i })).toBeNull();
  });

  it('disables the delete/restore item while a request is in flight', async () => {
    const user = userEvent.setup();
    setup({ deleteBusy: true });
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.getByRole('menuitem', { name: /Delete property/i })).toBeDisabled();
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
