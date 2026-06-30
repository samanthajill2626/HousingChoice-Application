// AlarmGrid tests — the CloudWatch alarm list (doc §6). Alarms come ALARM-first
// from the server; the component renders them in that order (asserted by DOM
// order). A manual ↻ refetches; { available:false } renders the degraded notice.
// State is conveyed by TEXT badges (not colour alone). Mocks getSystemAlarms.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { SystemAlarmsResult } from '../../api/index.js';

const getSystemAlarms = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getSystemAlarms: (...a: unknown[]) => getSystemAlarms(...a),
  };
});

import { AlarmGrid } from './AlarmGrid.js';

const available = (alarms: SystemAlarmsResult['alarms']): SystemAlarmsResult => ({ available: true, alarms });

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('AlarmGrid — available:true', () => {
  it('renders alarms in the server order (ALARM-first) and shows state as TEXT', async () => {
    getSystemAlarms.mockResolvedValue(
      available([
        { name: 'hc-dev-5xx', state: 'ALARM', stateUpdatedAt: '2026-06-29T00:00:00.000Z' },
        { name: 'hc-dev-cpu', state: 'OK', stateUpdatedAt: '2026-06-29T00:00:00.000Z' },
        { name: 'hc-dev-lag', state: 'INSUFFICIENT_DATA', stateUpdatedAt: '' },
      ]),
    );
    render(<AlarmGrid />);

    await screen.findByText('hc-dev-5xx');
    const rows = screen.getAllByRole('listitem');
    // DOM order preserves the ALARM-first ordering from the server.
    expect(within(rows[0]!).getByText('hc-dev-5xx')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('In alarm')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('hc-dev-cpu')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('OK')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('No data')).toBeInTheDocument();
  });

  it('the manual ↻ Refresh button refetches the alarms', async () => {
    getSystemAlarms.mockResolvedValue(available([{ name: 'hc-dev-cpu', state: 'OK', stateUpdatedAt: '' }]));
    render(<AlarmGrid />);
    await screen.findByText('hc-dev-cpu');
    expect(getSystemAlarms).toHaveBeenCalledTimes(1);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh alarms' }));
    await waitFor(() => expect(getSystemAlarms).toHaveBeenCalledTimes(2));
  });

  it('renders a friendly empty state when there are no alarms', async () => {
    getSystemAlarms.mockResolvedValue(available([]));
    render(<AlarmGrid />);
    expect(await screen.findByText(/No alarms configured for this environment/i)).toBeInTheDocument();
  });

  it('exposes a POLITE live region announcing the firing count (a11y for silent auto-refresh)', async () => {
    getSystemAlarms.mockResolvedValue(
      available([
        { name: 'hc-dev-5xx', state: 'ALARM', stateUpdatedAt: '2026-06-29T00:00:00.000Z' },
        { name: 'hc-dev-cpu', state: 'OK', stateUpdatedAt: '2026-06-29T00:00:00.000Z' },
      ]),
    );
    render(<AlarmGrid />);
    await screen.findByText('hc-dev-5xx');

    const live = screen.getByTestId('alarm-status-line');
    // Polite (not assertive) so a refresh doesn't interrupt the screen reader.
    expect(live).toHaveAttribute('aria-live', 'polite');
    // Summarizes the firing count so an OK→ALARM swap on refresh is announced.
    expect(live).toHaveTextContent('1 alarm firing');
  });
});

describe('AlarmGrid — degraded / error', () => {
  it('available:false renders "Available in deployed environments."', async () => {
    getSystemAlarms.mockResolvedValue({ available: false, reason: 'unavailable_local' });
    render(<AlarmGrid />);
    expect(await screen.findByText('Available in deployed environments.')).toBeInTheDocument();
    // Not an error — no alert.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a true fetch failure shows an error block + Retry', async () => {
    getSystemAlarms.mockRejectedValue(new ApiError(500, 'server_error', 'boom'));
    render(<AlarmGrid />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn't load alarms/i);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('AlarmGrid — visibility auto-refresh wiring', () => {
  it('refetches on a visibilitychange back to visible (the 60s-while-visible mechanism)', async () => {
    getSystemAlarms.mockResolvedValue(available([{ name: 'hc-dev-cpu', state: 'OK', stateUpdatedAt: '' }]));
    render(<AlarmGrid />);
    await screen.findByText('hc-dev-cpu');
    expect(getSystemAlarms).toHaveBeenCalledTimes(1);

    // Simulate the tab being re-shown: the hook catches up immediately (a
    // background refresh) — proving the visibility wiring is in place without
    // waiting the full 60s interval.
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(getSystemAlarms.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
