// HousingFair (public) tests — success confirmation, empty-field validation,
// and the 429 rate-limit message. Mock the api barrel (stub submitHousingFair).
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { submitHousingFairMock } = vi.hoisted(() => ({ submitHousingFairMock: vi.fn() }));

vi.mock('../../api/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../../api/index.js')>();
  return { ...actual, submitHousingFair: submitHousingFairMock };
});

const { default: HousingFair } = await import('../HousingFair.js');

function fill(): void {
  // The labels carry a required-marker span, so match by regex (substring).
  fireEvent.change(screen.getByLabelText(/First name/), { target: { value: 'Pat' } });
  fireEvent.change(screen.getByLabelText(/Last name/), { target: { value: 'Doe' } });
  fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '(555) 555-1234' } });
}

beforeEach(() => {
  submitHousingFairMock.mockReset();
});

describe('<HousingFair> (public)', () => {
  it('submits and shows the thanks confirmation', async () => {
    submitHousingFairMock.mockResolvedValue({ ok: true });
    render(<HousingFair />);

    fill();
    fireEvent.change(screen.getByLabelText('Voucher size (optional)'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /sign me up/i }));

    expect(await screen.findByText(/thanks, we'll text you/i)).toBeInTheDocument();
    expect(submitHousingFairMock).toHaveBeenCalledWith({
      firstName: 'Pat',
      lastName: 'Doe',
      phone: '(555) 555-1234',
      voucherSize: 2,
    });
  });

  it('validates required fields before submitting', () => {
    render(<HousingFair />);
    fireEvent.click(screen.getByRole('button', { name: /sign me up/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/first name, last name, and phone/i);
    expect(submitHousingFairMock).not.toHaveBeenCalled();
  });

  it('shows the rate-limit message on 429', async () => {
    const { ApiError } = await import('../../api/index.js');
    submitHousingFairMock.mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'rate_limited'));
    render(<HousingFair />);

    fill();
    fireEvent.click(screen.getByRole('button', { name: /sign me up/i }));

    expect(await screen.findByText(/try again in a moment/i)).toBeInTheDocument();
  });

  it('shows a validation message on 400', async () => {
    const { ApiError } = await import('../../api/index.js');
    submitHousingFairMock.mockRejectedValueOnce(new ApiError(400, 'invalid request', 'invalid request'));
    render(<HousingFair />);

    fill();
    fireEvent.click(screen.getByRole('button', { name: /sign me up/i }));

    expect(await screen.findByText(/didn’t look quite right/i)).toBeInTheDocument();
  });
});
