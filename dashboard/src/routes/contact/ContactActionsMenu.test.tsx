import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ContactActionsMenu } from './ContactActionsMenu.js';

function setup(props: Partial<React.ComponentProps<typeof ContactActionsMenu>> = {}) {
  const onEdit = props.onEdit ?? vi.fn();
  const onToggleOptOut = props.onToggleOptOut ?? vi.fn();
  const onToggleVoiceOptOut = props.onToggleVoiceOptOut ?? vi.fn();
  const onDelete = props.onDelete ?? vi.fn();
  const onRestore = props.onRestore ?? vi.fn();
  const onRunExtraction = props.onRunExtraction ?? vi.fn();
  const onToggleUnread = props.onToggleUnread ?? vi.fn();
  render(
    <ContactActionsMenu
      onEdit={onEdit}
      optedOut={props.optedOut ?? false}
      onToggleOptOut={onToggleOptOut}
      voiceOptedOut={props.voiceOptedOut ?? false}
      onToggleVoiceOptOut={onToggleVoiceOptOut}
      deleted={props.deleted ?? false}
      onDelete={onDelete}
      onRestore={onRestore}
      onRunExtraction={onRunExtraction}
      contactName={props.contactName ?? 'Tasha Williams'}
      hasUnread={props.hasUnread ?? false}
      onToggleUnread={onToggleUnread}
      {...(props.optOutBusy !== undefined && { optOutBusy: props.optOutBusy })}
      {...(props.voiceOptOutBusy !== undefined && { voiceOptOutBusy: props.voiceOptOutBusy })}
      {...(props.deleteBusy !== undefined && { deleteBusy: props.deleteBusy })}
      {...(props.extractionBusy !== undefined && { extractionBusy: props.extractionBusy })}
      {...(props.unreadBusy !== undefined && { unreadBusy: props.unreadBusy })}
    />,
  );
  return {
    onEdit,
    onToggleOptOut,
    onToggleVoiceOptOut,
    onDelete,
    onRestore,
    onRunExtraction,
    onToggleUnread,
  };
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

  it('offers an independent Do-Not-Call (voice_opt_out) toggle and fires it', async () => {
    const user = userEvent.setup();
    const { onToggleVoiceOptOut } = setup();
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    const item = screen.getByRole('menuitem', { name: /Mark Do-Not-Call/i });
    await user.click(item);
    expect(onToggleVoiceOptOut).toHaveBeenCalledTimes(1);
  });

  it('reflects the voice opt-out state (offers to clear it)', async () => {
    const user = userEvent.setup();
    setup({ voiceOptedOut: true });
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    expect(
      screen.getByRole('menuitem', { name: /Allow calls \(clear do-not-call\)/i }),
    ).toBeInTheDocument();
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

  it('fires onRunExtraction and closes the menu', async () => {
    const user = userEvent.setup();
    const { onRunExtraction } = setup();
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Run AI extraction/i }));
    expect(onRunExtraction).toHaveBeenCalledTimes(1);
    // Like every sibling item it calls setOpen(false), so a second query for the
    // item cannot find a stale node.
    expect(screen.queryByRole('menuitem', { name: /Run AI extraction/i })).toBeNull();
  });

  it('disables the extraction item while a run is in flight', async () => {
    const user = userEvent.setup();
    setup({ extractionBusy: true });
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.getByRole('menuitem', { name: /Run AI extraction/i })).toBeDisabled();
  });

  // --- S7: the mark-read / mark-unread toggle (D6) -------------------------
  //
  // It lives HERE and specifically NOT in ContactCommsPane: that pane is shared
  // with the tour and placement 1:1 tabs, so an action added there leaks onto
  // surfaces the spec's non-goal 5 excludes. This menu has exactly one
  // production render site.
  it('offers Mark unread - and NEVER Mark read - on a read contact', async () => {
    const user = userEvent.setup();
    setup({ hasUnread: false });
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    // The "as" is deliberate - it keeps the two accessible names from being
    // substrings of each other for assistive tech and for selectors.
    expect(
      screen.getByRole('menuitem', { name: 'Mark Tasha Williams as unread' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Mark Tasha Williams read' })).toBeNull();
  });

  it('offers Mark read - and NEVER Mark unread - on an unread contact', async () => {
    const user = userEvent.setup();
    setup({ hasUnread: true });
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.getByRole('menuitem', { name: 'Mark Tasha Williams read' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Mark Tasha Williams as unread' })).toBeNull();
  });

  it('fires onToggleUnread and closes the menu', async () => {
    const user = userEvent.setup();
    const { onToggleUnread } = setup();
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    await user.click(screen.getByRole('menuitem', { name: 'Mark Tasha Williams as unread' }));
    expect(onToggleUnread).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menuitem', { name: 'Mark Tasha Williams as unread' })).toBeNull();
  });

  it('disables the unread item while the request is in flight', async () => {
    const user = userEvent.setup();
    setup({ unreadBusy: true });
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.getByRole('menuitem', { name: 'Mark Tasha Williams as unread' })).toBeDisabled();
  });

  it('hides the toggle ENTIRELY for a soft-deleted contact (MU-2)', async () => {
    const user = userEvent.setup();
    setup({ deleted: true });
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    // The server refuses a deleted contact with 409 contact_deleted, so the
    // action would only ever fail. Restore is still offered, which proves the
    // menu rendered at all.
    expect(screen.getByRole('menuitem', { name: /Restore contact/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Mark Tasha Williams as unread' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Mark Tasha Williams read' })).toBeNull();
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
