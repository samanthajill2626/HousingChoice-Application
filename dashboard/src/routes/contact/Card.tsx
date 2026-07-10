// Card + PendingPanel — the file-pane building blocks shared by TenantFile and
// LandlordFile. A Card is a stacked white section with an uppercase heading and
// an optional right-aligned action/count slot. PendingPanel is the honest
// "arrives with the backend" empty state for the C4/C5 slices (listings-sent /
// media) and the manual-now preferences — we never fabricate data.
import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TourSignalState } from '../../api/index.js';
import styles from './Card.module.css';

export interface CardProps {
  title: string;
  /** Right-aligned slot: an Edit affordance or a count chip. */
  aside?: React.ReactNode;
  children: React.ReactNode;
}

export function Card({ title, aside, children }: CardProps): React.JSX.Element {
  return (
    <section className={styles.card}>
      <h3 className={styles.heading}>
        {title}
        {aside !== undefined ? <span className={styles.aside}>{aside}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** A clickable Card heading action (e.g. "Edit", "+ Add"), styled like the muted
 *  `aside` text but interactive. Pass as the Card's `aside`. */
export function CardAction({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  /** Accessible label when the text alone is ambiguous (e.g. "Edit"). */
  label?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={styles.asideBtn}
      onClick={onClick}
      {...(label !== undefined && { 'aria-label': label })}
    >
      {children}
    </button>
  );
}

/** A small inline text-button (e.g. "Manage" next to the phone numbers) — like
 *  CardAction but without the right-align, for use INSIDE a value. */
export function CardInlineAction({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={styles.inlineAction}
      onClick={onClick}
      {...(label !== undefined && { 'aria-label': label })}
    >
      {children}
    </button>
  );
}

/** A small muted "pending backend" state for panels whose data arrives with a
 *  backend slice that isn't live yet. */
export function PendingPanel({ note }: { note?: string }): React.JSX.Element {
  return (
    <p className={styles.pending}>{note ?? 'Arrives with the backend.'}</p>
  );
}

/** A muted "nothing here" state for a real-but-empty panel. */
export function EmptyRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className={styles.empty}>{children}</p>;
}

/**
 * Render a list of already-built rows, capped at `limit` (default 4) with a
 * "Show N more" / "Show less" toggle when there are more. Each row must carry its
 * own `key`. Owns its expanded state per instance, so several lists on a page
 * expand independently. Keeps long card lists (a landlord's properties/tours/
 * placements, a unit's related/similar) from running unbounded.
 */
export function CollapsibleRows({
  rows,
  limit = 4,
}: {
  rows: React.JSX.Element[];
  limit?: number;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, limit);
  const hidden = rows.length - limit;
  return (
    <>
      {shown}
      {rows.length > limit ? (
        <button
          type="button"
          className={styles.moreToggle}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : `Show ${hidden} more`}
        </button>
      ) : null}
    </>
  );
}

/** A key/value detail row (the Details card). An optional `hint` adds a small ⓘ
 *  next to the key that reveals the explanation on hover (title tooltip) — for
 *  fields whose meaning isn't obvious from the label alone (e.g. the
 *  landlord-onboarding criteria), without cluttering the row with always-on text. */
export function KV({
  k,
  v,
  hint,
}: {
  k: string;
  v: React.ReactNode;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className={styles.kv}>
      <span className={styles.k}>
        {k}
        {hint ? (
          <span className={styles.info} title={hint} aria-label={hint} role="img">
            ⓘ
          </span>
        ) : null}
      </span>
      <span className={styles.v}>{v}</span>
    </div>
  );
}

export interface RowProps {
  /** When set, the whole row becomes a link to this route. */
  to?: string;
  label: React.ReactNode;
  /** Right-aligned status / response slot. */
  right?: React.ReactNode;
}

/** A list row (a placement / tour / property / listings-sent entry). Links out when
 *  `to` is set. */
export function Row({ to, label, right }: RowProps): React.JSX.Element {
  const inner = (
    <>
      <span className={styles.liLabel}>{label}</span>
      {right !== undefined ? <span className={styles.liRight}>{right}</span> : null}
    </>
  );
  return to ? (
    <Link className={styles.li} to={to}>
      {inner}
    </Link>
  ) : (
    <div className={styles.li}>{inner}</div>
  );
}

/** Copy + tone for the derived tour-state chip. `state` comes from the server's
 *  live tour derivation (see the app-side `deriveTourSignal`): requested reads as
 *  a neutral/wait signal; scheduled + toured are positive/progress. The label
 *  IS the accessible name of the link (no extra aria needed). Staff copy. */
const TOUR_CHIP_META: Record<TourSignalState, { label: string; cls: string }> = {
  requested: { label: 'Tour requested', cls: styles.wait ?? '' },
  scheduled: { label: 'Tour scheduled', cls: styles.statusAvailable ?? '' },
  toured: { label: 'Toured', cls: styles.yes ?? '' },
};

/** The ONE shared tour-state chip both send-roster cards render ("Sent to
 *  tenants" on the property page + "Properties sent" on the tenant file). It is a
 *  link to the tour detail page; the chip text is its accessible name. */
export function TourChip({
  tourId,
  state,
}: {
  tourId: string;
  state: TourSignalState;
}): React.JSX.Element {
  const meta = TOUR_CHIP_META[state];
  return (
    <Link className={`${styles.tourChip ?? ''} ${meta.cls}`.trim()} to={`/tours/${encodeURIComponent(tourId)}`}>
      {meta.label}
    </Link>
  );
}

/** A send-roster row: the identity links to its detail page (a contact on the
 *  property card, a property on the tenant card) and, when a qualifying tour
 *  exists for the pairing, a `TourChip` links to that tour. The row is NOT a
 *  full-row link because the identity and the chip navigate to DIFFERENT places
 *  (nesting anchors would be invalid) — each is its own link. Rows without a
 *  tour render just the identity. */
export function SendRosterRow({
  to,
  identity,
  tour,
}: {
  to: string;
  identity: React.ReactNode;
  tour?: { tourId: string; state: TourSignalState };
}): React.JSX.Element {
  return (
    <div className={styles.li}>
      <span className={styles.liLabel}>
        <Link className={styles.rowLink ?? ''} to={to}>
          {identity}
        </Link>
      </span>
      {tour ? (
        <span className={styles.liRight}>
          <TourChip tourId={tour.tourId} state={tour.state} />
        </span>
      ) : null}
    </div>
  );
}

/** A wrapping row of preference / note chips. */
export function Chips({ items }: { items: string[] }): React.JSX.Element {
  return (
    <div className={styles.chips}>
      {items.map((c) => (
        <span key={c} className={styles.chip}>
          {c}
        </span>
      ))}
    </div>
  );
}

/**
 * Full-text notes: prose with the author's newlines PRESERVED (pre-wrap),
 * clamped to ~6 lines with a "Show more"/"Show less" toggle that appears only
 * when the text actually overflows the clamp. Replaces the old chip rendering,
 * which collapsed newlines and truncated nothing (a wall-of-text pill).
 */
export function NotesText({ text }: { text: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  // Measure whether the CLAMPED text overflows (→ show the toggle). Re-measure
  // on text changes and container resizes (wrap width changes the line count).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  return (
    <div>
      <p ref={ref} className={`${styles.notes} ${expanded ? '' : styles.notesClamped}`}>
        {text}
      </p>
      {overflowing || expanded ? (
        <button
          type="button"
          className={styles.notesToggle}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

/** The CSS-module class for a response/status word, so callers can color a
 *  👍/👎/⏳ or availability label without importing the module. */
export const responseClass = {
  yes: styles.yes ?? '',
  no: styles.no ?? '',
  wait: styles.wait ?? '',
  muted: styles.muted ?? '',
  available: styles.statusAvailable ?? '',
  placed: styles.statusPlaced ?? '',
  inactive: styles.statusInactive ?? '',
};
