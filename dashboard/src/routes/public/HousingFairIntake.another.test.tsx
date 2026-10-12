// HousingFairIntake (/join) - "Sign up another person" (join-housing-authority
// D9). The thank-you keeps its heading and text and adds the button. It
// returns an empty form (names, phone, voucher blank, the consent box
// unchecked), keeps the select on the previous choice, moves focus to "First
// name", and reads the list again ONLY when the last read failed (then the
// default rule applies). The public API module is mocked.
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

const getHousingAuthorities = vi.fn();
const submitHousingFair = vi.fn();
vi.mock('./publicApi.js', async () => {
  const actual = await vi.importActual<typeof import('./publicApi.js')>('./publicApi.js');
  return {
    ...actual,
    getHousingAuthorities: (...a: unknown[]) => getHousingAuthorities(...a),
    submitHousingFair: (...a: unknown[]) => submitHousingFair(...a),
  };
});

import { HousingFairIntake } from './HousingFairIntake.js';

const NAMES = ['Atlanta Housing Authority', 'Cobb County Housing Authority', 'DeKalb Housing Authority'];
const EM_DASH = String.fromCharCode(0x2014);
const FAILED_NOTE = 'The list of housing authorities could not be loaded.';

function sendButton(): HTMLElement {
  return screen.getByRole('button', { name: /sign me up/i });
}

function consentBox(): HTMLElement {
  return screen.getByRole('checkbox', { name: /I agree to receive/i });
}

function authoritySelect(): HTMLSelectElement {
  return screen.getByLabelText('Housing authority') as HTMLSelectElement;
}

/** Render /join and wait until the list read has settled (send enabled). */
async function renderJoin(): Promise<void> {
  render(<HousingFairIntake />);
  await waitFor(() => expect(sendButton()).toBeEnabled());
}

async function fillPerson(
  user: ReturnType<typeof userEvent.setup>,
  first: string,
  last: string,
  phone: string,
): Promise<void> {
  await user.type(screen.getByLabelText(/first name/i), first);
  await user.type(screen.getByLabelText(/last name/i), last);
  await user.type(screen.getByLabelText(/phone number/i), phone);
}

/** Fill, consent, send, and wait for the thank-you. */
async function signUp(
  user: ReturnType<typeof userEvent.setup>,
  first: string,
  last: string,
  phone: string,
): Promise<void> {
  await fillPerson(user, first, last, phone);
  await user.click(consentBox());
  await user.click(sendButton());
  await screen.findByRole('heading', { name: /signed up/i });
}

beforeEach(() => {
  vi.resetAllMocks();
  getHousingAuthorities.mockResolvedValue(NAMES);
  submitHousingFair.mockResolvedValue(undefined);
});

describe('"Sign up another person" (join-housing-authority D9)', () => {
  it('the thank-you keeps its heading and text and adds the button', async () => {
    const user = userEvent.setup();
    await renderJoin();
    await signUp(user, 'Grace', 'Hopper', '4045559999');

    const heading = screen.getByRole('heading', { name: /signed up/i });
    expect(heading.textContent).toBe(`Thanks ${EM_DASH} you're signed up!`);
    expect(heading).toHaveFocus();
    expect(
      screen.getByText("We've got your info. A team member will text you about homes that fit your voucher."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign up another person' })).toBeEnabled();
  });

  it('returns an empty form with the consent box unchecked, keeps the chosen authority, focuses First name, and reads nothing', async () => {
    const user = userEvent.setup();
    await renderJoin();
    await user.selectOptions(authoritySelect(), 'DeKalb Housing Authority');
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.type(screen.getByLabelText(/voucher size/i), '2');
    await user.click(consentBox());
    await user.click(sendButton());
    await user.click(await screen.findByRole('button', { name: 'Sign up another person' }));

    const first = screen.getByLabelText(/first name/i);
    expect(first).toHaveFocus();
    expect(first).toHaveValue('');
    expect(screen.getByLabelText(/last name/i)).toHaveValue('');
    expect(screen.getByLabelText(/phone number/i)).toHaveValue('');
    expect(screen.getByLabelText(/voucher size/i)).toHaveValue(null);
    expect(consentBox()).not.toBeChecked();
    expect(screen.queryByRole('alert')).toBeNull();
    const select = authoritySelect();
    expect(select).toHaveDisplayValue('DeKalb Housing Authority');
    expect(select).toBeEnabled();
    expect(sendButton()).toBeEnabled();
    expect(getHousingAuthorities).toHaveBeenCalledTimes(1);

    // The next person goes out with the kept authority.
    await signUp(user, 'Alan', 'Turing', '4045558888');
    expect(submitHousingFair).toHaveBeenCalledTimes(2);
    expect(submitHousingFair.mock.calls[1]![0]).toMatchObject({
      firstName: 'Alan',
      lastName: 'Turing',
      phone: '+14045558888',
      smsConsent: true,
      housingAuthority: 'DeKalb Housing Authority',
    });
    expect(submitHousingFair.mock.calls[1]![0]).not.toHaveProperty('voucherSize');
  });

  it('keeps a "Not sure" choice, and the next person also goes out with no authority', async () => {
    const user = userEvent.setup();
    await renderJoin();
    await user.selectOptions(authoritySelect(), 'Not sure');
    await signUp(user, 'Grace', 'Hopper', '4045559999');
    await user.click(screen.getByRole('button', { name: 'Sign up another person' }));

    expect(authoritySelect()).toHaveDisplayValue('Not sure');
    await signUp(user, 'Alan', 'Turing', '4045558888');
    expect(submitHousingFair.mock.calls[1]![0]).not.toHaveProperty('housingAuthority');
    expect(getHousingAuthorities).toHaveBeenCalledTimes(1);
  });

  it('after a failed read, reads the list again and applies the default rule', async () => {
    const user = userEvent.setup();
    getHousingAuthorities
      .mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' }))
      .mockResolvedValueOnce(NAMES);
    await renderJoin();
    expect(authoritySelect()).toHaveDisplayValue('Not sure');
    expect(screen.getByText(FAILED_NOTE)).toBeInTheDocument();
    await signUp(user, 'Grace', 'Hopper', '4045559999');
    expect(submitHousingFair.mock.calls[0]![0]).not.toHaveProperty('housingAuthority');

    await user.click(screen.getByRole('button', { name: 'Sign up another person' }));
    await waitFor(() => expect(getHousingAuthorities).toHaveBeenCalledTimes(2));
    const select = authoritySelect();
    await waitFor(() => expect(select).toHaveDisplayValue('Atlanta Housing Authority'));
    expect(select).toBeEnabled();
    expect(screen.queryByText(FAILED_NOTE)).toBeNull();
    expect(screen.getByLabelText(/first name/i)).toHaveFocus();
  });

  it('under StrictMode, makes no list read after a good load (the remount reads nothing)', async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <HousingFairIntake />
      </StrictMode>,
    );
    await waitFor(() => expect(sendButton()).toBeEnabled());
    const readsAfterLoad = getHousingAuthorities.mock.calls.length;
    await signUp(user, 'Grace', 'Hopper', '4045559999');
    await user.click(screen.getByRole('button', { name: 'Sign up another person' }));

    expect(screen.getByLabelText(/first name/i)).toHaveFocus();
    expect(authoritySelect()).toHaveDisplayValue('Atlanta Housing Authority');
    expect(getHousingAuthorities).toHaveBeenCalledTimes(readsAfterLoad);
  });

  it('(PIN) a first visit does not move focus into the form', async () => {
    await renderJoin();
    expect(document.body).toHaveFocus();
  });
});
