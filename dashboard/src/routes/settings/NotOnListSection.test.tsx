// NotOnListSection tests - one "Not on the list" value in the detail panel
// (spec 2026-10-06 D10, D11; S14 selector contract L1-L6; design review
// 2026-10-07 Option B): its field, records and resolution, the records with
// per-record links, and the admin-only settle - one radio group of the
// choices its resolution allows, and under the pick a confirm that repeats
// the action.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

import { NotOnListPanel, type NotOnListPanelProps } from './NotOnListSection.js';

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

type User = ReturnType<typeof userEvent.setup>;

/** Render the panel for the row holding `value` (exactly) among `rows`. */
function renderPanel(value: string, over: Partial<NotOnListPanelProps> = {}): NotOnListPanelProps {
  const rows = over.rows ?? ROWS;
  const row = rows.find((r) => r.value === value);
  if (row === undefined) throw new Error(`no row ${value}`);
  const props: NotOnListPanelProps = {
    row,
    rows,
    entries: ENTRIES,
    isAdmin: true,
    rewriteLive: false,
    narrow: false,
    headingRef: { current: null },
    onSettled: vi.fn(),
    ...over,
  };
  render(
    <MemoryRouter>
      <NotOnListPanel {...props} />
    </MemoryRouter>,
  );
  return props;
}

const panel = (value: string): HTMLElement => screen.getByRole('region', { name: value });

/** A fact in the panel (Field, Records, What it is): the text beside its label. */
function fact(value: string, label: string): string {
  const term = within(panel(value)).getByText(label, { selector: 'dt' });
  return term.nextElementSibling?.textContent ?? '';
}
const settleGroup = (): HTMLElement => screen.getByRole('group', { name: 'Settle this value' });
const choices = (): string[] =>
  within(settleGroup())
    .getAllByRole('radio')
    .map((r) => r.closest('label')?.textContent ?? '');

/** Pick a choice; returns the settle group (its confirm sits under the pick). */
async function pick(user: User, label: string): Promise<HTMLElement> {
  await user.click(within(settleGroup()).getByRole('radio', { name: label }));
  return settleGroup();
}

beforeEach(() => {
  getNotOnListRecords.mockReset();
  resolveNotOnList.mockReset().mockResolvedValue({ lastRewrite: RUNNING, skippedSpellings: [] });
  checkOrgText.mockReset().mockResolvedValue({ candidates: [], close: [], spellingProblem: null });
});

