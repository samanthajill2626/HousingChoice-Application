// PartnerFile - the right pane for a PARTNER contact (type 'partner'): a resolved
// external party (caseworker, agency, inspector, ...) that is NOT a tenant or a
// landlord. Details (phones, Role, Organization, status), the Staff notes card,
// Preferences & notes, Group threads and Media from comms. Deliberately omits
// the tenant cards (voucher / housing authority / tours / placements) and the
// landlord cards (units): a partner has no housing pipeline, and a converted
// caseworker's old tenant facts stay as data the page does not show (spec
// 2026-10-06 D19). Role is `displayKind` (a caseworker reads "Caseworker");
// Organization is `contact.organization` (spec D17, edited in the edit form).
// Unlike UnknownFile it carries NO "Needs triage" call-to-action - a partner is
// already classified (A2, email-channel-v1).
import type { Contact, ContactPhone, GroupThreadRow } from '../../api/index.js';
import { BLANK, Card, CardAction, CardInlineAction, KV, NotesText, PendingPanel } from './Card.js';
import { GroupThreadsCard } from './GroupThreadsCard.js';
import { MediaGallery, type MediaGalleryPaging } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';
import { contactStatusLabel, formatPhone } from './format.js';
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
  /** Open the edit dialog. */
  onEdit?: () => void;
  /** Open the "Manage numbers" dialog (Phone numbers row). */
  onManagePhones?: () => void;
  /** Receives the contact a Staff notes save returns (applied in place).
   *  Absent -> the Staff notes card is read-only. */
  onContactUpdated?: (updated: Contact) => void;
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
  onEdit,
  onManagePhones,
  onContactUpdated,
}: PartnerFileProps): React.JSX.Element {
  const phoneList = phones.map((p) => formatPhone(p.phone)).join(' - ');
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
