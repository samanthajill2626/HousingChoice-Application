// TenantFile — the right pane for a tenant contact (§B2). Stacked cards:
// Details (voucher size, housing authority, current address, phone numbers,
// status) - Staff notes (tenants only) - Preferences & notes - Properties sent
// (C4) - Tours - Placements - Group texts - Media (C5). Placements + Tours +
// Properties-sent + Relay groups are REAL
// (/api/placements, /api/tours?tenantId=, /api/contacts/:id/listings-sent,
// /api/contacts/:id/relay-groups); Preferences are manual-now (pending until the
// gleaning slice). Each list row links to its detail route.
import {
  STAGE_LABELS,
  TOUR_STATUS_LABELS,
  type PlacementItem,
  type Contact,
  type ContactPhone,
  type FieldSource,
  type GroupThreadRow,
  type RelayGroupRow,
  type SuggestionItem,
  type Tour,
  type UnitItem,
  type ListingSendRow,
} from '../../api/index.js';
import { StatusBadge, contactStatusTone } from '../../ui/index.js';
import {
  BLANK,
  Card,
  CardAction,
  CardInlineAction,
  NotesText,
  EmptyRow,
  KV,
  PendingPanel,
  Row,
  SendRosterRow,
  responseClass,
} from './Card.js';
import { DeadlineChip } from '../placements/DeadlineChip.js';
import { AutoBadge } from './AutoBadge.js';
import { SuggestionChip } from './SuggestionChip.js';
import { SUGGESTION_TARGET_LABEL, aiSourceOf, suggestionFor } from './suggestionTargets.js';
import { EligibilityIntakeCard } from './EligibilityIntakeCard.js';
import { GroupTextsCard } from './GroupTextsCard.js';
import { GroupThreadsCard } from './GroupThreadsCard.js';
import { StaffNotesCard } from './StaffNotesCard.js';
import { MediaGallery, type MediaGalleryPaging } from './MediaGallery.js';
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
  /** The relay groups (relay threads) this contact is a member of. */
  relayGroups: RelayGroupRow[];
  groupThreadsPending: boolean;
  /** The contact's NATIVE group texts (the "Group threads" card). */
  groupThreads: GroupThreadRow[];
  /** The bounded group-threads read stopped early - the card says so. */
  groupThreadsTruncated: boolean;
  /** Pending AI suggestions for this contact (conversation-fact-extraction). A
   *  chip renders under a field only when a suggestion for that target is present
   *  here - the server is authoritative (no client-side policy). */
  suggestions?: SuggestionItem[];
  /** Accept / dismiss a suggestion by target. */
  onAcceptSuggestion?: (target: string) => void;
  onDismissSuggestion?: (target: string) => void;
  /** The target currently mid-accept/dismiss (disables its chip). */
  suggestionBusy?: string | null;
  /** An inline error for one chip (e.g. a 409 phone conflict). */
  suggestionError?: { target: string; message: string } | null;
  /** "Media from comms" — derived from the live timeline (updates as messages
   *  arrive); `mediaLoading` covers the brief window before the timeline lands. */
  media: CommsMediaItem[];
  mediaLoading?: boolean;
  /** "Load older media" for the gallery (useContactMedia's paging), when the caller pages. */
  mediaPaging?: MediaGalleryPaging | undefined;
  /** Open the edit dialog (Details "Edit" + Preferences "+ Add"). */
  onEdit?: () => void;
  /** Apply a contact the Staff notes card saved (the file pane's setContact).
   *  Absent -> that card is read-only. */
  onContactUpdated?: (updated: Contact) => void;
  /** Open the "Manage numbers" dialog (Phone numbers row). */
  onManagePhones?: () => void;
  /** Open the "New placement" dialog pre-filled+locked to this tenant (Placements
   *  card "+ Start placement"). Only the tenant view wires this. */
  onStartPlacement?: () => void;
  /** Open the "Schedule tour" dialog (Tours card "+ Schedule"). */
  onScheduleTour?: () => void;
  /** Open the seeded composer for this tenant (Properties sent card "+ Send"). */
  onSendProperty?: () => void;
  /** Open the "Create a relay group" dialog seeded with this contact (Relay
   *  groups card "+ Create group"). */
  onCreateRelayGroup?: () => void;
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
  tours,
  units,
  listingsSentPending,
  listingsSent,
  relayGroupsPending,
  relayGroups,
  groupThreadsPending,
  groupThreads,
  groupThreadsTruncated,
  media,
  mediaLoading,
  mediaPaging,
  suggestions = [],
  onAcceptSuggestion,
  onDismissSuggestion,
  suggestionBusy,
  suggestionError,
  onEdit,
  onContactUpdated,
  onManagePhones,
  onStartPlacement,
  onScheduleTour,
  onSendProperty,
  onCreateRelayGroup,
}: TenantFileProps): React.JSX.Element {
  const unitMap = new Map(units.map((u) => [u.unitId, u]));
  // A pending suggestion for `target` rendered as a review chip (or null). Shared
  // by the Details rows below and passed down to the Eligibility intake card.
  const chipFor = (target: string): React.JSX.Element | null => {
    const s = suggestionFor(suggestions, target);
    if (!s) return null;
    return (
      <SuggestionChip
        label={SUGGESTION_TARGET_LABEL[target] ?? target}
        suggestion={s}
        onAccept={() => onAcceptSuggestion?.(target)}
        onDismiss={() => onDismissSuggestion?.(target)}
        busy={suggestionBusy === target}
        error={suggestionError?.target === target ? suggestionError.message : null}
      />
    );
  };
  // The AutoBadge for a field whose value carries AI provenance (or null).
  const badgeFor = (field: string): React.JSX.Element | null => {
    const src = aiSourceOf(contact, field);
    return src ? <AutoBadge {...(src.at !== undefined && { at: src.at })} /> : null;
  };
  const myPlacements = tenantPlacements(placements, contact.contactId);
  const phoneList = phones.map((p) => formatPhone(p.phone)).join(' - ');
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
        <KV k="Voucher size" v={<>{voucher}{badgeFor('voucherSize')}</>} />
        {chipFor('voucherSize')}
        <KV k="Housing authority" v={<>{housingAuthority}{badgeFor('housingAuthority')}</>} />
        {chipFor('housingAuthority')}
        {/* The helper organization that assists this tenant - NOT the authority
            that issues the voucher. No AI badge or suggestion chip: nothing
            extracts `agency`, so it is deliberately not a provenance field.
            `||`, never `??`: a CLEARED agency persists as '' (it has no GSI, so
            unlike housingAuthority the empty string stores cleanly), and '' is
            not nullish - it would render a blank cell between two em-dashed
            siblings. Same idiom as the unit-side twin, ListingDetail.tsx. */}
        <KV k="Agency" v={contact.agency || BLANK} />
        <KV k="Current address" v={<>{currentAddress}{badgeFor('address')}</>} />
        {chipFor('address')}
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
        {chipFor('phone')}
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
                <span className={responseClass.muted}> - Porting</span>
              ) : null}
              {badgeFor('porting')}
            </>
          }
        />
        {chipFor('status')}
        {chipFor('porting')}
      </Card>

      <EligibilityIntakeCard
        contact={contact}
        suggestions={suggestions}
        {...(onAcceptSuggestion && { onAcceptSuggestion })}
        {...(onDismissSuggestion && { onDismissSuggestion })}
        {...(suggestionBusy !== undefined && { suggestionBusy })}
        {...(suggestionError !== undefined && { suggestionError })}
      />

      {/* Staff notes (item 22): the hand-written box, kept apart from the
          AI-appended "Preferences & notes" below. TENANTS ONLY - this file
          also serves team_member contacts, who do not get it. Keyed by the
          contact, defensively: today a contact-to-contact navigation
          UNMOUNTS this pane and the card (ContactDetail renders its spinner,
          not the file, while useContact derives "loading" for the new id),
          so the key changes nothing. It matters only if a future caller
          swaps the contact in place: then an editor open on tenant A must
          not carry A's draft - or a Save of it - over to tenant B. */}
      {contact.type === 'tenant' ? (
        <StaffNotesCard
          key={contact.contactId}
          contactId={contact.contactId}
          value={contact.staff_notes}
          updatedAt={contact.staff_notes_updated_at}
          onContactUpdated={onContactUpdated}
        />
      ) : null}

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
        aside={
          onSendProperty ? (
            <CardAction onClick={onSendProperty} label="Send a property to this tenant">
              + Send
            </CardAction>
          ) : undefined
        }
      >
        {listingsSentPending ? (
          <PendingPanel />
        ) : listingsSent.length === 0 ? (
          <EmptyRow>No properties sent yet.</EmptyRow>
        ) : (
          listingsSent.map((s) => (
            <SendRosterRow
              key={`${s.unitId}:${s.sentAt}`}
              to={`/listings/${s.unitId}`}
              identity={unitLabel(unitMap, s.unitId)}
              {...(s.tour && { tour: s.tour })}
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
              label={`${unitLabel(unitMap, t.unitId)} - ${
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
              right={
                <>
                  <DeadlineChip placement={c} />
                  {STAGE_LABELS[c.stage] ?? c.stage}
                </>
              }
            />
          ))
        )}
      </Card>

      <GroupTextsCard
        pending={relayGroupsPending}
        groups={relayGroups}
        onCreate={onCreateRelayGroup}
      />

      <GroupThreadsCard
        pending={groupThreadsPending}
        groups={groupThreads}
        truncated={groupThreadsTruncated}
      />

      <Card title="Media from comms">
        <MediaGallery media={media} loading={mediaLoading ?? false} paging={mediaPaging} />
      </Card>
    </>
  );
}
