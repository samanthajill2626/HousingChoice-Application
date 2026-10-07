// NewOrgDialog tests - "Is this really new?" (spec 2026-10-06 D6, D8, D13; the
// S14 selector contract N1-N4): one check per name, the name's own match and
// the close names as "Use <name>", the other kind, a compound name pointing to
// Split, "Yes, add it" disabled with the reason, an editable Name (never in
// the AI-suggestion mode), and every button typed.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';

const checkOrgText = vi.fn();
const addOrg = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    checkOrgText: (...a: unknown[]) => checkOrgText(...a),
    addOrg: (...a: unknown[]) => addOrg(...a),
  };
});

import { NEW_ORG_CHECK_DELAY_MS, NewOrgDialog, type NewOrgDialogProps } from './NewOrgDialog.js';

const ATL = { orgId: 'o-atl', kind: 'housing_authority' as const, name: 'Atlanta Housing Authority' };
const AUG = { orgId: 'o-aug', kind: 'housing_authority' as const, name: 'Augusta Housing Authority' };
const STEP = { orgId: 'o-step', kind: 'agency' as const, name: 'Step Up' };
const DCA = { orgId: 'o-dca', kind: 'housing_authority' as const, name: 'Georgia Department of Community Affairs' };
const VASH = { orgId: 'o-vash', kind: 'agency' as const, name: 'HUD-Veterans Affairs Supportive Housing (HUD-VASH)' };

function renderDialog(over: Partial<NewOrgDialogProps> = {}): NewOrgDialogProps {
  const props: NewOrgDialogProps = {
    kind: 'housing_authority',
    text: 'Metro Housing Authority',
    mode: 'field',
    onUse: vi.fn(),
    onAdded: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<NewOrgDialog {...props} />);
  return props;
}

const yes = (): HTMLElement => screen.getByRole('button', { name: 'Yes, add it' });

beforeEach(() => {
  checkOrgText.mockReset();
  addOrg.mockReset();
});

