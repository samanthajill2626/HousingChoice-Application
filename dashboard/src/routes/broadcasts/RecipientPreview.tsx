// RecipientPreview — the editable curated recipient list (the step between
// Preview and Send). Every preview candidate is listed individually with a
// checkbox; the operator can uncheck/remove anyone, add tenants the filter
// didn't catch (tenant search → append), search-within-recipients (filter by
// name/phone), and bulk Select all / Deselect all. Already-sent-this-property
// rows render amber + UNCHECKED (a SOFT opt-in-to-resend flag, never a hard
// gate); "Select all" SKIPS already-sent rows. A live selected count drives
// "Send to N tenants", which posts the EXACT checked contactIds. 400/409 are
// surfaced inline. A "Delete draft" button removes the unsent draft.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  deleteBroadcast,
  sendBroadcast,
  type Contact,
  type PreviewResponse,
} from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { ContactSearchField, type ContactSearchValue } from '../contact/ContactSearchField.js';
import { contactDisplayName, formatPhone } from '../contact/format.js';
import styles from './RecipientPreview.module.css';

/** One row in the curated list (a preview candidate or a manually-added tenant). */
interface Row {
  contactId: string;
  name: string;
  phone: string;
  alreadySentThisProperty: boolean;
  /** Whether this row will be sent to. */
  checked: boolean;
  /** True for a manually-added tenant (badge cue). */
  added?: boolean;
}

export interface RecipientPreviewProps {
  draftId: string;
  preview: PreviewResponse;
  /** Tenant candidates for the "add a tenant" search (getContacts({type:'tenant'})). */
  tenantCandidates: Contact[];
  /** Whether the tenant-candidate list is still loading (disables add until ready). */
  candidatesLoading: boolean;
}

/** Build the initial rows from the preview candidates — already-sent rows start
 *  UNCHECKED (soft opt-in to resend); everyone else starts checked. */
function initialRows(preview: PreviewResponse): Row[] {
  return preview.candidates.map((c) => ({
    contactId: c.contactId,
    name: contactDisplayName(c.firstName, undefined, c.phone),
    phone: c.phone,
    alreadySentThisProperty: c.alreadySentThisProperty,
    checked: !c.alreadySentThisProperty,
  }));
}

