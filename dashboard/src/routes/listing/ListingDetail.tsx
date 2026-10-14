// ListingDetail - the Listing detail page (B4), the locked v4 mockup. A
// near-black header band (address - status badge - facts - Edit + the More
// actions kebab, which holds "Send this property") over a two-column body and
// a full-width Photos gallery:
//   LEFT  - a small hero image - a flyer line (View flyer ? + Copy public link)
//           - Property details (incl. the Housing authorities row) - Tour
//           & application process - Activity.
//   RIGHT - Contacts roster - Sent to - Placements on this property - Related
//           properties - Similar properties.
//   BOTTOM (full width) - Photos.
// Real panels come from existing endpoints (unit, placements, units, the landlord
// contact); the C4 "Sent to" + C6 "Similar properties" panels show an
// honest "Arrives with the backend" pending state, and "Activity" serves the unit
// audit trail (pending only on an older backend). Nothing is fabricated.
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  addUnitContact,
  ApiError,
  confirmUnitPhotos,
  deleteUnit,
  getUnit,
  presignUnitPhotos,
  removeUnitContact,
  removeUnitPhoto,
  restoreUnit,
  setListingSendOutcome,
  setUnitPhotoCover,
  uploadToPresignedPost,
  type Contact,
  type ListingSendRow,
  type UnitContact,
  type UnitItem,
  type UnitMediaDisplay,
} from '../../api/index.js';
import { Button, Spinner, StatusBadge, StatusMenu, type StatusTone } from '../../ui/index.js';
import {
  LISTING_STATUSES,
  LISTING_STATUS_LABELS,
  STAGE_LABELS,
  TOUR_TYPE_LABELS,
  setListingStatus,
  tourStatusLabel,
  undatedTourLabel,
  type ListingStatus,
} from '../../api/index.js';
import { BLANK, Card, CardAction, CollapsibleRows, EmptyRow, KV, NotesText, PendingPanel, Row, SendRosterList, SendRosterRow, interestedModeOf, responseClass } from '../contact/Card.js';
import { ContactSearchField, type ContactSearchValue } from '../contact/ContactSearchField.js';
import { Modal } from '../contact/Modal.js';
import { isCaseworkerContact } from '../contact/caseworkerRole.js';
import { PlacementCreateForm } from '../placements/PlacementCreateForm.js';
import { ScheduleTourForm } from '../tours/ScheduleTourForm.js';
import { useListing } from './useListing.js';
import { ROSTER_READ_FAILED_COPY, ROSTER_RETRY_COPY } from './rosterCopy.js';
import { listingRoster, ROLE_LABEL, type RosterRow } from './buildListingFile.js';
import { useContacts } from '../contacts/useContacts.js';
import { tenantName } from '../placements/placementsFormat.js';
import { ListingActionsMenu } from './ListingActionsMenu.js';
import { ListingEditForm } from './ListingEditForm.js';
import { RestoreLandlordDialog } from './RestoreLandlordDialog.js';
import {
  authoritiesOf,
  buildListingFacts,
  describeUnitActivity,
  formatBedsBaths,
  formatMoney,
  formatRent,
  groupSendRows,
  isMediaUrl,
  sendRowKindLabel,
  shortAddress,
  statusLabel,
} from './listingFormat.js';
import { formatDayDivider, formatTime } from '../contact/format.js';
import { safeHttpUrl } from '../../lib/safeUrl.js';
import { contactTypeErrorMessage } from '../../lib/contactTypeErrors.js';
import styles from './ListingDetail.module.css';

// Property-status -> the interactive status pill's tone. `available` is the one
// publicly-shareable status (green); under_application/finalizing/occupied read as
// a settled/in-progress (placed) tone; the rest fall back to the neutral tone.
const STATUS_TONE: Record<ListingStatus, StatusTone> = {
  setup: 'inactive',
  available: 'available',
  under_application: 'placed',
  finalizing: 'placed',
  occupied: 'placed',
  on_hold: 'inactive',
  off_market: 'inactive',
};

// Property-status ? status-dot colour for the related-properties rows.
const STATUS_DOT: Record<ListingStatus, string> = {
  setup: responseClass.muted,
  available: responseClass.available,
  under_application: responseClass.placed,
  finalizing: responseClass.placed,
  occupied: responseClass.placed,
  on_hold: responseClass.muted,
  off_market: responseClass.inactive,
};

/** How many rows the Related / Similar property lists show before collapsing. */
const RELATED_LIMIT = 4;

/** The roster roles the Contacts card can set, in menu order. Mirrors the
 *  server's UNIT_CONTACT_ROLES (app/src/repos/unitsRepo.ts) - the route 400s on
 *  anything else; ROLE_LABEL supplies each one's display word. */
const ROSTER_ROLES: readonly UnitContact['role'][] = ['landlord', 'pm', 'owner', 'other'];

/** The busy/error key for the "+ Add contact" form (rows key on contactId). */
const ADD_ROW_KEY = 'add-contact';

/** The reason the landlord of record's remove is disabled. `landlordId` IS who
 *  owns the property; the roster row for them is structural, so the operator
 *  reassigns the property's landlord first (spec 6.1 / D2). */
const LANDLORD_OF_RECORD_REASON = "Landlord of record - reassign the property's landlord first";

/** The row we tried to remove is (now) the landlord of record. Rendered inline
 *  ON the row, and the card refetches so the row settles into the state that won
 *  the race (spec 6.1). */
const ROSTER_CONFLICT_COPY =
  "That contact is the landlord of record now - reassign the property's landlord first.";

/** A 409 primary_contact_deleted (primary-contact-integrity spec 7.4): Make
 *  primary on a contact who was deleted. Its own sentence - not the
 *  landlord-of-record catch-all above. */
const PRIMARY_CONTACT_DELETED_COPY = 'That contact was deleted - restore them first or choose someone else.';

/** The remove-the-primary confirm (spec 7.3), word for word: no heir, an heir
 *  with no name on record, and no propertyContact block (could not tell). The
 *  named-heir sentence is built in promotionNotice. */
const NO_HEIR_NOTICE =
  "This property will have no primary contact. New tours won't include a landlord, and tour group texts will use the general intro.";
const UNNAMED_HEIR_NOTICE = 'Another contact on this property becomes the primary contact.';
const UNKNOWN_HEIR_NOTICE = 'Another contact on this property may become the primary contact.';

/** Adding a second Landlord label must not silently replace the property's
 *  actual landlordId. Point the operator to the explicit reassignment flow. */
const LANDLORD_REASSIGNMENT_COPY =
  'This property already has a landlord of record - reassign it before choosing Landlord.';

/** The no-primary box (primary-contact-integrity spec 7.4), word for word.
 *  The lead names the case; the effect sentence follows it. */
const NO_PRIMARY_LEAD = 'No primary contact.';
const DELETED_CONTACT_LEAD = "This property's contact was deleted.";
const NO_PRIMARY_EFFECT = "New tours won't include the landlord, and tour group texts use the general intro.";
/** No eligible row to offer (no live contact, or only caseworkers). True: an
 *  eligible add on a property with no live primary and no live landlord of
 *  record is made primary by the server (spec 4.4). It names a property
 *  manager or owner, not "the landlord": while a DELETED contact is still the
 *  landlord of record, an add with the Landlord role is refused (409
 *  landlord_reassignment_required), and a property manager or owner always
 *  works (builder Q1, planner fix wave F3). */
const NO_ELIGIBLE_LINE = 'Add a property manager or owner - they become the primary automatically.';

/** The busy/error key for the box's one-click Make primary: its error renders
 *  IN the box, which shows outside edit mode too. */
const NO_PRIMARY_BOX_KEY = 'no-primary-box';

// Mirror of app/src/lib/unitMedia.ts UNIT_MEDIA_MAX (the dashboard has no import
// path into the app lib). An abuse/runaway BACKSTOP, not a product limit; keep in
// sync if the server cap changes.
const UNIT_MEDIA_MAX = 100;

// The image types the upload endpoint accepts (mirror of the app's
// IMAGE_MEDIA_TYPES: jpeg/png/gif/webp). Hints the OS file picker; the server
// re-validates every file regardless.
const PHOTO_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp';

/** Files per presign WAVE (unit-photos direct-upload R4). Mirrors the server's
 *  UNIT_PHOTO_PRESIGN_BATCH_MAX (a per-request politeness bound, NOT a memory
 *  bound - the bytes go browser->S3 directly). A selection larger than this
 *  uploads in sequential 20-file waves (presign -> parallel direct POSTs ->
 *  confirm per wave), so a 100-photo drag-drop still works end to end. Keep it
 *  coupled to that server constant if it changes. */
