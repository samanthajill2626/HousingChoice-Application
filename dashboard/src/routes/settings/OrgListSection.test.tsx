// OrgListSection tests - Settings > Housing authorities & agencies (spec
// 2026-10-06 D10-D13; S14 selector contract S1-S8): the lists as tables with
// use counts, Add through "Is this really new?", notes, the latest rewrite,
// and the admin-only actions that never render for a VA.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type OrgEntry, type OrgRewriteState } from '../../api/index.js';
import { noteServerDate, resetServerClockForTests } from '../../api/serverClock.js';

const getOrgList = vi.fn();
const getOrgUsage = vi.fn();
const getNotOnList = vi.fn();
const getNotOnListRecords = vi.fn();
const checkOrgText = vi.fn();
const addOrg = vi.fn();
const patchOrg = vi.fn();
const mergeOrg = vi.fn();
const deleteOrg = vi.fn();
const resolveNotOnList = vi.fn();
const runOrgRewriteAgain = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getOrgList: (...a: unknown[]) => getOrgList(...a),
    getOrgUsage: (...a: unknown[]) => getOrgUsage(...a),
    getNotOnList: (...a: unknown[]) => getNotOnList(...a),
    getNotOnListRecords: (...a: unknown[]) => getNotOnListRecords(...a),
    checkOrgText: (...a: unknown[]) => checkOrgText(...a),
    addOrg: (...a: unknown[]) => addOrg(...a),
    patchOrg: (...a: unknown[]) => patchOrg(...a),
    mergeOrg: (...a: unknown[]) => mergeOrg(...a),
    deleteOrg: (...a: unknown[]) => deleteOrg(...a),
    resolveNotOnList: (...a: unknown[]) => resolveNotOnList(...a),
    runOrgRewriteAgain: (...a: unknown[]) => runOrgRewriteAgain(...a),
  };
});

// Mutable auth - flip per test before render (the SettingsPage.test idiom).
let viewerIsAdmin = false;
vi.mock('../../app/AuthContext.js', () => ({
  useAuth: () => ({
    status: 'authenticated',
    me: { userId: 'u1', email: 'x@example.com', role: viewerIsAdmin ? 'admin' : 'va' },
    isAdmin: viewerIsAdmin,
    refresh: vi.fn(),
  }),
}));

import { OrgListSection } from './OrgListSection.js';

function entry(kind: OrgEntry['kind'], name: string, extra: Partial<OrgEntry> = {}): OrgEntry {
  return {
    orgId: `id-${name}`,
    kind,
    name,
    spellings: [],
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'system',
    ...extra,
  };
}

const ATLANTA = entry('housing_authority', 'Atlanta Housing Authority', {
  orgId: 'o-atl',
  spellings: ['AHA'],
  notes: 'Main office downtown',
});
const DEKALB = entry('housing_authority', 'DeKalb County Housing Authority', { orgId: 'o-dek', spellings: ['HADC'] });
const STEP_UP = entry('agency', 'Step Up', { orgId: 'o-step' });
const USAGE = {
  'o-atl': { tenants: 3, otherContacts: 1, properties: 2, deleted: 2 },
  'o-dek': { tenants: 0, otherContacts: 0, properties: 0, deleted: 0 },
  'o-step': { tenants: 1, otherContacts: 0, properties: 0, deleted: 0 },
};
// dashboard/src/test/setup.ts pins Date.now() to 2026-07-01T12:00:00Z.
const FAILED: OrgRewriteState = {
  jobId: 'j1',
  action: 'merge',
  fromTexts: ['Atlanta HA'],
  fields: ['housingAuthority', 'accepted_authorities'],
  toName: 'Atlanta Housing Authority',
  status: 'failed',
  heartbeatAt: '2026-07-01T11:00:00.000Z',
  startedAt: '2026-07-01T11:00:00.000Z',
  startedBy: 'u1',
  counts: { housingAuthority: 2 },
};
const RUNNING: OrgRewriteState = { ...FAILED, status: 'running', heartbeatAt: '2026-07-01T11:59:59.000Z' };

function renderSection(): void {
  render(
    <MemoryRouter>
      <OrgListSection />
    </MemoryRouter>,
  );
}

