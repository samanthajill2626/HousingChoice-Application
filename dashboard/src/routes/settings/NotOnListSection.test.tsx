// NotOnListSection tests - "Not on the list" (spec 2026-10-06 D10, D11; S14
// selector contract L1-L6): the rows, the records with per-record links, and
// the admin-only settling actions, each through "Settle <value>" whose confirm
// repeats the action.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type NotOnListRow, type OrgEntry, type OrgRewriteState } from '../../api/index.js';

const getNotOnListRecords = vi.fn();
const resolveNotOnList = vi.fn();
const checkOrgText = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getNotOnListRecords: (...a: unknown[]) => getNotOnListRecords(...a),
    resolveNotOnList: (...a: unknown[]) => resolveNotOnList(...a),
    checkOrgText: (...a: unknown[]) => checkOrgText(...a),
  };
});

import { NotOnListSection, type NotOnListSectionProps } from './NotOnListSection.js';

function entry(kind: OrgEntry['kind'], name: string, orgId: string): OrgEntry {
  return {
    orgId,
    kind,
    name,
    spellings: [],
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'system',
  };
}

const MERLIN = entry('housing_authority', 'Merlin Housing Authority', 'o-merlin');
const SHRIKE = entry('housing_authority', 'Shrike Housing Authority', 'o-shrike');
const KITE = entry('agency', 'Kite Aid', 'o-kite');
const SHRIKE_AID = entry('agency', 'Shrike Aid', 'o-shrike-aid');
const ENTRIES = [MERLIN, SHRIKE, KITE, SHRIKE_AID];
const ref = (e: OrgEntry): { orgId: string; kind: OrgEntry['kind']; name: string } => ({
  orgId: e.orgId,
  kind: e.kind,
  name: e.name,
});

const ROWS: NotOnListRow[] = [
  {
    field: 'housingAuthority',
    value: 'merlin housing authority',
    count: 2,
    deletedCount: 1,
    resolution: { status: 'match', match: ref(MERLIN) },
  },
  {
    field: 'housingAuthority',
    value: 'Merln Housng',
    count: 3,
    deletedCount: 0,
    resolution: { status: 'unknown', close: [ref(MERLIN)] },
  },
  {
    field: 'housingAuthority',
    value: 'Kite Aid',
    count: 1,
    deletedCount: 0,
    resolution: { status: 'other_kind', otherKind: [ref(KITE)] },
  },
  {
    field: 'housingAuthority',
    value: 'Shrike Housing Authority Shrike Aid',
    count: 1,
    deletedCount: 0,
    resolution: { status: 'compound', compound: [[ref(SHRIKE)], [ref(SHRIKE_AID)]] },
  },
  {
    field: 'agency',
    value: 'Shrike Housing',
    count: 1,
    deletedCount: 0,
    resolution: { status: 'other_kind', otherKind: [ref(SHRIKE)] },
  },
  {
    field: 'accepted_authorities',
    value: 'Rook Junk',
    count: 1,
    deletedCount: 0,
    resolution: { status: 'unknown', close: [] },
  },
];

// dashboard/src/test/setup.ts pins Date.now() to 2026-07-01T12:00:00Z.
const RUNNING: OrgRewriteState = {
  jobId: 'j1',
  action: 'use',
  fromTexts: ['x'],
  field: 'housingAuthority',
  fields: ['housingAuthority'],
  status: 'running',
  heartbeatAt: '2026-07-01T11:59:59.000Z',
  startedAt: '2026-07-01T11:59:59.000Z',
  startedBy: 'u1',
};

function renderSection(over: Partial<NotOnListSectionProps> = {}): NotOnListSectionProps {
  const props: NotOnListSectionProps = {
    rows: ROWS,
    error: false,
    entries: ENTRIES,
    isAdmin: true,
    rewriteLive: false,
    onRetry: vi.fn(),
    onSettled: vi.fn(),
    ...over,
  };
  render(
    <MemoryRouter>
      <NotOnListSection {...props} />
    </MemoryRouter>,
  );
  return props;
}

/** A value's row, by its row header (the exact value). */
function valueRow(value: string): HTMLElement {
  const row = screen.getByRole('rowheader', { name: value }).closest('tr');
  if (row === null) throw new Error(`no row for ${value}`);
  return row;
}

beforeEach(() => {
  getNotOnListRecords.mockReset();
  resolveNotOnList.mockReset().mockResolvedValue({ lastRewrite: RUNNING, skippedSpellings: [] });
  checkOrgText.mockReset().mockResolvedValue({ candidates: [], close: [], spellingProblem: null });
});

