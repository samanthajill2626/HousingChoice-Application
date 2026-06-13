// TriageForm unit tests (M1.4 triage fixes):
//   - dirty-tracking: changing ONLY the type PATCHes only { type } (never
//     re-sends an untouched status/name/notes — the legacy-status backend 400);
//   - a legacy status (e.g. 'new', outside the backend allowlist) renders as a
//     visible "(legacy)" option so the select reflects the real held value;
//   - 'archived' is NOT offered (backend allowlist = needs_review | active);
//   - Save is disabled until something changes;
//   - a save error renders as a single form-level alert, NOT pinned to Notes.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../api';

const api = vi.hoisted(() => ({ updateContact: vi.fn() }));
vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api');
  return { ...actual, updateContact: api.updateContact };
});

import { TriageForm } from './TriageForm';
import { ToastProvider } from '../../ui';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    contactId: 'contact-1',
    type: 'unknown',
    status: 'needs_review',
    phone: '+13135551234',
    ...overrides,
  };
}

function renderForm(contact: Contact, onSaved = vi.fn()): { onSaved: ReturnType<typeof vi.fn> } {
  render(
    <ToastProvider>
      <TriageForm contact={contact} onSaved={onSaved} />
    </ToastProvider>,
  );
  return { onSaved };
}

beforeEach(() => {
  api.updateContact.mockReset();
  api.updateContact.mockResolvedValue(makeContact({ type: 'tenant', status: 'needs_review' }));
});

afterEach(() => vi.clearAllMocks());

describe('<TriageForm> dirty-tracking', () => {
  it('disables Save until a field changes', () => {
    renderForm(makeContact());
    expect(screen.getByRole('button', { name: /save contact/i })).toBeDisabled();
  });

  it('PATCHes ONLY { type } when only the type changed — no stale status/name/notes', async () => {
    // A legacy contact whose status ('new') is NOT in the backend allowlist:
    // re-sending it would 400. Dirty-tracking must omit it entirely.
    renderForm(makeContact({ status: 'new', firstName: 'Old', notes: 'prior note' }));

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'tenant' } });
    fireEvent.click(screen.getByRole('button', { name: /save contact/i }));

    await waitFor(() => expect(api.updateContact).toHaveBeenCalledTimes(1));
    const [, patch] = api.updateContact.mock.calls[0]!;
    expect(patch).toEqual({ type: 'tenant' });
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('firstName');
    expect(patch).not.toHaveProperty('notes');
  });

  it('PATCHes only the changed status when only status changed', async () => {
    renderForm(makeContact({ status: 'needs_review' }));

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'active' } });
    fireEvent.click(screen.getByRole('button', { name: /save contact/i }));

    await waitFor(() => expect(api.updateContact).toHaveBeenCalledTimes(1));
    const [, patch] = api.updateContact.mock.calls[0]!;
    expect(patch).toEqual({ status: 'active' });
  });
});

describe('<TriageForm> status options', () => {
  it('offers exactly the backend allowlist (needs_review, active) — no archived', () => {
    renderForm(makeContact({ status: 'active' }));
    const statusSelect = screen.getByLabelText('Status') as HTMLSelectElement;
    const values = Array.from(statusSelect.options).map((o) => o.value);
    expect(values).toEqual(['needs_review', 'active']);
    expect(values).not.toContain('archived');
  });

  it('renders a legacy status as a visible "(legacy)" option so the select reflects reality', () => {
    renderForm(makeContact({ status: 'new' }));
    const statusSelect = screen.getByLabelText('Status') as HTMLSelectElement;
    // The select VISIBLY holds 'new' (not silently snapped to needs_review).
    expect(statusSelect.value).toBe('new');
    const legacyOption = Array.from(statusSelect.options).find((o) => o.value === 'new');
    expect(legacyOption).toBeDefined();
    expect(legacyOption?.textContent).toMatch(/legacy/i);
  });
});

describe('<TriageForm> error display', () => {
  it('shows a single form-level alert on save failure — NOT pinned to Notes', async () => {
    const { ApiError } = await vi.importActual<typeof import('../../api')>('../../api');
    api.updateContact.mockRejectedValueOnce(
      new ApiError(400, 'bad', 'status must be one of: needs_review, active'),
    );
    renderForm(makeContact());

    // Make the form dirty so Save is enabled, then submit.
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'tenant' } });
    fireEvent.click(screen.getByRole('button', { name: /save contact/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('status must be one of: needs_review, active');

    // The error is NOT attached to the Notes textarea (no aria-invalid there).
    const notes = screen.getByLabelText('Notes');
    expect(notes).not.toHaveAttribute('aria-invalid', 'true');
    // The Notes field has no describedby pointing at an error region.
    expect(notes).not.toHaveAttribute('aria-describedby');
  });
});
