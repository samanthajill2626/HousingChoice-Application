// OrgListSection tests - Settings > Housing authorities & agencies (spec
// 2026-10-06 D10-D13; S14 selector contract S1-S8; design review 2026-10-07
// Option B): three segments with counts and a search, a list of links beside
// a detail panel, the selection in the URL and focus following it, Add
// through "Is this really new?", notes, the latest rewrite, and the
// admin-only actions that never render for a VA.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
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

/** The URL the page is on, read after each render (the URL is the selection). */
let currentUrl = '';
function LocationProbe(): null {
  const location = useLocation();
  currentUrl = `${location.pathname}${location.search}`;
  return null;
}

function renderSection(path = '/settings/organizations'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings/organizations/:orgId?" element={<OrgListSection />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** Stub matchMedia: true = the two-pane shell's narrow width (one pane at a time). */
function stubNarrow(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
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

type User = ReturnType<typeof userEvent.setup>;

const region = (name: string): HTMLElement => screen.getByRole('region', { name });

/** One entry's row in a list (a link named by the exact name), once loaded. */
async function findRow(list: string, name: string): Promise<HTMLElement> {
  return within(await screen.findByRole('region', { name: list })).findByRole('link', { name });
}

/** Pick an entry in its list; returns the detail panel (a region named by the entry). */
async function openEntry(user: User, list: string, name: string): Promise<HTMLElement> {
  if (list === 'Agencies') await user.click(await screen.findByRole('button', { name: /^Agencies/ }));
  await user.click(await findRow(list, name));
  return screen.getByRole('region', { name });
}

beforeEach(() => {
  viewerIsAdmin = false;
  stubNarrow(false);
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OrgListSection - the lists', () => {
  it('shows three segments with counts; a list row names the entry and how many records use it', async () => {
    getNotOnList.mockResolvedValue([
      { field: 'agency', value: 'Step-Up', count: 1, deletedCount: 0, resolution: { status: 'unknown', close: [] } },
    ]);
    renderSection();
    const atlanta = await findRow('Housing authorities', 'Atlanta Housing Authority');
    expect(atlanta).toHaveAttribute('href', '/settings/organizations/o-atl');
    await waitFor(() => expect(atlanta).toHaveAccessibleDescription('8 records'));
    expect(await findRow('Housing authorities', 'DeKalb County Housing Authority')).toHaveAccessibleDescription(
      'Not used',
    );
    expect(within(region('Housing authorities')).queryByRole('link', { name: 'Step Up' })).not.toBeInTheDocument();
    const lists = screen.getByRole('group', { name: 'Lists' });
    expect(within(lists).getByRole('button', { name: 'Housing authorities 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(lists).getByRole('button', { name: 'Agencies 1' })).toHaveAttribute('aria-pressed', 'false');
    expect(await within(lists).findByRole('button', { name: 'Not on the list 1' })).toBeInTheDocument();
  });

  it('a segment switches the list on screen and is kept in the URL', async () => {
    const user = userEvent.setup();
    renderSection();
    await findRow('Housing authorities', 'Atlanta Housing Authority');
    await user.click(screen.getByRole('button', { name: /^Agencies/ }));
    expect(currentUrl).toBe('/settings/organizations?view=agencies');
    expect(await findRow('Agencies', 'Step Up')).toHaveAccessibleDescription('1 record');
    expect(screen.queryByRole('region', { name: 'Housing authorities' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Not on the list/ }));
    expect(currentUrl).toBe('/settings/organizations?view=not-on-list');
    expect(within(region('Not on the list')).getByText('Every stored value is on the lists.')).toBeInTheDocument();
  });

  it('the search finds names and spellings in every list, and the counts say where', async () => {
    const user = userEvent.setup();
    renderSection();
    await findRow('Housing authorities', 'Atlanta Housing Authority');
    const search = screen.getByRole('searchbox', { name: 'Search names and spellings' });
    await user.type(search, 'hadc');
    const list = region('Housing authorities');
    expect(within(list).getByRole('link', { name: 'DeKalb County Housing Authority' })).toBeInTheDocument();
    expect(within(list).queryByRole('link', { name: 'Atlanta Housing Authority' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Housing authorities 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agencies 0' })).toBeInTheDocument();
    // Compared the way names are: case and punctuation do not matter.
    await user.clear(search);
    await user.type(search, 'step-up');
    expect(within(list).getByText('No housing authorities match "step-up".')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agencies 1' })).toBeInTheDocument();
  });

  it('a VA gets Add on each list and only Edit notes in the panel - no admin action at all', async () => {
    const user = userEvent.setup();
    renderSection();
    expect(
      within(await screen.findByRole('region', { name: 'Housing authorities' })).getByRole('button', {
        name: 'Add housing authority',
      }),
    ).toBeInTheDocument();
    const panel = await openEntry(user, 'Housing authorities', 'Atlanta Housing Authority');
    expect(within(panel).getAllByRole('button').map((b) => b.textContent)).toEqual(['Edit notes']);
    expect(within(panel).getByRole('button', { name: 'Edit notes for Atlanta Housing Authority' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Agencies/ }));
    expect(within(region('Agencies')).getByRole('button', { name: 'Add agency' })).toBeInTheDocument();
  });

  it('a list that fails to load offers Retry', async () => {
    const user = userEvent.setup();
    getOrgList.mockRejectedValueOnce(new ApiError(503, 'org_list_busy', 'org_list_busy'));
    renderSection();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load housing authorities and agencies.");
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await findRow('Housing authorities', 'Atlanta Housing Authority')).toBeInTheDocument();
  });
});

describe('OrgListSection - the detail panel', () => {
  it('shows the spellings as chips, the notes and what uses the entry', async () => {
    const user = userEvent.setup();
    renderSection();
    const panel = await openEntry(user, 'Housing authorities', 'Atlanta Housing Authority');
    expect(within(panel).getByRole('heading', { name: 'Atlanta Housing Authority' })).toBeInTheDocument();
    expect(panel).toHaveTextContent('Housing authority');
    const chips = within(panel).getByRole('list', { name: 'Spellings of Atlanta Housing Authority' });
    expect(within(chips).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['AHA']);
    expect(panel).toHaveTextContent('Main office downtown');
    await waitFor(() => expect(panel).toHaveTextContent('3 tenants, 1 other contact, 2 properties (+2 deleted)'));
  });

  it('a spelling that holds a comma stays one chip (design review P7)', async () => {
    const user = userEvent.setup();
    const commas = { ...ATLANTA, spellings: ['AHA', 'Atlanta, aha, Atlanta housing'] };
    getOrgList.mockResolvedValue({ version: 1, entries: [commas, DEKALB, STEP_UP] });
    renderSection();
    const panel = await openEntry(user, 'Housing authorities', 'Atlanta Housing Authority');
    const chips = within(panel).getByRole('list', { name: 'Spellings of Atlanta Housing Authority' });
    expect(within(chips).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'AHA',
      'Atlanta, aha, Atlanta housing',
    ]);
  });

  it('an unused entry says so; empty spellings and notes say so in words', async () => {
    const user = userEvent.setup();
    renderSection();
    const panel = await openEntry(user, 'Housing authorities', 'DeKalb County Housing Authority');
    await waitFor(() => expect(panel).toHaveTextContent('Not used'));
    expect(panel).toHaveTextContent('No notes yet.');
    const stepUp = await openEntry(user, 'Agencies', 'Step Up');
    expect(stepUp).toHaveTextContent('No spellings.');
  });

  it('picking an entry puts it in the URL and moves focus to the panel; Close returns it to the row', async () => {
    const user = userEvent.setup();
    renderSection();
    const row = await findRow('Housing authorities', 'Atlanta Housing Authority');
    await user.click(row);
    expect(currentUrl).toBe('/settings/organizations/o-atl');
    expect(row).toHaveAttribute('aria-current', 'page');
    const panel = region('Atlanta Housing Authority');
    expect(within(panel).getByRole('heading', { name: 'Atlanta Housing Authority' })).toHaveFocus();
    await user.click(within(panel).getByRole('link', { name: 'Close' }));
    expect(currentUrl).toBe('/settings/organizations');
    expect(screen.queryByRole('region', { name: 'Atlanta Housing Authority' })).not.toBeInTheDocument();
    expect(await findRow('Housing authorities', 'Atlanta Housing Authority')).toHaveFocus();
  });

  it('a link to an entry opens it in its own list without taking focus', async () => {
    renderSection('/settings/organizations/o-step');
    const panel = await screen.findByRole('region', { name: 'Step Up' });
    expect(within(panel).getByRole('heading', { name: 'Step Up' })).not.toHaveFocus();
    expect(screen.getByRole('button', { name: /^Agencies/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(region('Agencies')).getByRole('link', { name: 'Step Up' })).toHaveAttribute('aria-current', 'page');
  });

  it('a link to an entry that is gone says so', async () => {
    renderSection('/settings/organizations/o-gone');
    const panel = await screen.findByRole('region', { name: 'Name not found' });
    expect(panel).toHaveTextContent('it may have been merged or deleted');
    expect(within(panel).getByRole('link', { name: 'Close' })).toHaveAttribute('href', '/settings/organizations');
  });

  it('on a phone one pane shows at a time: the panel has a Back link, and Back returns focus to the row', async () => {
    stubNarrow(true);
    const user = userEvent.setup();
    renderSection();
    const row = await findRow('Housing authorities', 'Atlanta Housing Authority');
    expect(screen.getByRole('searchbox', { name: 'Search names and spellings' })).toBeInTheDocument();
    await user.click(row);
    const panel = region('Atlanta Housing Authority');
    // Nothing above the panel but the update status: no segments, no search.
    expect(screen.queryByRole('group', { name: 'Lists' })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    await user.click(within(panel).getByRole('link', { name: 'Back to Housing authorities' }));
    expect(currentUrl).toBe('/settings/organizations');
    expect(await findRow('Housing authorities', 'Atlanta Housing Authority')).toHaveFocus();
  });
});

describe('OrgListSection - Add and notes (everyone)', () => {
  it('Add opens "Is this really new?" with an empty Name; the added entry opens in the panel with its notes', async () => {
    const user = userEvent.setup();
    const finch = entry('agency', 'Finch Mission', { orgId: 'o-finch', notes: 'Added today' });
    addOrg.mockResolvedValue(finch);
    renderSection();
    await user.click(await screen.findByRole('button', { name: /^Agencies/ }));
    await user.click(screen.getByRole('button', { name: 'Add agency' }));
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
    expect(currentUrl).toBe('/settings/organizations/o-finch');
    expect(await screen.findByRole('region', { name: 'Finch Mission' })).toHaveTextContent('Added today');
    expect(await findRow('Agencies', 'Finch Mission')).toHaveAttribute('aria-current', 'page');
  });

  it('everyone edits notes; Save sends only the notes and re-reads the list', async () => {
    const user = userEvent.setup();
    patchOrg.mockResolvedValue({ entry: { ...ATLANTA, notes: 'Moved to Peachtree' } });
    renderSection();
    const panel = await openEntry(user, 'Housing authorities', 'Atlanta Housing Authority');
    await user.click(within(panel).getByRole('button', { name: 'Edit notes for Atlanta Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit notes' });
    const notes = within(dialog).getByRole('textbox', { name: 'Notes' });
    expect(notes).toHaveValue('Main office downtown');
    getOrgList.mockResolvedValue({ version: 2, entries: [{ ...ATLANTA, notes: 'Moved to Peachtree' }, DEKALB, STEP_UP] });
    await user.clear(notes);
    await user.type(notes, 'Moved to Peachtree');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(patchOrg).toHaveBeenCalledWith('o-atl', { notes: 'Moved to Peachtree' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(region('Atlanta Housing Authority')).toHaveTextContent('Moved to Peachtree'));
  });

  it('a refused notes save says why in staff words', async () => {
    const user = userEvent.setup();
    patchOrg.mockRejectedValue(new ApiError(400, 'org_notes_too_long', 'org_notes_too_long'));
    renderSection();
    const panel = await openEntry(user, 'Housing authorities', 'Atlanta Housing Authority');
    await user.click(within(panel).getByRole('button', { name: 'Edit notes for Atlanta Housing Authority' }));
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

  it('an update the list outgrew says why and is not offered Run again (code review R3-BE-4)', async () => {
    // The job's claim refused it - the list changed since it started - and
    // Run again would answer 409 org_rewrite_target_gone for the same reason.
    getOrgList.mockResolvedValue({
      version: 3,
      entries: [ATLANTA],
      lastRewrite: { ...FAILED, error: 'org_rewrite_target_gone: a name it writes left the list or changed kind' },
    });
    renderSection();
    expect(
      await screen.findByText(
        'The last update failed: merging Atlanta HA into Atlanta Housing Authority. Housing authority fields: 2. The list changed since this update started, so it cannot run again - start a new one from the list.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run again' })).not.toBeInTheDocument();
    expect(runOrgRewriteAgain).not.toHaveBeenCalled();
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
    renderSection('/settings/organizations/o-atl');
    expect(
      await screen.findByText('Updating records: merging Atlanta HA into Atlanta Housing Authority.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run again' })).not.toBeInTheDocument();
    const panel = region('Atlanta Housing Authority');
    expect(within(panel).getByRole('button', { name: 'Rename Atlanta Housing Authority' })).toBeDisabled();
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

  it('an admin gets every entry action, labeled, in the panel', async () => {
    const user = userEvent.setup();
    renderSection();
    const panel = await openEntry(user, 'Housing authorities', 'Atlanta Housing Authority');
    expect(within(panel).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Edit notes',
      'Edit spellings',
      'Rename',
      'Merge',
      'Change kind',
      'Delete',
    ]);
    for (const name of ['Edit notes for', 'Edit spellings for', 'Rename', 'Merge', 'Change kind of', 'Delete']) {
      expect(within(panel).getByRole('button', { name: `${name} Atlanta Housing Authority` })).toBeEnabled();
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
    const panel = await openEntry(user, 'Housing authorities', 'Atlanta Housing Authority');
    await waitFor(() => expect(panel).toHaveTextContent('3 tenants'));
    await user.click(within(panel).getByRole('button', { name: 'Rename Atlanta Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename Atlanta Housing Authority' });
    expect(dialog).toHaveTextContent('3 tenants, 1 other contact, 2 properties, 2 deleted');
    const rename = within(dialog).getByRole('button', { name: 'Rename' });
    expect(rename).toBeDisabled(); // the name is unchanged
    const box = within(dialog).getByRole('textbox', { name: 'New name' });
    await user.clear(box);
    await user.type(box, 'Atlanta Housing Authority of Fulton');
    getOrgList.mockResolvedValue({
      version: 2,
      entries: [{ ...ATLANTA, name: 'Atlanta Housing Authority of Fulton' }, DEKALB, STEP_UP],
      lastRewrite: RUNNING,
    });
    await user.click(rename);
    expect(patchOrg).toHaveBeenCalledWith('o-atl', { name: 'Atlanta Housing Authority of Fulton' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(getOrgList).toHaveBeenCalledTimes(2));
    // The same entry stays selected under its new name.
    expect(await screen.findByRole('region', { name: 'Atlanta Housing Authority of Fulton' })).toBeInTheDocument();
    expect(currentUrl).toBe('/settings/organizations/o-atl');
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
    const panel = await openEntry(user, 'Housing authorities', 'Atlanta Housing Authority');
    await user.click(within(panel).getByRole('button', { name: 'Rename Atlanta Housing Authority' }));
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
    const panel = await openEntry(user, 'Housing authorities', 'Atlanta Housing Authority');
    await user.click(within(panel).getByRole('button', { name: 'Rename Atlanta Housing Authority' }));
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
    const panel = await openEntry(user, 'Housing authorities', 'Atlanta Housing Authority');
    await user.click(within(panel).getByRole('button', { name: 'Edit spellings for Atlanta Housing Authority' }));
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

  it('merge offers only entries of the same kind; Merge starts the update and the panel goes back to the list', async () => {
    const user = userEvent.setup();
    mergeOrg.mockResolvedValue(RUNNING);
    renderSection();
    const panel = await openEntry(user, 'Housing authorities', 'DeKalb County Housing Authority');
    await user.click(within(panel).getByRole('button', { name: 'Merge DeKalb County Housing Authority' }));
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
    // The merged entry leaves the list: focus goes to the list, not to its row.
    expect(currentUrl).toBe('/settings/organizations');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Housing authorities' })).toHaveFocus());
  });

  it('delete and kind change wait until no record (deleted ones included) uses the entry', async () => {
    const user = userEvent.setup();
    deleteOrg.mockResolvedValue(undefined);
    patchOrg.mockResolvedValue({ entry: { ...DEKALB, kind: 'agency' } });
    renderSection();
    const atlanta = await openEntry(user, 'Housing authorities', 'Atlanta Housing Authority');
    await waitFor(() => expect(atlanta).toHaveTextContent('3 tenants'));
    await user.click(within(atlanta).getByRole('button', { name: 'Delete Atlanta Housing Authority' }));
    let dialog = screen.getByRole('dialog', { name: 'Delete Atlanta Housing Authority' });
    expect(dialog).toHaveTextContent(
      '8 records still hold this name (3 tenants, 1 other contact, 2 properties, 2 deleted).',
    );
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    const dekalb = await openEntry(user, 'Housing authorities', 'DeKalb County Housing Authority');
    await user.click(within(dekalb).getByRole('button', { name: 'Change kind of DeKalb County Housing Authority' }));
    dialog = screen.getByRole('dialog', { name: 'Change kind of DeKalb County Housing Authority' });
    getOrgList.mockResolvedValue({ version: 2, entries: [ATLANTA, { ...DEKALB, kind: 'agency' }, STEP_UP] });
    await user.click(within(dialog).getByRole('button', { name: 'Move to Agencies' }));
    expect(patchOrg).toHaveBeenCalledWith('o-dek', { kind: 'agency' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The entry stays selected and its new kind's list comes with it.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Agencies/ })).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(within(region('Agencies')).getByRole('link', { name: 'DeKalb County Housing Authority' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await user.click(
      within(region('DeKalb County Housing Authority')).getByRole('button', {
        name: 'Delete DeKalb County Housing Authority',
      }),
    );
    dialog = screen.getByRole('dialog', { name: 'Delete DeKalb County Housing Authority' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(deleteOrg).toHaveBeenCalledWith('o-dek');
    await waitFor(() => expect(currentUrl).toBe('/settings/organizations?view=agencies'));
  });

  it('while an update runs, Rename, Merge, Change kind and Delete wait - and say why in visible text', async () => {
    getOrgList.mockResolvedValue({ version: 1, entries: [ATLANTA, DEKALB, STEP_UP], lastRewrite: RUNNING });
    renderSection('/settings/organizations/o-atl');
    const panel = await screen.findByRole('region', { name: 'Atlanta Housing Authority' });
    const reason = 'Another update is still running. Rename, Merge, Change kind and Delete wait until it finishes.';
    expect(within(panel).getByText(reason)).toBeVisible();
    // The server refuses all four with 409 org_rewrite_running while one runs (D11; plan 3.5).
    for (const name of ['Rename', 'Merge', 'Change kind of', 'Delete']) {
      const button = within(panel).getByRole('button', { name: `${name} Atlanta Housing Authority` });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAccessibleDescription(reason);
      expect(button, name).not.toHaveAttribute('title');
    }
    expect(within(panel).getByRole('button', { name: 'Edit spellings for Atlanta Housing Authority' })).toBeEnabled();
  });
});

// Code review R1-ADV-FE-6: a spelling typed into "New spelling" but never
// added was dropped by the footer Save, which still PATCHed the old list and
// closed as a success.
describe('OrgListSection - Save in Edit spellings never drops a typed spelling', () => {
  beforeEach(() => {
    viewerIsAdmin = true;
  });

  async function openSpellings(user: User): Promise<HTMLElement> {
    const panel = await openEntry(user, 'Housing authorities', 'Atlanta Housing Authority');
    await user.click(within(panel).getByRole('button', { name: 'Edit spellings for Atlanta Housing Authority' }));
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

  async function renameAtlanta(user: User, to: string): Promise<void> {
    const panel = await openEntry(user, 'Housing authorities', 'Atlanta Housing Authority');
    await user.click(within(panel).getByRole('button', { name: 'Rename Atlanta Housing Authority' }));
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
    const dekalb = await openEntry(user, 'Housing authorities', 'DeKalb County Housing Authority');
    await user.click(within(dekalb).getByRole('button', { name: 'Edit notes for DeKalb County Housing Authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit notes' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Notes' }), 'Decatur office');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(patchOrg).toHaveBeenLastCalledWith('o-dek', { notes: 'Decatur office' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText(SKIPPED_NOTICE)).not.toBeInTheDocument();
  });

  it('an Add clears the notice an earlier rename left (code review R1-CONF-2)', async () => {
    const user = userEvent.setup();
    patchOrg.mockResolvedValueOnce(SKIPPED_RENAME);
    addOrg.mockResolvedValue(entry('agency', 'Finch Mission', { orgId: 'o-finch' }));
    renderSection();
    await renameAtlanta(user, 'Atlanta Metro Housing');
    expect(await screen.findByText(SKIPPED_NOTICE)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Agencies/ }));
    await user.click(screen.getByRole('button', { name: 'Add agency' }));
    const dialog = screen.getByRole('dialog', { name: 'Is this really new?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Finch Mission');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Yes, add it' })).toBeEnabled());
    await user.click(within(dialog).getByRole('button', { name: 'Yes, add it' }));
    expect(addOrg).toHaveBeenCalledWith({ kind: 'agency', name: 'Finch Mission' });
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
  const ATL_HA = {
    field: 'housingAuthority' as const,
    value: 'Atl HA',
    count: 1,
    deletedCount: 0,
    resolution: {
      status: 'unknown' as const,
      close: [{ orgId: 'o-atl', kind: 'housing_authority' as const, name: 'Atlanta Housing Authority' }],
    },
  };

  it('everyone sees the values, each a link to its own URL; a VA gets no settling', async () => {
    const user = userEvent.setup();
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
    await user.click(await screen.findByRole('button', { name: 'Not on the list 1' }));
    const row = within(region('Not on the list')).getByRole('link', { name: 'atlanta_housing' });
    expect(row).toHaveAccessibleDescription('Housing authority - 1 record');
    expect(row).toHaveAttribute(
      'href',
      '/settings/organizations?view=not-on-list&field=housingAuthority&value=atlanta_housing',
    );
    await user.click(row);
    const panel = screen.getByRole('region', { name: 'atlanta_housing' });
    expect(within(panel).getByRole('heading', { name: 'atlanta_housing' })).toHaveFocus();
    expect(within(panel).queryByRole('group', { name: 'Settle this value' })).not.toBeInTheDocument();
    expect(within(panel).getAllByRole('button').map((b) => b.textContent)).toEqual(['Show records']);
  });

  it('a link to a value opens it; a value no record holds any more says so', async () => {
    getNotOnList.mockResolvedValue([ATL_HA]);
    renderSection('/settings/organizations?view=not-on-list&field=housingAuthority&value=Atl%20HA');
    expect(await screen.findByRole('region', { name: 'Atl HA' })).toHaveTextContent('Unknown - close to');
    expect(within(region('Not on the list')).getByRole('link', { name: 'Atl HA' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('a value that is gone from the list says so', async () => {
    renderSection('/settings/organizations?view=not-on-list&field=agency&value=Gone%20Aid');
    expect(await screen.findByRole('region', { name: 'Gone Aid' })).toHaveTextContent(
      'No record holds this value any more - it was settled or changed.',
    );
  });

  it('an admin settle re-reads the page, names a spelling it could not keep, and goes back to the list', async () => {
    viewerIsAdmin = true;
    const user = userEvent.setup();
    getNotOnList.mockResolvedValue([ATL_HA]);
    checkOrgText.mockResolvedValue({ candidates: [], close: [], spellingProblem: null });
    resolveNotOnList.mockResolvedValue({
      lastRewrite: { ...RUNNING, action: 'use' },
      skippedSpellings: [{ spelling: 'Atl HA', problem: 'shared_same_kind' }],
    });
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Not on the list 1' }));
    await user.click(within(region('Not on the list')).getByRole('link', { name: 'Atl HA' }));
    const settle = within(region('Atl HA')).getByRole('group', { name: 'Settle this value' });
    await user.click(within(settle).getByRole('radio', { name: 'Use Atlanta Housing Authority' }));
    await user.click(within(settle).getByRole('button', { name: 'Use Atlanta Housing Authority' }));
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
    expect(currentUrl).toBe('/settings/organizations?view=not-on-list');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Not on the list' })).toHaveFocus());
  });
});
