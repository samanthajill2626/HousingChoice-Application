// OrgPicker - the type-to-search picker over the organization lists (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D6/D7). It generalizes ContactSearchField's proven shape - read that file's
// header for the reasoning, and keep the two in step:
//   - the listbox is a position:FIXED popover PORTALED to document.body and
//     measured from the input (Modal's body is a scroll container that would
//     clip it); it is DISMISSED - never chased - on a scroll that moved the
//     input, a resize, a mousedown outside both the field and the list, or
//     focus leaving the field (code review R1-ADV-FE-2: a list left open over
//     the next field invited an Escape that closed the whole Modal). A press
//     anywhere in the list keeps focus in the input, so a pick or a scrollbar
//     drag never counts as leaving;
//   - Escape preventDefaults, so a surrounding Modal stays open;
//   - Enter acts ONLY on a highlighted option, so inside a <form> an Enter
//     with nothing highlighted still submits it.
// COMMIT RULE (spec D7; R2 finding F2): the typed text is LOCAL state.
// `onChange` fires only on a pick or a clear (a chip's remove button), never
// per keystroke - the blast composer recreates its draft on every filter change.
// TYPED TEXT IS NEVER DROPPED SILENTLY (code review R1-ADV-FE-1): the picker
// reports the text it holds through `onPendingTextChange` ('' after a pick, an
// emptied input or an unmount; a clear - a chip's remove button - KEEPS the
// typed text, R2-FE-2), and a field left holding text that is not a pick shows
// the HOST's note about it under the field (`pendingNote`, R2-FE-6). A FORM's
// Save commits that text when it names exactly one entry and otherwise refuses
// to save (useTypedOrgText, which also writes the note); it clears the
// committed text or focuses the refused field through the `ref` handle. The
// composer keeps the commit rule above and never commits typed text. Focusing
// the field again re-opens its list for the text it holds.
// Matching covers names AND spellings (normalized like the server), so typing
// AHA lists both Atlanta and Augusta Housing Authority - a shared spelling
// shows every entry carrying it - and staff pick. An option's accessible name
// STARTS with the entry name (the S14 selector contract).
// A stored value that is not exactly a name of an offered kind (spec D3) is a
// removable chip marked "Not on the list". It stays untouched until staff
// remove it (an unchanged value never fails a save, D6).
// The add step is optional: with `onRequestAdd`, when NOTHING of the offered
// kinds matches, the one option is "Add <text> as a new housing authority" (or
// agency). The HOST renders "Is this really new?" (NewOrgDialog) outside its
// <form>; this component never does.
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OrgEntry, OrgKind } from '../../api/index.js';
import { KIND_NOUN, ORG_TYPED_NOT_SAVED, isOnList, normalizeOrgText } from './orgCopy.js';
import styles from './OrgPicker.module.css';

const MAX_SHOWN = 10;
/** U+00D7 MULTIPLICATION SIGN, built at runtime so the source stays ASCII. */
const REMOVE_GLYPH = String.fromCharCode(0xd7);

/** What a host form's Save guard asks of the picker (code review R1-ADV-FE-1). */
export interface OrgPickerHandle {
  /** Focus the field - Save refused the text it holds. */
  focus: () => void;
  /** Empty the field - Save committed the text it held, as a pick would. */
  clearText: () => void;
}

