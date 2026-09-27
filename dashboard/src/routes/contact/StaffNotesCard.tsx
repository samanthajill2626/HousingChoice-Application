// StaffNotesCard - the tenant file's hand-written notes box (Sam's item 22,
// spec 2026-09-26-staff-notes-past-tours-design.md section 3.6).
//
// A SECOND notes card, kept apart from "Preferences & notes" (which the AI
// appends dated "[Auto - <date>]" lines to): one free-text value staff edit IN
// PLACE - textarea, Save, Cancel - saved through PATCH /api/contacts/:id
// { staff_notes } (updateContact). The server stamps staff_notes_updated_at,
// rendered here as "Last edited <date>" while the box holds text. The card
// owns its edit state and its save call and hands the returned contact up
// through onContactUpdated so the file pane applies it in place (the same
// setContact path the edit dialog uses). Without that handler the card is
// read-only, mirroring how the sibling cards degrade without onEdit.
//
// Two staff saving at once is last-write-wins, like every contact field.
import { useEffect, useId, useRef, useState } from 'react';
import { updateContact, type Contact } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Card, CardAction, EmptyRow, NotesText, responseClass } from './Card.js';
import styles from './StaffNotesCard.module.css';

export interface StaffNotesCardProps {
  contactId: string;
  /** The stored staff_notes (undefined when never set). */
  value: string | undefined;
  /** The stored staff_notes_updated_at (undefined when never saved). */
  updatedAt: string | undefined;
  /** Receives the PATCHed contact. Absent -> read-only card (no Edit / + Add). */
  onContactUpdated?: (updated: Contact) => void;
}

/** The one user-facing failure line. No server code or message is appended
 *  (raw error codes stay out of user copy). */
const SAVE_FAILED = 'Could not save staff notes. Try again.';

/** "Sep 26, 2026" (en-US short month, numeric day and year) or '' when absent
 *  or unparseable. Same shape the Closed tours rows use for a date. */
export function formatLastEdited(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function StaffNotesCard({
  contactId,
  value,
  updatedAt,
  onContactUpdated,
}: StaffNotesCardProps): React.JSX.Element {
  const stored = typeof value === 'string' ? value : '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(stored);
  const [baseline, setBaseline] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaId = useId();

  // Focus the box on entry to edit mode (the click that opened it was on the
  // heading affordance, which is gone once the form renders).
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const startEdit = (): void => {
    setDraft(stored);
    setBaseline(stored);
    setError(null);
    setEditing(true);
  };
  const cancel = (): void => {
    setEditing(false);
    setError(null);
  };
  const save = async (): Promise<void> => {
    // An unchanged draft is a no-op: no request, back to read mode.
    // Trimmed: the server stores it trimmed, so a whitespace-only edit would re-stamp.
    // vs the text the editor OPENED with: a refetch can move the prop mid-edit; untouched never sends.
    if (draft.trim() === baseline.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateContact(contactId, { staff_notes: draft });
      onContactUpdated?.(updated);
      setEditing(false);
    } catch {
      setError(SAVE_FAILED);
    } finally {
      setSaving(false);
    }
  };

  const trimmed = stored.trim();
  const hasText = trimmed.length > 0;
  // Only while the box holds text: a cleared box reads as never set even
  // though the server keeps the stamp (spec 3.6).
  const lastEdited = hasText ? formatLastEdited(updatedAt) : '';
  const asideLabel = hasText ? 'Edit staff notes' : 'Add staff notes';
  const asideText = hasText ? 'Edit' : '+ Add';
  const aside = onContactUpdated ? (
    <CardAction onClick={startEdit} label={asideLabel}>
      {asideText}
    </CardAction>
  ) : (
    asideText
  );

  return (
    <Card title="Staff notes" aside={editing ? undefined : aside}>
      {editing ? (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {/* The label is a SIBLING associated by id, never a wrapper: React
              mirrors a controlled textarea's value into its text content, and
              a wrapping <label> would then carry the draft as part of its
              accessible text, so getByLabel('Staff notes', { exact: true })
              would miss a prefilled box. */}
          <div className={styles.field}>
            <label htmlFor={textareaId} className={styles.srOnly}>
              Staff notes
            </label>
            <textarea
              id={textareaId}
              ref={textareaRef}
              className={styles.textarea}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              readOnly={saving}
            />
          </div>
          {error !== null ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Button type="submit" size="sm" variant="primary" disabled={saving}>
              Save
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          {hasText ? <NotesText text={trimmed} /> : <EmptyRow>No staff notes yet.</EmptyRow>}
          {lastEdited.length > 0 ? (
            <p className={`${styles.lastEdited} ${responseClass.muted}`}>Last edited {lastEdited}</p>
          ) : null}
        </>
      )}
    </Card>
  );
}
