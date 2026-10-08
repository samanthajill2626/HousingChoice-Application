// PartnerFile - the right pane for a PARTNER contact (type 'partner'): a resolved
// external party (caseworker, agency, inspector, ...) that is NOT a tenant or a
// landlord. Details (phones, Role, Organization, status), the Staff notes card,
// Preferences & notes, Properties sent (+ Send, spec 2026-10-06 D20: a partner
// can be sent a property directly; its rows carry no tour chips, ruling
// R3-F5), Group threads and Media from comms. Deliberately omits
// the tenant cards (voucher / housing authority / tours / placements) and the
// landlord cards (units): a partner has no housing pipeline, and a converted
// caseworker's old tenant facts stay as data the page does not show (spec
// 2026-10-06 D19). Role is `displayKind` (a caseworker reads "Caseworker");
// Organization is `contact.organization` (spec D17, edited in the edit form).
// Unlike UnknownFile it carries NO "Needs triage" call-to-action - a partner is
// already classified (A2, email-channel-v1).
import type { Contact, ContactPhone, GroupThreadRow, ListingSendRow, UnitItem } from '../../api/index.js';
import { BLANK, Card, CardAction, CardInlineAction, EmptyRow, KV, NotesText, PendingPanel, SendRosterRow } from './Card.js';
import { GroupThreadsCard } from './GroupThreadsCard.js';
import { MediaGallery, type MediaGalleryPaging } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';
import { contactStatusLabel, formatAddress, formatPhone } from './format.js';
import { CONTACT_TYPE_LABEL, displayKind } from './contactProfile.js';
import { StaffNotesCard } from './StaffNotesCard.js';

export interface PartnerFileProps {
  contact: Contact;
  phones: ContactPhone[];
  /** "Media from comms" - derived from the live timeline (updates on send). */
  media: CommsMediaItem[];
  mediaLoading?: boolean;
  /** "Load older media" for the gallery (useContactMedia's paging), when the caller pages. */
  mediaPaging?: MediaGalleryPaging | undefined;
  /** NATIVE group texts this partner is a member of (C13 - see the card below).
   *  REQUIRED, not optional: the props are what make the wiring in
   *  ContactDetail a typecheck error to forget, which is how this card came to
   *  be absent from two of the four contact pages in the first place. */
  groupThreadsPending: boolean;
  groupThreads: GroupThreadRow[];
  groupThreadsTruncated: boolean;
  /** caseworkers D20: the units the page loaded (useContactFile, every contact)
   *  - the Properties sent rows' address labels. REQUIRED for the same reason
   *  as the group-threads props: a forgotten wiring is a typecheck error. */
  units: UnitItem[];
  /** C4 listings-sent slice status (the card degrades to pending). */
  listingsSentPending: boolean;
  /** C4 listings-sent rows - the properties shared with this partner. */
  listingsSent: ListingSendRow[];
  /** Open the seeded composer for this partner (Properties sent "+ Send"). */
  onSendProperty?: () => void;
  /** Open the edit dialog. */
  onEdit?: () => void;
  /** Open the "Manage numbers" dialog (Phone numbers row). */
  onManagePhones?: () => void;
  /** Receives the contact a Staff notes save returns (applied in place).
   *  Absent -> the Staff notes card is read-only. */
  onContactUpdated?: (updated: Contact) => void;
}

/** A unit's address line (or its id as a last resort) - TenantFile's rule. */
function sentUnitLabel(units: Map<string, UnitItem>, unitId: string): string {
  const unit = units.get(unitId);
  const addr = unit ? formatAddress(unit.address) : '';
  return addr || unitId;
}

export function PartnerFile({
  contact,
  phones,
  media,
  mediaLoading,
  mediaPaging,
  groupThreadsPending,
  groupThreads,
  groupThreadsTruncated,
  units,
  listingsSentPending,
  listingsSent,
  onSendProperty,
  onEdit,
  onManagePhones,
  onContactUpdated,
}: PartnerFileProps): React.JSX.Element {
  const phoneList = phones.map((p) => formatPhone(p.phone)).join(' - ');
  const unitMap = new Map(units.map((u) => [u.unitId, u]));
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
        <KV
          k="Phone numbers"
          v={
            <>
              {phoneList || BLANK}
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
        <KV k="Role" v={displayKind(contact, (t) => CONTACT_TYPE_LABEL[t])} />
        <KV
          k="Organization"
          v={typeof contact.organization === 'string' && contact.organization !== '' ? contact.organization : BLANK}
        />
        <KV k="Status" v={contact.status ? contactStatusLabel(contact.type, contact.status) : BLANK} />
      </Card>

      {/* Staff notes (spec D19, ruling R4-19): the hand-written box, apart from
          the AI-appended "Preferences & notes" below - so a converted
          caseworker's notes stay visible. Keyed by the contact, as on the
          tenant file. */}
      <StaffNotesCard
        key={contact.contactId}
        contactId={contact.contactId}
        value={contact.staff_notes}
        updatedAt={contact.staff_notes_updated_at}
        {...(onContactUpdated !== undefined && { onContactUpdated })}
      />

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
          <PendingPanel note={'No preferences yet - added manually for now.'} />
        )}
      </Card>

      {/* caseworkers D20: a partner can be sent a property directly (the
          normal share, into the partner's own conversation). Rows show NO tour
          chip (ruling R3-F5): a converted caseworker's tenant-era sends stay
          listed, but the partner page does not link that tenant history. */}
      <Card
        title="Properties sent"
        aside={
          onSendProperty ? (
            <CardAction onClick={onSendProperty} label="Send a property to this partner">
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
              identity={sentUnitLabel(unitMap, s.unitId)}
            />
          ))
        )}
      </Card>

      {/* PLACEMENT RULING (C13). "Group threads" is TYPE-AGNOSTIC: a group text
          is a plain carrier thread with no housing pipeline attached, and
          useContactFile already reads /group-threads for EVERY contact, so a
          partner on a coordination group paid for the read and saw nothing. It
          sits above "Media from comms" on all four pages so the ordering does
          not shift when a contact is triaged from unknown to tenant/landlord. */}
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
