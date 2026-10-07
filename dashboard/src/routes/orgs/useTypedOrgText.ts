// useTypedOrgText - what a FORM does with the text typed in one of its org
// pickers but never picked (code review R1-ADV-FE-1, R2-FE-6). ONE rule -
// orgCopy settleTypedOrgText - answers both questions, so the note under the
// field can never promise one thing while Save does another:
//   - text naming exactly one entry (its name, or a spelling only it carries):
//     the note says "Save will use <name>.", and Save commits that name as a
//     pick would (and empties the field);
//   - any other text: the note says "Not saved - ...", and Save refuses,
//     saying why under the field (role="alert") until the text changes.
// Every form passes its picker's ref in, wires `onPendingTextChange`, `note`
// and `refusal` to the OrgPicker and calls settle() from Save - no form holds
// its own copy of the rule. (The form owns the ref: a hook result carrying one
// would read as a ref to the React Compiler's lint at every render use.) The
// blast composer never commits typed text (spec D7): it does not use this.
import { useState, type RefObject } from 'react';
import type { OrgEntry, OrgKind } from '../../api/index.js';
import type { OrgPickerHandle } from './OrgPicker.js';
import { ORG_TYPED_BLOCKED, refusesSave, settleTypedOrgText, typedOrgNote, type TypedOrgText } from './orgCopy.js';

export interface TypedOrgTextField {
  /** The picker's `onPendingTextChange`. */
  onPendingTextChange: (text: string) => void;
  /** The picker's `pendingNote`: what Save will do with the text it holds. */
  note: string | null;
  /** Why the last Save refused the text (the picker's `error`), until the text changes. */
  refusal: string | null;
  /** Save's verdict on the text the field holds: a refusal is shown under
   *  the field; a committed text is emptied from it, as a pick would be. */
  settle: () => TypedOrgText;
  /** Focus the field - Save refused its text. */
  focus: () => void;
}

/** `picker` is the OrgPicker's `ref`: Save focuses a refused field and empties a committed one. */
export function useTypedOrgText(
  list: { entries: readonly OrgEntry[] },
  kinds: readonly OrgKind[],
  picker: RefObject<OrgPickerHandle | null>,
): TypedOrgTextField {
  const [text, setText] = useState('');
  const [refused, setRefused] = useState(false);
  const verdict = settleTypedOrgText(list.entries, kinds, text);
  return {
    onPendingTextChange: (next) => {
      setText(next);
      setRefused(false);
    },
    note: typedOrgNote(verdict),
    refusal: refused ? ORG_TYPED_BLOCKED : null,
    settle: () => {
      setRefused(refusesSave(verdict));
      if (verdict.status === 'resolved') picker.current?.clearText();
      return verdict;
    },
    focus: () => picker.current?.focus(),
  };
}
