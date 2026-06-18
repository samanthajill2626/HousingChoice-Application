// ContactSearchField — a text input with a client-side filtered candidate list.
// Picking a candidate sets { name, contactId }; free typing clears contactId.
// Candidates are rendered as JSX text nodes — never dangerouslySetInnerHTML.
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
  const matches = filterCandidates(candidates, value.name);
  const showList = matches.length > 0;

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>): void {
    // Free typing — always clear any prior contactId link
    onChange({ name: e.target.value });
  }

  function handlePick(candidate: Contact): void {
    const phone = candidate.phones?.find((p) => p.primary)?.phone ?? candidate.phone;
    const displayName = contactDisplayName(candidate.firstName, candidate.lastName, phone);
    onChange({ name: displayName, contactId: candidate.contactId });
  }

  return (
    <div className={styles.wrapper}>
      <input
        className={styles.input}
        type="text"
        aria-label={inputLabel}
        value={value.name}
        onChange={handleInputChange}
        placeholder="Search contacts…"
        autoComplete="off"
      />
      {showList && (
        <ul className={styles.listbox} role="listbox">
          {matches.map((c) => {
            const phone = c.phones?.find((p) => p.primary)?.phone ?? c.phone;
            const displayName = contactDisplayName(c.firstName, c.lastName, phone);
            return (
              <li
                key={c.contactId}
                className={styles.option}
                role="option"
                aria-selected={value.contactId === c.contactId}
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
