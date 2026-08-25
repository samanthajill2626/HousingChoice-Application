// ErrorTrace tests - the correlation trace timeline behind one error row.
// Mocks the api barrel's getSystemTrace (never a bare vi.fn(): a mock with no
// resolved value returns undefined and kills the hook on .then()). Covers the
// merged ordering + source chips, the anchor found by REF and marked by TEXT,
// the abort when the view is hidden mid-flight, the per-side
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

/** The anchor row's timestamp: bounds the QUERY. */
const AT = '2026-08-24T10:00:00.000Z';
/** The anchor row's ref: marks the anchor LINE, exactly. */
const ANCHOR_REF = 'PTR-ANCHOR';

const line = (
  timestamp: string,
  message: string,
  source: 'app' | 'worker' = 'app',
  ref = `PTR-${message}`,
) => ({
  timestamp,
  level: 30,
  message,
  source,
  ref,
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
    render(<ErrorTrace kind="pollRunId" id="p-1" at={AT} anchorRef={ANCHOR_REF} />);
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
    render(<ErrorTrace kind="requestId" id="r-1" at={AT} anchorRef={ANCHOR_REF} />);
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!).toHaveTextContent('job started');
    expect(items[1]!).toHaveTextContent('job failed: relay.warm');
    expect(screen.getAllByText('worker')).toHaveLength(2);
  });

  it('marks the anchor row by TEXT, not colour alone', async () => {
    mockTrace({
      available: true,
      lines: [
        line('2026-08-24T09:59:59.000Z', 'before'),
        line('2026-08-24T10:00:00.000Z', 'the failure', 'app', ANCHOR_REF),
      ],
      truncatedBefore: false,
      truncatedAfter: false,
    });
    render(<ErrorTrace kind="requestId" id="r-1" at={AT} anchorRef={ANCHOR_REF} />);
    expect(await screen.findByText('this failure')).toBeInTheDocument();
  });

  it('marks the anchor by REF, so two lines in the SAME millisecond get ONE marker', async () => {
    // The interleaved case this view exists to show: an app line and a worker
    // line under one requestId, logged in the same millisecond. Only one of
    // them IS the failure the operator clicked.
    mockTrace({
      available: true,
      lines: [
        line(AT, 'the failure', 'worker', ANCHOR_REF),
        line(AT, 'a sibling line in the same ms', 'app', 'PTR-OTHER'),
      ],
      truncatedBefore: false,
      truncatedAfter: false,
    });
    render(<ErrorTrace kind="requestId" id="r-1" at={AT} anchorRef={ANCHOR_REF} />);
    expect(await screen.findAllByText('this failure')).toHaveLength(1);
    const items = screen.getAllByRole('listitem');
    expect(items[0]!).toHaveTextContent('this failure');
    expect(items[1]!).not.toHaveTextContent('this failure');
  });

  it('aborts the in-flight query when the trace is hidden before it lands', async () => {
    // Hiding the trace unmounts this component. The pair of Insights queries
    // behind it must not outlive the view nobody is waiting on any more.
    getSystemTrace.mockImplementation(() => new Promise(() => {}));
    const { unmount } = render(<ErrorTrace kind="requestId" id="r-1" at={AT} anchorRef={ANCHOR_REF} />);
    await waitFor(() => expect(getSystemTrace).toHaveBeenCalled());
    const signal = getSystemTrace.mock.calls[0]![3] as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('surfaces per-side truncation', async () => {
    mockTrace({
      available: true,
      lines: [line(AT, 'x')],
      truncatedBefore: true,
      truncatedAfter: false,
    });
    render(<ErrorTrace kind="requestId" id="r-1" at={AT} anchorRef={ANCHOR_REF} />);
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
    render(<ErrorTrace kind="requestId" id="r-1" at={AT} anchorRef={ANCHOR_REF} />);
    expect(await screen.findByText(/Later lines were cut off/i)).toBeInTheDocument();
    expect(screen.queryByText(/Earlier lines were cut off/i)).toBeNull();
  });

  it('distinguishes an EMPTY trace from a DEGRADED one', async () => {
    mockTrace({ available: true, lines: [], truncatedBefore: false, truncatedAfter: false });
    const { unmount } = render(<ErrorTrace kind="requestId" id="r-1" at={AT} anchorRef={ANCHOR_REF} />);
    expect(await screen.findByText(/No lines found/i)).toBeInTheDocument();
    expect(screen.queryByText(/Available in deployed environments/i)).toBeNull();
    unmount();

    mockTrace({ available: false, reason: 'unavailable_local' });
    render(<ErrorTrace kind="requestId" id="r-1" at={AT} anchorRef={ANCHOR_REF} />);
    expect(await screen.findByText(/Available in deployed environments/i)).toBeInTheDocument();
    expect(screen.queryByText(/No lines found/i)).toBeNull();
  });

  it('a true fetch failure reads as an alert, not as an empty trace', async () => {
    getSystemTrace.mockRejectedValue(new ApiError(500, 'server_error', 'boom'));
    render(<ErrorTrace kind="requestId" id="r-1" at={AT} anchorRef={ANCHOR_REF} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn't load the trace/i);
    expect(screen.queryByText(/No lines found/i)).toBeNull();
  });
});
