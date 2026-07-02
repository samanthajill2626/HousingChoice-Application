// IntakeForm — A2P/CTIA consent gate tests. The required, unchecked-by-default
// consent checkbox gates submit (client-side); a checked submit threads
// smsConsent:true through onSubmit. The checkbox label reproduces the FILED CTIA
// disclosure VERBATIM and renders "Privacy Policy" / "Terms" as new-tab links.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntakeForm } from './IntakeForm.js';
import {
  WEB_FORM_CONSENT_LABEL,
  PRIVACY_POLICY_URL,
  TERMS_URL,
} from '../../lib/consentCopy.js';

function setup() {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<IntakeForm onSubmit={onSubmit} />);
  return { onSubmit };
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/first name/i), 'Ada');
  await user.type(screen.getByLabelText(/last name/i), 'Lovelace');
  await user.type(screen.getByLabelText(/phone number/i), '4045551234');
}

beforeEach(() => vi.clearAllMocks());

describe('IntakeForm — phone normalize-on-blur', () => {
  it('blur with dashed 10-digit snaps the field to display form', async () => {
    const user = userEvent.setup();
    setup();
    const phoneInput = screen.getByLabelText(/phone number/i);
    await user.type(phoneInput, '404-982-4978');
    await user.tab(); // blur
    expect(phoneInput).toHaveValue('(404) 982-4978');
  });

  it('blur with garbage shows inline error; submit is blocked (no onSubmit call)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByLabelText(/first name/i), 'Ada');
    await user.type(screen.getByLabelText(/last name/i), 'Lovelace');
    const phoneInput = screen.getByLabelText(/phone number/i);
    await user.type(phoneInput, '404'); // too short
    await user.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Enter a 10-digit US number/i);

    // Check consent and try submitting — phone error blocks it.
    await user.click(screen.getByRole('checkbox', { name: /I agree to receive/i }));
    await user.click(screen.getByRole('button', { name: /send my info/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('explicit +44 international passes through and submits as-is', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByLabelText(/first name/i), 'Ada');
    await user.type(screen.getByLabelText(/last name/i), 'Lovelace');
    const phoneInput = screen.getByLabelText(/phone number/i);
    await user.type(phoneInput, '+442079460958');
    await user.tab();
    expect(phoneInput).toHaveValue('+442079460958'); // non-NANP, no reformat

    await user.click(screen.getByRole('checkbox', { name: /I agree to receive/i }));
    await user.click(screen.getByRole('button', { name: /send my info/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ phone: '+442079460958' }));
  });
});

describe('IntakeForm — A2P/CTIA consent gate', () => {
  it('renders the verbatim filed consent label with Privacy Policy + Terms links (new tab, rel=noreferrer)', () => {
    setup();
    // The checkbox is present, required, and unchecked by default.
    const box = screen.getByRole('checkbox', { name: /I agree to receive/i });
    expect(box).toHaveAttribute('aria-required', 'true');
    expect(box).not.toBeChecked();

    // The full rendered text equals the FILED copy VERBATIM.
    expect(screen.getByText((_c, node) => node?.textContent === WEB_FORM_CONSENT_LABEL, {
      selector: 'span',
    })).toBeInTheDocument();

    // The two link phrases open in a new tab with rel="noreferrer".
    const pp = screen.getByRole('link', { name: 'Privacy Policy' });
    expect(pp).toHaveAttribute('href', PRIVACY_POLICY_URL);
    expect(pp).toHaveAttribute('target', '_blank');
    expect(pp).toHaveAttribute('rel', 'noreferrer');
    const terms = screen.getByRole('link', { name: 'Terms' });
    expect(terms).toHaveAttribute('href', TERMS_URL);
    expect(terms).toHaveAttribute('target', '_blank');
    expect(terms).toHaveAttribute('rel', 'noreferrer');
  });

  it('blocks submit until the consent box is checked, then submits with smsConsent:true', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await fillRequiredFields(user);
    // Unchecked → submit is blocked with an accessible error, onSubmit NOT called.
    await user.click(screen.getByRole('button', { name: /send my info/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/agree to receive texts/i);
    expect(onSubmit).not.toHaveBeenCalled();

    // Check the box → submit succeeds with smsConsent:true.
    await user.click(screen.getByRole('checkbox', { name: /I agree to receive/i }));
    await user.click(screen.getByRole('button', { name: /send my info/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: 'Ada',
        lastName: 'Lovelace',
        phone: '+14045551234', // normalized to E.164 on submit
        smsConsent: true,
      }),
    );
  });
});
