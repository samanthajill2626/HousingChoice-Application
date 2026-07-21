// EmailTriage -- the /email side-door page (email-channel-v1 B6). Inbound email
// from UNKNOWN senders never becomes a contact/conversation on its own; it lands
// here to triage. Two URL-backed tabs (Unmatched | Quarantine) as Links with
// aria-current; each row expands to its body and carries per-status actions.
//
// Architecture: the data hook (useUnmatchedEmail) owns the list + optimistic
// mutations; the ROWS are presentational (UnmatchedRow); this page owns the
// contact roster (for the link typeahead), navigation, and the MODALS -- hosted
// at page level so an optimistic row removal can't unmount an open dialog.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, type Contact } from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import { ContactSearchField, type ContactSearchValue } from '../contact/ContactSearchField.js';
import { useContacts } from '../contacts/useContacts.js';
import { UnmatchedRow } from './UnmatchedRow.js';
import { useUnmatchedEmail, type NewContactInput, type UnmatchedFilter } from './useUnmatchedEmail.js';
import styles from './EmailTriage.module.css';

const TYPE_LABEL: Record<NewContactInput['type'], string> = {
  tenant: 'Tenant',
  landlord: 'Landlord',
  partner: 'Partner',
};

/** Pull a readable name out of a 409 email_in_use body ({ contact }); null when
 *  absent (defensive read -- never imports the Contact shape here). */
function conflictName(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const c = (body as { contact?: unknown }).contact;
  if (c === null || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  const first = typeof o['firstName'] === 'string' ? o['firstName'] : '';
  const last = typeof o['lastName'] === 'string' ? o['lastName'] : '';
  const name = [first, last].filter(Boolean).join(' ').trim();
  if (name.length > 0) return name;
  const email = typeof o['email'] === 'string' ? o['email'] : '';
  return email.length > 0 ? email : null;
}

/** Map the B3 route refusals to friendly copy (shared by the modals + the page
 *  banner). Falls back to a generic message. */
function friendlyActionError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'email_in_use') {
      const who = conflictName(err.body);
      return who !== null
        ? `That email address already belongs to ${who}.`
        : 'That email address already belongs to another contact.';
    }
    switch (err.code) {
      case 'virus_flagged':
        return "This message is virus-flagged and can't be linked.";
      case 'already_threaded':
        return 'This message is already in that conversation.';
      case 'not_quarantined':
        return 'This message is no longer in quarantine.';
      case 'email_ingest_unavailable':
        return "Email isn't fully configured yet, so this can't be linked.";
      case 'no_sender_address':
        return 'This message has no readable sender address to link.';
      case 'contact_not_found':
        return 'That contact no longer exists.';
      case 'unmatched_not_found':
        return 'This message is no longer available.';
      default:
        break;
    }
  }
  return 'Something went wrong. Please try again.';
}

/** The Link-to-contact modal: the committed-state contact typeahead + a Link
 *  action. Self-contained state; `onLink` navigates on success or throws. */
