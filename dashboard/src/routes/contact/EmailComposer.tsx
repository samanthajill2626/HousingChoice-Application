// EmailComposer - the contact page's email composer (email-channel v1, A6). A
// SEPARATE component from the SMS reply box (Timeline's composer) because email
// needs its own fields (To/Cc/Subject), a wider attachment allowlist, and the
// 25 MB email cap (NOT the carrier-tight MMS caps). Rendered by Timeline when the
// [Text | Email] channel toggle is on Email. Message body renders/sends as PLAIN
// TEXT (no HTML) - outbound email is plain text (inbound HTML is B7).
//
// Optimistic send: the PARENT (ContactDetail.onSendEmail) shows the "Sending..."
// EmailCard and owns the conversation resolution; this component just composes,
// uploads attachments, and calls onSend, mapping the A5 refusal codes to copy.
import { useMemo, useRef, useState } from 'react';
import {
  ApiError,
  confirmEmailMedia,
  presignEmailMedia,
  uploadToPresignedPost,
  type ContactEmail,
} from '../../api/index.js';
import { defaultEmail, isValidEmail, normalizeEmail } from './contactEmails.js';
import { useAutoGrowTextarea } from './useAutoGrowTextarea.js';
import styles from './EmailComposer.module.css';

// Email attachment limits - MIRROR the server (mediaTypes.ts EMAIL_ATTACHMENT_TYPES
// + EMAIL_MAX_TOTAL_BYTES). A file the server would reject never uploads; the
// server re-validates on confirm (stored VERBATIM - no transcode).
const EMAIL_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const EMAIL_ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
];
// The picker accept string: extensions AND MIME ids (some browsers report an
// empty file.type for docx/xlsx, so the extension hints the native picker).
const EMAIL_ACCEPT =
  '.jpg,.jpeg,.png,.gif,.webp,.pdf,.txt,.csv,.docx,.xlsx,' + EMAIL_ALLOWED_TYPES.join(',');

interface EmailAttachment {
  localId: string;
  name: string;
  size: number;
  contentType: string;
  status: 'uploading' | 'done' | 'error';
  key?: string;
  error?: string;
  previewUrl?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Client pre-check for a picked file. Returns a reason string to reject, else null. */
function attachmentReject(file: File, existing: EmailAttachment[]): string | null {
  if (!EMAIL_ALLOWED_TYPES.includes(file.type)) {
    return `${file.name}: unsupported file type. Attach an image, PDF, text, CSV, DOCX, or XLSX.`;
  }
  const total = existing.reduce((n, a) => n + a.size, 0) + file.size;
  if (total > EMAIL_MAX_TOTAL_BYTES) {
    return 'Attachments exceed the 25 MB total limit. Remove one and try again.';
  }
  return null;
}

/** An upload failure -> a short chip message (email-media presign/confirm codes). */
function uploadFailureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'unsupported_media_type' || err.status === 415) return 'Unsupported file type.';
    if (err.code === 'too_large' || err.status === 413) return 'Too large (max 25 MB total).';
    if (err.code === 'invalid_size') return 'That file looks empty.';
    if (err.code === 'media_storage_unavailable' || err.status === 503)
      return 'Storage is unavailable - try again shortly.';
    if (err.code === 'unknown_attachment' || err.code === 'invalid_attachment_key')
      return 'Upload could not be verified - remove and retry.';
    if (err.code === 'rate_limited') return 'Uploading too fast - wait a moment.';
  }
  return 'Upload failed - remove and try again.';
}

/** A send refusal -> a clear reason. Maps the A5 route codes (409/400/404) + a
 *  500 (the adapter send failed AFTER the message persisted as failed). */
function sendFailureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'email_sending_disabled':
        return 'Email sending is turned off right now.';
      case 'email_suppressed':
        return 'This contact is not receiving email - they opted out or a message bounced.';
      case 'email_attachments_too_large':
        return 'Attachments exceed the 25 MB total limit. Remove one and try again.';
      case 'contact_email_missing':
        return 'Pick an email address that is on this contact.';
      case 'invalid_cc':
        return 'One of the Cc addresses is not a valid email.';
      case 'invalid_attachment':
        return 'An attachment could not be verified. Remove it and try again.';
      case 'conversation_not_found':
        return 'This conversation cannot receive email.';
      case 'conversation_contact_mismatch':
        return 'This conversation does not belong to this contact.';
      // Backstop: the ensure-conversation step failed before the send could run.
      case 'contact_has_no_email':
        return 'Add an email address for this contact first.';
      case 'contact_has_no_phone':
        return 'Add an email address for this contact first.';
    }
    if (err.status === 500) return 'The email could not be sent - see the failed message above.';
  }
  return "Couldn't send - please try again.";
}

export interface EmailComposerSendInput {
  to: string;
  cc: string[];
  subject: string;
  body: string;
  /** Uploaded attachments: the durable email-media key + the original filename
   *  (carried so the outbound MIME part and the timeline gallery show the real
   *  document name, not a synthesized one). */
  attachments: { key: string; filename: string }[];
}

