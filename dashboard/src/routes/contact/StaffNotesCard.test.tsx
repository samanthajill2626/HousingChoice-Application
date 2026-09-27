// StaffNotesCard - the tenant file's hand-written notes box (spec 3.6).
// Mocks updateContact from the api barrel; asserts accessibility-first.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Contact } from '../../api/index.js';

const updateContact = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, updateContact: (...a: unknown[]) => updateContact(...a) };
});

import { StaffNotesCard, formatLastEdited } from './StaffNotesCard.js';

const CONTACT: Contact = {
  contactId: 'c1',
  type: 'tenant',
  firstName: 'Tasha',
  lastName: 'Nguyen',
  staff_notes: 'Has a service dog',
  staff_notes_updated_at: '2026-09-26T15:00:00.000Z',
};

beforeEach(() => {
  updateContact.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatLastEdited', () => {
  it('formats an ISO instant as a short en-US date', () => {
    // Read back in local time; only the shape is asserted so the test is TZ-safe.
    expect(formatLastEdited('2026-09-26T15:00:00.000Z')).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });
  it('returns an empty string for absent or unparseable input', () => {
    expect(formatLastEdited(undefined)).toBe('');
    expect(formatLastEdited('nope')).toBe('');
  });
});

describe('StaffNotesCard - read mode', () => {
  it('renders the title, the text and the Last edited line, with an Edit affordance', () => {
    render(
      <StaffNotesCard
        contactId="c1"
        value={CONTACT.staff_notes}
        updatedAt={CONTACT.staff_notes_updated_at}
        onContactUpdated={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { name: /Staff notes/ })).toBeInTheDocument();
    expect(screen.getByText('Has a service dog')).toBeInTheDocument();
    expect(screen.getByText(/^Last edited [A-Z][a-z]{2} \d{1,2}, \d{4}$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit staff notes' })).toHaveTextContent('Edit');
    expect(screen.queryByRole('button', { name: 'Add staff notes' })).not.toBeInTheDocument();
  });

  it('renders the empty line and a + Add affordance when there is no text, and no Last edited line even with a stamp', () => {
    render(
      <StaffNotesCard
        contactId="c1"
        value=""
        updatedAt="2026-09-26T15:00:00.000Z"
        onContactUpdated={() => {}}
      />,
    );
    expect(screen.getByText('No staff notes yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add staff notes' })).toHaveTextContent('+ Add');
    expect(screen.queryByText(/Last edited/)).not.toBeInTheDocument();
  });

  it('treats a whitespace-only value as empty', () => {
    render(<StaffNotesCard contactId="c1" value="   " updatedAt={undefined} onContactUpdated={() => {}} />);
    expect(screen.getByText('No staff notes yet.')).toBeInTheDocument();
  });

  it('is read-only without onContactUpdated (no button)', () => {
    render(<StaffNotesCard contactId="c1" value="x" updatedAt={undefined} />);
    expect(screen.getByText('x')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });
});

describe('StaffNotesCard - edit mode', () => {
  it('Edit hides the aside, opens a prefilled focused textarea; Save PATCHes { staff_notes } and hands the returned contact up', async () => {
    const user = userEvent.setup();
    const onContactUpdated = vi.fn();
    const returned: Contact = {
      ...CONTACT,
      staff_notes: 'Has a service dog. Call first.',
      staff_notes_updated_at: '2026-09-27T09:00:00.000Z',
    };
    updateContact.mockResolvedValue(returned);
    render(
      <StaffNotesCard
        contactId="c1"
        value={CONTACT.staff_notes}
        updatedAt={CONTACT.staff_notes_updated_at}
        onContactUpdated={onContactUpdated}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Edit staff notes' }));
    expect(screen.queryByRole('button', { name: 'Edit staff notes' })).not.toBeInTheDocument();
    const box = screen.getByLabelText('Staff notes');
    expect(box).toHaveValue('Has a service dog');
    expect(box).toHaveFocus();
    await user.clear(box);
    await user.type(box, 'Has a service dog. Call first.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onContactUpdated).toHaveBeenCalledWith(returned));
    expect(updateContact).toHaveBeenCalledTimes(1);
    expect(updateContact).toHaveBeenCalledWith('c1', { staff_notes: 'Has a service dog. Call first.' });
    // Back in read mode (the textarea is gone, the aside is back).
    expect(screen.queryByLabelText('Staff notes')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit staff notes' })).toBeInTheDocument();
  });

  it('Cancel discards the draft with no request', async () => {
    const user = userEvent.setup();
    render(<StaffNotesCard contactId="c1" value="keep" updatedAt={undefined} onContactUpdated={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Edit staff notes' }));
    await user.type(screen.getByLabelText('Staff notes'), ' typed');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(updateContact).not.toHaveBeenCalled();
    expect(screen.getByText('keep')).toBeInTheDocument();
    expect(screen.queryByLabelText('Staff notes')).not.toBeInTheDocument();
  });

  it('Save with an unchanged draft sends no request and returns to read mode', async () => {
    const user = userEvent.setup();
    render(<StaffNotesCard contactId="c1" value="same" updatedAt={undefined} onContactUpdated={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Edit staff notes' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updateContact).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Staff notes')).not.toBeInTheDocument();
  });

  it('Save with a draft that differs only by surrounding whitespace sends no request (the server stores it trimmed)', async () => {
    // Worklist OD-2: the server trims every string body value, so sending this
    // draft would store the same text and re-stamp "Last edited" for nothing.
    const user = userEvent.setup();
    render(<StaffNotesCard contactId="c1" value="same" updatedAt={undefined} onContactUpdated={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Edit staff notes' }));
    await user.type(screen.getByLabelText('Staff notes'), '  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updateContact).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Staff notes')).not.toBeInTheDocument();
  });

  it('an untouched Save after the stored value moved under the open editor sends NO request and returns to read mode', async () => {
    // The page swaps the contact in the background (a refetch) while the
    // editor is open: the baseline is the text the editor OPENED with, so a
    // Save with nothing edited must not write that old text over the new one.
    const user = userEvent.setup();
    const { rerender } = render(
      <StaffNotesCard contactId="c1" value="X" updatedAt={undefined} onContactUpdated={() => {}} />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit staff notes' }));
    rerender(<StaffNotesCard contactId="c1" value="Y" updatedAt={undefined} onContactUpdated={() => {}} />);
    expect(screen.getByLabelText('Staff notes')).toHaveValue('X');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updateContact).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Staff notes')).not.toBeInTheDocument();
    expect(screen.getByText('Y')).toBeInTheDocument();
  });

  it('an EDITED draft still saves after the stored value moved under the open editor (last write wins)', async () => {
    const user = userEvent.setup();
    const onContactUpdated = vi.fn();
    updateContact.mockResolvedValue({ ...CONTACT, staff_notes: 'X2' });
    const { rerender } = render(
      <StaffNotesCard contactId="c1" value="X" updatedAt={undefined} onContactUpdated={onContactUpdated} />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit staff notes' }));
    rerender(<StaffNotesCard contactId="c1" value="Y" updatedAt={undefined} onContactUpdated={onContactUpdated} />);
    await user.type(screen.getByLabelText('Staff notes'), '2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onContactUpdated).toHaveBeenCalledTimes(1));
    expect(updateContact).toHaveBeenCalledTimes(1);
    expect(updateContact).toHaveBeenCalledWith('c1', { staff_notes: 'X2' });
  });

  it('while a save is in flight, Save and Cancel are disabled and the textarea is read-only', async () => {
    const user = userEvent.setup();
    let release: ((c: Contact) => void) | undefined;
    updateContact.mockImplementation(
      () =>
        new Promise<Contact>((resolve) => {
          release = resolve;
        }),
    );
    const onContactUpdated = vi.fn();
    render(<StaffNotesCard contactId="c1" value="keep" updatedAt={undefined} onContactUpdated={onContactUpdated} />);
    await user.click(screen.getByRole('button', { name: 'Edit staff notes' }));
    await user.type(screen.getByLabelText('Staff notes'), ' more');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByLabelText('Staff notes')).toHaveAttribute('readonly');

    release!({ ...CONTACT, staff_notes: 'keep more' });
    await waitFor(() => expect(onContactUpdated).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText('Staff notes')).not.toBeInTheDocument();
  });

  it('a failed save keeps the draft, stays in edit mode and shows the fixed alert (no server text)', async () => {
    const user = userEvent.setup();
    updateContact.mockRejectedValue(new ApiError(500, 'boom', 'boom'));
    render(<StaffNotesCard contactId="c1" value={undefined} updatedAt={undefined} onContactUpdated={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Add staff notes' }));
    await user.type(screen.getByLabelText('Staff notes'), 'draft text');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not save staff notes. Try again.');
    expect(alert).not.toHaveTextContent('boom');
    expect(screen.getByLabelText('Staff notes')).toHaveValue('draft text');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
