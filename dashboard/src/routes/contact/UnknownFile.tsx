// UnknownFile — the right pane for an UNTRIAGED contact (type 'unknown'): a new
// inbound we don't yet know is a tenant, landlord, partner, or property manager. So we show ONLY what's
// type-agnostic — Details (phones, status), Preferences & notes, any Placements, and
// Media — and lead with a triage call-to-action. The classify actions are
// DISABLED until a backend triage endpoint exists (every /api/contacts route is
// GET today); they signal the intended workflow without faking an action that
// can't persist. Deliberately omits the tenant cards (voucher / housing authority
// / listings-sent / tours) and landlord cards (units) — those presume a type we
// don't have yet, which is exactly the bug this fixes.
import type {
  PlacementItem,
  Contact,
  ContactPhone,
  GroupThreadRow,
  SuggestionItem,
  UnitItem,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Card, CardAction, CardInlineAction, EmptyRow, KV, NotesText, PendingPanel, Row } from './Card.js';
import { GroupThreadsCard } from './GroupThreadsCard.js';
import { MediaGallery, type MediaGalleryPaging } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';
import { tenantPlacements } from './buildContactFile.js';
import { suggestionFor } from './suggestionTargets.js';
import { contactStatusLabel, formatAddress, formatPhone } from './format.js';
import { suggestedContactKindLabel, type SuggestedContactKind } from './contactProfile.js';
import styles from './UnknownFile.module.css';

export interface UnknownFileProps {
  contact: Contact;
  phones: ContactPhone[];
  placements: PlacementItem[];
  units: UnitItem[];
  /** "Media from comms" — derived from the live timeline (updates on send). */
  media: CommsMediaItem[];
  mediaLoading?: boolean;
  /** "Load older media" for the gallery (useContactMedia's paging), when the caller pages. */
  mediaPaging?: MediaGalleryPaging | undefined;
  /** NATIVE group texts this contact is a member of (C13 - see the card below).
   *  REQUIRED, not optional: the props are what make the wiring in ContactDetail
   *  a typecheck error to forget, which is how this card came to be absent from
   *  two of the four contact pages in the first place. */
  groupThreadsPending: boolean;
  groupThreads: GroupThreadRow[];
  groupThreadsTruncated: boolean;
  /** Open the edit dialog. */
  onEdit?: () => void;
  /** Open the "Manage numbers" dialog (Phone numbers row). */
  onManagePhones?: () => void;
  /** Triage this untriaged contact to a known kind. In flight,
   *  `triaging` disables the buttons. */
  onTriage?: (kind: SuggestedContactKind) => void;
  triaging?: boolean;
  /** Pending AI suggestions - a `type` suggestion surfaces a recommendation line
   *  inside the triage card (the Mark-as buttons remain the action). */
  suggestions?: SuggestionItem[];
}

export function UnknownFile({
  contact,
  phones,
  placements,
  units,
  media,
  mediaLoading,
  mediaPaging,
  groupThreadsPending,
  groupThreads,
  groupThreadsTruncated,
  onEdit,
  onManagePhones,
  onTriage,
  triaging = false,
  suggestions = [],
}: UnknownFileProps): React.JSX.Element {
  const unitMap = new Map(units.map((u) => [u.unitId, u]));
  const typeSuggestion = suggestionFor(suggestions, 'type');
  // Placements that reference this contact (none expected for a fresh inbound, but show
  // them if a navigator linked one before triaging).
  const myPlacements = tenantPlacements(placements, contact.contactId);
  const phoneList = phones.map((p) => formatPhone(p.phone)).join(' - ');
  const notes = typeof contact.notes === 'string' ? contact.notes.trim() : '';

  return (
    <>
      <Card title="Needs triage">
        <p className={styles.note}>
          This contact hasn&apos;t been classified yet. Classify them as a Tenant,
          Landlord, Partner, or Property Manager to file them correctly and unlock the
          matching workspace.
        </p>
        {typeSuggestion ? (
          <p className={styles.aiSuggest}>
            {`AI suggests: ${suggestedContactKindLabel(typeSuggestion.suggestedValue)}`}
            {typeSuggestion.reason ? ` - ${typeSuggestion.reason}` : null}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            disabled={triaging || !onTriage}
            onClick={() => onTriage?.('tenant')}
          >
            Mark as Tenant
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={triaging || !onTriage}
            onClick={() => onTriage?.('landlord')}
          >
            Mark as Landlord
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={triaging || !onTriage}
            onClick={() => onTriage?.('partner')}
          >
            Mark as Partner
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={triaging || !onTriage}
            onClick={() => onTriage?.('property_manager')}
          >
            Mark as Property Manager
          </Button>
        </div>
      </Card>

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
        <KV k="Status" v={contact.status ? contactStatusLabel(contact.type, contact.status) : '—'} />
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
          <PendingPanel note="No preferences yet — added manually for now." />
        )}
      </Card>

      <Card title="Placements">
        {myPlacements.length === 0 ? (
          <EmptyRow>No placements yet.</EmptyRow>
        ) : (
          myPlacements.map((c) => {
            const unit = unitMap.get(c.unitId);
            const addr = unit ? formatAddress(unit.address) || c.unitId : c.unitId;
            return <Row key={c.placementId} to={`/placements/${c.placementId}`} label={addr} right={c.stage} />;
          })
        )}
      </Card>

      {/* PLACEMENT RULING (C13). This is the page that needed it MOST: detection
          mints every unseen group member as `type:'unknown', status:'needs_review'`
          (app/src/services/groupMembers.ts), so an untriaged contact IS the
          default state of a group member - and the group thread is where the
          evidence for triaging them lives. useContactFile already reads
          /group-threads for every contact, so this card costs no request. Same
          slot as the other three pages (above "Media from comms") so the layout
          does not shift when the contact is triaged. */}
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
