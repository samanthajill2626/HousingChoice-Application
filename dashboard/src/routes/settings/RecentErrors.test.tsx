// RecentErrors tests — recent error events (doc §6). A labeled window selector
// (1h/24h/7d, default 24h) drives the query; available:true renders the widened
// row (timestamp, level, source, job/event, error type + code, message,
// errMessage, correlationId) plus its "Show all" record expander and "Trace"
// pivot; an empty list is a friendly empty state; available:false renders the
// degraded notice. The panel is admin-only and a row MAY carry PII (deliberate,
// 2026-08-24), so nothing here asserts a redaction. Mocks getSystemErrors,
// getSystemErrorDetail and getSystemTrace.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { SystemErrorEvent, SystemErrorsResult } from '../../api/index.js';

const getSystemErrors = vi.fn();
const getSystemErrorDetail = vi.fn();
const getSystemTrace = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getSystemErrors: (...a: unknown[]) => getSystemErrors(...a),
    getSystemErrorDetail: (...a: unknown[]) => getSystemErrorDetail(...a),
    getSystemTrace: (...a: unknown[]) => getSystemTrace(...a),
  };
});

import { RecentErrors } from './RecentErrors.js';

const available = (events: SystemErrorsResult['events']): SystemErrorsResult => ({ available: true, events });

/** Render the panel with a fixed list of rows. RecentErrors takes NO props - it
 *  self-fetches, so rows arrive by resolving the mocked read. Always await the
 *  first row (or another post-fetch assertion) before querying. */
function renderRows(events: SystemErrorEvent[]): ReturnType<typeof render> {
  getSystemErrors.mockResolvedValue(available(events));
  return render(<RecentErrors />);
}

beforeEach(() => {
  vi.clearAllMocks();
  // The on-demand row reads default to the degraded shape. NEVER leave these as
  // bare vi.fn()s: an unset mock resolves undefined and kills the hook's .then()
  // (the conversationdetail-members-mock-suite-flake failure mode).
  getSystemErrorDetail.mockResolvedValue({ available: false, reason: 'unavailable_local' });
  getSystemTrace.mockResolvedValue({ available: false, reason: 'unavailable_local' });
});
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

  it('defaults to warnings OFF, and toggling "Include warnings" re-queries with the flag on', async () => {
    getSystemErrors.mockResolvedValue(available([]));
    render(<RecentErrors />);
    await waitFor(() => expect(getSystemErrors).toHaveBeenCalled());
    // 2nd arg is includeWarnings — off by default.
    expect(getSystemErrors.mock.calls[0]![1]).toBe(false);

    await userEvent.setup().click(screen.getByLabelText('Include warnings'));
    await waitFor(() => expect(getSystemErrors.mock.calls.some((c) => c[1] === true)).toBe(true));
  });
});