describe('NotOnListPanel - everyone', () => {
  it('shows the value with its field, its record counts and what it resolves to', () => {
    renderPanel('merlin housing authority', { isAdmin: false });
    const merlin = panel('merlin housing authority');
    expect(within(merlin).getByRole('heading', { name: 'merlin housing authority' })).toBeInTheDocument();
    expect(fact('merlin housing authority', 'Field')).toBe('Housing authority');
    expect(fact('merlin housing authority', 'Records')).toBe('2 (+1 deleted)');
    expect(fact('merlin housing authority', 'What it is')).toBe('Matches Merlin Housing Authority');
  });

  it.each([
    ['Kite Aid', 'What it is', 'An agency: Kite Aid'],
    ['Rook Junk', 'Field', 'Property housing authorities'],
  ])('%s: %s reads %s', (value, label, text) => {
    renderPanel(value, { isAdmin: false });
    expect(fact(value, label)).toBe(text);
  });

  it('Show records links each holder to its own page; a deleted one is marked', async () => {
    const user = userEvent.setup();
    getNotOnListRecords.mockResolvedValue([
      { kind: 'contact', contactId: 'c-live', name: 'Lena Live', type: 'tenant', deleted: false },
      { kind: 'contact', contactId: 'c-gone', name: 'Gus Gone', type: 'tenant', deleted: true },
      { kind: 'unit', unitId: 'u-1', address: '1 Linnet Lane', deleted: false },
    ]);
    renderPanel('merlin housing authority', { isAdmin: false });
    const show = screen.getByRole('button', { name: 'Show records' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await user.click(show);
    expect(getNotOnListRecords).toHaveBeenCalledWith(
      'housingAuthority',
      'merlin housing authority',
      expect.any(AbortSignal),
    );
    expect(await screen.findByRole('link', { name: 'Lena Live' })).toHaveAttribute('href', '/contacts/c-live');
    expect(screen.getByRole('link', { name: 'Gus Gone' })).toHaveAttribute('href', '/contacts/c-gone');
    expect(screen.getByRole('link', { name: '1 Linnet Lane' })).toHaveAttribute('href', '/listings/u-1');
    const items = within(screen.getByRole('list', { name: 'Records holding merlin housing authority' })).getAllByRole(
      'listitem',
    );
    expect(items.find((li) => (li.textContent ?? '').includes('Gus Gone'))).toHaveTextContent(/deleted/);
    expect(items.find((li) => (li.textContent ?? '').includes('Lena Live'))).not.toHaveTextContent(/deleted/);
    expect(screen.getByRole('button', { name: 'Hide records' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('a VA gets no settling at all - the group is absent, not disabled', () => {
    renderPanel('Rook Junk', { isAdmin: false });
    expect(screen.queryByRole('group', { name: 'Settle this value' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(within(panel('Rook Junk')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Show records']);
  });

  it('Back (phone) or Close (desktop) leads back to the list', () => {
    renderPanel('Rook Junk', { narrow: true });
    expect(screen.getByRole('link', { name: 'Back to Not on the list' })).toHaveAttribute(
      'href',
      '/settings/organizations?view=not-on-list',
    );
  });
});

describe('NotOnListPanel - admin settling', () => {
  it.each([
    // A NAME VARIANT (spec D10): only Use <that entry> - any other action would
    // also rewrite every record holding the exact name (the server refuses it).
    ['merlin housing authority', ['Use Merlin Housing Authority']],
    ['Kite Aid', ['Move to Agency as Kite Aid', 'Use another name', 'Clear']],
    // An agency value that names a housing authority moves the other way.
    ['Shrike Housing', ['Move to Housing authority as Shrike Housing Authority', 'Use another name', 'Clear']],
    [
      'Shrike Housing Authority Shrike Aid',
      ['Use Shrike Housing Authority', 'Split into Shrike Housing Authority + Shrike Aid', 'Use another name', 'Clear'],
    ],
    // A property list takes housing authorities only: no Move, no Split.
    ['Rook Junk', ['Use another name', 'Add as new', 'Clear']],
  ])('%s offers the choices its resolution allows, one radio each', (value, expected) => {
    renderPanel(value);
    expect(choices()).toEqual(expected);
    // Nothing is picked, so nothing can be confirmed yet.
    expect(within(settleGroup()).queryByRole('button')).not.toBeInTheDocument();
    expect(settleGroup()).toHaveTextContent('Pick what the value should become, then confirm it.');
  });

  it('Use <name>: a value that IS the name is never remembered', async () => {
    const user = userEvent.setup();
    const props = renderPanel('merlin housing authority');
    const group = await pick(user, 'Use Merlin Housing Authority');
    const remember = within(group).getByRole('checkbox', { name: 'Remember this spelling' });
    expect(remember).not.toBeChecked();
    expect(remember).toBeDisabled();
    expect(group).toHaveTextContent('Not remembered: it is the name itself, written another way.');
    expect(checkOrgText).not.toHaveBeenCalled();
    await user.click(within(group).getByRole('button', { name: 'Use Merlin Housing Authority' }));
    expect(resolveNotOnList).toHaveBeenCalledWith({
      field: 'housingAuthority',
      value: 'merlin housing authority',
      action: 'use',
      name: 'Merlin Housing Authority',
      rememberSpelling: false,
    });
    await waitFor(() => expect(props.onSettled).toHaveBeenCalledWith({ lastRewrite: RUNNING, skippedSpellings: [] }));
  });

  it('Use <close name>: Remember this spelling is on, checked against the target entry', async () => {
    const user = userEvent.setup();
    renderPanel('Merln Housng');
    const group = await pick(user, 'Use Merlin Housing Authority');
    await waitFor(() =>
      expect(checkOrgText).toHaveBeenCalledWith(
        { kind: 'housing_authority', text: 'Merln Housng', spellingFor: 'o-merlin' },
        expect.any(AbortSignal),
      ),
    );
    expect(group).toHaveTextContent(
      'Every record holding this value in Housing authority changes to Merlin Housing Authority (3 records).',
    );
    expect(within(group).getByRole('checkbox', { name: 'Remember this spelling' })).toBeChecked();
    await user.click(within(group).getByRole('button', { name: 'Use Merlin Housing Authority' }));
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
    renderPanel('Merln Housng');
    const group = await pick(user, 'Use Merlin Housing Authority');
    await waitFor(() =>
      expect(within(group).getByRole('checkbox', { name: 'Remember this spelling' })).not.toBeChecked(),
    );
    expect(group).toHaveTextContent(
      'Not remembered: another entry already has it, and a shared spelling is never applied automatically.',
    );
    await user.click(within(group).getByRole('button', { name: 'Use Merlin Housing Authority' }));
    expect(resolveNotOnList).toHaveBeenCalledWith(expect.objectContaining({ rememberSpelling: false }));
  });

  it('Move to Agency confirms with the same words', async () => {
    const user = userEvent.setup();
    renderPanel('Kite Aid');
    const group = await pick(user, 'Move to Agency as Kite Aid');
    await user.click(within(group).getByRole('button', { name: 'Move to Agency as Kite Aid' }));
    expect(resolveNotOnList).toHaveBeenLastCalledWith({
      field: 'housingAuthority',
      value: 'Kite Aid',
      action: 'move_to_agency',
      name: 'Kite Aid',
    });
  });

  it('Clear confirms with the same words, as the danger action', async () => {
    const user = userEvent.setup();
    renderPanel('Rook Junk');
    const group = await pick(user, 'Clear');
    expect(group).toHaveTextContent(
      'The value is removed from Property housing authorities on every record that holds it (1 record).',
    );
    await user.click(within(group).getByRole('button', { name: 'Clear' }));
    expect(resolveNotOnList).toHaveBeenLastCalledWith({
      field: 'accepted_authorities',
      value: 'Rook Junk',
      action: 'clear',
    });
  });

  it('a new pick replaces the confirm under the old one', async () => {
    const user = userEvent.setup();
    renderPanel('Kite Aid');
    let group = await pick(user, 'Move to Agency as Kite Aid');
    expect(within(group).getByRole('button', { name: 'Move to Agency as Kite Aid' })).toBeInTheDocument();
    group = await pick(user, 'Clear');
    expect(within(group).queryByRole('button', { name: 'Move to Agency as Kite Aid' })).not.toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Clear' })).toBeEnabled();
  });

  it('Move to Housing authority settles an agency value that names a housing authority', async () => {
    const user = userEvent.setup();
    renderPanel('Shrike Housing');
    expect(fact('Shrike Housing', 'Field')).toBe('Agency');
    const group = await pick(user, 'Move to Housing authority as Shrike Housing Authority');
    expect(group).toHaveTextContent(
      'The value leaves Agency and goes into Housing authority as Shrike Housing Authority',
    );
    await user.click(
      within(group).getByRole('button', { name: 'Move to Housing authority as Shrike Housing Authority' }),
    );
    expect(resolveNotOnList).toHaveBeenCalledWith({
      field: 'agency',
      value: 'Shrike Housing',
      action: 'move_to_housing_authority',
      name: 'Shrike Housing Authority',
    });
  });

  it('Split prefills both halves (editable) and sends them', async () => {
    const user = userEvent.setup();
    renderPanel('Shrike Housing Authority Shrike Aid');
    const group = await pick(user, 'Split into Shrike Housing Authority + Shrike Aid');
    expect(within(group).getByRole('button', { name: 'Remove Shrike Housing Authority' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Remove Shrike Aid' })).toBeInTheDocument();
    await user.click(within(group).getByRole('button', { name: 'Split' }));
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
    renderPanel('Rook Junk');
    const group = await pick(user, 'Use another name');
    expect(within(group).getByRole('button', { name: 'Use' })).toBeDisabled();
    await user.type(within(group).getByRole('combobox', { name: 'Name to use' }), 'Merlin');
    await user.click(await screen.findByRole('option', { name: /^Merlin Housing Authority/ }));
    await user.click(within(group).getByRole('button', { name: 'Use Merlin Housing Authority' }));
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
    renderPanel('Rook Junk');
    const group = await pick(user, 'Add as new');
    const name = within(group).getByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('Rook Junk');
    // The value itself as the name: nothing to remember.
    expect(within(group).queryByRole('checkbox', { name: 'Remember this spelling' })).not.toBeInTheDocument();
    await user.clear(name);
    await user.type(name, 'Rook Housing Authority');
    expect(within(group).getByRole('checkbox', { name: 'Remember this spelling' })).toBeChecked();
    await user.click(within(group).getByRole('button', { name: 'Add as new' }));
    expect(resolveNotOnList).toHaveBeenCalledWith({
      field: 'accepted_authorities',
      value: 'Rook Junk',
      action: 'add',
      name: 'Rook Housing Authority',
      rememberSpelling: true,
    });
  });

  it('settling waits while an update runs and says why in visible text; the records stay readable', () => {
    renderPanel('Rook Junk', { rewriteLive: true });
    const group = settleGroup();
    expect(group).toBeDisabled();
    const reason = 'Another update is still running. Settling waits until it finishes.';
    expect(within(group).getByText(reason)).toBeVisible();
    expect(group).toHaveAccessibleDescription(reason);
    for (const radio of within(group).getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show records' })).toBeEnabled();
  });

  it('a settle confirm counts every row of the field written the same way, and names them (R1-ADV-FE-9)', async () => {
    // A rewrite matches NORMALIZED text: settling one of these rows rewrites
    // the holders of all three. The agency row is another field - never counted.
    const user = userEvent.setup();
    const unknown = { status: 'unknown' as const, close: [] };
    const rows: NotOnListRow[] = [
      { field: 'housingAuthority', value: 'Rook Junk', count: 2, deletedCount: 1, resolution: unknown },
      { field: 'housingAuthority', value: 'rook junk', count: 3, deletedCount: 0, resolution: unknown },
      { field: 'housingAuthority', value: 'Rook-Junk', count: 1, deletedCount: 0, resolution: unknown },
      { field: 'agency', value: 'ROOK JUNK', count: 4, deletedCount: 0, resolution: unknown },
    ];
    renderPanel('rook junk', { rows });
    expect(await pick(user, 'Clear')).toHaveTextContent(
      'The value is removed from Housing authority on every record that holds it (6 records (+1 deleted), written as Rook Junk, rook junk or Rook-Junk).',
    );
  });

  it('(PIN) a value with no sibling in its field keeps the one-row wording', async () => {
    const user = userEvent.setup();
    const unknown = { status: 'unknown' as const, close: [] };
    renderPanel('ROOK JUNK', {
      rows: [
        { field: 'housingAuthority', value: 'Rook Junk', count: 2, deletedCount: 1, resolution: unknown },
        { field: 'agency', value: 'ROOK JUNK', count: 4, deletedCount: 0, resolution: unknown },
      ],
    });
    expect(await pick(user, 'Clear')).toHaveTextContent(
      'The value is removed from Agency on every record that holds it (4 records).',
    );
  });

  it('a placeholder value counts only the rows the server rewrites with it - its trimmed exact text (R2-FE-4)', async () => {
    // "-", "--" and "()" all normalize to '', and the server matches such a
    // value by its TRIMMED EXACT text (app/src/services/orgRecords.ts), so a
    // settle of "-" reaches "-" and " - " only - never "--" or "()".
    const user = userEvent.setup();
    const unknown = { status: 'unknown' as const, close: [] };
    const rows: NotOnListRow[] = [
      { field: 'housingAuthority', value: '-', count: 2, deletedCount: 0, resolution: unknown },
      { field: 'housingAuthority', value: ' - ', count: 1, deletedCount: 1, resolution: unknown },
      { field: 'housingAuthority', value: '--', count: 3, deletedCount: 0, resolution: unknown },
      { field: 'housingAuthority', value: '()', count: 1, deletedCount: 0, resolution: unknown },
    ];
    const first = renderPanel('--', { rows });
    expect(first.row.value).toBe('--');
    expect(await pick(user, 'Clear')).toHaveTextContent(
      'The value is removed from Housing authority on every record that holds it (3 records).',
    );
    cleanup();
    // "-" and " - " are one value to the server: both rows are counted and named.
    renderPanel('-', { rows });
    expect((await pick(user, 'Clear')).textContent).toContain('(3 records (+1 deleted), written as - or  - ).');
  });

  it('a refused settle says why in staff words', async () => {
    const user = userEvent.setup();
    resolveNotOnList.mockRejectedValue(new ApiError(409, 'org_rewrite_running', 'org_rewrite_running'));
    const props = renderPanel('Rook Junk');
    const group = await pick(user, 'Clear');
    await user.click(within(group).getByRole('button', { name: 'Clear' }));
    expect(await within(group).findByRole('alert')).toHaveTextContent(
      'Another update is still running - try again when it finishes.',
    );
    expect(props.onSettled).not.toHaveBeenCalled();
  });
});
