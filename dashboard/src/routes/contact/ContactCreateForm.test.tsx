import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Contact } from '../../api/index.js';

// Mock createContact and useContactVocabulary before importing the component.
const createContact = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, createContact: (...a: unknown[]) => createContact(...a) };
});

vi.mock('./useContactVocabulary.js', () => ({
  useContactVocabulary: () => ({ roles: [], relationshipRoles: [], fieldLabels: [] }),
}));

// Import AFTER mocking.
import { ContactCreateForm } from './ContactCreateForm.js';

const CANDIDATES: Contact[] = [];

function setup(overrides?: Partial<Parameters<typeof ContactCreateForm>[0]>) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const onOpenExisting = vi.fn();
  render(
    <ContactCreateForm
      candidates={CANDIDATES}
      onClose={onClose}
      onCreated={onCreated}
      onOpenExisting={onOpenExisting}
      {...overrides}
    />,
  );
  return { onClose, onCreated, onOpenExisting };
}

beforeEach(() => vi.clearAllMocks());

describe('ContactCreateForm', () => {
  // ── Test 1: Tenant + name + phone → createContact called with {type, firstName, lastName, phone} (no role key)
  it('picks Tenant, fills name+phone, Create → createContact called with correct body (no role key)', async () => {
    const user = userEvent.setup();
    const newContact: Contact = {
      contactId: 'new-1',
      type: 'tenant',
      firstName: 'Alice',
      lastName: 'Smith',
      phone: '+14041112222',
    };
    createContact.mockResolvedValue(newContact);

    setup();

    // Pick Tenant from the KindPicker segment bar
    await user.click(screen.getByRole('button', { name: 'Tenant' }));

    // Fill standard fields
    await user.type(screen.getByLabelText(/First name/i), 'Alice');
    await user.type(screen.getByLabelText(/Last name/i), 'Smith');
    await user.type(screen.getByLabelText(/Phone/i), '+14041112222');

    // Click Create
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() =>
      expect(createContact).toHaveBeenCalledWith({
        type: 'tenant',
        firstName: 'Alice',
        lastName: 'Smith',
        phone: '+14041112222',
      }),
    );
    // No 'role' key in the call
    const calledWith = createContact.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('role' in calledWith).toBe(false);
  });

  // ── Test 2: Other → role "Case worker" + base Tenant + relationship + custom field
  it('Other kind with role, relationship, and custom field → body carries role, relationships, customFields', async () => {
    const user = userEvent.setup();
    const newContact: Contact = {
      contactId: 'new-2',
      type: 'tenant',
      role: 'Case worker',
      firstName: 'Bob',
      lastName: 'Jones',
    };
    createContact.mockResolvedValue(newContact);

    setup();

    // Click "Other" in the segment bar
    await user.click(screen.getByRole('button', { name: 'Other' }));

    // Fill the role input (shown by KindPicker in Other mode)
    await user.type(screen.getByLabelText(/^Role$/i), 'Case worker');

    // Pick Tenant as the base type (second "Tenant" button = the sub-choice one)
    const tenantButtons = screen.getAllByRole('button', { name: 'Tenant' });
    await user.click(tenantButtons[tenantButtons.length - 1]!);

    // Fill name fields
    await user.type(screen.getByLabelText(/First name/i), 'Bob');
    await user.type(screen.getByLabelText(/Last name/i), 'Jones');

    // Expand relationships section and fill a row
    await user.click(screen.getByRole('button', { name: /\+ Add relationship/i }));
    await user.type(screen.getByLabelText(/Relationship role 1/i), 'Spouse');
    // ContactSearchField has a label matching "Contact search 1"
    await user.type(screen.getByLabelText(/Contact search 1/i), 'Jane Doe');

    // Expand custom fields section and fill a row
    await user.click(screen.getByRole('button', { name: /\+ Add custom field/i }));
    await user.type(screen.getByLabelText(/Field label 1/i), 'Notes');
    await user.type(screen.getByLabelText(/Field value 1/i), 'Prefers calls');

    // Create
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() =>
      expect(createContact).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tenant',
          role: 'Case worker',
          firstName: 'Bob',
          lastName: 'Jones',
          relationships: [{ role: 'Spouse', name: 'Jane Doe' }],
          customFields: [{ label: 'Notes', value: 'Prefers calls' }],
        }),
      ),
    );
  });

  // ── Test 3: 201 → onCreated called with returned contact
  it('on successful create (201), calls onCreated with the returned contact', async () => {
    const user = userEvent.setup();
    const newContact: Contact = { contactId: 'new-3', type: 'tenant', firstName: 'Carol' };
    createContact.mockResolvedValue(newContact);

    const { onCreated } = setup();

    await user.click(screen.getByRole('button', { name: 'Tenant' }));
    await user.type(screen.getByLabelText(/First name/i), 'Carol');
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(newContact));
  });

  // ── Test 4: 409 conflict → inline notice, "Open their page" → onOpenExisting; no onCreated; dialog stays open
  it('409 conflict → shows existing contact name + Open their page; no onCreated; dialog stays open', async () => {
    const user = userEvent.setup();
    const existingContact = { contactId: 'c-existing', firstName: 'Bob', type: 'tenant' };
    createContact.mockRejectedValue(
      new ApiError(409, 'contact_exists', 'contact_exists', {
        error: 'contact_exists',
        contact: existingContact,
      }),
    );

    const { onCreated, onOpenExisting } = setup();

    await user.click(screen.getByRole('button', { name: 'Tenant' }));
    await user.type(screen.getByLabelText(/Phone/i), '+14041110000');
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    // Conflict notice should appear
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/That number already belongs to/i),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Bob/i);

    // "Open their page" button should be present and call onOpenExisting
    const openBtn = screen.getByRole('button', { name: /Open their page/i });
    await user.click(openBtn);
    expect(onOpenExisting).toHaveBeenCalledWith('c-existing');

    // onCreated should NOT have been called
    expect(onCreated).not.toHaveBeenCalled();

    // Dialog is still open (title is visible)
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // ── Test 5: Create button disabled before a base type is chosen
  it('Create button is disabled before a base type is chosen', () => {
    setup();
    const createBtn = screen.getByRole('button', { name: /^Create$/i });
    expect(createBtn).toBeDisabled();
  });

  // ── Test 6: Empty relationship row / empty-label custom field dropped from body
  it('relationship row with role but empty name is dropped from the submitted body', async () => {
    const user = userEvent.setup();
    const newContact: Contact = { contactId: 'new-6a', type: 'tenant' };
    createContact.mockResolvedValue(newContact);

    setup();

    await user.click(screen.getByRole('button', { name: 'Tenant' }));

    // Expand relationships and fill in role but leave name blank
    await user.click(screen.getByRole('button', { name: /\+ Add relationship/i }));
    await user.type(screen.getByLabelText(/Relationship role 1/i), 'Spouse');
    // Leave Contact search 1 (name) empty

    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() => expect(createContact).toHaveBeenCalled());
    const body = createContact.mock.calls[0]?.[0] as Record<string, unknown>;
    // Partial row (role only, no name) must be dropped — no relationships key
    expect('relationships' in body).toBe(false);
  });

  // ── Test 7: busy flag resets on success (no stuck "Creating…" lock)
  it('Create button re-enables after a successful create when caller does NOT unmount', async () => {
    const user = userEvent.setup();
    const newContact: Contact = { contactId: 'new-7', type: 'tenant', firstName: 'Dave' };
    createContact.mockResolvedValue(newContact);

    // onCreated does NOT unmount — it's a plain vi.fn() that does nothing.
    setup({ onCreated: vi.fn() });

    await user.click(screen.getByRole('button', { name: 'Tenant' }));
    await user.type(screen.getByLabelText(/First name/i), 'Dave');
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    // After the promise settles the button must be enabled again (not "Creating…").
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /^Create$/i });
      expect(btn).not.toBeDisabled();
    });
  });

  it('empty relationship row and empty-label custom field are dropped from the body', async () => {
    const user = userEvent.setup();
    const newContact: Contact = { contactId: 'new-6', type: 'tenant' };
    createContact.mockResolvedValue(newContact);

    setup();

    await user.click(screen.getByRole('button', { name: 'Tenant' }));

    // Add a relationship row but leave it empty
    await user.click(screen.getByRole('button', { name: /\+ Add relationship/i }));
    // Leave role + name empty

    // Add a custom field row with an empty label
    await user.click(screen.getByRole('button', { name: /\+ Add custom field/i }));
    // Leave label empty, but type a value
    await user.type(screen.getByLabelText(/Field value 1/i), 'some value');

    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() => expect(createContact).toHaveBeenCalled());
    const body = createContact.mock.calls[0]?.[0] as Record<string, unknown>;
    // relationships and customFields arrays should be absent (empty/invalid rows dropped)
    expect('relationships' in body).toBe(false);
    expect('customFields' in body).toBe(false);
  });
});
