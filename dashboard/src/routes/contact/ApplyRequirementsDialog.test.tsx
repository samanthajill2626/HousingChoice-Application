import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Contact, type UnitItem } from '../../api/index.js';

const getContact = vi.fn();
const getAllUnits = vi.fn();
const applyLandlordRequirements = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContact: (...a: unknown[]) => getContact(...a),
    getAllUnits: (...a: unknown[]) => getAllUnits(...a),
    applyLandlordRequirements: (...a: unknown[]) => applyLandlordRequirements(...a),
  };
});

import { ApplyRequirementsDialog } from './ApplyRequirementsDialog.js';

const LANDLORD: Contact = {
  contactId: 'L1',
  type: 'landlord',
  firstName: 'James',
  lastName: 'Porter',
  req_no_pets: true,
  req_pet_fee: '$300',
  req_credit_requirements: '600+',
};
// beds: 3, so its row is named "1 Match St - 3BR" - the landlord Properties
// card's label (planner ruling on accessible names).
const MATCH: UnitItem = {
  unitId: 'u-match',
  landlordId: 'L1',
  status: 'available',
  address: { line1: '1 Match St' },
  beds: 3,
  no_pets: true,
  pet_fee: '$300',
  credit_requirements: '600+',
  requirement_sources: { pets: 'copied', credit_requirements: 'copied' },
};
const OLD: UnitItem = {
  unitId: 'u-old',
  landlordId: 'L1',
  status: 'occupied',
  address: { line1: '2 Old St' },
  no_pets: true,
  pet_fee: '$250',
  evictions_notes: 'Case by case',
  requirement_sources: { pets: 'copied' },
};
const OWN: UnitItem = {
  unitId: 'u-own',
  landlordId: 'L1',
  status: 'setup',
  address: { line1: '3 Own St' },
  pets: 'Cats OK',
  qualifications: 'Two references',
};
// Never listed: another landlord's property, and a deleted one.
const OTHER: UnitItem = { unitId: 'u-other', landlordId: 'L2', status: 'available', address: { line1: '9 Other St' } };
const DELETED: UnitItem = {
  unitId: 'u-deleted',
  landlordId: 'L1',
  status: 'available',
  address: { line1: '8 Deleted St' },
  deleted_at: '2026-06-01T00:00:00.000Z',
};

function many(n: number): UnitItem[] {
  return Array.from({ length: n }, (_, i): UnitItem => ({
    unitId: `u${i}`,
    landlordId: 'L1',
    status: 'available',
    address: { line1: `${i + 1} Many St` },
  }));
}

function renderDialog(): { onLandlordRead: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn>; onDone: ReturnType<typeof vi.fn> } {
  const handlers = { onLandlordRead: vi.fn(), onClose: vi.fn(), onDone: vi.fn() };
  render(<ApplyRequirementsDialog contactId="L1" {...handlers} />);
  return handlers;
}

/** The two columns, by the names the planner ruled: a group "What to copy"
 *  and a list "Which properties". */
async function columns(): Promise<{ copy: HTMLElement; which: HTMLElement }> {
  const dialog = await screen.findByRole('dialog', { name: 'Apply to properties' });
  const copy = await within(dialog).findByRole('group', { name: 'What to copy' });
  return { copy, which: within(dialog).getByRole('list', { name: 'Which properties' }) };
}
const rowBox = (which: HTMLElement, address: string): HTMLElement =>
  within(which).getByRole('checkbox', { name: address });
const row = (which: HTMLElement, address: string): HTMLElement => rowBox(which, address).closest('li') as HTMLElement;

beforeEach(() => {
  getContact.mockReset().mockResolvedValue(LANDLORD);
  getAllUnits.mockReset().mockResolvedValue([MATCH, OLD, OWN, OTHER, DELETED]);
  applyLandlordRequirements.mockReset();
});

