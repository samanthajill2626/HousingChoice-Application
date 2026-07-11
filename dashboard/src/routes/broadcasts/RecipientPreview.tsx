// RecipientPreview — the editable curated recipient list (the step between
// Preview and Send). Every preview candidate is listed individually with a
// checkbox; the operator can uncheck anyone (the ONLY exclusion mechanism —
// the old per-row Remove duplicated it and could dismiss a fenced no-consent
// row from view, hiding the record-consent reminder), add tenants the filter
// didn't catch (tenant search → append), search-within-recipients (filter by
// name/phone), and bulk Select all / Deselect all. Excluded rows stay VISIBLE
// (auditable: staff can see who's left out and re-check them). Already-sent-
// this-property rows render amber + UNCHECKED (a SOFT opt-in-to-resend flag,
// never a hard gate); "Select all" SKIPS already-sent rows. A live selected
// count drives "Send to N tenants", which posts the EXACT checked contactIds.
// 400/409 are surfaced inline. A "Delete draft" button removes the unsent draft.
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ApiError,
  deleteBroadcast,
  getUnit,
  sendBroadcast,
  updateBroadcastSeeds,
  setListingStatus,
  LISTING_STATUS_LABELS,
  type Contact,
  type ListingStatus,
  type PreviewResponse,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import { ContactSearchField, type ContactSearchValue } from '../contact/ContactSearchField.js';
import { contactDisplayName, formatPhone } from '../contact/format.js';
import styles from './RecipientPreview.module.css';

/** One row in the curated list (a preview candidate or a manually-added tenant). */
interface Row {
  contactId: string;
  name: string;
  phone: string;
  alreadySentThisProperty: boolean;
  /** A2P/CTIA consent (CONTRACT 3): false → a HARD fence (excluded from the send,
   *  badged "consent not recorded", never checkable). */
  hasConsent: boolean;
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
  /** The attached property, when composing from one. Send re-checks its status
   *  (spec 2026-07-10): a non-Available unit's flyer link is dead, so the send
   *  is blocked behind a "Make Available & send" dialog. */
  unitId?: string;
}

/** Build the initial rows from the preview candidates — already-sent rows start
 *  UNCHECKED (soft opt-in to resend); everyone else starts checked. */
function initialRows(preview: PreviewResponse): Row[] {
  return preview.candidates.map((c) => ({
    contactId: c.contactId,
    // FULL name — first name alone doesn't identify a person at roster scale.
    name: contactDisplayName(c.firstName, c.lastName, c.phone),
    phone: c.phone,
    alreadySentThisProperty: c.alreadySentThisProperty,
    hasConsent: c.has_consent,
    // No-consent rows are a HARD fence — never checked. Already-sent rows start
    // unchecked (soft opt-in) UNLESS they were hand-seeded: a seed is a
    // deliberate choice, so pre-check it even when already sent this property.
    checked: c.has_consent && (c.seeded || !c.alreadySentThisProperty),
  }));
}