describe('NewOrgDialog ("Is this really new?")', () => {
  it('checks the name and offers its own match first; a taken name cannot be added', async () => {
    checkOrgText.mockResolvedValue({ match: ATL, candidates: [], close: [], nameProblem: 'org_name_taken' });
    const props = renderDialog({ text: 'atlanta housing authority' });
    expect(screen.getByRole('dialog', { name: 'Is this really new?' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Use Atlanta Housing Authority' }));
    expect(checkOrgText).toHaveBeenCalledWith(
      { kind: 'housing_authority', text: 'atlanta housing authority' },
      expect.any(AbortSignal),
    );
    expect(props.onUse).toHaveBeenCalledWith(ATL, 'resolution');
    expect(yes()).toBeDisabled();
    expect(yes()).toHaveAccessibleDescription('Cannot add it: It is already on the list as Atlanta Housing Authority.');
  });

  it('a shared spelling offers every candidate', async () => {
    checkOrgText.mockResolvedValue({ candidates: [ATL, AUG], close: [], nameProblem: 'org_name_taken' });
    const props = renderDialog({ text: 'AHA' });
    fireEvent.click(await screen.findByRole('button', { name: 'Use Augusta Housing Authority' }));
    expect(props.onUse).toHaveBeenCalledWith(AUG, 'resolution');
  });

  it('offers the closest names as a different choice', async () => {
    checkOrgText.mockResolvedValue({ candidates: [], close: [ATL] });
    const props = renderDialog({ text: 'Atlnta Housing' });
    fireEvent.click(await screen.findByRole('button', { name: 'Use Atlanta Housing Authority' }));
    expect(props.onUse).toHaveBeenCalledWith(ATL, 'close');
  });

  it('the other kind: says so and offers "Put it in Agency" on the tenant form', async () => {
    checkOrgText.mockResolvedValue({ candidates: [], close: [], otherKind: [STEP], nameProblem: 'org_name_taken' });
    const onUseOtherField = vi.fn();
    renderDialog({ text: 'Step Up', onUseOtherField });
    expect(await screen.findByText('Step Up is an agency, not a housing authority.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Put it in Agency' }));
    expect(onUseOtherField).toHaveBeenCalledWith(STEP);
    expect(yes()).toBeDisabled();
  });

  it('suggestion mode offers Dismiss for an agency name (spec D8)', async () => {
    const onDismissSuggestion = vi.fn();
    renderDialog({
      text: 'Step Up',
      mode: 'suggestion',
      initialCheck: { candidates: [], close: [], otherKind: [STEP], nameProblem: 'org_name_taken' },
      onDismissSuggestion,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss suggestion' }));
    expect(onDismissSuggestion).toHaveBeenCalled();
  });

  it('a compound name says what it contains, points to Split and cannot be added (spec D13)', async () => {
    checkOrgText.mockResolvedValue({ candidates: [], close: [], compound: [[DCA], [VASH]], nameProblem: 'org_name_compound' });
    renderDialog({ text: 'DCA HUD-VASH' });
    expect(
      await screen.findByText(
        /names more than one organization \(Georgia Department of Community Affairs and HUD-Veterans Affairs Supportive Housing \(HUD-VASH\)\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/use Split on Settings/)).toBeInTheDocument();
    expect(yes()).toBeDisabled();
  });

  it('a name over 120 characters is refused at once and never sent to the check (spec D13)', async () => {
    const user = userEvent.setup();
    checkOrgText.mockResolvedValue({ candidates: [], close: [] });
    renderDialog({ text: 'x'.repeat(121) });
    // Said at once, with no "Checking the list...": POST /check refuses a text
    // over 200 characters, so a check could only dead-end on Try again.
    expect(yes()).toBeDisabled();
    expect(yes()).toHaveAccessibleDescription('Cannot add it: Names can be at most 120 characters.');
    expect(screen.queryByText('Checking the list...')).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, NEW_ORG_CHECK_DELAY_MS + 100));
    expect(checkOrgText).not.toHaveBeenCalled();
    // At the limit the name is checked as usual.
    await user.type(screen.getByRole('textbox', { name: 'Name' }), '{Backspace}');
    await waitFor(() =>
      expect(checkOrgText).toHaveBeenLastCalledWith(
        { kind: 'housing_authority', text: 'x'.repeat(120) },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(yes()).toBeEnabled());
  });

  it('"Yes, add it" adds the name with its notes', async () => {
    const user = userEvent.setup();
    checkOrgText.mockResolvedValue({ candidates: [], close: [] });
    const created = {
      ...ATL,
      orgId: 'o-new',
      name: 'Metro Housing Authority',
      spellings: [],
      notes: 'Covers Metro',
      createdAt: '2026-10-06T00:00:00.000Z',
      createdBy: 'u1',
      updatedAt: '2026-10-06T00:00:00.000Z',
      updatedBy: 'u1',
    };
    addOrg.mockResolvedValue(created);
    const props = renderDialog();
    await waitFor(() => expect(yes()).toBeEnabled());
    await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'Covers Metro');
    await user.click(yes());
    expect(addOrg).toHaveBeenCalledWith({ kind: 'housing_authority', name: 'Metro Housing Authority', notes: 'Covers Metro' });
    await waitFor(() => expect(props.onAdded).toHaveBeenCalledWith(created));
  });

  it('staff can correct the name, and the check follows the current name', async () => {
    const user = userEvent.setup();
    checkOrgText.mockResolvedValue({ candidates: [], close: [] });
    addOrg.mockResolvedValue({ ...ATL, name: 'Metro Housing Authority' });
    renderDialog({ text: 'Metro HA' });
    const box = screen.getByRole('textbox', { name: 'Name' });
    expect(box).toHaveValue('Metro HA');
    await user.clear(box);
    await user.type(box, 'Metro Housing Authority');
    await waitFor(() =>
      expect(checkOrgText).toHaveBeenLastCalledWith(
        { kind: 'housing_authority', text: 'Metro Housing Authority' },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(yes()).toBeEnabled());
    await user.click(yes());
    expect(addOrg).toHaveBeenCalledWith({ kind: 'housing_authority', name: 'Metro Housing Authority' });
  });

  it('a refused add shows the mapped copy, never the raw code', async () => {
    checkOrgText.mockResolvedValue({ candidates: [], close: [] });
    addOrg.mockRejectedValue(new ApiError(409, 'org_name_taken', 'org_name_taken', { error: 'org_name_taken', entry: ATL }));
    renderDialog();
    await waitFor(() => expect(yes()).toBeEnabled());
    fireEvent.click(yes());
    expect(await screen.findByRole('alert')).toHaveTextContent('That name is already on the list as Atlanta Housing Authority.');
    expect(screen.queryByText(/org_name_taken/)).not.toBeInTheDocument();
  });

  it('uses an answer the caller already holds instead of checking again', () => {
    renderDialog({ text: 'AHA', mode: 'suggestion', initialCheck: { candidates: [ATL, AUG], close: [] } });
    expect(screen.getByRole('button', { name: 'Use Atlanta Housing Authority' })).toBeInTheDocument();
    expect(checkOrgText).not.toHaveBeenCalled();
  });

  it('a name edited and brought back to the starting text is checked again, never stuck on "Checking the list..."', async () => {
    // Code review R1-ADV-FE-8: the caller's answer belongs to the starting
    // text; once an edit's check replaced it, going back must ask again.
    const user = userEvent.setup();
    checkOrgText.mockResolvedValue({ candidates: [], close: [] });
    renderDialog({ text: 'Metro Housing', initialCheck: { candidates: [], close: [] } });
    expect(yes()).toBeEnabled(); // the caller's answer, no check
    const box = screen.getByRole('textbox', { name: 'Name' });
    await user.type(box, 'X');
    await waitFor(() =>
      expect(checkOrgText).toHaveBeenLastCalledWith(
        { kind: 'housing_authority', text: 'Metro HousingX' },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(yes()).toBeEnabled());
    await user.type(box, '{Backspace}');
    await waitFor(() =>
      expect(checkOrgText).toHaveBeenLastCalledWith(
        { kind: 'housing_authority', text: 'Metro Housing' },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(yes()).toBeEnabled());
    expect(screen.queryByText('Checking the list...')).not.toBeInTheDocument();
  });

  it('suggestion mode shows the heard text as fixed, with no Name textbox', () => {
    renderDialog({ text: 'AHA', mode: 'suggestion', initialCheck: { candidates: [ATL, AUG], close: [] } });
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    expect(screen.getByText('AHA')).toBeInTheDocument();
  });

  it('settings mode starts empty, checks what staff type, and lists names already on the list without Use', async () => {
    const user = userEvent.setup();
    checkOrgText.mockResolvedValue({ candidates: [], close: [ATL] });
    renderDialog({ text: '', mode: 'settings', onUse: undefined });
    expect(yes()).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Atlnta Housing');
    expect(await screen.findByText('Atlanta Housing Authority')).toBeInTheDocument();
    expect(checkOrgText).toHaveBeenLastCalledWith({ kind: 'housing_authority', text: 'Atlnta Housing' }, expect.any(AbortSignal));
    expect(screen.queryByRole('button', { name: /^Use / })).not.toBeInTheDocument();
    expect(yes()).toBeEnabled();
  });

  it('a failed check still allows the add (the server decides) and offers Try again', async () => {
    checkOrgText
      .mockRejectedValueOnce(new ApiError(0, 'network_error', 'Network request failed'))
      .mockResolvedValueOnce({ candidates: [], close: [] });
    renderDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't check the list");
    expect(yes()).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(checkOrgText).toHaveBeenCalledTimes(2));
  });

  it('every button carries an explicit type, so nothing here can submit a form', async () => {
    checkOrgText.mockResolvedValue({ candidates: [ATL, AUG], close: [] });
    renderDialog({ text: 'AHA' });
    await screen.findByRole('button', { name: 'Use Atlanta Housing Authority' });
    for (const button of screen.getAllByRole('button')) expect(button).toHaveAttribute('type', 'button');
  });
});
