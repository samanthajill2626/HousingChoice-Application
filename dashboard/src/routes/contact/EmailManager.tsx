// EmailManager - the "Manage email" dialog (email-channel v1, A6). The exact
// analog of PhoneManager: lists the contact's addresses (one marked Primary) and
// lets a navigator add an address, promote one to primary, or remove a
// non-primary address. Every mutation hits an email CRUD endpoint that RETURNS
// the updated contact, which the parent applies in place. The primary address is
// the default email send target, so "make primary" also changes which address we
// email by default.
import { useState } from 'react';
import {
  addContactEmail,
  removeContactEmail,
  updateContactEmail,
  ApiError,
  type Contact,
  type ContactEmail,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from './Modal.js';
import { isValidEmail, normalizeEmail } from './contactEmails.js';
import styles from './EmailManager.module.css';

const EMAIL_ERROR = 'Enter a valid email address, like name@example.com';

export interface EmailManagerProps {
  contact: Contact;
  emails: ContactEmail[];
  onClose: () => void;
  onChanged: (updated: Contact) => void;
}

function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'email_in_use') return 'That address already belongs to another contact.';
    if (err.code === 'cannot_remove_primary')
      return 'Make another address primary before removing this one.';
    if (err.status === 400) return 'That does not look like a valid email address.';
  }
  return 'Something went wrong - please try again.';
}

export function EmailManager({
  contact,
  emails,
  onClose,
  onChanged,
}: EmailManagerProps): React.JSX.Element {
  const [newEmail, setNewEmail] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
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

  function onNewEmailBlur(): void {
    const raw = newEmail.trim();
    if (raw === '') {
      setEmailError(null);
      return;
    }
    if (isValidEmail(raw)) {
      setNewEmail(normalizeEmail(raw));
      setEmailError(null);
    } else {
      setEmailError(EMAIL_ERROR);
    }
  }

  async function onAdd(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const raw = newEmail.trim();
    if (raw === '') return;
    if (!isValidEmail(raw)) {
      setEmailError(EMAIL_ERROR);
      return;
    }
    setEmailError(null);
    await run(async () => {
      const updated = await addContactEmail(
        contact.contactId,
        normalizeEmail(raw),
        newLabel.trim() || undefined,
      );
      setNewEmail('');
      setNewLabel('');
      return updated;
    });
  }

  return (
    <Modal
      title="Manage email"
      onClose={onClose}
      footer={
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
          Done
        </Button>
      }
    >
      <ul className={styles.list}>
        {emails.length === 0 ? <li className={styles.empty}>No email addresses yet.</li> : null}
        {emails.map((em) => (
          <li key={em.email} className={styles.row}>
            <div className={styles.addrCol}>
              <span className={styles.addr}>{em.email}</span>
              <span className={styles.meta}>
                {em.primary ? <span className={styles.primaryBadge}>Primary</span> : null}
                {em.label ? <span className={styles.label}>{em.label}</span> : null}
              </span>
            </div>
            <div className={styles.actions}>
              {!em.primary ? (
                <button
                  type="button"
                  className={styles.linkBtn}
                  disabled={busy}
                  onClick={() =>
                    void run(() => updateContactEmail(contact.contactId, em.email, { primary: true }))
                  }
                >
                  Make primary
                </button>
              ) : null}
              {!em.primary ? (
                <button
                  type="button"
                  className={`${styles.linkBtn} ${styles.danger}`}
                  disabled={busy}
                  onClick={() => void run(() => removeContactEmail(contact.contactId, em.email))}
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
            type="email"
            value={newEmail}
            onChange={(e) => {
              setNewEmail(e.target.value);
              setEmailError(null);
            }}
            onBlur={onNewEmailBlur}
            placeholder="name@example.com"
            aria-label="New email address"
          />
          <input
            className={`${styles.input} ${styles.labelInput}`}
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Label (optional)"
            aria-label="Label for the new address"
          />
          <Button variant="secondary" size="sm" type="submit" disabled={busy || newEmail.trim() === ''}>
            Add
          </Button>
        </div>
      </form>

      {emailError !== null ? (
        <p role="alert" className={styles.error}>
          {emailError}
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
