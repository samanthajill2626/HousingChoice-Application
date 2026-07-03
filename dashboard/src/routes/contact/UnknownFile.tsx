// UnknownFile — the right pane for an UNTRIAGED contact (type 'unknown'): a new
// inbound we don't yet know is a tenant or landlord. So we show ONLY what's
// type-agnostic — Details (phones, status), Preferences & notes, any Placements, and
// Media — and lead with a triage call-to-action. The classify actions are
// DISABLED until a backend triage endpoint exists (every /api/contacts route is
// GET today); they signal the intended workflow without faking an action that
// can't persist. Deliberately omits the tenant cards (voucher / housing authority
// / listings-sent / tours) and landlord cards (units) — those presume a type we
// don't have yet, which is exactly the bug this fixes.
import type { PlacementItem, Contact, ContactPhone, UnitItem } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Card, CardAction, CardInlineAction, EmptyRow, KV, NotesText, PendingPanel, Row } from './Card.js';
import { MediaGallery } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';
import { tenantPlacements } from './buildContactFile.js';
import { contactStatusLabel, formatAddress, formatPhone } from './format.js';
import styles from './UnknownFile.module.css';

export interface UnknownFileProps {
  contact: Contact;
  phones: ContactPhone[];
  placements: PlacementItem[];
  units: UnitItem[];
  /** "Media from comms" — derived from the live timeline (updates on send). */
  media: CommsMediaItem[];
  mediaLoading?: boolean;
  /** Open the edit dialog. */
  onEdit?: () => void;
  /** Open the "Manage numbers" dialog (Phone numbers row). */
  onManagePhones?: () => void;
  /** Triage this untriaged contact to a known type (tenant/landlord). In flight,
   *  `triaging` disables the buttons. */
  onTriage?: (type: 'tenant' | 'landlord') => void;
  triaging?: boolean;
}

export function UnknownFile({
  contact,
  phones,
  placements,
  units,
  media,
  mediaLoading,
  onEdit,
  onManagePhones,
  onTriage,
  triaging = false,
}: UnknownFileProps): React.JSX.Element {
  const unitMap = new Map(units.map((u) => [u.unitId, u]));
  // Placements that reference this contact (none expected for a fresh inbound, but show
  // them if a navigator linked one before triaging).
  const myPlacements = tenantPlacements(placements, contact.contactId);
  const phoneList = phones.map((p) => formatPhone(p.phone)).join(' · ');
  const notes = typeof contact.notes === 'string' ? contact.notes.trim() : '';

  return (
    <>
      <Card title="Needs triage">
        <p className={styles.note}>
          This contact hasn&apos;t been classified yet. Classify them as a tenant or
          landlord to file them correctly and unlock the matching workspace.
        </p>
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
                  {' · '}
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

      <Card title="Placements" aside={myPlacements.length > 0 ? String(myPlacements.length) : undefined}>
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

      <Card title="Media from comms">
        <MediaGallery media={media} loading={mediaLoading ?? false} />
      </Card>
    </>
  );
}
