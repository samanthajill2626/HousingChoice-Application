import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, PossibleCaseworkerRow } from '../../api/index.js';
import { formatPhone } from '../contact/format.js';

const getAllContacts = vi.fn();
const listPossibleCaseworkers = vi.fn();
const dismissPossibleCaseworker = vi.fn();
const previewCaseworker = vi.fn();
const makeCaseworker = vi.fn();
const getOrgList = vi.fn();
const checkOrgText = vi.fn();
const addOrg = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getAllContacts: (...a: unknown[]) => getAllContacts(...a),
    listPossibleCaseworkers: (...a: unknown[]) => listPossibleCaseworkers(...a),
    dismissPossibleCaseworker: (...a: unknown[]) => dismissPossibleCaseworker(...a),
    previewCaseworker: (...a: unknown[]) => previewCaseworker(...a),
    makeCaseworker: (...a: unknown[]) => makeCaseworker(...a),
    getOrgList: (...a: unknown[]) => getOrgList(...a),
    checkOrgText: (...a: unknown[]) => checkOrgText(...a),
    addOrg: (...a: unknown[]) => addOrg(...a),
  };
});

import { CaseworkersList } from './CaseworkersList.js';

const CW_HOPE: Contact = {
  contactId: 'cw1',
  type: 'partner',
  role: 'Caseworker',
  firstName: 'Ana',
  lastName: 'Lopez',
  phone: '+14040100056',
  organization: 'Hope Atlanta',
};
const CW_NONE: Contact = { contactId: 'cw2', type: 'partner', role: 'case worker', firstName: 'Ben', lastName: 'Ortiz' };
const PLAIN_PARTNER: Contact = { contactId: 'p3', type: 'partner', firstName: 'Renee', lastName: 'Carter' };
const MANAGER: Contact = { contactId: 'p4', type: 'partner', role: 'Case Manager', firstName: 'Cal', lastName: 'Mays' };

const DANA: PossibleCaseworkerRow = {
  contactId: 't9',
  firstName: 'Dana',
  lastName: 'Reyes',
  phone: '+14040100090',
  type: 'tenant',
  role: 'Case manager',
  signals: ['role_mentions', 'relationship'],
};
const RENEE: PossibleCaseworkerRow = {
  contactId: 'p3',
  firstName: 'Renee',
  lastName: 'Carter',
  type: 'partner',
  signals: ['partner_no_role'],
};

const PREVIEW = {
  contactId: 't9',
  alreadyCaseworker: false,
  refusals: [],
  removes: { pendingSuggestions: 0 },
  threads: { retype: 1, leftShared: 0, leftOther: 0 },
  organization: { source: 'none' },
};

function Probe(): React.JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{loc.search}</div>;
}

function renderAt(url = '/contacts/caseworkers'): void {
  render(
    <MemoryRouter initialEntries={[url]}>
      <CaseworkersList />
      <Probe />
    </MemoryRouter>,
  );
}

const caseworkerRows = async (): Promise<HTMLElement[]> =>
  within(await screen.findByRole('list', { name: 'Caseworkers' })).getAllByRole('listitem');
const possibleList = async (): Promise<HTMLElement> => screen.findByRole('list', { name: 'Possible caseworkers' });

beforeEach(() => {
  getAllContacts.mockReset().mockResolvedValue([CW_HOPE, CW_NONE, PLAIN_PARTNER, MANAGER]);
  listPossibleCaseworkers.mockReset().mockResolvedValue([DANA, RENEE]);
  dismissPossibleCaseworker.mockReset();
  previewCaseworker.mockReset().mockResolvedValue(PREVIEW);
  makeCaseworker.mockReset();
  getOrgList.mockReset().mockResolvedValue({ version: 1, entries: [] });
  checkOrgText.mockReset().mockResolvedValue({ candidates: [], close: [] });
  addOrg.mockReset();
});

