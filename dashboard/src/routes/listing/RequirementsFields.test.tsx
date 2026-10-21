// RequirementsFields - the shared Requirements section (spec 2026-10-20 D1,
// D9, D10; plan 2.6), for both audiences.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RequirementsFields } from './RequirementsFields.js';
import {
  NO_APPLICATION_FEE_FLAG,
  emptyRequirementFormValues,
  requirementFormValuesFromUnit,
  type RequirementFormValues,
} from './requirementForm.js';
import { REQUIREMENT_ITEMS } from './requirements.js';

type Audience = 'property' | 'landlord';

function Harness({
  initial,
  audience = 'property',
  disabled = false,
  spy,
}: {
  initial?: RequirementFormValues;
  audience?: Audience;
  disabled?: boolean;
  spy?: (next: RequirementFormValues) => void;
}): React.JSX.Element {
  const [values, setValues] = useState<RequirementFormValues>(initial ?? emptyRequirementFormValues());
  return (
    <RequirementsFields
      values={values}
      audience={audience}
      disabled={disabled}
      onChange={(next) => {
        spy?.(next);
        setValues(next);
      }}
    />
  );
}

const TAGS = {
  property: { on_flyer: 'On flyer', staff_only: 'Staff only' },
  landlord: { on_flyer: 'On property flyers', staff_only: 'Staff only' },
} as const;
const PUBLIC_NOTE = 'Tenants see this on the public flyer.';
const FIELDS = REQUIREMENT_ITEMS.flatMap((item) => item.fields);

/** The elements a control's aria-describedby names. */
function describers(control: HTMLElement): HTMLElement[] {
  return (control.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => el !== null);
}
const describedTexts = (control: HTMLElement): string[] => describers(control).map((el) => el.textContent ?? '');