export function RecipientPreview({
  draftId,
  preview,
  tenantCandidates,
  candidatesLoading,
}: RecipientPreviewProps): React.JSX.Element {
  const navigate = useNavigate();
  const priorIds = useMemo(
    () => new Set(preview.priorRecipientContactIds),
    [preview.priorRecipientContactIds],
  );
  const [rows, setRows] = useState<Row[]>(() => initialRows(preview));
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<ContactSearchValue>({ name: '' });
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** When a 409 fired (already sent / raced), offer the Results link inline. */
  const [racedToResults, setRacedToResults] = useState(false);

  const checkedCount = rows.filter((r) => r.checked).length;

  // Search-within-recipients: filter the visible rows by name/phone (the model
  // keeps every row's checked state; only the rendered set is filtered).
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return rows;
    return rows.filter(
      (r) => r.name.toLowerCase().includes(q) || r.phone.toLowerCase().includes(q),
    );
  }, [rows, query]);

  function toggle(contactId: string): void {
    setRows((prev) =>
      prev.map((r) => (r.contactId === contactId ? { ...r, checked: !r.checked } : r)),
    );
  }

  function remove(contactId: string): void {
    setRows((prev) => prev.filter((r) => r.contactId !== contactId));
  }

  /** Select all — but SKIP already-sent rows (they stay unchecked; opt-in only). */
  function selectAll(): void {
    setRows((prev) => prev.map((r) => ({ ...r, checked: !r.alreadySentThisProperty })));
  }
  function deselectAll(): void {
    setRows((prev) => prev.map((r) => ({ ...r, checked: false })));
  }

  /** Add a tenant from the search (must resolve to a contactId). Annotate
   *  already-sent locally via priorRecipientContactIds; ignore duplicates. */
  function addTenant(picked: ContactSearchValue): void {
    setSearch({ name: '' });
    if (picked.contactId === undefined) return;
    const candidate = tenantCandidates.find((c) => c.contactId === picked.contactId);
    if (candidate === undefined) return;
    const phone = candidate.phones?.find((p) => p.primary)?.phone ?? candidate.phone ?? '';
    if (phone.length === 0) return; // unsendable — don't add a phone-less tenant
    setRows((prev) => {
      if (prev.some((r) => r.contactId === candidate.contactId)) return prev; // already listed
      const already = priorIds.has(candidate.contactId);
      return [
        ...prev,
        {
          contactId: candidate.contactId,
          name: contactDisplayName(candidate.firstName, candidate.lastName, phone),
          phone,
          alreadySentThisProperty: already,
          checked: !already,
          added: true,
        },
      ];
    });
  }

  async function onSend(): Promise<void> {
    if (sending || checkedCount === 0) return;
    setSending(true);
    setError(null);
    setRacedToResults(false);
    const ids = rows.filter((r) => r.checked).map((r) => r.contactId);
    try {
      await sendBroadcast(draftId, ids);
      navigate(`/broadcasts/${encodeURIComponent(draftId)}`);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setError('This broadcast was already sent (or is sending).');
          setRacedToResults(true);
        } else if (err.status === 400 && err.code === 'empty_audience') {
          setError('Nothing selected — check at least one tenant to send.');
        } else if (err.status === 400 && /cap/i.test(err.message)) {
          setError(err.message);
        } else if (err.status === 400) {
          setError(err.message);
        } else {
          setError("Couldn't send — please try again.");
        }
      } else {
        setError("Couldn't send — please try again.");
      }
    } finally {
      setSending(false);
    }
  }

  async function onDelete(): Promise<void> {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteBroadcast(draftId);
      navigate('/broadcasts');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // No longer a draft (already sent / raced) → it's a Results row now.
        navigate(`/broadcasts/${encodeURIComponent(draftId)}`);
        return;
      }
      setError("Couldn't delete the draft — please try again.");
      setDeleting(false);
    }
  }

  return (
    <div className={styles.preview}>
      <div className={styles.toolbar}>
        <h2 className={styles.heading}>Recipients</h2>
        <div className={styles.bulk}>
          <button type="button" className={styles.bulkBtn} onClick={selectAll}>
            Select all
          </button>
          <button type="button" className={styles.bulkBtn} onClick={deselectAll}>
            Deselect all
          </button>
        </div>
      </div>

      <p className={styles.note}>
        Already-sent tenants are unchecked — check one to resend. “Select all” skips them.
      </p>

      <label className={styles.searchField}>
        <span className={styles.srOnly}>Search recipients</span>
        <input
          type="search"
          className={styles.search}
          value={query}
          placeholder="Search recipients by name or number…"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      {visibleRows.length === 0 ? (
        <p className={styles.emptyBody}>
          {rows.length === 0 ? 'No candidates — add a tenant below.' : 'No recipients match your search.'}
        </p>
      ) : (
        <ul className={styles.rows} aria-label="Candidate recipients">
          {visibleRows.map((row) => (
            <li
              key={row.contactId}
              className={`${styles.row} ${row.alreadySentThisProperty ? styles.rowAlready : ''}`.trim()}
            >
              <label className={styles.rowLabel}>
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={row.checked}
                  onChange={() => toggle(row.contactId)}
                />
                <span className={styles.rowName}>{row.name}</span>
                <span className={styles.rowPhone}>{formatPhone(row.phone)}</span>
                {row.alreadySentThisProperty ? (
                  <span className={styles.alreadyTag}>Already sent</span>
                ) : null}
                {row.added ? <span className={styles.addedTag}>Added</span> : null}
              </label>
              <button
                type="button"
                className={styles.removeBtn}
                aria-label={`Remove ${row.name}`}
                onClick={() => remove(row.contactId)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Add a tenant the filter didn't catch. */}
      <div className={styles.addRow}>
        <span className={styles.addLabel}>Add a tenant</span>
        {candidatesLoading ? (
          <Spinner />
        ) : (
          <ContactSearchField
            value={search}
            onChange={(v) => {
              if (v.contactId !== undefined) addTenant(v);
              else setSearch(v);
            }}
            candidates={tenantCandidates}
            inputLabel="Add a tenant"
          />
        )}
      </div>

      {error !== null ? (
        <p className={styles.error} role="alert">
          {error}
          {racedToResults ? (
            <>
              {' '}
              <button
                type="button"
                className={styles.resultsLink}
                onClick={() => navigate(`/broadcasts/${encodeURIComponent(draftId)}`)}
              >
                View results
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      {preview.truncated ? (
        <p className={styles.truncated} role="status">
          The audience hit the cap — some matches may be missing. Narrow the filter for a complete
          list.
        </p>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.sendBtn}
          disabled={checkedCount === 0 || sending}
          onClick={() => void onSend()}
        >
          {sending ? 'Sending…' : `Send to ${checkedCount} tenant${checkedCount === 1 ? '' : 's'}`}
        </button>
        <button
          type="button"
          className={styles.deleteBtn}
          disabled={deleting || sending}
          onClick={() => void onDelete()}
        >
          {deleting ? 'Deleting…' : 'Delete draft'}
        </button>
      </div>
    </div>
  );
}
