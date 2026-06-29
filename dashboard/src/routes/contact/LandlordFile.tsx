// LandlordFile — the right pane for a landlord contact (§B3). Same shell as the
// tenant file; the cards center on the units they own: Details (role/company) ·
// Preferences · Properties (their units, with status) · Placements on their units ·
// Group texts · Media. Properties + Placements are REAL (from /api/units + /api/placements);
// Preferences + Group texts + Media are pending until their backend slices land.
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
  EmptyRow,
  KV,
  PendingPanel,
  Row,
} from './Card.js';
import { MediaGallery } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';
import { landlordPlacements, landlordUnits } from './buildContactFile.js';
import { formatAddress, formatPhone } from './format.js';
import { CONTACT_TYPE_LABEL, displayKind } from './contactProfile.js';

export interface LandlordFileProps {
  contact: Contact;
  phones: ContactPhone[];
  placements: PlacementItem[];
  units: UnitItem[];
  /** "Media from comms" — derived from the live timeline (updates on send). */
  media: CommsMediaItem[];
  mediaLoading?: boolean;
  /** Open the edit dialog (Details "Edit" + Preferences "+ Add"). */
  onEdit?: () => void;
  /** Open the "Manage numbers" dialog (Phone numbers row). */
  onManagePhones?: () => void;
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
  units,
  media,
  mediaLoading,
  onEdit,
  onManagePhones,
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
        <KV k="Status" v={contact.status ?? '—'} />
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
        <PendingPanel note="Accepts-programs / lease terms / pet policy arrive with the backend." />
      </Card>

      <Card title="Properties" aside={myUnits.length > 0 ? String(myUnits.length) : undefined}>
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
