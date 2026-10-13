// HousingFairIntake (/join) - sign-up failures (join-housing-authority D8).
// housing_authority_not_listed (the list changed after the page read it): the
// page reads the list again, keeps every typed field and the consent box,
// picks NO value ("Choose one"), blocks send until a choice, and says so; a
// failed re-read falls into the failed-list state. A 429 gets its own message.
// Every other failure keeps IntakeForm's message. The public API module is
// mocked.
import { act, render, screen, waitFor } from '@testing-library/react';
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
// The list after a Settings change: DeKalb gone, Fulton added, Atlanta still there.
const NEW_NAMES = ['Atlanta Housing Authority', 'Cobb County Housing Authority', 'Fulton County Housing Authority'];
const NOT_LISTED = 'The housing authority list was updated. Choose the housing authority again.';
const TOO_MANY = 'Too many sign-ups from this network in the last minute. Wait a minute, then send again.';
const TODAYS_ERROR = "Sorry, we couldn't send that. Please try again.";
const FAILED_NOTE = 'The list of housing authorities could not be loaded.';

function notListed(): ApiError {
  return new ApiError(400, 'housing_authority_not_listed', 'housing_authority_not_listed', {
    error: 'housing_authority_not_listed',
  });
}

function sendButton(): HTMLElement {
  return screen.getByRole('button', { name: /sign me up/i });
}

function consentBox(): HTMLElement {
  return screen.getByRole('checkbox', { name: /I agree to receive/i });
}

function authoritySelect(): HTMLSelectElement {
  return screen.getByLabelText('Housing authority') as HTMLSelectElement;
}

