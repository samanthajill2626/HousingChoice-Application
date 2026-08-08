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
const decisions: Record<string, AiRunDecision> = Object.fromEntries(['firstName','lastName','voucherSize','housingAuthority','pets','evictions','tenure','porting','address','status','type','phone'].map((target) => [target, { proposedOp: 'write', proposedValue: 'yes', outcome: 'wrote', verdict: 'auto_applied' }]));
const detail: AiRunDetailResponse = { run: { runId: 'run-1', startedAt: '2026-08-07T10:00:00.000Z', finishedAt: '2026-08-07T10:00:01.000Z', durationMs: 4, conversationId: 'c1', trigger: 'sms', outcome: 'applied', driver: 'fake', model: 'fake-v1', promptFingerprint: 'abcdef123456', usage: { inputTokens: 12, outputTokens: 4 }, decisions, notedLines: 0, window: { detail: 'full', cursor: 'x', windowCappedAtLimit: false, messages: [], excluded: [{ tsMsgId: 'old', cause: 'age_30d' }, { tsMsgId: 'budget', cause: 'char_budget' }], noContent: ['empty-call'] } }, window: { messages: [{ tsMsgId: 'm1', type: 'sms', direction: 'inbound', tier: 'new', truncated: true, chars: 12, hash: 'abc', available: true, text: 'hello' }] } };

function Location(): React.JSX.Element { return <output data-testid="location">{useLocation().search}</output>; }
function renderSection(path = '/settings/ai-runs'): void { render(<MemoryRouter initialEntries={[path]}><AiRunsSection /><Location /></MemoryRouter>); }

beforeEach(() => {
  useSystemFlags.mockReturnValue({ status: 'ready', flags, retry: vi.fn() });
  useAiRunList.mockReturnValue({ rows: [row], status: 'ready', hasMore: false, loadingMore: false, loadMore: vi.fn(), retry: vi.fn() });
  useAiRun.mockReturnValue({ detail, status: 'ready', retry: vi.fn() });
});

describe('AiRunsSection', () => {
  it('renders the config strip so an empty log is never misread', () => { renderSection(); expect(screen.getByLabelText('Extraction driver: fake')).toBeInTheDocument(); expect(screen.getByLabelText(/^Extraction model: /)).toBeInTheDocument(); expect(screen.getByLabelText(/^Prompt fingerprint: [0-9a-f]{12}$/)).toBeInTheDocument(); expect(screen.getByLabelText(/^AI extraction: (on|off)$/)).toBeInTheDocument(); });
  it('lists runs newest-first and opens one into the detail pane', async () => { renderSection(); await userEvent.click(screen.getByRole('button', { name: /run-1/i })); expect(screen.getByTestId('location')).toHaveTextContent('run=run-1'); expect(screen.getByRole('heading', { name: /run run-1/i })).toBeInTheDocument(); });
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
  it('shows every decision with its verdict', () => { renderSection(); const table = screen.getByRole('table', { name: 'Decisions' }); expect(within(table).getAllByRole('row')).toHaveLength(13); expect(screen.getByRole('row', { name: /^pets/ })).toHaveTextContent('auto_applied'); });
  it('shows model fingerprint and token usage in the detail header', () => { renderSection(); const header = screen.getByRole('heading', { name: /run run-1/i }).parentElement as HTMLElement; expect(header).toHaveTextContent('abcdef123456'); expect(header).toHaveTextContent('12 input tokens'); expect(header).toHaveTextContent('4 output tokens'); });
  it('shows truncation plus chars and hash evidence for a FULL window', () => { renderSection(); const table = screen.getByRole('table', { name: 'Window messages' }); expect(within(table).getByRole('columnheader', { name: 'Truncated' })).toBeInTheDocument(); expect(within(table).getByRole('columnheader', { name: 'Chars' })).toBeInTheDocument(); expect(within(table).getByRole('columnheader', { name: 'Hash' })).toBeInTheDocument(); expect(table).toHaveTextContent('yes'); });
  it('labels a LIGHT window as a skip window and shows no hash column', () => {
    useAiRun.mockReturnValueOnce({ detail: { ...detail, run: { ...detail.run, window: { ...detail.run.window!, detail: 'light' } } }, status: 'ready', retry: vi.fn() });
    renderSection();
    expect(screen.getByRole('heading', { name: 'Skip window' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Truncated' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Chars' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Hash' })).not.toBeInTheDocument();
  });
  it('renders an expired row as expired rather than crashing', () => { useAiRunList.mockReturnValueOnce({ rows: [{ runId: 'gone', sortKey: 's0', expired: true }], status: 'ready', hasMore: false, loadingMore: false, loadMore: vi.fn(), retry: vi.fn() }); renderSection(); expect(screen.getByText(/expired/i)).toBeInTheDocument(); });
  it('shows a retryable error block when the fetch fails', () => { useAiRunList.mockReturnValueOnce({ rows: [], status: 'error', hasMore: false, loadingMore: false, loadMore: vi.fn(), retry: vi.fn() }); renderSection(); expect(screen.getByRole('alert')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument(); });
});
