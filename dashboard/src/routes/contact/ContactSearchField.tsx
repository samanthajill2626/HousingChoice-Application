// ContactSearchField — a text input with a client-side filtered candidate list.
// Picking a candidate sets { name, contactId } and COMMITS the field: the list
// hides, the input goes read-only, and the Clear button is the only way back
// to free typing (so typing can never silently drop a selection). Free typing
// (uncommitted only) clears contactId.
// Candidates are rendered as JSX text nodes — never dangerouslySetInnerHTML.
//
// EACH OPTION SHOWS THE CONTACT'S KIND AFTER THEIR NAME, and it is a SIBLING
// node, never part of `displayName`. A roster full of first-name-only contacts
// is otherwise unpickable - several rows read "Renee" with nothing to tell the
// tenant from the caseworker. It must stay out of `displayName` because
// handlePick commits that string as `value.name`, and RelationshipsEditor
// STORES that value: folding the kind in would write "Renee Partner" into a
// relationship. It DOES join the option's accessible name, deliberately - a
// screen-reader user needs the differentiator too - so query options by
// substring/regex, not by an exact accessible name.
//
// POSITIONING: the candidate list is a position:FIXED popover rendered through
// a React PORTAL to document.body, measured from the input's rect. It is NOT an
// absolutely positioned child, and that is load-bearing: `Modal`'s .body is a
// scroll container (`overflow: auto`), and a scroll container CLIPS absolutely
// positioned descendants. Seven modals render this field - create relay group,
// email triage, unit create, placement create, schedule tour, and the
// relationships editor inside both contact forms - and in every one of them the
// list was cropped to whatever space happened to remain below the input.
// StageMenu hit the identical trap on the placements ledger and solved it this
// way; this is that pattern, not a new one.
// Fixed coordinates go stale on scroll/resize, so either DISMISSES the list
// rather than chasing it (scrolls inside the list itself are ignored - it
// scrolls internally when long). Outside-click has to check BOTH refs, since
// the list is no longer inside the field's own subtree.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Contact } from '../../api/index.js';
import { CONTACT_TYPE_LABEL, displayKind } from './contactProfile.js';
import { contactDisplayName } from './format.js';
import styles from './ContactSearchField.module.css';

const MAX_SHOWN = 8;

export interface ContactSearchValue {
  name: string;
  contactId?: string;
}

export interface ContactSearchFieldProps {
  value: ContactSearchValue;
  onChange: (v: ContactSearchValue) => void;
  candidates: Contact[];
  /** Accessible label for the underlying text input. */
  inputLabel?: string;
  /** Freeze the field while the CALLER is mid-flight: the input is disabled and
   *  the candidate list never renders, so no pick can land on a list the caller
   *  has already snapshotted. Defaults to false - every existing call site is
   *  unaffected. */
  disabled?: boolean;
}

/** Filter candidates whose display name or primary phone contains the query
 *  (case-insensitive). Caps results at MAX_SHOWN. */
function filterCandidates(candidates: Contact[], query: string): Contact[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const results: Contact[] = [];
  for (const c of candidates) {
    if (results.length >= MAX_SHOWN) break;
    const phone = c.phones?.find((p) => p.primary)?.phone ?? c.phone;
    const displayName = contactDisplayName(c.firstName, c.lastName, phone);
    if (displayName.toLowerCase().includes(q) || (phone ?? '').toLowerCase().includes(q)) {
      results.push(c);
    }
  }
  return results;
}

export function ContactSearchField({
  value,
  onChange,
  candidates,
  inputLabel = 'Contact search',
  disabled = false,
}: ContactSearchFieldProps): React.JSX.Element {
  // Fix 3: keyboard navigation state
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  // Fix 4 (a11y): dismissed flag — Escape collapses the popup; typing clears it
  const [dismissed, setDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** Viewport coordinates for the portaled list, measured from the input. */
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: string } | null>(
    null,
  );

  // Fix 5: stable, instance-unique ids
  const uid = useId();
  const listboxId = `${uid}-listbox`;

  // Committed: a contact is linked. The picked display name always matches its
  // own candidate, so the list must be gated on this, not just on matches.
  const isSelected = value.contactId !== undefined;
  const matches = filterCandidates(candidates, value.name);
  // A disabled field shows NO list: a frozen input can still hold a query that
  // matches, and an option is clickable even when the input beside it is not.
  const isListShown = !disabled && !dismissed && !isSelected && matches.length > 0;

  // Measure while the list is shown. The input does not move as the user types,
  // so this only has to re-run when the list opens or its length changes; the
  // scroll/resize listeners below handle the cases where it WOULD move.
  // useLayoutEffect so the list never paints at a stale position.
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
      // Fit the remaining viewport, with a floor so a field near the bottom of
      // a short window still shows something worth reading.
      maxHeight: `max(9rem, min(${Math.round(window.innerHeight - top - 12)}px, 60vh))`,
    });
  }, [isListShown, matches.length]);

  // Fixed coordinates go stale the moment anything scrolls or resizes - dismiss
  // instead of chasing (StageMenu's ruling). Capture phase so a scroll in ANY
  // ancestor container counts, including a modal body; scrolls inside the list
  // itself are ignored, since it scrolls internally when long.
  useEffect(() => {
    if (!isListShown) return;
    const onScroll = (e: Event): void => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      setDismissed(true);
    };
    const onResize = (): void => setDismissed(true);
    // The list is portaled OUT of the field's subtree, so a click on an option
    // is "outside" the wrapper - both refs have to be consulted.
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
    // Free typing — always clear any prior contactId link; reset keyboard selection
    setActiveIndex(-1);
    setDismissed(false);
    onChange({ name: e.target.value });
  }

  function handlePick(candidate: Contact): void {
    const phone = candidate.phones?.find((p) => p.primary)?.phone ?? candidate.phone;
    const displayName = contactDisplayName(candidate.firstName, candidate.lastName, phone);
    setActiveIndex(-1);
    onChange({ name: displayName, contactId: candidate.contactId });
  }

  function handleClear(): void {
    setActiveIndex(-1);
    setDismissed(false);
    onChange({ name: '' });
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
        value={value.name}
        readOnly={isSelected}
        disabled={disabled}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        placeholder="Search contacts…"
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
          {matches.map((c, idx) => {
            const phone = c.phones?.find((p) => p.primary)?.phone ?? c.phone;
            const displayName = contactDisplayName(c.firstName, c.lastName, phone);
            const isActive = idx === activeIndex;
            return (
              <li
                key={c.contactId}
                id={`${uid}-option-${idx}`}
                className={styles.option}
                role="option"
                aria-selected={isActive}
                onMouseDown={(e) => {
                  // mousedown fires before blur; prevent the input losing focus
                  // before the click registers
                  e.preventDefault();
                }}
                onClick={() => handlePick(c)}
              >
                {displayName}
                {/* The kind trails the name because a first-name-only roster is
                    otherwise unpickable - several contacts read "Renee" and
                    nothing on the row says which one is the tenant. `displayKind`
                    prefers the contact's own ROLE ("Property Manager", "Case
                    worker") over the bare type label, so it is the most specific
                    true thing we hold. DISPLAY ONLY: it is a sibling node, never
                    folded into `displayName`, because handlePick commits that
                    string as `value.name` and RelationshipsEditor STORES it. */}
                <span className={styles.optionKind}>
                  {displayKind(c, (t) => CONTACT_TYPE_LABEL[t])}
                </span>
              </li>
            );
          })}
        </ul>,
          document.body,
        )}
    </div>
  );
}
