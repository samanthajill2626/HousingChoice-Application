// FlyerFunnel (/p/:unitId) — the public, unauthenticated teaser→intake→reveal
// conversion funnel for ONE shareable unit. This route is what `flyerUrl()`
// emits (${base}/p/${unitId}), so every broadcast [FlyerLink] share lands here.
//
// Client state machine:
//   loading  — fetching the teaser on mount
//   teaser   — the minimal flyer (photos, neighborhood, beds/baths, rent,
//              voucher, programs) + a prominent "I'm interested" button. NO
//              address, NO fees, NO external listing link.
//   intake   — the IntakeForm (name / phone / optional voucher)
//   reveal   — after a successful submit: the full details (address, utilities,
//              video tour, application fee, same-day RTA) + a thank-you. If the
//              details fetch fails we STILL show the thank-you (graceful).
//   unavailable — a 404/ApiError on the teaser → the friendly "this home is no
//              longer available" state (tenant-facing copy = "home").
//
// Tenant-facing copy: the dwelling is a "home" (never unit/property/listing).
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  getFlyer,
  getFlyerDetails,
  submitHousingFair,
  type PublicFlyer,
  type PublicFlyerDetails,
  type HousingFairInput,
} from './publicApi.js';
import { IntakeForm } from './IntakeForm.js';
import styles from './FlyerFunnel.module.css';

type Stage =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'teaser'; flyer: PublicFlyer }
  | { kind: 'intake'; flyer: PublicFlyer }
  | { kind: 'reveal'; flyer: PublicFlyer; details: PublicFlyerDetails | null };

function rentRange(flyer: Pick<PublicFlyer, 'rent_min' | 'rent_max'>): string | null {
  const { rent_min: min, rent_max: max } = flyer;
  if (min !== null && max !== null) return min === max ? `$${min}` : `$${min}–$${max}`;
  if (min !== null) return `From $${min}`;
  if (max !== null) return `Up to $${max}`;
  return null;
}

function neighborhood(flyer: Pick<PublicFlyer, 'area' | 'subzone'>): string | null {
  const parts = [flyer.subzone, flyer.area].filter((p): p is string => typeof p === 'string' && p !== '');
  return parts.length > 0 ? parts.join(', ') : null;
}

function addressLines(a: PublicFlyerDetails['address']): string | null {
  const street = [a.line1, a.line2].filter(Boolean).join(', ');
  const cityLine = [a.city, a.state].filter(Boolean).join(', ');
  const full = [street, cityLine, a.zip].filter((p) => p && p !== '').join(' · ');
  return full === '' ? null : full;
}

