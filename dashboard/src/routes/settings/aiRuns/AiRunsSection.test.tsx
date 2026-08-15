import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRunDecision, AiRunDetailResponse, AiRunListRow, SystemFlags } from '../../../api/index.js';

const useAiRunList = vi.fn();
const useAiRun = vi.fn();
const useSystemFlags = vi.fn();

vi.mock('./useAiRuns.js', () => ({ useAiRunList: (...args: unknown[]) => useAiRunList(...args), useAiRun: (...args: unknown[]) => useAiRun(...args) }));
vi.mock('../useSystemStatus.js', () => ({ useSystemFlags: (...args: unknown[]) => useSystemFlags(...args) }));

import { AiRunsSection } from './AiRunsSection.js';

const flags: SystemFlags = {
  env: 'local', smsSendingEnabled: true, relayLiveProvisioning: true, pushConfigured: true, messagingDriver: 'mock',
  aiExtractionEnabled: true, aiExtractionDriver: 'fake', aiExtractionModel: 'fake-v1', aiExtractionPromptFingerprint: '123456789abc',
};
const row: AiRunListRow = { runId: 'run-1', sortKey: 's1', expired: false, startedAt: '2026-08-07T10:00:00.000Z', durationMs: 4, conversationId: 'c1', contactId: 'contact-1', trigger: 'sms', outcome: 'applied', driver: 'fake', decisionCounts: { wrote: 1 }, notedLines: 0 };
// Deliberately ALPHABETICAL, which is the order the decisions map comes back in:
// it round-trips through an unordered DynamoDB map attribute, so the writer's
// DECISION_TARGETS order is gone by the time the dashboard sees it. Building the
// fixture in display order would make the ordering test unable to fail.
const decisions: Record<string, AiRunDecision> = Object.fromEntries(['address','evictions','firstName','housingAuthority','lastName','pets','phone','porting','status','tenure','type','voucherSize'].map((target) => [target, { proposedOp: 'write', proposedValue: 'yes', outcome: 'wrote', verdict: 'auto_applied' }]));
const detail: AiRunDetailResponse = { run: { runId: 'run-1', startedAt: '2026-08-07T10:00:00.000Z', finishedAt: '2026-08-07T10:00:01.000Z', durationMs: 4, conversationId: 'c1', trigger: 'sms', outcome: 'applied', driver: 'fake', model: 'fake-v1', promptFingerprint: 'abcdef123456', usage: { inputTokens: 12, outputTokens: 4 }, decisions, notedLines: 0, window: { detail: 'full', cursor: 'x', windowCappedAtLimit: false, messages: [], excluded: [{ tsMsgId: 'old', cause: 'age_30d' }, { tsMsgId: 'budget', cause: 'char_budget' }], noContent: ['empty-call'] } }, window: { messages: [{ tsMsgId: 'm1', type: 'sms', direction: 'inbound', tier: 'new', truncated: true, chars: 12, hash: 'abc', hashStatus: 'mismatch', available: true, text: 'hello' }] } };

function Location(): React.JSX.Element { return <output data-testid="location">{useLocation().search}</output>; }
function renderSection(path = '/settings/ai-runs'): void { render(<MemoryRouter initialEntries={[path]}><AiRunsSection /><Location /></MemoryRouter>); }

beforeEach(() => {
  useSystemFlags.mockReturnValue({ status: 'ready', flags, retry: vi.fn() });
  useAiRunList.mockReturnValue({ rows: [row], status: 'ready', hasMore: false, loadingMore: false, loadMoreFailed: false, loadMore: vi.fn(), retry: vi.fn() });
  useAiRun.mockReturnValue({ detail, status: 'ready', retry: vi.fn() });
});

