// FlyerPage (/p/:unitId) - the public, unauthenticated FULL-INFO flyer for one
// shareable unit (flyer-full-info 2026-07-16: the teaser->intake->reveal funnel
// is gone; everything public is shown upfront). This route is what flyerUrl()
// emits, so every broadcast [FlyerLink] share lands here.
//
// Two CTA variants, selected by ?cta=text (stripped from the URL on load so a
// copied/shared address never carries it; sessionStorage keeps the variant
// across a same-tab refresh):
//   form (bare link)  - the IntakeForm signup funnel at the bottom.
//   text (?cta=text)  - "I'm interested - text us": a tap-to-text sms: link to
//                       our main business number (contact_number). No form -
//                       these visitors are ALREADY onboarded.
// The unavailable state is variant-aware too (the opaque 404 body carries
// contact_number so the text CTA still works there).
//
// Tenant-facing copy: the dwelling is a "home" (never unit/property/listing).
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client.js';
import {
  getFlyer,
  submitHousingFair,
  type PublicFlyer,
  type HousingFairInput,
} from './publicApi.js';
import { IntakeForm } from './IntakeForm.js';
import { safeHttpUrl } from '../../lib/safeUrl.js';
import styles from './FlyerPage.module.css';

type Stage =
  | { kind: 'loading' }
  | { kind: 'unavailable'; contactNumber: string | null }
  | { kind: 'ready'; flyer: PublicFlyer };

type Variant = 'form' | 'text';

const UNAVAILABLE_PREFILL =
  "The home I was looking at is no longer available - I'm interested in similar homes.";

/** Build the cross-platform tap-to-text href. The `?&body=` form is DELIBERATE
 *  (iOS takes &body / modern iOS ?body, Android takes ?body) - do not "fix" it. */
function smsHref(number: string, body: string): string {
  return `sms:${number}?&body=${encodeURIComponent(body)}`;
}

function rentRange(flyer: Pick<PublicFlyer, 'rent_min' | 'rent_max'>): string | null {
  const { rent_min: min, rent_max: max } = flyer;
  if (min !== null && max !== null) return min === max ? `$${min}` : `$${min}-$${max}`;
  if (min !== null) return `From $${min}`;
  if (max !== null) return `Up to $${max}`;
  return null;
}

function neighborhood(flyer: Pick<PublicFlyer, 'area' | 'subzone'>): string | null {
  const parts = [flyer.subzone, flyer.area].filter((p): p is string => typeof p === 'string' && p !== '');
  return parts.length > 0 ? parts.join(', ') : null;
}

function addressLines(a: PublicFlyer['address']): string | null {
  const street = [a.line1, a.line2].filter(Boolean).join(', ');
  const cityLine = [a.city, a.state].filter(Boolean).join(', ');
  const full = [street, cityLine, a.zip].filter((p) => p && p !== '').join(' - ');
  return full === '' ? null : full;
}

/** "I'm interested in <line1, city | neighborhood | this home>" */
function interestedPrefill(flyer: PublicFlyer): string {
  const line1 = flyer.address.line1;
  const where =
    typeof line1 === 'string' && line1 !== ''
      ? [line1, flyer.address.city].filter(Boolean).join(', ')
      : neighborhood(flyer) ?? 'this home';
  return `I'm interested in ${where}`;
}

/** Pull contact_number out of the opaque 404 body (null when absent). */
function contactFromError(err: unknown): string | null {
  if (err instanceof ApiError && err.body !== null && typeof err.body === 'object') {
    const n = (err.body as Record<string, unknown>)['contact_number'];
    if (typeof n === 'string') return n;
  }
  return null;
}

/** Treat an empty string as absent - staff can save '' for a free-text field
 *  (the write validator accepts it), and a labeled detail row with a blank
 *  value must simply not render. */
function textOrNull(v: string | null): string | null {
  return v === '' ? null : v;
}

function petsLabel(pets: string | boolean | null): string | null {
  if (pets === true) return 'Allowed';
  if (pets === false) return 'Not allowed';
  return pets === '' ? null : pets;
}

