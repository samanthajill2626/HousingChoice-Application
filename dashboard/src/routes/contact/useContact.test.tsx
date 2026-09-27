// useContact - the detail page's single-contact hook. Pinned here (review R1
// A-3): setContact is BOUND to the contact id it was handed out for. The page
// re-renders (never remounts) across a contact-to-contact navigation, so a
// caller still holding contact A's setter - a Staff notes save on A whose
// PATCH resolves after the page moved to B - must not replace B's state, or
// the hook derives "loading" for B forever and nothing refetches it.
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../api/index.js';

const getContact = vi.fn();
const updateContact = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContact: (...a: unknown[]) => getContact(...a),
    updateContact: (...a: unknown[]) => updateContact(...a),
  };
});

import { StaffNotesCard } from './StaffNotesCard.js';
import { useContact } from './useContact.js';

const A: Contact = { contactId: 'A', type: 'tenant', firstName: 'Ada', lastName: 'Adams', staff_notes: 'note A' };
const B: Contact = { contactId: 'B', type: 'tenant', firstName: 'Ben', lastName: 'Brown', staff_notes: 'note B' };

/** The detail page's shape: the hook, a spinner while loading, then the
 *  contact with the Staff notes card handed the hook's setContact (as
 *  ContactDetail passes it through TenantFile). */
function Page({ contactId }: { contactId: string }): React.JSX.Element {
  const { status, contact, setContact } = useContact(contactId);
  if (status !== 'ready' || contact === null) return <p role="status">page loading</p>;
  return (
    <>
      <h1>{contact.firstName}</h1>
      <StaffNotesCard
        contactId={contact.contactId}
        value={contact.staff_notes}
        updatedAt={contact.staff_notes_updated_at}
        onContactUpdated={setContact}
      />
    </>
  );
}

beforeEach(() => {
  getContact.mockReset();
  updateContact.mockReset();
  getContact.mockImplementation((id: string) => Promise.resolve(id === 'A' ? A : B));
});

describe('useContact - setContact is bound to its contact', () => {
  it('a STALE setContact for contact A, landing after contact B has loaded, leaves B on screen', async () => {
    const user = userEvent.setup();
    let releaseA: ((c: Contact) => void) | undefined;
    updateContact.mockImplementation(
      () =>
        new Promise<Contact>((resolve) => {
          releaseA = resolve;
        }),
    );
    const { rerender } = render(<Page contactId="A" />);
    expect(await screen.findByRole('heading', { name: 'Ada' })).toBeInTheDocument();

    // Save on A with its PATCH held...
    await user.click(screen.getByRole('button', { name: 'Edit staff notes' }));
    await user.type(screen.getByLabelText('Staff notes'), ' - updated');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    // The card also sends the stamp its editor opened with (the stale-save
    // guard, spec 3.9); A has never been saved, so it is null.
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('A', {
        staff_notes: 'note A - updated',
        staff_notes_expected_updated_at: null,
      }),
    );

    // ...then the page moves to B (same component, new id) and B loads.
    rerender(<Page contactId="B" />);
    expect(await screen.findByRole('heading', { name: 'Ben' })).toBeInTheDocument();

    // A's PATCH resolves now: A's card hands the result to A's setContact.
    await act(async () => {
      releaseA!({ ...A, staff_notes: 'note A - updated' });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByRole('heading', { name: 'Ben' })).toBeInTheDocument();
    expect(screen.getByText('note B')).toBeInTheDocument();
    expect(screen.queryByText('page loading')).not.toBeInTheDocument();
    expect(getContact).toHaveBeenCalledTimes(2);
  });

  it('a setContact for the contact on screen still applies in place, with no refetch', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...B, staff_notes: 'note B - updated' });
    render(<Page contactId="B" />);
    expect(await screen.findByRole('heading', { name: 'Ben' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit staff notes' }));
    await user.type(screen.getByLabelText('Staff notes'), ' - updated');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('note B - updated')).toBeInTheDocument();
    expect(getContact).toHaveBeenCalledTimes(1);
  });
});
