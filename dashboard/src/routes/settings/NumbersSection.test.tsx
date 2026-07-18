// NumbersSection tests - the admin "Group text numbers" inventory (pool numbers).
// Covers the table render (mocked listPoolNumbers), the four retirement-cell
// variants, the state filter chips (default active+releasing / Released / All),
// row expansion into group rows that link to the conversation thread, both empty
// states, the error + Retry path, and the VA bounce via AdminRoute. Rows render
// react-router <Link>s, so every render is wrapped in <MemoryRouter>.
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { PoolNumberGroupRow, PoolNumberRow } from '../../api/index.js';

const listPoolNumbers = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    listPoolNumbers: (...a: unknown[]) => listPoolNumbers(...a),
  };
});

// Track the viewer's admin flag so the AdminRoute bounce test can flip it.
let viewerIsAdmin = true;
vi.mock('../../app/AuthContext.js', () => ({
  useAuth: () => ({
    status: 'authenticated',
    me: { userId: 'viewer', email: 'viewer@example.com', role: viewerIsAdmin ? 'admin' : 'va' },
    isAdmin: viewerIsAdmin,
    refresh: vi.fn(),
  }),
}));

import { NumbersSection } from './NumbersSection.js';
import { AdminRoute } from './AdminRoute.js';

function group(overrides: Partial<PoolNumberGroupRow> = {}): PoolNumberGroupRow {
  return {
    conversationId: 'conv-1',
    label: 'With Ann A',
    memberCount: 2,
    status: 'open',
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function numberRow(overrides: Partial<PoolNumberRow> = {}): PoolNumberRow {
  return {
    number: '+15550190001',
    state: 'active',
    openGroups: 0,
    totalGroups: 0,
    burnedCount: 0,
    retire: { eligible: false },
    groups: [],
    ...overrides,
  };
}

// Desktop viewport (matches=false) - defensive stub; jsdom has no matchMedia.
function stubDesktop(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function renderSection(): void {
  render(
    <MemoryRouter>
      <NumbersSection />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  viewerIsAdmin = true;
  stubDesktop();
});
afterEach(() => vi.unstubAllGlobals());

describe('NumbersSection - table', () => {
  it('renders a row per pool number with the formatted number, state and counts', async () => {
    listPoolNumbers.mockResolvedValue([
      numberRow({
        number: '+15550190001',
        state: 'active',
        openGroups: 1,
        totalGroups: 3,
        burnedCount: 4,
      }),
    ]);
    renderSection();

    expect(await screen.findByText('(555) 019-0001')).toBeInTheDocument();
    const table = screen.getByRole('table');
    // Column headers (the expander column carries an sr-only "Groups" label).
    for (const name of [
      'Groups',
      'Number',
      'State',
      'Open groups',
      'Total groups',
      'People burned',
      'Last activity',
      'Last closed',
      'Retirement',
    ]) {
      expect(within(table).getByRole('columnheader', { name })).toBeInTheDocument();
    }
    const row = screen.getByText('(555) 019-0001').closest('tr') as HTMLTableRowElement;
    expect(within(row).getByText('active')).toBeInTheDocument();
    expect(within(row).getByText('1')).toBeInTheDocument(); // open groups
    expect(within(row).getByText('3')).toBeInTheDocument(); // total groups
    expect(within(row).getByText('4')).toBeInTheDocument(); // people burned
  });

  it('renders all four retirement-cell variants', async () => {
    listPoolNumbers.mockResolvedValue([
      // Eligible.
      numberRow({ number: '+15550190001', retire: { eligible: true }, totalGroups: 2 }),
      // Counting down.
      numberRow({ number: '+15550190002', retire: { eligible: false, daysRemaining: 12 } }),
      // Idle with an open group -> no countdown, not released -> "-".
      numberRow({ number: '+15550190003', openGroups: 1, totalGroups: 1, retire: { eligible: false } }),
      // Released.
      numberRow({
        number: '+15550190004',
        state: 'released',
        releasedAt: '2026-01-01T00:00:00.000Z',
        retire: { eligible: false },
      }),
    ]);
    render(
      <MemoryRouter>
        <NumbersSection />
      </MemoryRouter>,
    );
    // Switch to "All" so the released row is visible alongside the active ones.
    await screen.findByText('(555) 019-0001');
    await userEvent.click(screen.getByRole('button', { name: 'All' }));

    const retireCell = (num: string): HTMLElement => {
      const row = screen.getByText(num).closest('tr') as HTMLTableRowElement;
      const cells = within(row).getAllByRole('cell');
      return cells[cells.length - 1] as HTMLElement;
    };
    expect(retireCell('(555) 019-0001')).toHaveTextContent('Eligible');
    expect(retireCell('(555) 019-0002')).toHaveTextContent('12d remaining');
    expect(retireCell('(555) 019-0003')).toHaveTextContent('-');
    // Timezone-robust: a real formatted date always carries a 4-digit year
    // (proving the "Released <date>" branch, not the "Released -" fallback).
    expect(retireCell('(555) 019-0004')).toHaveTextContent(/^Released .*\d{4}/);
  });

  it('formats absent last-activity / last-closed stamps as "-"', async () => {
    listPoolNumbers.mockResolvedValue([
      numberRow({ number: '+15550190001', lastActivityAt: undefined, lastGroupClosedAt: undefined }),
    ]);
    renderSection();
    const row = (await screen.findByText('(555) 019-0001')).closest('tr') as HTMLTableRowElement;
    // Last activity + Last closed + Retirement all render the ASCII placeholder.
    expect(within(row).getAllByText('-').length).toBeGreaterThanOrEqual(2);
  });
});

describe('NumbersSection - state filter chips', () => {
  const rows = (): PoolNumberRow[] => [
    numberRow({ number: '+15550190001', state: 'active' }),
    numberRow({ number: '+15550190002', state: 'releasing' }),
    numberRow({ number: '+15550190003', state: 'released', releasedAt: '2026-01-01T00:00:00.000Z' }),
  ];

  it('defaults to Active (shows active + releasing, hides released)', async () => {
    listPoolNumbers.mockResolvedValue(rows());
    renderSection();
    expect(await screen.findByText('(555) 019-0001')).toBeInTheDocument();
    expect(screen.getByText('(555) 019-0002')).toBeInTheDocument();
    expect(screen.queryByText('(555) 019-0003')).not.toBeInTheDocument();
    // The Active chip is pressed by default.
    expect(screen.getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Released reveals only released rows; All shows everything', async () => {
    const u = userEvent.setup();
    listPoolNumbers.mockResolvedValue(rows());
    renderSection();
    await screen.findByText('(555) 019-0001');

    await u.click(screen.getByRole('button', { name: 'Released' }));
    expect(screen.getByText('(555) 019-0003')).toBeInTheDocument();
    expect(screen.queryByText('(555) 019-0001')).not.toBeInTheDocument();
    expect(screen.queryByText('(555) 019-0002')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Released' })).toHaveAttribute('aria-pressed', 'true');

    await u.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('(555) 019-0001')).toBeInTheDocument();
    expect(screen.getByText('(555) 019-0002')).toBeInTheDocument();
    expect(screen.getByText('(555) 019-0003')).toBeInTheDocument();
  });

  it('shows a filter-no-match message (distinct from the empty state)', async () => {
    // Only a released row -> the default Active filter matches nothing.
    listPoolNumbers.mockResolvedValue([
      numberRow({ number: '+15550190003', state: 'released', releasedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    const u = userEvent.setup();
    renderSection();

    expect(await screen.findByText('No group text numbers match this filter.')).toBeInTheDocument();
    // NOT the no-numbers-at-all copy.
    expect(screen.queryByText(/a number is provisioned with the first group text/i)).not.toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Released' }));
    expect(screen.getByText('(555) 019-0003')).toBeInTheDocument();
    expect(screen.queryByText('No group text numbers match this filter.')).not.toBeInTheDocument();
  });
});

describe('NumbersSection - expansion', () => {
  it('expands a number into its group rows, each linking to the conversation thread', async () => {
    const u = userEvent.setup();
    listPoolNumbers.mockResolvedValue([
      numberRow({
        number: '+15550190001',
        openGroups: 1,
        totalGroups: 2,
        groups: [
          group({ conversationId: 'conv-open', label: 'With Ann A', status: 'open', memberCount: 2 }),
          group({
            conversationId: 'conv-closed',
            label: 'Maple St tour',
            status: 'closed',
            memberCount: 3,
            createdAt: '2026-05-01T00:00:00.000Z',
            closedAt: '2026-05-09T00:00:00.000Z',
          }),
        ],
      }),
    ]);
    renderSection();
    await screen.findByText('(555) 019-0001');

    // Collapsed by default: group labels are not shown.
    expect(screen.queryByText('Maple St tour')).not.toBeInTheDocument();

    const expander = screen.getByRole('button', { name: 'Show groups for (555) 019-0001' });
    expect(expander).toHaveAttribute('aria-expanded', 'false');
    await u.click(expander);

    // Now the group rows render, each a link to its conversation view.
    expect(screen.getByRole('button', { name: 'Hide groups for (555) 019-0001' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('link', { name: /With Ann A/ })).toHaveAttribute(
      'href',
      '/conversations/conv-open',
    );
    expect(screen.getByRole('link', { name: /Maple St tour/ })).toHaveAttribute(
      'href',
      '/conversations/conv-closed',
    );
  });
});

describe('NumbersSection - empty + error', () => {
  it('shows the no-numbers-at-all empty state (no table)', async () => {
    listPoolNumbers.mockResolvedValue([]);
    renderSection();
    expect(
      await screen.findByText(
        'No group text numbers yet - a number is provisioned with the first group text.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an error block + Retry when the fetch fails, then recovers on Retry', async () => {
    const u = userEvent.setup();
    listPoolNumbers.mockRejectedValueOnce(new ApiError(500, 'server_error', 'boom'));
    renderSection();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/load/i);
    const retry = screen.getByRole('button', { name: 'Retry' });

    listPoolNumbers.mockResolvedValueOnce([numberRow({ number: '+15550190001' })]);
    await u.click(retry);
    expect(await screen.findByText('(555) 019-0001')).toBeInTheDocument();
  });

  it('shows a loading spinner before the fetch resolves', () => {
    listPoolNumbers.mockReturnValue(new Promise(() => {}));
    renderSection();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });
});

describe('NumbersSection - admin guard', () => {
  it('bounces a VA who lands on /settings/numbers to Templates (guarded content absent)', () => {
    viewerIsAdmin = false;
    render(
      <MemoryRouter initialEntries={['/settings/numbers']}>
        <Routes>
          <Route
            path="/settings/numbers"
            element={
              <AdminRoute>
                <NumbersSection />
              </AdminRoute>
            }
          />
          <Route path="/settings/templates" element={<div>TEMPLATES PANEL</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('heading', { name: 'Group text numbers' })).not.toBeInTheDocument();
    expect(screen.getByText('TEMPLATES PANEL')).toBeInTheDocument();
    expect(listPoolNumbers).not.toHaveBeenCalled();
  });
});