export function FlyerPage(): React.JSX.Element {
  const { unitId } = useParams<{ unitId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [submitted, setSubmitted] = useState(false);
  const storageKey = `flyer-cta-${unitId ?? ''}`;

  // Variant: ?cta=text wins (and is persisted + stripped); else sessionStorage
  // (same-tab refresh keeps the known-tenant CTA); else the public form.
  const [variant, setVariant] = useState<Variant>('form');
  useEffect(() => {
    const fromParam = searchParams.get('cta') === 'text';
    if (fromParam) {
      try {
        sessionStorage.setItem(storageKey, 'text');
      } catch {
        // Private-mode storage failure: the variant just won't survive refresh.
      }
    }
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(storageKey);
    } catch {
      stored = null;
    }
    setVariant(fromParam || stored === 'text' ? 'text' : 'form');
    // Strip cta (and ONLY cta) so a copied/shared URL never carries the flag.
    if (searchParams.get('cta') !== null) {
      const next = new URLSearchParams(searchParams);
      next.delete('cta');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per unit
  }, [unitId]);

  // Focus the swapped-in heading (thank-you) so the change is announced to SRs.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (submitted) headingRef.current?.focus();
  }, [submitted]);

  useEffect(() => {
    if (unitId === undefined) {
      setStage({ kind: 'unavailable', contactNumber: null });
      return;
    }
    const controller = new AbortController();
    (async () => {
      try {
        const flyer = await getFlyer(unitId, controller.signal);
        if (controller.signal.aborted) return;
        setStage({ kind: 'ready', flyer });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        // Opaque 404 (missing/not-shareable) or any other failure -> the
        // friendly unavailable state; its body may carry our texting number.
        setStage({ kind: 'unavailable', contactNumber: contactFromError(err) });
      }
    })();
    return () => controller.abort();
  }, [unitId]);

  async function handleIntakeSubmit(input: Omit<HousingFairInput, 'unitId'>): Promise<void> {
    if (unitId === undefined) return;
    // A throw propagates to the IntakeForm so it shows its error and stays put.
    await submitHousingFair({ ...input, unitId });
    setSubmitted(true);
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
          The home you&apos;re looking for has been taken or removed.
        </p>
        {variant === 'text' ? (
          stage.contactNumber !== null ? (
            <a className={styles.linkButton} href={smsHref(stage.contactNumber, UNAVAILABLE_PREFILL)}>
              I&apos;m interested in similar homes - text us
            </a>
          ) : (
            <p className={styles.muted}>
              Interested in similar homes? Reply to the text we sent you and
              we&apos;ll help you take the next step.
            </p>
          )
        ) : (
          <>
            <p className={styles.muted}>
              Sign up to hear about other homes that fit your voucher.
            </p>
            <a className={styles.linkButton} href="/join">
              See other homes
            </a>
          </>
        )}
      </section>
    );
  }

  const { flyer } = stage;
  const rent = rentRange(flyer);
  const hood = neighborhood(flyer);
  const safeVideoUrl = safeHttpUrl(flyer.video_url);
  const safeListingUrl = safeHttpUrl(flyer.listing_link);
  const pets = petsLabel(flyer.pets);
  const address = addressLines(flyer.address);
  const utilities = textOrNull(flyer.utilities);
  const accessibility = textOrNull(flyer.accessibility);
  const leaseTerms = textOrNull(flyer.lease_terms);

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
        <p className={styles.programs}>Accepts: {flyer.accepted_programs.join(', ')}</p>
      )}

      <dl className={styles.details}>
        {address !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Address</dt>
            <dd className={styles.dd}>{address}</dd>
          </div>
        )}
        {flyer.deposit !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Deposit</dt>
            <dd className={styles.dd}>${flyer.deposit}</dd>
          </div>
        )}
        {flyer.application_fee !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Application fee</dt>
            <dd className={styles.dd}>${flyer.application_fee}</dd>
          </div>
        )}
        {utilities !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Tenant pays</dt>
            <dd className={styles.dd}>{utilities}</dd>
          </div>
        )}
        {pets !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Pets</dt>
            <dd className={styles.dd}>{pets}</dd>
          </div>
        )}
        {accessibility !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Accessibility</dt>
            <dd className={styles.dd}>{accessibility}</dd>
          </div>
        )}
        {leaseTerms !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Lease terms</dt>
            <dd className={styles.dd}>{leaseTerms}</dd>
          </div>
        )}
        {flyer.same_day_rta === true && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Same-day RTA</dt>
            <dd className={styles.dd}>Available</dd>
          </div>
        )}
        {safeVideoUrl !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Video tour</dt>
            <dd className={styles.dd}>
              <a href={safeVideoUrl} target="_blank" rel="noreferrer">
                Watch the tour
              </a>
            </dd>
          </div>
        )}
        {safeListingUrl !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Listing</dt>
            <dd className={styles.dd}>
              <a href={safeListingUrl} target="_blank" rel="noreferrer">
                See the full listing
              </a>
            </dd>
          </div>
        )}
      </dl>

      <div className={styles.ctaSection}>
        {variant === 'text' ? (
          flyer.contact_number !== null ? (
            <>
              <h2 className={styles.title}>Interested in this home?</h2>
              <a className={styles.linkButton} href={smsHref(flyer.contact_number, interestedPrefill(flyer))}>
                I&apos;m interested - text us
              </a>
            </>
          ) : (
            <p className={styles.muted}>
              Interested? Reply to the text we sent you and we&apos;ll help you
              take the next step.
            </p>
          )
        ) : submitted ? (
          <>
            <h2 className={styles.title} ref={headingRef} tabIndex={-1}>
              Thanks - you&apos;re all set!
            </h2>
            <p className={styles.muted}>
              We&apos;ve got your info and a team member will be in touch.
            </p>
          </>
        ) : (
          <>
            <h2 className={styles.title}>Interested in this home?</h2>
            <p className={styles.muted}>
              Share your info and a team member will reach out about this home.
            </p>
            <IntakeForm onSubmit={handleIntakeSubmit} submitLabel="I'm interested" />
          </>
        )}
      </div>
    </section>
  );
}
