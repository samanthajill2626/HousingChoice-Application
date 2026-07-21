// PartnerFile - the right pane for a PARTNER contact (type 'partner'): a resolved
// external party (caseworker, agency, inspector, ...) that is NOT a tenant or a
// landlord, so it shows ONLY the type-agnostic cards - Details (phones, status),
// Preferences & notes, and Media from comms. Deliberately omits the tenant cards
// (voucher / housing authority / listings-sent / tours / placements) and the
// landlord cards (units): a partner has no housing pipeline. Unlike UnknownFile it
// carries NO "Needs triage" call-to-action and NO Placements card - a partner is
// already classified (A2, email-channel-v1). Header pill reads "Partner" via
// CONTACT_TYPE_LABEL in ContactDetail.
import type { Contact, ContactPhone } from '../../api/index.js';
import { Card, CardAction, CardInlineAction, KV, NotesText, PendingPanel } from './Card.js';
import { MediaGallery } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';
import { contactStatusLabel, formatPhone } from './format.js';

export interface PartnerFileProps {
  contact: Contact;
  phones: ContactPhone[];
  /** "Media from comms" - derived from the live timeline (updates on send). */
  media: CommsMediaItem[];
  mediaLoading?: boolean;
  /** Open the edit dialog. */
  onEdit?: () => void;
  /** Open the "Manage numbers" dialog (Phone numbers row). */
  onManagePhones?: () => void;
}

export function PartnerFile({
  contact,
  phones,
  media,
  mediaLoading,
  onEdit,
  onManagePhones,
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
              {phoneList || '-'}
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
        <KV k="Status" v={contact.status ? contactStatusLabel(contact.type, contact.status) : '-'} />
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
        {notes ? (
          <NotesText text={notes} />
        ) : (
          <PendingPanel note={'No preferences yet - added manually for now.'} />
        )}
      </Card>

      <Card title="Media from comms">
        <MediaGallery media={media} loading={mediaLoading ?? false} />
      </Card>
    </>
  );
}
