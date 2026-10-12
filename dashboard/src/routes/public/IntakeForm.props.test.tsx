// IntakeForm - the optional /join props (join-housing-authority spec D8, D9).
// The flyer passes none of them, so the first block PINS today's behavior with
// no optional prop: no extra field, the submit enabled, nothing focused, and
// today's error copy for ANY thrown error. The second block drives each new
// prop: extraField placement, submitBlocked, errorMessage, autoFocusFirstName.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { IntakeForm } from './IntakeForm.js';

const TODAYS_ERROR = "Sorry, we couldn't send that. Please try again.";

function sendButton(): HTMLElement {
  return screen.getByRole('button', { name: /send my info/i });
}

function consentBox(): HTMLElement {
  return screen.getByRole('checkbox', { name: /I agree to receive/i });
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/first name/i), 'Ada');
  await user.type(screen.getByLabelText(/last name/i), 'Lovelace');
  await user.type(screen.getByLabelText(/phone number/i), '4045551234');
}

describe('IntakeForm with none of the optional props (the flyer) - PIN', () => {
  it('renders only its own fields: no select, the submit enabled, nothing focused', () => {
    render(<IntakeForm onSubmit={vi.fn().mockResolvedValue(undefined)} />);

    expect(document.querySelector('select')).toBeNull();
    expect(screen.queryByLabelText(/housing authority/i)).toBeNull();
    expect(screen.getByLabelText(/first name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/last name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/phone number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/voucher size/i)).toBeInTheDocument();
    expect(consentBox()).toBeInTheDocument();
    // First, last, phone, voucher, consent - and nothing else.
    expect(document.querySelectorAll('input')).toHaveLength(5);
    expect(sendButton()).toBeEnabled();
    expect(document.body).toHaveFocus();
  });

  it("shows today's message for ANY thrown error (a 429 and a not-listed refusal included) and keeps the fields", async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' }))
      .mockRejectedValueOnce(
        new ApiError(400, 'housing_authority_not_listed', 'housing_authority_not_listed', {
          error: 'housing_authority_not_listed',
        }),
      );
    render(<IntakeForm onSubmit={onSubmit} />);
    await fillRequiredFields(user);
    await user.click(consentBox());

    await user.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(TODAYS_ERROR);

    await user.click(sendButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('alert')).toHaveTextContent(TODAYS_ERROR);
    expect(screen.getByLabelText(/first name/i)).toHaveValue('Ada');
    expect(consentBox()).toBeChecked();
    for (const call of onSubmit.mock.calls) {
      expect(call[0]).not.toHaveProperty('housingAuthority');
    }
  });
});

describe('IntakeForm optional props (/join)', () => {
  it('extraField renders inside the form, after "Voucher size" and before the consent box', () => {
    render(
      <IntakeForm
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        extraField={
          <div>
            <label htmlFor="extra-field">Extra field</label>
            <input id="extra-field" />
          </div>
        }
      />,
    );
    const voucher = screen.getByLabelText(/voucher size/i);
    const extra = screen.getByLabelText('Extra field');

    expect(voucher.compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(extra.compareDocumentPosition(consentBox()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(extra.closest('form')).not.toBeNull();
  });

  it('submitBlocked disables the submit button and an Enter in a field sends nothing', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<IntakeForm onSubmit={onSubmit} submitBlocked />);
    expect(sendButton()).toBeDisabled();

    await fillRequiredFields(user);
    await user.click(consentBox());
    await user.type(screen.getByLabelText(/last name/i), '{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();

    rerender(<IntakeForm onSubmit={onSubmit} submitBlocked={false} />);
    expect(sendButton()).toBeEnabled();
    await user.click(sendButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it("errorMessage maps a thrown error to its copy; null keeps today's message", async () => {
    const user = userEvent.setup();
    const tooMany = new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' });
    const broken = new ApiError(500, 'internal', 'internal', { error: 'internal' });
    const onSubmit = vi.fn().mockRejectedValueOnce(tooMany).mockRejectedValueOnce(broken);
    const errorMessage = vi.fn((err: unknown) => (err === tooMany ? 'Mapped copy for the test.' : null));
    render(<IntakeForm onSubmit={onSubmit} errorMessage={errorMessage} />);
    await fillRequiredFields(user);
    await user.click(consentBox());

    await user.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Mapped copy for the test.');
    expect(errorMessage).toHaveBeenCalledWith(tooMany);
    // The form stays as typed, consent included, and can send again.
    expect(screen.getByLabelText(/first name/i)).toHaveValue('Ada');
    expect(consentBox()).toBeChecked();

    await user.click(sendButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(TODAYS_ERROR));
    expect(errorMessage).toHaveBeenLastCalledWith(broken);
  });

  it('autoFocusFirstName focuses "First name" on mount', () => {
    render(<IntakeForm onSubmit={vi.fn().mockResolvedValue(undefined)} autoFocusFirstName />);
    expect(screen.getByLabelText(/first name/i)).toHaveFocus();
  });

  it('autoFocusFirstName={false} leaves focus where it was', () => {
    render(<IntakeForm onSubmit={vi.fn().mockResolvedValue(undefined)} autoFocusFirstName={false} />);
    expect(document.body).toHaveFocus();
  });
});
