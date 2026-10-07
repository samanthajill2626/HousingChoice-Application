// useTypedOrgText - what a FORM does with the text typed in one of its org
// pickers but never picked (code review R1-ADV-FE-1, R2-FE-6). ONE rule -
// orgCopy settleTypedOrgText - answers both questions, so the note under the
// field can never promise one thing while Save does another:
//   - text naming exactly one entry (its name, or a spelling only it carries):
//     the note says "Save will use <name>.", and Save commits that name as a
//     pick would (and empties the field);
//   - any other text: the note says "Not saved - ...", and Save refuses,
//     saying why under the field (role="alert") until the text changes;
//   - typed text is never dropped silently, and a Save never waits on a
//     picker staff cannot use (code review R2-FE-1, R3-FE-3): before the
//     first read lands, Save refuses with "Still loading the list - try
//     again in a moment."; a RE-read that fails keeps the last list in hand,
//     and the text settles against it as usual; a read that fails with
//     nothing in hand leaves nothing to settle against - Save refuses with
//     "The list did not load - clear the text to save without it.". A picker
//     whose list failed is disabled - but never while it holds text (here
//     `disabled`), so the text can always be fixed or cleared.
// Every form passes its picker's ref in, wires `onPendingTextChange`, `note`,
// `refusal`, `refusalAttempt` and `disabled` to the OrgPicker (`errorAttempt`:
// a refusal repeated word for word is announced again, code review R2-FE-10)
// and calls settle() from Save - no form holds its own copy of the rule. (The
// form owns the ref: a hook result carrying one would read as a ref to the
// React Compiler's lint at every render use.) The blast composer never commits
// typed text (spec D7): it does not use this, but keeps its picker usable the
// same way while it holds text (AudienceFilters).
import { useState, type RefObject } from 'react';
import type { OrgKind } from '../../api/index.js';
import type { OrgPickerHandle } from './OrgPicker.js';
import { settleTypedOrgText, typedOrgNote, typedOrgRefusal, type OrgListView, type TypedOrgText } from './orgCopy.js';

export interface TypedOrgTextField {
  /** The picker's `onPendingTextChange`. */
  onPendingTextChange: (text: string) => void;
  /** The picker's `pendingNote`: what Save will do with the text it holds. */
  note: string | null;
  /** Once a Save refused the text (until the text changes): why Save refuses
   *  it NOW (the picker's `error`) - re-judged against the list as it is, so
   *  it goes once the text settles (code review R3-FE-6). */
  refusal: string | null;
  /** The picker's `errorAttempt`: one more per refused Save, so a refusal
   *  repeated word for word is announced again (code review R2-FE-10). */
  refusalAttempt: number;
  /** The picker's `disabled`: a list that failed to load disables it -
   *  unless it holds text, which stays usable so a Save can never wait on a
   *  field staff cannot clear (code review R3-FE-3). */
  disabled: boolean;
  /** Save's verdict on the text the field holds: a refusal is shown under
   *  the field; a committed text is emptied from it, as a pick would be. */
  settle: () => TypedOrgText;
  /** Focus the field - Save refused its text. */
  focus: () => void;
}

/** `list` is the picker's list (useOrgList); `picker` is the OrgPicker's
 *  `ref`: Save focuses a refused field and empties a committed one. */
export function useTypedOrgText(
  list: OrgListView,
  kinds: readonly OrgKind[],
  picker: RefObject<OrgPickerHandle | null>,
): TypedOrgTextField {
  const [text, setText] = useState('');
  /** A Save refused the text the field holds (cleared when the text changes). */
  const [refused, setRefused] = useState(false);
  const [refusalAttempt, setRefusalAttempt] = useState(0);
  const verdict = settleTypedOrgText(list, kinds, text);
  return {
    onPendingTextChange: (next) => {
      setText(next);
      setRefused(false);
    },
    note: typedOrgNote(verdict),
    // The refusal is about the text AND the list, so it is the CURRENT
    // verdict's (code review R3-FE-6): once the list lands, a "still
    // loading" refusal goes if the text now settles - or says what refuses
    // it now - and never sits beside a note saying Save will use it. Under a
    // list that failed to load it shows too (R3-FE-3): Save refuses there,
    // and must say why.
    refusal: refused ? typedOrgRefusal(verdict) : null,
    refusalAttempt,
    disabled: list.error && text.trim() === '',
    settle: () => {
      const refusal = typedOrgRefusal(verdict);
      setRefused(refusal !== null);
      if (refusal !== null) setRefusalAttempt((n) => n + 1);
      if (verdict.status === 'resolved') picker.current?.clearText();
      return verdict;
    },
    focus: () => picker.current?.focus(),
  };
}
