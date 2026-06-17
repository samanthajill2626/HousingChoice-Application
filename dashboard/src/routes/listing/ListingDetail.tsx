// ListingDetail — the Listing detail page (§B4), the locked v4 mockup. A
// near-black header band (address · status badge · facts · "📣 Broadcast to
// tenants" + Edit + ⋯) over a two-column body and a full-width Photos gallery:
//   LEFT  — a small hero image · a flyer line (View flyer ↗ + Copy public link)
//           · Listing details (with Accepted vouchers as a BULLETED list) · Tour
//           & application process · Activity.
//   RIGHT — Contacts roster · Sent to tenants · Cases on this listing · Related
//           listings · Similar listings.
//   BOTTOM (full width) — Photos.
// Real panels come from existing endpoints (unit, cases, units, the landlord
// contact); the C4 "Sent to tenants" + C6 "Similar listings" panels show an
// honest "Arrives with the backend" pending state, and "Activity" (BE2) is
// pending too. Nothing is fabricated.
import { useParams } from 'react-router-dom';
import { Spinner } from '../../ui/index.js';
import { Card, EmptyRow, KV, PendingPanel, Row, responseClass } from '../contact/Card.js';
import { useListing } from './useListing.js';
import {
  buildListingFacts,
  formatBedsBaths,
  formatMoney,
  formatRent,
  isMediaUrl,
  shortAddress,
  statusLabel,
} from './listingFormat.js';
import { flyerPath } from './listingLinks.js';
import styles from './ListingDetail.module.css';

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

const STATUS_BADGE: Record<string, string> = {
  available: styles.badgeAvailable ?? '',
  placed: styles.badgePlaced ?? '',
  inactive: styles.badgeInactive ?? '',
};

const STATUS_DOT: Record<string, string> = {
  available: responseClass.available,
  placed: responseClass.placed,
  inactive: responseClass.inactive,
};

const RESPONSE_META: Record<string, { label: string; cls: string }> = {
  interested: { label: '👍 Interested', cls: responseClass.yes },
  not_a_fit: { label: '👎 Not a fit', cls: responseClass.no },
  no_reply: { label: '⏳ No reply', cls: responseClass.wait },
};

