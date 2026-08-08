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
const detail: AiRunDetailResponse = { run: { runId: 'run-1', startedAt: '2026-08-07T10:00:00.000Z', finishedAt: '2026-08-07T10:00:01.000Z', durationMs: 4, conversationId: 'c1', trigger: 'sms', outcome: 'applied', driver: 'fake', decisions, notedLines: 0, window: { detail: 'full', cursor: 'x', windowCappedAtLimit: false, messages: [], excluded: [{ tsMsgId: 'old', cause: 'age_30d' }, { tsMsgId: 'budget', cause: 'char_budget' }], noContent: ['empty-call'] } }, window: { messages: [{ tsMsgId: 'm1', type: 'sms', direction: 'inbound', tier: 'new', chars: 12, hash: 'abc', available: true, text: 'hello' }] } };

function Location(): React.JSX.Element { return <output data-testid="location">{useLocation().search}</output>; }
function renderSection(): void { render(<MemoryRouter initialEntries={['/settings/ai-runs']}><AiRunsSection /><Location /></MemoryRouter>); }

beforeEach(() => {
  useSystemFlags.mockReturnValue({ status: 'ready', flags, retry: vi.fn() });
  useAiRunList.mockReturnValue({ rows: [row], status: 'ready', hasMore: false, loadingMore: false, loadMore: vi.fn(), retry: vi.fn() });
  useAiRun.mockReturnValue({ detail, status: 'ready', retry: vi.fn() });
});

describe('AiRunsSection', () => {
  it('renders the config strip so an empty log is never misread', () => { renderSection(); expect(screen.getByLabelText('Extraction driver: fake')).toBeInTheDocument(); expect(screen.getByLabelText(/^Extraction model: /)).toBeInTheDocument(); expect(screen.getByLabelText(/^Prompt fingerprint: [0-9a-f]{12}$/)).toBeInTheDocument(); expect(screen.getByLabelText(/^AI extraction: (on|off)$/)).toBeInTheDocument(); });
  it('lists runs newest-first and opens one into the detail pane', async () => { renderSection(); await userEvent.click(screen.getByRole('button', { name: /run-1/i })); expect(screen.getByTestId('location')).toHaveTextContent('run=run-1'); expect(screen.getByRole('heading', { name: /run run-1/i })).toBeInTheDocument(); });
  it('offers scope as a SINGLE choice, never a checkbox matrix', () => { renderSection(); expect(screen.queryAllByRole('checkbox')).toHaveLength(0); expect(screen.getByRole('radiogroup', { name: /scope/i })).toBeInTheDocument(); });
  it('shows the window with excluded causes and the no-content list', () => { renderSection(); expect(screen.getByRole('table', { name: 'Window messages' })).toBeInTheDocument(); expect(screen.getByRole('region', { name: 'Excluded messages' })).toHaveTextContent('age_30d'); expect(screen.getByRole('region', { name: 'Excluded messages' })).toHaveTextContent('char_budget'); expect(screen.getByRole('region', { name: 'No content' })).toHaveTextContent('empty-call'); });
  it('shows every decision with its verdict', () => { renderSection(); const table = screen.getByRole('table', { name: 'Decisions' }); expect(within(table).getAllByRole('row')).toHaveLength(13); expect(screen.getByRole('row', { name: /^pets/ })).toHaveTextContent('auto_applied'); });
  it('renders an expired row as expired rather than crashing', () => { useAiRunList.mockReturnValueOnce({ rows: [{ runId: 'gone', sortKey: 's0', expired: true }], status: 'ready', hasMore: false, loadingMore: false, loadMore: vi.fn(), retry: vi.fn() }); renderSection(); expect(screen.getByText(/expired/i)).toBeInTheDocument(); });
  it('shows a retryable error block when the fetch fails', () => { useAiRunList.mockReturnValueOnce({ rows: [], status: 'error', hasMore: false, loadingMore: false, loadMore: vi.fn(), retry: vi.fn() }); renderSection(); expect(screen.getByRole('alert')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument(); });
});
