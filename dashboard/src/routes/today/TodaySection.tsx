// TodaySection - the section frame every Today section shares (spec
// 2026-10-23-today-checklist-design 2, 2.1; plan PR33).
//
// TodaySection: a <section> whose heading is the bare label - NO count (spec
// r8 2.1, plan PR102: the 2026-08-03 no-bare-counts ruling stands; the
// "Show all N" button names the count) - plus an optional help line for the
// VA (spec 2.2).
//
// LimitedList: the section's list, named by the heading text -
// getByRole('list', { name: 'Tours to book' }) - showing its first
// TODAY_SECTION_LIMIT rows. Past the limit a "Show all N" button under it
// expands the list in place and then reads "Show fewer" (aria-expanded,
// aria-controls = the list). Expansion is per-viewer page state only: lost
// on reload, never stored. Every checklist section, Tours today, the opened
// AI suggestions line and the Quiet shares property lines use it.
import { Fragment, useId, useState } from 'react';
import styles from './Today.module.css';

/** Rows a section shows before its "Show all N" button (spec 2.1). */
export const TODAY_SECTION_LIMIT = 5;

export interface TodaySectionProps {
  /** The heading text (no count, PR102) - also its list's accessible name. */
  label: string;
  /** The VA help line under the heading (spec 2.2). */
  help?: string;
  /** 2 for a checklist section (the default); 3 for a part of At a glance. */
  level?: 2 | 3;
  children: React.ReactNode;
}

export function TodaySection({ label, help, level = 2, children }: TodaySectionProps): React.JSX.Element {
  const Heading = level === 3 ? 'h3' : 'h2';
  return (
    <section className={styles.group}>
      <Heading className={styles.groupHeading}>{label}</Heading>
      {help !== undefined ? <p className={styles.help}>{help}</p> : null}
      {children}
    </section>
  );
}

export interface LimitedListProps<T> {
  /** The list's accessible name: the section's heading text. */
  label: string;
  items: readonly T[];
  itemKey: (item: T) => string;
  /** Renders ONE row, as an <li>. */
  renderItem: (item: T) => React.ReactNode;
  /** Names what is counted: "properties" -> "Show all 7 properties". */
  noun?: string;
  /** Rendered beside the Show all button (the Past tab link). */
  footer?: React.ReactNode;
}

export function LimitedList<T>({
  label,
  items,
  itemKey,
  renderItem,
  noun,
  footer,
}: LimitedListProps<T>): React.JSX.Element {
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const overflows = items.length > TODAY_SECTION_LIMIT;
  const shown = overflows && !expanded ? items.slice(0, TODAY_SECTION_LIMIT) : items;
  const showAll = noun !== undefined ? `Show all ${items.length} ${noun}` : `Show all ${items.length}`;
  return (
    <>
      <ul id={listId} className={styles.rows} aria-label={label}>
        {shown.map((item) => (
          <Fragment key={itemKey(item)}>{renderItem(item)}</Fragment>
        ))}
      </ul>
      {overflows || footer !== undefined ? (
        <div className={styles.listFooter}>
          {overflows ? (
            <button
              type="button"
              className={styles.showAll}
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? 'Show fewer' : showAll}
            </button>
          ) : null}
          {footer}
        </div>
      ) : null}
    </>
  );
}
