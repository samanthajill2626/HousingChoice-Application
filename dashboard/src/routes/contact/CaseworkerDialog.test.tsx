import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type CaseworkerPreview, type Contact, type OrgEntry } from '../../api/index.js';

const previewCaseworker = vi.fn();
const makeCaseworker = vi.fn();
const getOrgList = vi.fn();
const checkOrgText = vi.fn();
const addOrg = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    previewCaseworker: (...a: unknown[]) => previewCaseworker(...a),
    makeCaseworker: (...a: unknown[]) => makeCaseworker(...a),
    getOrgList: (...a: unknown[]) => getOrgList(...a),
    checkOrgText: (...a: unknown[]) => checkOrgText(...a),
    addOrg: (...a: unknown[]) => addOrg(...a),
  };
});

import { CaseworkerDialog } from './CaseworkerDialog.js';
import { isCaseworkerContact } from './caseworkerRole.js';

function orgEntry(kind: OrgEntry['kind'], name: string, spellings: string[] = []): OrgEntry {
  return {
    orgId: `id-${name}`,
    kind,
    name,
    spellings,
    createdAt: '2026-10-07T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-07T00:00:00.000Z',
    updatedBy: 'system',
  };
}

const ORG_ENTRIES: OrgEntry[] = [
  orgEntry('housing_authority', 'Atlanta Housing Authority', ['AHA']),
  orgEntry('agency', 'Step Up'),
  orgEntry('agency', 'Hope Atlanta'),
];

const CLEAN: CaseworkerPreview = {
  contactId: 'c1',
  alreadyCaseworker: false,
  refusals: [],
  removes: { housingAuthority: 'Atlanta Housing Authority', agency: 'Hope Atlanta', pendingSuggestions: 2 },
  threads: { retype: 1, leftShared: 2, leftOther: 1 },
  organization: { value: 'Hope Atlanta', source: 'list_match' },
};

const CONVERTED: Contact = {
  contactId: 'c1',
  type: 'partner',
  role: 'Caseworker',
  firstName: 'Dana',
  lastName: 'Reyes',
  organization: 'Hope Atlanta',
};

function renderDialog(): { onConverted: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
  const onConverted = vi.fn();
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <CaseworkerDialog contactId="c1" name="Dana Reyes" onConverted={onConverted} onClose={onClose} />
    </MemoryRouter>,
  );
  return { onConverted, onClose };
}

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Make Dana Reyes a caseworker' });
const confirm = (): HTMLElement => screen.getByRole('button', { name: 'Make caseworker' });
const organization = (): HTMLElement => screen.getByRole('combobox', { name: 'Organization' });

async function ready(): Promise<void> {
  await within(dialog()).findByText('Past tours, closed placements, properties sent and other details stay on the record.');
  await waitFor(() => expect(confirm()).toBeEnabled());
}

beforeEach(() => {
  previewCaseworker.mockReset().mockResolvedValue(CLEAN);
  makeCaseworker.mockReset().mockResolvedValue(CONVERTED);
  getOrgList.mockReset().mockResolvedValue({ version: 1, entries: ORG_ENTRIES });
  checkOrgText.mockReset().mockResolvedValue({ candidates: [], close: [] });
  addOrg.mockReset();
});

describe('isCaseworkerContact (the STORED-contact test, spec D16)', () => {
  it.each([
    [{ type: 'partner', role: 'Caseworker' }, true],
    [{ type: 'partner', role: 'case worker' }, true],
    [{ type: 'partner', role: 'Case Manager' }, false],
    [{ type: 'partner' }, false],
    [{ type: 'tenant', role: 'Caseworker' }, false],
    [{ type: 'landlord', role: 'Case worker' }, false],
  ] as const)('%o -> %s', (contact, expected) => {
    expect(isCaseworkerContact(contact)).toBe(expected);
  });
});

