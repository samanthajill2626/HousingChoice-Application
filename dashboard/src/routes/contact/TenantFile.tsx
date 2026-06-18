// TenantFile — the right pane for a tenant contact (§B2). Stacked cards:
// Details (voucher size, housing authority, current address, phone numbers,
// status) · Preferences & notes · Listings sent (C4) · Tours · Cases · Group
// texts · Media (C5). Cases + Tours are REAL (derived from /api/cases);
// Listings-sent + Media render a "pending backend" state until BE4/BE5 land;
// Preferences are manual-now (pending until the gleaning slice). Each list row
// links to its detail route.
import type { CaseItem, Contact, ContactPhone, UnitItem } from '../../api/index.js';
import {
  Card,
  CardAction,
  CardInlineAction,
  Chips,
  EmptyRow,
  KV,
  PendingPanel,
  Row,
  responseClass,
} from './Card.js';
import { MediaGallery } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';
import { tenantCases, tenantTours } from './buildContactFile.js';
import { formatAddress, formatPhone } from './format.js';

export interface TenantFileProps {
  contact: Contact;
  phones: ContactPhone[];
  cases: CaseItem[];
  units: UnitItem[];
  /** C4 listings-sent slice status (panel degrades to pending on 404). */
  listingsSentPending: boolean;
  /** "Media from comms" — derived from the live timeline (updates as messages
   *  arrive); `mediaLoading` covers the brief window before the timeline lands. */
  media: CommsMediaItem[];
  mediaLoading?: boolean;
  /** Open the edit dialog (Details "Edit" + Preferences "+ Add"). */
  onEdit?: () => void;
  /** Open the "Manage numbers" dialog (Phone numbers row). */
  onManagePhones?: () => void;
}

/** A unit's address line (or its id as a last resort), for a row label. */
function unitLabel(units: Map<string, UnitItem>, unitId: string): string {
  const unit = units.get(unitId);
  const addr = unit ? formatAddress(unit.address) : '';
  return addr || unitId;
}

const STAGE_LABEL: Record<string, string> = {
  interested: 'Interested',
  porting: 'Porting',
  touring: 'Touring',
  applied: 'Applied',
  rta_submitted: 'RTA submitted',
  inspection: 'Inspection',
  rent_determined: 'Rent determined',
  lease: 'Lease',
  moved_in: 'Moved in',
  lost: 'Lost',
};

export function TenantFile({
  contact,
  phones,
  cases,
  units,
  listingsSentPending,
  media,
  mediaLoading,
  onEdit,
  onManagePhones,
}: TenantFileProps): React.JSX.Element {
  const unitMap = new Map(units.map((u) => [u.unitId, u]));
  const myCases = tenantCases(cases, contact.contactId);
  const tours = tenantTours(cases, contact.contactId);
  const phoneList = phones.map((p) => formatPhone(p.phone)).join(' · ');
  const voucher = typeof contact.voucherSize === 'number' ? `${contact.voucherSize} BR` : '—';
  const housingAuthority = contact.housingAuthority ?? '—';
  const currentAddress = formatAddress(contact.address) || '—';
  const prefs = typeof contact.notes === 'string' && contact.notes.trim() ? [contact.notes.trim()] : [];

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
        {prefs.length > 0 ? (
          <Chips items={prefs} />
        ) : (
          <PendingPanel note="No preferences yet — added manually for now." />
        )}
      </Card>

      <Card title="Listings sent">
        {listingsSentPending ? (
          <PendingPanel />
        ) : (
          <EmptyRow>No listings sent yet.</EmptyRow>
        )}
      </Card>

      <Card title="Tours" aside={tours.length > 0 ? String(tours.length) : undefined}>
        {tours.length === 0 ? (
          <EmptyRow>No tours yet.</EmptyRow>
        ) : (
          tours.map((t) => (
            <Row
              key={`${t.caseId}:${t.date}`}
              to={`/cases/${t.caseId}`}
              label={`${unitLabel(unitMap, t.unitId)} · ${t.date}`}
              right={<span className={responseClass.muted}>{t.outcome ?? 'Scheduled'}</span>}
            />
          ))
        )}
      </Card>

      <Card title="Cases" aside={myCases.length > 0 ? String(myCases.length) : undefined}>
        {myCases.length === 0 ? (
          <EmptyRow>No cases yet.</EmptyRow>
        ) : (
          myCases.map((c) => (
            <Row
              key={c.caseId}
              to={`/cases/${c.caseId}`}
              label={unitLabel(unitMap, c.unitId)}
              right={STAGE_LABEL[c.stage] ?? c.stage}
            />
          ))
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