describe('ApplyRequirementsDialog - reading', () => {
  it('re-reads the landlord and its properties on open, with a loading state, and hands the contact to the page', async () => {
    const { onLandlordRead } = renderDialog();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    await columns();
    expect(getContact).toHaveBeenCalledWith('L1', expect.any(AbortSignal));
    expect(getAllUnits).toHaveBeenCalledWith({ landlordId: 'L1' }, expect.any(AbortSignal));
    expect(onLandlordRead).toHaveBeenCalledWith(LANDLORD);
  });

  it('a failed landlord read shows the error with Try again, which reads both again', async () => {
    const user = userEvent.setup();
    getContact.mockReset().mockRejectedValueOnce(new ApiError(500, 'boom', 'x')).mockResolvedValue(LANDLORD);
    renderDialog();
    expect(await screen.findByText("Couldn't load this landlord's properties.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await columns();
    expect(getContact).toHaveBeenCalledTimes(2);
    expect(getAllUnits).toHaveBeenCalledTimes(2);
  });

  it('a failed properties read shows the same error', async () => {
    getAllUnits.mockReset().mockRejectedValue(new ApiError(503, 'unavailable', 'x'));
    renderDialog();
    expect(await screen.findByText("Couldn't load this landlord's properties.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('ApplyRequirementsDialog - the two columns', () => {
  it('What to copy: every item with the landlord value; filled items checked, blank ones unchecked and marked Clears', async () => {
    renderDialog();
    const { copy } = await columns();
    expect(within(copy).getAllByRole('checkbox')).toHaveLength(8);
    const pets = within(copy).getByRole('checkbox', { name: 'Pets' });
    expect(pets).toBeChecked();
    expect(pets).toHaveAccessibleDescription('No pets; pet fee $300');
    expect(within(copy).getByRole('checkbox', { name: 'Credit score' })).toBeChecked();
    for (const name of ['Evictions', 'Income requirements', 'Qualifications', 'Deposit', 'Application fee', 'Touring']) {
      const box = within(copy).getByRole('checkbox', { name });
      expect(box).not.toBeChecked();
      expect(box).toHaveAccessibleDescription('Clears');
      // "Clears" is visible text in the item's row.
      expect(box.closest('li')).toHaveTextContent('Clears');
    }
  });

  // Code review RD-8: "Clears" is the only visible warning that checking an
  // item ERASES values. jsdom computes no CSS, so the rule is read from disk:
  // the small semibold mark uses the amber text token (7.1:1 on white), never
  // the shared --c-warning (4.28:1, under AA's 4.5:1 for small text).
  it('the Clears mark uses the amber text token that passes AA contrast', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ApplyRequirementsDialog.module.css'), 'utf8');
    const rule = /\.clears\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/color:\s*var\(--c-evt-amber-text\);/);
    expect(rule).not.toContain('--c-warning');
  });

  it('Which properties: changes per row, own values marked, Already matches, and the starting state', async () => {
    renderDialog();
    const { which } = await columns();
    // One listitem per property, each holding exactly one checkbox, named by
    // the landlord Properties card's label ("address - NBR" when beds are known).
    const items = within(which).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    for (const li of items) expect(within(li).getAllByRole('checkbox')).toHaveLength(1);
    expect(rowBox(which, '1 Match St - 3BR')).toBeDisabled();
    expect(rowBox(which, '1 Match St - 3BR')).not.toBeChecked();
    expect(row(which, '1 Match St - 3BR')).toHaveTextContent('Already matches');
    expect(rowBox(which, '2 Old St')).toBeChecked();
    expect(row(which, '2 Old St')).toHaveTextContent('Credit score, Pets');
    expect(row(which, '2 Old St')).not.toHaveTextContent('own value');
    expect(row(which, '2 Old St')).toHaveTextContent('Occupied');
    expect(rowBox(which, '3 Own St')).not.toBeChecked();
    expect(row(which, '3 Own St')).toHaveTextContent('Credit score, Pets (own value)');
    expect(within(which).queryByRole('checkbox', { name: '9 Other St' })).toBeNull();
    expect(within(which).queryByRole('checkbox', { name: '8 Deleted St' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Update 1 property' })).toBeEnabled();
    // There is no Select all.
    expect(screen.queryByRole('button', { name: /select all/i })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /select all/i })).toBeNull();
  });

  it('an all-blank landlord: checking a Clears item marks existing values as own values', async () => {
    const user = userEvent.setup();
    getContact.mockReset().mockResolvedValue({ contactId: 'L1', type: 'landlord' } as Contact);
    getAllUnits.mockReset().mockResolvedValue([OWN]);
    renderDialog();
    const { copy, which } = await columns();
    expect(row(which, '3 Own St')).toHaveTextContent('Already matches');
    expect(screen.getByRole('button', { name: 'Update 0 properties' })).toBeDisabled();
    await user.click(within(copy).getByRole('checkbox', { name: 'Pets' }));
    expect(row(which, '3 Own St')).toHaveTextContent('Pets (own value)');
    expect(rowBox(which, '3 Own St')).not.toBeChecked();
  });

  it('unchecking an item recomputes every row: a row whose only own value was in it starts checked', async () => {
    const user = userEvent.setup();
    renderDialog();
    const { copy, which } = await columns();
    await user.click(within(copy).getByRole('checkbox', { name: 'Pets' }));
    expect(rowBox(which, '3 Own St')).toBeChecked();
    expect(row(which, '3 Own St')).toHaveTextContent('Credit score');
    expect(row(which, '3 Own St')).not.toHaveTextContent('own value');
    expect(screen.getByRole('button', { name: 'Update 2 properties' })).toBeEnabled();
  });

  it('a hand-unchecked row stays unchecked until it becomes Already matches', async () => {
    const user = userEvent.setup();
    renderDialog();
    const { copy, which } = await columns();
    await user.click(rowBox(which, '2 Old St'));
    expect(rowBox(which, '2 Old St')).not.toBeChecked();
    await user.click(within(copy).getByRole('checkbox', { name: 'Pets' }));
    expect(rowBox(which, '2 Old St')).not.toBeChecked(); // still has the credit change
    await user.click(within(copy).getByRole('checkbox', { name: 'Credit score' }));
    expect(row(which, '2 Old St')).toHaveTextContent('Already matches');
    await user.click(within(copy).getByRole('checkbox', { name: 'Credit score' }));
    expect(rowBox(which, '2 Old St')).toBeChecked(); // released: back to its starting state
  });

  it('a hand-checked row resets only when a left-column change ADDS an own value to it', async () => {
    const user = userEvent.setup();
    renderDialog();
    const { copy, which } = await columns();
    await user.click(rowBox(which, '3 Own St'));
    expect(rowBox(which, '3 Own St')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Update 2 properties' })).toBeEnabled();
    // Removing an item never resets it.
    await user.click(within(copy).getByRole('checkbox', { name: 'Credit score' }));
    expect(rowBox(which, '3 Own St')).toBeChecked();
    // Adding an item that is an own value here resets it: staff confirm again.
    await user.click(within(copy).getByRole('checkbox', { name: 'Qualifications' }));
    expect(rowBox(which, '3 Own St')).not.toBeChecked();
    // The changes read in display order (Screening before Pets).
    expect(row(which, '3 Own St')).toHaveTextContent('Qualifications (own value), Pets (own value)');
  });
});

describe('ApplyRequirementsDialog - Update', () => {
  it('sends the checked rows with their own values, the checked items and the landlord values; done hands the summary to the page', async () => {
    const user = userEvent.setup();
    applyLandlordRequirements.mockResolvedValue({
      updated: ['u-old'],
      skipped: [{ unitId: 'u-own', reason: 'changed_since_opened' }],
    });
    const { onDone } = renderDialog();
    const { which } = await columns();
    await user.click(rowBox(which, '3 Own St'));
    await user.click(screen.getByRole('button', { name: 'Update 2 properties' }));
    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({
        updated: 1,
        skipped: [{ unitId: 'u-own', address: '3 Own St', reason: 'changed since you opened this - review it again' }],
      }),
    );
    expect(applyLandlordRequirements).toHaveBeenCalledTimes(1);
    expect(applyLandlordRequirements).toHaveBeenCalledWith('L1', {
      units: [
        { unitId: 'u-old', ownItems: [] },
        { unitId: 'u-own', ownItems: ['pets'] },
      ],
      items: ['credit_requirements', 'pets'],
      expected: {
        credit_requirements: { credit_requirements: '600+' },
        pets: { no_pets: true, pets: null, pet_fee: '$300' },
      },
    });
  });

  it('sends more than 100 properties in batches of 100, one after another', async () => {
    const user = userEvent.setup();
    const units = many(150);
    getAllUnits.mockReset().mockResolvedValue(units);
    let releaseFirst: (value: unknown) => void = () => undefined;
    applyLandlordRequirements
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ updated: units.slice(100).map((u) => u.unitId), skipped: [] });
    const { onDone } = renderDialog();
    await columns();
    await user.click(screen.getByRole('button', { name: 'Update 150 properties' }));
    await waitFor(() => expect(applyLandlordRequirements).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Update 150 properties' })).toBeDisabled();
    releaseFirst({ updated: units.slice(0, 100).map((u) => u.unitId), skipped: [] });
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ updated: 150, skipped: [] }));
    expect(applyLandlordRequirements).toHaveBeenCalledTimes(2);
    const sizes = applyLandlordRequirements.mock.calls.map((c) => (c[1] as { units: unknown[] }).units.length);
    expect(sizes).toEqual([100, 50]);
  });

  it.each<[string, Error]>([
    ['answers 409', new ApiError(409, 'requirements_changed', 'x', { error: 'requirements_changed' })],
    ['fails', new TypeError('Failed to fetch')],
  ])('a later request that %s stops the run, re-reads and says how many landed', async (_label, failure) => {
    const user = userEvent.setup();
    const units = many(250);
    getAllUnits.mockReset().mockResolvedValue(units);
    applyLandlordRequirements
      .mockResolvedValueOnce({ updated: units.slice(0, 100).map((u) => u.unitId), skipped: [] })
      .mockRejectedValueOnce(failure);
    const { onDone, onClose } = renderDialog();
    await columns();
    await user.click(screen.getByRole('button', { name: 'Update 250 properties' }));
    expect(
      await screen.findByText('Updated 100 properties before this stopped. Review the rest and press Update again.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(getContact).toHaveBeenCalledTimes(2));
    expect(getAllUnits).toHaveBeenCalledTimes(2);
    expect(applyLandlordRequirements).toHaveBeenCalledTimes(2); // no third batch
    expect(onDone).not.toHaveBeenCalled();
    // Closing now: the page re-reads its properties (some were written).
    await columns();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('a first request answering 409 requirements_changed re-reads and asks for another look', async () => {
    const user = userEvent.setup();
    applyLandlordRequirements.mockRejectedValueOnce(
      new ApiError(409, 'requirements_changed', 'x', { error: 'requirements_changed' }),
    );
    getContact.mockReset().mockResolvedValueOnce(LANDLORD).mockResolvedValue({ ...LANDLORD, req_pet_fee: '$350' });
    const { onLandlordRead } = renderDialog();
    await columns();
    await user.click(screen.getByRole('button', { name: 'Update 1 property' }));
    expect(
      await screen.findByText("This landlord's requirements changed. Review the updated list and press Update again."),
    ).toBeInTheDocument();
    const { copy } = await columns();
    await waitFor(() =>
      expect(within(copy).getByRole('checkbox', { name: 'Pets' })).toHaveAccessibleDescription('No pets; pet fee $350'),
    );
    expect(onLandlordRead).toHaveBeenLastCalledWith({ ...LANDLORD, req_pet_fee: '$350' });
  });

  it('a first request failing any other way re-reads and says so (CI-5)', async () => {
    const user = userEvent.setup();
    applyLandlordRequirements.mockRejectedValueOnce(new ApiError(500, 'boom', 'x'));
    renderDialog();
    await columns();
    await user.click(screen.getByRole('button', { name: 'Update 1 property' }));
    expect(
      await screen.findByText("Couldn't update the properties. Review the list and press Update again."),
    ).toBeInTheDocument();
    await waitFor(() => expect(getContact).toHaveBeenCalledTimes(2));
  });

  it('Cancel before any Update closes without asking the page to re-read', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await columns();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledWith(false);
  });
});

// Worklist OR-17 (a divergence from the plan text, recorded for Cameron): the
// re-read after an Update that stopped or failed continues the same Apply -
// so it never re-checks an item staff unchecked, and an item the re-read
// landlord has since blanked comes back unchecked (never a surprise Clears).
// Worklist OR-34 (code review R3-1): EVERY re-read inside one open dialog
// carries, a first-request 409 requirements_changed included; only opening
// the dialog starts the left column from the defaults.
describe('ApplyRequirementsDialog - the left column across a re-read (worklist OR-17)', () => {
  const box = (copy: HTMLElement, name: string): HTMLElement => within(copy).getByRole('checkbox', { name });
  const sentItems = (call: number): string[] =>
    (applyLandlordRequirements.mock.calls[call]?.[1] as { items: string[] }).items;

  it('a first request failing other than with 409 keeps what staff unchecked; an item the landlord blanked comes back unchecked', async () => {
    const user = userEvent.setup();
    // Opened with Credit score, Income requirements and Pets; the re-read
    // finds Income requirements blanked.
    getContact
      .mockReset()
      .mockResolvedValueOnce({ ...LANDLORD, req_income_requirements: '3x rent' })
      .mockResolvedValue(LANDLORD);
    applyLandlordRequirements.mockRejectedValueOnce(new ApiError(500, 'boom', 'x'));
    renderDialog();
    const { copy } = await columns();
    expect(box(copy, 'Income requirements')).toBeChecked();
    // Staff leave Credit score out of this Apply.
    await user.click(box(copy, 'Credit score'));
    await user.click(screen.getByRole('button', { name: 'Update 2 properties' }));
    expect(
      await screen.findByText("Couldn't update the properties. Review the list and press Update again."),
    ).toBeInTheDocument();
    await waitFor(() => expect(getContact).toHaveBeenCalledTimes(2));
    const { copy: after } = await columns();
    // Still left out, although the re-read landlord still holds it.
    expect(box(after, 'Credit score')).not.toBeChecked();
    // Blanked since: unchecked, so it is never copied as a clear unasked.
    expect(box(after, 'Income requirements')).not.toBeChecked();
    expect(box(after, 'Income requirements')).toHaveAccessibleDescription('Clears');
    // Kept by staff and still held: still checked.
    expect(box(after, 'Pets')).toBeChecked();
  });

  it('a stopped run (a later batch failing) keeps what staff unchecked after the re-read', async () => {
    const user = userEvent.setup();
    const units = many(150);
    getAllUnits.mockReset().mockResolvedValue(units);
    applyLandlordRequirements
      .mockResolvedValueOnce({ updated: units.slice(0, 100).map((u) => u.unitId), skipped: [] })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderDialog();
    const { copy } = await columns();
    await user.click(box(copy, 'Credit score'));
    await user.click(screen.getByRole('button', { name: 'Update 150 properties' }));
    expect(
      await screen.findByText('Updated 100 properties before this stopped. Review the rest and press Update again.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(getContact).toHaveBeenCalledTimes(2));
    const { copy: after } = await columns();
    expect(box(after, 'Credit score')).not.toBeChecked();
    expect(box(after, 'Pets')).toBeChecked();
  });

  it('what staff chose survives a failed re-read and Try again', async () => {
    const user = userEvent.setup();
    getContact
      .mockReset()
      .mockResolvedValueOnce(LANDLORD)
      .mockRejectedValueOnce(new ApiError(503, 'unavailable', 'x'))
      .mockResolvedValue(LANDLORD);
    applyLandlordRequirements.mockRejectedValueOnce(new ApiError(500, 'boom', 'x'));
    renderDialog();
    const { copy } = await columns();
    await user.click(box(copy, 'Credit score'));
    await user.click(screen.getByRole('button', { name: 'Update 1 property' }));
    expect(await screen.findByText("Couldn't load this landlord's properties.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    const { copy: after } = await columns();
    expect(getContact).toHaveBeenCalledTimes(3);
    expect(box(after, 'Credit score')).not.toBeChecked();
    expect(box(after, 'Pets')).toBeChecked();
  });

  // Code review R3-1 (worklist OR-34): this path once reset the left column,
  // so an item staff left out came back checked and "press Update again"
  // copied it onto every property.
  it('a first request answering 409 requirements_changed keeps what staff unchecked, and the next request leaves it out (OR-34)', async () => {
    const user = userEvent.setup();
    // A colleague changed the landlord's pet fee while staff were reviewing.
    getContact.mockReset().mockResolvedValueOnce(LANDLORD).mockResolvedValue({ ...LANDLORD, req_pet_fee: '$350' });
    applyLandlordRequirements
      .mockRejectedValueOnce(new ApiError(409, 'requirements_changed', 'x', { error: 'requirements_changed' }))
      .mockResolvedValueOnce({ updated: ['u-match', 'u-old'], skipped: [] });
    renderDialog();
    const { copy } = await columns();
    // Staff leave Credit score out of this Apply.
    await user.click(box(copy, 'Credit score'));
    await user.click(screen.getByRole('button', { name: 'Update 1 property' }));
    expect(sentItems(0)).toEqual(['pets']);
    expect(
      await screen.findByText("This landlord's requirements changed. Review the updated list and press Update again."),
    ).toBeInTheDocument();
    await waitFor(() => expect(getContact).toHaveBeenCalledTimes(2));
    const { copy: after } = await columns();
    // Still left out, although the re-read landlord still holds it.
    expect(box(after, 'Credit score')).not.toBeChecked();
    // Kept by staff and still held: still checked, showing the new value.
    expect(box(after, 'Pets')).toBeChecked();
    expect(box(after, 'Pets')).toHaveAccessibleDescription('No pets; pet fee $350');
    // "press Update again", as the notice says: still without Credit score.
    await user.click(screen.getByRole('button', { name: 'Update 2 properties' }));
    await waitFor(() => expect(applyLandlordRequirements).toHaveBeenCalledTimes(2));
    expect(sentItems(1)).toEqual(['pets']);
  });
});

// Code review RD-1 (worklist OR-31): the server refuses every Apply with 409
// deposit_conflict while the LANDLORD record holds both one month's rent and a
// fixed amount (only a direct data edit can store both since OR-30), so
// pressing Update again alone can never work. On ANY batch the dialog sends
// no more, re-reads, and says what to fix; the left column shows both forms,
// so the refusal is visible.
describe('ApplyRequirementsDialog - a landlord deposit holding both forms (code review RD-1, worklist OR-31)', () => {
  // Code review R2D-13 (amends OR-31): Edit requirements is on the card BEHIND
  // the dialog, so the sentence says to close it first.
  const DEPOSIT_CONFLICT =
    "This landlord's deposit is set to both one month's rent and a fixed amount. Close this, fix it with Edit requirements, then open Apply to properties again.";
  const BOTH: Contact = { ...LANDLORD, req_deposit_one_month: true, req_deposit: 1400 };
  const refusal = (): ApiError => new ApiError(409, 'deposit_conflict', 'deposit_conflict', { error: 'deposit_conflict' });
  const depositBox = (copy: HTMLElement): HTMLElement => within(copy).getByRole('checkbox', { name: 'Deposit' });

  it('a first request answering 409 deposit_conflict says what to fix, sends no further batch and re-reads', async () => {
    const user = userEvent.setup();
    const units = many(150);
    getContact.mockReset().mockResolvedValue(BOTH);
    getAllUnits.mockReset().mockResolvedValue(units);
    applyLandlordRequirements.mockRejectedValue(refusal());
    const { onDone } = renderDialog();
    const { copy } = await columns();
    // What the server refuses is on screen: both forms, never one of them.
    expect(depositBox(copy)).toHaveAccessibleDescription("One month's rent; $1,400");
    await user.click(screen.getByRole('button', { name: 'Update 150 properties' }));
    // The notice role the dialog's other notices use.
    expect((await screen.findByText(DEPOSIT_CONFLICT)).closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByText("Couldn't update the properties. Review the list and press Update again.")).toBeNull();
    // Code review R2D-3: on the FIRST batch nothing landed - the deposit sentence alone.
    expect(screen.queryByText(/before this stopped/)).toBeNull();
    await waitFor(() => expect(getContact).toHaveBeenCalledTimes(2));
    expect(getAllUnits).toHaveBeenCalledTimes(2);
    expect(applyLandlordRequirements).toHaveBeenCalledTimes(1); // the second batch is never sent
    expect(onDone).not.toHaveBeenCalled();
  });

  // Code review R2D-3: a LATER batch keeps D8's stop sentence - the first
  // batch really wrote 100 properties - and adds the deposit sentence after
  // it, in the same alert.
  it('a later batch answering 409 deposit_conflict says how many landed, then what to fix; sends no further batch and re-reads', async () => {
    const user = userEvent.setup();
    const units = many(250);
    // The landlord gained the second form between the open and the second batch.
    getContact.mockReset().mockResolvedValueOnce(LANDLORD).mockResolvedValue(BOTH);
    getAllUnits.mockReset().mockResolvedValue(units);
    applyLandlordRequirements
      .mockResolvedValueOnce({ updated: units.slice(0, 100).map((u) => u.unitId), skipped: [] })
      .mockRejectedValueOnce(refusal());
    const { onDone } = renderDialog();
    await columns();
    await user.click(screen.getByRole('button', { name: 'Update 250 properties' }));
    const deposit = await screen.findByText(DEPOSIT_CONFLICT);
    const stopped = screen.getByText('Updated 100 properties before this stopped. Review the rest and press Update again.');
    const alert = deposit.closest('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(stopped.closest('[role="alert"]')).toBe(alert);
    // The stop sentence first, then the deposit sentence.
    expect(stopped.compareDocumentPosition(deposit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(getContact).toHaveBeenCalledTimes(2));
    expect(getAllUnits).toHaveBeenCalledTimes(2);
    expect(applyLandlordRequirements).toHaveBeenCalledTimes(2); // no third batch
    expect(onDone).not.toHaveBeenCalled();
    // The re-read landlord's deposit shows both forms.
    const { copy: after } = await columns();
    await waitFor(() => expect(depositBox(after)).toHaveAccessibleDescription("One month's rent; $1,400"));
  });

  // Mutant follow-up (FW1b M1): the re-read after a deposit_conflict carries
  // the left column the way any failure does (OR-17) - an item staff left out
  // is never re-checked by the defaults.
  // (The rows staff unchecked are carried too - worklist OR-32, below.)
  it('the re-read after a deposit_conflict keeps what staff left out (the OR-17 carry)', async () => {
    const user = userEvent.setup();
    getContact.mockReset().mockResolvedValue(BOTH);
    applyLandlordRequirements.mockRejectedValueOnce(refusal());
    renderDialog();
    const { copy } = await columns();
    await user.click(within(copy).getByRole('checkbox', { name: 'Credit score' }));
    await user.click(screen.getByRole('button', { name: /^Update \d+ propert(y|ies)$/ }));
    expect(await screen.findByText(DEPOSIT_CONFLICT)).toBeInTheDocument();
    await waitFor(() => expect(getContact).toHaveBeenCalledTimes(2));
    const { copy: after } = await columns();
    expect(within(after).getByRole('checkbox', { name: 'Credit score' })).not.toBeChecked();
    expect(within(after).getByRole('checkbox', { name: 'Pets' })).toBeChecked();
    expect(depositBox(after)).toBeChecked();
  });
});

// Worklist OR-32 (code review R2D-1, amends OR-17): the re-read after a
// failed or stopped Update also keeps the rows staff UNCHECKED by hand (while
// still listed and not "Already matches"). Before, the re-read reset every
// row to its starting state, so a property staff had left out came back
// CHECKED and the notice's "press Update again" wrote it. Rows staff CHECKED
// by hand still go back to their starting state (staff confirm a check
// again). Worklist OR-34 (code review R3-1): every re-read inside one open
// dialog carries, a first-request 409 requirements_changed included.
describe('ApplyRequirementsDialog - the rows staff unchecked across a re-read (worklist OR-32)', () => {
  const FAILED = "Couldn't update the properties. Review the list and press Update again.";
  const BOTH: Contact = { ...LANDLORD, req_deposit_one_month: true, req_deposit: 1400 };
  const sentUnits = (call: number): string[] =>
    (applyLandlordRequirements.mock.calls[call]?.[1] as { units: Array<{ unitId: string }> }).units.map((u) => u.unitId);

  it('after a first request fails: the row staff unchecked stays unchecked, the button counts without it, and the next request leaves it out', async () => {
    const user = userEvent.setup();
    getAllUnits.mockReset().mockResolvedValue(many(3));
    applyLandlordRequirements
      .mockRejectedValueOnce(new ApiError(500, 'boom', 'x'))
      .mockResolvedValueOnce({ updated: ['u0', 'u2'], skipped: [] });
    const { onDone } = renderDialog();
    const { which } = await columns();
    // None of the three has an own value: all start checked. Staff leave
    // "2 Many St" as it is.
    await user.click(rowBox(which, '2 Many St'));
    await user.click(screen.getByRole('button', { name: 'Update 2 properties' }));
    expect(sentUnits(0)).toEqual(['u0', 'u2']);
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    await waitFor(() => expect(getContact).toHaveBeenCalledTimes(2));
    const { which: after } = await columns();
    expect(rowBox(after, '2 Many St')).not.toBeChecked();
    expect(rowBox(after, '1 Many St')).toBeChecked();
    expect(rowBox(after, '3 Many St')).toBeChecked();
    // "press Update again", as the notice says: still without it.
    await user.click(screen.getByRole('button', { name: 'Update 2 properties' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ updated: 2, skipped: [] }));
    expect(sentUnits(1)).toEqual(['u0', 'u2']);
  });

  it('after a 409 deposit_conflict: the row staff unchecked stays unchecked, the button counts without it, and the next request leaves it out', async () => {
    const user = userEvent.setup();
    getAllUnits.mockReset().mockResolvedValue(many(3));
    // Opened on a landlord holding both deposit forms; fixed by the time of the re-read.
    getContact.mockReset().mockResolvedValueOnce(BOTH).mockResolvedValue(LANDLORD);
    applyLandlordRequirements
      .mockRejectedValueOnce(new ApiError(409, 'deposit_conflict', 'deposit_conflict', { error: 'deposit_conflict' }))
      .mockResolvedValueOnce({ updated: ['u0', 'u2'], skipped: [] });
    renderDialog();
    const { which } = await columns();
    await user.click(rowBox(which, '2 Many St'));
    await user.click(screen.getByRole('button', { name: 'Update 2 properties' }));
    expect(await screen.findByText(/deposit is set to both/)).toBeInTheDocument();
    await waitFor(() => expect(getContact).toHaveBeenCalledTimes(2));
    const { which: after } = await columns();
    expect(rowBox(after, '2 Many St')).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Update 2 properties' }));
    await waitFor(() => expect(applyLandlordRequirements).toHaveBeenCalledTimes(2));
    expect(sentUnits(1)).toEqual(['u0', 'u2']);
  });

  it('after a mid-run stop: the row staff unchecked stays unchecked and the button counts without it', async () => {
    const user = userEvent.setup();
    const units = many(150);
    getAllUnits.mockReset().mockResolvedValue(units);
    applyLandlordRequirements
      .mockResolvedValueOnce({ updated: units.slice(0, 101).filter((u) => u.unitId !== 'u1').map((u) => u.unitId), skipped: [] })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderDialog();
    const { which } = await columns();
    await user.click(rowBox(which, '2 Many St'));
    await user.click(screen.getByRole('button', { name: 'Update 149 properties' }));
    expect(
      await screen.findByText('Updated 100 properties before this stopped. Review the rest and press Update again.'),
    ).toBeInTheDocument();
    expect(sentUnits(0)).not.toContain('u1');
    await waitFor(() => expect(getContact).toHaveBeenCalledTimes(2));
    const { which: after } = await columns();
    expect(rowBox(after, '2 Many St')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Update 149 properties' })).toBeEnabled();
  });

  it('a row staff CHECKED by hand goes back to its starting state after the re-read: staff confirm it again', async () => {
    const user = userEvent.setup();
    applyLandlordRequirements.mockRejectedValueOnce(new ApiError(500, 'boom', 'x'));
    renderDialog();
    const { which } = await columns();
    // "3 Own St" holds own values, so it starts unchecked; staff check it.
    await user.click(rowBox(which, '3 Own St'));
    await user.click(screen.getByRole('button', { name: 'Update 2 properties' }));
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    await waitFor(() => expect(getContact).toHaveBeenCalledTimes(2));
    const { which: after } = await columns();
    expect(rowBox(after, '3 Own St')).not.toBeChecked();
    expect(rowBox(after, '2 Old St')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Update 1 property' })).toBeEnabled();
  });

  // Code review R3-1 (worklist OR-34): this path once reset every row, so the
  // property staff left out came back checked ("Update 3 properties") and
  // "press Update again" overwrote it.
  it('after a first request answers 409 requirements_changed: the row staff unchecked stays unchecked, the button counts without it, and the next request leaves it out (OR-34)', async () => {
    const user = userEvent.setup();
    getAllUnits.mockReset().mockResolvedValue(many(3));
    // A colleague changed the landlord's pet fee while staff were reviewing.
    getContact.mockReset().mockResolvedValueOnce(LANDLORD).mockResolvedValue({ ...LANDLORD, req_pet_fee: '$350' });
    applyLandlordRequirements
      .mockRejectedValueOnce(new ApiError(409, 'requirements_changed', 'x', { error: 'requirements_changed' }))
      .mockResolvedValueOnce({ updated: ['u0', 'u2'], skipped: [] });
    const { onDone } = renderDialog();
    const { which } = await columns();
    await user.click(rowBox(which, '2 Many St'));
    await user.click(screen.getByRole('button', { name: 'Update 2 properties' }));
    expect(sentUnits(0)).toEqual(['u0', 'u2']);
    expect(
      await screen.findByText("This landlord's requirements changed. Review the updated list and press Update again."),
    ).toBeInTheDocument();
    await waitFor(() => expect(getContact).toHaveBeenCalledTimes(2));
    const { which: after } = await columns();
    expect(rowBox(after, '2 Many St')).not.toBeChecked();
    expect(rowBox(after, '1 Many St')).toBeChecked();
    expect(rowBox(after, '3 Many St')).toBeChecked();
    // "press Update again", as the notice says: still without it.
    await user.click(screen.getByRole('button', { name: 'Update 2 properties' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ updated: 2, skipped: [] }));
    expect(sentUnits(1)).toEqual(['u0', 'u2']);
  });
});