describe('AiRunsSection', () => {
  // By ROLE, not getByLabelText: `aria-label` on a bare div/span (role=generic)
  // is honoured by Testing Library and Playwright but DROPPED by assistive tech,
  // so a label-text assertion here proves something a screen reader never hears.
  it('renders the config strip so an empty log is never misread', () => { renderSection(); const strip = within(screen.getByRole('list', { name: 'Extraction configuration' })); expect(strip.getByRole('listitem', { name: 'Extraction driver: fake' })).toBeInTheDocument(); expect(strip.getByRole('listitem', { name: /^Extraction model: / })).toBeInTheDocument(); expect(strip.getByRole('listitem', { name: /^Prompt fingerprint: [0-9a-f]{12}$/ })).toBeInTheDocument(); expect(strip.getByRole('listitem', { name: /^AI extraction: (on|off)$/ })).toBeInTheDocument(); });
  it('names a run row by what the run DID, never by a bare id', () => {
    renderSection();
    const row = within(screen.getByRole('list', { name: 'AI runs' })).getByRole('button');
    // The runId is not rendered anywhere a sighted operator can see it, so an
    // `aria-label` of it hides the whole row from assistive tech.
    expect(row).toHaveAccessibleName(/applied/i);
    expect(row).toHaveAccessibleName(/sms via fake/i);
    expect(row).toHaveAccessibleName(/contact-1/);
    expect(row.getAttribute('aria-label')).not.toBe('Run run-1');
  });
  it('lists runs newest-first and opens one into the detail pane', async () => { renderSection(); await userEvent.click(within(screen.getByRole('list', { name: 'AI runs' })).getByRole('button')); expect(screen.getByTestId('location')).toHaveTextContent('run=run-1'); expect(screen.getByRole('heading', { name: /run run-1/i })).toBeInTheDocument(); });
  it('offers scope as a SINGLE choice, never a checkbox matrix', () => { renderSection(); expect(screen.queryAllByRole('checkbox')).toHaveLength(0); expect(screen.getByRole('radiogroup', { name: /scope/i })).toBeInTheDocument(); });
  it('stores a composable From and To range in the URL and passes it to the list hook', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.type(screen.getByLabelText('From'), '2026-08-01');
    await user.type(screen.getByLabelText('To'), '2026-08-07');
    expect(useAiRunList).toHaveBeenLastCalledWith({ scope: 'global', from: '2026-08-01', to: '2026-08-07' });
    expect(screen.getByTestId('location')).toHaveTextContent('from=2026-08-01');
    expect(screen.getByTestId('location')).toHaveTextContent('to=2026-08-07');
  });
  it('keeps a deep-linked contact scope as the selected single radio option', () => {
    renderSection('/settings/ai-runs?scope=contacts%23contact-1');
    expect(screen.getByRole('radio', { name: 'Contact: contact-1' })).toBeChecked();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
  it('shows the window with excluded causes and the no-content list', () => { renderSection(); expect(screen.getByRole('table', { name: 'Window messages' })).toBeInTheDocument(); expect(screen.getByRole('region', { name: 'Excluded messages' })).toHaveTextContent('age_30d'); expect(screen.getByRole('region', { name: 'Excluded messages' })).toHaveTextContent('char_budget'); expect(screen.getByRole('region', { name: 'No content' })).toHaveTextContent('empty-call'); });
  it('shows every decision with its verdict', () => { renderSection(); const table = screen.getByRole('table', { name: 'Decisions' }); expect(within(table).getAllByRole('row')).toHaveLength(13); expect(screen.getByRole('row', { name: /^pets/ })).toHaveTextContent('auto applied'); });
  it('renders the ledger in the declared display order, not the map order the API returns', () => {
    renderSection();
    const body = within(screen.getByRole('table', { name: 'Decisions' })).getAllByRole('row').slice(1);
    expect(body.map((tr) => within(tr).getAllByRole('cell')[0]?.textContent)).toEqual([
      'firstName', 'lastName', 'voucherSize', 'housingAuthority', 'pets', 'evictions',
      'tenure', 'porting', 'address', 'status', 'type', 'phone',
    ]);
  });
  it('shows WHEN the run happened in the detail header (spec section 9)', () => {
    renderSection();
    const header = screen.getByRole('heading', { name: /run run-1/i }).parentElement as HTMLElement;
    // Computed the same way the pane renders it, so the assertion is host-timezone-safe.
    expect(header).toHaveTextContent(new Date('2026-08-07T10:00:00.000Z').toLocaleString());
  });
  it('counts what an operator scanning the log cares about, not a pending cross-tab', () => {
    // `pending` is a VERDICT cross-tab over the same twelve targets the five
    // outcome buckets already partition, so the old total double-counted every
    // pending decision. Both of these rows summed to 12 under it - the column
    // could not tell "wrote a field" apart from "changed nothing".
    const wroteOne: AiRunListRow = { ...row, runId: 'run-wrote', decisionCounts: { wrote: 1, suggested: 0, dropped: 0, no_finding: 0, not_addressed: 11, pending: 0 } };
    const changedNothing: AiRunListRow = { ...row, runId: 'run-noop', outcome: 'no_op', decisionCounts: { wrote: 0, suggested: 0, dropped: 0, no_finding: 0, not_addressed: 12, pending: 0 } };
    useAiRunList.mockReturnValueOnce({ rows: [wroteOne, changedNothing], status: 'ready', hasMore: false, loadingMore: false, loadMoreFailed: false, loadMore: vi.fn(), retry: vi.fn() });
    renderSection();
    const runs = within(screen.getByRole('list', { name: 'AI runs' })).getAllByRole('listitem');
    expect(runs[0]).toHaveTextContent('1 wrote, 0 suggested');
    expect(runs[1]).toHaveTextContent('0 wrote, 0 suggested');
    expect(runs[0]?.textContent).not.toEqual(runs[1]?.textContent);
  });
  it('renders decision outcome, verdict, and drop-reason labels without enum underscores', () => {
    useAiRun.mockReturnValueOnce({ detail: { ...detail, run: { ...detail.run, decisions: {
      pets: { proposedOp: 'write', outcome: 'no_finding', verdict: 'not_addressed' },
      phone: { proposedOp: 'write', outcome: 'dropped', verdict: 'superseded_by_human_edit', dropReason: 'superseded_by_human_edit' },
    } } }, status: 'ready', retry: vi.fn() });
    renderSection();
    expect(screen.getByRole('row', { name: /^pets/ })).toHaveTextContent('no finding');
    expect(screen.getByRole('row', { name: /^pets/ })).toHaveTextContent('not addressed');
    expect(screen.getByRole('row', { name: /^phone/ })).toHaveTextContent('superseded by human edit');
  });
  it('shows WHY a failed run failed - the pane used to render "failed" and drop the cause entirely', () => {
    useAiRun.mockReturnValueOnce({ detail: { ...detail, run: { ...detail.run, outcome: 'failed', error: {
      kind: 'truncated', parked: true, attempts: 4,
      message: 'Anthropic extraction hit the 4096-token output cap (4096 output tokens) and returned an incomplete response (stop_reason: max_tokens)',
    } } }, status: 'ready', retry: vi.fn() });
    renderSection();
    const failure = screen.getByRole('region', { name: 'Run failure' });
    expect(failure).toHaveTextContent('truncated');
    expect(failure).toHaveTextContent('stop_reason: max_tokens');
    // `attempts` counts the PRIOR consecutive failures, so a stored 4 is this
    // run being the fifth - the off-by-one an operator would otherwise make.
    expect(failure).toHaveTextContent('Attempt 5');
    // The operationally load-bearing half: nothing retries a parked row.
    expect(failure).toHaveTextContent(/parked/i);
  });

  it('shows no failure block on a run that did not fail', () => {
    renderSection();
    expect(screen.queryByRole('region', { name: 'Run failure' })).not.toBeInTheDocument();
  });

  it('shows model fingerprint and token usage in the detail header', () => { renderSection(); const header = screen.getByRole('heading', { name: /run run-1/i }).parentElement as HTMLElement; expect(header).toHaveTextContent('abcdef123456'); expect(header).toHaveTextContent('12 input tokens'); expect(header).toHaveTextContent('4 output tokens'); });
  it('shows truncation plus chars and hash evidence for a FULL window', () => { renderSection(); const table = screen.getByRole('table', { name: 'Window messages' }); expect(within(table).getByRole('columnheader', { name: 'Truncated' })).toBeInTheDocument(); expect(within(table).getByRole('columnheader', { name: 'Chars' })).toBeInTheDocument(); expect(within(table).getByRole('columnheader', { name: 'Hash' })).toBeInTheDocument(); expect(table).toHaveTextContent('yes'); });
  it('renders the current hash status instead of implying changed text still matches', () => { renderSection(); expect(screen.getByRole('table', { name: 'Window messages' })).toHaveTextContent('mismatch'); });
  it('labels a LIGHT window as a skip window and shows no hash column', () => {
    useAiRun.mockReturnValueOnce({ detail: { ...detail, run: { ...detail.run, window: { ...detail.run.window!, detail: 'light' } } }, status: 'ready', retry: vi.fn() });
    renderSection();
    expect(screen.getByRole('heading', { name: 'Skip window' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Truncated' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Chars' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Hash' })).not.toBeInTheDocument();
  });
  it('renders an expired row as expired rather than crashing', () => { useAiRunList.mockReturnValueOnce({ rows: [{ runId: 'gone', sortKey: 's0', expired: true }], status: 'ready', hasMore: false, loadingMore: false, loadMoreFailed: false, loadMore: vi.fn(), retry: vi.fn() }); renderSection(); expect(screen.getByText(/expired/i)).toBeInTheDocument(); });
  it('shows a retryable error block when the fetch fails', () => { useAiRunList.mockReturnValueOnce({ rows: [], status: 'error', hasMore: false, loadingMore: false, loadMoreFailed: false, loadMore: vi.fn(), retry: vi.fn() }); renderSection(); expect(screen.getByRole('alert')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument(); });
  it('tells the operator when a load more failed and retries the SAME page, keeping Load more', async () => {
    const loadMore = vi.fn();
    useAiRunList.mockReturnValueOnce({ rows: [row], status: 'ready', hasMore: true, loadingMore: false, loadMoreFailed: true, loadMore, retry: vi.fn() });
    renderSection();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('We could not load more runs.');
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });
});
