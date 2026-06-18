// LandlordFile — the right pane for a landlord contact (§B3). Same shell as the
// tenant file; the cards center on the units they own: Details (role/company) ·
// Preferences · Listings (their units, with status) · Cases on their units ·
// Group texts · Media. Listings + Cases are REAL (from /api/units + /api/cases);
// Preferences + Group texts + Media are pending until their backend slices land.
import type { CaseItem, Contact, ContactPhone, UnitItem } from '../../api/index.js';
import {
  Card,
  CardAction,
  CardInlineAction,
  EmptyRow,
  KV,
  PendingPanel,
  Row,
  responseClass,
} from './Card.js';
import { MediaGallery } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';
import { landlordCases, landlordUnits } from './buildContactFile.js';
import { formatAddress, formatPhone } from './format.js';

export interface LandlordFileProps {
  contact: Contact;
  phones: ContactPhone[];
  cases: CaseItem[];
  units: UnitItem[];
  /** "Media from comms" — derived from the live timeline (updates on send). */
  media: CommsMediaItem[];
  mediaLoading?: boolean;
  /** Open the edit dialog (Details "Edit" + Preferences "+ Add"). */
  onEdit?: () => void;
  /** Open the "Manage numbers" dialog (Phone numbers row). */
  onManagePhones?: () => void;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  available: { label: '● Available', cls: responseClass.available },
  placed: { label: '● Placed', cls: responseClass.placed },
  inactive: { label: '● Inactive', cls: responseClass.inactive },
};

/** A unit row label: "address · NBR" when both are known. */
function unitRowLabel(unit: UnitItem): string {
  const addr = formatAddress(unit.address) || unit.unitId;
  const beds = typeof unit.beds === 'number' ? ` · ${unit.beds}BR` : '';
  return `${addr}${beds}`;
}

export function LandlordFile({
  contact,
  phones,
  cases,
  units,
  media,
  mediaLoading,
  onEdit,
  onManagePhones,
}: LandlordFileProps): React.JSX.Element {
  const myUnits = landlordUnits(units, contact.contactId);
  const unitMap = new Map(units.map((u) => [u.unitId, u]));
  const myCases = landlordCases(cases, units, contact.contactId);
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
        <KV k="Role" v={contact.type === 'pm' ? 'Property manager' : 'Landlord'} />
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

      <Card title="Listings" aside={myUnits.length > 0 ? String(myUnits.length) : undefined}>
        {myUnits.length === 0 ? (
          <EmptyRow>No listings yet.</EmptyRow>
        ) : (
          myUnits.map((u) => {
            const meta = STATUS_META[u.status] ?? { label: u.status, cls: responseClass.muted };
            return (
              <Row
                key={u.unitId}
                to={`/listings/${u.unitId}`}
                label={unitRowLabel(u)}
                right={<span className={meta.cls}>{meta.label}</span>}
              />
            );
          })
        )}
      </Card>

      <Card title="Cases on their units" aside={myCases.length > 0 ? String(myCases.length) : undefined}>
        {myCases.length === 0 ? (
          <EmptyRow>No cases on these units yet.</EmptyRow>
        ) : (
          myCases.map((c) => {
            const unit = unitMap.get(c.unitId);
            const addr = unit ? formatAddress(unit.address) || c.unitId : c.unitId;
            return <Row key={c.caseId} to={`/cases/${c.caseId}`} label={addr} right={c.stage} />;
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
