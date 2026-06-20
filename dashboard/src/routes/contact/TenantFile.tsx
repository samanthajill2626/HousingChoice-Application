// TenantFile — the right pane for a tenant contact (§B2). Stacked cards:
// Details (voucher size, housing authority, current address, phone numbers,
// status) · Preferences & notes · Listings sent (C4) · Tours · Placements · Group
// texts · Media (C5). Placements + Tours are REAL (derived from /api/placements);
// Listings-sent + Media render a "pending backend" state until BE4/BE5 land;
// Preferences are manual-now (pending until the gleaning slice). Each list row
// links to its detail route.
import {
  STAGE_LABELS,
  type PlacementItem,
  type Contact,
  type ContactPhone,
  type UnitItem,
} from '../../api/index.js';
import { StatusBadge } from '../../ui/index.js';
import {
  Card,
  CardAction,
  CardInlineAction,
  Chips,
  EmptyRow,
  KV,
  PendingPanel,
  Row,
  responseClass,
} from './Card.js';
import { MediaGallery } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';
import { tenantPlacements, tenantTours } from './buildContactFile.js';
import { formatAddress, formatPhone } from './format.js';

export interface TenantFileProps {
  contact: Contact;
  phones: ContactPhone[];
  placements: PlacementItem[];
  units: UnitItem[];
  /** C4 listings-sent slice status (panel degrades to pending on 404). */
  listingsSentPending: boolean;
  /** "Media from comms" — derived from the live timeline (updates as messages
   *  arrive); `mediaLoading` covers the brief window before the timeline lands. */
  media: CommsMediaItem[];
  mediaLoading?: boolean;
  /** Open the edit dialog (Details "Edit" + Preferences "+ Add"). */
  onEdit?: () => void;
  /** Open the "Manage numbers" dialog (Phone numbers row). */
  onManagePhones?: () => void;
}

/** A unit's address line (or its id as a last resort), for a row label. */
function unitLabel(units: Map<string, UnitItem>, unitId: string): string {
  const unit = units.get(unitId);
  const addr = unit ? formatAddress(unit.address) : '';
  return addr || unitId;
}

export function TenantFile({
  contact,
  phones,
  placements,
  units,
  listingsSentPending,
  media,
  mediaLoading,
  onEdit,
  onManagePhones,
}: TenantFileProps): React.JSX.Element {
  const unitMap = new Map(units.map((u) => [u.unitId, u]));
  const myPlacements = tenantPlacements(placements, contact.contactId);
  const tours = tenantTours(placements, contact.contactId);
  const phoneList = phones.map((p) => formatPhone(p.phone)).join(' · ');
  const voucher = typeof contact.voucherSize === 'number' ? `${contact.voucherSize} BR` : '—';
  const housingAuthority = contact.housingAuthority ?? '—';
  const currentAddress = formatAddress(contact.address) || '—';
  const prefs = typeof contact.notes === 'string' && contact.notes.trim() ? [contact.notes.trim()] : [];

  return (
    <>
      <Card
        title="Details"
        aside={
          onEdit ? (
            <CardAction onClick={onEdit} label="Edit contact details">
              Edit
            </CardAction>
          ) : (
            'Edit'
          )
        }
      >
        <KV k="Voucher size" v={voucher} />
        <KV k="Housing authority" v={housingAuthority} />
        <KV k="Current address" v={currentAddress} />
        <KV
          k="Phone numbers"
          v={
            <>
              {phoneList || '—'}
              {onManagePhones ? (
                <>
                  {' · '}
                  <CardInlineAction onClick={onManagePhones} label="Manage phone numbers">
                    Manage
                  </CardInlineAction>
                </>
              ) : null}
            </>
          }
        />
        <KV
          k="Status"
          v={
            <>
              {contact.status ? <StatusBadge kind="tenant" status={contact.status} /> : '—'}
              {contact.porting === true ? (
                <span className={responseClass.muted}> · Porting</span>
              ) : null}
            </>
          }
        />
      </Card>

      <Card
        title="Preferences & notes"
        aside={
          onEdit ? (
            <CardAction onClick={onEdit} label="Add a note">
              + Add
            </CardAction>
          ) : (
            '+ Add'
          )
        }
      >
        {prefs.length > 0 ? (
          <Chips items={prefs} />
        ) : (
          <PendingPanel note="No preferences yet — added manually for now." />
        )}
      </Card>

      <Card title="Listings sent">
        {listingsSentPending ? (
          <PendingPanel />
        ) : (
          <EmptyRow>No listings sent yet.</EmptyRow>
        )}
      </Card>

      <Card title="Tours" aside={tours.length > 0 ? String(tours.length) : undefined}>
        {tours.length === 0 ? (
          <EmptyRow>No tours yet.</EmptyRow>
        ) : (
          tours.map((t) => (
            <Row
              key={`${t.placementId}:${t.date}`}
              to={`/placements/${t.placementId}`}
              label={`${unitLabel(unitMap, t.unitId)} · ${t.date}`}
              right={<span className={responseClass.muted}>{t.outcome ?? 'Scheduled'}</span>}
            />
          ))
        )}
      </Card>

      <Card title="Placements" aside={myPlacements.length > 0 ? String(myPlacements.length) : undefined}>
        {myPlacements.length === 0 ? (
          <EmptyRow>No placements yet.</EmptyRow>
        ) : (
          myPlacements.map((c) => (
            <Row
              key={c.placementId}
              to={`/placements/${c.placementId}`}
              label={unitLabel(unitMap, c.unitId)}
              right={STAGE_LABELS[c.stage] ?? c.stage}
            />
          ))
        )}
      </Card>

      <Card title="Group texts">
        <PendingPanel note="Group-text membership arrives with the backend." />
      </Card>

      <Card title="Media from comms">
        <MediaGallery media={media} loading={mediaLoading ?? false} />
      </Card>
    </>
  );
}
