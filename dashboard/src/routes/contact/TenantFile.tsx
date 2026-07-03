// TenantFile — the right pane for a tenant contact (§B2). Stacked cards:
// Details (voucher size, housing authority, current address, phone numbers,
// status) · Preferences & notes · Properties sent (C4) · Tours · Placements · Group
// texts · Media (C5). Placements + Tours + Properties-sent + Group texts are REAL
// (/api/placements, /api/tours?tenantId=, /api/contacts/:id/listings-sent,
// /api/contacts/:id/relay-groups); Preferences are manual-now (pending until the
// gleaning slice). Each list row links to its detail route.
import {
  STAGE_LABELS,
  TOUR_STATUS_LABELS,
  type PlacementItem,
  type Contact,
  type ContactPhone,
  type RelayGroupRow,
  type Tour,
  type UnitItem,
  type ListingSendRow,
  type ListingResponse,
} from '../../api/index.js';
import { StatusBadge, contactStatusTone } from '../../ui/index.js';
import {
  Card,
  CardAction,
  CardInlineAction,
  NotesText,
  EmptyRow,
  KV,
  PendingPanel,
  Row,
  responseClass,
} from './Card.js';
import { EligibilityIntakeCard } from './EligibilityIntakeCard.js';
import { GroupTextsCard } from './GroupTextsCard.js';
import { MediaGallery } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';
import { tenantPlacements } from './buildContactFile.js';
import { contactStatusLabel, formatAddress, formatPhone } from './format.js';

export interface TenantFileProps {
  contact: Contact;
  phones: ContactPhone[];
  placements: PlacementItem[];
  /** Tours for this tenant — loaded via GET /api/tours?tenantId= by the caller.
   *  Pass an empty array while loading or when none exist. */
  tours: Tour[];
  units: UnitItem[];
  /** C4 listings-sent slice status (panel degrades to pending on 404). */
  listingsSentPending: boolean;
  /** C4 listings-sent rows — the properties broadcast/sent to this tenant. */
  listingsSent: ListingSendRow[];
  /** Relay-membership slice status (panel degrades to pending on 404). */
  relayGroupsPending: boolean;
  /** The group texts (relay threads) this contact is a member of. */
  relayGroups: RelayGroupRow[];
  /** "Media from comms" — derived from the live timeline (updates as messages
   *  arrive); `mediaLoading` covers the brief window before the timeline lands. */
  media: CommsMediaItem[];
  mediaLoading?: boolean;
  /** Open the edit dialog (Details "Edit" + Preferences "+ Add"). */
  onEdit?: () => void;
  /** Open the "Manage numbers" dialog (Phone numbers row). */
  onManagePhones?: () => void;
  /** Open the "New placement" dialog pre-filled+locked to this tenant (Placements
   *  card "+ Start placement"). Only the tenant view wires this. */
  onStartPlacement?: () => void;
  /** Open the "Schedule tour" dialog (Tours card "+ Schedule"). */
  onScheduleTour?: () => void;
}

/** A unit's address line (or its id as a last resort), for a row label. */
function unitLabel(units: Map<string, UnitItem>, unitId: string): string {
  const unit = units.get(unitId);
  const addr = unit ? formatAddress(unit.address) : '';
  return addr || unitId;
}

/** The tenant's reaction to a sent listing, as a row's right-hand label. */
const LISTING_RESPONSE_LABEL: Record<ListingResponse, string> = {
  interested: 'Interested',
  not_a_fit: 'Not a fit',
  no_reply: 'No reply',
};

export function TenantFile({
  contact,
  phones,
  placements,
  tours,
  units,
  listingsSentPending,
  listingsSent,
  relayGroupsPending,
  relayGroups,
  media,
  mediaLoading,
  onEdit,
  onManagePhones,
  onStartPlacement,
  onScheduleTour,
}: TenantFileProps): React.JSX.Element {
  const unitMap = new Map(units.map((u) => [u.unitId, u]));
  const myPlacements = tenantPlacements(placements, contact.contactId);
  const phoneList = phones.map((p) => formatPhone(p.phone)).join(' · ');
  const voucher = typeof contact.voucherSize === 'number' ? `${contact.voucherSize} BR` : '—';
  const housingAuthority = contact.housingAuthority ?? '—';
  const currentAddress = formatAddress(contact.address) || '—';
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
              {contact.status ? (
                // The status is already the prominent header badge, so here it reads
                // as plain text — EXCEPT when it wants attention (warn tone, e.g.
                // "Needs review"), where the pill still earns its colour.
                contactStatusTone(contact.type, contact.status) === 'warn' ? (
                  <StatusBadge kind="tenant" status={contact.status} />
                ) : (
                  contactStatusLabel(contact.type, contact.status)
                )
              ) : (
                '—'
              )}
              {contact.porting === true ? (
                <span className={responseClass.muted}> · Porting</span>
              ) : null}
            </>
          }
        />
      </Card>

      <EligibilityIntakeCard contact={contact} />

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
        {notes ? (
          <NotesText text={notes} />
        ) : (
          <PendingPanel note="No preferences yet — added manually for now." />
        )}
      </Card>

      <Card
        title="Properties sent"
        aside={listingsSent.length > 0 ? String(listingsSent.length) : undefined}
      >
        {listingsSentPending ? (
          <PendingPanel />
        ) : listingsSent.length === 0 ? (
          <EmptyRow>No properties sent yet.</EmptyRow>
        ) : (
          listingsSent.map((s) => (
            <Row
              key={`${s.unitId}:${s.sentAt}`}
              to={`/listings/${s.unitId}`}
              label={unitLabel(unitMap, s.unitId)}
              right={
                <span className={responseClass.muted}>{LISTING_RESPONSE_LABEL[s.response]}</span>
              }
            />
          ))
        )}
      </Card>

      <Card
        title="Tours"
        aside={
          onScheduleTour ? (
            <CardAction onClick={onScheduleTour} label="Schedule a tour">
              + Schedule
            </CardAction>
          ) : undefined
        }
      >
        {tours.length === 0 ? (
          <EmptyRow>No tours yet.</EmptyRow>
        ) : (
          tours.map((t) => (
            <Row
              key={t.tourId}
              to={`/tours/${t.tourId}`}
              label={`${unitLabel(unitMap, t.unitId)} · ${
                t.scheduledAt !== undefined
                  ? new Date(t.scheduledAt).toLocaleDateString()
                  : 'Not booked'
              }`}
              right={<span className={responseClass.muted}>{TOUR_STATUS_LABELS[t.status] ?? t.status}</span>}
            />
          ))
        )}
      </Card>

      <Card
        title="Placements"
        aside={
          onStartPlacement ? (
            <CardAction onClick={onStartPlacement} label="Start a placement">
              + Start placement
            </CardAction>
          ) : undefined
        }
      >
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

      <GroupTextsCard pending={relayGroupsPending} groups={relayGroups} />

      <Card title="Media from comms">
        <MediaGallery media={media} loading={mediaLoading ?? false} />
      </Card>
    </>
  );
}
