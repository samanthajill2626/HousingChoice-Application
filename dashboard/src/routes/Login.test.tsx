// Login screen tests — the Google sign-in regression guard plus the dev-only
// "Continue as dev user" button. The dev button must FAIL CLOSED: it only
// renders once devPing() resolves available, and any error/unavailability keeps
// it absent. Mock the api barrel (keeping everything real but stubbing the two
// dev helpers); no network, no real navigation.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { devPingMock, devLoginMock } = vi.hoisted(() => ({
  devPingMock: vi.fn(),
  devLoginMock: vi.fn(),
}));

vi.mock('../api/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../api/index.js')>();
  return { ...actual, devPing: devPingMock, devLogin: devLoginMock };
});

const { default: Login } = await import('./Login.js');

const devButton = () => screen.queryByRole('button', { name: /dev user/i });

beforeEach(() => {
  devPingMock.mockReset();
  devLoginMock.mockReset();
  // Default: dev endpoint not available (fail closed).
  devPingMock.mockResolvedValue(false);
  devLoginMock.mockResolvedValue({ userId: 'u1', email: 'va@example.com', role: 'va' });
});

describe('<Login>', () => {
  it('always renders the Google sign-in link', () => {
    render(<Login />);
    const link = screen.getByRole('link', { name: /sign in with google/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/auth/login');
  });

  it('shows the dev button when the dev endpoint is available', async () => {
    devPingMock.mockResolvedValue(true);
    render(<Login />);
    expect(await screen.findByRole('button', { name: /dev user/i })).toBeInTheDocument();
  });

  it('never shows the dev button when the dev endpoint is unavailable', async () => {
    devPingMock.mockResolvedValue(false);
    render(<Login />);
    // Let the probe settle.
    await waitFor(() => expect(devPingMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(devButton()).toBeNull();
  });

  it('never shows the dev button when the probe throws', async () => {
    devPingMock.mockRejectedValue(new Error('network'));
    render(<Login />);
    await waitFor(() => expect(devPingMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(devButton()).toBeNull();
  });

  it('logs in as va@example.com and reloads into / on click', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, assign },
    });
    try {
      devPingMock.mockResolvedValue(true);
      render(<Login />);
      const btn = await screen.findByRole('button', { name: /dev user/i });
      fireEvent.click(btn);
      await waitFor(() => expect(devLoginMock).toHaveBeenCalledWith('va@example.com'));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('shows an error and does not navigate when dev-login fails', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, assign },
    });
    try {
      devPingMock.mockResolvedValue(true);
      devLoginMock.mockRejectedValue(new Error('unknown_dev_user'));
      render(<Login />);
      const btn = await screen.findByRole('button', { name: /dev user/i });
      fireEvent.click(btn);
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(assign).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});
