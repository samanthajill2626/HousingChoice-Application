// UnitSearchField — a text input with a client-side filtered candidate list.
// Picking a candidate sets { label, unitId } and COMMITS the field: the list
// hides, the input goes read-only, and the Clear button is the only way back
// to free typing (so typing can never silently drop a selection). Free typing
// (uncommitted only) clears unitId.
// Candidates are rendered as JSX text nodes — never dangerouslySetInnerHTML.
//
// POSITIONING: identical to ContactSearchField, and for the identical reason -
// the list is a position:FIXED popover portaled to document.body, because an
// absolutely positioned one is clipped by any ancestor scroll container and
// `Modal`'s .body is exactly that. Two of this field's three call sites are
// modals (PlacementCreateForm, ScheduleTourForm); the third is the broadcast
// composer. See ContactSearchField's header for the full reasoning and the
// StageMenu precedent. Keep the two fields' behaviour in step.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type UnitItem } from '../../api/index.js';
import { formatAddress } from './format.js';
import styles from './UnitSearchField.module.css';

const MAX_SHOWN = 8;

export interface UnitSearchValue {
  label: string;
  unitId?: string;
}

export interface UnitSearchFieldProps {
  value: UnitSearchValue;
  onChange: (v: UnitSearchValue) => void;
  candidates: UnitItem[];
  /** Accessible label for the underlying text input. */
  inputLabel?: string;
}

/** The display label for a unit — its formatted address, falling back to the
 *  unitId when the address is empty (so an option is never blank). Exported so
 *  callers pre-committing a pick (ScheduleTourForm's initialUnitId) produce the
 *  EXACT label a hand pick would. */
export function unitLabel(u: UnitItem): string {
  const addr = formatAddress(u.address);
  return addr || u.unitId;
}

/** Filter candidates whose formatted address (or unitId fallback) contains the
 *  query (case-insensitive). Caps results at MAX_SHOWN. */
function filterCandidates(candidates: UnitItem[], query: string): UnitItem[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const results: UnitItem[] = [];
  for (const u of candidates) {
    if (results.length >= MAX_SHOWN) break;
    if (unitLabel(u).toLowerCase().includes(q)) {
      results.push(u);
    }
  }
  return results;
}

export function UnitSearchField({
  value,
  onChange,
  candidates,
  inputLabel = 'Unit search',
}: UnitSearchFieldProps): React.JSX.Element {
  // keyboard navigation state
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  // a11y: dismissed flag — Escape collapses the popup; typing clears it
  const [dismissed, setDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** Viewport coordinates for the portaled list, measured from the input. */
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: string } | null>(
    null,
  );

  // stable, instance-unique ids
  const uid = useId();
  const listboxId = `${uid}-listbox`;

  // Committed: a unit is linked. The picked label always matches its own unit,
  // so the list must be gated on this, not just on matches.
  const isSelected = value.unitId !== undefined;
  const matches = filterCandidates(candidates, value.label);
  const isListShown = !dismissed && !isSelected && matches.length > 0;

  // Measure while the list is shown; the input does not move as the user types.
  // useLayoutEffect so it never paints at a stale position.
  useLayoutEffect(() => {
    if (!isListShown || !inputRef.current) {
      setPos(null);
      return;
    }
    const rect = inputRef.current.getBoundingClientRect();
    const top = rect.bottom + 4;
    setPos({
      top,
      left: rect.left,
      width: rect.width,
      maxHeight: `max(9rem, min(${Math.round(window.innerHeight - top - 12)}px, 60vh))`,
    });
  }, [isListShown, matches.length]);

  // Fixed coordinates go stale on scroll/resize - dismiss rather than chase.
  // Capture phase so an ancestor modal body's scroll counts; scrolls inside the
  // list are ignored. Outside-click checks BOTH refs: the list is portaled out
  // of this field's subtree, so a click on an option is otherwise "outside".
  useEffect(() => {
    if (!isListShown) return;
    const onScroll = (e: Event): void => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      setDismissed(true);
    };
    const onResize = (): void => setDismissed(true);
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

  // Build a stable option id for aria-activedescendant
  const activeOptionId =
    isListShown && activeIndex >= 0 && activeIndex < matches.length
      ? `${uid}-option-${activeIndex}`
      : undefined;

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>): void {
    // Free typing — always clear any prior unitId link; reset keyboard selection
    setActiveIndex(-1);
    setDismissed(false);
    onChange({ label: e.target.value });
  }

  function handlePick(candidate: UnitItem): void {
    setActiveIndex(-1);
    onChange({ label: unitLabel(candidate), unitId: candidate.unitId });
  }

  function handleClear(): void {
    setActiveIndex(-1);
    setDismissed(false);
    onChange({ label: '' });
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (!isListShown) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1 < matches.length ? prev + 1 : prev));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : 0));
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && activeIndex < matches.length) {
        e.preventDefault();
        const candidate = matches[activeIndex];
        if (candidate) handlePick(candidate);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(true);
      setActiveIndex(-1);
    }
  }

  return (
    <div className={styles.wrapper}>
      <input
        ref={inputRef}
        className={isSelected ? `${styles.input} ${styles.inputSelected}` : styles.input}
        type="text"
        aria-label={inputLabel}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={isListShown}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        value={value.label}
        readOnly={isSelected}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        placeholder="Search properties…"
        autoComplete="off"
      />
      {isSelected && (
        <button
          type="button"
          className={styles.clearButton}
          aria-label={`Clear ${inputLabel}`}
          title={`Clear ${inputLabel}`}
          onClick={handleClear}
        >
          {'×'}
        </button>
      )}
      {isListShown &&
        createPortal(
        <ul
          id={listboxId}
          ref={listRef}
          className={styles.listbox}
          role="listbox"
          aria-label={`${inputLabel} suggestions`}
          style={
            pos
              ? { top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }
              : undefined
          }
        >
          {matches.map((u, idx) => {
            const label = unitLabel(u);
            const isActive = idx === activeIndex;
            return (
              <li
                key={u.unitId}
                id={`${uid}-option-${idx}`}
                className={styles.option}
                role="option"
                aria-selected={isActive}
                onMouseDown={(e) => {
                  // mousedown fires before blur; prevent the input losing focus
                  // before the click registers
                  e.preventDefault();
                }}
                onClick={() => handlePick(u)}
              >
                {label}
              </li>
            );
          })}
        </ul>,
          document.body,
        )}
    </div>
  );
}
