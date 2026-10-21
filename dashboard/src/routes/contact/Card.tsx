// Card + PendingPanel — the file-pane building blocks shared by TenantFile and
// LandlordFile. A Card is a stacked white section with an uppercase heading and
// an optional right-aligned action/count slot. PendingPanel is the honest
// "arrives with the backend" empty state for the C4/C5 slices (listings-sent /
// media) and the manual-now preferences — we never fabricate data.
import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { InterestedMode, ListingSendRow, TourSignalState } from '../../api/index.js';
import { formatHeardFrom } from '../../lib/heardFrom.js';
import { isTourTypeRequired, outcomeErrorCopy } from '../../lib/listingOutcomeErrors.js';
import styles from './Card.module.css';

export interface CardProps {
  title: string;
  /** Right-aligned slot: an Edit/add affordance or a short qualifier (never a bare count). */
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
  disabled,
  describedBy,
}: {
  children: React.ReactNode;
  onClick: () => void;
  /** Accessible label when the text alone is ambiguous (e.g. "Edit"). */
  label?: string;
  /** Disabled with a reason: render the reason in the card and pass its id
   *  as `describedBy` (property requirements D8, Apply to properties). */
  disabled?: boolean;
  describedBy?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={styles.asideBtn}
      onClick={onClick}
      {...(label !== undefined && { 'aria-label': label })}
      {...(disabled === true && { disabled: true })}
      {...(describedBy !== undefined && { 'aria-describedby': describedBy })}
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

/** The dashboard-wide placeholder for a value that is not recorded: an em dash
 *  (U+2014), written as an escape so no file-encoding round-trip can mangle it. The
 *  Settings numbers table is the ONE deliberate exception and uses an ASCII "-"
 *  (spec adjudication A10). */
export const BLANK = '\u2014';

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

/** The ONE shared tour-state chip both send-roster cards render ("Sent to"
 *  on the property page + "Properties sent" on a contact's file). It is a
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

/** What a send-roster row's action asks the outcome route for. */
export type SendRowAction = 'interested' | 'not_interested' | 'clear';

/** last-heard-from spec 14.3 B2: the contact page derives the Interested mode
 *  from the units it already loaded ('route' = one click creates the tour). An
 *  absent unit (deleted, or not loaded) reads 'form'. */
export function interestedModeOf(unit: { tour_type?: string } | undefined): InterestedMode {
  return typeof unit?.tour_type === 'string' && unit.tour_type.length > 0 ? 'route' : 'form';
}

export interface SendRosterRowProps {
  /** The identity link's route (a contact on the property card, a property on a contact card). */
  to: string;
  identity: React.ReactNode;
  /** caseworkers D20: a muted label after the identity link (a non-tenant
   *  recipient's displayKind on the property "Sent to" card). Outside the
   *  link, so the link's accessible name stays the identity. */
  kind?: string;
  /** The whole wire row (outcome, dates, tour, decline). */
  row: ListingSendRow;
  /** For the accessible names: the property's (short) address ... */
  address: string;
  /** ... and the person's name. */
  name: string;
  /** Computed by the host (server on the property card, file.units on the contact page). */
  interestedMode: InterestedMode;
  /** A deleted property: outcomes show, actions do not (spec 14.3 B10). */
  actionsDisabled?: boolean;
  /** Calls the outcome route and applies the returned row; rejects on failure. */
  onOutcome: (outcome: SendRowAction) => Promise<void>;
  /** A Link to /listings/:unitId?tour=new (head 3.4 #1). The HOST passes it
   *  ONLY for a PARTNER recipient (B8: the units route's `row.type`, or the
   *  contact page's own type) - never for a landlord or team-member row. */
  requestTourTo?: string;
  /** Render that link with `replace` (the property page, whose tour dialog
   *  adds no history entry - task 5.3); the contact pages leave it a push. */
  requestTourReplace?: boolean;
  /** interestedMode 'form' on a tenant row: open the Schedule tour form. Also
   *  the fall-through when a 'route' click answers 409 tour_type_required (the
   *  property lost its tour_type since the page loaded - review B R2-5). */
  onOpenTourForm?: () => void;
  now: Date;
}

/** The outcome chip (spec 5.5). `interested` IS the tour chip - no second chip. */
function OutcomeChip({ row, now }: { row: ListingSendRow; now: Date }): React.JSX.Element | null {
  const chip = styles.outcomeChip ?? '';
  switch (row.outcome) {
    case 'no_reply':
      return <span className={chip}>No reply yet</span>;
    case 'replied':
      return <span className={`${chip} ${styles.chipPositive ?? ''}`}>Replied</span>;
    case 'interested':
      // Head 3.4 #5: an interested row whose response carries no `tour` reads `Interested`.
      return row.tour ? <TourChip tourId={row.tour.tourId} state={row.tour.state} /> : <span className={chip}>Interested</span>;
    case 'not_interested': {
      const title = row.declined !== undefined ? formatHeardFrom(row.declined.at, now).title : '';
      return (
        <span className={`${chip} ${styles.chipMuted ?? ''}`} {...(title !== '' && { title })}>
          {row.declined?.by === 'engine' ? 'Not interested (auto)' : 'Not interested'}
        </span>
      );
    }
    default:
      return null;
  }
}

/** The list every send-roster host wraps its rows in (markup R1, plan head
 *  3.4 #10): a `<ul>` named by `label` (a property-card group - `Waiting`,
 *  `Interested`, `Not interested`, `Not eligible` - or `Properties sent` on a
 *  contact card). Its children are SendRosterRows only, so every listitem in a
 *  card is one roster row. */
export function SendRosterList({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <ul className={styles.sendList} aria-label={label}>
      {children}
    </ul>
  );
}

/** A send-roster row (last-heard-from spec 5.5): line one is the identity
 *  link (+ kind) and the muted "Sent <date> - Last heard from <date>"; line
 *  two is the outcome chip and the outcome's actions. The root is an `<li>`
 *  (markup R1) and must sit inside a SendRosterList. The row is NOT a
 *  full-row link (the identity, the tour chip and the actions go to different
 *  places; nesting anchors would be invalid). An action disables itself while
 *  in flight and the host replaces the row with the route's answer; a failure
 *  shows an inline error and leaves the row unchanged. */
export function SendRosterRow({
  to,
  identity,
  kind,
  row,
  address,
  name,
  interestedMode,
  actionsDisabled = false,
  onOutcome,
  requestTourTo,
  requestTourReplace = false,
  onOpenTourForm,
  now,
}: SendRosterRowProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (outcome: SendRowAction): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void onOutcome(outcome)
      .catch((err: unknown) => {
        // Review B R2-5: the property lost its tour_type since the page
        // loaded (409 tour_type_required) - fall through to the form path
        // when the host has one, rather than a dead-end "try again".
        if (outcome === 'interested' && isTourTypeRequired(err) && onOpenTourForm !== undefined) {
          onOpenTourForm();
          return;
        }
        setError(outcomeErrorCopy(err));
      })
      .finally(() => setBusy(false));
  };
  const sent = formatHeardFrom(row.sentAt, now);
  const heard = formatHeardFrom(row.lastHeardFromAt, now);
  const showActions = !actionsDisabled && row.recipientMissing !== true;
  const waiting = row.outcome === 'no_reply' || row.outcome === 'replied';
  const canInterested = waiting && row.interestedSupported && (interestedMode === 'route' || onOpenTourForm !== undefined);
  return (
    <li className={styles.sendRow}>
      <div className={styles.sendRowLine}>
        <span className={styles.liLabel}>
          <Link className={styles.rowLink ?? ''} to={to}>
            {identity}
          </Link>
          {kind !== undefined ? <span className={styles.rowKind}>{kind}</span> : null}
        </span>
        <span className={styles.sendRowDates}>
          {/* Contract N1: an empty title (a "Never" label) renders NO title attribute. */}
          <span {...(sent.title !== '' && { title: sent.title })}>Sent {sent.label}</span>
          {' - '}
          <span {...(heard.title !== '' && { title: heard.title })}>Last heard from {heard.label}</span>
        </span>
      </div>
      <div className={styles.sendRowLine}>
        <OutcomeChip row={row} now={now} />
        {showActions ? (
          <span className={styles.rowActions}>
            {canInterested ? (
              <button
                type="button"
                className={styles.rowButton}
                aria-label={`Mark ${name} interested in ${address}`}
                disabled={busy}
                onClick={() => (interestedMode === 'route' ? run('interested') : onOpenTourForm?.())}
              >
                Interested
              </button>
            ) : null}
            {waiting && !row.interestedSupported && requestTourTo !== undefined ? (
              <Link
                className={styles.rowActionLink ?? ''}
                to={requestTourTo}
                replace={requestTourReplace}
                aria-label={`Request a tour for ${name} at ${address}`}
              >
                Request a tour
              </Link>
            ) : null}
            {waiting ? (
              <button
                type="button"
                className={styles.rowButton}
                aria-label={`Mark ${name} not interested in ${address}`}
                disabled={busy}
                onClick={() => run('not_interested')}
              >
                Not interested
              </button>
            ) : null}
            {row.outcome === 'not_interested' ? (
              <button
                type="button"
                className={styles.rowButton}
                aria-label={`Undo not interested for ${name}`}
                disabled={busy}
                onClick={() => run('clear')}
              >
                Undo
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      {error !== null ? (
        <p role="alert" className={styles.rowError}>
          {error}
        </p>
      ) : null}
    </li>
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
