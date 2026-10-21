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
import { WASHER_DRYER_LABELS } from '../listing/requirements.js';
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

/** The neighborhood line: the AREA alone (D11). Subzone is a staff-only code
 *  and is not in the projection (D3). */
function neighborhood(flyer: Pick<PublicFlyer, 'area'>): string | null {
  return typeof flyer.area === 'string' && flyer.area.trim() !== '' ? flyer.area : null;
}

/** D11: the voucher sizes as one phrase - "studio", "2-bedroom", "2- or
 *  3-bedroom", "studio or 1-bedroom", "1-, 2-, or 3-bedroom". Ascending and
 *  de-duplicated; every number but the last reads "<n>-", the last
 *  "<n>-bedroom"; a studio always reads "studio". Null for none. */
function voucherPhrase(sizes: readonly number[]): string | null {
  const sorted = [...new Set(sizes.filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  const words = sorted.map((n, i) => (n === 0 ? 'studio' : i === sorted.length - 1 ? `${n}-bedroom` : `${n}-`));
  if (words.length === 0) return null;
  if (words.length === 1) return words[0] ?? null;
  if (words.length === 2) return `${words[0]} or ${words[1]}`;
  return `${words.slice(0, -1).join(', ')}, or ${words[words.length - 1]}`;
}

/** Code review R2D-8: the article before the voucher phrase - "an" when it
 *  starts with 8 or 11 (said "eight", "eleven": "Fits an 8-bedroom voucher",
 *  "Fits an 11-bedroom voucher", "Fits an 8- or 9-bedroom voucher"), "a"
 *  for every other start (sizes run 0..12, D4). */
function voucherArticle(phrase: string): 'a' | 'an' {
  return /^(?:8|11)(?!\d)/.test(phrase) ? 'an' : 'a';
}

function addressLines(a: PublicFlyer['address']): string | null {
  const street = [a.line1, a.line2].filter(Boolean).join(', ');
  const cityLine = [a.city, a.state].filter(Boolean).join(', ');
  const full = [street, cityLine, a.zip].filter((p) => p && p !== '').join(' - ');
  return full === '' ? null : full;
}

/** A Google Maps link for the home's address - "where is this?" is the tenant's
 *  next question after the rent, and a flyer arrives by text on a phone, where
 *  this hands off to the native Maps app. Uses the documented Maps URL API
 *  (`search/?api=1&query=`), which takes a free-text query, so a partial address
 *  (city + state, no street) still lands somewhere useful. The parts are joined
 *  with ', ' rather than reusing the DISPLAYED string, whose ' - ' separators are
 *  a presentation choice; every part is encodeURIComponent'd, and the host is a
 *  literal, so nothing here can become another scheme or origin. Null when the
 *  address carries nothing but blanks (the row then renders as plain text). */
function mapsHref(a: PublicFlyer['address']): string | null {
  const query = [a.line1, a.line2, a.city, a.state, a.zip]
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .join(', ');
  return query === ''
    ? null
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
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

/** Treat an empty or whitespace-only string as absent - staff can save '' (or
 *  '   ': the edit form PATCHes untrimmed values) for a free-text field, and a
 *  labeled detail row with a blank value must simply not render. */
function textOrNull(v: string | null): string | null {
  return v === null || v.trim() === '' ? null : v;
}

/** D11: "No pets", "No pets (<details>)", or the details alone. A legacy stored
 *  boolean reaches the page already interpreted (true -> details "Allowed",
 *  false -> no_pets), so the page reads only the new shape. */
function petsLabel(flyer: Pick<PublicFlyer, 'no_pets' | 'pets'>): string | null {
  const details = textOrNull(flyer.pets);
  if (flyer.no_pets) return details !== null ? `No pets (${details.trim()})` : 'No pets';
  return details;
}

/** D11: "One month's rent" or "$N", then ", flexible / payment plan
 *  available" when flexible; flexible alone reads "Flexible / payment plan
 *  available". Null when none of the three is recorded (the deposit notes are
 *  staff only and never projected). */
function depositLabel(
  flyer: Pick<PublicFlyer, 'deposit_one_month' | 'deposit' | 'deposit_flexible'>,
): string | null {
  const base = flyer.deposit_one_month ? "One month's rent" : flyer.deposit !== null ? `$${flyer.deposit}` : null;
  if (!flyer.deposit_flexible) return base;
  return base !== null ? `${base}, flexible / payment plan available` : 'Flexible / payment plan available';
}

/** D11: "No application fee" for 0, "$N" otherwise; null when not recorded. */
function applicationFeeLabel(fee: number | null): string | null {
  if (fee === null) return null;
  return fee === 0 ? 'No application fee' : `$${fee}`;
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
  const pets = petsLabel(flyer);
  const petFee = textOrNull(flyer.pet_fee);
  const deposit = depositLabel(flyer);
  const applicationFee = applicationFeeLabel(flyer.application_fee);
  const washerDryer = flyer.washer_dryer !== null ? WASHER_DRYER_LABELS[flyer.washer_dryer] : null;
  const voucher = voucherPhrase(flyer.voucher_sizes);
  const address = addressLines(flyer.address);
  const mapUrl = mapsHref(flyer.address);
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
        {voucher !== null && (
          <li>
            Fits {voucherArticle(voucher)} <strong>{voucher}</strong> voucher
          </li>
        )}
      </ul>

      {/* Which authorities' vouchers this home takes - the tenant's actual
          question. Absent authorities hide the line entirely (spec section 8). */}
      {flyer.accepted_authorities.length > 0 && (
        <p className={styles.authorities}>Accepts: {flyer.accepted_authorities.join(', ')}</p>
      )}

      <dl className={styles.details}>
        {address !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Address</dt>
            {/* The address itself is the map link (no separate "Map" affordance).
                The visible text stays the address and the hidden suffix only
                ADDS to it, so the accessible name still contains what a voice
                user would say (WCAG 2.5.3). */}
            <dd className={styles.dd}>
              {mapUrl !== null ? (
                <a href={mapUrl} target="_blank" rel="noreferrer">
                  {address}
                  <span className={styles.srOnly}> - open in Google Maps</span>
                </a>
              ) : (
                address
              )}
            </dd>
          </div>
        )}
        {deposit !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Deposit</dt>
            <dd className={styles.dd}>{deposit}</dd>
          </div>
        )}
        {applicationFee !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Application fee</dt>
            <dd className={styles.dd}>{applicationFee}</dd>
          </div>
        )}
        {utilities !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Tenant pays</dt>
            <dd className={styles.dd}>{utilities}</dd>
          </div>
        )}
        {washerDryer !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Washer / dryer</dt>
            <dd className={styles.dd}>{washerDryer}</dd>
          </div>
        )}
        {pets !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Pets</dt>
            <dd className={styles.dd}>{pets}</dd>
          </div>
        )}
        {petFee !== null && (
          <div className={styles.detailRow}>
            <dt className={styles.dt}>Pet fee</dt>
            <dd className={styles.dd}>{petFee}</dd>
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
