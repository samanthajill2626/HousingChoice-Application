// useContact - the detail page's single-contact hook. Pinned here (review R1
// A-3): setContact is BOUND to the contact id it was handed out for. The page
// re-renders (never remounts) across a contact-to-contact navigation, so a
// caller still holding contact A's setter - a Staff notes save on A whose
// PATCH resolves after the page moved to B - must not replace B's state, or
// the hook derives "loading" for B forever and nothing refetches it.
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, EventStreamHandlers } from '../../api/index.js';

const getContact = vi.fn();
const updateContact = vi.fn();
// The page's only useEventStream caller is useContact, so last-writer-wins
// capture is exact here.
let sse: EventStreamHandlers = {};
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContact: (...a: unknown[]) => getContact(...a),
    updateContact: (...a: unknown[]) => updateContact(...a),
    useEventStream: (h: EventStreamHandlers) => {
      sse = h;
    },
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
  sse = {};
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

// unknown-inactive spec D2 / AR3: a status or type change made elsewhere (the
// edit form, another tab, another operator) re-reads the open contact in
// place - no spinner, no reload.
describe('useContact - live re-read on contact.updated', () => {
  it('re-reads the open contact in place when contact.updated names it', async () => {
    render(<Page contactId="B" />);
    expect(await screen.findByRole('heading', { name: 'Ben' })).toBeInTheDocument();
    expect(getContact).toHaveBeenCalledTimes(1);

    getContact.mockResolvedValue({ ...B, firstName: 'Benjamin' });
    act(() => {
      sse.onContactUpdated?.({ contactId: 'B' });
    });
    expect(await screen.findByRole('heading', { name: 'Benjamin' })).toBeInTheDocument();
    expect(getContact).toHaveBeenCalledTimes(2);
    // Plan round 1 P2: the re-read follows a write by moments, so it is a
    // consistent read (getContact's `consistent`, planner ruling PR-3).
    expect(getContact).toHaveBeenLastCalledWith('B', undefined, { consistent: true });
    expect(screen.queryByText('page loading')).not.toBeInTheDocument();
  });

  it('(PIN) ignores contact.updated for another contact', async () => {
    render(<Page contactId="B" />);
    expect(await screen.findByRole('heading', { name: 'Ben' })).toBeInTheDocument();
    await act(async () => {
      sse.onContactUpdated?.({ contactId: 'A' });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(getContact).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Ben' })).toBeInTheDocument();
  });

  it('the latest re-read wins: an earlier re-read answering LAST never overwrites a newer one (WORKLIST OR-5)', async () => {
    // A type change to tenant whose shown status is not Onboarding emits
    // contact.updated twice (the PATCH, then setTenantStatus). Two consistent
    // GETs answering out of order must not leave the intermediate contact on
    // screen.
    render(<Page contactId="B" />);
    expect(await screen.findByRole('heading', { name: 'Ben' })).toBeInTheDocument();
    let releaseFirst: ((c: Contact) => void) | undefined;
    let releaseSecond: ((c: Contact) => void) | undefined;
    getContact
      .mockImplementationOnce(
        () =>
          new Promise<Contact>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Contact>((resolve) => {
            releaseSecond = resolve;
          }),
      );
    act(() => {
      sse.onContactUpdated?.({ contactId: 'B' });
      sse.onContactUpdated?.({ contactId: 'B' });
    });
    expect(getContact).toHaveBeenCalledTimes(3);

    // The newer re-read answers first and lands...
    await act(async () => {
      releaseSecond!({ ...B, firstName: 'Final' });
    });
    expect(await screen.findByRole('heading', { name: 'Final' })).toBeInTheDocument();
    // ...then the older one answers late and is dropped.
    await act(async () => {
      releaseFirst!({ ...B, firstName: 'Intermediate' });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByRole('heading', { name: 'Final' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Intermediate' })).not.toBeInTheDocument();
  });
});