interface OrgPickerBaseProps {
  /** The visible label - also the combobox's accessible name. Keep each
   *  field's established label ("Housing authority", "Housing authorities",
   *  "Agency"): unit tests and e2e select by it. */
  label: string;
  /** The entry kinds offered (branch A: one kind per field). */
  kinds: readonly OrgKind[];
  entries: readonly OrgEntry[];
  /** True while the list loads: no "Not on the list" marks, no add option yet. */
  loading?: boolean;
  /** Present = the add step. Absent in the blast composer (spec D7). */
  onRequestAdd?: (text: string) => void;
  /** Help text under the field, wired as aria-describedby. */
  hint?: string;
  /** An inline field error (a list that failed to load, a refused save). */
  error?: string | null;
  disabled?: boolean;
  placeholder?: string;
  /** Root and label classes, so each host keeps its own field layout. */
  className?: string;
  labelClassName?: string;
  /** The typed text that is not a pick yet, on every change - and '' after a
   *  pick, an emptied input or an unmount (a chip removed keeps it, R2-FE-2).
   *  A form's Save reads it (R1-ADV-FE-1). */
  onPendingTextChange?: (text: string) => void;
  /** The note under a field focus left holding typed text that is not a
   *  pick: the host's truth about that text (code review R2-FE-6) - a form's
   *  says what its Save will do (useTypedOrgText), the composer's that it is
   *  no filter. Absent: "Not saved - pick a name from the list, or clear the
   *  text." (a host that never uses typed text: the Settle dialogs). null:
   *  no note. */
  pendingNote?: string | null;
  /** The Save guard's handle (React 19 passes `ref` as a plain prop). */
  ref?: React.Ref<OrgPickerHandle>;
}

export interface OrgPickerSingleProps extends OrgPickerBaseProps {
  multiple?: false;
  /** The stored value ('' = none). */
  value: string;
  onChange: (next: string) => void;
}

export interface OrgPickerMultiProps extends OrgPickerBaseProps {
  multiple: true;
  value: readonly string[];
  onChange: (next: string[]) => void;
}

export type OrgPickerProps = OrgPickerSingleProps | OrgPickerMultiProps;

type Option = { type: 'entry'; entry: OrgEntry; via?: string } | { type: 'add'; text: string };

interface ListPos {
  top: number;
  left: number;
  width: number;
  maxHeight: string;
}

/**
 * Entries of `kinds` matching `query` by name or spelling, best first: an
 * exact name, an exact spelling, a name prefix, a name substring, then a
 * spelling substring (the spelling that matched rides along as `via`). Never
 * fuzzy - close names belong to "Is this really new?" only (spec D4).
 */
function matchEntries(
  entries: readonly OrgEntry[],
  kinds: readonly OrgKind[],
  query: string,
  exclude: readonly string[],
): { entry: OrgEntry; via?: string }[] {
  const q = normalizeOrgText(query);
  if (q === '') return [];
  const scored: { entry: OrgEntry; via?: string; rank: number }[] = [];
  for (const entry of entries) {
    if (!kinds.includes(entry.kind) || exclude.includes(entry.name)) continue;
    const name = normalizeOrgText(entry.name);
    const exactSpelling = entry.spellings.find((s) => normalizeOrgText(s) === q);
    const partSpelling = entry.spellings.find((s) => normalizeOrgText(s).includes(q));
    if (name === q) scored.push({ entry, rank: 0 });
    else if (exactSpelling !== undefined) scored.push({ entry, via: exactSpelling, rank: 1 });
    else if (name.startsWith(q)) scored.push({ entry, rank: 2 });
    else if (name.includes(q)) scored.push({ entry, rank: 3 });
    else if (partSpelling !== undefined) scored.push({ entry, via: partSpelling, rank: 4 });
  }
  return scored
    .sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name))
    .slice(0, MAX_SHOWN)
    .map(({ entry, via }) => (via === undefined ? { entry } : { entry, via }));
}

