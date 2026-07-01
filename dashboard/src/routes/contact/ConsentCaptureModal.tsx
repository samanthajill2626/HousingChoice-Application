// ConsentCaptureModal — the just-in-time HARD-BLOCK modal (§3.4). It opens when a
// proactive 1:1 send to a contact with NO consent_method is refused by the server
// (409 { error: 'contact_no_consent' }). It captures a HUMAN consent method +
// when (default today) + an optional note, PATCHes the contact's consent
// (CONTRACT 2), and — on success — signals the caller to RETRY the original send.
// Cancel aborts the send (the message stays in the reply box; the caller restores
// it). Accessible: it reuses the route's focus-trapping Modal (role=dialog,
// aria-modal, Esc/backdrop close) with labelled controls; a method MUST be chosen
// before Confirm enables.
import { useState } from 'react';
import { updateContact, ApiError, type Contact } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from './Modal.js';
import { ConsentFields, type ConsentValue } from './ConsentFields.js';
import { consentAtFromDate, todayISODate } from '../../lib/consentCopy.js';

export interface ConsentCaptureModalProps {
  contactId: string;
  /** The contact's display name (shown in the modal copy). */
  contactName: string;
  /** Cancel — aborts the send. The caller keeps the drafted message. */
  onCancel: () => void;
  /** Consent recorded (PATCH succeeded) → the caller retries the original send.
   *  Receives the updated contact so the page can apply it in place. */
  onRecorded: (updated: Contact) => void;
}

export function ConsentCaptureModal({
  contactId,
  contactName,
  onCancel,
  onRecorded,
}: ConsentCaptureModalProps): React.JSX.Element {
  const [consent, setConsent] = useState<ConsentValue>({
    method: '',
    when: todayISODate(),
    note: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canConfirm = consent.method !== '' && !busy;

  async function onConfirm(): Promise<void> {
    if (consent.method === '' || busy) return;
    setBusy(true);
    setError(null);
    const note = consent.note.trim();
    try {
      // CONTRACT 2: PATCH /api/contacts/:id with the human consent fields; the
      // server stamps consent_captured_by. On success the caller retries the send.
      const updated = await updateContact(contactId, {
        consent_method: consent.method,
        consent_at: consentAtFromDate(consent.when),
        ...(note ? { consent_note: note } : {}),
      });
      onRecorded(updated);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? "Couldn't record consent — please try again."
          : "Couldn't record consent — please try again.",
      );
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Record consent before texting"
      onClose={() => {
        if (!busy) onCancel();
      }}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={() => void onConfirm()}
            disabled={!canConfirm}
          >
            {busy ? 'Recording…' : 'Record consent & send'}
          </Button>
        </>
      }
    >
      <p>
        <strong>{contactName}</strong> hasn&apos;t opted in to texts yet. Record how they
        consented, then we&apos;ll send your message.
      </p>
      <ConsentFields
        value={consent}
        onChange={setConsent}
        idPrefix="jit"
        disabled={busy}
        methodRequired
      />
      {error !== null ? (
        <p role="alert" style={{ color: 'var(--c-danger)' }}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
