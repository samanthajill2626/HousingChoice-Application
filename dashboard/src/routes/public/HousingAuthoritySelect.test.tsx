// HousingAuthoritySelect - the /join "Housing authority" field
// (join-housing-authority spec D8): its states (ready, loading, failed, the
// "Choose one" placeholder), the exact copy, the option values it reports, its
// accessible wiring, and the two pure helpers HousingFairIntake uses (the
// default rule and what a value sends).
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  CHOOSE_ONE_VALUE,
  HousingAuthoritySelect,
  NOT_SURE_VALUE,
  authorityToSend,
  defaultAuthorityChoice,
  type AuthorityList,
} from './HousingAuthoritySelect.js';

const NAMES = ['Atlanta Housing Authority', 'Cobb County Housing Authority', 'DeKalb Housing Authority'];
const READY: AuthorityList = { kind: 'ready', names: NAMES };
const HELP = 'The organization that runs your voucher.';
const FAILED_NOTE = 'The list of housing authorities could not be loaded.';

function authoritySelect(): HTMLSelectElement {
  return screen.getByLabelText('Housing authority') as HTMLSelectElement;
}

function optionLabels(): string[] {
  return Array.from(authoritySelect().options, (o) => o.textContent ?? '');
}

describe('HousingAuthoritySelect', () => {
  it('ready: the names in their order, then "Not sure"; shows the value; the help text describes it', () => {
    render(<HousingAuthoritySelect list={READY} value="Atlanta Housing Authority" onChange={vi.fn()} />);

    expect(authoritySelect().tagName).toBe('SELECT');
    expect(optionLabels()).toEqual([...NAMES, 'Not sure']);
    expect(authoritySelect()).toHaveValue('Atlanta Housing Authority');
    expect(authoritySelect()).toHaveDisplayValue('Atlanta Housing Authority');
    expect(authoritySelect()).toBeEnabled();
    expect(authoritySelect()).toHaveAccessibleDescription(HELP);
    expect(screen.getByText(HELP)).toBeInTheDocument();
    expect(screen.queryByText(FAILED_NOTE)).toBeNull();
  });

  it('ready with "Not sure" shows "Not sure"', () => {
    render(<HousingAuthoritySelect list={READY} value={NOT_SURE_VALUE} onChange={vi.fn()} />);
    expect(authoritySelect()).toHaveDisplayValue('Not sure');
  });

  it('loading: disabled, and "Loading..." is the only option', () => {
    render(<HousingAuthoritySelect list={{ kind: 'loading' }} value={NOT_SURE_VALUE} onChange={vi.fn()} />);

    expect(authoritySelect()).toBeDisabled();
    expect(optionLabels()).toEqual(['Loading...']);
    expect(authoritySelect()).toHaveDisplayValue('Loading...');
    expect(authoritySelect()).toHaveAccessibleDescription(HELP);
  });

  it('failed: only "Not sure", the note under it, and help + note describe the select', () => {
    render(
      <HousingAuthoritySelect list={{ kind: 'failed' }} value="Atlanta Housing Authority" onChange={vi.fn()} />,
    );

    expect(optionLabels()).toEqual(['Not sure']);
    expect(authoritySelect()).toHaveDisplayValue('Not sure');
    expect(authoritySelect()).toBeEnabled();
    expect(screen.getByText(FAILED_NOTE)).toBeInTheDocument();
    expect(authoritySelect()).toHaveAccessibleDescription(`${HELP} ${FAILED_NOTE}`);
  });

  it('the "Choose one" placeholder sits ahead of the names and "Not sure" while it is the value', () => {
    render(<HousingAuthoritySelect list={READY} value={CHOOSE_ONE_VALUE} onChange={vi.fn()} />);

    expect(optionLabels()).toEqual(['Choose one', ...NAMES, 'Not sure']);
    expect(authoritySelect()).toHaveDisplayValue('Choose one');
  });

  it('reports the picked value: a name exactly, "Not sure" as NOT_SURE_VALUE', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<HousingAuthoritySelect list={READY} value="Atlanta Housing Authority" onChange={onChange} />);

    await user.selectOptions(authoritySelect(), 'DeKalb Housing Authority');
    expect(onChange).toHaveBeenLastCalledWith('DeKalb Housing Authority');
    await user.selectOptions(authoritySelect(), 'Not sure');
    expect(onChange).toHaveBeenLastCalledWith(NOT_SURE_VALUE);
  });

  it('disabled disables it even when the list is ready', () => {
    render(<HousingAuthoritySelect list={READY} value="Atlanta Housing Authority" onChange={vi.fn()} disabled />);
    expect(authoritySelect()).toBeDisabled();
  });
});

describe('defaultAuthorityChoice', () => {
  it('is "Atlanta Housing Authority" only when that exact name is listed, else "Not sure"', () => {
    expect(defaultAuthorityChoice(NAMES)).toBe('Atlanta Housing Authority');
    expect(defaultAuthorityChoice(['atlanta housing authority', 'Atlanta Housing Authority (AHA)'])).toBe(
      NOT_SURE_VALUE,
    );
    expect(defaultAuthorityChoice([])).toBe(NOT_SURE_VALUE);
  });
});

describe('authorityToSend', () => {
  it('sends a listed name exactly; nothing for "Not sure", "Choose one", an unlisted value, or a list that is not ready', () => {
    expect(authorityToSend(READY, 'DeKalb Housing Authority')).toBe('DeKalb Housing Authority');
    expect(authorityToSend(READY, NOT_SURE_VALUE)).toBeUndefined();
    expect(authorityToSend(READY, CHOOSE_ONE_VALUE)).toBeUndefined();
    expect(authorityToSend(READY, 'Fulton County Housing Authority')).toBeUndefined();
    expect(authorityToSend({ kind: 'loading' }, 'DeKalb Housing Authority')).toBeUndefined();
    expect(authorityToSend({ kind: 'failed' }, 'DeKalb Housing Authority')).toBeUndefined();
  });
});

describe('option values', () => {
  it('can never equal a listed name: "Not sure" is empty, "Choose one" starts with a space (stored names are trimmed and non-empty)', () => {
    expect(NOT_SURE_VALUE).toBe('');
    expect(CHOOSE_ONE_VALUE).not.toBe(CHOOSE_ONE_VALUE.trim());
    expect(CHOOSE_ONE_VALUE.trim()).not.toBe('');
  });
});
