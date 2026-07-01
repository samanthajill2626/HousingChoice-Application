// ListingDetail � the Listing detail page (�B4), the locked v4 mockup. A
// near-black header band (address � status badge � facts � "?? Broadcast to
// tenants" + Edit + ?) over a two-column body and a full-width Photos gallery:
//   LEFT  � a small hero image � a flyer line (View flyer ? + Copy public link)
//           � Property details (with Accepted vouchers as a BULLETED list) � Tour
//           & application process � Activity.
//   RIGHT � Contacts roster � Sent to tenants � Placements on this property � Related
//           properties � Similar properties.
//   BOTTOM (full width) � Photos.
// Real panels come from existing endpoints (unit, placements, units, the landlord
// contact); the C4 "Sent to tenants" + C6 "Similar properties" panels show an
// honest "Arrives with the backend" pending state, and "Activity" (BE2) is
// pending too. Nothing is fabricated.
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { deleteUnit, restoreUnit } from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import {
  LISTING_STATUSES,
  LISTING_STATUS_LABELS,
  STAGE_LABELS,
  setListingStatus,
  type ListingStatus,
} from '../../api/index.js';
import { Card, EmptyRow, KV, PendingPanel, Row, responseClass } from '../contact/Card.js';
import { Modal } from '../contact/Modal.js';
import { PlacementCreateForm } from '../placements/PlacementCreateForm.js';
import { useListing } from './useListing.js';
import { ListingActionsMenu } from './ListingActionsMenu.js';
import { ListingEditForm } from './ListingEditForm.js';
import {
  buildListingFacts,
  formatBedsBaths,
  formatMoney,
  formatRent,
  isMediaUrl,
  shortAddress,
  statusLabel,
} from './listingFormat.js';
import { safeHttpUrl } from '../../lib/safeUrl.js';
import styles from './ListingDetail.module.css';

