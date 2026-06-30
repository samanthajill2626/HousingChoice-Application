// RecentErrors tests — recent error events (doc §6). A labeled window selector
// (1h/24h/7d, default 24h) drives the query; available:true renders the PII-SAFE
// projection ONLY (timestamp + level + message + correlationId); an empty list is
// a friendly empty state; available:false renders the degraded notice. Mocks
// getSystemErrors.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { SystemErrorsResult } from '../../api/index.js';

const getSystemErrors = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getSystemErrors: (...a: unknown[]) => getSystemErrors(...a),
  };
});

import { RecentErrors } from './RecentErrors.js';

const available = (events: SystemErrorsResult['events']): SystemErrorsResult => ({ available: true, events });

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('RecentErrors — window selector', () => {
  it('defaults to the 24h window on first load', async () => {
    getSystemErrors.mockResolvedValue(available([]));
    render(<RecentErrors />);
    await waitFor(() => expect(getSystemErrors).toHaveBeenCalled());
    // First arg is the window; defaults to 24h.
    expect(getSystemErrors.mock.calls[0]![0]).toBe('24h');
    expect((screen.getByLabelText('Window') as HTMLSelectElement).value).toBe('24h');
  });

  it('changing the window re-queries with the new value (1h / 7d)', async () => {
    getSystemErrors.mockResolvedValue(available([]));
    render(<RecentErrors />);
    await waitFor(() => expect(getSystemErrors).toHaveBeenCalled());
    const select = screen.getByLabelText('Window');

    await userEvent.setup().selectOptions(select, '1h');
    await waitFor(() => expect(getSystemErrors.mock.calls.some((c) => c[0] === '1h')).toBe(true));

    await userEvent.setup().selectOptions(select, '7d');
    await waitFor(() => expect(getSystemErrors.mock.calls.some((c) => c[0] === '7d')).toBe(true));
  });
});

describe('RecentErrors — available:true rendering (PII-safe)', () => {
  it('renders timestamp + level + message + correlationId ONLY', async () => {
    getSystemErrors.mockResolvedValue(
      available([
        { timestamp: '2026-06-29T03:00:00.000Z', level: 60, message: 'fatal boom', correlationId: 'corr-9' },
        { timestamp: '2026-06-29T02:00:00.000Z', level: 50, message: 'just an error', correlationId: null },
      ]),
    );
    render(<RecentErrors />);

    expect(await screen.findByText('fatal boom')).toBeInTheDocument();
    expect(screen.getByText('just an error')).toBeInTheDocument();
    // Level → human label.
    expect(screen.getByText('fatal')).toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument();
    // correlationId shown when present, omitted when null.
    expect(screen.getByText(/id:\s*corr-9/)).toBeInTheDocument();
    // Only ONE correlation line (the null one renders none).
    expect(screen.getAllByText(/^id:/)).toHaveLength(1);
  });

  it('renders a friendly empty state for an empty window', async () => {
    getSystemErrors.mockResolvedValue(available([]));
    render(<RecentErrors />);
    expect(await screen.findByText(/No recent errors in this window/i)).toBeInTheDocument();
  });

  it('a manual ↻ Refresh refetches', async () => {
    getSystemErrors.mockResolvedValue(available([]));
    render(<RecentErrors />);
    await waitFor(() => expect(getSystemErrors).toHaveBeenCalled());
    const before = getSystemErrors.mock.calls.length;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh recent errors' }));
    await waitFor(() => expect(getSystemErrors.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('RecentErrors — degraded / error', () => {
  it('available:false renders the degraded notice (not an error)', async () => {
    getSystemErrors.mockResolvedValue({ available: false, reason: 'unavailable_local' });
    render(<RecentErrors />);
    expect(await screen.findByText('Available in deployed environments.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a true fetch failure shows an error block + Retry', async () => {
    getSystemErrors.mockRejectedValue(new ApiError(500, 'server_error', 'boom'));
    render(<RecentErrors />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn't load recent errors/i);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
