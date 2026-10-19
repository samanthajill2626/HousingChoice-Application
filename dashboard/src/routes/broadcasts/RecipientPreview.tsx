// RecipientPreview — the editable curated recipient list (the step between
// Preview and Send). Every preview candidate is listed individually with a
// checkbox; the operator can uncheck anyone (the ONLY exclusion mechanism —
// the old per-row Remove duplicated it and could dismiss a fenced no-consent
// row from view, hiding the record-consent reminder), add tenants the filter
// didn't catch (tenant search → append), search-within-recipients (filter by
// name/phone), and bulk Select all / Deselect all. Excluded rows stay VISIBLE
// (auditable: staff can see who's left out and re-check them).
// Flagged rows (already sent, Not interested, a tour hold) render amber. Each
// row starts as the server's checkedByDefault says (matching-blast-rules D5:
// has_consent && (seeded || (!alreadySent && !declined && !tourHold))) and
// "Select all" re-applies it - the dashboard never recomputes the rule. ONE
// client-side case: a row added or PROMOTED by Add a tenant here is a hand
// pick from that moment (checkedByDefault = hasConsent), so it starts checked
// and "Select all" keeps it (share-skip-fix D5 / I4).
// A live selected count drives "Send to N recipients", which posts the EXACT
// checked contactIds.
// 400/409 are surfaced inline. A "Delete draft" button removes the unsent draft.
// last-heard-from (spec 5.3): columns at a 768px+ pane (Name, Status, Housing authority, Last heard from), the COMBINED list ordered by last heard from, and a "Not interested" row (declinedContactIds) that starts unchecked unless seeded and that Select all skips.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  type TourHold,
} from '../../api/index.js';
import { Button, Spinner, StatusBadge } from '../../ui/index.js';
import { formatHeardFrom, sortByHeardFrom } from '../../lib/heardFrom.js';
import { Modal } from '../contact/Modal.js';
import { ContactSearchField, type ContactSearchValue } from '../contact/ContactSearchField.js';
import { contactDisplayName, formatPhone } from '../contact/format.js';
import { tourHoldLabel } from './tourHoldLabel.js';
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
  /** share-skip-fix D5: a deliberate pick (a preview-returned seed, or a tenant
   *  added or picked in this session). Seeded rows start checked even when
   *  already sent, and "Select all" keeps them checked. */
  seeded: boolean;
  /** last-heard-from (spec 5.3): split name parts for the shared name order
   *  (sortByHeardFrom's tie-break) - `name` stays the rendered string. */
  firstName?: string;
  lastName?: string;
  /** The contact's lifecycle status - TENANT rows only (StatusBadge kind="tenant"). */
  status?: string;
  /** Tenant housing authority (blank for a partner seed, spec 14.4 B6). */
  housingAuthority?: string;
  /** contact.last_heard_from_at - the column AND the list order. */
  lastHeardFromAt?: string;
  /** An EFFECTIVE decline of this property (declinedContactIds, D11). */
  declined: boolean;
  /** matching-blast-rules D4: the unresolved tour that holds this tenant. */
  tourHold?: TourHold;
  /** matching-blast-rules D5: the row's default - the server's verdict for a
   *  preview row, hasConsent for a hand pick made here. The initial state
   *  AND "Select all" read it. */
  checkedByDefault: boolean;
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
  /** Resolved 1:1 mode (matching sends): the message was composed for exactly
   *  ONE tenant (the one-to-one default is the address and the flyer link,
   *  share-skip-fix D8, and any edit was written for them), so it must reach
   *  exactly that tenant and nobody else. When set: the add-a-tenant search is
   *  hidden, and Send is blocked unless the checked set is exactly [contactId]. */
  resolvedFor?: { contactId: string; name: string };
  /** The clock the Last heard from column formats against (tests pin it). */
  now?: Date;
}

/** The visible no-consent tag. Its em dash is PINNED by
 *  e2e a2p-compliance.spec.ts (spec 14.4 B7 keeps the visible text), so it
 *  is built from the code point and this source stays ASCII. */
const NO_CONSENT_TAG_TEXT = `consent not recorded ${String.fromCharCode(0x2014)} fix before sending`;

