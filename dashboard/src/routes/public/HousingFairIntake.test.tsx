// HousingFairIntake (/join) tests. The standalone intake works with NO unit:
// a successful submit (no unitId) -> a generic thank-you, no reveal; plus
// IntakeForm client validation through the page. join-housing-authority D8:
// the "Housing authority" select - the list read on mount, the Atlanta
// default, "Not sure" sending nothing, the loading / failed / 10 s timeout
// states, abort on unmount, and React StrictMode's double effect. The public
// API module is mocked.
import { StrictMode } from 'react';
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
const EM_DASH = String.fromCharCode(0x2014);
const HELP = 'The organization that runs your voucher.';
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

/** A list read that never answers, but rejects like fetch when aborted. */
function abortableNever(signal: AbortSignal | undefined): Promise<string[]> {
  return new Promise<string[]>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
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

describe('HousingFairIntake (/join)', () => {
  it('submits WITHOUT a unitId and shows a generic thank-you (no reveal)', async () => {
    const user = userEvent.setup();
    await renderJoin();

    await user.type(screen.getByLabelText(/first name/i), 'Grace');
    await user.type(screen.getByLabelText(/last name/i), 'Hopper');
    await user.type(screen.getByLabelText(/phone number/i), '4045559999');
    // A2P/CTIA consent gate - check the required box before submit.
    await user.click(consentBox());
    await user.click(sendButton());

    await waitFor(() => expect(submitHousingFair).toHaveBeenCalled());
    const arg = submitHousingFair.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('unitId');
    expect(arg).toMatchObject({
      firstName: 'Grace',
      lastName: 'Hopper',
      phone: '+14045559999', // normalized to E.164 on submit
      smsConsent: true,
    });

    expect(await screen.findByText(/you're signed up/i)).toBeInTheDocument();
    // No reveal: no address/details ever shown on /join.
    expect(screen.queryByText(/address/i)).not.toBeInTheDocument();
  });

  it('(PIN) the thank-you heading and text are unchanged, and the heading takes focus', async () => {
    const user = userEvent.setup();
    await renderJoin();
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    const heading = await screen.findByRole('heading', { name: /signed up/i });
    expect(heading.textContent).toBe(`Thanks ${EM_DASH} you're signed up!`);
    expect(heading).toHaveFocus();
    expect(
      screen.getByText("We've got your info. A team member will text you about homes that fit your voucher."),
    ).toBeInTheDocument();
  });

  it('blocks submit when names are empty (validation)', async () => {
    const user = userEvent.setup();
    await renderJoin();

    await user.type(screen.getByLabelText(/phone number/i), '4045559999');
    await user.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(/first and last name/i);
    expect(submitHousingFair).not.toHaveBeenCalled();
  });

  it('blocks submit when the phone is empty (validation)', async () => {
    const user = userEvent.setup();
    await renderJoin();

    await user.type(screen.getByLabelText(/first name/i), 'Grace');
    await user.type(screen.getByLabelText(/last name/i), 'Hopper');
    await user.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(/phone number/i);
    expect(submitHousingFair).not.toHaveBeenCalled();
  });

  it('marks name + phone fields required (aria-required) and associates the error', async () => {
    const user = userEvent.setup();
    await renderJoin();

    for (const name of [/first name/i, /last name/i, /phone number/i]) {
      expect(screen.getByLabelText(name)).toHaveAttribute('aria-required', 'true');
    }
    // The optional voucher field is NOT required.
    expect(screen.getByLabelText(/voucher size/i)).not.toHaveAttribute('aria-required', 'true');

    // On a validation error the field is marked invalid + describes the alert.
    await user.click(sendButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('id');
    const errorId = alert.getAttribute('id')!;
    const first = screen.getByLabelText(/first name/i);
    expect(first).toHaveAttribute('aria-invalid', 'true');
    expect(first).toHaveAttribute('aria-describedby', errorId);
  });

  it('clears the validation error as soon as the user edits a field', async () => {
    const user = userEvent.setup();
    await renderJoin();

    await user.click(sendButton());
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    // Editing any field clears the standing error (corrected field stops erroring).
    await user.type(screen.getByLabelText(/first name/i), 'G');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/first name/i)).toHaveAttribute('aria-invalid', 'false');
  });
});

describe('the "Housing authority" select (join-housing-authority D8)', () => {
  it('reads the list once on mount and preselects Atlanta Housing Authority; the options are the names in order, then "Not sure"', async () => {
    await renderJoin();

    expect(getHousingAuthorities).toHaveBeenCalledTimes(1);
    const select = authoritySelect();
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveValue('Atlanta Housing Authority');
    expect(select).toHaveDisplayValue('Atlanta Housing Authority');
    expect(optionLabels(select)).toEqual([...NAMES, 'Not sure']);
  });

  it('is described by its help text and sits after "Voucher size", before the consent box', async () => {
    await renderJoin();
    const select = authoritySelect();

    expect(select).toHaveAccessibleDescription(HELP);
    const voucher = screen.getByLabelText(/voucher size/i);
    expect(voucher.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(select.compareDocumentPosition(consentBox()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sends the default "Atlanta Housing Authority" when left alone', async () => {
    const user = userEvent.setup();
    await renderJoin();
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(1));
    expect(submitHousingFair.mock.calls[0]![0]).toMatchObject({ housingAuthority: 'Atlanta Housing Authority' });
  });

  it("sends the chosen authority's exact name", async () => {
    const user = userEvent.setup();
    await renderJoin();
    await user.selectOptions(authoritySelect(), 'DeKalb Housing Authority');
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(1));
    expect(submitHousingFair.mock.calls[0]![0]).toMatchObject({ housingAuthority: 'DeKalb Housing Authority' });
  });

  it('"Not sure" sends no housingAuthority', async () => {
    const user = userEvent.setup();
    await renderJoin();
    await user.selectOptions(authoritySelect(), 'Not sure');
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(1));
    expect(submitHousingFair.mock.calls[0]![0]).not.toHaveProperty('housingAuthority');
  });

  it('defaults to "Not sure" when "Atlanta Housing Authority" is not an exact listed name', async () => {
    const user = userEvent.setup();
    getHousingAuthorities.mockResolvedValue(['Atlanta Housing Authority (AHA)', 'DeKalb Housing Authority']);
    await renderJoin();

    expect(authoritySelect()).toHaveDisplayValue('Not sure');
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());
    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(1));
    expect(submitHousingFair.mock.calls[0]![0]).not.toHaveProperty('housingAuthority');
  });

  it('while the list loads: the select is disabled and shows "Loading...", and send is blocked', () => {
    getHousingAuthorities.mockImplementation(() => new Promise<string[]>(() => {}));
    render(<HousingFairIntake />);
    const select = authoritySelect();

    expect(select).toBeDisabled();
    expect(select).toHaveDisplayValue('Loading...');
    expect(optionLabels(select)).toEqual(['Loading...']);
    expect(select).toHaveAccessibleDescription(HELP);
    expect(sendButton()).toBeDisabled();
  });

  it('a failed read (a 429 included) leaves only "Not sure" and the note, and the sign-up still works with no authority', async () => {
    const user = userEvent.setup();
    getHousingAuthorities.mockRejectedValue(
      new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' }),
    );
    await renderJoin();
    const select = authoritySelect();

    expect(select).toBeEnabled();
    expect(select).toHaveDisplayValue('Not sure');
    expect(optionLabels(select)).toEqual(['Not sure']);
    expect(screen.getByText(FAILED_NOTE)).toBeInTheDocument();
    expect(select).toHaveAccessibleDescription(`${HELP} ${FAILED_NOTE}`);

    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());
    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(1));
    expect(submitHousingFair.mock.calls[0]![0]).not.toHaveProperty('housingAuthority');
    expect(await screen.findByRole('heading', { name: /signed up/i })).toBeInTheDocument();
  });

  it('gives up after 10 seconds: aborts the read, then only "Not sure", the note, and send allowed', async () => {
    // src/test/setup.ts pins Date globally; release that pin before taking FULL
    // fake timers, per the convention documented there.
    vi.useRealTimers();
    vi.useFakeTimers();
    try {
      getHousingAuthorities.mockImplementation(() => new Promise<string[]>(() => {}));
      render(<HousingFairIntake />);
      const select = authoritySelect();
      const signal = getHousingAuthorities.mock.calls[0]![0] as AbortSignal;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_999);
      });
      expect(select).toBeDisabled();
      expect(select).toHaveDisplayValue('Loading...');
      expect(sendButton()).toBeDisabled();
      expect(signal.aborted).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(signal.aborted).toBe(true);
      expect(select).toBeEnabled();
      expect(select).toHaveDisplayValue('Not sure');
      expect(optionLabels(select)).toEqual(['Not sure']);
      expect(screen.getByText(FAILED_NOTE)).toBeInTheDocument();
      expect(sendButton()).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the list read on unmount', () => {
    getHousingAuthorities.mockImplementation(() => new Promise<string[]>(() => {}));
    const { unmount } = render(<HousingFairIntake />);
    const signal = getHousingAuthorities.mock.calls[0]![0] as AbortSignal;

    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("survives React StrictMode: the cleaned-up first read is ignored and the second read fills the select", async () => {
    const second = deferred<string[]>();
    getHousingAuthorities
      .mockImplementationOnce((signal?: AbortSignal) => abortableNever(signal))
      .mockImplementationOnce(() => second.promise);
    render(
      <StrictMode>
        <HousingFairIntake />
      </StrictMode>,
    );
    // Let the first run's abort rejection land.
    await act(async () => {});

    expect(getHousingAuthorities).toHaveBeenCalledTimes(2);
    expect((getHousingAuthorities.mock.calls[0]![0] as AbortSignal).aborted).toBe(true);
    expect((getHousingAuthorities.mock.calls[1]![0] as AbortSignal).aborted).toBe(false);
    // The aborted first read must NOT have put the select into the failed state.
    const select = authoritySelect();
    expect(select).toBeDisabled();
    expect(select).toHaveDisplayValue('Loading...');
    expect(screen.queryByText(FAILED_NOTE)).toBeNull();

    await act(async () => {
      second.resolve(NAMES);
    });
    expect(select).toBeEnabled();
    expect(select).toHaveDisplayValue('Atlanta Housing Authority');
    expect(sendButton()).toBeEnabled();
  });

  it('disables the select while the sign-up is sending', async () => {
    const user = userEvent.setup();
    const send = deferred<void>();
    submitHousingFair.mockImplementation(() => send.promise);
    await renderJoin();
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    await waitFor(() => expect(authoritySelect()).toBeDisabled());
    await act(async () => {
      send.resolve();
    });
    expect(await screen.findByRole('heading', { name: /signed up/i })).toBeInTheDocument();
  });
});
