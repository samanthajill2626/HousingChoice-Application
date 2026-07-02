// PhoneManager — the "Manage numbers" dialog. Lists the contact's numbers (one
// marked Primary) and lets a navigator add a number, relabel/promote one to
// primary, or remove a non-primary number. Every mutation hits a C1 phones
// endpoint that RETURNS the updated contact, which the parent applies in place.
// The primary number is the default reply/call target, so "make primary" is also
// how you change which number we text by default.
import { useState } from 'react';
import {
  addContactPhone,
  removeContactPhone,
  updateContactPhone,
  ApiError,
  type Contact,
  type ContactPhone,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from './Modal.js';
import { formatPhone } from './format.js';
import { normalizeToE164, formatPhoneDisplay } from '../../lib/phone.js';
import styles from './PhoneManager.module.css';

const PHONE_ERROR = 'Enter a 10-digit US number, or a full international number starting with +';

export interface PhoneManagerProps {
  contact: Contact;
  phones: ContactPhone[];
  onClose: () => void;
  onChanged: (updated: Contact) => void;
}

function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'phone_in_use') return 'That number already belongs to another contact.';
    if (err.code === 'cannot_remove_primary') return 'Make another number primary before removing this one.';
    if (err.status === 400) return 'That doesn’t look like a valid phone number.';
  }
  return 'Something went wrong — please try again.';
}

export function PhoneManager({ contact, phones, onClose, onChanged }: PhoneManagerProps): React.JSX.Element {
  const [newPhone, setNewPhone] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Run a mutation with shared busy/error handling; apply the returned contact.
  async function run(fn: () => Promise<Contact>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onChanged(await fn());
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  function onNewPhoneBlur(): void {
    const raw = newPhone.trim();
    if (raw === '') { setPhoneError(null); return; }
    const e164 = normalizeToE164(raw);
    if (e164) {
      setNewPhone(formatPhoneDisplay(e164));
      setPhoneError(null);
    } else {
      setPhoneError(PHONE_ERROR);
    }
  }

  async function onAdd(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const raw = newPhone.trim();
    if (raw === '') return;
    const e164 = normalizeToE164(raw);
    if (!e164) {
      setPhoneError(PHONE_ERROR);
      return;
    }
    setPhoneError(null);
    await run(async () => {
      const updated = await addContactPhone(contact.contactId, e164, newLabel.trim() || undefined);
      setNewPhone('');
      setNewLabel('');
      return updated;
    });
  }

  return (
    <Modal
      title="Manage numbers"
      onClose={onClose}
      footer={
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
          Done
        </Button>
      }
    >
      <ul className={styles.list}>
        {phones.length === 0 ? <li className={styles.empty}>No numbers yet.</li> : null}
        {phones.map((p) => (
          <li key={p.phone} className={styles.row}>
            <div className={styles.numCol}>
              <span className={styles.num}>{formatPhone(p.phone)}</span>
              <span className={styles.meta}>
                {p.primary ? <span className={styles.primaryBadge}>Primary</span> : null}
                {p.label ? <span className={styles.label}>{p.label}</span> : null}
              </span>
            </div>
            <div className={styles.actions}>
              {!p.primary ? (
                <button
                  type="button"
                  className={styles.linkBtn}
                  disabled={busy}
                  onClick={() =>
                    void run(() => updateContactPhone(contact.contactId, p.phone, { primary: true }))
                  }
                >
                  Make primary
                </button>
              ) : null}
              {!p.primary ? (
                <button
                  type="button"
                  className={`${styles.linkBtn} ${styles.danger}`}
                  disabled={busy}
                  onClick={() => void run(() => removeContactPhone(contact.contactId, p.phone))}
                >
                  Remove
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <form className={styles.addForm} onSubmit={(e) => void onAdd(e)}>
        <div className={styles.addRow}>
          <input
            className={styles.input}
            type="tel"
            value={newPhone}
            onChange={(e) => { setNewPhone(e.target.value); setPhoneError(null); }}
            onBlur={onNewPhoneBlur}
            placeholder="(404) 555-0123"
            aria-label="New phone number"
          />
          <input
            className={`${styles.input} ${styles.labelInput}`}
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Label (optional)"
            aria-label="Label for the new number"
          />
          <Button variant="secondary" size="sm" type="submit" disabled={busy || newPhone.trim() === ''}>
            Add
          </Button>
        </div>
      </form>

      {phoneError !== null ? (
        <p role="alert" className={styles.error}>
          {phoneError}
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