export interface EmailComposerProps {
  /** The contact's addresses (the To select). Rendered only when non-empty. */
  emails: ContactEmail[];
  /** Compose + send. Resolves on the 202; rejects (ApiError) on refusal. The
   *  parent owns the optimistic bubble + which conversation to send into. */
  onSend: (input: EmailComposerSendInput) => Promise<void>;
  /** Contact is suppressed for email (email_opt_out / email_unreachable) - show a
   *  standing note; the send is also refused server-side. */
  suppressed?: boolean;
}

export function EmailComposer({ emails, onSend, suppressed }: EmailComposerProps): React.JSX.Element {
  const defaultTo = useMemo(() => defaultEmail(emails)?.email ?? emails[0]?.email ?? '', [emails]);
  const [to, setTo] = useState(defaultTo);
  const [cc, setCc] = useState<string[]>([]);
  const [ccDraft, setCcDraft] = useState('');
  const [ccError, setCcError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const bodyRef = useAutoGrowTextarea(body);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachSeqRef = useRef(0);

  const doneAttachments = attachments.filter((a) => a.status === 'done' && a.key !== undefined);
  const uploadedAttachments = doneAttachments.map((a) => ({ key: a.key as string, filename: a.name }));
  const totalBytes = doneAttachments.reduce((n, a) => n + a.size, 0);
  const overCap = totalBytes > EMAIL_MAX_TOTAL_BYTES;
  const hasUploading = attachments.some((a) => a.status === 'uploading');
  const hasErrored = attachments.some((a) => a.status === 'error');

  const canSend =
    to !== '' &&
    subject.trim().length > 0 &&
    body.trim().length > 0 &&
    !sending &&
    !hasUploading &&
    !hasErrored &&
    !overCap;

  const uploadOne = async (localId: string, file: File): Promise<void> => {
    try {
      const { key, post } = await presignEmailMedia(file.type, file.size);
      await uploadToPresignedPost(post, file);
      const att = await confirmEmailMedia(key);
      setAttachments((prev) =>
        prev.map((a) =>
          a.localId === localId
            ? { ...a, status: 'done', key: att.s3Key, contentType: att.contentType, size: att.size }
            : a,
        ),
      );
    } catch (err) {
      setAttachments((prev) =>
        prev.map((a) =>
          a.localId === localId ? { ...a, status: 'error', error: uploadFailureMessage(err) } : a,
        ),
      );
    }
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow re-picking the same file after a remove
    if (files.length === 0) return;
    const combined = [...attachments];
    const accepted: { entry: EmailAttachment; file: File }[] = [];
    let reject: string | null = null;
    for (const file of files) {
      const why = attachmentReject(file, combined);
      if (why !== null) {
        reject = why;
        continue;
      }
      const localId = `eatt:${(attachSeqRef.current += 1)}`;
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      const entry: EmailAttachment = {
        localId,
        name: file.name,
        size: file.size,
        contentType: file.type,
        status: 'uploading',
        ...(previewUrl !== undefined && { previewUrl }),
      };
      combined.push(entry);
      accepted.push({ entry, file });
    }
    setAttachError(reject);
    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted.map((a) => a.entry)]);
      for (const a of accepted) void uploadOne(a.entry.localId, a.file);
    }
  };

  const removeAttachment = (localId: string): void => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.localId === localId);
      if (target?.previewUrl !== undefined) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.localId !== localId);
    });
    setAttachError(null);
  };

  // Commit the Cc draft into a chip (validated). Returns the effective cc list so
  // handleSend can use it synchronously (state updates are async).
  const commitCcDraft = (): { ok: boolean; cc: string[] } => {
    const raw = ccDraft.trim().replace(/,+$/, '').trim();
    if (raw === '') return { ok: true, cc };
    if (!isValidEmail(raw)) {
      setCcError(`${raw} is not a valid email address.`);
      return { ok: false, cc };
    }
    const norm = normalizeEmail(raw);
    const next = cc.includes(norm) ? cc : [...cc, norm];
    setCc(next);
    setCcDraft('');
    setCcError(null);
    return { ok: true, cc: next };
  };

  const onCcKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitCcDraft();
    } else if (e.key === 'Backspace' && ccDraft === '' && cc.length > 0) {
      setCc(cc.slice(0, -1));
    }
  };

  const removeCc = (addr: string): void => setCc((prev) => prev.filter((c) => c !== addr));

  const handleSend = async (): Promise<void> => {
    const committed = commitCcDraft();
    if (!committed.ok) return;
    const finalCc = committed.cc;
    const subjectT = subject.trim();
    const bodyT = body.trim();
    if (to === '' || subjectT === '' || bodyT === '' || sending || hasUploading || hasErrored || overCap) {
      return;
    }
    const atts = uploadedAttachments;
    const snapshot = { subject, body, cc: finalCc, attachments };
    setSending(true);
    setSendError(null);
    // Optimistic: the parent shows the "Sending..." card, so clear the fields now
    // (keep the To selection). Restore on failure so nothing is lost.
    setSubject('');
    setBody('');
    setCc([]);
    setCcDraft('');
    setCcError(null);
    setAttachments([]);
    setAttachError(null);
    try {
      await onSend({ to, cc: finalCc, subject: subjectT, body: bodyT, attachments: atts });
      for (const a of snapshot.attachments) {
        if (a.previewUrl !== undefined) URL.revokeObjectURL(a.previewUrl);
      }
    } catch (err) {
      setSendError(sendFailureMessage(err));
      setSubject(snapshot.subject);
      setBody(snapshot.body);
      setCc(snapshot.cc);
      setAttachments(snapshot.attachments);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={styles.composer}>
      {suppressed ? (
        <p className={styles.suppressedNote} role="note">
          This contact is not receiving email - they opted out or a message bounced.
        </p>
      ) : null}

      <div className={styles.field}>
        <label className={styles.label} htmlFor="email-to">
          To
        </label>
        <select
          id="email-to"
          className={styles.select}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        >
          {emails.map((em) => (
            <option key={em.email} value={em.email}>
              {em.email}
              {em.label ? ` (${em.label})` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="email-cc">
          Cc
        </label>
        {cc.length > 0 ? (
          <ul className={styles.ccChips} aria-label="Cc recipients">
            {cc.map((addr) => (
              <li key={addr} className={styles.ccChip}>
                <span className={styles.ccChipName}>{addr}</span>
                <button
                  type="button"
                  className={styles.ccChipRemove}
                  onClick={() => removeCc(addr)}
                  aria-label={`Remove ${addr} from Cc`}
                >
                  <span aria-hidden="true">x</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          id="email-cc"
          className={styles.input}
          type="email"
          value={ccDraft}
          onChange={(e) => {
            setCcDraft(e.target.value);
            setCcError(null);
          }}
          onKeyDown={onCcKeyDown}
          onBlur={() => commitCcDraft()}
          placeholder="Add Cc and press Enter (optional)"
        />
        {ccError !== null ? (
          <p role="alert" className={styles.error}>
            {ccError}
          </p>
        ) : null}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="email-subject">
          Subject
        </label>
        <input
          id="email-subject"
          className={styles.input}
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject"
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="email-body">
          Message
        </label>
        <textarea
          ref={bodyRef}
          id="email-body"
          className={styles.body}
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your email..."
        />
      </div>

      {attachments.length > 0 ? (
        <ul className={styles.chips} aria-label="Email attachments">
          {attachments.map((a) => (
            <li
              key={a.localId}
              className={`${styles.chip} ${a.status === 'error' ? styles.chipError ?? '' : ''}`}
              aria-busy={a.status === 'uploading'}
            >
              {a.previewUrl !== undefined ? (
                <img className={styles.chipThumb} src={a.previewUrl} alt="" />
              ) : (
                <span className={styles.chipIcon} aria-hidden="true">
                  {a.contentType === 'application/pdf' ? 'PDF' : 'FILE'}
                </span>
              )}
              <span className={styles.chipName}>{a.name}</span>
              <span className={styles.chipMeta}>
                {a.status === 'uploading'
                  ? 'Uploading...'
                  : a.status === 'error'
                    ? a.error ?? 'Upload failed'
                    : formatBytes(a.size)}
              </span>
              <button
                type="button"
                className={styles.chipRemove}
                onClick={() => removeAttachment(a.localId)}
                aria-label={`Remove ${a.name}`}
              >
                <span aria-hidden="true">x</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {overCap ? (
        <p className={styles.error} role="alert">
          Attachments exceed the 25 MB total limit. Remove one to send.
        </p>
      ) : null}
      {hasErrored ? (
        <p className={styles.error} role="alert">
          An attachment failed to upload. Remove it to send.
        </p>
      ) : null}
      {attachError ? (
        <p className={styles.error} role="alert">
          {attachError}
        </p>
      ) : null}
      {sendError ? (
        <p className={styles.error} role="alert">
          {sendError}
        </p>
      ) : null}

      <div className={styles.foot}>
        <label className={styles.srOnly} htmlFor="email-attach-input">
          Attach files
        </label>
        <input
          ref={fileInputRef}
          id="email-attach-input"
          className={styles.srOnly}
          type="file"
          multiple
          accept={EMAIL_ACCEPT}
          aria-label="Attach files to email"
          onChange={onPickFiles}
        />
        <button
          type="button"
          className={styles.attachBtn}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach a file to the email"
        >
          <span aria-hidden="true">+</span> Attach
        </button>
        <button
          type="button"
          className={styles.sendBtn}
          onClick={() => void handleSend()}
          disabled={!canSend}
          title={
            to === ''
              ? 'Add an email address first'
              : subject.trim().length === 0
                ? 'Add a subject to send'
                : body.trim().length === 0
                  ? 'Write a message to send'
                  : overCap
                    ? 'Attachments exceed the 25 MB limit'
                    : undefined
          }
        >
          {sending ? 'Sending...' : 'Send email'}
        </button>
      </div>
    </div>
  );
}