describe('RecentErrors - available:true rendering', () => {
  it('renders timestamp + level + message + correlationId ONLY', async () => {
    getSystemErrors.mockResolvedValue(
      available([
        {
          timestamp: '2026-06-29T03:00:00.000Z',
          level: 60,
          message: 'fatal boom',
          messageTruncated: false,
          correlationId: 'corr-9',
          errMessageTruncated: false,
          source: 'app',
          ref: 'PTR-A',
        },
        {
          timestamp: '2026-06-29T02:00:00.000Z',
          level: 50,
          message: 'just an error',
          messageTruncated: false,
          correlationId: null,
          errMessageTruncated: false,
          source: 'app',
          ref: 'PTR-B',
        },
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

  it('renders a warn-level Twilio delivery failure with its error code (30034) and a "warn" label', async () => {
    getSystemErrors.mockResolvedValue(
      available([
        {
          timestamp: '2026-07-21T20:04:31.000Z',
          level: 40,
          message: 'twilio relay-recipient delivery failed (undelivered/failed)',
          messageTruncated: false,
          correlationId: 'c-30034',
          errorCode: '30034',
          errMessageTruncated: false,
          source: 'app',
          ref: 'PTR-C',
        },
      ]),
    );
    render(<RecentErrors />);
    expect(await screen.findByText(/twilio relay-recipient delivery failed/)).toBeInTheDocument();
    // warn label (not "error") + the raw code chip so it's debuggable.
    expect(screen.getByText('warn')).toBeInTheDocument();
    expect(screen.getByText('error 30034')).toBeInTheDocument();
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

// --- The widened row: chips, truncation markers, expander, trace pivot -------

const base: SystemErrorEvent = {
  timestamp: '2026-08-24T10:00:00.000Z',
  level: 50,
  message: 'job failed: relay.warmNumber',
  messageTruncated: false,
  correlationId: 'c-1',
  errMessageTruncated: false,
  source: 'worker',
  ref: 'PTR-1',
};

describe('RecentErrors - the widened row', () => {
  it('renders the source chip for all four values (system reads as "host")', async () => {
    for (const [source, label] of [
      ['app', 'app'],
      ['worker', 'worker'],
      ['system', 'host'],
      ['unknown', 'unknown'],
    ] as const) {
      const { unmount } = renderRows([{ ...base, source, ref: `R-${source}` }]);
      expect(await screen.findByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it('renders a jobName chip when present, else the event chip', async () => {
    const { unmount } = renderRows([{ ...base, jobName: 'relay.warmNumber' }]);
    expect(await screen.findByText('relay.warmNumber')).toBeInTheDocument();
    unmount();

    renderRows([{ ...base, jobName: null, event: 'sms.send' }]);
    expect(await screen.findByText('sms.send')).toBeInTheDocument();
  });

  it('renders the errType chip when present', async () => {
    renderRows([{ ...base, errType: 'RestException' }]);
    expect(await screen.findByText('RestException')).toBeInTheDocument();
  });

  it('marks a truncated message', async () => {
    renderRows([{ ...base, messageTruncated: true }]);
    expect(await screen.findByText(/truncated/i)).toBeInTheDocument();
  });

  it('renders errMessage alongside message when they differ, with its own flag', async () => {
    renderRows([
      {
        ...base,
        message: 'job failed: relay.warmNumber',
        errMessage: 'RestException [HTTP 404]',
        errMessageTruncated: true,
      },
    ]);
    expect(await screen.findByText(/job failed: relay.warmNumber/)).toBeInTheDocument();
    expect(screen.getByText(/RestException \[HTTP 404\]/)).toBeInTheDocument();
    // ONE marker: message is not truncated, errMessage is - each flag is its own.
    expect(screen.getAllByText(/truncated/i)).toHaveLength(1);
  });

  it('does not render errMessage when the ladder already put it in message', async () => {
    renderRows([{ ...base, message: 'only this', errMessage: null }]);
    expect(await screen.findAllByText(/only this/)).toHaveLength(1);
  });

  it('keeps expander state per row (two same-looking rows do not share it)', async () => {
    const user = userEvent.setup();
    renderRows([
      { ...base, ref: 'PTR-1' },
      { ...base, ref: 'PTR-2' },
    ]);
    const toggles = await screen.findAllByRole('button', { name: /show all/i });
    expect(toggles).toHaveLength(2);

    await user.click(toggles[1]!);
    await waitFor(() => expect(getSystemErrorDetail).toHaveBeenCalledWith('PTR-2', expect.anything()));
    expect(toggles[0]!).toHaveAttribute('aria-expanded', 'false');
    expect(toggles[1]!).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggles the expander with aria-expanded, and loads the record on OPEN only', async () => {
    const user = userEvent.setup();
    renderRows([base]);
    const toggle = await screen.findByRole('button', { name: /show all/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(getSystemErrorDetail).toHaveBeenCalledWith('PTR-1', expect.anything()));
    expect(getSystemErrorDetail).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /hide details/i }));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Closing is not a read.
    expect(getSystemErrorDetail).toHaveBeenCalledTimes(1);
  });
});

describe('RecentErrors - the trace pivot', () => {
  it('prefers requestId, then pollRunId, then correlationId for the trace link', async () => {
    const user = userEvent.setup();
    const cases = [
      { row: { ...base, requestId: 'r-1', pollRunId: 'p-1' }, kind: 'requestId', id: 'r-1' },
      { row: { ...base, requestId: null, pollRunId: 'p-1' }, kind: 'pollRunId', id: 'p-1' },
      { row: { ...base, requestId: null, pollRunId: null }, kind: 'correlationId', id: 'c-1' },
    ];
    for (const { row, kind, id } of cases) {
      getSystemTrace.mockClear();
      const { unmount } = renderRows([row]);
      await user.click(await screen.findByRole('button', { name: /^trace$/i }));
      // The pivot also sends the ROW's timestamp as the anchor.
      await waitFor(() =>
        expect(getSystemTrace).toHaveBeenCalledWith(kind, id, base.timestamp, expect.anything()),
      );
      unmount();
    }
  });

  it('renders NO trace control when all three ids are null (the OOM row shape)', async () => {
    renderRows([{ ...base, correlationId: null }]);
    expect(await screen.findByText(/job failed: relay.warmNumber/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /trace/i })).toBeNull();
    // The expander is still there - the record itself is fetchable by ref.
    expect(screen.getByRole('button', { name: /show all/i })).toBeInTheDocument();
  });

  it('the trace hides again on a second click', async () => {
    const user = userEvent.setup();
    renderRows([{ ...base, requestId: 'r-1' }]);
    await user.click(await screen.findByRole('button', { name: /^trace$/i }));
    expect(await screen.findByText('Available in deployed environments.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /hide trace/i }));
    expect(screen.queryByText('Available in deployed environments.')).toBeNull();
  });
});

describe('RecentErrors - the expanded record', () => {
  const expand = async (): Promise<void> => {
    const user = userEvent.setup();
    renderRows([base]);
    await user.click(await screen.findByRole('button', { name: /show all/i }));
  };

  it('degrades with the local-stack notice for reason unavailable_local', async () => {
    await expand();
    expect(await screen.findByText('Available in deployed environments.')).toBeInTheDocument();
  });

  it('reads DIFFERENTLY for any other degraded reason', async () => {
    getSystemErrorDetail.mockResolvedValue({ available: false, reason: 'out_of_scope' });
    await expand();
    expect(await screen.findByText('Could not load the full record.')).toBeInTheDocument();
    expect(screen.queryByText('Available in deployed environments.')).toBeNull();
  });

  it('renders the fields, the stack, the raw text and BOTH truncation markers', async () => {
    getSystemErrorDetail.mockResolvedValue({
      available: true,
      record: {
        fields: {
          'err.type': 'RestException',
          'err.stack': 'Error: boom\n    at warmNumber (relay.ts:12:5)',
          level: '50',
        },
        rawText: '{"level":50,"msg":"job failed: relay.warmNumber"}',
        rawTextTruncated: true,
        responseTruncated: true,
        logGroup: '/hc/dev/worker',
      },
    });
    await expand();

    // Key/value list, sorted, with the stack pulled OUT into its own container.
    expect(await screen.findByText('err.type')).toBeInTheDocument();
    expect(screen.getByText('RestException')).toBeInTheDocument();
    expect(screen.getByText('level')).toBeInTheDocument();
    expect(screen.queryByText('err.stack')).toBeNull();
    expect(screen.getByText(/at warmNumber \(relay\.ts:12:5\)/)).toBeInTheDocument();
    expect(screen.getByText(/"msg":"job failed: relay.warmNumber"/)).toBeInTheDocument();
    // Every server-side flag is surfaced HERE; nothing else renders them.
    expect(screen.getByText(/Raw text was cut off/i)).toBeInTheDocument();
    expect(screen.getByText(/Some fields were cut off/i)).toBeInTheDocument();
    expect(screen.getByText(/hc\/dev\/worker/)).toBeInTheDocument();
  });

  it('omits the raw text and its marker when the record carried none', async () => {
    getSystemErrorDetail.mockResolvedValue({
      available: true,
      record: { fields: { level: '50' }, responseTruncated: false, logGroup: '/hc/dev/app' },
    });
    await expand();
    expect(await screen.findByText('level')).toBeInTheDocument();
    expect(screen.queryByText(/Raw text was cut off/i)).toBeNull();
    expect(screen.queryByText(/Some fields were cut off/i)).toBeNull();
  });
});
