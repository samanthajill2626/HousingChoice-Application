// ListingDetail - the Listing detail page (B4), the locked v4 mockup. A
// near-black header band (address - status badge - facts - "?? Send to
// tenants" + Edit + ?) over a two-column body and a full-width Photos gallery:
//   LEFT  - a small hero image - a flyer line (View flyer ? + Copy public link)
//           - Property details (with Accepted vouchers as a BULLETED list) - Tour
//           & application process - Activity.
//   RIGHT - Contacts roster - Sent to tenants - Placements on this property - Related
//           properties - Similar properties.
//   BOTTOM (full width) - Photos.
// Real panels come from existing endpoints (unit, placements, units, the landlord
// contact); the C4 "Sent to tenants" + C6 "Similar properties" panels show an
// honest "Arrives with the backend" pending state, and "Activity" serves the unit
// audit trail (pending only on an older backend). Nothing is fabricated.
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  confirmUnitPhotos,
  deleteUnit,
  presignUnitPhotos,
  removeUnitPhoto,
  restoreUnit,
  setUnitPhotoCover,
  uploadToPresignedPost,
  type Contact,
  type UnitMediaDisplay,
} from '../../api/index.js';
import { Button, Spinner, StatusBadge, StatusMenu, type StatusTone } from '../../ui/index.js';
import {
  LISTING_STATUSES,
  LISTING_STATUS_LABELS,
  STAGE_LABELS,
  TOUR_STATUS_LABELS,
  TOUR_TYPE_LABELS,
  setListingStatus,
  type ListingStatus,
} from '../../api/index.js';
import { Card, CardAction, CollapsibleRows, EmptyRow, KV, NotesText, PendingPanel, Row, SendRosterRow, responseClass } from '../contact/Card.js';
import { Modal } from '../contact/Modal.js';
import { PlacementCreateForm } from '../placements/PlacementCreateForm.js';
import { useListing } from './useListing.js';
import { useContacts } from '../contacts/useContacts.js';
import { tenantName } from '../placements/placementsFormat.js';
import { ListingActionsMenu } from './ListingActionsMenu.js';
import { ListingEditForm } from './ListingEditForm.js';
import {
  buildListingFacts,
  describeUnitActivity,
  formatBedsBaths,
  formatMoney,
  formatRent,
  isMediaUrl,
  shortAddress,
  statusLabel,
} from './listingFormat.js';
import { formatDayDivider, formatTime } from '../contact/format.js';
import { safeHttpUrl } from '../../lib/safeUrl.js';
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

export function ListingDetail(): React.JSX.Element {
  const { unitId = '' } = useParams<{ unitId: string }>();
  const navigate = useNavigate();
  const state = useListing(unitId);
  // Contacts back the "Placements on this property" + "Tours on this property"
  // rows: resolve each row's tenantId to a display name (falls back to the id
  // when a contact hasn't loaded).
  const { contacts: contactsList } = useContacts('all');
  const contactsMap = useMemo(() => {
    const m = new Map<string, Contact>();
    for (const c of contactsList) m.set(c.contactId, c);
    return m;
  }, [contactsList]);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // The "Start placement" dialog, pre-filled+locked to this property's unit.
  const [startingPlacement, setStartingPlacement] = useState(false);
  const { setUnit } = state;
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
  const landlordName = roster.find((r) => r.primaryVoice)?.company ?? roster[0]?.company;
  const facts = buildListingFacts(unit, landlordName);
  const programs = unit.accepted_programs ?? [];
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
  // "Sent to tenants" card's "+ Send" action) - one URL, one place it's built.
  const goToSend = (): void => void navigate(`/broadcasts/new?unitId=${encodeURIComponent(unit.unitId)}`);
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
    void restoreUnit(unit.unitId)
      .then((updated) => setUnit(updated))
      .catch(() => {
        /* leave it deleted; the action re-enables for a retry */
      })
      .finally(() => setDeleteBusy(false));
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
              <KV k="Jurisdiction" v={unit.jurisdiction ?? '—'} />
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
            <div className={styles.vouchers}>
              <span className={styles.vouchersLabel} id={`vouchers-${unit.unitId}`}>
                Accepted vouchers
              </span>
              {programs.length > 0 ? (
                <ul className={styles.vouchersList} aria-labelledby={`vouchers-${unit.unitId}`}>
                  {programs.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : (
                <EmptyRow>None recorded yet.</EmptyRow>
              )}
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
          <Card title="Contacts" aside="landlord / PM roster">
            {roster.length === 0 ? (
              <EmptyRow>No contacts on this property yet.</EmptyRow>
            ) : (
              roster.map((r) => (
                <Row
                  key={r.contactId}
                  to={`/contacts/${r.contactId}`}
                  label={
                    <span>
                      {/* The NAME is the visible link (brand-styled; the whole row
                          stays the hit target) — no separate "Open" affordance. */}
                      <span className={styles.contactName}>{r.name ?? r.contactId}</span>
                      {r.primaryVoice ? <span className={styles.primaryStar}> (primary)</span> : null}
                      <span className={styles.roleLine}>
                        {r.roleLabel}
                        {r.company ? ` - ${r.company}` : ''}
                      </span>
                    </span>
                  }
                />
              ))
            )}
          </Card>

          <Card
            title="Sent to tenants"
            aside={
              !deleted ? (
                <CardAction onClick={goToSend} label="Send this property to tenants">
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
                recipients.rows.map((row) => (
                  <SendRosterRow
                    key={`${row.contactId}:${row.sentAt}`}
                    to={`/contacts/${row.contactId}`}
                    identity={row.tenantName ?? row.contactId}
                    {...(row.tour && { tour: row.tour })}
                  />
                ))
              )
            ) : recipients.status === 'error' ? (
              <EmptyRow>We couldn&apos;t load recipients.</EmptyRow>
            ) : (
              <PendingPanel />
            )}
          </Card>

          {/* Tours sit between Sent-to-tenants and Placements — the flow order
              (send -> tour -> placement). Rows: tenant + date, right = status. */}
          <Card
            title="Tours on this property"
            aside={
              tours.status === 'ready' && tours.rows.length > 0
                ? String(tours.rows.length)
                : undefined
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
                              : 'Not booked'}
                          </span>
                        </span>
                      }
                      right={TOUR_STATUS_LABELS[t.status] ?? t.status}
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
            aside={placementsOnUnit.length > 0 ? String(placementsOnUnit.length) : undefined}
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