function optionLabels(select: HTMLSelectElement): string[] {
  return Array.from(select.options, (o) => o.textContent ?? '');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

beforeEach(() => {
  vi.resetAllMocks();
  getHousingAuthorities.mockResolvedValue(NAMES);
  submitHousingFair.mockResolvedValue(undefined);
});

describe('housing_authority_not_listed recovery', () => {
  it('reads the list again, keeps every typed field and the consent box, picks no value, and blocks send until a choice', async () => {
    const user = userEvent.setup();
    const reread = deferred<string[]>();
    getHousingAuthorities.mockResolvedValueOnce(NAMES).mockImplementationOnce(() => reread.promise);
    submitHousingFair.mockRejectedValueOnce(notListed()).mockResolvedValueOnce(undefined);
    await renderJoin();

    await user.selectOptions(authoritySelect(), 'DeKalb Housing Authority');
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.type(screen.getByLabelText(/voucher size/i), '2');
    await user.click(consentBox());
    await user.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(NOT_LISTED);
    expect(submitHousingFair.mock.calls[0]![0]).toMatchObject({ housingAuthority: 'DeKalb Housing Authority' });
    // The list is read again; while it loads the select is disabled and send is blocked.
    await waitFor(() => expect(getHousingAuthorities).toHaveBeenCalledTimes(2));
    const select = authoritySelect();
    expect(select).toBeDisabled();
    expect(select).toHaveDisplayValue('Loading...');
    expect(sendButton()).toBeDisabled();

    await act(async () => {
      reread.resolve(NEW_NAMES);
    });
    // No value is picked - not even the Atlanta default, which is still listed.
    expect(select).toBeEnabled();
    expect(select).toHaveDisplayValue('Choose one');
    expect(optionLabels(select)).toEqual(['Choose one', ...NEW_NAMES, 'Not sure']);
    expect(sendButton()).toBeDisabled();
    // Every typed field and the consent box are as they were.
    expect(screen.getByLabelText(/first name/i)).toHaveValue('Grace');
    expect(screen.getByLabelText(/last name/i)).toHaveValue('Hopper');
    expect(screen.getByLabelText(/phone number/i)).toHaveValue('(404) 555-9999');
    expect(screen.getByLabelText(/voucher size/i)).toHaveValue(2);
    expect(consentBox()).toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent(NOT_LISTED);

    await user.selectOptions(select, 'Cobb County Housing Authority');
    expect(sendButton()).toBeEnabled();
    await user.click(sendButton());
    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(2));
    expect(submitHousingFair.mock.calls[1]![0]).toMatchObject({
      firstName: 'Grace',
      lastName: 'Hopper',
      phone: '+14045559999',
      voucherSize: 2,
      smsConsent: true,
      housingAuthority: 'Cobb County Housing Authority',
    });
    expect(await screen.findByRole('heading', { name: /signed up/i })).toBeInTheDocument();
  });

  it('after the message, "Not sure" is a choice too: send unblocks and goes out with no authority', async () => {
    const user = userEvent.setup();
    getHousingAuthorities.mockResolvedValueOnce(NAMES).mockResolvedValueOnce(NEW_NAMES);
    submitHousingFair.mockRejectedValueOnce(notListed()).mockResolvedValueOnce(undefined);
    await renderJoin();
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(NOT_LISTED);
    const select = authoritySelect();
    await waitFor(() => expect(select).toHaveDisplayValue('Choose one'));
    expect(sendButton()).toBeDisabled();

    await user.selectOptions(select, 'Not sure');
    expect(sendButton()).toBeEnabled();
    await user.click(sendButton());
    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(2));
    expect(submitHousingFair.mock.calls[1]![0]).not.toHaveProperty('housingAuthority');
  });

  it('a failed re-read falls into the failed state: only "Not sure", the note, and the sign-up still works', async () => {
    const user = userEvent.setup();
    getHousingAuthorities
      .mockResolvedValueOnce(NAMES)
      .mockRejectedValueOnce(new ApiError(0, 'network_error', 'Network request failed'));
    submitHousingFair.mockRejectedValueOnce(notListed()).mockResolvedValueOnce(undefined);
    await renderJoin();
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(NOT_LISTED);
    await waitFor(() => expect(getHousingAuthorities).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(FAILED_NOTE)).toBeInTheDocument();
    const select = authoritySelect();
    expect(select).toBeEnabled();
    expect(select).toHaveDisplayValue('Not sure');
    expect(optionLabels(select)).toEqual(['Not sure']);
    expect(sendButton()).toBeEnabled();

    await user.click(sendButton());
    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(2));
    expect(submitHousingFair.mock.calls[1]![0]).not.toHaveProperty('housingAuthority');
    expect(await screen.findByRole('heading', { name: /signed up/i })).toBeInTheDocument();
  });
});

describe('other sign-up failures', () => {
  it('a 429 says so and keeps the form as it is; the list is not read again', async () => {
    const user = userEvent.setup();
    submitHousingFair.mockRejectedValueOnce(
      new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' }),
    );
    await renderJoin();
    await user.selectOptions(authoritySelect(), 'DeKalb Housing Authority');
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(TOO_MANY);
    expect(getHousingAuthorities).toHaveBeenCalledTimes(1);
    expect(authoritySelect()).toHaveDisplayValue('DeKalb Housing Authority');
    expect(authoritySelect()).toBeEnabled();
    expect(screen.getByLabelText(/first name/i)).toHaveValue('Grace');
    expect(consentBox()).toBeChecked();
    expect(sendButton()).toBeEnabled();
  });

  it("(PIN) every other failure keeps today's message", async () => {
    const user = userEvent.setup();
    submitHousingFair
      .mockRejectedValueOnce(new ApiError(500, 'internal', 'internal', { error: 'internal' }))
      .mockRejectedValueOnce(new ApiError(0, 'network_error', 'Network request failed'))
      .mockRejectedValueOnce(new ApiError(400, 'invalid request', 'invalid request', { error: 'invalid request' }));
    await renderJoin();
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await user.click(sendButton());
      await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(attempt));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(TODAYS_ERROR));
    }
    expect(getHousingAuthorities).toHaveBeenCalledTimes(1);
    expect(authoritySelect()).toHaveDisplayValue('Atlanta Housing Authority');
  });
});