describe('CaseworkersList - the caseworkers (spec 2026-10-06 D18)', () => {
  it('reads the partners and lists only caseworkers, with organization and phone', async () => {
    renderAt();
    expect(screen.getByRole('heading', { level: 1, name: 'Caseworkers' })).toBeInTheDocument();
    expect(getAllContacts).toHaveBeenCalledWith({ type: 'partner' }, expect.any(AbortSignal));
    const rows = await caseworkerRows();
    expect(rows).toHaveLength(2);
    const ana = rows.find((r) => r.textContent?.includes('Ana Lopez'));
    expect(ana).toBeDefined();
    expect(within(ana!).getByText('Hope Atlanta')).toBeInTheDocument();
    expect(within(ana!).getByText(formatPhone('+14040100056'))).toBeInTheDocument();
    expect(within(ana!).getByRole('link')).toHaveAttribute('href', '/contacts/cw1');
    // A role-less partner and a non-caseworker role are not caseworkers.
    const list = screen.getByRole('list', { name: 'Caseworkers' });
    expect(within(list).queryByText(/Renee Carter|Cal Mays/)).toBeNull();
  });

  it('says so when there are none', async () => {
    getAllContacts.mockResolvedValue([PLAIN_PARTNER]);
    renderAt();
    expect(await screen.findByText('No caseworkers yet.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Caseworkers' })).toBeNull();
  });

  it('marks Caseworkers active in the Filter contacts links', async () => {
    renderAt();
    await caseworkerRows();
    await possibleList();
    const bar = screen.getByRole('navigation', { name: 'Filter contacts' });
    expect(within(bar).getByRole('link', { name: 'Caseworkers' })).toHaveAttribute('aria-current', 'page');
    expect(within(bar).getByRole('link', { name: 'Tenants' })).not.toHaveAttribute('aria-current');
  });

  it('filters by Organization chips written to the URL as org', async () => {
    const user = userEvent.setup();
    renderAt();
    await caseworkerRows();
    const group = screen.getByRole('group', { name: 'Organization' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Hope Atlanta (1)',
      'Not recorded (1)',
    ]);
    await user.click(within(group).getByRole('button', { name: 'Hope Atlanta (1)' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('?org=hope+atlanta');
    expect((await caseworkerRows()).map((r) => r.textContent)).toEqual([
      expect.stringContaining('Ana Lopez'),
    ]);
    await user.click(within(group).getByRole('button', { name: 'Clear organization filter' }));
    expect(await caseworkerRows()).toHaveLength(2);
  });

  it('a shared link filters; a ghost org key is ignored', async () => {
    renderAt('/contacts/caseworkers?org=__none__');
    expect((await caseworkerRows()).map((r) => r.textContent)).toEqual([expect.stringContaining('Ben Ortiz')]);
  });

  it('a stale org key never empties the list', async () => {
    renderAt('/contacts/caseworkers?org=nobody');
    expect(await caseworkerRows()).toHaveLength(2);
  });

  it('says when no caseworker has an organization', async () => {
    getAllContacts.mockResolvedValue([CW_NONE]);
    renderAt();
    await caseworkerRows();
    const group = screen.getByRole('group', { name: 'Organization' });
    expect(within(group).getByText('No organizations recorded yet')).toBeInTheDocument();
  });

  it('a failed partner read says so', async () => {
    getAllContacts.mockRejectedValue(new Error('offline'));
    renderAt();
    expect(await screen.findByText("We couldn't load caseworkers. Please try again.")).toBeInTheDocument();
  });
});

describe('CaseworkersList - Possible caseworkers (spec 2026-10-06 D19, D22)', () => {
  it('lists each possible row with its kind, phone and one label per signal', async () => {
    renderAt();
    expect(screen.getByRole('heading', { level: 2, name: 'Possible caseworkers' })).toBeInTheDocument();
    const list = await possibleList();
    const [dana, renee] = within(list).getAllByRole('listitem');
    expect(within(dana!).getByRole('link', { name: 'Dana Reyes' })).toHaveAttribute('href', '/contacts/t9');
    expect(within(dana!).getByText('Case manager')).toBeInTheDocument();
    expect(within(dana!).getByText(formatPhone('+14040100090'))).toBeInTheDocument();
    expect(within(dana!).getByText('Role mentions caseworker')).toBeInTheDocument();
    expect(within(dana!).getByText('Linked as a caseworker')).toBeInTheDocument();
    expect(within(dana!).getByRole('button', { name: 'Make Dana Reyes a caseworker' })).toBeInTheDocument();
    expect(within(dana!).getByRole('button', { name: 'Dana Reyes is not a caseworker' })).toBeInTheDocument();
    expect(within(renee!).getByText('Partner')).toBeInTheDocument();
    expect(within(renee!).getByText('Partner with no role')).toBeInTheDocument();
  });

  it('labels the AI-note signal', async () => {
    listPossibleCaseworkers.mockResolvedValue([{ ...DANA, signals: ['ai_note'] }]);
    renderAt();
    expect(within(await possibleList()).getByText('AI noted caseworker')).toBeInTheDocument();
  });

  it('Make caseworker opens the conversion dialog; a success reads both lists again', async () => {
    const user = userEvent.setup();
    makeCaseworker.mockResolvedValue({ ...DANA, type: 'partner', role: 'Caseworker' });
    renderAt();
    await user.click(within(await possibleList()).getByRole('button', { name: 'Make Dana Reyes a caseworker' }));
    expect(screen.getByRole('dialog', { name: 'Make Dana Reyes a caseworker' })).toBeInTheDocument();
    expect(previewCaseworker).toHaveBeenCalledWith('t9', expect.any(AbortSignal));
    const confirm = screen.getByRole('button', { name: 'Make caseworker' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    expect(makeCaseworker).toHaveBeenCalledWith('t9', {});
    await waitFor(() => expect(getAllContacts).toHaveBeenCalledTimes(2));
    expect(listPossibleCaseworkers).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog', { name: 'Make Dana Reyes a caseworker' })).toBeNull();
  });

  it('Not a caseworker asks first; Hide dismisses and drops the row without a re-read', async () => {
    const user = userEvent.setup();
    dismissPossibleCaseworker.mockResolvedValue({ contactId: 't9', type: 'tenant' });
    renderAt();
    await user.click(within(await possibleList()).getByRole('button', { name: 'Dana Reyes is not a caseworker' }));
    const confirm = screen.getByRole('dialog', { name: 'Hide Dana Reyes from Possible caseworkers?' });
    expect(within(confirm).getByText("This can't be undone in the app.")).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Hide' }));
    expect(dismissPossibleCaseworker).toHaveBeenCalledWith('t9');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Hide Dana Reyes from Possible caseworkers?' })).toBeNull(),
    );
    expect(within(await possibleList()).queryByText('Dana Reyes')).toBeNull();
    expect(within(await possibleList()).getByText('Renee Carter')).toBeInTheDocument();
    expect(listPossibleCaseworkers).toHaveBeenCalledTimes(1);
  });

  it('Cancel hides nothing; a failed Hide says so and keeps the dialog', async () => {
    const user = userEvent.setup();
    dismissPossibleCaseworker.mockRejectedValue(new Error('offline'));
    renderAt();
    await user.click(within(await possibleList()).getByRole('button', { name: 'Dana Reyes is not a caseworker' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(dismissPossibleCaseworker).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /Hide Dana Reyes/ })).toBeNull();

    await user.click(within(await possibleList()).getByRole('button', { name: 'Dana Reyes is not a caseworker' }));
    const confirm = screen.getByRole('dialog', { name: 'Hide Dana Reyes from Possible caseworkers?' });
    await user.click(within(confirm).getByRole('button', { name: 'Hide' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      "Couldn't hide this contact - please try again.",
    );
    expect(within(await possibleList()).getByText('Dana Reyes')).toBeInTheDocument();
  });

  it('a failed Possible read says so and leaves the caseworkers list working', async () => {
    listPossibleCaseworkers.mockRejectedValue(new Error('offline'));
    renderAt();
    expect(await screen.findByText("We couldn't load possible caseworkers. Please try again.")).toBeInTheDocument();
    expect(await caseworkerRows()).toHaveLength(2);
  });

  it('says so when nobody is left to review', async () => {
    listPossibleCaseworkers.mockResolvedValue([]);
    renderAt();
    expect(await screen.findByText('No possible caseworkers right now.')).toBeInTheDocument();
  });
});