/** The checkbox's accessible name: the person plus every cue, ASCII " - "
 *  (spec 14.4 B7) - so getByRole('checkbox', { name }) resolves by the row.
 *  matching-blast-rules D7: the cues joined with ", " in the order already
 *  sent, not interested, then the tour label in lower case
 *  ("Ana Diaz - already sent, not interested, tour oct 20"). A no-consent row
 *  names its fence alone. */
function checkboxName(row: Row): string {
  if (!row.hasConsent) return `${row.name} - consent not recorded`;
  const cues: string[] = [];
  if (row.alreadySentThisProperty) cues.push('already sent');
  if (row.declined) cues.push('not interested');
  if (row.tourHold !== undefined) cues.push(tourHoldLabel(row.tourHold).toLowerCase());
  return cues.length > 0 ? `${row.name} - ${cues.join(', ')}` : row.name;
}

/** Build the initial rows from the preview candidates (FULL name - a first
 *  name alone does not identify a person at roster scale). */
function initialRows(preview: PreviewResponse, declinedIds: ReadonlySet<string>): Row[] {
  return preview.candidates.map((c) => {
    const row: Row = {
      contactId: c.contactId,
      name: contactDisplayName(c.firstName, c.lastName, c.phone),
      ...(c.firstName !== undefined && { firstName: c.firstName }),
      ...(c.lastName !== undefined && { lastName: c.lastName }),
      phone: c.phone,
      ...(c.status !== undefined && { status: c.status }),
      ...(c.housingAuthority !== undefined && { housingAuthority: c.housingAuthority }),
      ...(c.lastHeardFromAt !== undefined && { lastHeardFromAt: c.lastHeardFromAt }),
      alreadySentThisProperty: c.alreadySentThisProperty,
      declined: declinedIds.has(c.contactId),
      ...(c.tourHold !== undefined && { tourHold: c.tourHold }),
      hasConsent: c.has_consent,
      seeded: c.seeded,
      // matching-blast-rules D5: the server's verdict, as is.
      checkedByDefault: c.checkedByDefault,
      checked: c.checkedByDefault,
    };
    return row;
  });
}

