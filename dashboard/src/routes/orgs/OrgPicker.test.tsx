// OrgPicker tests - the organization-list picker (spec 2026-10-06 D6/D7; the
// S14 selector contract P1-P5): names AND spellings match, a pick or a clear is
// the ONLY commit, a stored off-list value is a removable "Not on the list"
// chip, Enter acts only on a highlighted option, Escape keeps a surrounding
// Modal open, the list is portaled, and the optional add step.
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { OrgEntry } from '../../api/index.js';
import { Modal } from '../contact/Modal.js';
import { OrgPicker, type OrgPickerHandle } from './OrgPicker.js';

function entry(kind: OrgEntry['kind'], name: string, spellings: string[] = []): OrgEntry {
  return {
    orgId: `id-${name}`,
    kind,
    name,
    spellings,
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'system',
  };
}

const ATLANTA = entry('housing_authority', 'Atlanta Housing Authority', ['AHA', 'Atlanta Housing']);
const AUGUSTA = entry('housing_authority', 'Augusta Housing Authority', ['AHA']);
const DEKALB = entry('housing_authority', 'DeKalb County Housing Authority', ['HADC']);
const STEP_UP = entry('agency', 'Step Up');
const ENTRIES = [ATLANTA, AUGUSTA, DEKALB, STEP_UP];

function Single({
  initial = '',
  onChangeSpy,
  onRequestAdd,
}: {
  initial?: string;
  onChangeSpy?: (v: string) => void;
  onRequestAdd?: (text: string) => void;
}): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <OrgPicker
      label="Housing authority"
      kinds={['housing_authority']}
      entries={ENTRIES}
      value={value}
      onChange={(next) => {
        onChangeSpy?.(next);
        setValue(next);
      }}
      {...(onRequestAdd !== undefined && { onRequestAdd })}
    />
  );
}

function Multi({ initial = [], onChangeSpy }: { initial?: string[]; onChangeSpy?: (v: string[]) => void }): React.JSX.Element {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <OrgPicker
      multiple
      label="Housing authorities"
      kinds={['housing_authority']}
      entries={ENTRIES}
      value={value}
      onChange={(next) => {
        onChangeSpy?.(next);
        setValue(next);
      }}
    />
  );
}

const combobox = (name = 'Housing authority'): HTMLElement => screen.getByRole('combobox', { name });
const optionNames = (): string[] => screen.getAllByRole('option').map((o) => o.textContent ?? '');

