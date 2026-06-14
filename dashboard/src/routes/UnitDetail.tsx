// UnitDetail — view one property (route '/units/:unitId').
//
// Shows every intake field (including tour_process / application_process), the
// primary call contact (resolved to its contact detail when linkable), the
// media list, and the shareable public flyer link. Edit links to the form.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getUnit, useApi, type UnitItem } from '../api/index.js';
import { Badge, Button, ChevronLeftIcon, EmptyState, Spinner } from '../ui/index.js';
import { AddressDisplay, formatAddress } from './records/Address.js';
import { UNIT_STATUS_LABEL, formatRentRange } from './records/records.js';
import { BroadcastComposer } from './broadcast/BroadcastComposer.js';
import styles from './records/records.module.css';

export default function UnitDetail(): React.JSX.Element {
  const { unitId } = useParams<{ unitId: string }>();
  const id = unitId ?? '';
  const navigate = useNavigate();

  const { data: unit, loading, error } = useApi((signal) => getUnit(id, signal), [id]);

  if (loading && unit === undefined) {
    return (
      <section className={styles.page}>
        <Spinner center label="Loading property" />
      </section>
    );
  }

  if (error || !unit) {
    const notFound = error?.status === 404 || error?.code === 'unit_not_found';
    return (
      <section className={styles.page}>
        <EmptyState
          title={notFound ? 'Property not found' : "Couldn't load this property"}
          description={
            notFound
              ? 'This property may have been removed.'
              : 'Something went wrong loading the property.'
          }
          action={
            <Button variant="secondary" onClick={() => navigate('/units')}>
              Back to properties
            </Button>
          }
        />
      </section>
    );
  }

  return <UnitView unit={unit} />;
}

/** One labelled fact, rendered only when the value is present. */
function Fact({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element | null {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function UnitView({ unit }: { unit: UnitItem }): React.JSX.Element {
  const navigate = useNavigate();
  const rent = formatRentRange(unit.rent_min, unit.rent_max);
  const title = formatAddress(unit.address) ?? unit.jurisdiction ?? `Unit ${unit.unitId}`;
  const flyerHref = `/flyer/${encodeURIComponent(unit.unitId)}`;
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <section className={styles.page} aria-labelledby="unit-detail-heading">
      <Link to="/units" className={styles.back}>
        <ChevronLeftIcon size={16} />
        Back to properties
      </Link>

      <header className={styles.header}>
        <div>
          <h1 id="unit-detail-heading">{title}</h1>
          <p className={styles.lead}>{unit.jurisdiction ?? 'Property record'}</p>
        </div>
        <Badge tone="info" dot>
          {UNIT_STATUS_LABEL[unit.status]}
        </Badge>
      </header>

      <div className={styles.formActions}>
        <Button size="sm" onClick={() => setShareOpen(true)}>
          Share this property
        </Button>
        <Button as="a" href={`/units/${encodeURIComponent(unit.unitId)}/edit`} variant="secondary" size="sm">
          Edit property
        </Button>
        <Button as="a" href={flyerHref} target="_blank" rel="noopener noreferrer" variant="secondary" size="sm">
          View public flyer
        </Button>
      </div>

      <BroadcastComposer
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        unit={unit}
        onSent={(broadcastId) => {
          setShareOpen(false);
          navigate(`/broadcasts/${encodeURIComponent(broadcastId)}`);
        }}
      />

      <div className={styles.surface}>
        <h2 className={styles.sectionTitle}>Details</h2>
        <dl className={styles.facts}>
          {formatAddress(unit.address) !== undefined && (
            <Fact label="Address" value={<AddressDisplay address={unit.address} />} />
          )}
          <Fact label="Jurisdiction" value={unit.jurisdiction} />
          <Fact label="Area" value={unit.area} />
          <Fact label="Subzone" value={unit.subzone} />
          <Fact label="Beds" value={typeof unit.beds === 'number' ? unit.beds : undefined} />
          <Fact label="Baths" value={typeof unit.baths === 'number' ? unit.baths : undefined} />
          <Fact label="Rent" value={rent} />
          <Fact
            label="Payment standard"
            value={typeof unit.payment_standard === 'number' ? `$${unit.payment_standard.toLocaleString('en-US')}` : undefined}
          />
          <Fact
            label="Deposit"
            value={typeof unit.deposit === 'number' ? `$${unit.deposit.toLocaleString('en-US')}` : undefined}
          />
          <Fact label="LIF" value={unit.lif} />
          <Fact label="Utilities" value={unit.utilities} />
          <Fact label="Accessibility" value={unit.accessibility} />
          <Fact label="Pets" value={unit.pets} />
          <Fact label="Priority" value={unit.priority} />
          <Fact
            label="Accepted programs"
            value={
              unit.accepted_programs && unit.accepted_programs.length > 0
                ? unit.accepted_programs.join(', ')
                : undefined
            }
          />
          <Fact
            label="Listing link"
            value={
              unit.listing_link ? (
                <a href={unit.listing_link} target="_blank" rel="noopener noreferrer">
                  {unit.listing_link}
                </a>
              ) : undefined
            }
          />
          {/* CO1 per-property primary voice contact, pending founder
              confirmation — that internal note stays in code, off the screen. */}
          <Fact
            label="Primary contact for calls"
            value={
              typeof unit.primary_voice_contact === 'string' && unit.primary_voice_contact.length > 0 ? (
                <Link to={`/contacts/${encodeURIComponent(unit.primary_voice_contact)}`}>
                  View contact
                </Link>
              ) : undefined
            }
          />
        </dl>
      </div>

      {(unit.tour_process || unit.application_process) && (
        <div className={styles.surface}>
          <h2 className={styles.sectionTitle}>Process</h2>
          <dl className={styles.facts}>
            <Fact label="Tour process" value={unit.tour_process} />
            <Fact label="Application process" value={unit.application_process} />
          </dl>
        </div>
      )}

      {unit.media && unit.media.length > 0 && (
        <div className={styles.surface}>
          <h2 className={styles.sectionTitle}>Media ({unit.media.length})</h2>
          <ul className={styles.list}>
            {unit.media.map((m, i) => (
              <li key={`${m}-${i}`} className={styles.rowSub}>
                {m}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