describe('RequirementsFields', () => {
  it('shows the four groups in order, with Evictions and Deposit as sub-groups', () => {
    render(<Harness />);
    expect(screen.getAllByRole('group').map((g) => g.querySelector(':scope > legend')?.textContent)).toEqual([
      'Screening',
      'Evictions',
      'Pets',
      'Move-in costs',
      'Deposit',
      'Touring',
    ]);
  });

  it.each(
    (['property', 'landlord'] as const).flatMap((audience) =>
      FIELDS.map((f) => [audience, f.label, f.flyer, f.kind] as const),
    ),
  )('%s form: "%s" is tagged %s from the registry, outside its accessible name', (audience, label, flyer, kind) => {
    render(<Harness audience={audience} />);
    const control = screen.getByLabelText(label);
    expect(control).toHaveAccessibleName(label);
    const texts = describedTexts(control);
    expect(texts).toContain(TAGS[audience][flyer]);
    for (const el of describers(control)) expect(el.closest('label')).toBeNull();
    // D10: only the PROPERTY forms' public free-text boxes say tenants see
    // them; a landlord value reaches a flyer only once it is copied to a
    // property (D9; planner ruling PR-2, code review PC-1). flyer-leads D2:
    // no requirement text field is On flyer any more, so none carries it.
    expect(texts.includes(PUBLIC_NOTE)).toBe(audience === 'property' && kind === 'text' && flyer === 'on_flyer');
  });

  it.each(['property', 'landlord'] as const)('%s form: No application fee is tagged as the fee is', (audience) => {
    render(<Harness audience={audience} />);
    const box = screen.getByLabelText('No application fee');
    expect(box).toHaveAccessibleName('No application fee');
    expect(describedTexts(box)).toContain(TAGS[audience].on_flyer);
  });

  it.each(['property', 'landlord'] as const)(
    '%s form: every Pets and Deposit field reads Staff only, and no requirement field carries the public note (flyer-leads D2)',
    (audience) => {
      render(<Harness audience={audience} />);
      for (const label of [
        'No pets',
        'Pets (details)',
        'Pet fee',
        "One month's rent",
        'Fixed amount',
        'Flexible / payment terms available',
        'Deposit notes',
      ]) {
        expect(describedTexts(screen.getByLabelText(label)), label).toEqual(['Staff only']);
      }
      expect(screen.queryByText(PUBLIC_NOTE)).toBeNull();
      // The application-fee pair is the only public requirement left.
      expect(describedTexts(screen.getByLabelText('No application fee'))).toEqual([TAGS[audience].on_flyer]);
      expect(describedTexts(screen.getByLabelText('Application fee'))).toEqual([TAGS[audience].on_flyer]);
    },
  );

  it('typing and ticking report the whole next value', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    await user.type(screen.getByLabelText('Credit score'), '6');
    expect(spy).toHaveBeenLastCalledWith({ ...emptyRequirementFormValues(), credit_requirements: '6' });
    await user.click(screen.getByLabelText('No evictions while on the program'));
    expect(spy).toHaveBeenLastCalledWith({
      ...emptyRequirementFormValues(),
      credit_requirements: '6',
      no_evictions_on_program: true,
    });
    await user.selectOptions(screen.getByLabelText('Tour type'), 'pm_team');
    expect(spy.mock.lastCall?.[0]).toMatchObject({ tour_type: 'pm_team', credit_requirements: '6' });
  });

  it("One month's rent clears and disables the fixed amount; unticked, the amount is editable again", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={{ ...emptyRequirementFormValues(), deposit: '1200' }} spy={spy} />);
    const amount = screen.getByLabelText('Fixed amount');
    expect(amount).toHaveValue(1200);
    await user.click(screen.getByLabelText("One month's rent"));
    expect(amount).toBeDisabled();
    expect(amount).toHaveValue(null);
    expect(spy.mock.lastCall?.[0]).toMatchObject({ deposit_one_month: true, deposit: '' });
    await user.click(screen.getByLabelText("One month's rent"));
    expect(amount).toBeEnabled();
    expect(amount).toHaveValue(null);
    expect(spy.mock.lastCall?.[0]).toMatchObject({ deposit_one_month: false, deposit: '' });
  });

  it('No application fee records 0 and disables the amount; unticked, the amount is blank and editable', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const fee = screen.getByLabelText('Application fee');
    await user.click(screen.getByLabelText('No application fee'));
    expect(fee).toBeDisabled();
    expect(fee).toHaveValue(0);
    expect(spy.mock.lastCall?.[0]).toMatchObject({ application_fee: '0' });
    await user.click(screen.getByLabelText('No application fee'));
    expect(fee).toBeEnabled();
    expect(fee).toHaveValue(null);
    expect(spy.mock.lastCall?.[0]).toMatchObject({ application_fee: '' });
  });

  it('a recorded 0 shows as No application fee', () => {
    render(<Harness initial={{ ...emptyRequirementFormValues(), application_fee: '0' }} />);
    expect(screen.getByLabelText('No application fee')).toBeChecked();
    expect(screen.getByLabelText('Application fee')).toBeDisabled();
  });

  // Code review R2D-5: "No application fee" is its own form flag, set only by
  // the checkbox (it starts checked when the stored / prefilled fee is 0).
  // It was DERIVED from the amount text, so any partial amount reading 0
  // ticked it and disabled the box under the caret.
  it('typing an amount that starts with 0 ("0.50") never ticks No application fee or disables the box', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const fee = screen.getByLabelText('Application fee');
    await user.type(fee, '0.50');
    expect(fee).toBeEnabled();
    expect(fee).toHaveValue(0.5);
    expect(screen.getByLabelText('No application fee')).not.toBeChecked();
    const last = spy.mock.lastCall?.[0] as RequirementFormValues;
    expect(Number(last['application_fee'])).toBe(0.5);
    expect(last[NO_APPLICATION_FEE_FLAG]).toBe(false);
  });

  it('deleting the 4 of a stored 40 leaves an editable 0, unticked', async () => {
    const user = userEvent.setup();
    render(<Harness initial={requirementFormValuesFromUnit({ application_fee: 40 })} />);
    const fee = screen.getByLabelText('Application fee');
    expect(fee).toHaveValue(40);
    await user.click(fee);
    await user.keyboard('{Home}{Delete}');
    expect(fee).toHaveValue(0);
    expect(fee).toBeEnabled();
    expect(screen.getByLabelText('No application fee')).not.toBeChecked();
    // ... and staff can go on typing.
    await user.type(fee, '5');
    expect(fee).toBeEnabled();
  });

  it('only the checkbox sets the flag: ticked it records 0, unticked the amount is blank again', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={requirementFormValuesFromUnit({ application_fee: 0 })} spy={spy} />);
    const box = screen.getByLabelText('No application fee');
    expect(box).toBeChecked();
    await user.click(box);
    expect(spy.mock.lastCall?.[0]).toMatchObject({ application_fee: '', [NO_APPLICATION_FEE_FLAG]: false });
    await user.type(screen.getByLabelText('Application fee'), '0');
    expect(box).not.toBeChecked();
    await user.click(box);
    expect(spy.mock.lastCall?.[0]).toMatchObject({ application_fee: '0', [NO_APPLICATION_FEE_FLAG]: true });
    expect(screen.getByLabelText('Application fee')).toBeDisabled();
  });

  // Mutant follow-up (U9 M7; planner ruling PR2-3): both amounts take any
  // amount of 0 or more, cents included - a stored or landlord-prefilled 1250.5
  // must never trip native step validation and silently block Save / Create.
  it('the two amounts take any amount of 0 or more, cents included', () => {
    render(<Harness initial={{ ...emptyRequirementFormValues(), deposit: '1250.5', application_fee: '35.75' }} />);
    for (const label of ['Fixed amount', 'Application fee']) {
      const amount = screen.getByLabelText(label);
      expect(amount, label).toHaveAttribute('min', '0');
      expect(amount, label).toHaveAttribute('step', 'any');
      expect(amount, label).toBeValid();
    }
  });

  it('Tour type offers Not set and the three tour types', () => {
    render(<Harness />);
    const select = screen.getByLabelText('Tour type');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Not set',
      'Self-guided',
      'Landlord-led',
      'PM team',
    ]);
    expect(select).toHaveValue('');
  });

  it('Qualifications and Tour process are multi-line boxes; the other text fields are one line', () => {
    render(<Harness />);
    expect(screen.getByLabelText('Qualifications').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Tour process').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Pets (details)').tagName).toBe('INPUT');
    expect(screen.getByLabelText('Deposit notes').tagName).toBe('INPUT');
  });

  it('disabled disables every control', () => {
    render(<Harness disabled />);
    for (const f of FIELDS) expect(screen.getByLabelText(f.label), f.label).toBeDisabled();
    expect(screen.getByLabelText('No application fee')).toBeDisabled();
  });
});
