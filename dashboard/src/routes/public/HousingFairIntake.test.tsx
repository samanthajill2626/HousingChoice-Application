// HousingFairIntake (/join) tests (spec §9) — the standalone intake works with
// NO unit: a successful submit (no unitId) → a generic thank-you, no reveal.
// Plus IntakeForm client validation (empty name / phone blocked). Public API
// module mocked.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const submitHousingFair = vi.fn();
vi.mock('./publicApi.js', async () => {
  const actual = await vi.importActual<typeof import('./publicApi.js')>('./publicApi.js');
  return { ...actual, submitHousingFair: (...a: unknown[]) => submitHousingFair(...a) };
});

import { HousingFairIntake } from './HousingFairIntake.js';

beforeEach(() => vi.clearAllMocks());

describe('HousingFairIntake (/join)', () => {
  it('submits WITHOUT a unitId and shows a generic thank-you (no reveal)', async () => {
    const user = userEvent.setup();
    submitHousingFair.mockResolvedValue(undefined);
    render(<HousingFairIntake />);

    await user.type(screen.getByLabelText(/first name/i), 'Grace');
    await user.type(screen.getByLabelText(/last name/i), 'Hopper');
    await user.type(screen.getByLabelText(/phone number/i), '4045559999');
    await user.click(screen.getByRole('button', { name: /sign me up/i }));

    await waitFor(() => expect(submitHousingFair).toHaveBeenCalled());
    const arg = submitHousingFair.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('unitId');
    expect(arg).toMatchObject({ firstName: 'Grace', lastName: 'Hopper', phone: '4045559999' });

    expect(await screen.findByText(/you're signed up/i)).toBeInTheDocument();
    // No reveal: no address/details ever shown on /join.
    expect(screen.queryByText(/address/i)).not.toBeInTheDocument();
  });

  it('blocks submit when names are empty (validation)', async () => {
    const user = userEvent.setup();
    render(<HousingFairIntake />);

    await user.type(screen.getByLabelText(/phone number/i), '4045559999');
    await user.click(screen.getByRole('button', { name: /sign me up/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/first and last name/i);
    expect(submitHousingFair).not.toHaveBeenCalled();
  });

  it('blocks submit when the phone is empty (validation)', async () => {
    const user = userEvent.setup();
    render(<HousingFairIntake />);

    await user.type(screen.getByLabelText(/first name/i), 'Grace');
    await user.type(screen.getByLabelText(/last name/i), 'Hopper');
    await user.click(screen.getByRole('button', { name: /sign me up/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/phone number/i);
    expect(submitHousingFair).not.toHaveBeenCalled();
  });
});
