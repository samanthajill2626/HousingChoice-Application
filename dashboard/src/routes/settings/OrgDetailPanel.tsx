// OrgDetailPanel - the right half of Settings > Housing authorities & agencies
// (design review 2026-10-07 Option B): everything about the selected entry -
// its spellings as chips (a spelling can hold a comma, so they are never
// joined into one string), its notes, what uses it - and labeled actions.
// Everyone gets Edit notes; the admin-only actions are ABSENT for a VA, never
// disabled (spec D10; S14 S8), and the server enforces requireRole('admin').
// While a rewrite runs, the four that would start or collide with one wait,
// and the reason is VISIBLE text the buttons are described by - a disabled
// button cannot take focus, so a title alone reaches no keyboard or screen
// reader user (review P11). The panel heading takes focus when an entry is
// picked; Back (phone) and Close (desktop) go back to the list.
import { useId } from 'react';
import { Link } from 'react-router-dom';
import type { OrgEntry, OrgUsageCounts } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { KIND_FIELD_LABEL, blockingUses, usageText } from '../orgs/orgCopy.js';
import { SEGMENT_LABEL, listHref, type OrgSegment } from './orgSelection.js';
import listStyles from './OrgListSection.module.css';
import styles from './OrgSettings.module.css';

/** The entry actions, as OrgListSection's dialogs name them. */
export type EntryAction = 'notes' | 'spellings' | 'rename' | 'merge' | 'kind' | 'delete';

export const REWRITE_WAIT_REASON =
  'Another update is still running. Rename, Merge, Change kind and Delete wait until it finishes.';

/** U+2039 SINGLE LEFT-POINTING ANGLE QUOTATION MARK, built at runtime so the
 *  source stays ASCII (the REMOVE_GLYPH precedent in OrgEntryDialogs). */
const BACK_GLYPH = String.fromCharCode(0x2039);

/** Back to the list: "Back to <list>" when one pane shows at a time, else Close.
 *  A plain push either way: the entry's URL is a real place to come back to.
 *  The chevron is decoration, hidden from the accessible name (code review r1
 *  M7). */
export function PanelBack({ segment, narrow }: { segment: OrgSegment; narrow: boolean }): React.JSX.Element {
  return (
    <Link to={listHref(segment)} className={`${styles.back} ${narrow ? '' : styles.close}`.trim()}>
      {narrow ? (
        <>
          <span aria-hidden="true" className={styles.chevron}>
            {BACK_GLYPH}
          </span>
          {`Back to ${SEGMENT_LABEL[segment]}`}
        </>
      ) : (
        'Close'
      )}
    </Link>
  );
}

/** Nothing picked yet (the panel's resting state beside the list). */
export function OrgPanelPlaceholder({ segment, isAdmin }: { segment: OrgSegment; isAdmin: boolean }): React.JSX.Element {
  const text =
    segment === 'not-on-list'
      ? `Pick a value to see the records holding it${isAdmin ? ' and settle it' : ''}.`
      : 'Pick a name to see its spellings, its notes and what uses it.';
  return <p className={styles.placeholder}>{text}</p>;
}

/** A selection the page cannot show (merged, deleted, settled, a stale link,
 *  or a read that failed - then with Retry, which at the narrow width is the
 *  only one on screen; code review r1 M2). */
export function OrgPanelMessage({
  segment,
  narrow,
  title,
  text,
  headingRef,
  onRetry,
}: {
  segment: OrgSegment;
  narrow: boolean;
  title: string;
  text: string;
  headingRef: React.Ref<HTMLHeadingElement>;
  onRetry?: () => void;
}): React.JSX.Element {
  const headingId = useId();
  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <div className={styles.panelTop}>
        <PanelBack segment={segment} narrow={narrow} />
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className={styles.panelHeading}>
          {title}
        </h2>
      </div>
      <p className={`${styles.factValue} ${styles.quiet}`}>{text}</p>
      {onRetry !== undefined ? (
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" type="button" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export interface OrgEntryPanelProps {
  entry: OrgEntry;
  usage: OrgUsageCounts | undefined;
  isAdmin: boolean;
  /** True while a rewrite runs (D11: one at a time). */
  rewriteLive: boolean;
  segment: OrgSegment;
  narrow: boolean;
  headingRef: React.Ref<HTMLHeadingElement>;
  onAction: (action: EntryAction) => void;
}

export function OrgEntryPanel({
  entry,
  usage,
  isAdmin,
  rewriteLive,
  segment,
  narrow,
  headingRef,
  onAction,
}: OrgEntryPanelProps): React.JSX.Element {
  const headingId = useId();
  const reasonId = useId();
  const notes = entry.notes ?? '';
  // "Not used" only when no record holds the name in any field (R2-F1, spec D17).
  const total = blockingUses(usage, 'delete');
  // Rename and Merge start a rewrite, so they wait while one runs (D11); Change
  // kind and Delete wait too - the server refuses both with 409
  // org_rewrite_running while one runs (plan 3.5), so an enabled button could
  // only fail. Edit spellings touches no records and never waits.
  const waits = {
    disabled: rewriteLive,
    'aria-describedby': rewriteLive ? reasonId : undefined,
  };
  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <div className={styles.panelTop}>
        <PanelBack segment={segment} narrow={narrow} />
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className={styles.panelHeading}>
          {entry.name}
        </h2>
        <p className={styles.panelKind}>{KIND_FIELD_LABEL[entry.kind]}</p>
      </div>
      <dl className={styles.facts}>
        <dt className={styles.factLabel}>Spellings</dt>
        <dd className={styles.factValue}>
          {entry.spellings.length > 0 ? (
            <ul className={listStyles.spellings} aria-label={`Spellings of ${entry.name}`}>
              {entry.spellings.map((spelling, i) => (
                <li key={`${i}:${spelling}`} className={listStyles.spelling}>
                  {spelling}
                </li>
              ))}
            </ul>
          ) : (
            <span className={styles.quiet}>No spellings.</span>
          )}
        </dd>
        <dt className={styles.factLabel}>Notes</dt>
        <dd className={`${styles.factValue} ${styles.notes}`}>
          {notes !== '' ? notes : <span className={styles.quiet}>No notes yet.</span>}
        </dd>
        <dt className={styles.factLabel}>Used by</dt>
        <dd className={styles.factValue}>
          {total === 0 ? <span className={styles.quiet}>Not used</span> : usageText(usage)}
        </dd>
      </dl>
      {isAdmin && rewriteLive ? (
        <p id={reasonId} className={styles.reason}>
          {REWRITE_WAIT_REASON}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          aria-label={`Edit notes for ${entry.name}`}
          onClick={() => onAction('notes')}
        >
          Edit notes
        </Button>
        {isAdmin ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              aria-label={`Edit spellings for ${entry.name}`}
              onClick={() => onAction('spellings')}
            >
              Edit spellings
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              aria-label={`Rename ${entry.name}`}
              {...waits}
              onClick={() => onAction('rename')}
            >
              Rename
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              aria-label={`Merge ${entry.name}`}
              {...waits}
              onClick={() => onAction('merge')}
            >
              Merge
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              aria-label={`Change kind of ${entry.name}`}
              {...waits}
              onClick={() => onAction('kind')}
            >
              Change kind
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              className={styles.deleteAction}
              aria-label={`Delete ${entry.name}`}
              {...waits}
              onClick={() => onAction('delete')}
            >
              Delete
            </Button>
          </>
        ) : null}
      </div>
    </section>
  );
}
