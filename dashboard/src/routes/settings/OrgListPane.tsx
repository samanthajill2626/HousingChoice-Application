// OrgListPane - the left half of Settings > Housing authorities & agencies
// (design review 2026-10-07 Option B): the three segments with their counts,
// the search over names and spellings, and the compact list of the segment on
// screen. Each row is ONE link to its own URL (orgSelection) - one Tab stop -
// named by the exact name or value, with its use count as its description; the
// selected row is aria-current. Everything a row used to carry (spellings,
// notes, the actions) is in the detail panel.
import { useId } from 'react';
import { Link } from 'react-router-dom';
import type { NotOnListRow, OrgEntry, OrgKind, OrgUsage } from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { FIELD_LABEL, KIND_NOUN, usageTotal } from '../orgs/orgCopy.js';
import {
  ORG_SEGMENTS,
  SEGMENT_LABEL,
  entryHref,
  entryKey,
  segmentForKind,
  valueHref,
  valueKey,
  type OrgSegment,
} from './orgSelection.js';
import styles from './OrgSettings.module.css';

/** Hands a row's link to the page, so focus can come back to it (Back, Close). */
export type RowRef = (key: string) => (el: HTMLAnchorElement | null) => void;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface OrgViewBarProps {
  segment: OrgSegment;
  /** What each segment holds under the current search; null while unknown. */
  counts: Readonly<Record<OrgSegment, number | null>>;
  query: string;
  onSegment: (segment: OrgSegment) => void;
  onQuery: (query: string) => void;
}

/** The segments (a pressed-button group: each switches the list on screen)
 *  and the search. */
export function OrgViewBar({ segment, counts, query, onSegment, onQuery }: OrgViewBarProps): React.JSX.Element {
  return (
    <div className={styles.viewBar}>
      <div role="group" aria-label="Lists" className={styles.segments}>
        {ORG_SEGMENTS.map((s) => {
          const count = counts[s];
          return (
            <button
              key={s}
              type="button"
              aria-pressed={segment === s}
              className={`${styles.segment} ${segment === s ? styles.segmentOn : ''}`.trim()}
              onClick={() => onSegment(s)}
            >
              {SEGMENT_LABEL[s]}
              {/* The space keeps the name "Agencies 7", never "Agencies7". */}
              {count !== null ? <span className={styles.count}>{` ${count}`}</span> : null}
            </button>
          );
        })}
      </div>
      <input
        type="search"
        className={styles.search}
        placeholder="Search names and spellings"
        aria-label="Search names and spellings"
        autoComplete="off"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
    </div>
  );
}

interface ListRowProps {
  to: string;
  name: string;
  meta: string | null;
  quiet?: boolean;
  selected: boolean;
  linkRef: (el: HTMLAnchorElement | null) => void;
}

function ListRow({ to, name, meta, quiet = false, selected, linkRef }: ListRowProps): React.JSX.Element {
  const metaId = useId();
  return (
    <li>
      <Link
        ref={linkRef}
        to={to}
        className={`${styles.row} ${selected ? styles.rowOn : ''}`.trim()}
        aria-label={name}
        aria-describedby={meta !== null ? metaId : undefined}
        aria-current={selected ? 'page' : undefined}
      >
        <span className={styles.rowName}>{name}</span>
        {meta !== null ? (
          <span id={metaId} className={`${styles.rowMeta} ${quiet ? styles.rowMetaQuiet : ''}`.trim()}>
            {meta}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

export interface OrgEntryListProps {
  kind: OrgKind;
  /** The entries of the kind that match the search, sorted. */
  entries: readonly OrgEntry[];
  /** How many entries of the kind there are, search aside. */
  total: number;
  query: string;
  usage: OrgUsage | null;
  selectedKey: string | null;
  headingRef: React.Ref<HTMLHeadingElement>;
  rowRef: RowRef;
  onAdd: () => void;
}

/** One kind's list as a region (named by its heading), with Add. */
export function OrgEntryList({
  kind,
  entries,
  total,
  query,
  usage,
  selectedKey,
  headingRef,
  rowRef,
  onAdd,
}: OrgEntryListProps): React.JSX.Element {
  const headingId = useId();
  const title = SEGMENT_LABEL[segmentForKind(kind)];
  return (
    <section aria-labelledby={headingId}>
      <div className={styles.listHead}>
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className={styles.listHeading}>
          {title}
        </h2>
        <Button variant="secondary" size="sm" type="button" onClick={onAdd}>
          {`Add ${KIND_NOUN[kind]}`}
        </Button>
      </div>
      {total === 0 ? (
        <p className={styles.listNote}>{`No ${title.toLowerCase()} on the list yet.`}</p>
      ) : entries.length === 0 ? (
        <p className={styles.listNote}>{`No ${title.toLowerCase()} match "${query.trim()}".`}</p>
      ) : (
        // Explicit role: `list-style: none` makes WebKit drop the implicit list
        // role (the AiRunList precedent).
        <ul role="list" className={styles.rows}>
          {entries.map((entry) => {
            const key = entryKey(entry.orgId);
            const used = usage === null ? undefined : usageTotal(usage[entry.orgId]);
            return (
              <ListRow
                key={entry.orgId}
                to={entryHref(entry.orgId)}
                name={entry.name}
                meta={used === undefined ? null : used === 0 ? 'Not used' : plural(used, 'record', 'records')}
                quiet={used === 0}
                selected={selectedKey === key}
                linkRef={rowRef(key)}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

export interface NotOnListListProps {
  /** The values that match the search; null until read. */
  rows: readonly NotOnListRow[] | null;
  /** How many values there are, search aside (0 while unknown). */
  total: number;
  error: boolean;
  query: string;
  selectedKey: string | null;
  headingRef: React.Ref<HTMLHeadingElement>;
  rowRef: RowRef;
  onRetry: () => void;
}

/** "Not on the list" (spec D10): one row per value and field. */
export function NotOnListList({
  rows,
  total,
  error,
  query,
  selectedKey,
  headingRef,
  rowRef,
  onRetry,
}: NotOnListListProps): React.JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <div className={styles.listHead}>
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className={styles.listHeading}>
          {SEGMENT_LABEL['not-on-list']}
        </h2>
      </div>
      <p className={styles.listLede}>
        Values stored on contacts and properties, deleted ones included, that are not exactly a name on the
        lists. A tenant or a property can also be fixed one at a time on its own page.
      </p>
      {rows === null ? (
        error ? (
          <div className={styles.listError} role="alert">
            <p>{"Couldn't load the values that are not on the list."}</p>
            <Button variant="secondary" size="sm" type="button" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : (
          <div className={styles.center}>
            <Spinner />
          </div>
        )
      ) : total === 0 ? (
        <p className={styles.listNote}>Every stored value is on the lists.</p>
      ) : rows.length === 0 ? (
        <p className={styles.listNote}>{`No values match "${query.trim()}".`}</p>
      ) : (
        <ul role="list" className={styles.rows}>
          {rows.map((row) => {
            const key = valueKey(row.field, row.value);
            const records = plural(row.count, 'record', 'records');
            const deleted = row.deletedCount > 0 ? ` (+${row.deletedCount} deleted)` : '';
            return (
              <ListRow
                key={key}
                to={valueHref(row.field, row.value)}
                name={row.value}
                meta={`${FIELD_LABEL[row.field]} - ${records}${deleted}`}
                selected={selectedKey === key}
                linkRef={rowRef(key)}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}