function LinkContactModal({
  contacts,
  onCancel,
  onLink,
}: {
  contacts: Contact[];
  onCancel: () => void;
  onLink: (contactId: string) => Promise<void>;
}): React.JSX.Element {
  const [value, setValue] = useState<ContactSearchValue>({ name: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const contactId = value.contactId;

  async function submit(): Promise<void> {
    if (contactId === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await onLink(contactId); // navigates away on success
    } catch (err) {
      setError(friendlyActionError(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Link to contact"
      onClose={() => {
        if (!busy) onCancel();
      }}
      footer={
        <>
          <button type="button" className={styles.btnSecondary} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={() => void submit()}
            disabled={contactId === undefined || busy}
          >
            {busy ? 'Linking...' : 'Link'}
          </button>
        </>
      }
    >
      <p className={styles.modalHint}>
        Add this sender&apos;s address to a contact and move the message into their conversation.
      </p>
      <ContactSearchField
        value={value}
        onChange={(v) => {
          setValue(v);
          setError(null);
        }}
        candidates={contacts}
        inputLabel="Search contacts"
      />
      {error !== null ? (
        <p role="alert" className={styles.modalError}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/** The New-contact modal: a name + a 3-segment type control [Tenant|Landlord|
 *  Partner], then create + link. `onCreate` navigates on success or throws. */
function NewContactModal({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: NewContactInput) => Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [type, setType] = useState<NewContactInput['type']>('tenant');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canCreate = name.trim().length > 0 && !busy;

  async function submit(): Promise<void> {
    if (name.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), type }); // navigates away on success
    } catch (err) {
      setError(friendlyActionError(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New contact"
      onClose={() => {
        if (!busy) onCancel();
      }}
      footer={
        <>
          <button type="button" className={styles.btnSecondary} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={() => void submit()}
            disabled={!canCreate}
          >
            {busy ? 'Creating...' : 'Create contact'}
          </button>
        </>
      }
    >
      <p className={styles.modalHint}>
        Create a contact from this sender, then move the message into their conversation.
      </p>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Name</span>
        <input
          className={styles.input}
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          autoComplete="off"
        />
      </label>
      <div className={styles.field} role="group" aria-label="Contact type">
        <span className={styles.fieldLabel}>Type</span>
        <div className={styles.segmented}>
          {(['tenant', 'landlord', 'partner'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`${styles.segment} ${type === t ? styles.segmentActive : ''}`}
              aria-pressed={type === t}
              onClick={() => setType(t)}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </div>
      {error !== null ? (
        <p role="alert" className={styles.modalError}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

export function EmailTriage({ tab = 'unmatched' }: { tab?: UnmatchedFilter }): React.JSX.Element {
  const filter = tab;
  const unmatched = useUnmatchedEmail(filter);
  const { contacts } = useContacts('all');
  const navigate = useNavigate();

  // Page-level modal/confirm targets (hosted here so a row removal can't unmount
  // an open dialog).
  const [action, setAction] = useState<{ id: string; kind: 'link' | 'new' } | null>(null);
  const [spamId, setSpamId] = useState<string | null>(null);
  const [spamBusy, setSpamBusy] = useState(false);
  const [spamError, setSpamError] = useState<string | null>(null);
  // Errors from the direct (no-modal) actions surface in a dismissible banner,
  // since the row itself is optimistically removed while the request is in flight.
  const [pageError, setPageError] = useState<string | null>(null);

  const linkTarget = action?.kind === 'link' ? action : null;
  const newTarget = action?.kind === 'new' ? action : null;

  function runDirect(fn: () => Promise<void>): void {
    setPageError(null);
    void fn().catch((err: unknown) => setPageError(friendlyActionError(err)));
  }

  async function confirmSpam(): Promise<void> {
    if (spamId === null) return;
    setSpamBusy(true);
    setSpamError(null);
    try {
      await unmatched.spam(spamId);
      setSpamId(null);
    } catch (err) {
      setSpamError(friendlyActionError(err));
    } finally {
      setSpamBusy(false);
    }
  }

  const empty =
    filter === 'quarantine'
      ? {
          title: 'Quarantine is empty',
          body: 'Suspected-spam and virus-flagged mail from unknown senders lands here.',
        }
      : {
          title: 'No unmatched email',
          body: 'Email from senders who are not yet contacts shows up here to triage.',
        };

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Email</h1>
      <p className={styles.sub}>
        Triage inbound email from unknown senders - link it to a contact, or clear it out.
      </p>

      <div className={styles.tabs}>
        <Link
          to="/email"
          className={`${styles.tab} ${filter === 'unmatched' ? styles.tabActive : ''}`}
          aria-current={filter === 'unmatched' ? 'page' : undefined}
        >
          Unmatched
        </Link>
        <Link
          to="/email/quarantine"
          className={`${styles.tab} ${filter === 'quarantine' ? styles.tabActive : ''}`}
          aria-current={filter === 'quarantine' ? 'page' : undefined}
        >
          Quarantine
        </Link>
      </div>

      {pageError !== null ? (
        <div className={styles.error} role="alert">
          <p>{pageError}</p>
          {/* "Dismiss error" (NOT "Dismiss") so this never collides with the row's
              literal "Dismiss" action button under a role+name selector. */}
          <button type="button" className={styles.retry} onClick={() => setPageError(null)}>
            Dismiss error
          </button>
        </div>
      ) : null}

      {unmatched.status === 'loading' ? <Spinner center /> : null}

      {unmatched.status === 'error' ? (
        <div className={styles.error} role="alert">
          <p>We couldn&apos;t load this list.</p>
          <button type="button" className={styles.retry} onClick={() => unmatched.retry()}>
            Retry
          </button>
        </div>
      ) : null}

      {unmatched.status === 'pending' ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Email triage turns on with its backend</p>
          <p className={styles.emptyBody}>This view is wired and will fill in once inbound email ships.</p>
        </div>
      ) : null}

      {unmatched.status === 'ready' && unmatched.rows.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{empty.title}</p>
          <p className={styles.emptyBody}>{empty.body}</p>
        </div>
      ) : null}

      {unmatched.status === 'ready' && unmatched.rows.length > 0 ? (
        <>
          <ul
            className={styles.rows}
            aria-label={filter === 'quarantine' ? 'Quarantined email' : 'Unmatched email'}
          >
            {unmatched.rows.map((row) => (
              <UnmatchedRow
                key={row.unmatchedId}
                row={row}
                filter={filter}
                onMarkRead={unmatched.markRead}
                onLink={(id) => setAction({ id, kind: 'link' })}
                onNewContact={(id) => setAction({ id, kind: 'new' })}
                onSpam={(id) => {
                  setSpamError(null);
                  setSpamId(id);
                }}
                onDismiss={(id) => runDirect(() => unmatched.dismiss(id))}
                onRelease={(id) => runDirect(() => unmatched.release(id))}
                onDelete={(id) => runDirect(() => unmatched.dismiss(id))}
              />
            ))}
          </ul>
          {unmatched.hasMore ? (
            <button
              type="button"
              className={styles.loadMore}
              onClick={() => unmatched.loadMore()}
              disabled={unmatched.loadingMore}
            >
              {unmatched.loadingMore ? 'Loading...' : 'Load more'}
            </button>
          ) : null}
        </>
      ) : null}

      {linkTarget !== null ? (
        <LinkContactModal
          contacts={contacts}
          onCancel={() => setAction(null)}
          onLink={async (contactId) => {
            await unmatched.link(linkTarget.id, contactId);
            navigate(`/contacts/${contactId}`);
          }}
        />
      ) : null}

      {newTarget !== null ? (
        <NewContactModal
          onCancel={() => setAction(null)}
          onCreate={async (input) => {
            const res = await unmatched.createContact(newTarget.id, input);
            navigate(`/contacts/${res.contactId}`);
          }}
        />
      ) : null}

      {spamId !== null ? (
        <Modal
          title="Report as spam?"
          onClose={() => {
            if (!spamBusy) setSpamId(null);
          }}
          footer={
            <>
              <button
                type="button"
                className={styles.btnSecondary}
                onClick={() => setSpamId(null)}
                disabled={spamBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.btnDanger}
                onClick={() => void confirmSpam()}
                disabled={spamBusy}
              >
                {spamBusy ? 'Reporting...' : 'Report spam'}
              </button>
            </>
          }
        >
          <p className={styles.modalHint}>
            This blocks the sender&apos;s address and removes the message. Future mail from them is
            dropped before it reaches this list.
          </p>
          {spamError !== null ? (
            <p role="alert" className={styles.modalError}>
              {spamError}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