export function OrgPicker(props: OrgPickerProps): React.JSX.Element {
  const {
    label,
    kinds,
    entries,
    loading = false,
    onRequestAdd,
    hint,
    error = null,
    disabled = false,
    placeholder,
    className,
    labelClassName,
    onPendingTextChange,
    pendingNote,
    ref,
  } = props;
  const chosen: readonly string[] =
    props.multiple === true ? props.value : props.value === '' ? [] : [props.value];

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pos, setPos] = useState<ListPos | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** Where the input was when the list was measured (ContactSearchField's rule:
   *  a scroll dismisses the list only if it moved the input). */
  const anchorRef = useRef<{ top: number; left: number } | null>(null);

  const uid = useId();
  const inputId = `${uid}-input`;
  const listboxId = `${uid}-listbox`;
  const hintId = `${uid}-hint`;
  const noteId = `${uid}-note`;
  const errorId = `${uid}-error`;

  /** Every change to the typed text goes through here, so the host always
   *  knows what the field holds (R1-ADV-FE-1). */
  function setText(next: string): void {
    setQuery(next);
    onPendingTextChange?.(next);
  }

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    clearText: () => {
      setText('');
      setActiveIndex(-1);
    },
  }));

  // The text goes with the picker: an unmount reports '' (the tenant pickers
  // unmount when the type leaves tenant - a Save must not act on text that is
  // no longer on screen). Through a ref, so the latest callback is told.
  const pendingRef = useRef(onPendingTextChange);
  useEffect(() => {
    pendingRef.current = onPendingTextChange;
  });
  useEffect(() => () => pendingRef.current?.(''), []);

  const trimmed = query.trim();
  // Typed text the field holds after focus left it: say what the host makes
  // of it under the field (R1-ADV-FE-1, R2-FE-6).
  const noteText = pendingNote === undefined ? ORG_TYPED_NOT_SAVED : pendingNote;
  const showNote = !focused && trimmed !== '' && noteText !== null;
  // "When nothing matches" (spec D6) is judged against EVERY entry of the
  // kinds - chosen ones included - so the add step never offers a name a pick
  // can reach. A multi-picker never offers a member it already holds.
  const showAdd =
    onRequestAdd !== undefined &&
    trimmed !== '' &&
    !loading &&
    matchEntries(entries, kinds, query, []).length === 0;
  const options: Option[] = showAdd
    ? [{ type: 'add', text: trimmed }]
    : matchEntries(entries, kinds, query, props.multiple === true ? props.value : []).map(
        (m): Option => ({ type: 'entry', ...m }),
      );
  const isListShown = !disabled && !dismissed && options.length > 0;
  const addNoun = KIND_NOUN[kinds[0] ?? 'housing_authority'];

  // Measure while the list is shown - ContactSearchField's layout effect, shape
  // for shape (it lints clean): the list never paints at a stale position.
  useLayoutEffect(() => {
    if (!isListShown || !inputRef.current) {
      anchorRef.current = null;
      setPos(null);
      return;
    }
    const rect = inputRef.current.getBoundingClientRect();
    anchorRef.current = { top: rect.top, left: rect.left };
    const top = rect.bottom + 4;
    setPos({
      top,
      left: rect.left,
      width: rect.width,
      // Fit the remaining viewport, with a floor (ContactSearchField's rule).
      maxHeight: `max(9rem, min(${Math.round(window.innerHeight - top - 12)}px, 60vh))`,
    });
  }, [isListShown, options.length]);

  useEffect(() => {
    if (!isListShown) return undefined;
    const onScroll = (e: Event): void => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      const anchor = anchorRef.current;
      const rect = inputRef.current?.getBoundingClientRect();
      if (
        anchor !== null &&
        rect !== undefined &&
        Math.abs(rect.top - anchor.top) < 0.5 &&
        Math.abs(rect.left - anchor.left) < 0.5
      ) {
        return;
      }
      setDismissed(true);
    };
    const onResize = (): void => setDismissed(true);
    // The list is portaled OUT of the field's subtree, so both refs are consulted.
    const onDocMouseDown = (e: MouseEvent): void => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (inputRef.current?.parentElement?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      setDismissed(true);
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('mousedown', onDocMouseDown);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('mousedown', onDocMouseDown);
    };
  }, [isListShown]);

  const activeOptionId =
    isListShown && activeIndex >= 0 && activeIndex < options.length ? `${uid}-option-${activeIndex}` : undefined;
  const describedBy =
    [hint !== undefined ? hintId : '', showNote ? noteId : '', error ? errorId : '']
      .filter((id) => id !== '')
      .join(' ') || undefined;

  function choose(option: Option): void {
    setActiveIndex(-1);
    setText('');
    setDismissed(false);
    if (option.type === 'add') {
      onRequestAdd?.(option.text);
      return;
    }
    const name = option.entry.name;
    if (props.multiple === true) {
      if (!props.value.includes(name)) props.onChange([...props.value, name]);
    } else {
      props.onChange(name);
    }
  }

  function remove(value: string): void {
    if (props.multiple === true) props.onChange(props.value.filter((v) => v !== value));
    else props.onChange('');
    // The typed text STAYS (code review R2-FE-2): "type the new name, remove
    // the old chip, Save" must not lose the new name at the remove. It is
    // still what the host was told, and back in the field its list returns.
    setActiveIndex(-1);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (!isListShown) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1 < options.length ? prev + 1 : prev));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : 0));
    } else if (e.key === 'Enter') {
      const option = activeIndex >= 0 ? options[activeIndex] : undefined;
      if (option !== undefined) {
        e.preventDefault();
        choose(option);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(true);
      setActiveIndex(-1);
    }
  }

  return (
    <div className={className ?? styles.field}>
      <label htmlFor={inputId} className={labelClassName ?? styles.label}>
        {label}
      </label>
      {chosen.length > 0 ? (
        <ul className={styles.chips}>
          {chosen.map((value, index) => {
            const offList = !loading && !isOnList(entries, value, kinds);
            return (
              <li key={`${value}-${index}`} className={offList ? `${styles.chip} ${styles.chipOffList}` : styles.chip}>
                <span className={styles.chipText}>{value}</span>
                {offList ? <span className={styles.offList}>Not on the list</span> : null}
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={`Remove ${value}`}
                  title={`Remove ${value}`}
                  disabled={disabled}
                  onClick={() => remove(value)}
                >
                  {REMOVE_GLYPH}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className={styles.inputWrap}>
        <input
          ref={inputRef}
          id={inputId}
          className={styles.input}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isListShown}
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          aria-describedby={describedBy}
          value={query}
          disabled={disabled}
          placeholder={placeholder ?? 'Type a name or abbreviation'}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            setActiveIndex(-1);
            setDismissed(false);
          }}
          onFocus={() => {
            setFocused(true);
            // Back in the field, its list follows the text it holds again.
            setDismissed(false);
          }}
          onBlur={(e) => {
            setFocused(false);
            // Focus left the field (Tab, a click elsewhere): close the list
            // rather than leave it painted over the next field (R1-ADV-FE-2).
            const next = e.relatedTarget;
            if (next instanceof Node && listRef.current?.contains(next)) return;
            setDismissed(true);
            setActiveIndex(-1);
          }}
          onKeyDown={handleKeyDown}
        />
      </div>
      {hint !== undefined ? (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
      {showNote ? (
        <p id={noteId} className={styles.pendingNote}>
          {noteText}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {isListShown &&
        createPortal(
          <ul
            id={listboxId}
            ref={listRef}
            className={styles.listbox}
            role="listbox"
            aria-label={`${label} suggestions`}
            style={pos ? { top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight } : undefined}
            onMouseDown={(e) => {
              // A press on the list's scrollbar or padding must not blur the
              // input: a blur closes the list (R1-ADV-FE-2).
              e.preventDefault();
            }}
          >
            {options.map((option, index) => (
              <li
                key={option.type === 'add' ? 'add' : option.entry.orgId}
                id={`${uid}-option-${index}`}
                className={option.type === 'add' ? `${styles.option} ${styles.optionAdd}` : styles.option}
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(e) => {
                  // Keep focus in the input until the click lands.
                  e.preventDefault();
                }}
                onClick={() => choose(option)}
              >
                {option.type === 'add' ? (
                  `Add ${option.text} as a new ${addNoun}`
                ) : (
                  <>
                    {option.entry.name}
                    {option.via !== undefined ? (
                      <>
                        {' '}
                        <span className={styles.optionNote}>{`(${option.via})`}</span>
                      </>
                    ) : null}
                  </>
                )}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
