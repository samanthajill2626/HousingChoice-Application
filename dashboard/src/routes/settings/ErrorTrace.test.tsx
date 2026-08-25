// ErrorTrace tests - the correlation trace timeline behind one error row.
// Mocks the api barrel's getSystemTrace (never a bare vi.fn(): a mock with no
// resolved value returns undefined and kills the hook on .then()). Covers the
// merged ordering + source chips, the anchor marked by TEXT, the per-side
// truncation notices, and the DISTINCT empty vs degraded copy - an empty trace
// that reads as a blank panel is the failure mode this view exists to avoid.
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { SystemTraceResult } from '../../api/index.js';

const getSystemTrace = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getSystemTrace: (...a: unknown[]) => getSystemTrace(...a),
  };
});

import { ErrorTrace } from './ErrorTrace.js';

/** The anchor row's timestamp: bounds the query AND marks the anchor line. */
const AT = '2026-08-24T10:00:00.000Z';

const line = (timestamp: string, message: string, source: 'app' | 'worker' = 'app') => ({
  timestamp,
  level: 30,
  message,
  source,
});

/** Set what the mocked barrel read resolves with. Never a bare vi.fn(). */
function mockTrace(result: SystemTraceResult): void {
  getSystemTrace.mockResolvedValue(result);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTrace({ available: false, reason: 'unavailable_local' });
});
afterEach(() => vi.restoreAllMocks());

describe('ErrorTrace', () => {
  it('loads the trace for the pivot it was given', async () => {
    mockTrace({ available: true, lines: [line(AT, 'x')], truncatedBefore: false, truncatedAfter: false });
    render(<ErrorTrace kind="pollRunId" id="p-1" at={AT} />);
    await waitFor(() =>
      expect(getSystemTrace).toHaveBeenCalledWith('pollRunId', 'p-1', AT, expect.anything()),
    );
  });

  it('renders lines in the order given, each with a source chip', async () => {
    mockTrace({
      available: true,
      lines: [
        line('2026-08-24T09:59:59.000Z', 'job started', 'worker'),
        line('2026-08-24T10:00:00.000Z', 'job failed: relay.warm', 'worker'),
      ],
      truncatedBefore: false,
      truncatedAfter: false,
    });
    render(<ErrorTrace kind="requestId" id="r-1" at={AT} />);
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!).toHaveTextContent('job started');
    expect(items[1]!).toHaveTextContent('job failed: relay.warm');
    expect(screen.getAllByText('worker')).toHaveLength(2);
  });

  it('marks the anchor row by TEXT, not colour alone', async () => {
    mockTrace({
      available: true,
      lines: [line('2026-08-24T09:59:59.000Z', 'before'), line('2026-08-24T10:00:00.000Z', 'the failure')],
      truncatedBefore: false,
      truncatedAfter: false,
    });
    render(<ErrorTrace kind="requestId" id="r-1" at={AT} />);
    expect(await screen.findByText('this failure')).toBeInTheDocument();
  });

  it('surfaces per-side truncation', async () => {
    mockTrace({
      available: true,
      lines: [line(AT, 'x')],
      truncatedBefore: true,
      truncatedAfter: false,
    });
    render(<ErrorTrace kind="requestId" id="r-1" at={AT} />);
    expect(await screen.findByText(/Earlier lines were cut off/i)).toBeInTheDocument();
    expect(screen.queryByText(/Later lines were cut off/i)).toBeNull();
  });

  it('surfaces truncation on the AFTER side too', async () => {
    mockTrace({
      available: true,
      lines: [line(AT, 'x')],
      truncatedBefore: false,
      truncatedAfter: true,
    });
    render(<ErrorTrace kind="requestId" id="r-1" at={AT} />);
    expect(await screen.findByText(/Later lines were cut off/i)).toBeInTheDocument();
    expect(screen.queryByText(/Earlier lines were cut off/i)).toBeNull();
  });

  it('distinguishes an EMPTY trace from a DEGRADED one', async () => {
    mockTrace({ available: true, lines: [], truncatedBefore: false, truncatedAfter: false });
    const { unmount } = render(<ErrorTrace kind="requestId" id="r-1" at={AT} />);
    expect(await screen.findByText(/No lines found/i)).toBeInTheDocument();
    expect(screen.queryByText(/Available in deployed environments/i)).toBeNull();
    unmount();

    mockTrace({ available: false, reason: 'unavailable_local' });
    render(<ErrorTrace kind="requestId" id="r-1" at={AT} />);
    expect(await screen.findByText(/Available in deployed environments/i)).toBeInTheDocument();
    expect(screen.queryByText(/No lines found/i)).toBeNull();
  });

  it('a true fetch failure reads as an alert, not as an empty trace', async () => {
    getSystemTrace.mockRejectedValue(new ApiError(500, 'server_error', 'boom'));
    render(<ErrorTrace kind="requestId" id="r-1" at={AT} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn't load the trace/i);
    expect(screen.queryByText(/No lines found/i)).toBeNull();
  });
});