describe('OrgPicker - single', () => {
  it('is a combobox named by its visible label and described by its hint', () => {
    render(
      <OrgPicker
        label="Housing authority"
        hint="The organization that runs the voucher"
        kinds={['housing_authority']}
        entries={ENTRIES}
        value=""
        onChange={vi.fn()}
      />,
    );
    expect(combobox()).toHaveAccessibleDescription('The organization that runs the voucher');
  });

  it('typing never commits - only a pick does, as the full name', () => {
    const onChangeSpy = vi.fn();
    render(<Single onChangeSpy={onChangeSpy} />);
    fireEvent.change(combobox(), { target: { value: 'Atl' } });
    expect(onChangeSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: /^Atlanta Housing Authority/ }));
    expect(onChangeSpy).toHaveBeenCalledWith('Atlanta Housing Authority');
    expect(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    expect(combobox()).toHaveValue('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('a shared spelling lists every entry carrying it, each name first with the spelling after it', () => {
    render(<Single />);
    fireEvent.change(combobox(), { target: { value: 'aha' } });
    expect(optionNames()).toEqual(['Atlanta Housing Authority (AHA)', 'Augusta Housing Authority (AHA)']);
  });

  it('offers only the kinds it was given', () => {
    render(<Single />);
    fireEvent.change(combobox(), { target: { value: 'Step' } });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows a stored value that is not on the list as a removable "Not on the list" chip', () => {
    const onChangeSpy = vi.fn();
    render(<Single initial="atlanta_housing" onChangeSpy={onChangeSpy} />);
    expect(screen.getByText('atlanta_housing')).toBeInTheDocument();
    expect(screen.getByText('Not on the list')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove atlanta_housing' }));
    expect(onChangeSpy).toHaveBeenCalledWith('');
    expect(screen.queryByText('atlanta_housing')).not.toBeInTheDocument();
  });

  it('a list name carries no mark, and nothing is marked while the list still loads', () => {
    const { unmount } = render(<Single initial="Atlanta Housing Authority" />);
    expect(screen.queryByText('Not on the list')).not.toBeInTheDocument();
    unmount();
    render(
      <OrgPicker label="Housing authority" kinds={['housing_authority']} entries={[]} loading value="atlanta_housing" onChange={vi.fn()} />,
    );
    expect(screen.queryByText('Not on the list')).not.toBeInTheDocument();
  });

  it('Enter acts only on a highlighted option; otherwise the surrounding form submits', async () => {
    const user = userEvent.setup();
    const onChangeSpy = vi.fn();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Single onChangeSpy={onChangeSpy} />
      </form>,
    );
    await user.type(combobox(), 'DeKalb{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onChangeSpy).not.toHaveBeenCalled();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChangeSpy).toHaveBeenCalledWith('DeKalb County Housing Authority');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the list but keeps a surrounding Modal open', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Edit contact" onClose={onClose}>
        <Single />
      </Modal>,
    );
    fireEvent.change(combobox(), { target: { value: 'Atl' } });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(combobox(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Edit contact' })).toBeInTheDocument();
  });

  it('portals the list to document.body (a Modal body would clip it)', () => {
    render(<Single />);
    fireEvent.change(combobox(), { target: { value: 'Atl' } });
    expect(screen.getByRole('listbox').parentElement).toBe(document.body);
  });

  it('a load failure shows inline and the field cannot be used', () => {
    render(
      <OrgPicker
        label="Housing authority"
        kinds={['housing_authority']}
        entries={[]}
        value=""
        onChange={vi.fn()}
        disabled
        error="Couldn't load housing authorities"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load housing authorities");
    expect(combobox()).toBeDisabled();
  });
});

describe('OrgPicker - multi', () => {
  it('appends a picked name, keeps untouched members byte-exact, and never offers a member twice', () => {
    const onChangeSpy = vi.fn();
    render(<Multi initial={['Atlanta Housing Authority', ' Old Place ']} onChangeSpy={onChangeSpy} />);
    // Only the member that is not a list name is marked.
    expect(screen.getAllByText('Not on the list')).toHaveLength(1);
    fireEvent.change(combobox('Housing authorities'), { target: { value: 'housing authority' } });
    expect(optionNames()).toEqual(['Augusta Housing Authority', 'DeKalb County Housing Authority']);
    fireEvent.click(screen.getByRole('option', { name: /^DeKalb County Housing Authority/ }));
    expect(onChangeSpy).toHaveBeenLastCalledWith(['Atlanta Housing Authority', ' Old Place ', 'DeKalb County Housing Authority']);
  });

  it('removing a member sends the list without it', () => {
    const onChangeSpy = vi.fn();
    render(<Multi initial={['Atlanta Housing Authority', 'DeKalb County Housing Authority']} onChangeSpy={onChangeSpy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith(['DeKalb County Housing Authority']);
  });
});

describe('OrgPicker - the add step', () => {
  it('when nothing matches, the one option adds the typed text through the host - without committing it', () => {
    const onChangeSpy = vi.fn();
    const onRequestAdd = vi.fn();
    render(<Single onChangeSpy={onChangeSpy} onRequestAdd={onRequestAdd} />);
    fireEvent.change(combobox(), { target: { value: '  Metro Housing Board  ' } });
    expect(optionNames()).toEqual(['Add Metro Housing Board as a new housing authority']);
    fireEvent.click(screen.getByRole('option', { name: 'Add Metro Housing Board as a new housing authority' }));
    expect(onRequestAdd).toHaveBeenCalledWith('Metro Housing Board');
    expect(onChangeSpy).not.toHaveBeenCalled();
    expect(combobox()).toHaveValue('');
  });

  it('offers no add option while something matches', () => {
    render(<Single onRequestAdd={vi.fn()} />);
    fireEvent.change(combobox(), { target: { value: 'HADC' } });
    expect(optionNames()).toEqual(['DeKalb County Housing Authority (HADC)']);
    fireEvent.change(combobox(), { target: { value: 'Augusta' } });
    expect(optionNames()).toEqual(['Augusta Housing Authority']);
  });

  it('offers no add option without onRequestAdd (the blast composer)', () => {
    render(<Single />);
    fireEvent.change(combobox(), { target: { value: 'Nowhere Org' } });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('OrgPicker - focus leaving the field (code review R1-ADV-FE-2)', () => {
  it('Tab away closes the list: no stray popup over the next field, and aria-expanded is false', async () => {
    const user = userEvent.setup();
    render(
      <Modal title="Edit contact" onClose={vi.fn()}>
        <OrgPicker label="Housing authority" kinds={['housing_authority']} entries={ENTRIES} value="" onChange={vi.fn()} />
        <OrgPicker label="Agency" kinds={['agency']} entries={ENTRIES} value="" onChange={vi.fn()} />
      </Modal>,
    );
    const housingAuthority = combobox();
    await user.type(housingAuthority, 'AHA');
    expect(screen.getByRole('listbox', { name: 'Housing authority suggestions' })).toBeInTheDocument();
    await user.tab();
    expect(combobox('Agency')).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(housingAuthority).toHaveAttribute('aria-expanded', 'false');
  });

  it('a press anywhere in the list (its scrollbar, its padding) keeps focus in the field', () => {
    render(<Single />);
    fireEvent.change(combobox(), { target: { value: 'aha' } });
    // false = the default (moving focus out of the input) was prevented.
    expect(fireEvent.mouseDown(screen.getByRole('listbox'))).toBe(false);
  });

  it('a click on an option still picks it - focus never leaves the field', async () => {
    const user = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(<Single onChangeSpy={onChangeSpy} />);
    await user.type(combobox(), 'aha');
    await user.click(screen.getByRole('option', { name: /^Augusta Housing Authority/ }));
    expect(onChangeSpy).toHaveBeenCalledWith('Augusta Housing Authority');
    expect(combobox()).toHaveFocus();
  });
});

describe('OrgPicker - text typed but never picked (code review R1-ADV-FE-1)', () => {
  const NOTE = 'Not saved - pick a name from the list, or clear the text.';

  /** A single picker with a focusable neighbour to move focus to. */
  function Typed({
    onPendingTextChange,
    pickerRef,
  }: {
    onPendingTextChange?: (text: string) => void;
    pickerRef?: React.Ref<OrgPickerHandle>;
  }): React.JSX.Element {
    const [value, setValue] = useState('');
    return (
      <>
        <OrgPicker
          label="Housing authority"
          kinds={['housing_authority']}
          entries={ENTRIES}
          value={value}
          onChange={setValue}
          {...(onPendingTextChange !== undefined && { onPendingTextChange })}
          {...(pickerRef !== undefined && { ref: pickerRef })}
        />
        <button type="button">Elsewhere</button>
      </>
    );
  }

  it('reports the typed text to the host, and an empty text after a pick and an emptied input', async () => {
    const user = userEvent.setup();
    const onPendingTextChange = vi.fn();
    render(<Typed onPendingTextChange={onPendingTextChange} />);
    await user.type(combobox(), 'Atl');
    expect(onPendingTextChange).toHaveBeenLastCalledWith('Atl');
    await user.click(screen.getByRole('option', { name: /^Atlanta Housing Authority/ }));
    expect(onPendingTextChange).toHaveBeenLastCalledWith('');
    await user.type(combobox(), 'x');
    expect(onPendingTextChange).toHaveBeenLastCalledWith('x');
    await user.clear(combobox());
    expect(onPendingTextChange).toHaveBeenLastCalledWith('');
  });

  it('removing a chip keeps the typed text: it stays in the field, still reported, its list back (R2-FE-2)', async () => {
    // The natural "replace the stale value" order - type the new name, then
    // remove the old chip, then Save - must not lose the new name at the remove.
    const user = userEvent.setup();
    const onPendingTextChange = vi.fn();
    render(<Typed onPendingTextChange={onPendingTextChange} />);
    await user.type(combobox(), 'Atl');
    await user.click(screen.getByRole('option', { name: /^Atlanta Housing Authority/ }));
    await user.type(combobox(), 'DeK');
    await user.click(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' }));
    expect(screen.queryByRole('button', { name: 'Remove Atlanta Housing Authority' })).not.toBeInTheDocument();
    expect(combobox()).toHaveValue('DeK');
    expect(onPendingTextChange).toHaveBeenLastCalledWith('DeK');
    expect(combobox()).toHaveFocus();
    expect(optionNames()).toEqual(['DeKalb County Housing Authority']);
  });

  it('a field left holding typed text shows a note under it that describes it', async () => {
    const user = userEvent.setup();
    render(<Typed />);
    await user.type(combobox(), 'Metro');
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument(); // never while typing
    await user.tab();
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(combobox()).toHaveAccessibleDescription(NOTE);
    // Back in the field the note goes; an emptied field never shows it.
    await user.click(combobox());
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    await user.clear(combobox());
    await user.tab();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it("the note is the host's truth about the text: its own words, or none at all (R2-FE-6)", async () => {
    const user = userEvent.setup();
    const WILL_USE = 'Save will use DeKalb County Housing Authority.';
    const picker = (pendingNote: string | null): React.JSX.Element => (
      <>
        <OrgPicker
          label="Housing authority"
          kinds={['housing_authority']}
          entries={ENTRIES}
          value=""
          onChange={vi.fn()}
          pendingNote={pendingNote}
        />
        <button type="button">Elsewhere</button>
      </>
    );
    const { rerender } = render(picker(WILL_USE));
    await user.type(combobox(), 'HADC');
    await user.tab();
    expect(combobox()).toHaveAccessibleDescription(WILL_USE);
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    rerender(picker(null));
    expect(screen.queryByText(WILL_USE)).not.toBeInTheDocument();
    expect(combobox()).toHaveAccessibleDescription('');
  });

  it('an unmounted picker tells its host the text is gone', async () => {
    // A host must not act on text that left the screen with its picker (the
    // tenant pickers unmount when the type leaves tenant).
    const user = userEvent.setup();
    const onPendingTextChange = vi.fn();
    const { unmount } = render(<Typed onPendingTextChange={onPendingTextChange} />);
    await user.type(combobox(), 'Metro');
    expect(onPendingTextChange).toHaveBeenLastCalledWith('Metro');
    unmount();
    expect(onPendingTextChange).toHaveBeenLastCalledWith('');
  });

  it('a host form can focus the field and clear the text it committed', async () => {
    const user = userEvent.setup();
    const onPendingTextChange = vi.fn();
    const pickerRef = createRef<OrgPickerHandle>();
    render(<Typed onPendingTextChange={onPendingTextChange} pickerRef={pickerRef} />);
    await user.type(combobox(), 'DCA');
    await user.tab();
    act(() => pickerRef.current?.focus());
    expect(combobox()).toHaveFocus();
    act(() => pickerRef.current?.clearText());
    expect(combobox()).toHaveValue('');
    expect(onPendingTextChange).toHaveBeenLastCalledWith('');
  });

  it('focusing the field again re-opens the list for the text it holds', async () => {
    const user = userEvent.setup();
    render(<Typed />);
    await user.type(combobox(), 'aha');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(combobox());
    expect(optionNames()).toEqual(['Atlanta Housing Authority (AHA)', 'Augusta Housing Authority (AHA)']);
  });
});
