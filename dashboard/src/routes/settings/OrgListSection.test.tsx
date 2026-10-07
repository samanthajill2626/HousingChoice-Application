// OrgListSection tests - Settings > Housing authorities & agencies (spec
// 2026-10-06 D10-D13; S14 selector contract S1-S8): the lists as tables with
// use counts, Add through "Is this really new?", notes, the latest rewrite,
// and the admin-only actions that never render for a VA.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type OrgEntry, type OrgRewriteState } from '../../api/index.js';

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