const PHOTO_PRESIGN_WAVE_SIZE = 20;

/** How many direct-to-S3 POSTs run concurrently within a wave. The bytes never
 *  touch the app, so this is purely browser civility (avoid opening 20 sockets
 *  at once); 5 keeps uploads brisk without hammering the connection pool. */
const PHOTO_UPLOAD_CONCURRENCY = 5;

/** Mirror of the server's UNIT_PHOTO_SOURCE_MAX_BYTES presign policy cap - a
 *  file over this is rejected by S3 itself, so drop it client-side with an
 *  honest, NAMED message instead of a doomed upload. Server re-enforces. */
const PHOTO_MAX_SOURCE_BYTES = 20 * 1024 * 1024;

/** Mirror of UNIT_PHOTO_PASSTHROUGH_MAX_BYTES: a file over this transcodes at
 *  confirm (one sharp run behind a 2-slot server gate), so each such file is
 *  confirmed in its OWN request - a batch of transcodes serialized in one
 *  request could brush CloudFront's 30s origin timeout. */
const PHOTO_TRANSCODE_THRESHOLD_BYTES = 5 * 1024 * 1024;

/** An honest, staff-facing message for a photo-upload failure (the app 400 carries
 *  a machine `error` code on `ApiError.code`; map the known ones, else a generic
 *  retry). GLOSSARY: staff copy says "property" / "photo". */
function photoUploadMessage(err: unknown): string {
  const code = err instanceof ApiError ? err.code : '';
  switch (code) {
    case 'unsupported_media_type':
      return "That file type isn't supported - add JPEG, PNG, GIF, or WebP photos.";
    case 'photo_cap_exceeded':
      return 'That would go past the 100-photo limit for this property.';
    case 'no_valid_photos':
      return "None of the photos could be uploaded - please try again.";
    case 'media_storage_unavailable':
      return "Photo storage isn't available right now - please try again later.";
    case 'transcode_busy':
      return 'The server is busy fitting large photos - wait a moment, then add just the large photo(s) again.';
    case 'transcode_failed':
      return "A large photo couldn't be processed - it may be corrupted. Re-export it and try again.";
    case 'rate_limited':
      return 'Uploads are being rate limited - wait a minute, then add the remaining photos.';
    default:
      return "Couldn't upload the photos - please try again.";
  }
}

/** The stored landlord's name a 409 restore_needs_landlord carries, when it
 *  names one (caseworker-integrity spec section 4 "Restore"). */
