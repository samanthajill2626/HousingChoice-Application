// AdHocDialog — a small accessible modal for minting an ad-hoc party. role=
// "dialog", labelled by its title, Escape + a close button both dismiss, and the
// submit collects label + role (+ optional E.164 number) into an AddAdHocInput.
// A server-side validation error is surfaced inline via role="alert". Pure
// presentational: the parent owns open/closed and the async submit.
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './Button.js';
import type { AddAdHocInput, Role } from '../api/types.js';
import styles from './AdHocDialog.module.css';

export interface AdHocDialogProps {
  onSubmit: (input: AddAdHocInput) => void;
  onClose: () => void;
  /** Server validation error to surface inline. */
  error?: string;
}

const ROLES: ReadonlyArray<{ value: Role; label: string }> = [
  { value: 'landlord', label: 'Landlord' },
  { value: 'tenant', label: 'Tenant' },
  { value: 'pm', label: 'PM' },
  { value: 'staff', label: 'Staff' },
];

export function AdHocDialog({ onSubmit, onClose, error }: AdHocDialogProps): React.JSX.Element {
  const titleId = useId();
  const [label, setLabel] = useState('');
  const [role, setRole] = useState<Role>('landlord');
  const [number, setNumber] = useState('');
  const labelRef = useRef<HTMLInputElement>(null);

  // Focus the first field on open + close on Escape (accessible dialog basics).
  useEffect(() => {
    labelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const trimmedNumber = number.trim();
    onSubmit({
      label: label.trim(),
      role,
      ...(trimmedNumber !== '' && { number: trimmedNumber }),
    });
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.dialog}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            Add ad-hoc number
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Label</span>
            <input
              ref={labelRef}
              className={styles.input}
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
            />
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Role</span>
            <select
              className={styles.input}
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Number (optional)</span>
            <input
              className={styles.input}
              type="text"
              inputMode="tel"
              placeholder="+1555…"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
            />
          </label>

          {error !== undefined && error !== '' && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}

          <div className={styles.actions}>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Add
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