// Property-status ? header badge class. `available` is the one publicly-shareable
// status (green); occupied/off_market read as a settled/closed badge; the rest
// fall back to the neutral badge.
const STATUS_BADGE: Record<ListingStatus, string> = {
  setup: styles.badgeInactive ?? '',
  available: styles.badgeAvailable ?? '',
  under_application: styles.badgePlaced ?? '',
  finalizing: styles.badgePlaced ?? '',
  occupied: styles.badgePlaced ?? '',
  on_hold: styles.badgeInactive ?? '',
  off_market: styles.badgeInactive ?? '',
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

const RESPONSE_META: Record<string, { label: string; cls: string }> = {
  interested: { label: '?? Interested', cls: responseClass.yes },
  not_a_fit: { label: '?? Not a fit', cls: responseClass.no },
  no_reply: { label: '? No reply', cls: responseClass.wait },
};

export function ListingDetail(): React.JSX.Element {
  const { unitId = '' } = useParams<{ unitId: string }>();
  const navigate = useNavigate();
  const state = useListing(unitId);
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

  // Property-status write � goes through the transition service (status is NOT
  // writable via a plain unit PATCH). On success apply the returned unit in
  // place (no refetch) and clear any prior error. On failure surface an inline
  // error (the select reverts to the unit's stored status, so without feedback a
  // failed change would silently vanish). Manual source; no reason needed.
  function onChangeStatus(toStatus: ListingStatus): void {
    if (statusBusy || !state.unit || toStatus === state.unit.status) return;
    setStatusBusy(true);
    void setListingStatus(state.unit.unitId, { toStatus, source: 'manual' })
      .then((updated) => {
        setUnit(updated);
        setStatusError(null);
      })
      .catch(() => {
        setStatusError("Couldn't update the property status � please try again.");
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

  const { unit, roster, placementsOnUnit, related, recipients, similar } = state;
  const address = shortAddress(unit.address, unit.unitId);
  const landlordName = roster.find((r) => r.primaryVoice)?.company ?? roster[0]?.company;
  const facts = buildListingFacts(unit, landlordName);
  const programs = unit.accepted_programs ?? [];
  const media = unit.media ?? [];
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
  // out of the normal views � so on success we navigate back to the Properties list
  // (it can be restored from the Deleted tab). Restore stays on the page and
  // applies the returned unit in place so the Deleted banner clears.
  const deleted = typeof unit.deleted_at === 'string' && unit.deleted_at.length > 0;
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
        setDeleteError("Couldn't delete � please try again.");
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

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <h1 className={styles.name}>
            {address}
            <span className={`${styles.badge} ${STATUS_BADGE[unit.status] ?? ''}`}>
              {statusLabel(unit.status)}
            </span>
            {deleted ? <span className={styles.deletedBadge}>?? Deleted</span> : null}
          </h1>
          {facts ? <div className={styles.facts}>{facts}</div> : null}
        </div>
        <div className={styles.actions}>
          <label className={styles.statusSelect}>
            <span className={styles.srLabel}>Property status</span>
            <select
              aria-label="Property status"
              value={unit.status}
              disabled={statusBusy}
              onChange={(e) => onChangeStatus(e.target.value as ListingStatus)}
            >
              {LISTING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {LISTING_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            {statusError !== null ? (
              <span role="alert" className={styles.statusError}>
                {statusError}
              </span>
            ) : null}
          </label>
          {deleted ? (
            <button type="button" className={`${styles.btn} ${styles.btnAlt}`} disabled={deleteBusy} onClick={onRestore}>
              Restore
            </button>
          ) : (
            <>
              <button
                type="button"
                className={styles.btn}
                onClick={() => navigate(`/broadcasts/new?unitId=${encodeURIComponent(unit.unitId)}`)}
              >
                📣 Broadcast to tenants
              </button>
              <button type="button" className={styles.btn} onClick={() => setStartingPlacement(true)}>
                Start placement
              </button>
            </>
          )}
          <ListingActionsMenu
            triggerClassName={styles.kebab ?? ''}
            {...(!deleted && { onEdit: () => setEditing(true) })}
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
            This property is <strong>deleted</strong> � hidden from the properties and the
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
          {media.length > 0 && isMediaUrl(media[0] ?? '') ? (
            <img className={styles.hero} src={media[0]} alt={`${address} hero`} />
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

          <Card title="Property details" aside="Edit">
            <div className={styles.detailGrid}>
              <KV k="Beds / Baths" v={formatBedsBaths(unit.beds, unit.baths) || '�'} />
              <KV k="Rent" v={formatRent(unit.rent_min, unit.rent_max) || '�'} />
              <KV k="Payment standard" v={formatMoney(unit.payment_standard) || '�'} />
              <KV k="Deposit" v={formatMoney(unit.deposit) || '�'} />
              <KV k="Jurisdiction" v={unit.jurisdiction ?? '�'} />
              <KV k="Utilities" v={unit.utilities ?? '�'} />
              <KV k="Accessibility" v={unit.accessibility ?? '�'} />
              <KV k="Pets" v={unit.pets ?? '�'} />
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

          <Card title="Tour & application process" aside="Edit">
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
            <PendingPanel note="The property's activity log arrives with the backend." />
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
                      {r.name ?? r.contactId}
                      {r.primaryVoice ? <span className={styles.primaryStar}> ? primary</span> : null}
                      <span className={styles.roleLine}>
                        {r.roleLabel}
                        {r.company ? ` � ${r.company}` : ''}
                      </span>
                    </span>
                  }
                  right={<span className={styles.openLink}>Open ?</span>}
                />
              ))
            )}
          </Card>

          <Card title="Sent to tenants" aside="recipients + responses">
            {recipients.status === 'ready' ? (
              recipients.rows.length === 0 ? (
                <EmptyRow>Not sent to anyone yet.</EmptyRow>
              ) : (
                recipients.rows.map((row) => {
                  const meta = RESPONSE_META[row.response] ?? {
                    label: row.response,
                    cls: responseClass.muted,
                  };
                  return (
                    <Row
                      key={`${row.contactId}:${row.sentAt}`}
                      to={`/contacts/${row.contactId}`}
                      label={row.contactId}
                      right={<span className={meta.cls}>{meta.label}</span>}
                    />
                  );
                })
              )
            ) : recipients.status === 'error' ? (
              <EmptyRow>We couldn&apos;t load recipients.</EmptyRow>
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
                  label={c.tenantId}
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
                related.rows.map((r) => (
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
                        ? {statusLabel(r.status)}
                      </span>
                    }
                  />
                ))
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
                similar.rows.map((s) => (
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
                ))
              )
            ) : similar.status === 'error' ? (
              <EmptyRow>We couldn&apos;t load similar properties.</EmptyRow>
            ) : (
              <PendingPanel />
            )}
          </Card>
        </div>
      </div>

      {/* BOTTOM � full-width Photos */}
      <section className={styles.photos}>
        <h2 className={styles.photosHeading}>Photos</h2>
        <div className={styles.gallery}>
          {media.map((m, i) =>
            isMediaUrl(m) ? (
              <img key={`${m}:${i}`} className={styles.thumb} src={m} alt={`Photo ${i + 1}`} />
            ) : (
              <div
                key={`${m}:${i}`}
                className={styles.thumb}
                title="Stored image (preview arrives with media URLs)"
                aria-label={`Photo ${i + 1} (stored, no preview)`}
              />
            ),
          )}
          <button type="button" className={styles.addPhoto}>
            + Add
          </button>
        </div>
        {media.some((m) => !isMediaUrl(m)) ? (
          <p className={styles.photosNote}>
            Some photos are stored references; previews arrive when the backend serves media URLs.
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
                {deleteBusy ? 'Deleting�' : 'Delete'}
              </Button>
            </>
          }
        >
          <p>
            <strong>{address}</strong> will be hidden from the properties and the landlord&apos;s
            file. Nothing is erased � you can restore it from the Properties <em>Deleted</em> view.
          </p>
          {deleteError !== null ? (
            <p role="alert" className={styles.error}>
              {deleteError}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
