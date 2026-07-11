// LandlordFile — the right pane for a landlord contact (§B3). Same shell as the
// tenant file; the cards center on the units they own: Details (role/company) -
// Notes - Properties (their units, with status) - Tours on their properties -
// Placements on their units - Group texts - Media. Properties + Placements + Tours +
// Group texts are REAL (from /api/units + /api/placements + /api/tours?unitId= +
// /api/contacts/:id/relay-groups). Notes are free text only — the structured
// preferences (accepted programs / lease terms / pet policy) and expected rent
// are PER-PROPERTY facts on the unit (moved 2026-07-10; GLOSSARY).
import {
  STAGE_LABELS,
  TOUR_STATUS_LABELS,
  type PlacementItem,
  type Contact,
  type ContactPhone,
  type RelayGroupRow,
  type Tour,
  type UnitItem,
} from '../../api/index.js';
import { StatusBadge } from '../../ui/index.js';
import {
  Card,
  CardAction,
  CardInlineAction,
  CollapsibleRows,
  EmptyRow,
  KV,
  NotesText,
  PendingPanel,
  Row,
  responseClass,
} from './Card.js';
import { DeadlineChip } from '../placements/DeadlineChip.js';
import { GroupTextsCard } from './GroupTextsCard.js';
import { LandlordOnboardingCard } from './LandlordOnboardingCard.js';
import { MediaGallery } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';
import { landlordPlacements, landlordUnits } from './buildContactFile.js';
import { contactStatusLabel, formatAddress, formatPhone } from './format.js';
import { CONTACT_TYPE_LABEL, displayKind } from './contactProfile.js';

export interface LandlordFileProps {
  contact: Contact;
  phones: ContactPhone[];
  placements: PlacementItem[];
  /** Tours on this landlord's properties — loaded via GET /api/tours?unitId= for
   *  each owned unit by the caller. Pass an empty array while loading or when none exist. */
  tours: Tour[];
  units: UnitItem[];
  /** Relay-membership slice status (panel degrades to pending on 404). */
  relayGroupsPending: boolean;
  /** The group texts (relay threads) this contact is a member of. */
  relayGroups: RelayGroupRow[];
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

/** The landlord lead status as its display LABEL — delegates to the shared
 *  contactStatusLabel (format.ts), pinned to the landlord vocabulary. */
function landlordStatusLabel(status: string): string {
  return contactStatusLabel('landlord', status);
}

/** A unit row label: "address - NBR" when both are known. */
function unitRowLabel(unit: UnitItem): string {
  const addr = formatAddress(unit.address) || unit.unitId;
  const beds = typeof unit.beds === 'number' ? ` - ${unit.beds}BR` : '';
  return `${addr}${beds}`;
}

export function LandlordFile({
  contact,
  phones,
  placements,
  tours,
  units,
  relayGroupsPending,
  relayGroups,
  media,
  mediaLoading,
  onEdit,
  onManagePhones,
  onAddProperty,
}: LandlordFileProps): React.JSX.Element {
  const myUnits = landlordUnits(units, contact.contactId);
  const unitMap = new Map(units.map((u) => [u.unitId, u]));
  const myPlacements = landlordPlacements(placements, units, contact.contactId);
  const phoneList = phones.map((p) => formatPhone(p.phone)).join(' - ');
  const company = typeof contact['company'] === 'string' ? contact['company'] : '—';
  // Notes — free-text only. The structured preferences (accepted programs,
  // lease terms, pet policy) and expected rent MOVED to the property record
  // (2026-07-10; per-unit facts on UnitItem — see each property's details card).
  const notes = typeof contact.notes === 'string' ? contact.notes.trim() : '';

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
                  {' - '}
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
        title="Notes"
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
        {notes !== '' ? (
          <NotesText text={notes} />
        ) : (
          <PendingPanel note="No notes yet — use + Add. (Programs, lease terms, and pet policy live on each property.)" />
        )}
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
          <CollapsibleRows
            rows={myUnits.map((u) => (
              <Row
                key={u.unitId}
                to={`/listings/${u.unitId}`}
                label={unitRowLabel(u)}
                right={<StatusBadge kind="listing" status={u.status} />}
              />
            ))}
          />
        )}
      </Card>

      <Card title="Tours on their properties" aside={tours.length > 0 ? String(tours.length) : undefined}>
        {tours.length === 0 ? (
          <EmptyRow>No tours on these properties yet.</EmptyRow>
        ) : (
          <CollapsibleRows
            rows={tours.map((t) => {
              const unit = unitMap.get(t.unitId);
              const addr = unit ? formatAddress(unit.address) || t.unitId : t.unitId;
              return (
                <Row
                  key={t.tourId}
                  to={`/tours/${t.tourId}`}
                  label={`${addr} - ${
                    t.scheduledAt !== undefined
                      ? new Date(t.scheduledAt).toLocaleDateString()
                      : 'Not booked'
                  }`}
                  right={<span className={responseClass.muted}>{TOUR_STATUS_LABELS[t.status] ?? t.status}</span>}
                />
              );
            })}
          />
        )}
      </Card>

      <Card title="Placements on their units" aside={myPlacements.length > 0 ? String(myPlacements.length) : undefined}>
        {myPlacements.length === 0 ? (
          <EmptyRow>No placements on these units yet.</EmptyRow>
        ) : (
          <CollapsibleRows
            rows={myPlacements.map((c) => {
              const unit = unitMap.get(c.unitId);
              const addr = unit ? formatAddress(unit.address) || c.unitId : c.unitId;
              return (
                <Row
                  key={c.placementId}
                  to={`/placements/${c.placementId}`}
                  label={addr}
                  right={
                    <>
                      <DeadlineChip placement={c} />
                      {STAGE_LABELS[c.stage] ?? c.stage}
                    </>
                  }
                />
              );
            })}
          />
        )}
      </Card>

      <GroupTextsCard pending={relayGroupsPending} groups={relayGroups} />

      <Card title="Media from comms">
        <MediaGallery media={media} loading={mediaLoading ?? false} />
      </Card>
    </>
  );
}
