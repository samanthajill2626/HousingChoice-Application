// LandlordFile — the right pane for a landlord contact (§B3). Same shell as the
// tenant file; the cards center on the units they own: Details (role/company) ·
// Preferences · Properties (their units, with status) · Tours on their properties ·
// Placements on their units · Group texts · Media. Properties + Placements + Tours
// are REAL (from /api/units + /api/placements + /api/tours?unitId=); Preferences +
// Group texts + Media are pending until their backend slices land.
import {
  LANDLORD_STATUS_LABELS,
  STAGE_LABELS,
  TOUR_STATUS_LABELS,
  type LandlordStatus,
  type PlacementItem,
  type Contact,
  type ContactPhone,
  type Tour,
  type UnitItem,
} from '../../api/index.js';
import { StatusBadge } from '../../ui/index.js';
import {
  Card,
  CardAction,
  CardInlineAction,
  EmptyRow,
  KV,
  PendingPanel,
  Row,
  responseClass,
} from './Card.js';
import { LandlordOnboardingCard } from './LandlordOnboardingCard.js';
import { MediaGallery } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';
import { landlordPlacements, landlordUnits } from './buildContactFile.js';
import { formatAddress, formatPhone, humanize } from './format.js';
import { CONTACT_TYPE_LABEL, displayKind } from './contactProfile.js';

export interface LandlordFileProps {
  contact: Contact;
  phones: ContactPhone[];
  placements: PlacementItem[];
  /** Tours on this landlord's properties — loaded via GET /api/tours?unitId= for
   *  each owned unit by the caller. Pass an empty array while loading or when none exist. */
  tours: Tour[];
  units: UnitItem[];
  /** "Media from comms" — derived from the live timeline (updates on send). */
  media: CommsMediaItem[];
  mediaLoading?: boolean;
  /** Open the edit dialog (Details "Edit" + Preferences "+ Add"). */
  onEdit?: () => void;
  /** Open the "Manage numbers" dialog (Phone numbers row). */
  onManagePhones?: () => void;
  /** Open the "New property" dialog pre-filled + locked to this landlord (Properties card). */
  onAddProperty?: () => void;
}

/** The landlord lead status as its display LABEL (mirrors StatusBadge's label
 *  resolution for tenants), falling back to a humanized form for an off-list value
 *  so the row never renders a raw snake_case token. */
function landlordStatusLabel(status: string): string {
  return LANDLORD_STATUS_LABELS[status as LandlordStatus] ?? humanize(status);
}

/** A unit row label: "address · NBR" when both are known. */
function unitRowLabel(unit: UnitItem): string {
  const addr = formatAddress(unit.address) || unit.unitId;
  const beds = typeof unit.beds === 'number' ? ` · ${unit.beds}BR` : '';
  return `${addr}${beds}`;
}

export function LandlordFile({
  contact,
  phones,
  placements,
  tours,
  units,
  media,
  mediaLoading,
  onEdit,
  onManagePhones,
  onAddProperty,
}: LandlordFileProps): React.JSX.Element {
  const myUnits = landlordUnits(units, contact.contactId);
  const unitMap = new Map(units.map((u) => [u.unitId, u]));
  const myPlacements = landlordPlacements(placements, units, contact.contactId);
  const phoneList = phones.map((p) => formatPhone(p.phone)).join(' · ');
  const company = typeof contact['company'] === 'string' ? contact['company'] : '—';

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
        <KV k="Role" v={displayKind(contact, (t) => CONTACT_TYPE_LABEL[t])} />
        <KV k="Company" v={company} />
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
        <KV k="Status" v={contact.status ? landlordStatusLabel(contact.status) : '—'} />
      </Card>

      <LandlordOnboardingCard contact={contact} />

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
        <PendingPanel note="Accepts-programs / lease terms / pet policy arrive with the backend." />
      </Card>

      <Card
        title="Properties"
        aside={
          onAddProperty ? (
            <CardAction onClick={onAddProperty} label="Add a property for this landlord">
              + Add a property
            </CardAction>
          ) : myUnits.length > 0 ? (
            String(myUnits.length)
          ) : undefined
        }
      >
        {myUnits.length === 0 ? (
          <EmptyRow>No properties yet.</EmptyRow>
        ) : (
          myUnits.map((u) => (
            <Row
              key={u.unitId}
              to={`/listings/${u.unitId}`}
              label={unitRowLabel(u)}
              right={<StatusBadge kind="listing" status={u.status} />}
            />
          ))
        )}
      </Card>

      <Card title="Tours on their properties" aside={tours.length > 0 ? String(tours.length) : undefined}>
        {tours.length === 0 ? (
          <EmptyRow>No tours on these properties yet.</EmptyRow>
        ) : (
          tours.map((t) => {
            const unit = unitMap.get(t.unitId);
            const addr = unit ? formatAddress(unit.address) || t.unitId : t.unitId;
            return (
              <Row
                key={t.tourId}
                to={`/tours/${t.tourId}`}
                label={`${addr} · ${
                  t.scheduledAt !== undefined
                    ? new Date(t.scheduledAt).toLocaleDateString()
                    : 'Not booked'
                }`}
                right={<span className={responseClass.muted}>{TOUR_STATUS_LABELS[t.status] ?? t.status}</span>}
              />
            );
          })
        )}
      </Card>

      <Card title="Placements on their units" aside={myPlacements.length > 0 ? String(myPlacements.length) : undefined}>
        {myPlacements.length === 0 ? (
          <EmptyRow>No placements on these units yet.</EmptyRow>
        ) : (
          myPlacements.map((c) => {
            const unit = unitMap.get(c.unitId);
            const addr = unit ? formatAddress(unit.address) || c.unitId : c.unitId;
            return (
              <Row
                key={c.placementId}
                to={`/placements/${c.placementId}`}
                label={addr}
                right={STAGE_LABELS[c.stage] ?? c.stage}
              />
            );
          })
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