describe('NotOnListSection - everyone', () => {
  it('shows each value with its field, its record counts and what it resolves to', () => {
    renderSection({ isAdmin: false });
    expect(screen.getByRole('region', { name: 'Not on the list' })).toBeInTheDocument();
    const merlin = valueRow('merlin housing authority');
    expect(merlin).toHaveTextContent('Housing authority');
    expect(merlin).toHaveTextContent('2 (+1 deleted)');
    expect(merlin).toHaveTextContent('Matches Merlin Housing Authority');
    expect(valueRow('Kite Aid')).toHaveTextContent('An agency: Kite Aid');
    expect(valueRow('Rook Junk')).toHaveTextContent('Property housing authorities');
  });

  it('Show records links each holder to its own page; a deleted one is marked', async () => {
    const user = userEvent.setup();
    getNotOnListRecords.mockResolvedValue([
      { kind: 'contact', contactId: 'c-live', name: 'Lena Live', type: 'tenant', deleted: false },
      { kind: 'contact', contactId: 'c-gone', name: 'Gus Gone', type: 'tenant', deleted: true },
      { kind: 'unit', unitId: 'u-1', address: '1 Linnet Lane', deleted: false },
    ]);
    renderSection({ isAdmin: false });
    await user.click(within(valueRow('merlin housing authority')).getByRole('button', { name: 'Show records' }));
    expect(getNotOnListRecords).toHaveBeenCalledWith(
      'housingAuthority',
      'merlin housing authority',
      expect.any(AbortSignal),
    );
    expect(await screen.findByRole('link', { name: 'Lena Live' })).toHaveAttribute('href', '/contacts/c-live');
    expect(screen.getByRole('link', { name: 'Gus Gone' })).toHaveAttribute('href', '/contacts/c-gone');
    expect(screen.getByRole('link', { name: '1 Linnet Lane' })).toHaveAttribute('href', '/listings/u-1');
    const items = screen.getAllByRole('listitem');
    expect(items.find((li) => (li.textContent ?? '').includes('Gus Gone'))).toHaveTextContent(/deleted/);
    expect(items.find((li) => (li.textContent ?? '').includes('Lena Live'))).not.toHaveTextContent(/deleted/);
  });

  it('a VA gets no settling action', () => {
    renderSection({ isAdmin: false });
    const row = valueRow('Rook Junk');
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['Show records']);
  });

  it('says so when every value is on the list, and offers Retry when the rows failed to load', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <MemoryRouter>
        <NotOnListSection rows={[]} error={false} entries={ENTRIES} isAdmin rewriteLive={false} onRetry={vi.fn()} onSettled={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Every stored value is on the lists.')).toBeInTheDocument();
    unmount();
    const props = renderSection({ rows: null, error: true });
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('NotOnListSection - admin settling', () => {
  it('offers each row the actions its resolution allows', () => {
    renderSection();
    const names = (value: string): (string | null)[] =>
      within(valueRow(value)).getAllByRole('button').map((b) => b.textContent);
    // A NAME VARIANT (spec D10): only Use <that entry> - any other action would
    // also rewrite every record holding the exact name (the server refuses it).
    expect(names('merlin housing authority')).toEqual(['Show records', 'Use Merlin Housing Authority']);
    expect(names('Kite Aid')).toEqual(['Show records', 'Move to Agency as Kite Aid', 'Use another name', 'Clear']);
    // An agency value that names a housing authority moves the other way.
    expect(names('Shrike Housing')).toEqual([
      'Show records',
      'Move to Housing authority as Shrike Housing Authority',
      'Use another name',
      'Clear',
    ]);
    expect(names('Shrike Housing Authority Shrike Aid')).toEqual([
      'Show records',
      'Use Shrike Housing Authority',
      'Split into Shrike Housing Authority + Shrike Aid',
      'Use another name',
      'Clear',
    ]);
    // A property list takes housing authorities only: no Move, no Split.
    expect(names('Rook Junk')).toEqual(['Show records', 'Use another name', 'Add as new', 'Clear']);
  });

  it('Use <name>: the dialog shows the value; a value that IS the name is never remembered', async () => {
    const user = userEvent.setup();
    const props = renderSection();
    await user.click(within(valueRow('merlin housing authority')).getByRole('button', { name: 'Use Merlin Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Settle merlin housing authority' });
    const remember = within(dialog).getByRole('checkbox', { name: 'Remember this spelling' });
    expect(remember).not.toBeChecked();
    expect(remember).toBeDisabled();
    expect(dialog).toHaveTextContent('Not remembered: it is the name itself, written another way.');
    expect(checkOrgText).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Use Merlin Housing Authority' }));
    expect(resolveNotOnList).toHaveBeenCalledWith({
      field: 'housingAuthority',
      value: 'merlin housing authority',
      action: 'use',
      name: 'Merlin Housing Authority',
      rememberSpelling: false,
    });
    await waitFor(() => expect(props.onSettled).toHaveBeenCalledWith({ lastRewrite: RUNNING, skippedSpellings: [] }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Use <close name>: Remember this spelling is on, checked against the target entry', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(within(valueRow('Merln Housng')).getByRole('button', { name: 'Use Merlin Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Settle Merln Housng' });
    await waitFor(() =>
      expect(checkOrgText).toHaveBeenCalledWith(
        { kind: 'housing_authority', text: 'Merln Housng', spellingFor: 'o-merlin' },
        expect.any(AbortSignal),
      ),
    );
    expect(within(dialog).getByRole('checkbox', { name: 'Remember this spelling' })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Use Merlin Housing Authority' }));
    expect(resolveNotOnList).toHaveBeenCalledWith({
      field: 'housingAuthority',
      value: 'Merln Housng',
      action: 'use',
      name: 'Merlin Housing Authority',
      rememberSpelling: true,
    });
  });

  it('a spelling the check refuses turns Remember off and says why', async () => {
    const user = userEvent.setup();
    checkOrgText.mockResolvedValue({ candidates: [], close: [], spellingProblem: 'shared_same_kind' });
    renderSection();
    await user.click(within(valueRow('Merln Housng')).getByRole('button', { name: 'Use Merlin Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Settle Merln Housng' });
    await waitFor(() =>
      expect(within(dialog).getByRole('checkbox', { name: 'Remember this spelling' })).not.toBeChecked(),
    );
    expect(dialog).toHaveTextContent(
      'Not remembered: another entry already has it, and a shared spelling is never applied automatically.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Use Merlin Housing Authority' }));
    expect(resolveNotOnList).toHaveBeenCalledWith(expect.objectContaining({ rememberSpelling: false }));
  });

  it('Move to Agency and Clear confirm with the same words', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(within(valueRow('Kite Aid')).getByRole('button', { name: 'Move to Agency as Kite Aid' }));
    let dialog = screen.getByRole('dialog', { name: 'Settle Kite Aid' });
    await user.click(within(dialog).getByRole('button', { name: 'Move to Agency as Kite Aid' }));
    expect(resolveNotOnList).toHaveBeenLastCalledWith({
      field: 'housingAuthority',
      value: 'Kite Aid',
      action: 'move_to_agency',
      name: 'Kite Aid',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(within(valueRow('Rook Junk')).getByRole('button', { name: 'Clear' }));
    dialog = screen.getByRole('dialog', { name: 'Settle Rook Junk' });
    await user.click(within(dialog).getByRole('button', { name: 'Clear' }));
    expect(resolveNotOnList).toHaveBeenLastCalledWith({
      field: 'accepted_authorities',
      value: 'Rook Junk',
      action: 'clear',
    });
  });

  it('Move to Housing authority settles an agency value that names a housing authority', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      within(valueRow('Shrike Housing')).getByRole('button', {
        name: 'Move to Housing authority as Shrike Housing Authority',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Settle Shrike Housing' });
    expect(dialog).toHaveTextContent('Agency: Shrike Housing');
    expect(dialog).toHaveTextContent('The value leaves Agency and goes into Housing authority as Shrike Housing Authority');
    await user.click(
      within(dialog).getByRole('button', { name: 'Move to Housing authority as Shrike Housing Authority' }),
    );
    expect(resolveNotOnList).toHaveBeenCalledWith({
      field: 'agency',
      value: 'Shrike Housing',
      action: 'move_to_housing_authority',
      name: 'Shrike Housing Authority',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('Split prefills both halves (editable) and sends them', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      within(valueRow('Shrike Housing Authority Shrike Aid')).getByRole('button', {
        name: 'Split into Shrike Housing Authority + Shrike Aid',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Settle Shrike Housing Authority Shrike Aid' });
    expect(within(dialog).getByRole('button', { name: 'Remove Shrike Housing Authority' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Remove Shrike Aid' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Split' }));
    expect(resolveNotOnList).toHaveBeenCalledWith({
      field: 'housingAuthority',
      value: 'Shrike Housing Authority Shrike Aid',
      action: 'split',
      name: 'Shrike Housing Authority',
      agencyName: 'Shrike Aid',
    });
  });

  it('Use another name picks from the field kind list', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(within(valueRow('Rook Junk')).getByRole('button', { name: 'Use another name' }));
    const dialog = screen.getByRole('dialog', { name: 'Settle Rook Junk' });
    expect(within(dialog).getByRole('button', { name: 'Use' })).toBeDisabled();
    await user.type(within(dialog).getByRole('combobox', { name: 'Name to use' }), 'Merlin');
    await user.click(await screen.findByRole('option', { name: /^Merlin Housing Authority/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Use Merlin Housing Authority' }));
    expect(resolveNotOnList).toHaveBeenCalledWith({
      field: 'accepted_authorities',
      value: 'Rook Junk',
      action: 'use',
      name: 'Merlin Housing Authority',
      rememberSpelling: true,
    });
  });

  it('Add as new: from the value, or a corrected name that remembers the value', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(within(valueRow('Rook Junk')).getByRole('button', { name: 'Add as new' }));
    const dialog = screen.getByRole('dialog', { name: 'Settle Rook Junk' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('Rook Junk');
    // The value itself as the name: nothing to remember.
    expect(within(dialog).queryByRole('checkbox', { name: 'Remember this spelling' })).not.toBeInTheDocument();
    await user.clear(name);
    await user.type(name, 'Rook Housing Authority');
    expect(within(dialog).getByRole('checkbox', { name: 'Remember this spelling' })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Add as new' }));
    expect(resolveNotOnList).toHaveBeenCalledWith({
      field: 'accepted_authorities',
      value: 'Rook Junk',
      action: 'add',
      name: 'Rook Housing Authority',
      rememberSpelling: true,
    });
  });

  it('settling waits while an update runs; the records stay readable', () => {
    renderSection({ rewriteLive: true });
    expect(within(valueRow('Rook Junk')).getByRole('button', { name: 'Clear' })).toBeDisabled();
    expect(within(valueRow('Rook Junk')).getByRole('button', { name: 'Show records' })).toBeEnabled();
  });

  it('a settle confirm counts every row of the field written the same way, and names them (R1-ADV-FE-9)', async () => {
    // A rewrite matches NORMALIZED text: settling one of these rows rewrites
    // the holders of all three. The agency row is another field - never counted.
    const user = userEvent.setup();
    const unknown = { status: 'unknown' as const, close: [] };
    renderSection({
      rows: [
        { field: 'housingAuthority', value: 'Rook Junk', count: 2, deletedCount: 1, resolution: unknown },
        { field: 'housingAuthority', value: 'rook junk', count: 3, deletedCount: 0, resolution: unknown },
        { field: 'housingAuthority', value: 'Rook-Junk', count: 1, deletedCount: 0, resolution: unknown },
        { field: 'agency', value: 'ROOK JUNK', count: 4, deletedCount: 0, resolution: unknown },
      ],
    });
    await user.click(within(valueRow('rook junk')).getByRole('button', { name: 'Clear' }));
    let dialog = screen.getByRole('dialog', { name: 'Settle rook junk' });
    expect(dialog).toHaveTextContent(
      'The value is removed from Housing authority on every record that holds it (6 records (+1 deleted), written as Rook Junk, rook junk or Rook-Junk).',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    // (PIN) a value with no sibling in its field keeps the one-row wording.
    await user.click(within(valueRow('ROOK JUNK')).getByRole('button', { name: 'Clear' }));
    dialog = screen.getByRole('dialog', { name: 'Settle ROOK JUNK' });
    expect(dialog).toHaveTextContent('The value is removed from Agency on every record that holds it (4 records).');
  });

  it('a refused settle says why in staff words', async () => {
    const user = userEvent.setup();
    resolveNotOnList.mockRejectedValue(new ApiError(409, 'org_rewrite_running', 'org_rewrite_running'));
    renderSection();
    await user.click(within(valueRow('Rook Junk')).getByRole('button', { name: 'Clear' }));
    const dialog = screen.getByRole('dialog', { name: 'Settle Rook Junk' });
    await user.click(within(dialog).getByRole('button', { name: 'Clear' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Another update is still running - try again when it finishes.',
    );
  });
});
