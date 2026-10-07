// useTypedOrgText - what a FORM does with the text typed in one of its org
// pickers but never picked (code review R1-ADV-FE-1, R2-FE-6). ONE rule -
// orgCopy settleTypedOrgText - answers both questions, so the note under the
// field can never promise one thing while Save does another:
//   - text naming exactly one entry (its name, or a spelling only it carries):
//     the note says "Save will use <name>.", and Save commits that name as a
//     pick would (and empties the field);
//   - any other text: the note says "Not saved - ...", and Save refuses,
//     saying why under the field (role="alert") until the text changes;
//   - a Save never waits on a picker staff cannot use (code review R2-FE-1):
//     while the list failed to load, the picker (disabled) keeps its text
//     unused - the field keeps its value - and its load error stays in view,
//     never replaced by a refusal; before the first read lands, Save refuses
//     with "Still loading the list - try again in a moment."
// Every form passes its picker's ref in, wires `onPendingTextChange`, `note`,
// `refusal` and `refusalAttempt` to the OrgPicker (`errorAttempt`: a refusal
// repeated word for word is announced again, code review R2-FE-10) and calls
// settle() from Save - no form holds
// its own copy of the rule. (The form owns the ref: a hook result carrying one
// would read as a ref to the React Compiler's lint at every render use.) The
// blast composer never commits typed text (spec D7): it does not use this.
import { useState, type RefObject } from 'react';
import type { OrgKind } from '../../api/index.js';
import type { OrgPickerHandle } from './OrgPicker.js';
import { settleTypedOrgText, typedOrgNote, typedOrgRefusal, type OrgListView, type TypedOrgText } from './orgCopy.js';

export interface TypedOrgTextField {
  /** The picker's `onPendingTextChange`. */
  onPendingTextChange: (text: string) => void;
  /** The picker's `pendingNote`: what Save will do with the text it holds. */
  note: string | null;
  /** Why the last Save refused the text (the picker's `error`), until the text changes. */
  refusal: string | null;
  /** The picker's `errorAttempt`: one more per refused Save, so a refusal
   *  repeated word for word is announced again (code review R2-FE-10). */
  refusalAttempt: number;
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
  const [refusal, setRefusal] = useState<string | null>(null);
  const [refusalAttempt, setRefusalAttempt] = useState(0);
  const verdict = settleTypedOrgText(list, kinds, text);
  return {
    onPendingTextChange: (next) => {
      setText(next);
      setRefusal(null);
    },
    note: typedOrgNote(verdict),
    // A list that failed to load disables the picker: its load error is
    // what the field says, never a refusal from an earlier Save (R2-FE-1).
    refusal: list.error ? null : refusal,
    refusalAttempt,
    settle: () => {
      const refused = typedOrgRefusal(verdict);
      setRefusal(refused);
      if (refused !== null) setRefusalAttempt((n) => n + 1);
      if (verdict.status === 'resolved') picker.current?.clearText();
      return verdict;
    },
    focus: () => picker.current?.focus(),
  };
}
