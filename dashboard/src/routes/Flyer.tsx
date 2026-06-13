// Flyer — the PUBLIC, shareable unit flyer (route '/flyer/:unitId', NO auth).
//
// Rendered ABOVE the auth gate (see App.tsx) so it works for anyone with the
// link — no session, no app nav/chrome. Fetches GET /public/units/:id/flyer.
// A 404 shows a friendly "listing not available" rather than an error dump.
import { useParams } from 'react-router-dom';
import { getUnitFlyer, useApi, type UnitFlyer } from '../api/index.js';
import { Spinner } from '../ui/index.js';
import { formatRentRange } from './records/records.js';
import styles from './public.module.css';

export default function Flyer(): React.JSX.Element {
  const { unitId } = useParams<{ unitId: string }>();
  const id = unitId ?? '';
  const { data: flyer, loading, error } = useApi((signal) => getUnitFlyer(id, signal), [id]);

  if (loading && flyer === undefined) {
    return (
      <main className={styles.page}>
        <div className={styles.card}>
          <Spinner center label="Loading listing" />
        </div>
      </main>
    );
  }

  if (error || !flyer) {
    return (
      <main className={styles.page}>
        <div className={styles.card}>
          <div className={styles.brand}>HousingChoice</div>
          <h1 className={styles.title}>Listing not available</h1>
          <p className={styles.subtitle}>
            This listing isn&apos;t available right now. It may have been placed or removed. Please
            check back with whoever shared the link.
          </p>
        </div>
      </main>
    );
  }

  return <FlyerView flyer={flyer} />;
}

/** True when a media entry is a directly renderable image URL. Storage keys
 *  (no scheme) are shown as labels instead of broken images. */
function isImageUrl(m: string): boolean {
  return /^https?:\/\//i.test(m);
}

function Fact({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element | null {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function FlyerView({ flyer }: { flyer: UnitFlyer }): React.JSX.Element {
  const rent = formatRentRange(flyer.rent_min, flyer.rent_max);
  const where = flyer.area ?? flyer.subzone;
  const photos = flyer.media.filter(isImageUrl);

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>HousingChoice</div>
        <h1 className={styles.title}>
          {typeof flyer.beds === 'number' ? `${flyer.beds}-bed home` : 'Available home'}
          {where ? ` in ${where}` : ''}
        </h1>
        {rent !== undefined && <p className={styles.subtitle}>{rent} / month</p>}

        {photos.length > 0 && (
          <div className={styles.gallery}>
            {photos.map((src, i) => (
              <img key={`${src}-${i}`} className={styles.photo} src={src} alt={`Listing photo ${i + 1}`} />
            ))}
          </div>
        )}

        <dl className={styles.facts}>
          <Fact label="Bedrooms" value={typeof flyer.beds === 'number' ? flyer.beds : undefined} />
          <Fact label="Bathrooms" value={typeof flyer.baths === 'number' ? flyer.baths : undefined} />
          <Fact label="Area" value={flyer.area} />
          <Fact label="Subzone" value={flyer.subzone} />
          <Fact label="Rent" value={rent} />
          <Fact
            label="Voucher size"
            value={typeof flyer.voucher_size === 'number' ? `${flyer.voucher_size} bed` : undefined}
          />
          <Fact
            label="Accepted programs"
            value={flyer.accepted_programs.length > 0 ? flyer.accepted_programs.join(', ') : undefined}
          />
        </dl>

        {flyer.listing_link && (
          <p>
            <a href={flyer.listing_link} target="_blank" rel="noopener noreferrer">
              View the full listing
            </a>
          </p>
        )}

        <p className={styles.footnote}>Shared by HousingChoice. Details subject to change.</p>
      </div>
    </main>
  );
}