function restoreLandlordName(err: ApiError): string | undefined {
  const body = err.body;
  if (body === null || typeof body !== 'object') return undefined;
  const name = (body as Record<string, unknown>)['landlordName'];
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/** The deleted banner's sentence after the restore dialog's choice answered
 *  409 restore_landlord_not_needed and the re-read property is still deleted
 *  (caseworker-integrity spec revision 7 section 4 "Restore" and "Dashboard
 *  copy for section 4"): the page's own sentence, not the shared helper's. */
const RESTORE_LANDLORD_CHANGED_COPY =
  "This property's landlord changed while you were choosing. Choose Restore again.";

export function ListingDetail(): React.JSX.Element {
  const { unitId = '' } = useParams<{ unitId: string }>();
  const navigate = useNavigate();
  const state = useListing(unitId);
  // Contacts back the "Placements on this property" + "Tours on this property"
  // rows: resolve each row's tenantId to a display name (falls back to the id
  // when a contact hasn't loaded). Soft-deleted contacts are included too — a
  // closed placement/tour routinely outlives its tenant (same fix as the tours
  // list + placements board, 2026-08-03); live records are set LAST so a
  // defensive id collision resolves to the live record.
  const { contacts: contactsList } = useContacts('all');
  const { contacts: deletedContactsList } = useContacts('deleted');
  const contactsMap = useMemo(() => {
    const m = new Map<string, Contact>();
    for (const c of deletedContactsList) m.set(c.contactId, c);
    for (const c of contactsList) m.set(c.contactId, c);
    return m;
  }, [contactsList, deletedContactsList]);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // caseworker-integrity (spec section 4 "Restore"): set when a plain restore
  // answered 409 restore_needs_landlord - opens the landlord dialog. It records
  // the property it opened for and is RESET when the route's unitId moves on
  // (R1 code review, dashboard finding 8): the /listings/:unitId element is not
  // keyed, so a history move to another property re-renders this same
  // instance, and the dialog must neither survive it nor post its choice
  // against the other property. Reset during render (React's "adjust state
  // when a prop changes"), so no frame shows the dialog over the wrong property.
  const [restoreNeeds, setRestoreNeeds] = useState<{ unitId: string; landlordName?: string } | null>(null);
  if (restoreNeeds !== null && restoreNeeds.unitId !== unitId) setRestoreNeeds(null);
  // caseworker-integrity spec revision 7 section 4 "Restore" (final review
  // round 2 R2-1): set when the dialog's choice answered 409
  // restore_landlord_not_needed and the property is still deleted after the
  // re-read - the deleted banner then says why the dialog closed. The next
  // Restore press clears it; like restoreNeeds it records the property it was
  // set for and is reset during render when the route's unitId moves on.
  const [restoreNotice, setRestoreNotice] = useState<{ unitId: string } | null>(null);
  if (restoreNotice !== null && restoreNotice.unitId !== unitId) setRestoreNotice(null);
  const [editing, setEditing] = useState(false);
  // The "Start placement" dialog, pre-filled+locked to this property's unit.
  const [startingPlacement, setStartingPlacement] = useState(false);
  // The "Schedule a tour" dialog (markup R4) opens ONLY from the URL:
  // `?tour=new` (free tenant) or `?tour=new&tenantId=<id>` (that tenant
  // pre-committed and LOCKED in the form, spec 14.3 B9), unit side
  // pre-committed to this property. Every entry point NAVIGATES there - "+
  // Tour", a form-mode Interested click, a partner row's "Request a tour"
  // link, and the waiting list on another page - so a param change while this
  // page is mounted opens it, and Cancel / create clear both params so Back
  // and refresh never reopen it. On this page both the open and the close are
  // REPLACE navigations: the dialog adds no history entry.
  const [searchParams, setSearchParams] = useSearchParams();
  // The "Sent to" rows' date labels read one clock per page mount (a lazy
  // initializer keeps render pure).
  const [now] = useState(() => new Date());
  const { setUnit, setRecipientRow } = state;
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  // Photos: the hidden file input, upload/cover busy + inline error, and the
  // per-photo Remove confirm (the entry being confirmed; modal open while non-null).
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [removingEntry, setRemovingEntry] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // --- Contacts card edit mode (contact-rosters spec 6.1 / D9) --------------
  // `rosterUnit` is the AUTHORITATIVE unit after a roster write. Every
  // unit-contact endpoint returns the whole updated unit (enriched contacts[],
  // landlordId, the primary_contact scalar), so applying that response is both
  // how each action persists ON CLICK and how a lost race settles: on a 409 we
  // refetch the property into here and the toggled row re-renders into its TRUE
  // state. Held per unitId so navigating to another property drops it.
  const [editingContacts, setEditingContacts] = useState(false);
  const [rosterUnit, setRosterUnit] = useState<UnitItem | null>(null);
  /** The row currently being written (contactId, or ADD_ROW_KEY); null = idle.
   *  One write at a time - a roster is small and the writes are read-modify-write
   *  server-side. */
  const [rosterBusy, setRosterBusy] = useState<string | null>(null);
  const [rosterError, setRosterError] = useState<{ key: string; message: string } | null>(null);
  const [addingContact, setAddingContact] = useState(false);
  const [addContactValue, setAddContactValue] = useState<ContactSearchValue>({ name: '' });
  const [addContactRole, setAddContactRole] = useState<UnitContact['role']>('pm');
  /** The roster row whose removal is awaiting the promotion confirm (spec 6.1);
   *  only the CURRENT primary contact ever lands here. */
  const [removingContact, setRemovingContact] = useState<RosterRow | null>(null);

  // Property-status write - goes through the transition service (status is NOT
  // writable via a plain unit PATCH). On success apply the returned unit in
  // place (no refetch) and clear any prior error. On failure surface an inline
  // error (the select reverts to the unit's stored status, so without feedback a
  // failed change would silently vanish). Manual source; no reason needed.
  function onChangeStatus(toStatus: ListingStatus): void {
    if (statusBusy || !state.unit || toStatus === state.unit.status) return;
    setStatusBusy(true);
    // Clear any prior error at ATTEMPT start (matches PlacementDetail's
    // runTransition) so a retry never renders a stale message.
    setStatusError(null);
    void setListingStatus(state.unit.unitId, { toStatus, source: 'manual' })
      .then((updated) => setUnit(updated))
      .catch(() => {
        setStatusError("Couldn't update the property status - please try again.");
      })
      .finally(() => setStatusBusy(false));
  }

  if (state.status === 'loading') {
    return (
      <div className={styles.center}>
        <Spinner center />
      </div>
    );
  }

  if (state.status === 'error' || !state.unit) {
    return (
      <div className={styles.center}>
        <p role="alert" className={styles.error}>
          We couldn&apos;t load this property.
        </p>
      </div>
    );
  }

  const { unit, roster, placementsOnUnit, related, recipients, similar, activity, tours } = state;
  const address = shortAddress(unit.address, unit.unitId);
  // The Contacts roster: the hook's rows until a roster write answers, then the
  // server's own response (see `rosterUnit`). The unitId guard keeps a stale
  // property's roster from leaking onto the next one.
  const contactsUnit = rosterUnit !== null && rosterUnit.unitId === unit.unitId ? rosterUnit : null;
  const contactRows: RosterRow[] =
    contactsUnit !== null ? listingRoster(contactsUnit, state.landlord) : roster;
  // The property-contact block (primary-contact-integrity spec 7.5) comes from
  // the SAME roster source as the rows: a roster write's (or a re-read's) own
  // block, else the load-time GET's. Absent = the server could not tell.
  const propertyContact = contactsUnit !== null ? contactsUnit.propertyContact : state.propertyContact;
  /** Who OWNS the property (`unit.landlordId`) - never removable from the
   *  roster. Who takes over when the primary leaves is the SERVER's call
   *  (propertyContact.heirIfPrimaryRemoved, primary-contact-integrity 7.3). */
  // An ownerless property (legacy, or restored without a landlord -
  // caseworker-integrity section 4) has NO landlordId (UnitItem.landlordId is
  // optional); read it as '' (the "no landlord" branch) so nothing below
  // touches undefined.
  const landlordOfRecord: string = contactsUnit?.landlordId ?? unit.landlordId ?? '';
  // The facts subline names a LIVE contact's company (primary-contact-integrity
  // spec 7.4): a row whose contact is deleted is skipped, primary or not.
  const liveRows = contactRows.filter((r) => r.deleted !== true);
  const landlordName = liveRows.find((r) => r.primaryContact)?.company ?? liveRows[0]?.company;
  const facts = buildListingFacts(unit, landlordName);
  // The authorities whose vouchers this property accepts - ONE synthesized list
  // (spec section 8) behind the single "Housing authorities" detail row that
  // replaced the old Jurisdiction KV and the accepted-vouchers bulleted list.
  const authorities = authoritiesOf(unit);
  // The gallery renders resolved display media (presign-per-read). The server
  // attaches `mediaDisplay` alongside the raw `media`; on an older response with
  // only `media`, derive it (legacy absolute URLs pass through, bare keys become
  // url-absent "unavailable" tiles - E2).
  const mediaDisplay: UnitMediaDisplay[] =
    unit.mediaDisplay ??
    (unit.media ?? []).map((entry) => (isMediaUrl(entry) ? { entry, url: entry } : { entry }));
  // Hero = the COVER (first entry) when it has a display URL, else today's fallback.
  const coverUrl = mediaDisplay[0]?.url;
  const atPhotoCap = mediaDisplay.length >= UNIT_MEDIA_MAX;
  // Only an http(s) video link becomes clickable (never javascript:/data:/… — XSS).
  const videoUrl = safeHttpUrl(unit.video_url);
  // Public flyer: live only for a shareable (available) unit, at the same-origin
  // /p/:unitId funnel (what flyerUrl() emits). Copy the absolute public URL.
  const flyerShareable = unit.status === 'available';
  const onCopyFlyerLink = (): void => {
    void navigator.clipboard
      ?.writeText(`${window.location.origin}/p/${encodeURIComponent(unit.unitId)}`)
      .then(() => {
        setCopiedLink(true);
        window.setTimeout(() => setCopiedLink(false), 1500);
      })
      .catch(() => {
        /* clipboard unavailable/blocked - no-op */
      });
  };

  // Soft-delete (reversible). Deleting is confirmed first, then the property drops
  // out of the normal views - so on success we navigate back to the Properties list
  // (it can be restored from the Deleted tab). Restore stays on the page and
  // applies the returned unit in place so the Deleted banner clears.
  const deleted = typeof unit.deleted_at === 'string' && unit.deleted_at.length > 0;
  // Shared by both entry points to the send composer (the kebab item and the
  // "Sent to" card's "+ Send" action) - one URL, one place it's built.
  const goToSend = (): void => void navigate(`/broadcasts/new?unitId=${encodeURIComponent(unit.unitId)}`);
  // The URL-driven tour form (never on a deleted property - "+ Tour" is hidden
  // there too).
  const tourFormOpen = !deleted && searchParams.get('tour') === 'new';
  const tourFormTenant = searchParams.get('tenantId') ?? undefined;
  /** Open the form by NAVIGATING in place (replace): the dialog adds NO
   *  history entry, so open + Cancel leaves one entry and Back leaves the
   *  property page as before (plan review round 2). */
  const openTourForm = (tenantId?: string): void => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('tour', 'new');
        if (tenantId !== undefined) next.set('tenantId', tenantId);
        else next.delete('tenantId');
        return next;
      },
      { replace: true },
    );
  };
  /** Close it: strip BOTH params in place (replace). */
  const closeTourForm = (): void => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('tour');
        next.delete('tenantId');
        return next;
      },
      { replace: true },
    );
  };
  // One outcome action on a "Sent to" row: the route answers { row } (plan
  // head 3.4 #4), applied in place (no refetch). A rejection propagates to
  // the row, which shows its inline error.
  const onRecipientOutcome = async (contactId: string, outcome: 'interested' | 'not_interested' | 'clear'): Promise<void> => {
    const { row } = await setListingSendOutcome(unit.unitId, contactId, outcome);
    setRecipientRow(unit.unitId, contactId, row);
  };
  const onConfirmDelete = (): void => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    void deleteUnit(unit.unitId)
      .then(() => {
        setConfirmingDelete(false);
        void navigate('/listings');
      })
      .catch(() => {
        setDeleteError("Couldn't delete - please try again.");
        setDeleteBusy(false);
      });
  };
  const onRestore = (): void => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    // A new press answers for itself: the last landlord-changed sentence goes.
    setRestoreNotice(null);
    void restoreUnit(unit.unitId)
      .then((updated) => {
        setUnit(updated);
        // primary-contact-integrity spec 7.5: re-read the property and make
        // the re-read the Contacts card's roster source, REPLACING any earlier
        // roster-write response (a restore answers with no propertyContact
        // block). Best-effort: on a failed re-read the card keeps what it had.
        void getUnit(unit.unitId)
          .then((fresh) => {
            setRosterUnit(fresh);
            setUnit(fresh);
          })
          .catch(() => {
            /* best-effort re-read */
          });
      })
      .catch((err: unknown) => {
        // The stored landlord can't stay this property's landlord (gone, or no
        // longer a landlord): choose one - or none - in the dialog instead of
        // a dead click (caseworker-integrity spec section 4 "Restore").
        if (err instanceof ApiError && err.status === 409 && err.code === 'restore_needs_landlord') {
          const landlordName = restoreLandlordName(err);
          setRestoreNeeds({ unitId: unit.unitId, ...(landlordName !== undefined && { landlordName }) });
          return;
        }
        /* any other failure: leave it deleted; the action re-enables for a retry */
      })
      .finally(() => setDeleteBusy(false));
  };

  // --- Contacts card edit mode (spec 6.1 / D9) ------------------------------
  // This card is where the property's PRIMARY CONTACT is set: the person new
  // tours and placements put on their people list and the tour intro names
  // (no live call routing reads it - primary-contact-integrity spec 9.2). A
  // deleted property is read-only, like every other card here.
  const contactsEditing = editingContacts && !deleted;
  const rosteredIds = new Set(contactRows.map((r) => r.contactId));
  /** Search candidates for "+ Add contact": every live contact NOT already on
   *  the roster (re-adding a rostered contact is a re-role, which the row's own
   *  selector does). Never a caseworker: a caseworker can't take a NEW seat on
   *  a property's contact list (caseworker-integrity I4; the server refuses
   *  with 409 contact_list_caseworker). */
  const addContactCandidates = contactsList.filter(
    (c) => !rosteredIds.has(c.contactId) && !isCaseworkerContact(c),
  );
  // The no-primary box (spec 7.4). Shown only when the server TOLD us there
  // is no property contact (block present, contactId null), the property has
  // at least one row, and it is live (the card is read-only on a deleted
  // property). Its action counts ELIGIBLE rows - live and not a caseworker,
  // both from the server's row flags. That is broader than the server's
  // AUTOMATIC rule (typed landlord) on purpose: this is a deliberate click,
  // and the button names the person before it writes.
  const showNoPrimaryBox =
    !deleted && propertyContact !== undefined && propertyContact.contactId === null && contactRows.length > 0;
  const eligibleRows = contactRows.filter((r) => r.deleted !== true && r.caseworker !== true);
  const soleEligible = eligibleRows.length === 1 ? eligibleRows[0] : undefined;

  /** The server's answer IS the new truth - apply it to the card AND the page. */
  const applyRosterUnit = (updated: UnitItem): void => {
    setRosterUnit(updated);
    setUnit(updated);
  };

  const closeAddContact = (): void => {
    setAddingContact(false);
    setAddContactValue({ name: '' });
    setAddContactRole('pm');
  };

  /**
   * Run one roster write. EVERY action persists the moment it is clicked (spec
   * D5) - there is never a pending edit to lose, so "Done" is only a view
   * toggle. On a 409 the reason renders inline ON the row AND the property is
   * refetched, so the row the operator just toggled visibly settles into the
   * state that won the race rather than reading as a dead click (spec 6.1).
   */
  const runRosterWrite = (
    key: string,
    write: () => Promise<UnitItem>,
    onSuccess?: () => void,
  ): void => {
    if (rosterBusy !== null) return;
    setRosterBusy(key);
    setRosterError(null);
    void write()
      .then((updated) => {
        applyRosterUnit(updated);
        onSuccess?.();
      })
      .catch(async (err: unknown) => {
        // The settle: re-read the property onto the card AND the page.
        const settle = async (): Promise<void> => {
          try {
            applyRosterUnit(await getUnit(unit.unitId));
          } catch {
            /* the refetch is the settle; on failure the inline reason still stands */
          }
        };
        // caseworker-integrity (spec section 4): a contact-type refusal
        // (contact_list_caseworker, landlord_not_landlord) names its own reason.
        // Mapped BEFORE the 409 catch-all below, whose copy would otherwise
        // claim "landlord of record". It settles like the catch-all (final
        // review A3, fix wave FWF-2): this request wrote nothing. These codes
        // come from the route's own pre-checks with no race at all (an API
        // caller, or a stale picker) as well as from the roster write, which
        // answers them when the property changed after the route's read (a
        // seat removed, the landlord cleared) - exactly when the card is
        // stale. In the no-race case the extra re-read is harmless (final
        // review round 2 R2-F5).
        const typed = contactTypeErrorMessage(err);
        if (typed !== null) {
          setRosterError({ key, message: typed });
          await settle();
          return;
        }
        // primary-contact-integrity spec 7.3: removing the primary could not
        // check who takes over (a contact read failed), so the server wrote
        // nothing. Not a race - no settle; the operator tries again.
        if (err instanceof ApiError && err.status === 503 && err.code === 'roster_read_failed') {
          setRosterError({ key, message: ROSTER_READ_FAILED_COPY });
          return;
        }
        const conflict = err instanceof ApiError && err.status === 409;
        setRosterError({
          key,
          message: conflict
            ? err.code === 'landlord_reassignment_required'
              ? LANDLORD_REASSIGNMENT_COPY
              : err.code === 'unit_roster_conflict'
                ? ROSTER_RETRY_COPY
                : err.code === 'primary_contact_deleted'
                  ? PRIMARY_CONTACT_DELETED_COPY
                  : ROSTER_CONFLICT_COPY
            : "Couldn't save that change - please try again.",
        });
        if (!conflict) return;
        await settle();
      })
      .finally(() => setRosterBusy(null));
  };

  /** Re-role a row: the POST is an upsert, so its CURRENT primary flag rides
   *  along untouched (dropping it would silently unset the primary contact). */
  const onSetContactRole = (row: RosterRow, role: UnitContact['role']): void => {
    runRosterWrite(row.contactId, () =>
      addUnitContact(unit.unitId, {
        contactId: row.contactId,
        role,
        primaryContact: row.primaryContact,
      }),
    );
  };

  /** Promote a row to the property's primary contact - the same upsert with
   *  `primaryContact: true`; the server demotes whoever held it. Idempotent.
   *  `key` is where its busy state and error land: the row's own slot in edit
   *  mode, or the no-primary box (spec 7.4), which shows outside edit mode. */
  const onMakePrimaryContact = (row: RosterRow, key: string = row.contactId): void => {
    runRosterWrite(key, () =>
      addUnitContact(unit.unitId, {
        contactId: row.contactId,
        role: row.role,
        primaryContact: true,
      }),
    );
  };

  const removeContactRow = (row: RosterRow): void => {
    runRosterWrite(
      row.contactId,
      () => removeUnitContact(unit.unitId, row.contactId),
      () => setRemovingContact(null),
    );
  };

  /** Removing the CURRENT primary contact changes who new tours and relay
   *  groups for this property use, so it confirms first and NAMES who takes
   *  over (primary-contact-integrity spec 7.3). Any other row removes on
   *  click. */
  const onRemoveContactRow = (row: RosterRow): void => {
    if (row.primaryContact) {
      setRosterError(null);
      setRemovingContact(row);
      return;
    }
    removeContactRow(row);
  };

  /** The remove-the-primary confirm's sentence (primary-contact-integrity spec
   *  7.3). WHO takes over is the server's call, read from the propertyContact
   *  block's `heirIfPrimaryRemoved` (the heir function with the primary
   *  excluded) - never a client-side copy of that rule. The block carries the
   *  heir's name even for an off-roster landlord of record. "calls and" is
   *  gone from the old sentence: the scalar drives no live call routing. An
   *  absent block means the server could not tell. */
  const promotionNotice = (): string => {
    if (propertyContact === undefined) return UNKNOWN_HEIR_NOTICE;
    const heir = propertyContact.heirIfPrimaryRemoved;
    if (heir === null) return NO_HEIR_NOTICE;
    return heir.name !== undefined && heir.name.length > 0
      ? `${heir.name} becomes the primary contact - new tours and relay groups for this property will use them.`
      : UNNAMED_HEIR_NOTICE;
  };

  const onAddContact = (): void => {
    const contactId = addContactValue.contactId;
    if (contactId === undefined) return;
    runRosterWrite(
      ADD_ROW_KEY,
      () => addUnitContact(unit.unitId, { contactId, role: addContactRole, primaryContact: false }),
      closeAddContact,
    );
  };

  // Photos: "+ Add" opens the hidden multi-select file input; the chosen files
  // upload DIRECTLY to S3 (unit-photos direct-upload R4). A 20MB pre-check runs
  // first: any file over PHOTO_MAX_SOURCE_BYTES (the presign policy cap S3 itself
  // enforces) is dropped up front with a NAMED inline alert and the rest proceed.
  // Per wave of up to PHOTO_PRESIGN_WAVE_SIZE in-limit files: (1) presign mints
  // one grant per file; (2) the browser POSTs each file straight to its presigned
  // S3/MinIO target, in parallel with a modest concurrency pool - the bytes never
  // touch the app, so there is no memory concern; (3) confirm records the keys
  // that uploaded OK, SPLIT BY SIZE - files at/under PHOTO_TRANSCODE_THRESHOLD_BYTES
  // go in one batch, each larger file in its OWN confirm request (its server-side
  // transcode runs alone, so a serialized batch never brushes CloudFront's 30s
  // origin timeout). The updated unit is applied after EACH confirm (already-stored
  // photos persist + render even if a later confirm fails). Honest partial handling:
  // a single file that fails to reach S3 is dropped and the confirm records the
  // rest; if fewer than all in-limit files uploaded the inline alert says "Uploaded
  // N of M" (with any oversize-drop message appended so it is never lost).
  // A presign/confirm failure surfaces the mapped server error. Reset the input
  // so re-picking the SAME file fires change again.
  const onPickPhotos = (): void => photoInputRef.current?.click();
  const onFilesChosen = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const input = e.currentTarget;
    const picked = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (picked.length === 0 || photoBusy) return;
    // 20MB pre-check: a file over the presign policy cap would 400 at S3 -
    // drop it here with a NAMED message and upload the rest.
    const tooBig = picked.filter((f) => f.size > PHOTO_MAX_SOURCE_BYTES);
    const chosen = picked.filter((f) => f.size <= PHOTO_MAX_SOURCE_BYTES);
    const oversizeMsg =
      tooBig.length > 0
        ? `${tooBig
            .map((f) => `${f.name} is ${(f.size / (1024 * 1024)).toFixed(1)}MB`)
            .join(', ')} - the limit is 20MB per photo.`
        : null;
    if (chosen.length === 0) {
      setPhotoError(oversizeMsg);
      return;
    }
    setPhotoBusy(true);
    setPhotoError(null);
    void (async () => {
      const total = chosen.length;
      let uploaded = 0;
      // The last confirm-batch failure, adjudicated AFTER all batches settle
      // (review N2, Cameron 2026-07-21) - a transient 503/429 on one big-file
      // confirm must not discard the later batches' already-uploaded bytes.
      let confirmError: unknown;
      try {
        // Sequential 20-file waves keep each presign request within the server's
        // per-request batch max; the direct POSTs inside a wave run in parallel.
        for (let w = 0; w < chosen.length; w += PHOTO_PRESIGN_WAVE_SIZE) {
          const wave = chosen.slice(w, w + PHOTO_PRESIGN_WAVE_SIZE);
          const grants = await presignUnitPhotos(unit.unitId, wave);
          // Simple concurrency pool: at most PHOTO_UPLOAD_CONCURRENCY direct
          // POSTs in flight; each worker pulls the next index until the wave is
          // drained. grants[i] pairs with wave[i] (the server keeps order).
          const okSmallKeys: string[] = [];
          const okBigKeys: string[] = [];
          let next = 0;
          const worker = async (): Promise<void> => {
            while (next < wave.length) {
              const i = next++;
              const grant = grants[i];
              const file = wave[i];
              if (grant === undefined || file === undefined) continue;
              try {
                await uploadToPresignedPost(grant.post, file);
                if (file.size > PHOTO_TRANSCODE_THRESHOLD_BYTES) okBigKeys.push(grant.key);
                else okSmallKeys.push(grant.key);
              } catch {
                // A single file failed to reach S3 - drop it (honest partial).
              }
            }
          };
          await Promise.all(
            Array.from({ length: Math.min(PHOTO_UPLOAD_CONCURRENCY, wave.length) }, () => worker()),
          );
          // Confirm small files as one batch; each >5MB file in its OWN request
          // (one server-side transcode per request - see the threshold const).
          const confirmBatches = [
            ...(okSmallKeys.length > 0 ? [okSmallKeys] : []),
            ...okBigKeys.map((k) => [k]),
          ];
          for (const batch of confirmBatches) {
            // Settle EVERY batch (review N2): catch per batch so one failed
            // confirm never abandons the later batches' uploads; failures
            // adjudicate together below. Deliberately SEQUENTIAL, not
            // Promise.all - parallel confirms from one client would contend
            // the shared 2-slot server transcode gate and the per-user
            // confirm limiter for no wall-clock win.
            try {
              const updated = await confirmUnitPhotos(unit.unitId, batch);
              uploaded += batch.length;
              setUnit(updated);
            } catch (err) {
              confirmError = err;
            }
          }
        }
        if (uploaded < total) {
          // Partial failure: S3-upload drops keep the generic copy; a confirm
          // failure surfaces its mapped server error instead. If an oversize
          // file was ALSO dropped up front, append its named message so it is
          // never silently lost (DEC-5c).
          const base =
            confirmError !== undefined
              ? photoUploadMessage(confirmError)
              : "some photos couldn't be uploaded. Please try again.";
          setPhotoError(
            `Uploaded ${uploaded} of ${total} photos - ${base}${
              oversizeMsg ? ` ${oversizeMsg}` : ''
            }`,
          );
        } else if (oversizeMsg) {
          setPhotoError(oversizeMsg);
        }
      } catch (err) {
        const base = photoUploadMessage(err);
        setPhotoError(
          uploaded > 0 ? `Uploaded ${uploaded} of ${total} photos - ${base}` : base,
        );
      } finally {
        setPhotoBusy(false);
      }
    })();
  };
  const onMakeCover = (entry: string): void => {
    if (photoBusy) return;
    setPhotoBusy(true);
    setPhotoError(null);
    void setUnitPhotoCover(unit.unitId, entry)
      .then((updated) => setUnit(updated))
      .catch(() => setPhotoError("Couldn't update the cover photo - please try again."))
      .finally(() => setPhotoBusy(false));
  };
  const onConfirmRemove = (): void => {
    if (removingEntry === null || removeBusy) return;
    setRemoveBusy(true);
    setRemoveError(null);
    void removeUnitPhoto(unit.unitId, removingEntry)
      .then((updated) => {
        setUnit(updated);
        setRemovingEntry(null);
      })
      .catch(() => setRemoveError("Couldn't remove the photo - please try again."))
      .finally(() => setRemoveBusy(false));
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <div className={styles.titleRow}>
            <h1 className={styles.name}>{address}</h1>
            {/* Interactive status pill: shows the current status AND changes it
                (one control, so the header no longer duplicates a badge + a select).
                A soft-DELETED property gets a display-only badge instead — no live
                status control on a deleted record (matches the contact header). */}
            {deleted ? (
              <StatusBadge kind="listing" status={unit.status} />
            ) : (
              <StatusMenu
                value={unit.status}
                options={LISTING_STATUSES.map((s) => ({ value: s, label: LISTING_STATUS_LABELS[s] }))}
                onChange={(v) => onChangeStatus(v as ListingStatus)}
                tone={STATUS_TONE[unit.status]}
                disabled={statusBusy}
                label="Property status"
                error={statusError}
              />
            )}
            {deleted ? <span className={styles.deletedBadge}>Deleted</span> : null}
          </div>
          {facts ? <div className={styles.facts}>{facts}</div> : null}
        </div>
        <div className={styles.actions}>
          {deleted ? (
            <button type="button" className={`${styles.btn} ${styles.btnAlt}`} disabled={deleteBusy} onClick={onRestore}>
              Restore
            </button>
          ) : null}
          <ListingActionsMenu
            triggerClassName={styles.kebab ?? ''}
            {...(!deleted && { onEdit: () => setEditing(true) })}
            {...(!deleted && { onBroadcast: goToSend })}
            {...(!deleted && { onStartPlacement: () => setStartingPlacement(true) })}
            deleted={deleted}
            onDelete={() => setConfirmingDelete(true)}
            onRestore={onRestore}
            deleteBusy={deleteBusy}
          />
        </div>
      </header>

      {deleted ? (
        <div className={styles.deletedBanner} role="status">
          <span>
            This property is <strong>deleted</strong> - hidden from the properties and the
            landlord&apos;s file. Its data is retained.
            {restoreNotice !== null ? (
              <>
                {' '}
                <span>{RESTORE_LANDLORD_CHANGED_COPY}</span>
              </>
            ) : null}
          </span>
          <Button variant="secondary" size="sm" type="button" onClick={onRestore} disabled={deleteBusy}>
            Restore
          </Button>
        </div>
      ) : null}

      <div className={styles.cols}>
        {/* LEFT column */}
        <div className={styles.left}>
          {coverUrl ? (
            <img className={styles.hero} src={coverUrl} alt={`${address} hero`} />
          ) : (
            <div className={styles.hero} aria-hidden="true" />
          )}

          {/* Public flyer affordance: live only for a shareable (available) unit,
              at the same-origin /p/:unitId funnel (what flyerUrl() emits). */}
          <div className={styles.flyerLine}>
            {flyerShareable ? (
              <>
                <a
                  className={styles.flyerLink}
                  href={`/p/${encodeURIComponent(unit.unitId)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View flyer
                </a>
                <button type="button" className={styles.flyerCopy} onClick={onCopyFlyerLink}>
                  {copiedLink ? 'Copied!' : 'Copy public link'}
                </button>
              </>
            ) : (
              <span className={styles.flyerNote}>
                The public flyer goes live when this property is Available.
              </span>
            )}
          </div>

          <Card
            title="Property details"
            aside={
              deleted ? undefined : (
                <CardAction onClick={() => setEditing(true)} label="Edit property details">
                  Edit
                </CardAction>
              )
            }
          >
            <div className={styles.detailGrid}>
              <KV k="Beds / Baths" v={formatBedsBaths(unit.beds, unit.baths) || '—'} />
              <KV k="Rent" v={formatRent(unit.rent_min, unit.rent_max) || '—'} />
              <KV k="Payment standard" v={formatMoney(unit.payment_standard) || '—'} />
              <KV k="Deposit" v={formatMoney(unit.deposit) || '—'} />
              <KV k="Housing authorities" v={authorities.join(', ') || BLANK} />
              <KV k="Tenant-paid utilities" v={unit.utilities ?? '—'} />
              <KV k="Accessibility" v={unit.accessibility ?? '—'} />
              <KV k="Pets" v={unit.pets ?? '—'} />
              <KV k="Lease terms" v={unit.lease_terms ?? '—'} />
              <KV k="Application fee" v={formatMoney(unit.application_fee) || '—'} />
              <KV
                k="Same-day RTA"
                v={unit.same_day_rta === true ? 'Yes' : unit.same_day_rta === false ? 'No' : '—'}
              />
              {typeof unit.voucher_size_accepted === 'number' ? (
                <KV k="Voucher size accepted" v={String(unit.voucher_size_accepted)} />
              ) : null}
              <KV
                k="Video tour"
                v={
                  videoUrl ? (
                    <a href={videoUrl} target="_blank" rel="noreferrer">
                      Watch video
                    </a>
                  ) : (
                    '—'
                  )
                }
              />
            </div>
          </Card>

          {/* Free-form property notes (the tenant "Preferences & notes" counterpart):
              amenity/quirk facts that are neither utilities nor accessibility —
              "in-unit washer/dryer", "no dishwasher". Internal only (never on the
              public flyer). */}
          <Card
            title="Notes"
            aside={
              deleted ? undefined : (
                <CardAction onClick={() => setEditing(true)} label="Edit property notes">
                  {unit.notes ? 'Edit' : '+ Add'}
                </CardAction>
              )
            }
          >
            {unit.notes ? (
              <NotesText text={unit.notes} />
            ) : (
              <EmptyRow>No notes yet.</EmptyRow>
            )}
          </Card>

          <Card
            title="Tour & application process"
            aside={
              deleted ? undefined : (
                <CardAction onClick={() => setEditing(true)} label="Edit tour & application process">
                  Edit
                </CardAction>
              )
            }
          >
            {/* Structured tour type reads together with the free-form process
                copy below (spec S2). Em-dash placeholder when unset, matching
                the Property details KV rows. */}
            <KV k="Tour type" v={unit.tour_type ? TOUR_TYPE_LABELS[unit.tour_type] : '—'} />
            {unit.tour_process || unit.application_process ? (
              <div className={styles.process}>
                {unit.tour_process ? <p>{unit.tour_process}</p> : null}
                {unit.application_process ? <p>{unit.application_process}</p> : null}
              </div>
            ) : (
              <EmptyRow>No process recorded yet.</EmptyRow>
            )}
          </Card>

          <Card title="Activity">
            {activity.status === 'ready' ? (
              activity.rows.length === 0 ? (
                <EmptyRow>No activity yet.</EmptyRow>
              ) : (
                activity.rows.map((e) => {
                  const d = describeUnitActivity(e);
                  const when = [formatDayDivider(e.at), formatTime(e.at)]
                    .filter(Boolean)
                    .join(' - ');
                  return (
                    <Row
                      key={e.id}
                      {...(d.to !== undefined && { to: d.to })}
                      label={
                        <span>
                          {d.label}
                          {d.sub ? <span className={styles.subLabel}>{d.sub}</span> : null}
                        </span>
                      }
                      right={when}
                    />
                  );
                })
              )
            ) : activity.status === 'error' ? (
              <EmptyRow>We couldn&apos;t load activity.</EmptyRow>
            ) : (
              <PendingPanel />
            )}
          </Card>
        </div>

        {/* RIGHT column */}
        <div className={styles.right}>
          <Card
            title="Contacts"
            aside={
              deleted ? (
                'landlord / PM roster'
              ) : (
                <CardAction
                  onClick={() => {
                    setEditingContacts((v) => !v);
                    setRosterError(null);
                    closeAddContact();
                  }}
                  label={contactsEditing ? 'Done editing contacts' : 'Edit contacts'}
                >
                  {contactsEditing ? 'Done' : 'Edit'}
                </CardAction>
              )
            }
          >
            {showNoPrimaryBox ? (
              <div className={styles.noPrimaryBox} role="status">
                <p>
                  <strong>
                    {propertyContact?.reason === 'deleted' ? DELETED_CONTACT_LEAD : NO_PRIMARY_LEAD}
                  </strong>{' '}
                  {NO_PRIMARY_EFFECT}
                </p>
                {soleEligible !== undefined ? (
                  <p>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => onMakePrimaryContact(soleEligible, NO_PRIMARY_BOX_KEY)}
                      disabled={rosterBusy !== null}
                    >
                      {`Make ${soleEligible.name ?? soleEligible.contactId} primary`}
                    </Button>
                  </p>
                ) : eligibleRows.length > 1 ? (
                  <p>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => {
                        setEditingContacts(true);
                        setRosterError(null);
                        closeAddContact();
                      }}
                    >
                      Choose a primary
                    </Button>
                  </p>
                ) : (
                  <p>{NO_ELIGIBLE_LINE}</p>
                )}
                {rosterError !== null && rosterError.key === NO_PRIMARY_BOX_KEY ? (
                  <p role="alert" className={styles.contactRowError}>
                    {rosterError.message}
                  </p>
                ) : null}
              </div>
            ) : null}
            {contactRows.length === 0 ? (
              <EmptyRow>No contacts on this property yet. Tours need a primary contact.</EmptyRow>
            ) : contactsEditing ? (
              contactRows.map((r) => {
                const name = r.name ?? r.contactId;
                // The landlord of record may not leave the roster (server 409) -
                // say so instead of offering a doomed click.
                const immovable = r.contactId === landlordOfRecord;
                const rowError =
                  rosterError !== null && rosterError.key === r.contactId ? rosterError.message : null;
                return (
                  <div key={r.contactId} className={styles.contactEditRow}>
                    {/* The remove control anchors to the NAME line so it does not
                        move when the role controls wrap below 860px (spec 6.7). */}
                    <div className={styles.contactEditName}>
                      <span className={styles.contactName}>{name}</span>
                      {r.deleted === true ? <span className={styles.deletedMark}> (deleted)</span> : null}
                      {r.primaryContact ? (
                        <span className={styles.primaryStar}> (primary)</span>
                      ) : null}
                      <button
                        type="button"
                        className={styles.contactRowAction}
                        aria-label={`Remove ${name} from this property`}
                        onClick={() => onRemoveContactRow(r)}
                        disabled={immovable || rosterBusy !== null}
                      >
                        Remove
                      </button>
                    </div>
                    <div className={styles.contactEditControls}>
                      {/* The landlord of record's role is STRUCTURALLY pinned to
                          'landlord' server-side; a change there answers with the
                          pinned row and the selector snaps back. */}
                      <select
                        className={styles.contactRoleSelect}
                        aria-label={`Role for ${name}`}
                        value={r.role}
                        onChange={(e) => onSetContactRole(r, e.target.value as UnitContact['role'])}
                        disabled={rosterBusy !== null}
                      >
                        {ROSTER_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABEL[role]}
                          </option>
                        ))}
                      </select>
                      {/* A deleted contact can't be made primary (the server
                          answers 409 primary_contact_deleted, spec 7.4) - no
                          doomed click. Its role select and Remove stay. */}
                      {r.primaryContact || r.deleted === true ? null : (
                        <button
                          type="button"
                          className={styles.contactRowAction}
                          aria-label={`Make ${name} the primary contact`}
                          onClick={() => onMakePrimaryContact(r)}
                          disabled={rosterBusy !== null}
                        >
                          Make primary
                        </button>
                      )}
                    </div>
                    {immovable ? (
                      <p className={styles.contactRowNote}>{LANDLORD_OF_RECORD_REASON}</p>
                    ) : null}
                    {rowError !== null ? (
                      <p role="alert" className={styles.contactRowError}>
                        {rowError}
                      </p>
                    ) : null}
                  </div>
                );
              })
            ) : (
              contactRows.map((r) => (
                <Row
                  key={r.contactId}
                  to={`/contacts/${r.contactId}`}
                  label={
                    <span>
                      {/* The NAME is the visible link (brand-styled; the whole row
                          stays the hit target) — no separate "Open" affordance. */}
                      <span className={styles.contactName}>{r.name ?? r.contactId}</span>
                      {r.deleted === true ? <span className={styles.deletedMark}> (deleted)</span> : null}
                      {r.primaryContact ? <span className={styles.primaryStar}> (primary)</span> : null}
                      <span className={styles.roleLine}>
                        {r.roleLabel}
                        {r.company ? ` - ${r.company}` : ''}
                      </span>
                    </span>
                  }
                />
              ))
            )}
            {contactsEditing ? (
              addingContact ? (
                <div className={styles.contactAdd}>
                  {/* Committed-pick typeahead (the unit-search contract): typing
                      alone never carries a contactId, so only a PICKED candidate
                      can be added. */}
                  <ContactSearchField
                    value={addContactValue}
                    onChange={setAddContactValue}
                    candidates={addContactCandidates}
                    inputLabel="Add contact"
                  />
                  <div className={styles.contactEditControls}>
                    <select
                      className={styles.contactRoleSelect}
                      aria-label="Role for the new contact"
                      value={addContactRole}
                      onChange={(e) => setAddContactRole(e.target.value as UnitContact['role'])}
                      disabled={rosterBusy !== null}
                    >
                      {ROSTER_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABEL[role]}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      aria-label="Add contact to this property"
                      onClick={onAddContact}
                      disabled={addContactValue.contactId === undefined || rosterBusy !== null}
                    >
                      Add
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={closeAddContact}
                      disabled={rosterBusy !== null}
                    >
                      Cancel
                    </Button>
                  </div>
                  {rosterError !== null && rosterError.key === ADD_ROW_KEY ? (
                    <p role="alert" className={styles.contactRowError}>
                      {rosterError.message}
                    </p>
                  ) : null}
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.contactAddBtn}
                  onClick={() => setAddingContact(true)}
                >
                  + Add contact
                </button>
              )
            ) : null}
          </Card>

          <Card
            title="Sent to"
            aside={
              !deleted ? (
                <CardAction onClick={goToSend} label="Send this property">
                  + Send
                </CardAction>
              ) : (
                'recipients'
              )
            }
          >
            {recipients.status === 'ready' ? (
              recipients.rows.length === 0 ? (
                <EmptyRow>Not sent to anyone yet.</EmptyRow>
              ) : (
                groupSendRows(recipients.rows)
                  .filter((group) => group.rows.length > 0)
                  .map((group) => (
                    // Markup R1: one named list per non-empty group; its
                    // children are roster rows only.
                    <SendRosterList key={group.key} label={group.label}>
                      {group.rows.map((row: ListingSendRow) => {
                        // caseworkers D20/D22: a resolved non-tenant row is labelled by
                        // its displayKind; tenant and unresolved rows are not.
                        const kind = sendRowKindLabel(row);
                        const name = row.tenantName ?? row.contactId;
                        return (
                          <SendRosterRow
                            key={`${row.contactId}:${row.sentAt}`}
                            to={`/contacts/${row.contactId}`}
                            identity={name}
                            {...(kind !== undefined && { kind })}
                            row={row}
                            address={address}
                            name={name}
                            interestedMode={row.interestedMode ?? interestedModeOf(unit)}
                            actionsDisabled={deleted}
                            onOutcome={(outcome) => onRecipientOutcome(row.contactId, outcome)}
                            // B8: only a PARTNER recipient gets "Request a tour"
                            // (never a landlord / team-member row).
                            // Same page: `replace`, so the dialog adds no history entry.
                            {...(row.type === 'partner' && {
                              requestTourReplace: true,
                              requestTourTo: `/listings/${encodeURIComponent(unit.unitId)}?tour=new`,
                            })}
                            // R4: form mode NAVIGATES to ?tour=new&tenantId=.
                            onOpenTourForm={() => openTourForm(row.contactId)}
                            now={now}
                          />
                        );
                      })}
                    </SendRosterList>
                  ))
              )
            ) : recipients.status === 'error' ? (
              <EmptyRow>We couldn&apos;t load recipients.</EmptyRow>
            ) : (
              <PendingPanel />
            )}
          </Card>

          {/* Tours sit between Sent-to and Placements - the flow order
              (send -> tour -> placement). Rows: tenant + date, right = status. */}
          <Card
            title="Tours on this property"
            aside={
              !deleted ? (
                <CardAction
                  onClick={() => openTourForm()}
                  label="Schedule a tour on this property"
                >
                  + Tour
                </CardAction>
              ) : undefined
            }
          >
            {tours.status === 'ready' ? (
              tours.rows.length === 0 ? (
                <EmptyRow>No tours on this property yet.</EmptyRow>
              ) : (
                <CollapsibleRows
                  rows={tours.rows.map((t) => (
                    <Row
                      key={t.tourId}
                      to={`/tours/${t.tourId}`}
                      label={
                        <span>
                          {tenantName(contactsMap, t.tenantId)}
                          <span className={styles.subLabel}>
                            {t.scheduledAt !== undefined
                              ? new Date(t.scheduledAt).toLocaleDateString()
                              : undatedTourLabel(t)}
                          </span>
                        </span>
                      }
                      right={tourStatusLabel(t)}
                    />
                  ))}
                />
              )
            ) : tours.status === 'error' ? (
              <EmptyRow>We couldn&apos;t load tours.</EmptyRow>
            ) : (
              <PendingPanel />
            )}
          </Card>

          <Card
            title="Placements on this property"
            aside={
              !deleted ? (
                <CardAction
                  onClick={() => setStartingPlacement(true)}
                  label="Start a placement on this property"
                >
                  + Placement
                </CardAction>
              ) : undefined
            }
          >
            {placementsOnUnit.length === 0 ? (
              <EmptyRow>No placements on this property yet.</EmptyRow>
            ) : (
              placementsOnUnit.map((c) => (
                <Row
                  key={c.placementId}
                  to={`/placements/${c.placementId}`}
                  label={tenantName(contactsMap, c.tenantId)}
                  right={STAGE_LABELS[c.stage] ?? c.stage}
                />
              ))
            )}
          </Card>

          <Card title="Related properties" aside="same landlord">
            {related.status === 'ready' ? (
              related.rows.length === 0 ? (
                <EmptyRow>No related properties.</EmptyRow>
              ) : (
                <CollapsibleRows
                  limit={RELATED_LIMIT}
                  rows={related.rows.map((r) => (
                    <Row
                      key={r.unitId}
                      to={`/listings/${r.unitId}`}
                      label={
                        <span>
                          {shortAddress(r.address, r.unitId)}
                          {r.label ? <span className={styles.subLabel}>{r.label}</span> : null}
                        </span>
                      }
                      right={
                        <span className={STATUS_DOT[r.status] ?? responseClass.muted}>
                          {statusLabel(r.status)}
                        </span>
                      }
                    />
                  ))}
                />
              )
            ) : related.status === 'error' ? (
              <EmptyRow>We couldn&apos;t load related properties.</EmptyRow>
            ) : (
              <PendingPanel />
            )}
          </Card>

          <Card title="Similar properties" aside="available comps">
            {similar.status === 'ready' ? (
              similar.rows.length === 0 ? (
                <EmptyRow>No similar properties.</EmptyRow>
              ) : (
                <CollapsibleRows
                  limit={RELATED_LIMIT}
                  rows={similar.rows.map((s) => (
                    <Row
                      key={s.unitId}
                      to={`/listings/${s.unitId}`}
                      label={
                        <span>
                          {shortAddress(s.address, s.unitId)}
                          <span className={styles.subLabel}>{s.summary}</span>
                        </span>
                      }
                      right={<span className={styles.match}>{s.matchPct}%</span>}
                    />
                  ))}
                />
              )
            ) : similar.status === 'error' ? (
              <EmptyRow>We couldn&apos;t load similar properties.</EmptyRow>
            ) : (
              <PendingPanel />
            )}
          </Card>
        </div>
      </div>

      {/* BOTTOM - full-width Photos. The gallery renders the resolved display
          media; a bare entry with no URL shows an honest "unavailable" tile. Each
          thumbnail reveals its actions on hover/focus (focus-within): Make cover
          (hidden on the first/cover entry) and Remove (confirmed). "+ Add" opens a
          hidden multi-select file input. Management is hidden on a deleted property. */}
      <section className={styles.photos}>
        <h2 className={styles.photosHeading}>Photos</h2>
        <div className={styles.gallery}>
          {mediaDisplay.map((m, i) => (
            <div key={`${m.entry}:${i}`} className={styles.thumbWrap}>
              {m.url ? (
                <img className={styles.thumb} src={m.url} alt={`Property photo ${i + 1}`} />
              ) : (
                <div
                  className={styles.thumbUnavailable}
                  aria-label={`Property photo ${i + 1} (unavailable)`}
                >
                  Unavailable
                </div>
              )}
              {!deleted ? (
                <div className={styles.thumbActions}>
                  {i !== 0 ? (
                    <button
                      type="button"
                      className={styles.thumbBtn}
                      aria-label={`Make property photo ${i + 1} the cover`}
                      onClick={() => onMakeCover(m.entry)}
                      disabled={photoBusy}
                    >
                      Make cover
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.thumbBtn}
                    aria-label={`Remove property photo ${i + 1}`}
                    onClick={() => {
                      setRemoveError(null);
                      setRemovingEntry(m.entry);
                    }}
                    disabled={photoBusy}
                  >
                    Remove
                  </button>
                </div>
              ) : null}
            </div>
          ))}
          {!deleted ? (
            <button
              type="button"
              className={styles.addPhoto}
              onClick={onPickPhotos}
              disabled={photoBusy || atPhotoCap}
            >
              {photoBusy ? 'Uploading...' : '+ Add'}
            </button>
          ) : null}
          {/* Hidden multi-select input; the OS picker is hinted to the image types
              (the server re-validates every file regardless). */}
          <input
            ref={photoInputRef}
            type="file"
            accept={PHOTO_ACCEPT}
            multiple
            hidden
            onChange={onFilesChosen}
          />
        </div>
        {!deleted && atPhotoCap ? (
          <p className={styles.photosNote}>
            This property has the maximum of {UNIT_MEDIA_MAX} photos. Remove one to add more.
          </p>
        ) : null}
        {photoError !== null ? (
          <p role="alert" className={styles.photosError}>
            {photoError}
          </p>
        ) : null}
      </section>

      {editing ? (
        <ListingEditForm
          unit={unit}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            setUnit(updated);
            setEditing(false);
          }}
        />
      ) : null}

      {startingPlacement ? (
        <PlacementCreateForm
          unitId={unit.unitId}
          onClose={() => setStartingPlacement(false)}
          onCreated={(p) => {
            setStartingPlacement(false);
            void navigate('/placements/' + p.placementId);
          }}
        />
      ) : null}

      {tourFormOpen ? (
        <ScheduleTourForm
          // Remount on a tenant change while open (a param change while this
          // page is mounted): the form resolves its locked label once per mount.
          key={tourFormTenant ?? ''}
          initialUnitId={unit.unitId}
          {...(tourFormTenant !== undefined && { tenantId: tourFormTenant })}
          onClose={closeTourForm}
          onCreated={(t) => {
            // Strip the params FIRST (replace), then push the tour page, so
            // Back lands on the bare property page.
            closeTourForm();
            void navigate('/tours/' + t.tourId);
          }}
        />
      ) : null}

      {confirmingDelete ? (
        <Modal
          title="Delete property?"
          onClose={() => {
            if (!deleteBusy) {
              setConfirmingDelete(false);
              setDeleteError(null);
            }
          }}
          footer={
            <>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleteBusy}
              >
                Cancel
              </Button>
              <Button variant="danger" size="sm" type="button" onClick={onConfirmDelete} disabled={deleteBusy}>
                {deleteBusy ? 'Deleting...' : 'Delete'}
              </Button>
            </>
          }
        >
          <p>
            <strong>{address}</strong> will be hidden from the properties and the landlord&apos;s
            file. Nothing is erased - you can restore it from the Properties <em>Deleted</em> view.
          </p>
          {deleteError !== null ? (
            <p role="alert" className={styles.error}>
              {deleteError}
            </p>
          ) : null}
        </Modal>
      ) : null}

      {/* caseworker-integrity (spec section 4 "Restore"): the stored landlord
          can't stay this property's landlord - choose one, or restore
          without. The restored unit carries its enriched roster, so it is
          applied to the Contacts card too. */}
      {restoreNeeds !== null ? (
        <RestoreLandlordDialog
          unitId={unit.unitId}
          {...(restoreNeeds.landlordName !== undefined && { landlordName: restoreNeeds.landlordName })}
          onRestored={(updated) => {
            setRestoreNeeds(null);
            applyRosterUnit(updated);
            // primary-contact-integrity spec 7.5: a landlord-clearing or
            // landlord-swapping restore can hand the primary contact off, and
            // its answer carries no propertyContact block - re-read, and let
            // the re-read REPLACE this answer as the card's roster source.
            // Best-effort: on a failure the card keeps the restore's roster.
            void getUnit(unit.unitId)
              .then((fresh) => applyRosterUnit(fresh))
              .catch(() => {
                /* best-effort re-read */
              });
          }}
          onConflict={() => {
            void getUnit(unit.unitId)
              .then((fresh) => {
                // The re-read is the new truth for the page AND the Contacts
                // card (its landlord row may have changed) - the same settle
                // runRosterWrite's 409 path uses (plan review R1 row 5).
                applyRosterUnit(fresh);
                if (!(typeof fresh.deleted_at === 'string' && fresh.deleted_at.length > 0)) {
                  setRestoreNeeds(null);
                }
              })
              .catch(() => {
                /* best-effort re-read; the dialog's retry message stands */
              });
          }}
          onLandlordNotNeeded={() => {
            // The plain restore applies now (spec revision 7; final review
            // round 2 R2-1): close the dialog and re-read, the same settle as
            // onConflict - and never re-run the plain restore from here, which
            // would silently override the choice staff just made.
            setRestoreNeeds(null);
            void getUnit(unit.unitId)
              .then((fresh) => {
                applyRosterUnit(fresh);
                if (typeof fresh.deleted_at === 'string' && fresh.deleted_at.length > 0) {
                  setRestoreNotice({ unitId: unit.unitId });
                }
              })
              .catch(() => {
                // Best-effort re-read: the page still shows the property
                // deleted, so the banner still says why the dialog closed.
                setRestoreNotice({ unitId: unit.unitId });
              });
          }}
          onClose={() => setRestoreNeeds(null)}
        />
      ) : null}

      {/* Removing the primary contact changes who new tours and relay groups
          use, so it NAMES who takes over before it writes (spec 6.1; the
          sentence is the server's call, primary-contact-integrity spec 7.3). */}
      {removingContact !== null ? (
        <Modal
          title="Remove the primary contact?"
          onClose={() => {
            if (rosterBusy === null) {
              setRemovingContact(null);
              setRosterError(null);
            }
          }}
          footer={
            /* Authored Cancel -> default: desktop puts the default rightmost,
               and the narrow rule reverses the column so it lands on TOP
               (spec 6.7) without either order being re-authored. */
            <div className={styles.confirmActions}>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setRemovingContact(null)}
                disabled={rosterBusy !== null}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                type="button"
                onClick={() => removeContactRow(removingContact)}
                disabled={rosterBusy !== null}
              >
                Remove contact
              </Button>
            </div>
          }
        >
          <p>{promotionNotice()}</p>
          {rosterError !== null && rosterError.key === removingContact.contactId ? (
            <p role="alert" className={styles.error}>
              {rosterError.message}
            </p>
          ) : null}
        </Modal>
      ) : null}

      {removingEntry !== null ? (
        <Modal
          title="Remove photo?"
          onClose={() => {
            if (!removeBusy) {
              setRemovingEntry(null);
              setRemoveError(null);
            }
          }}
          footer={
            <>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setRemovingEntry(null)}
                disabled={removeBusy}
              >
                Cancel
              </Button>
              <Button variant="danger" size="sm" type="button" onClick={onConfirmRemove} disabled={removeBusy}>
                {removeBusy ? 'Removing...' : 'Remove'}
              </Button>
            </>
          }
        >
          <p>
            This photo will be removed from this property - it won&apos;t show on the property page
            or the public flyer.
          </p>
          {removeError !== null ? (
            <p role="alert" className={styles.error}>
              {removeError}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
