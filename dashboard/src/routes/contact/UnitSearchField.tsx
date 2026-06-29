// UnitSearchField — a text input with a client-side filtered candidate list.
// Picking a candidate sets { label, unitId }; free typing clears unitId.
// Candidates are rendered as JSX text nodes — never dangerouslySetInnerHTML.
import { useId, useState } from 'react';
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
 *  unitId when the address is empty (so an option is never blank). */
function unitLabel(u: UnitItem): string {
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

  // stable, instance-unique ids
  const uid = useId();
  const listboxId = `${uid}-listbox`;

  const matches = filterCandidates(candidates, value.label);
  const isListShown = !dismissed && matches.length > 0;

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
        className={styles.input}
        type="text"
        aria-label={inputLabel}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={isListShown}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        value={value.label}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        placeholder="Search properties…"
        autoComplete="off"
      />
      {isListShown && (
        <ul
          id={listboxId}
          className={styles.listbox}
          role="listbox"
          aria-label={`${inputLabel} suggestions`}
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
        </ul>
      )}
    </div>
  );
}