export function ListingDetail(): React.JSX.Element {
  const { unitId = '' } = useParams<{ unitId: string }>();
  const state = useListing(unitId);

  if (state.status === 'loading') {
    return (
      <div className={styles.center}>
        <Spinner center />
      </div>
    );
  }

  if (state.status === 'error' || !state.unit) {
    return (
      <div className={styles.center}>
        <p role="alert" className={styles.error}>
          We couldn&apos;t load this listing.
        </p>
      </div>
    );
  }

  const { unit, roster, casesOnUnit, related, recipients, similar } = state;
  const address = shortAddress(unit.address, unit.unitId);
  const landlordName = roster.find((r) => r.primaryVoice)?.company ?? roster[0]?.company;
  const facts = buildListingFacts(unit, landlordName);
  const flyer = flyerPath(unit.unitId);
  const programs = unit.accepted_programs ?? [];
  const media = unit.media ?? [];

  const onCopyLink = (): void => {
    const absolute =
      typeof window !== 'undefined' ? `${window.location.origin}${flyer}` : flyer;
    void navigator.clipboard?.writeText?.(absolute);
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <h1 className={styles.name}>
            {address}
            <span className={`${styles.badge} ${STATUS_BADGE[unit.status] ?? ''}`}>
              {statusLabel(unit.status)}
            </span>
          </h1>
          {facts ? <div className={styles.facts}>{facts}</div> : null}
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.btn}>
            📣 Broadcast to tenants
          </button>
          <button type="button" className={`${styles.btn} ${styles.btnAlt}`}>
            ✎ Edit
          </button>
          <button type="button" className={styles.kebab} aria-label="More actions">
            ⋯
          </button>
        </div>
      </header>

      <div className={styles.cols}>
        {/* LEFT column */}
        <div className={styles.left}>
          {media.length > 0 && isMediaUrl(media[0] ?? '') ? (
            <img className={styles.hero} src={media[0]} alt={`${address} hero`} />
          ) : (
            <div className={styles.hero} aria-hidden="true" />
          )}

          <div className={styles.flyerLine}>
            <a className={styles.flyerLink} href={flyer} target="_blank" rel="noreferrer">
              🖼 View flyer ↗
            </a>
            <button type="button" className={styles.flyerCopy} onClick={onCopyLink}>
              🔗 Copy public link
            </button>
            <span className={styles.flyerNote}>a live public page from this listing</span>
          </div>

          <Card title="Listing details" aside="Edit">
            <div className={styles.detailGrid}>
              <KV k="Beds / Baths" v={formatBedsBaths(unit.beds, unit.baths) || '—'} />
              <KV k="Rent" v={formatRent(unit.rent_min, unit.rent_max) || '—'} />
              <KV k="Payment standard" v={formatMoney(unit.payment_standard) || '—'} />
              <KV k="Deposit" v={formatMoney(unit.deposit) || '—'} />
              <KV k="Jurisdiction" v={unit.jurisdiction ?? '—'} />
              <KV k="Utilities" v={unit.utilities ?? '—'} />
              <KV k="Accessibility" v={unit.accessibility ?? '—'} />
              <KV k="Pets" v={unit.pets ?? '—'} />
            </div>
            <div className={styles.vouchers}>
              <span className={styles.vouchersLabel} id={`vouchers-${unit.unitId}`}>
                Accepted vouchers
              </span>
              {programs.length > 0 ? (
                <ul className={styles.vouchersList} aria-labelledby={`vouchers-${unit.unitId}`}>
                  {programs.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : (
                <EmptyRow>None recorded yet.</EmptyRow>
              )}
            </div>
          </Card>

          <Card title="Tour & application process" aside="Edit">
            {unit.tour_process || unit.application_process ? (
              <div className={styles.process}>
                {unit.tour_process ? <p>{unit.tour_process}</p> : null}
                {unit.application_process ? <p>{unit.application_process}</p> : null}
              </div>
            ) : (
              <EmptyRow>No process recorded yet.</EmptyRow>
            )}
          </Card>

          <Card title="Activity">
            <PendingPanel note="The listing's activity log arrives with the backend." />
          </Card>
        </div>

        {/* RIGHT column */}
        <div className={styles.right}>
          <Card title="Contacts" aside="landlord / PM roster">
            {roster.length === 0 ? (
              <EmptyRow>No contacts on this listing yet.</EmptyRow>
            ) : (
              roster.map((r) => (
                <Row
                  key={r.contactId}
                  to={`/contacts/${r.contactId}`}
                  label={
                    <span>
                      {r.name ?? r.contactId}
                      {r.primaryVoice ? <span className={styles.primaryStar}> ☎ primary</span> : null}
                      <span className={styles.roleLine}>
                        {r.roleLabel}
                        {r.company ? ` · ${r.company}` : ''}
                      </span>
                    </span>
                  }
                  right={<span className={styles.openLink}>Open ↗</span>}
                />
              ))
            )}
          </Card>

          <Card title="Sent to tenants" aside="recipients + responses">
            {recipients.status === 'ready' ? (
              recipients.rows.length === 0 ? (
                <EmptyRow>Not sent to anyone yet.</EmptyRow>
              ) : (
                recipients.rows.map((row) => {
                  const meta = RESPONSE_META[row.response] ?? {
                    label: row.response,
                    cls: responseClass.muted,
                  };
                  return (
                    <Row
                      key={`${row.contactId}:${row.sentAt}`}
                      to={`/contacts/${row.contactId}`}
                      label={row.contactId}
                      right={<span className={meta.cls}>{meta.label}</span>}
                    />
                  );
                })
              )
            ) : recipients.status === 'error' ? (
              <EmptyRow>We couldn&apos;t load recipients.</EmptyRow>
            ) : (
              <PendingPanel />
            )}
          </Card>

          <Card
            title="Cases on this listing"
            aside={casesOnUnit.length > 0 ? String(casesOnUnit.length) : undefined}
          >
            {casesOnUnit.length === 0 ? (
              <EmptyRow>No cases on this listing yet.</EmptyRow>
            ) : (
              casesOnUnit.map((c) => (
                <Row
                  key={c.caseId}
                  to={`/cases/${c.caseId}`}
                  label={c.tenantId}
                  right={STAGE_LABEL[c.stage] ?? c.stage}
                />
              ))
            )}
          </Card>

          <Card title="Related listings" aside="same landlord">
            {related.status === 'ready' ? (
              related.rows.length === 0 ? (
                <EmptyRow>No related listings.</EmptyRow>
              ) : (
                related.rows.map((r) => (
                  <Row
                    key={r.unitId}
                    to={`/listings/${r.unitId}`}
                    label={
                      <span>
                        {shortAddress(r.address, r.unitId)}
                        {r.label ? <span className={styles.subLabel}>{r.label}</span> : null}
                      </span>
                    }
                    right={
                      <span className={STATUS_DOT[r.status] ?? responseClass.muted}>
                        ● {statusLabel(r.status)}
                      </span>
                    }
                  />
                ))
              )
            ) : related.status === 'error' ? (
              <EmptyRow>We couldn&apos;t load related listings.</EmptyRow>
            ) : (
              <PendingPanel />
            )}
          </Card>

          <Card title="Similar listings" aside="available comps">
            {similar.status === 'ready' ? (
              similar.rows.length === 0 ? (
                <EmptyRow>No similar listings.</EmptyRow>
              ) : (
                similar.rows.map((s) => (
                  <Row
                    key={s.unitId}
                    to={`/listings/${s.unitId}`}
                    label={
                      <span>
                        {shortAddress(s.address, s.unitId)}
                        <span className={styles.subLabel}>{s.summary}</span>
                      </span>
                    }
                    right={<span className={styles.match}>{s.matchPct}%</span>}
                  />
                ))
              )
            ) : similar.status === 'error' ? (
              <EmptyRow>We couldn&apos;t load similar listings.</EmptyRow>
            ) : (
              <PendingPanel />
            )}
          </Card>
        </div>
      </div>

      {/* BOTTOM — full-width Photos */}
      <section className={styles.photos}>
        <h2 className={styles.photosHeading}>Photos</h2>
        <div className={styles.gallery}>
          {media.map((m, i) =>
            isMediaUrl(m) ? (
              <img key={`${m}:${i}`} className={styles.thumb} src={m} alt={`Photo ${i + 1}`} />
            ) : (
              <div
                key={`${m}:${i}`}
                className={styles.thumb}
                title="Stored image (preview arrives with media URLs)"
                aria-label={`Photo ${i + 1} (stored, no preview)`}
              />
            ),
          )}
          <button type="button" className={styles.addPhoto}>
            ＋ Add
          </button>
        </div>
        {media.some((m) => !isMediaUrl(m)) ? (
          <p className={styles.photosNote}>
            Some photos are stored references; previews arrive when the backend serves media URLs.
          </p>
        ) : null}
      </section>
    </div>
  );
}
