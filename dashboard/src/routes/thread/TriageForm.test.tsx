// TriageForm unit tests (M1.4 triage fixes + M1.5 status-field removal):
//   - the lifecycle Status field is NOT operator-visible and is never sent;
//   - dirty-tracking: changing ONLY the type PATCHes only { type } (never
//     re-sends an untouched status/name/notes — the legacy-status backend 400);
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
  api.updateContact.mockResolvedValue(makeContact({ type: 'tenant', status: 'active' }));
});

afterEach(() => vi.clearAllMocks());

describe('<TriageForm> status field is hidden (M1.5)', () => {
  it('does NOT render a Status control (lifecycle status is internal)', () => {
    renderForm(makeContact({ status: 'active' }));
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
  });

  it('never sends `status` even when the type changes (backend auto-advances it)', async () => {
    renderForm(makeContact({ status: 'needs_review' }));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'tenant' } });
    fireEvent.click(screen.getByRole('button', { name: /save contact/i }));

    await waitFor(() => expect(api.updateContact).toHaveBeenCalledTimes(1));
    const [, patch] = api.updateContact.mock.calls[0]!;
    expect(patch).not.toHaveProperty('status');
  });
});

describe('<TriageForm> dirty-tracking', () => {
  it('disables Save until a field changes, with a reason in the title', () => {
    renderForm(makeContact());
    const save = screen.getByRole('button', { name: /save contact/i });
    expect(save).toBeDisabled();
    // The disabled-until-dirty button explains itself (read as "broken" otherwise).
    expect(save).toHaveAttribute('title', 'Change a field to enable saving');
  });

  it('does NOT enable Save when only blanking a previously-set voucher (no clear in the contract)', () => {
    renderForm(makeContact({ voucherSize: 2 }));
    const save = screen.getByRole('button', { name: /save contact/i });
    expect(save).toBeDisabled();
    // Blank the voucher only → still disabled (buildPatch can't express a clear,
    // so dirty must agree and stay false).
    fireEvent.change(screen.getByLabelText('Voucher size'), { target: { value: '' } });
    expect(save).toBeDisabled();
  });

  it('PATCHes ONLY { type } when only the type changed — no stale status/name/notes', async () => {
    // A legacy contact whose status ('new') is NOT in the backend allowlist:
    // re-sending it would 400. The form never reads or sends status, and
    // dirty-tracking omits the untouched name/notes.
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
});

describe('<TriageForm> voucher validation', () => {
  it('shows a FIELD error (not a silent no-op) for an out-of-range voucher and does not save', async () => {
    renderForm(makeContact());

    // 13 is out of the backend range (0..12). Type it; that makes the form dirty.
    const voucher = screen.getByLabelText('Voucher size');
    fireEvent.change(voucher, { target: { value: '13' } });
    fireEvent.click(screen.getByRole('button', { name: /save contact/i }));

    // An inline field error appears (bound to the Voucher field) …
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/0 to 12/i);
    // … the Voucher input is marked invalid + described by the error …
    expect(voucher).toHaveAttribute('aria-invalid', 'true');
    expect(voucher).toHaveAttribute('aria-describedby', expect.stringContaining('-error'));
    // … and crucially NO save was attempted (not a silent no-op, not a save).
    expect(api.updateContact).not.toHaveBeenCalled();
  });

  it('rejects a non-integer voucher as a field error', async () => {
    renderForm(makeContact());
    fireEvent.change(screen.getByLabelText('Voucher size'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: /save contact/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/0 to 12/i);
    expect(api.updateContact).not.toHaveBeenCalled();
  });

  it('clears the voucher field error on change', async () => {
    renderForm(makeContact());
    const voucher = screen.getByLabelText('Voucher size');
    fireEvent.change(voucher, { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /save contact/i }));
    await screen.findByRole('alert');

    // Typing a valid value clears the error.
    fireEvent.change(voucher, { target: { value: '3' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('saves a valid in-range voucher', async () => {
    renderForm(makeContact());
    fireEvent.change(screen.getByLabelText('Voucher size'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /save contact/i }));

    await waitFor(() => expect(api.updateContact).toHaveBeenCalledTimes(1));
    const [, patch] = api.updateContact.mock.calls[0]!;
    expect(patch).toEqual({ voucherSize: 3 });
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