export function RecipientPreview({
  draftId,
  preview,
  tenantCandidates,
  candidatesLoading,
  unitId,
  resolvedFor,
  now: nowProp,
}: RecipientPreviewProps): React.JSX.Element {
  const navigate = useNavigate();
  const priorIds = useMemo(
    () => new Set(preview.priorRecipientContactIds),
    [preview.priorRecipientContactIds],
  );
  const declinedIds = useMemo(() => new Set(preview.declinedContactIds), [preview.declinedContactIds]);
  /** matching-blast-rules D7: EVERY held contact's tour hold - labels a
   *  tenant Add a tenant brings in from outside the candidates. */
  const tourHoldsById = useMemo(
    () =>
      new Map<string, TourHold>(
        preview.tourHolds.map((h) => [
          h.contactId,
          h.at !== undefined ? { kind: h.kind, tourId: h.tourId, at: h.at } : { kind: h.kind, tourId: h.tourId },
        ]),
      ),
    [preview.tourHolds],
  );
  const [mountNow] = useState(() => new Date());
  const now = nowProp ?? mountNow;
  /** The rendered row elements, for the scroll-into-view on add. */
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  /** The contactId an add just placed - scrolled into view after the commit. */
  const pendingScrollRef = useRef<string | null>(null);
  const [rows, setRows] = useState<Row[]>(() => initialRows(preview, declinedIds));
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
  // Resolved 1:1 mode: the message was composed for ONE tenant, so the send must
  // land on exactly that contactId - no more, no fewer. A mismatched selection
  // (extra recipients, or the seeded row unchecked) hard-blocks Send behind an
  // inline explanation.
  const resolvedMismatch =
    resolvedFor !== undefined &&
    !(checkedCount === 1 && rows.some((r) => r.checked && r.contactId === resolvedFor.contactId));
  // A2P/CTIA: how many listed recipients have NO recorded consent (fenced out of
  // the send + surfaced so staff can resolve them — mirrors the skipped counts).
  const noConsentCount = rows.filter((r) => !r.hasConsent).length;

  // last-heard-from (spec 5.3): the dashboard sorts the COMBINED list (audience,
  // seeds and added rows alike) - most recently heard from first, never-heard
  // last, ties by name; the server's order stops mattering.
  const orderedRows = useMemo(
    () =>
      sortByHeardFrom(rows, {
        heardAt: (r) => r.lastHeardFromAt,
        name: (r) => ({
          contactId: r.contactId,
          ...(r.firstName !== undefined && { firstName: r.firstName }),
          ...(r.lastName !== undefined && { lastName: r.lastName }),
          phone: r.phone,
        }),
      }),
    [rows],
  );

  // An added (or promoted) row is scrolled into view so a long list still
  // confirms the pick. `block: 'nearest'` (the AllToursView precedent): a bare
  // scrollIntoView scrolls every scrollable ancestor; nearest moves the list
  // only as far as needed.
  useLayoutEffect(() => {
    const id = pendingScrollRef.current;
    if (id === null) return;
    pendingScrollRef.current = null;
    rowEls.current.get(id)?.scrollIntoView({ block: 'nearest' });
  }, [rows]);

  // Search-within-recipients: filter the visible rows by name/phone (the model
  // keeps every row's checked state; only the rendered set is filtered).
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return orderedRows;
    return orderedRows.filter(
      (r) => r.name.toLowerCase().includes(q) || r.phone.toLowerCase().includes(q),
    );
  }, [orderedRows, query]);

  function toggle(contactId: string): void {
    setRows((prev) =>
      prev.map((r) =>
        // A no-consent row can't be checked (hard fence) — record consent to
        // include them; toggling it is a no-op.
        r.contactId === contactId && r.hasConsent ? { ...r, checked: !r.checked } : r,
      ),
    );
  }

  /** Select all = every row back to its default (matching-blast-rules D5):
   *  the server's checkedByDefault skips unseeded already-sent, declined and
   *  held rows and every no-consent row (hard fence); a hand pick made here
   *  defaults to checked (share-skip-fix D5). */
  function selectAll(): void {
    setRows((prev) => prev.map((r) => ({ ...r, checked: r.checkedByDefault })));
  }
  function deselectAll(): void {
    setRows((prev) => prev.map((r) => ({ ...r, checked: false })));
  }

  /** Add a tenant from the search (must resolve to a contactId). Annotate
   *  already-sent locally via priorRecipientContactIds; a pick of a tenant who is
   *  already listed promotes that row to a seed (checked) instead of adding a
   *  duplicate (share-skip-fix D5). We VALIDATE before clearing the search box
   *  so a can't-add surfaces an inline reason instead of vanishing silently.
   *  Mirrors the server fence: an opted-out / unreachable tenant is NOT added
   *  (the server would drop it anyway). */
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
    pendingScrollRef.current = candidate.contactId;
    // Only a genuine add, or the promotion of a listed row that was not yet a
    // seed, persists to the draft's seed list (a repeat pick of a seed does not).
    const listed = rows.find((r) => r.contactId === candidate.contactId);
    setRows((prev) => {
      if (prev.some((r) => r.contactId === candidate.contactId)) {
        // share-skip-fix D5: picking a tenant who is ALREADY listed (e.g. a
        // filter-proposed row flagged "Already sent", so unchecked) is a
        // deliberate pick too - promote that row to a seed and check it, never
        // discard the pick. A no-consent row stays unchecked (hard fence).
        // matching-blast-rules D5: from this pick on the row is a hand pick,
        // so its default is hasConsent - Select all keeps it checked.
        return prev.map((r) =>
          r.contactId === candidate.contactId
            ? { ...r, seeded: true, checkedByDefault: r.hasConsent, checked: r.hasConsent }
            : r,
        );
      }
      const already = priorIds.has(candidate.contactId);
      const hold = tourHoldsById.get(candidate.contactId);
      return [
        ...prev,
        {
          contactId: candidate.contactId,
          name,
          ...(candidate.firstName !== undefined && { firstName: candidate.firstName }),
          ...(candidate.lastName !== undefined && { lastName: candidate.lastName }),
          phone,
          // spec 14.4 B6: an added row's facts come from the raw contact.
          ...(candidate.status !== undefined && { status: candidate.status }),
          ...(candidate.housingAuthority !== undefined && { housingAuthority: candidate.housingAuthority }),
          ...(candidate.last_heard_from_at !== undefined && { lastHeardFromAt: candidate.last_heard_from_at }),
          alreadySentThisProperty: already,
          // Tagged, but CHECKED: a hand-pick is a seed (share-skip-fix D5,
          // spec 14.4 G3 as amended); the annotate suffix warned before the pick.
          declined: declinedIds.has(candidate.contactId),
          // matching-blast-rules D7: a tenant from outside the candidates is
          // labeled from the top-level tourHolds list.
          ...(hold !== undefined && { tourHold: hold }),
          hasConsent: true,
          // share-skip-fix D5: a hand-pick is a seed from the moment it is added -
          // the same row the server returns as `seeded: true` after a re-preview,
          // so it must not start unchecked here and checked there.
          checkedByDefault: true,
          checked: true,
          added: true,
          seeded: true,
        },
      ];
    });
    if (listed === undefined || !listed.seeded) {
      // Best-effort persistence — a failed PATCH never blocks or surfaces in the
      // review UI (the send still posts the exact checked ids either way).
      seedsRef.current = [...seedsRef.current, candidate.contactId];
      void updateBroadcastSeeds(draftId, seedsRef.current).catch(() => {});
    }
  }

  async function onSend(): Promise<void> {
    if (sending || checkingUnit || checkedCount === 0 || resolvedMismatch) return;
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
          setError('Nothing selected - check at least one recipient to send.');
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

  /** "Add a tenant" note (spec 5.3; matching-blast-rules D7): warns BEFORE
   *  the pick with every cue that applies, in the order Not interested,
   *  Already sent, then the tour label - joined with ", ". */
  const annotateCandidate = (c: Contact): string | undefined => {
    const cues: string[] = [];
    if (declinedIds.has(c.contactId)) cues.push('Not interested');
    if (priorIds.has(c.contactId)) cues.push('Already sent');
    const hold = tourHoldsById.get(c.contactId);
    if (hold !== undefined) cues.push(tourHoldLabel(hold));
    return cues.length > 0 ? cues.join(', ') : undefined;
  };

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
        Flagged recipients you picked stay checked; &quot;Select all&quot; skips the others.
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
            ? "1 added recipient can't receive texts (unknown, opted out, or unreachable) and was left out."
            : `${preview.unresolvedSeedIds.length} added recipients can't receive texts (unknown, opted out, or unreachable) and were left out.`}
        </p>
      ) : null}

      {/* matching-blast-rules D5: a SEEDS-ONLY draft's tour or decline reads
          failed - its rows came back without those labels (seeds stay
          checked). A filter draft's preview is refused instead (503). */}
      {preview.audienceRulesUnavailable === true ? (
        <p className={styles.seedNotice} role="status">
          Tour and Not interested labels couldn&apos;t be loaded.
        </p>
      ) : null}

      {visibleRows.length === 0 ? (
        <p className={styles.emptyBody}>
          {rows.length === 0 ? 'No candidates — add a tenant below.' : 'No recipients match your search.'}
        </p>
      ) : (
        <div className={styles.listFrame}>
          {/* Column headers (spec 5.3, 14.4 B8): OUTSIDE the list so every row
              stays ONE listitem with ONE checkbox (the e2e li selectors and
              partner-share's checkbox count hold). Shown at a 768px+ pane only;
              the rows' column template and the list's stable scrollbar gutter
              keep them aligned. Visual labels - every cell's text is in its row. */}
          <div className={styles.headerRow} aria-hidden="true">
            <span className={styles.headerCheck} />
            <span className={styles.headerCols}>
              <span>Name</span>
              <span>Status</span>
              <span>Housing authority</span>
              <span>Last heard from</span>
              <span />
            </span>
          </div>
          <ul className={styles.rows} aria-label="Candidate recipients">
            {visibleRows.map((row) => {
              const heard = formatHeardFrom(row.lastHeardFromAt, now);
              return (
                <li
                  key={row.contactId}
                  ref={(el) => {
                    if (el) rowEls.current.set(row.contactId, el);
                    else rowEls.current.delete(row.contactId);
                  }}
                  className={`${styles.row} ${!row.hasConsent ? styles.rowNoConsent : row.alreadySentThisProperty || row.declined || row.tourHold !== undefined ? styles.rowAlready : ''}`.trim()}
                >
                  <label className={styles.rowLabel}>
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      // A clean accessible name (checkboxName) so a test or a
                      // screen reader resolves the row by its person, not the
                      // whole row text. A no-consent row is DISABLED (hard fence).
                      aria-label={checkboxName(row)}
                      checked={row.checked}
                      disabled={!row.hasConsent}
                      onChange={() => toggle(row.contactId)}
                    />
                  </label>
                  {/* The name links to the profile in a NEW TAB - the curated list
                      lives in this page's memory, so in-tab navigation would lose
                      it. Outside the checkbox label so the link never toggles.
                      Cells: name + phone | status, authority, last heard from |
                      tags - columns at a 768px+ pane, three stacked lines below. */}
                  <span className={styles.rowBody}>
                    <span className={styles.cellName}>
                      <Link
                        className={styles.rowName}
                        to={`/contacts/${encodeURIComponent(row.contactId)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open profile in a new tab - your recipient list stays put"
                      >
                        {row.name}
                      </Link>
                      <span className={styles.rowPhone}>{formatPhone(row.phone)}</span>
                    </span>
                    <span className={styles.cellFacts}>
                      <span className={styles.cellStatus}>
                        {row.status !== undefined ? <StatusBadge kind="tenant" status={row.status} /> : null}
                      </span>
                      <span className={styles.cellAuthority}>{row.housingAuthority ?? null}</span>
                      {/* The cell's DOM text is the bare label ("Never" or the
                          formatted instant). The narrow layout's "Last heard
                          from " prefix is CSS ::before content, never DOM text
                          (plan review R1 #5: e2e 8.3 asserts the phrase is
                          nowhere inside the list). An empty title is no title
                          (contract N1). */}
                      <span className={styles.cellHeard} {...(heard.title !== '' && { title: heard.title })}>
                        {heard.label}
                      </span>
                    </span>
                    <span className={styles.cellTags}>
                      {!row.hasConsent ? (
                        <span className={styles.noConsentTag}>{NO_CONSENT_TAG_TEXT}</span>
                      ) : (
                        <>
                          {row.alreadySentThisProperty ? <span className={styles.alreadyTag}>Already sent</span> : null}
                          {row.declined ? <span className={styles.declinedTag}>Not interested</span> : null}
                          {/* matching-blast-rules D7: the tour hold, after Not
                              interested, in the same amber tag. */}
                          {row.tourHold !== undefined ? (
                            <span className={styles.declinedTag}>{tourHoldLabel(row.tourHold)}</span>
                          ) : null}
                        </>
                      )}
                      {row.added ? <span className={styles.addedTag}>Added</span> : null}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Add a tenant the filter didn't catch. Hidden in resolved 1:1 mode: the
          message was composed for one tenant, so a broader audience is unsafe. */}
      {resolvedFor === undefined ? (
        <>
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
                annotate={annotateCandidate}
              />
            )}
          </div>
          {addNote !== null ? (
            <p className={styles.addNote} role="alert">
              {addNote}
            </p>
          ) : null}
        </>
      ) : null}

      {/* Resolved 1:1 guard: the selection no longer matches the one tenant the
          message was written for — say so and block Send until it's corrected. */}
      {resolvedMismatch && resolvedFor !== undefined ? (
        <p className={styles.resolvedNote} role="status">
          This message was written for {resolvedFor.name}. Head back to edit the audience or message.
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
          Too many tenants to read - some matches may be missing from this list.
        </p>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.sendBtn}
          disabled={checkedCount === 0 || sending || checkingUnit || resolvedMismatch}
          onClick={() => void onSend()}
        >
          {checkingUnit
            ? 'Checking property…'
            : sending
              ? 'Sending…'
              : `Send to ${checkedCount} recipient${checkedCount === 1 ? '' : 's'}`}
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
            The flyer link in this send only works while the property is Available. Its
            status is currently{' '}
            <strong>{LISTING_STATUS_LABELS[availGate as ListingStatus] ?? availGate}</strong>.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