export function RecipientPreview({
  draftId,
  preview,
  tenantCandidates,
  candidatesLoading,
  unitId,
}: RecipientPreviewProps): React.JSX.Element {
  const navigate = useNavigate();
  const priorIds = useMemo(
    () => new Set(preview.priorRecipientContactIds),
    [preview.priorRecipientContactIds],
  );
  const [rows, setRows] = useState<Row[]>(() => initialRows(preview));
  // The draft's current hand-picked seed list — persisted best-effort on each
  // successful add-a-tenant so a hand-pick survives a reload of the review step.
  const seedsRef = useRef<string[]>(preview.seedContactIds);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<ContactSearchValue>({ name: '' });
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Brief inline reason an add-a-tenant pick couldn't be added (phone-less /
   *  not-found / opted-out / unreachable) — so a can't-add never fails silently. */
  const [addNote, setAddNote] = useState<string | null>(null);
  /** When a 409 fired (already sent / raced), offer the Results link inline. */
  const [racedToResults, setRacedToResults] = useState(false);
  /** Availability gate (spec 2026-07-10): set when Send found the property in a
   *  non-Available status - renders the blocking Make-Available dialog. */
  const [availGate, setAvailGate] = useState<ListingStatus | string | null>(null);
  const [gateBusy, setGateBusy] = useState(false);
  /** True while the Send pre-flight is fetching the property's fresh status —
   *  keeps the Send button honest (busy + non-reclickable) during the check. */
  const [checkingUnit, setCheckingUnit] = useState(false);

  const checkedCount = rows.filter((r) => r.checked).length;
  // A2P/CTIA: how many listed recipients have NO recorded consent (fenced out of
  // the send + surfaced so staff can resolve them — mirrors the skipped counts).
  const noConsentCount = rows.filter((r) => !r.hasConsent).length;

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
      prev.map((r) =>
        // A no-consent row can't be checked (hard fence) — record consent to
        // include them; toggling it is a no-op.
        r.contactId === contactId && r.hasConsent ? { ...r, checked: !r.checked } : r,
      ),
    );
  }

  /** Select all — but SKIP already-sent rows (opt-in only) AND no-consent rows
   *  (hard fence; they can never be sent to). */
  function selectAll(): void {
    setRows((prev) =>
      prev.map((r) => ({ ...r, checked: r.hasConsent && !r.alreadySentThisProperty })),
    );
  }
  function deselectAll(): void {
    setRows((prev) => prev.map((r) => ({ ...r, checked: false })));
  }

  /** Add a tenant from the search (must resolve to a contactId). Annotate
   *  already-sent locally via priorRecipientContactIds; ignore duplicates. We
   *  VALIDATE before clearing the search box so a can't-add surfaces an inline
   *  reason instead of vanishing silently. Mirrors the server fence: an opted-out
   *  / unreachable tenant is NOT added (the server would drop it anyway). */
  function addTenant(picked: ContactSearchValue): void {
    setAddNote(null);
    if (picked.contactId === undefined) return;
    const candidate = tenantCandidates.find((c) => c.contactId === picked.contactId);
    if (candidate === undefined) {
      setAddNote("Couldn't add that tenant — try the search again.");
      return;
    }
    const name = contactDisplayName(candidate.firstName, candidate.lastName, candidate.phone);
    const phone = candidate.phones?.find((p) => p.primary)?.phone ?? candidate.phone ?? '';
    if (phone.length === 0) {
      setAddNote(`Can't add ${name} — no phone number on file.`);
      return;
    }
    if (candidate.sms_opt_out === true) {
      setAddNote(`Can't add ${name} — opted out of texts.`);
      return;
    }
    if (candidate.sms_unreachable === true) {
      setAddNote(`Can't add ${name} — number is unreachable.`);
      return;
    }
    // A2P/CTIA: "has SMS consent" == a non-empty consent_method. A no-consent
    // tenant can't be added (mirrors the opt-out guard + the server fence) —
    // record consent for them first, then they re-enter the audience.
    const hasConsent =
      typeof candidate.consent_method === 'string' && candidate.consent_method.length > 0;
    if (!hasConsent) {
      setAddNote(`Can't add ${name} — no consent recorded.`);
      return;
    }
    setSearch({ name: '' });
    // Only a genuine add (not a dedupe hit) persists to the draft's seed list.
    const alreadyListed = rows.some((r) => r.contactId === candidate.contactId);
    setRows((prev) => {
      if (prev.some((r) => r.contactId === candidate.contactId)) return prev; // already listed
      const already = priorIds.has(candidate.contactId);
      return [
        ...prev,
        {
          contactId: candidate.contactId,
          name,
          phone,
          alreadySentThisProperty: already,
          hasConsent: true,
          checked: !already,
          added: true,
        },
      ];
    });
    if (!alreadyListed) {
      // Best-effort persistence — a failed PATCH never blocks or surfaces in the
      // review UI (the send still posts the exact checked ids either way).
      seedsRef.current = [...seedsRef.current, candidate.contactId];
      void updateBroadcastSeeds(draftId, seedsRef.current).catch(() => {});
    }
  }

  async function onSend(): Promise<void> {
    if (sending || checkingUnit || checkedCount === 0) return;
    // Pre-flight (spec 2026-07-10): the flyer link only resolves while the
    // property is Available. Check FRESH status (never the compose-time object;
    // a resumed draft can be days old).
    if (unitId !== undefined) {
      setError(null);
      setCheckingUnit(true);
      let status: string;
      try {
        status = (await getUnit(unitId)).status;
      } catch {
        setError("Couldn't check the property's status. Try again.");
        return;
      } finally {
        setCheckingUnit(false);
      }
      if (status !== 'available') {
        setAvailGate(status);
        return;
      }
    }
    await doSend();
  }

  async function doSend(): Promise<void> {
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
        if (err.code === 'rate_limited' || err.status === 429) {
          setError('Sending too fast — wait a moment and try again.');
        } else if (err.status === 409) {
          setError('This send already went out (or is sending).');
          setRacedToResults(true);
        } else if (err.status === 400 && err.code === 'empty_audience') {
          setError('Nothing selected — check at least one tenant to send.');
        } else if (err.status === 400 && err.code === 'unit_not_available') {
          // Race: the property left Available between our pre-flight and the
          // server's own guard (or another session flipped it back).
          setError("This property isn't Available, so its flyer link won't work. Make it Available, then send.");
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

  async function onMakeAvailableAndSend(): Promise<void> {
    if (gateBusy || unitId === undefined) return;
    setGateBusy(true);
    try {
      // Through the single status-transition service, same as the property
      // page's status pill - the property's activity trail records it.
      await setListingStatus(unitId, { toStatus: 'available', source: 'manual' });
      setAvailGate(null);
      await doSend();
    } catch {
      setAvailGate(null);
      setError("Couldn't make the property Available. Change its status on the property page, then send.");
    } finally {
      setGateBusy(false);
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

      {/* A2P/CTIA: surface no-consent recipients (fenced out of the send) with a
          count so staff can record consent → they re-enter the audience. */}
      {noConsentCount > 0 ? (
        <p className={styles.noConsentCount} role="status">
          {noConsentCount} recipient{noConsentCount === 1 ? '' : 's'} without recorded consent{' '}
          {noConsentCount === 1 ? 'is' : 'are'} excluded — record consent to include{' '}
          {noConsentCount === 1 ? 'them' : 'them'}.
        </p>
      ) : null}

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

      {/* Matching sends: hand-picked seeds the server couldn't deliver to
          (unknown contact, opted out, or unreachable) were dropped — say so. */}
      {preview.unresolvedSeedIds.length > 0 ? (
        <p className={styles.seedNotice} role="status">
          {preview.unresolvedSeedIds.length === 1
            ? "1 added tenant can't receive texts (unknown, opted out, or unreachable) and was left out."
            : `${preview.unresolvedSeedIds.length} added tenants can't receive texts (unknown, opted out, or unreachable) and were left out.`}
        </p>
      ) : null}

      {visibleRows.length === 0 ? (
        <p className={styles.emptyBody}>
          {rows.length === 0 ? 'No candidates — add a tenant below.' : 'No recipients match your search.'}
        </p>
      ) : (
        <ul className={styles.rows} aria-label="Candidate recipients">
          {visibleRows.map((row) => (
            <li
              key={row.contactId}
              className={`${styles.row} ${!row.hasConsent ? styles.rowNoConsent : row.alreadySentThisProperty ? styles.rowAlready : ''}`.trim()}
            >
              <label className={styles.rowLabel}>
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  // Explicit, clean accessible name (the tenant's name, plus a
                  // status cue) so getByRole('checkbox',{name}) resolves by the
                  // row's tenant — NOT the whole name+phone+tags blob. A no-consent
                  // row is DISABLED (hard fence — can never be sent to).
                  aria-label={
                    !row.hasConsent
                      ? `${row.name} — consent not recorded`
                      : row.alreadySentThisProperty
                        ? `${row.name} — already sent`
                        : row.name
                  }
                  checked={row.checked}
                  disabled={!row.hasConsent}
                  onChange={() => toggle(row.contactId)}
                />
              </label>
              {/* The name links to the profile in a NEW TAB — the curated list
                  (checkbox state, added rows) lives in this page's memory, so
                  in-tab navigation would lose it. Outside the checkbox label so
                  clicking the link never toggles the row. */}
              <span className={styles.rowBody}>
                <Link
                  className={styles.rowName}
                  to={`/contacts/${encodeURIComponent(row.contactId)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open profile in a new tab — your recipient list stays put"
                >
                  {row.name}
                </Link>
                <span className={styles.rowPhone}>{formatPhone(row.phone)}</span>
                {!row.hasConsent ? (
                  <span className={styles.noConsentTag}>consent not recorded — fix before sending</span>
                ) : row.alreadySentThisProperty ? (
                  <span className={styles.alreadyTag}>Already sent</span>
                ) : null}
                {row.added ? <span className={styles.addedTag}>Added</span> : null}
              </span>
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
      {addNote !== null ? (
        <p className={styles.addNote} role="alert">
          {addNote}
        </p>
      ) : null}

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
        // role="alert" (announces on insertion) — the warning mounts WITH content,
        // so role="status" wouldn't reliably announce.
        <p className={styles.truncated} role="alert">
          The audience hit the cap — some matches may be missing. Narrow the filter for a complete
          list.
        </p>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.sendBtn}
          disabled={checkedCount === 0 || sending || checkingUnit}
          onClick={() => void onSend()}
        >
          {checkingUnit
            ? 'Checking property…'
            : sending
              ? 'Sending…'
              : `Send to ${checkedCount} tenant${checkedCount === 1 ? '' : 's'}`}
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

      {availGate !== null ? (
        <Modal
          title="Property isn't Available"
          onClose={() => setAvailGate(null)}
          footer={
            <>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setAvailGate(null)}
                disabled={gateBusy}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                type="button"
                onClick={() => void onMakeAvailableAndSend()}
                disabled={gateBusy}
              >
                {gateBusy ? 'Working…' : 'Make Available & send'}
              </Button>
            </>
          }
        >
          <p className={styles.availGateBody}>
            The flyer link in this broadcast only works while the property is Available. Its
            status is currently{' '}
            <strong>{LISTING_STATUS_LABELS[availGate as ListingStatus] ?? availGate}</strong>.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