const region = (name: string): HTMLElement => screen.getByRole('region', { name });

/** One entry's row in a list region, by its exact name (S14 S3). */
function entryRow(regionName: string, name: string): HTMLElement {
  const header = within(region(regionName)).getByRole('rowheader', { name });
  const row = header.closest('tr');
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
}

beforeEach(() => {
  viewerIsAdmin = false;
  getOrgList.mockReset().mockResolvedValue({ version: 1, entries: [ATLANTA, DEKALB, STEP_UP] });
  getOrgUsage.mockReset().mockResolvedValue(USAGE);
  getNotOnList.mockReset().mockResolvedValue([]);
  getNotOnListRecords.mockReset();
  checkOrgText.mockReset().mockResolvedValue({ candidates: [], close: [] });
  addOrg.mockReset();
  patchOrg.mockReset();
  mergeOrg.mockReset();
  deleteOrg.mockReset();
  resolveNotOnList.mockReset();
  runOrgRewriteAgain.mockReset();
});

describe('OrgListSection - everyone', () => {
  it('shows both lists as tables: the name, its spellings, its notes and what uses it', async () => {
    renderSection();
    const atlanta = await waitFor(() => entryRow('Housing authorities', 'Atlanta Housing Authority'));
    expect(atlanta).toHaveTextContent('AHA');
    expect(atlanta).toHaveTextContent('Main office downtown');
    await waitFor(() => expect(atlanta).toHaveTextContent('3 tenants, 1 other contact, 2 properties (+2 deleted)'));
    expect(entryRow('Agencies', 'Step Up')).toHaveTextContent('1 tenant, 0 other contacts, 0 properties');
    expect(within(region('Housing authorities')).queryByRole('rowheader', { name: 'Step Up' })).not.toBeInTheDocument();
  });

  it('a VA gets Add and Edit notes, and no admin action at all', async () => {
    renderSection();
    const row = await waitFor(() => entryRow('Housing authorities', 'Atlanta Housing Authority'));
    expect(within(row).getAllByRole('button')).toHaveLength(1);
    expect(within(row).getByRole('button', { name: 'Edit notes for Atlanta Housing Authority' })).toBeInTheDocument();
    expect(within(region('Agencies')).getByRole('button', { name: 'Add agency' })).toBeInTheDocument();
    expect(within(region('Housing authorities')).getByRole('button', { name: 'Add housing authority' })).toBeInTheDocument();
  });

  it('Add opens "Is this really new?" with an empty Name; the added entry appears with its notes', async () => {
    const user = userEvent.setup();
    const finch = entry('agency', 'Finch Mission', { orgId: 'o-finch', notes: 'Added today' });
    addOrg.mockResolvedValue(finch);
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Add agency' }));
    const dialog = screen.getByRole('dialog', { name: 'Is this really new?' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('');
    getOrgList.mockResolvedValue({ version: 2, entries: [ATLANTA, DEKALB, STEP_UP, finch] });
    await user.type(name, 'Finch Mission');
    await user.type(within(dialog).getByRole('textbox', { name: 'Notes' }), 'Added today');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Yes, add it' })).toBeEnabled());
    await user.click(within(dialog).getByRole('button', { name: 'Yes, add it' }));
    expect(addOrg).toHaveBeenCalledWith({ kind: 'agency', name: 'Finch Mission', notes: 'Added today' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await waitFor(() => entryRow('Agencies', 'Finch Mission'))).toHaveTextContent('Added today');
  });

  it('everyone edits notes; Save sends only the notes and re-reads the list', async () => {
    const user = userEvent.setup();
    patchOrg.mockResolvedValue({ entry: { ...ATLANTA, notes: 'Moved to Peachtree' } });
    renderSection();
    const row = await waitFor(() => entryRow('Housing authorities', 'Atlanta Housing Authority'));
    await user.click(within(row).getByRole('button', { name: 'Edit notes for Atlanta Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit notes' });
    const notes = within(dialog).getByRole('textbox', { name: 'Notes' });
    expect(notes).toHaveValue('Main office downtown');
    getOrgList.mockResolvedValue({ version: 2, entries: [{ ...ATLANTA, notes: 'Moved to Peachtree' }, DEKALB, STEP_UP] });
    await user.clear(notes);
    await user.type(notes, 'Moved to Peachtree');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(patchOrg).toHaveBeenCalledWith('o-atl', { notes: 'Moved to Peachtree' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(entryRow('Housing authorities', 'Atlanta Housing Authority')).toHaveTextContent('Moved to Peachtree'),
    );
  });

  it('a refused notes save says why in staff words', async () => {
    const user = userEvent.setup();
    patchOrg.mockRejectedValue(new ApiError(400, 'org_notes_too_long', 'org_notes_too_long'));
    renderSection();
    const row = await waitFor(() => entryRow('Housing authorities', 'Atlanta Housing Authority'));
    await user.click(within(row).getByRole('button', { name: 'Edit notes for Atlanta Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit notes' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Notes' }), ' and more');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Notes can be at most 500 characters.');
  });

  it('shows the latest rewrite; a VA never gets Run again', async () => {
    getOrgList.mockResolvedValue({ version: 3, entries: [ATLANTA], lastRewrite: FAILED });
    renderSection();
    expect(
      await screen.findByText(
        'The last update failed: merging Atlanta HA into Atlanta Housing Authority. Housing authority fields: 2.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run again' })).not.toBeInTheDocument();
  });

  it('a list that fails to load offers Retry', async () => {
    const user = userEvent.setup();
    getOrgList.mockRejectedValueOnce(new ApiError(503, 'org_list_busy', 'org_list_busy'));
    renderSection();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load housing authorities and agencies.");
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await waitFor(() => entryRow('Housing authorities', 'Atlanta Housing Authority'))).toBeInTheDocument();
  });
});

describe('OrgListSection - admin', () => {
  beforeEach(() => {
    viewerIsAdmin = true;
  });

  it('runs a failed rewrite again, and the status follows it', async () => {
    const user = userEvent.setup();
    getOrgList
      .mockResolvedValueOnce({ version: 3, entries: [ATLANTA], lastRewrite: FAILED })
      .mockResolvedValue({ version: 3, entries: [ATLANTA], lastRewrite: RUNNING });
    runOrgRewriteAgain.mockResolvedValue(RUNNING);
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Run again' }));
    expect(runOrgRewriteAgain).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText('Updating records: merging Atlanta HA into Atlanta Housing Authority.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run again' })).not.toBeInTheDocument();
  });

  it('never offers Run again for the cleanup script - it says to re-run the script', async () => {
    getOrgList.mockResolvedValue({ version: 3, entries: [ATLANTA], lastRewrite: { ...FAILED, action: 'cleanup' } });
    renderSection();
    expect(await screen.findByText(/Re-run the cleanup script to finish it\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run again' })).not.toBeInTheDocument();
  });
});

// Code review R1-ADV-FE-4: the heartbeat is a SERVER stamp, judged by the
// server's 15-minute lock on the server's clock - so the page judges it on
// serverNowMs() too, never on a skewed browser clock (pinned to 12:00:00Z).
describe('OrgListSection - the latest rewrite on the server clock', () => {
  beforeEach(() => {
    viewerIsAdmin = true;
  });
  afterEach(() => resetServerClockForTests());

  it('a browser running 20 minutes FAST: a live rewrite reads as running, Rename waits, no Run again', async () => {
    noteServerDate('Wed, 01 Jul 2026 11:40:00 GMT', Date.now());
    getOrgList.mockResolvedValue({
      version: 3,
      entries: [ATLANTA],
      lastRewrite: { ...RUNNING, heartbeatAt: '2026-07-01T11:39:50.000Z' },
    });
    renderSection();
    expect(
      await screen.findByText('Updating records: merging Atlanta HA into Atlanta Housing Authority.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run again' })).not.toBeInTheDocument();
    const row = entryRow('Housing authorities', 'Atlanta Housing Authority');
    expect(within(row).getByRole('button', { name: 'Rename Atlanta Housing Authority' })).toBeDisabled();
  });

  it('a browser running 20 minutes SLOW: a stalled rewrite says so and offers Run again', async () => {
    noteServerDate('Wed, 01 Jul 2026 12:20:00 GMT', Date.now());
    getOrgList.mockResolvedValue({
      version: 3,
      entries: [ATLANTA],
      lastRewrite: { ...RUNNING, heartbeatAt: '2026-07-01T12:04:00.000Z' },
    });
    renderSection();
    expect(
      await screen.findByText('An update stopped responding: merging Atlanta HA into Atlanta Housing Authority.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run again' })).toBeInTheDocument();
  });
});

describe('OrgListSection - admin entry actions', () => {
  beforeEach(() => {
    viewerIsAdmin = true;
  });

  it('an admin gets every entry action', async () => {
    renderSection();
    const row = await waitFor(() => entryRow('Housing authorities', 'Atlanta Housing Authority'));
    for (const name of ['Edit notes for', 'Edit spellings for', 'Rename', 'Merge', 'Change kind of', 'Delete']) {
      expect(within(row).getByRole('button', { name: `${name} Atlanta Housing Authority` })).toBeInTheDocument();
    }
  });

  it('Rename is one step: the new name, what it changes, then Rename', async () => {
    const user = userEvent.setup();
    patchOrg.mockResolvedValue({
      entry: { ...ATLANTA, name: 'Atlanta Housing Authority of Fulton' },
      lastRewrite: RUNNING,
      skippedSpellings: [],
    });
    renderSection();
    const row = await waitFor(() => entryRow('Housing authorities', 'Atlanta Housing Authority'));
    await waitFor(() => expect(row).toHaveTextContent('3 tenants'));
    await user.click(within(row).getByRole('button', { name: 'Rename Atlanta Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename Atlanta Housing Authority' });
    expect(dialog).toHaveTextContent('3 tenants, 1 other contact, 2 properties, 2 deleted');
    const rename = within(dialog).getByRole('button', { name: 'Rename' });
    expect(rename).toBeDisabled(); // the name is unchanged
    const box = within(dialog).getByRole('textbox', { name: 'New name' });
    await user.clear(box);
    await user.type(box, 'Atlanta Housing Authority of Fulton');
    await user.click(rename);
    expect(patchOrg).toHaveBeenCalledWith('o-atl', { name: 'Atlanta Housing Authority of Fulton' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(getOrgList).toHaveBeenCalledTimes(2));
  });

  it('a compound new name is refused with what it names and a pointer to Split', async () => {
    const user = userEvent.setup();
    patchOrg.mockRejectedValue(
      new ApiError(409, 'org_name_compound', 'org_name_compound', {
        error: 'org_name_compound',
        spans: [
          [{ orgId: 'o-dek', kind: 'housing_authority', name: 'DeKalb County Housing Authority' }],
          [{ orgId: 'o-step', kind: 'agency', name: 'Step Up' }],
        ],
      }),
    );
    renderSection();
    const row = await waitFor(() => entryRow('Housing authorities', 'Atlanta Housing Authority'));
    await user.click(within(row).getByRole('button', { name: 'Rename Atlanta Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename Atlanta Housing Authority' });
    const box = within(dialog).getByRole('textbox', { name: 'New name' });
    await user.clear(box);
    await user.type(box, 'DeKalb Step Up');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That names more than one organization (DeKalb County Housing Authority and Step Up), so it cannot be one entry. Use Split instead.',
    );
  });

  it('says when the old name could not be kept as a spelling (spec D12)', async () => {
    const user = userEvent.setup();
    patchOrg.mockResolvedValue({
      entry: { ...ATLANTA, name: 'Atlanta Metro Housing' },
      lastRewrite: RUNNING,
      skippedSpellings: [{ spelling: 'Atlanta Housing Authority', problem: 'shared_same_kind' }],
    });
    renderSection();
    const row = await waitFor(() => entryRow('Housing authorities', 'Atlanta Housing Authority'));
    await user.click(within(row).getByRole('button', { name: 'Rename Atlanta Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename Atlanta Housing Authority' });
    const box = within(dialog).getByRole('textbox', { name: 'New name' });
    await user.clear(box);
    await user.type(box, 'Atlanta Metro Housing');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(
      await screen.findByText(
        'Not kept as a spelling: Atlanta Housing Authority (another entry already has it, and a shared spelling is never applied automatically).',
      ),
    ).toBeInTheDocument();
  });

  it('spellings: a spelling another entry has asks first, then saves with confirmShared', async () => {
    const user = userEvent.setup();
    patchOrg
      .mockRejectedValueOnce(
        new ApiError(409, 'org_spelling_shared', 'org_spelling_shared', {
          error: 'org_spelling_shared',
          spelling: 'ATL',
          entries: [{ orgId: 'o-dek', kind: 'housing_authority', name: 'DeKalb County Housing Authority' }],
        }),
      )
      .mockResolvedValueOnce({ entry: { ...ATLANTA, spellings: ['AHA', 'ATL'] } });
    renderSection();
    const row = await waitFor(() => entryRow('Housing authorities', 'Atlanta Housing Authority'));
    await user.click(within(row).getByRole('button', { name: 'Edit spellings for Atlanta Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit spellings' });
    await user.type(within(dialog).getByRole('textbox', { name: 'New spelling' }), 'ATL');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(within(dialog).getByRole('button', { name: 'Remove ATL' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(patchOrg).toHaveBeenNthCalledWith(1, 'o-atl', { spellings: ['AHA', 'ATL'] });
    expect(
      await within(dialog).findByText(
        'ATL is now shared with DeKalb County Housing Authority - it will no longer be applied automatically.',
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save anyway' }));
    expect(patchOrg).toHaveBeenNthCalledWith(2, 'o-atl', { spellings: ['AHA', 'ATL'], confirmShared: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('merge offers only entries of the same kind, then Merge starts the update', async () => {
    const user = userEvent.setup();
    mergeOrg.mockResolvedValue(RUNNING);
    renderSection();
    const row = await waitFor(() => entryRow('Housing authorities', 'DeKalb County Housing Authority'));
    await user.click(within(row).getByRole('button', { name: 'Merge DeKalb County Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Merge DeKalb County Housing Authority' });
    expect(within(dialog).getByRole('button', { name: 'Merge' })).toBeDisabled();
    const select = within(dialog).getByRole('combobox', { name: 'Merge into' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose a name',
      'Atlanta Housing Authority',
    ]);
    await user.selectOptions(select, 'o-atl');
    expect(dialog).toHaveTextContent('become spellings of Atlanta Housing Authority');
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(mergeOrg).toHaveBeenCalledWith('o-dek', 'o-atl');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('delete and kind change wait until no record (deleted ones included) uses the entry', async () => {
    const user = userEvent.setup();
    deleteOrg.mockResolvedValue(undefined);
    patchOrg.mockResolvedValue({ entry: { ...DEKALB, kind: 'agency' } });
    renderSection();
    const atlanta = await waitFor(() => entryRow('Housing authorities', 'Atlanta Housing Authority'));
    await waitFor(() => expect(atlanta).toHaveTextContent('3 tenants'));
    await user.click(within(atlanta).getByRole('button', { name: 'Delete Atlanta Housing Authority' }));
    let dialog = screen.getByRole('dialog', { name: 'Delete Atlanta Housing Authority' });
    expect(dialog).toHaveTextContent(
      '8 records still hold this name (3 tenants, 1 other contact, 2 properties, 2 deleted).',
    );
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    const dekalb = entryRow('Housing authorities', 'DeKalb County Housing Authority');
    await user.click(within(dekalb).getByRole('button', { name: 'Change kind of DeKalb County Housing Authority' }));
    dialog = screen.getByRole('dialog', { name: 'Change kind of DeKalb County Housing Authority' });
    await user.click(within(dialog).getByRole('button', { name: 'Move to Agencies' }));
    expect(patchOrg).toHaveBeenCalledWith('o-dek', { kind: 'agency' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(
      within(entryRow('Housing authorities', 'DeKalb County Housing Authority')).getByRole('button', {
        name: 'Delete DeKalb County Housing Authority',
      }),
    );
    dialog = screen.getByRole('dialog', { name: 'Delete DeKalb County Housing Authority' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(deleteOrg).toHaveBeenCalledWith('o-dek');
  });

  it('while an update runs, Rename, Merge, Change kind and Delete wait for it', async () => {
    getOrgList.mockResolvedValue({ version: 1, entries: [ATLANTA, DEKALB, STEP_UP], lastRewrite: RUNNING });
    renderSection();
    const row = await waitFor(() => entryRow('Housing authorities', 'Atlanta Housing Authority'));
    // The server refuses all four with 409 org_rewrite_running while one runs (D11; plan 3.5).
    for (const name of ['Rename', 'Merge', 'Change kind of', 'Delete']) {
      expect(within(row).getByRole('button', { name: `${name} Atlanta Housing Authority` }), name).toBeDisabled();
    }
    expect(within(row).getByRole('button', { name: 'Edit spellings for Atlanta Housing Authority' })).toBeEnabled();
  });
});

// Code review R1-ADV-FE-6: a spelling typed into "New spelling" but never
// added was dropped by the footer Save, which still PATCHed the old list and
// closed as a success.
describe('OrgListSection - Save in Edit spellings never drops a typed spelling', () => {
  beforeEach(() => {
    viewerIsAdmin = true;
  });

  async function openSpellings(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    const row = await waitFor(() => entryRow('Housing authorities', 'Atlanta Housing Authority'));
    await user.click(within(row).getByRole('button', { name: 'Edit spellings for Atlanta Housing Authority' }));
    return screen.getByRole('dialog', { name: 'Edit spellings' });
  }

  it('a spelling typed but never added is saved with the list', async () => {
    const user = userEvent.setup();
    patchOrg.mockResolvedValue({ entry: { ...ATLANTA, spellings: ['AHA', 'ATL HA'] } });
    renderSection();
    const dialog = await openSpellings(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'New spelling' }), 'ATL HA');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(patchOrg).toHaveBeenCalledWith('o-atl', { spellings: ['AHA', 'ATL HA'] });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('a typed spelling that needs the shared confirm is still the one Save anyway sends', async () => {
    const user = userEvent.setup();
    patchOrg
      .mockRejectedValueOnce(
        new ApiError(409, 'org_spelling_shared', 'org_spelling_shared', {
          error: 'org_spelling_shared',
          spelling: 'ATL',
          entries: [{ orgId: 'o-dek', kind: 'housing_authority', name: 'DeKalb County Housing Authority' }],
        }),
      )
      .mockResolvedValueOnce({ entry: { ...ATLANTA, spellings: ['AHA', 'ATL'] } });
    renderSection();
    const dialog = await openSpellings(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'New spelling' }), 'ATL');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(patchOrg).toHaveBeenNthCalledWith(1, 'o-atl', { spellings: ['AHA', 'ATL'] });
    // Folded into the list on Save: it shows as a spelling while staff confirm.
    expect(within(dialog).getByRole('button', { name: 'Remove ATL' })).toBeInTheDocument();
    await user.click(await within(dialog).findByRole('button', { name: 'Save anyway' }));
    expect(patchOrg).toHaveBeenNthCalledWith(2, 'o-atl', { spellings: ['AHA', 'ATL'], confirmShared: true });
  });

  it.each([
    ['nothing changed', ''],
    ['a typed spelling the entry already has (the Add rule)', '  AHA '],
  ])('Save with %s sends nothing and just closes', async (_case, typed) => {
    const user = userEvent.setup();
    renderSection();
    const dialog = await openSpellings(user);
    if (typed !== '') await user.type(within(dialog).getByRole('textbox', { name: 'New spelling' }), typed);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(patchOrg).not.toHaveBeenCalled();
  });
});

describe('OrgListSection - a notice never outlives a later clean action', () => {
  const SKIPPED_NOTICE =
    'Not kept as a spelling: Atlanta Housing Authority (another entry already has it, and a shared spelling is never applied automatically).';
  const SKIPPED_RENAME = {
    entry: { ...ATLANTA, name: 'Atlanta Metro Housing' },
    lastRewrite: RUNNING,
    skippedSpellings: [{ spelling: 'Atlanta Housing Authority', problem: 'shared_same_kind' }],
  };

  beforeEach(() => {
    viewerIsAdmin = true;
  });

  async function renameAtlanta(user: ReturnType<typeof userEvent.setup>, to: string): Promise<void> {
    const row = await waitFor(() => entryRow('Housing authorities', 'Atlanta Housing Authority'));
    await user.click(within(row).getByRole('button', { name: 'Rename Atlanta Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename Atlanta Housing Authority' });
    const box = within(dialog).getByRole('textbox', { name: 'New name' });
    await user.clear(box);
    await user.type(box, to);
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }

  it('a notes save clears the notice an earlier rename left', async () => {
    const user = userEvent.setup();
    patchOrg
      .mockResolvedValueOnce(SKIPPED_RENAME)
      .mockResolvedValueOnce({ entry: { ...DEKALB, notes: 'Decatur office' } });
    renderSection();
    await renameAtlanta(user, 'Atlanta Metro Housing');
    expect(await screen.findByText(SKIPPED_NOTICE)).toBeInTheDocument();
    const dekalb = entryRow('Housing authorities', 'DeKalb County Housing Authority');
    await user.click(within(dekalb).getByRole('button', { name: 'Edit notes for DeKalb County Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit notes' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Notes' }), 'Decatur office');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(patchOrg).toHaveBeenLastCalledWith('o-dek', { notes: 'Decatur office' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText(SKIPPED_NOTICE)).not.toBeInTheDocument();
  });

  it('a rename that skipped nothing clears the notice an earlier rename left', async () => {
    const user = userEvent.setup();
    patchOrg
      .mockResolvedValueOnce(SKIPPED_RENAME)
      .mockResolvedValueOnce({ entry: { ...ATLANTA, name: 'Atlanta Housing' }, lastRewrite: RUNNING, skippedSpellings: [] });
    renderSection();
    await renameAtlanta(user, 'Atlanta Metro Housing');
    expect(await screen.findByText(SKIPPED_NOTICE)).toBeInTheDocument();
    await renameAtlanta(user, 'Atlanta Housing');
    expect(patchOrg).toHaveBeenLastCalledWith('o-atl', { name: 'Atlanta Housing' });
    expect(screen.queryByText(SKIPPED_NOTICE)).not.toBeInTheDocument();
  });
});

describe('OrgListSection - "Not on the list"', () => {
  it('everyone sees the values that are not on the list', async () => {
    getNotOnList.mockResolvedValue([
      {
        field: 'housingAuthority',
        value: 'atlanta_housing',
        count: 1,
        deletedCount: 0,
        resolution: { status: 'unknown', close: [] },
      },
    ]);
    renderSection();
    const notOnList = await screen.findByRole('region', { name: 'Not on the list' });
    expect(await within(notOnList).findByRole('rowheader', { name: 'atlanta_housing' })).toBeInTheDocument();
    expect(within(notOnList).queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('an admin settle re-reads the page and names a spelling it could not keep', async () => {
    viewerIsAdmin = true;
    const user = userEvent.setup();
    getNotOnList.mockResolvedValue([
      {
        field: 'housingAuthority',
        value: 'Atl HA',
        count: 1,
        deletedCount: 0,
        resolution: {
          status: 'unknown',
          close: [{ orgId: 'o-atl', kind: 'housing_authority', name: 'Atlanta Housing Authority' }],
        },
      },
    ]);
    checkOrgText.mockResolvedValue({ candidates: [], close: [], spellingProblem: null });
    resolveNotOnList.mockResolvedValue({
      lastRewrite: { ...RUNNING, action: 'use' },
      skippedSpellings: [{ spelling: 'Atl HA', problem: 'shared_same_kind' }],
    });
    renderSection();
    const notOnList = await screen.findByRole('region', { name: 'Not on the list' });
    const header = await within(notOnList).findByRole('rowheader', { name: 'Atl HA' });
    await user.click(within(header.closest('tr')!).getByRole('button', { name: 'Use Atlanta Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Settle Atl HA' });
    await user.click(within(dialog).getByRole('button', { name: 'Use Atlanta Housing Authority' }));
    expect(resolveNotOnList).toHaveBeenCalledWith({
      field: 'housingAuthority',
      value: 'Atl HA',
      action: 'use',
      name: 'Atlanta Housing Authority',
      rememberSpelling: true,
    });
    expect(
      await screen.findByText(
        'Not kept as a spelling: Atl HA (another entry already has it, and a shared spelling is never applied automatically).',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(getNotOnList).toHaveBeenCalledTimes(2));
  });
});
