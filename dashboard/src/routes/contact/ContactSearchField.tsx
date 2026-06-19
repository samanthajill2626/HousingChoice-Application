// ContactSearchField — a text input with a client-side filtered candidate list.
// Picking a candidate sets { name, contactId }; free typing clears contactId.
// Candidates are rendered as JSX text nodes — never dangerouslySetInnerHTML.
import { useId, useState } from 'react';
import { type Contact } from '../../api/index.js';
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
}: ContactSearchFieldProps): React.JSX.Element {
  // Fix 3: keyboard navigation state
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  // Fix 4 (a11y): dismissed flag — Escape collapses the popup; typing clears it
  const [dismissed, setDismissed] = useState(false);

  // Fix 5: stable, instance-unique ids
  const uid = useId();
  const listboxId = `${uid}-listbox`;

  const matches = filterCandidates(candidates, value.name);
  const isListShown = !dismissed && matches.length > 0;

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
        value={value.name}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        placeholder="Search contacts…"
        autoComplete="off"
      />
      {isListShown && (
        <ul
          id={listboxId}
          className={styles.listbox}
          role="listbox"
          aria-label={`${inputLabel} suggestions`}
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
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
