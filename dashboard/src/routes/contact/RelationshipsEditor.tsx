// RelationshipsEditor — controlled editor for a list of relationship rows.
// Each row has a role input (with datalist suggestions) + a ContactSearchField
// (bound to name/contactId) + a Remove button. All mutations go via onChange —
// no local state for the rows.
import { useId, useRef } from 'react';
import { type Contact, type Relationship } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { ContactSearchField } from './ContactSearchField.js';
import styles from './RelationshipsEditor.module.css';

export interface RelationshipsEditorProps {
  rows: Relationship[];
  onChange: (rows: Relationship[]) => void;
  candidates: Contact[];
  roleSuggestions?: string[];
}

export function RelationshipsEditor({
  rows,
  onChange,
  candidates,
  roleSuggestions,
}: RelationshipsEditorProps): React.JSX.Element {
  // Fix 5: instance-unique id for the datalist (no module-level constant)
  const uid = useId();
  const datalistId = `${uid}-role-suggestions`;

  // Fix 2: stable per-row ids so removing a middle row does not bleed
  // ContactSearchField internal state (activeIndex / dropdown query) into the
  // wrong row. We maintain a parallel id list in lockstep with `rows`.
  const idsRef = useRef<number[]>([]);
  const nextId = useRef(0);
  // Reconcile length at render time (append-only — parent-driven growth or
  // initial population). Mutating the ref during render is safe here; it causes
  // no secondary renders and is the canonical pattern for "derived from props"
  // refs that must be ready before the JSX below.
  while (idsRef.current.length < rows.length) {
    idsRef.current.push(nextId.current++);
  }
  if (idsRef.current.length > rows.length) {
    idsRef.current = idsRef.current.slice(0, rows.length);
  }

  const suggestions = roleSuggestions ?? [];

  function onRoleChange(index: number, newRole: string): void {
    const updated = rows.map((row, i) => (i === index ? { ...row, role: newRole } : row));
    onChange(updated);
  }

  function onContactChange(
    index: number,
    newValue: { name: string; contactId?: string },
  ): void {
    // Fix 4: omit contactId entirely when the user has not linked a contact
    // (free-typed name). Spread the existing row (which may have a contactId from
    // a prior pick), then overwrite name, and conditionally add contactId so
    // any previously-set key is removed when the new value has none.
    const updated = rows.map((row, i) => {
      if (i !== index) return row;
      // Build a fresh object without contactId, then conditionally add it back.
      // Omitting contactId entirely (not setting it to undefined) is important
      // so the key is absent on unlinked rows.
      const base: Relationship = { role: row.role, name: newValue.name };
      if (newValue.contactId) {
        base.contactId = newValue.contactId;
      }
      return base;
    });
    onChange(updated);
  }

  function onRemove(index: number): void {
    // Remove the stable id at the same position, keeping ids aligned with rows.
    idsRef.current = idsRef.current.filter((_, i) => i !== index);
    onChange(rows.filter((_, i) => i !== index));
  }

  function onAdd(): void {
    // Append a new stable id in lockstep with the new row.
    idsRef.current = [...idsRef.current, nextId.current++];
    onChange([...rows, { role: '', name: '' }]);
  }

  return (
    <div className={styles.editor}>
      {suggestions.length > 0 && (
        <datalist id={datalistId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}

      {rows.length > 0 && (
        <ul className={styles.list}>
          {rows.map((row, i) => {
            const n = i + 1;
            return (
              <li key={idsRef.current[i] ?? i} className={styles.row}>
                <input
                  className={styles.roleInput}
                  type="text"
                  value={row.role}
                  onChange={(e) => onRoleChange(i, e.target.value)}
                  placeholder="Role"
                  aria-label={`Relationship role ${n}`}
                  list={suggestions.length > 0 ? datalistId : undefined}
                />
                <ContactSearchField
                  value={{ name: row.name, contactId: row.contactId }}
                  onChange={(v) => onContactChange(i, v)}
                  candidates={candidates}
                  inputLabel={`Contact search ${n}`}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  aria-label={`Remove relationship ${n}`}
                  onClick={() => onRemove(i)}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <Button variant="secondary" size="sm" type="button" onClick={onAdd}>
        + Add relationship
      </Button>
    </div>
  );
}
