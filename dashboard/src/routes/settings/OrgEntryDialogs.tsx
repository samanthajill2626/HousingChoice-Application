// OrgEntryDialogs - the dialogs behind the Settings entry rows (spec
// 2026-10-06 D10, D12, D13): notes for everyone, and (Task 11.16) the
// admin-only spellings, rename, merge, kind and delete. Every refusal is shown
// through orgErrorCopy (never the raw code); every button has an explicit type.
import { useId, useState } from 'react';
import {
  ApiError,
  deleteOrg,
  mergeOrg,
  patchOrg,
  type OrgEntry,
  type OrgPatchResult,
  type OrgUsageCounts,
  type SkippedSpelling,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import {
  KIND_PLURAL_TITLE,
  orgErrorCopy,
  otherKindOf,
  spellingProblemCopy,
  usageBreakdown,
  usageTotal,
} from '../orgs/orgCopy.js';
import styles from './OrgListSection.module.css';

/** U+00D7 MULTIPLICATION SIGN, built at runtime so the source stays ASCII. */
const REMOVE_GLYPH = String.fromCharCode(0xd7);

interface EntryDialogProps {
  entry: OrgEntry;
  onClose: () => void;
}

/** "Edit notes" - everyone; notes touch no records (spec D10, D13: 500 chars). */
export function NotesDialog({ entry, onSaved, onClose }: EntryDialogProps & { onSaved: () => void }): React.JSX.Element {
  const notesId = useId();
  const [notes, setNotes] = useState(entry.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (busy) return;
    if (notes === (entry.notes ?? '')) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await patchOrg(entry.orgId, { notes });
      onSaved();
    } catch (err) {
      setError(orgErrorCopy(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Edit notes"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving...' : 'Save'}
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <p className={styles.dialogText}>{`Notes for ${entry.name}. Notes change no records.`}</p>
        <div className={styles.field}>
          <label htmlFor={notesId} className={styles.label}>
            Notes
          </label>
          <textarea
            id={notesId}
            className={styles.textarea}
            value={notes}
            rows={4}
            maxLength={500}
            disabled={busy}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        {error !== null ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** "Not kept as a spelling: X (why)." - spec D12: an automatic addition (a
 *  rename keeping the old name, Use with "Remember this spelling") skips a
 *  spelling that breaks a rule and says why; it never fails. */
export function skippedSpellingsNotice(skipped: readonly SkippedSpelling[]): string {
  const parts = skipped.map((s) => `${s.spelling} (${spellingProblemCopy(s.problem)})`);
  return `Not kept as a spelling: ${parts.join('; ')}.`;
}

/** "8 records still hold this name (3 tenants, ..., 2 deleted)." */
function inUseText(usage: OrgUsageCounts): string {
  const total = usageTotal(usage) ?? 0;
  return `${total} ${total === 1 ? 'record still holds' : 'records still hold'} this name (${usageBreakdown(usage)}).`;
}

/** "Edit spellings" (admin, spec D12): abbreviations and other spellings that
 *  find the name. A spelling another entry of the same kind already carries
 *  needs an explicit "Save anyway" (409 org_spelling_shared -> confirmShared). */
export function SpellingsDialog({ entry, onSaved, onClose }: EntryDialogProps & { onSaved: () => void }): React.JSX.Element {
  const inputId = useId();
  const [spellings, setSpellings] = useState<string[]>(entry.spellings);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // D12's confirm sentence, after a 409 org_spelling_shared.
  const [shared, setShared] = useState<string | null>(null);

  function edit(next: string[]): void {
    setSpellings(next);
    setShared(null);
    setError(null);
  }

  function addDraft(): void {
    const spelling = draft.trim();
    setDraft('');
    if (spelling === '' || spellings.includes(spelling)) return;
    edit([...spellings, spelling]);
  }

  async function save(confirmShared: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await patchOrg(entry.orgId, confirmShared ? { spellings, confirmShared: true } : { spellings });
      onSaved();
    } catch (err) {
      if (!confirmShared && err instanceof ApiError && err.code === 'org_spelling_shared') {
        setShared(orgErrorCopy(err));
      } else {
        setError(orgErrorCopy(err));
      }
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Edit spellings"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {shared !== null ? (
            <Button variant="primary" size="sm" type="button" onClick={() => void save(true)} disabled={busy}>
              Save anyway
            </Button>
          ) : (
            <Button variant="primary" size="sm" type="button" onClick={() => void save(false)} disabled={busy}>
              {busy ? 'Saving...' : 'Save'}
            </Button>
          )}
        </>
      }
    >
      <div className={styles.dialogBody}>
        <p className={styles.dialogText}>
          {`Spellings that find ${entry.name}: abbreviations and other ways people write it. Spellings change no records.`}
        </p>
        {spellings.length > 0 ? (
          <ul className={styles.spellings} aria-label={`Spellings of ${entry.name}`}>
            {spellings.map((spelling) => (
              <li key={spelling} className={styles.spelling}>
                {spelling}
                <button
                  type="button"
                  className={styles.spellingRemove}
                  aria-label={`Remove ${spelling}`}
                  disabled={busy}
                  onClick={() => edit(spellings.filter((s) => s !== spelling))}
                >
                  {REMOVE_GLYPH}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.dialogMuted}>No spellings yet.</p>
        )}
        <div className={styles.field}>
          <label htmlFor={inputId} className={styles.label}>
            New spelling
          </label>
          <div className={styles.inlineRow}>
            <input
              id={inputId}
              className={styles.input}
              value={draft}
              maxLength={120}
              disabled={busy}
              autoComplete="off"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addDraft();
                }
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={addDraft}
              disabled={busy || draft.trim() === ''}
            >
              Add
            </Button>
          </div>
        </div>
        {shared !== null ? <p className={styles.warning}>{shared}</p> : null}
        {error !== null ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** "Rename <name>" (admin, spec D11/D12): ONE step - the new name, what it
 *  changes, Rename. A 202 starts the rewrite; the old name is kept as a
 *  spelling unless D12 skips it (the result names why). */
export function RenameDialog({
  entry,
  usage,
  onRenamed,
  onClose,
}: EntryDialogProps & {
  usage: OrgUsageCounts | undefined;
  onRenamed: (result: OrgPatchResult) => void;
}): React.JSX.Element {
  const nameId = useId();
  const [name, setName] = useState(entry.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = name.trim();
  const ready = !busy && next !== '' && next !== entry.name;

  async function rename(): Promise<void> {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      onRenamed(await patchOrg(entry.orgId, { name: next }));
    } catch (err) {
      setError(orgErrorCopy(err));
      setBusy(false);
    }
  }

  const changes =
    usage === undefined
      ? `Every record holding ${entry.name} changes to the new name.`
      : `Every record holding ${entry.name} changes to the new name: ${usageBreakdown(usage)}.`;
  return (
    <Modal
      title={`Rename ${entry.name}`}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => void rename()} disabled={!ready}>
            Rename
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <div className={styles.field}>
          <label htmlFor={nameId} className={styles.label}>
            New name
          </label>
          <input
            id={nameId}
            className={styles.input}
            value={name}
            maxLength={120}
            disabled={busy}
            autoComplete="off"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </div>
        <p className={styles.dialogText}>{`${changes} ${entry.name} is kept as a spelling, so it still finds the entry.`}</p>
        {error !== null ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** "Merge <name>" (admin, spec D11): the entry's name and ALL its spellings
 *  become spellings of another entry of the same kind, every record holding
 *  them is rewritten to it, and the entry leaves the list. */
export function MergeDialog({
  entry,
  entries,
  usage,
  onMerged,
  onClose,
}: EntryDialogProps & {
  entries: readonly OrgEntry[];
  usage: OrgUsageCounts | undefined;
  onMerged: () => void;
}): React.JSX.Element {
  const selectId = useId();
  const [intoOrgId, setIntoOrgId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targets = entries
    .filter((e) => e.kind === entry.kind && e.orgId !== entry.orgId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const target = targets.find((t) => t.orgId === intoOrgId);

  async function merge(): Promise<void> {
    if (busy || target === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await mergeOrg(entry.orgId, target.orgId);
      onMerged();
    } catch (err) {
      setError(orgErrorCopy(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Merge ${entry.name}`}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => void merge()} disabled={busy || target === undefined}>
            Merge
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <div className={styles.field}>
          <label htmlFor={selectId} className={styles.label}>
            Merge into
          </label>
          <select
            id={selectId}
            className={styles.select}
            value={intoOrgId}
            disabled={busy}
            onChange={(e) => {
              setIntoOrgId(e.target.value);
              setError(null);
            }}
          >
            <option value="">Choose a name</option>
            {targets.map((t) => (
              <option key={t.orgId} value={t.orgId}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        {target !== undefined ? (
          <p className={styles.dialogText}>
            {`${entry.name} and its spellings become spellings of ${target.name}, and ${entry.name} leaves the list. Every record holding it changes to ${target.name}${usage === undefined ? '' : `: ${usageBreakdown(usage)}`}.`}
          </p>
        ) : null}
        {error !== null ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** "Change kind of <name>" (admin, spec D10): allowed only when no record -
 *  deleted ones included - holds the name; nothing is rewritten. */
export function KindDialog({
  entry,
  usage,
  onChanged,
  onClose,
}: EntryDialogProps & { usage: OrgUsageCounts | undefined; onChanged: () => void }): React.JSX.Element {
  const to = otherKindOf(entry.kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = usage !== undefined && (usageTotal(usage) ?? 0) > 0;

  async function move(): Promise<void> {
    if (busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      await patchOrg(entry.orgId, { kind: to });
      onChanged();
    } catch (err) {
      setError(orgErrorCopy(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Change kind of ${entry.name}`}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => void move()} disabled={busy || blocked}>
            {`Move to ${KIND_PLURAL_TITLE[to]}`}
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <p className={styles.dialogText}>
          {blocked && usage !== undefined
            ? `${inUseText(usage)} The kind can change only when no record uses it.`
            : `${entry.name} moves from ${KIND_PLURAL_TITLE[entry.kind]} to ${KIND_PLURAL_TITLE[to]}. No record changes.`}
        </p>
        {error !== null ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** "Delete <name>" (admin, spec D10): allowed only when no record - deleted
 *  ones included - holds the name. */
export function DeleteDialog({
  entry,
  usage,
  onDeleted,
  onClose,
}: EntryDialogProps & { usage: OrgUsageCounts | undefined; onDeleted: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = usage !== undefined && (usageTotal(usage) ?? 0) > 0;

  async function remove(): Promise<void> {
    if (busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      await deleteOrg(entry.orgId);
      onDeleted();
    } catch (err) {
      setError(orgErrorCopy(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Delete ${entry.name}`}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" type="button" onClick={() => void remove()} disabled={busy || blocked}>
            Delete
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <p className={styles.dialogText}>
          {blocked && usage !== undefined
            ? `${inUseText(usage)} An entry can be deleted only when no record uses it.`
            : `${entry.name} leaves the list. No record changes.`}
        </p>
        {error !== null ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