export function FlyerFunnel(): React.JSX.Element {
  const { unitId } = useParams<{ unitId: string }>();
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });

  useEffect(() => {
    if (unitId === undefined) {
      setStage({ kind: 'unavailable' });
      return;
    }
    const controller = new AbortController();
    (async () => {
      try {
        const flyer = await getFlyer(unitId, controller.signal);
        if (controller.signal.aborted) return;
        setStage({ kind: 'teaser', flyer });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        // Any failure (an opaque 404 for missing/not-shareable, or any other
        // error) → the friendly unavailable state. No existence oracle.
        setStage({ kind: 'unavailable' });
      }
    })();
    return () => controller.abort();
  }, [unitId]);

  async function handleIntakeSubmit(input: Omit<HousingFairInput, 'unitId'>): Promise<void> {
    if (unitId === undefined) return;
    const current = stage.kind === 'intake' ? stage.flyer : null;
    // Submit the signup (attributed to this home). A throw here propagates to the
    // IntakeForm so it shows its error and stays on the form.
    await submitHousingFair({ ...input, unitId });
    // Then fetch the reveal details — but a details failure must NOT lose the
    // conversion: still show the thank-you (details = null).
    let details: PublicFlyerDetails | null = null;
    try {
      details = await getFlyerDetails(unitId);
    } catch {
      details = null;
    }
    setStage({ kind: 'reveal', flyer: current ?? ({} as PublicFlyer), details });
  }

  if (stage.kind === 'loading') {
    return (
      <p className={styles.status} role="status">
        Loading…
      </p>
    );
  }

  if (stage.kind === 'unavailable') {
    return (
      <section className={styles.card}>
        <h1 className={styles.title}>This home is no longer available</h1>
        <p className={styles.muted}>
          The home you&apos;re looking for has been taken or removed. Sign up to hear about other
          homes that fit your voucher.
        </p>
        <a className={styles.linkButton} href="/join">
          See other homes
        </a>
      </section>
    );
  }

  if (stage.kind === 'intake') {
    return (
      <section className={styles.card}>
        <h1 className={styles.title}>Tell us how to reach you</h1>
        <p className={styles.muted}>
          Share your info and we&apos;ll send you the full details for this home.
        </p>
        <IntakeForm onSubmit={handleIntakeSubmit} submitLabel="Get the full details" />
      </section>
    );
  }

  if (stage.kind === 'reveal') {
    const { details } = stage;
    return (
      <section className={styles.card}>
        <h1 className={styles.title}>Thanks — you&apos;re all set!</h1>
        <p className={styles.muted}>
          We&apos;ve got your info and a team member will be in touch. Here are the full details for
          this home.
        </p>
        {details === null ? (
          <p className={styles.muted}>We&apos;ll text you the full details shortly.</p>
        ) : (
          <dl className={styles.details}>
            {addressLines(details.address) !== null && (
              <div className={styles.detailRow}>
                <dt className={styles.dt}>Address</dt>
                <dd className={styles.dd}>{addressLines(details.address)}</dd>
              </div>
            )}
            {details.utilities !== null && (
              <div className={styles.detailRow}>
                <dt className={styles.dt}>Utilities</dt>
                <dd className={styles.dd}>{details.utilities}</dd>
              </div>
            )}
            {details.application_fee !== null && (
              <div className={styles.detailRow}>
                <dt className={styles.dt}>Application fee</dt>
                <dd className={styles.dd}>${details.application_fee}</dd>
              </div>
            )}
            {details.same_day_rta === true && (
              <div className={styles.detailRow}>
                <dt className={styles.dt}>Same-day RTA</dt>
                <dd className={styles.dd}>Available</dd>
              </div>
            )}
            {details.video_url !== null && (
              <div className={styles.detailRow}>
                <dt className={styles.dt}>Video tour</dt>
                <dd className={styles.dd}>
                  <a href={details.video_url} target="_blank" rel="noreferrer">
                    Watch the tour
                  </a>
                </dd>
              </div>
            )}
          </dl>
        )}
      </section>
    );
  }

  // teaser
  const { flyer } = stage;
  const rent = rentRange(flyer);
  const hood = neighborhood(flyer);
  return (
    <section className={styles.card}>
      {flyer.media.length > 0 && (
        <div className={styles.gallery} aria-label="Photos">
          {flyer.media.map((src, i) => (
            <img key={i} className={styles.photo} src={src} alt={`Home photo ${i + 1}`} />
          ))}
        </div>
      )}
      <h1 className={styles.title}>{hood ?? 'A home for you'}</h1>

      <ul className={styles.facts}>
        {flyer.beds !== null && (
          <li>
            <strong>{flyer.beds}</strong> bed{flyer.beds === 1 ? '' : 's'}
          </li>
        )}
        {flyer.baths !== null && (
          <li>
            <strong>{flyer.baths}</strong> bath{flyer.baths === 1 ? '' : 's'}
          </li>
        )}
        {rent !== null && (
          <li>
            <strong>{rent}</strong>/mo
          </li>
        )}
        {flyer.voucher_size !== null && (
          <li>
            Fits a <strong>{flyer.voucher_size}-bedroom</strong> voucher
          </li>
        )}
      </ul>

      {flyer.accepted_programs.length > 0 && (
        <p className={styles.programs}>
          Accepts: {flyer.accepted_programs.join(', ')}
        </p>
      )}

      <button
        className={styles.cta}
        type="button"
        onClick={() => setStage({ kind: 'intake', flyer })}
      >
        I&apos;m interested
      </button>
    </section>
  );
}
