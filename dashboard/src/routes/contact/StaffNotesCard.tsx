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
// Stale-save guard (spec 3.9): every Save sends the staff_notes_updated_at the
// editor OPENED with. If a colleague saved in between, the server refuses with
// 409 staff_notes_stale and the current contact; the card then shows their
// newer note above the box, keeps the user's draft, hands the current contact
// up, and re-bases on THEIR stamp - so a second Save is a deliberate overwrite
// of a note the user has now seen, and Cancel keeps theirs.
import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, updateContact, type Contact } from '../../api/index.js';
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

/** The current contact a stale-save refusal carries, or null for any other
 *  failure (only a 409 `staff_notes_stale` with a contact body qualifies). */
function staleContact(err: unknown): Contact | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'staff_notes_stale') return null;
  const body = err.body;
  if (typeof body !== 'object' || body === null) return null;
  const contact = (body as { contact?: unknown }).contact;
  return typeof contact === 'object' && contact !== null ? (contact as Contact) : null;
}

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
  // The stamp the editor opened with (null = never saved) - the guard's
  // expectation. Captured at edit start, re-based on a stale refusal.
  const [baselineStamp, setBaselineStamp] = useState<string | null>(updatedAt ?? null);
  // A colleague's newer note, shown after a stale refusal (null = no conflict).
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaId = useId();
  const conflictId = useId();

  // Focus the box on entry to edit mode (the click that opened it was on the
  // heading affordance, which is gone once the form renders).
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const startEdit = (): void => {
    setDraft(stored);
    setBaseline(stored);
    setBaselineStamp(updatedAt ?? null);
    setConflict(null);
    setError(null);
    setEditing(true);
  };
  const cancel = (): void => {
    setEditing(false);
    setConflict(null);
    setError(null);
  };
  const save = async (): Promise<void> => {
    // An unchanged draft is a no-op: no request, back to read mode.
    // Trimmed: the server stores it trimmed, so a whitespace-only edit would re-stamp.
    // vs the text the editor OPENED with: a refetch can move the prop mid-edit; untouched never sends.
    if (draft.trim() === baseline.trim()) {
      setEditing(false);
      setConflict(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateContact(contactId, {
        staff_notes: draft,
        staff_notes_expected_updated_at: baselineStamp,
      });
      onContactUpdated?.(updated);
      setEditing(false);
      setConflict(null);
    } catch (err) {
      const theirs = staleContact(err);
      if (theirs === null) {
        setError(SAVE_FAILED);
      } else {
        // Someone saved first. Show their note, keep the draft, re-base on
        // THEIR version so the next Save is a deliberate, informed overwrite.
        const theirText = typeof theirs.staff_notes === 'string' ? theirs.staff_notes : '';
        onContactUpdated?.(theirs);
        setBaseline(theirText);
        setBaselineStamp(typeof theirs.staff_notes_updated_at === 'string' ? theirs.staff_notes_updated_at : null);
        setConflict(theirText);
      }
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
          {conflict !== null ? (
            // Worded for every way a stale save happens (a colleague, the
            // same person in another tab, a page left open): it names what
            // changed, not who. Linked to the box via aria-describedby.
            <div id={conflictId} role="alert" className={styles.conflict}>
              <p className={styles.conflictLead}>
                These notes were changed since this page loaded. The current version is below, and
                your text is still in the box. Save again to replace it, or Cancel to keep it.
              </p>
              {conflict.trim().length > 0 ? (
                <p className={styles.conflictText}>{conflict}</p>
              ) : (
                <p className={styles.conflictEmpty}>(The notes were cleared.)</p>
              )}
            </div>
          ) : null}
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
              {...(conflict !== null && { 'aria-describedby': conflictId })}
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