describe('CaseworkerDialog', () => {
  it('reads the preview for this contact when it opens and says what the conversion does', async () => {
    renderDialog();
    expect(previewCaseworker).toHaveBeenCalledTimes(1);
    expect(previewCaseworker).toHaveBeenCalledWith('c1', expect.any(AbortSignal));
    // Confirm waits for the preview.
    expect(confirm()).toBeDisabled();
    await ready();
    const d = dialog();
    expect(within(d).getByText('Housing authority: Atlanta Housing Authority')).toBeInTheDocument();
    expect(within(d).getByText('Agency: Hope Atlanta')).toBeInTheDocument();
    expect(within(d).getByText('2 pending AI suggestions')).toBeInTheDocument();
    expect(within(d).getByText('1 conversation will become a partner conversation.')).toBeInTheDocument();
    expect(within(d).getByText('2 shared conversations stay as they are.')).toBeInTheDocument();
    expect(within(d).getByText('1 conversation without a type stays as it is.')).toBeInTheDocument();
    // The picker shows the preview's organization.
    expect(organization()).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Remove Hope Atlanta' })).toBeInTheDocument();
  });

  it('the plural thread sentences are plan 3.9 verbatim', async () => {
    previewCaseworker.mockResolvedValue({ ...CLEAN, threads: { retype: 2, leftShared: 3, leftOther: 2 } });
    renderDialog();
    await ready();
    const d = dialog();
    expect(within(d).getByText('2 conversations will become partner conversations.')).toBeInTheDocument();
    expect(within(d).getByText('3 shared conversations stay as they are.')).toBeInTheDocument();
    expect(within(d).getByText('2 conversations without a type stay as they are.')).toBeInTheDocument();
  });

  it('an existing caseworker: no Organization picker, it says Confirm re-runs the cleanup, and sends no organization (plan review R1 ruling B8)', async () => {
    const user = userEvent.setup();
    previewCaseworker.mockResolvedValue({
      ...CLEAN,
      alreadyCaseworker: true,
      organization: { value: 'Hope Atlanta', source: 'stored' },
    });
    renderDialog();
    await ready();
    const d = dialog();
    expect(within(d).getByText('This contact is already a caseworker. Confirming re-runs the cleanup.')).toBeInTheDocument();
    expect(within(d).queryByRole('combobox', { name: 'Organization' })).toBeNull();
    await user.click(confirm());
    expect(makeCaseworker).toHaveBeenCalledWith('c1', {});
  });

  it('says nothing about a count that is zero', async () => {
    previewCaseworker.mockResolvedValue({
      ...CLEAN,
      removes: { pendingSuggestions: 0 },
      threads: { retype: 3, leftShared: 0, leftOther: 0 },
      organization: { source: 'none' },
    });
    renderDialog();
    await ready();
    const d = dialog();
    expect(within(d).queryByText(/pending AI suggestion/)).toBeNull();
    expect(within(d).queryByText(/stay as they are|stays as it is/)).toBeNull();
    expect(within(d).queryByText(/^Housing authority:/)).toBeNull();
    expect(within(d).getByText('3 conversations will become partner conversations.')).toBeInTheDocument();
  });

  it('an untouched picker sends no organization - the server decides', async () => {
    const user = userEvent.setup();
    const { onConverted } = renderDialog();
    await ready();
    await user.click(confirm());
    expect(makeCaseworker).toHaveBeenCalledWith('c1', {});
    await waitFor(() => expect(onConverted).toHaveBeenCalledWith(CONVERTED));
  });

  it('an untouched carried value stays visible and omits organization from make', async () => {
    const user = userEvent.setup();
    previewCaseworker.mockResolvedValue({
      ...CLEAN,
      organization: { value: 'Old agency text', source: 'carried' },
    });
    renderDialog();
    await ready();
    expect(within(dialog()).getByRole('button', { name: 'Remove Old agency text' })).toBeInTheDocument();
    expect(within(dialog()).getByText('Not on the list')).toBeInTheDocument();
    await user.click(confirm());
    expect(makeCaseworker).toHaveBeenCalledWith('c1', {});
  });

  it('a cleared picker sends organization ""', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Remove Hope Atlanta' }));
    await user.click(confirm());
    expect(makeCaseworker).toHaveBeenCalledWith('c1', { organization: '' });
  });

  it('a pick of either kind sends that name', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    await user.type(organization(), 'step');
    await user.click(await screen.findByRole('option', { name: /^Step Up/ }));
    await user.click(confirm());
    expect(makeCaseworker).toHaveBeenCalledWith('c1', { organization: 'Step Up' });
  });

  it('typed text naming one entry is committed by Confirm; other text stops it (R4-08)', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    await user.type(organization(), 'Nowhere Partners');
    await user.click(confirm());
    expect(makeCaseworker).not.toHaveBeenCalled();
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'Pick a name from the list, add it as new, or clear the text.',
    );
    await user.clear(organization());
    await user.type(organization(), 'AHA');
    await user.click(confirm());
    expect(makeCaseworker).toHaveBeenCalledWith('c1', { organization: 'Atlanta Housing Authority' });
  });

  it('every refusal in the preview shows its sentence and link, and Confirm stays disabled (R4-09)', async () => {
    previewCaseworker.mockResolvedValue({
      ...CLEAN,
      refusals: [
        { code: 'caseworker_open_placement', placementId: 'p 7' },
        { code: 'caseworker_open_tour', tourId: 't1' },
        { code: 'caseworker_landlord_of_record', unitId: 'u1' },
        { code: 'caseworker_on_roster', unitId: 'u2' },
      ],
    });
    renderDialog();
    const d = dialog();
    expect(await within(d).findByText("Finish or close this contact's placement first.")).toBeInTheDocument();
    expect(within(d).getByText("Cancel or close this contact's open tour first.")).toBeInTheDocument();
    expect(
      within(d).getByText(
        "This contact is the landlord of record for a property. Change that property's landlord first.",
      ),
    ).toBeInTheDocument();
    expect(
      within(d).getByText("This contact is on a property's contact list. Remove them from it first."),
    ).toBeInTheDocument();
    expect(within(d).getByRole('link', { name: 'View placement' })).toHaveAttribute('href', '/placements/p%207');
    expect(within(d).getByRole('link', { name: 'View tour' })).toHaveAttribute('href', '/tours/t1');
    expect(
      within(d).getAllByRole('link', { name: 'View property' }).map((a) => a.getAttribute('href')),
    ).toEqual(['/listings/u1', '/listings/u2']);
    expect(confirm()).toBeDisabled();
    expect(confirm()).toHaveAccessibleDescription(/Finish or close this contact's placement first\./);
  });

  it('a refusal answered by make replaces the preview and disables Confirm', async () => {
    const user = userEvent.setup();
    makeCaseworker.mockRejectedValue(
      new ApiError(409, 'caseworker_on_roster', 'caseworker_on_roster', {
        error: 'caseworker_on_roster',
        refusals: [{ code: 'caseworker_on_roster', unitId: 'u2' }],
      }),
    );
    const { onConverted } = renderDialog();
    await ready();
    await user.click(confirm());
    expect(
      await within(dialog()).findByText("This contact is on a property's contact list. Remove them from it first."),
    ).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
    expect(onConverted).not.toHaveBeenCalled();
  });

  it('contact_changed says so, reads the preview again and starts the picker from it', async () => {
    const user = userEvent.setup();
    makeCaseworker
      .mockRejectedValueOnce(new ApiError(409, 'contact_changed', 'contact_changed', { error: 'contact_changed' }))
      .mockResolvedValueOnce(CONVERTED);
    previewCaseworker
      .mockResolvedValueOnce(CLEAN)
      .mockResolvedValueOnce({ ...CLEAN, organization: { value: 'Step Up', source: 'stored' } });
    renderDialog();
    await ready();
    await user.click(confirm());
    expect(
      await within(dialog()).findByText('This contact changed while this was open. Review and try again.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(previewCaseworker).toHaveBeenCalledTimes(2));
    expect(await within(dialog()).findByRole('button', { name: 'Remove Step Up' })).toBeInTheDocument();
    await waitFor(() => expect(confirm()).toBeEnabled());
    // The new preview is the new baseline: untouched again, nothing is sent.
    await user.click(confirm());
    expect(makeCaseworker).toHaveBeenLastCalledWith('c1', {});
  });

  it('a 422 org_not_on_list on organization shows under the picker, never the code', async () => {
    const user = userEvent.setup();
    makeCaseworker.mockRejectedValue(
      new ApiError(422, 'org_not_on_list', 'org_not_on_list', {
        error: 'org_not_on_list',
        field: 'organization',
        text: 'Step Up',
        candidates: [],
        close: [],
      }),
    );
    renderDialog();
    await ready();
    await user.type(organization(), 'step');
    await user.click(await screen.findByRole('option', { name: /^Step Up/ }));
    await user.click(confirm());
    const alert = await within(dialog()).findByRole('alert');
    expect(alert).toHaveTextContent(/Step Up is not on the list/);
    expect(alert.textContent ?? '').not.toContain('org_not_on_list');
  });

  it('any other failure gets the generic line and Confirm again', async () => {
    const user = userEvent.setup();
    makeCaseworker.mockRejectedValue(new Error('offline'));
    renderDialog();
    await ready();
    await user.click(confirm());
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      "Couldn't make this contact a caseworker - please try again.",
    );
    expect(confirm()).toBeEnabled();
  });

  it('a failed preview read says so; Try again reads it again', async () => {
    const user = userEvent.setup();
    previewCaseworker.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(CLEAN);
    renderDialog();
    expect(await within(dialog()).findByText("Couldn't check this contact - please try again.")).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
    await user.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    await ready();
    expect(previewCaseworker).toHaveBeenCalledTimes(2);
  });

  it('"Add <text> as a new organization" asks for the kind; the added name fills the picker (R2-F3)', async () => {
    const user = userEvent.setup();
    addOrg.mockResolvedValue(orgEntry('agency', 'Metro Partners'));
    renderDialog();
    await ready();
    await user.type(organization(), 'Metro Partners');
    await user.click(await screen.findByRole('option', { name: 'Add Metro Partners as a new organization' }));
    const isNew = screen.getByRole('dialog', { name: 'Is this really new?' });
    const yes = within(isNew).getByRole('button', { name: 'Yes, add it' });
    expect(yes).toBeDisabled(); // no default kind
    await user.click(within(isNew).getByRole('radio', { name: 'Agency' }));
    await waitFor(() => expect(yes).toBeEnabled());
    await user.click(yes);
    expect(addOrg).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agency', name: 'Metro Partners' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Is this really new?' })).not.toBeInTheDocument(),
    );
    expect(within(dialog()).getByRole('button', { name: 'Remove Metro Partners' })).toBeInTheDocument();
    await user.click(confirm());
    expect(makeCaseworker).toHaveBeenCalledWith('c1', { organization: 'Metro Partners' });
  });

  it('Cancel closes without a write', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(makeCaseworker).not.toHaveBeenCalled();
  });
});
