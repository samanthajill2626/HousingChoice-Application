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
//
// flyer-leads (spec 2026-10-21 D1, D3): no rent, lease terms, accessibility,
// pets or deposit - those are staff only, and the public projection no longer
// sends them (a stale payload's keys are simply never read). The address is
// the heading (a Google Maps link), the area the line under it.
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

/** The neighborhood: the AREA alone (D11), trimmed (flyer-leads D10 - a
 *  display guard; JSON writes are already trimmed server-side, but a legacy
 *  or imported value may not be). Subzone is a staff-only code and is not in
 *  the projection (D3). flyer-leads D3: the line under an address heading,
 *  or the plain heading when there is no address. */
function neighborhood(flyer: Pick<PublicFlyer, 'area'>): string | null {
  if (typeof flyer.area !== 'string') return null;
  const area = flyer.area.trim();
  return area === '' ? null : area;
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

/** A Google Maps link for the home's address - "where is this?" is the tenant's
 *  first question about a flyer, and a flyer arrives by text on a phone, where
 *  this hands off to the native Maps app. Uses the documented Maps URL API
 *  (`search/?api=1&query=`), which takes a free-text query, so a partial address
 *  (city + state, no street) still lands somewhere useful. The parts are joined
 *  with ', ' into one free-text query (the heading shows the same parts as a
 *  street line and a city line - flyerHeading); every part is
 *  encodeURIComponent'd, and the host is a literal, so nothing here can become
 *  another scheme or origin. Null when the address carries nothing but blanks
 *  (the heading then falls back to the area or "Home for rent" as plain text -
 *  flyerHeading, flyer-leads D3). */
function mapsHref(a: PublicFlyer['address']): string | null {
  const query = [a.line1, a.line2, a.city, a.state, a.zip]
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .join(', ');
  return query === ''
    ? null
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** flyer-leads D3: one address part, trimmed ('' when absent). */
function addressPart(v: string | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** flyer-leads D3: the street line - line1, then line2, joined by ', ';
 *  blank parts left out. Null when both are blank. */
function streetLine(a: PublicFlyer['address']): string | null {
  const line = [addressPart(a.line1), addressPart(a.line2)].filter((p) => p !== '').join(', ');
  return line === '' ? null : line;
}

/** flyer-leads D3: the city line - city, then ', ', then state and zip joined
 *  by one space; blank parts left out with their separators. Null when all
 *  three are blank. */
function cityLine(a: PublicFlyer['address']): string | null {
  const stateZip = [addressPart(a.state), addressPart(a.zip)].filter((p) => p !== '').join(' ');
  const line = [addressPart(a.city), stateZip].filter((p) => p !== '').join(', ');
  return line === '' ? null : line;
}

/** flyer-leads D3: the ready state's heading. An address heading is the Maps
 *  link; `subline` is the city line under the street line (null when the city
 *  line IS the title). With no address part at all: the area, else "Home for
 *  rent", as plain text. mapsHref is non-null exactly when streetLine or
 *  cityLine is (both test every part trimmed). */
type FlyerHeading =
  | { kind: 'address'; title: string; subline: string | null; href: string }
  | { kind: 'plain'; title: string };

function flyerHeading(address: PublicFlyer['address'], hood: string | null): FlyerHeading {
  const href = mapsHref(address);
  const street = streetLine(address);
  const city = cityLine(address);
  if (href !== null && street !== null) return { kind: 'address', title: street, subline: city, href };
  if (href !== null && city !== null) return { kind: 'address', title: city, subline: null, href };
  return { kind: 'plain', title: hood ?? 'Home for rent' };
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

/** The application-fee amount (planner ruling PR-4, code review PA-4): a
 *  whole number exactly as before ("$40"), any other amount with two decimals
 *  ("$37.50") - the forms accept cents (D1). flyer-leads D3: the deposit row
 *  is gone; applicationFeeLabel is the only reader. */
function flyerMoney(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/** D11: "No application fee" for 0, "$N" otherwise; null when not recorded. */
function applicationFeeLabel(fee: number | null): string | null {
  if (fee === null) return null;
  return fee === 0 ? 'No application fee' : flyerMoney(fee);
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
  const hood = neighborhood(flyer);
  const safeVideoUrl = safeHttpUrl(flyer.video_url);
  const safeListingUrl = safeHttpUrl(flyer.listing_link);
  const applicationFee = applicationFeeLabel(flyer.application_fee);
  const washerDryer = flyer.washer_dryer !== null ? WASHER_DRYER_LABELS[flyer.washer_dryer] : null;
  const voucher = voucherPhrase(flyer.voucher_sizes);
  const heading = flyerHeading(flyer.address, hood);
  const utilities = textOrNull(flyer.utilities);

  return (
    <section className={styles.card}>
      {flyer.media.length > 0 && (
        <div className={styles.gallery} aria-label="Photos">
          {flyer.media.map((src, i) => (
            <img key={i} className={styles.photo} src={src} alt={`Home photo ${i + 1}`} />
          ))}
        </div>
      )}
      {/* flyer-leads D3: the address IS the heading and the Maps link - the
          whole block (street line + city line) is the tap target. The visible
          text leads the accessible name and the hidden suffix only ADDS to it
          (WCAG 2.5.3); it also says the link leaves for Maps in a new tab.
          The area is a line under an address heading, never dropped. */}
      <div className={styles.headingGroup}>
        {heading.kind === 'address' ? (
          <a className={styles.headingLink} href={heading.href} target="_blank" rel="noreferrer">
            <h1 className={styles.addressTitle}>{heading.title}</h1>
            {heading.subline !== null && <span className={styles.subline}>{heading.subline}</span>}
            <span className={styles.srOnly}> - open in Google Maps</span>
          </a>
        ) : (
          <h1 className={styles.title}>{heading.title}</h1>
        )}
        {heading.kind === 'address' && hood !== null && <p className={styles.area}>{hood}</p>}
      </div>

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
