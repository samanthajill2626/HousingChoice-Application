// QuietShares - Today's "Quiet shares" section, option C (spec
// 2026-10-23-today-checklist-design 6.2, 6.3; Sam picked it 2026-10-23): one
// expandable line per property - the address and a summary such as "7 people:
// 2 replied, then quiet - 5 never replied" - with its people inside. The
// server orders everything (properties by their longest-quiet person; people
// replied first, then by longest quiet); this renders it in the order given.
//
// Opening: the first time properties arrive, the first one is open and the
// rest folded. After that the viewer's choices are kept by unitId across live
// refetches, and a property that appears later starts folded. Page state
// only. The 5-line limit counts PROPERTY lines ("Show all N properties"); an
// open property shows all its people. The heading carries no count (spec r8
// 2.1, plan PR102) and the wire carries no distinct-people count (PR103).
// The seed, the choices and Show all live in this component, which Today
// keeps MOUNTED - hidden on the client fallback rather than removed - so an
// unavailable or fallback refetch cannot reset them (code review R2-2).
//
// No Interested / Not interested here (spec 6.2): a person row opens the
// contact page, where the decision is made with the conversation in view.
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type { QuietSharePerson, QuietShareProperty } from '../../api/index.js';
import { isCaseworkerContact } from '../contact/caseworkerRole.js';
import { LimitedList, TodaySection } from './TodaySection.js';
import type { QuietSharesState } from './useToday.js';
import styles from './Today.module.css';

export const QUIET_SHARES_LABEL = 'Quiet shares';

/** The VA help line (spec 2.2), exact. */
export const QUIET_SHARES_HELP =
  'Properties sent in the last 14 days. Replied and then went quiet for 2+ days, or never replied in 5+ days. ' +
  'A message or call from either side restarts the clock; sending another property does not.';

const DAY_MS = 24 * 60 * 60 * 1000;
const NO_PROPERTIES: readonly QuietShareProperty[] = [];

/** A property line's summary (spec 6.3): "7 people: 2 replied, then quiet - 5
 *  never replied". A zero part is left out; one person reads "1 person". */
export function propertySummary(people: readonly QuietSharePerson[]): string {
  const replied = people.filter((p) => p.state === 'replied').length;
  const neverReplied = people.filter((p) => p.state === 'no_reply').length;
  const parts: string[] = [];
  if (replied > 0) parts.push(`${replied} replied, then quiet`);
  if (neverReplied > 0) parts.push(`${neverReplied} never replied`);
  const head = people.length === 1 ? '1 person' : `${people.length} people`;
  return `${head}: ${parts.join(' - ')}`;
}

/** Whole days from quietSince to `nowIso`, rounded down (spec 6.2); never
 *  negative; 0 when either instant is unparseable. */
export function quietDays(quietSince: string, nowIso: string): number {
  const since = Date.parse(quietSince);
  const now = Date.parse(nowIso);
  if (Number.isNaN(since) || Number.isNaN(now)) return 0;
  return Math.max(0, Math.floor((now - since) / DAY_MS));
}

/** "Replied, then quiet N days" / "No reply in N days" (spec 6.2). "1 day"
 *  in the singular, as the Follow up tab's chips read. */
export function quietText(person: QuietSharePerson, nowIso: string): string {
  const n = quietDays(person.quietSince, nowIso);
  const days = n === 1 ? '1 day' : `${n} days`;
  return person.state === 'replied' ? `Replied, then quiet ${days}` : `No reply in ${days}`;
}

function PersonRow({ person, now }: { person: QuietSharePerson; now: string }): React.JSX.Element {
  // "A role tag for a caseworker" (spec 6.2): a partner whose role is the
  // caseworker role - the dashboard's one rule for it.
  const caseworker = isCaseworkerContact(person);
  const text = quietText(person, now);
  const replied = person.state === 'replied';
  return (
    <li className={styles.rowItem}>
      <Link
        to={`/contacts/${encodeURIComponent(person.contactId)}`}
        className={styles.row}
        aria-label={[person.name, ...(caseworker ? ['Caseworker'] : []), text].join(', ')}
      >
        <span className={styles.main}>
          <span className={styles.who}>{person.name}</span>
          {caseworker ? <span className={styles.roleTag}>Caseworker</span> : null}
          <span className={styles.why}>{text}</span>
        </span>
        <span className={styles.meta}>
          <span className={`${styles.tag} ${replied ? styles.tagReplied : ''}`}>
            {replied ? 'Replied' : 'No reply yet'}
          </span>
        </span>
      </Link>
    </li>
  );
}

function PropertyLine({
  property,
  open,
  onToggle,
  now,
}: {
  property: QuietShareProperty;
  open: boolean;
  onToggle: () => void;
  now: string;
}): React.JSX.Element {
  const peopleId = useId();
  const summary = propertySummary(property.people);
  return (
    <li className={styles.rowItem}>
      <button
        type="button"
        className={styles.propLine}
        aria-expanded={open}
        aria-controls={open ? peopleId : undefined}
        aria-label={`${property.unitLabel}, ${summary}`}
        onClick={onToggle}
      >
        <span className={styles.propAddr}>{property.unitLabel}</span>
        <span className={styles.propSummary}>{summary}</span>
        <span className={styles.propChevron} aria-hidden="true">
          {open ? 'Hide' : 'Show'}
        </span>
      </button>
      {open ? (
        <ul
          id={peopleId}
          className={`${styles.rows} ${styles.propPeople}`}
          aria-label={`People waiting on ${property.unitLabel}`}
        >
          {property.people.map((p) => (
            <PersonRow key={p.contactId} person={p} now={now} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export interface QuietSharesSectionProps {
  quiet: QuietSharesState;
  /** The clock for "N days": the server's generatedAt - the instant the
   *  server applied the 2- and 5-day rule at, so N never reads below it - and
   *  a value, not Date.now(), so render stays pure. */
  now: string;
  /** The client fallback (spec 3.1): no section at all - not even the
   *  unavailable copy - while the component stays mounted, so the seed, the
   *  choices and Show all outlive the fallback load (code review R2-2). */
  hidden?: boolean;
}

export function QuietSharesSection({ quiet, now, hidden = false }: QuietSharesSectionProps): React.JSX.Element | null {
  const properties = !hidden && quiet.status === 'ok' ? quiet.properties : NO_PROPERTIES;
  // unitId -> open, for this mount (page state only, spec 6.3).
  const [openByUnit, setOpenByUnit] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [seeded, setSeeded] = useState(false);
  // "Show all N properties", held here rather than in the list: the
  // unavailable branch below renders no list (spec 2.1, code review R2-2).
  const [expanded, setExpanded] = useState(false);
  const first = properties[0];
  if (!seeded && first !== undefined) {
    // Seed ONCE, the first time properties arrive: the first property open,
    // the rest folded. A conditional state update during render (react.dev,
    // useState "storing information from previous renders"): React re-renders
    // before committing, so nothing flashes folded.
    setSeeded(true);
    setOpenByUnit(new Map([[first.unitId, true]]));
  }

  if (hidden) return null;
  if (quiet.status === 'unavailable') {
    return (
      <TodaySection label={QUIET_SHARES_LABEL}>
        <p className={styles.sectionError} role="alert">
          {"We couldn't load quiet shares."}
        </p>
      </TodaySection>
    );
  }
  if (properties.length === 0) return null;

  const toggle = (unitId: string): void => {
    setOpenByUnit((prev) => {
      const next = new Map(prev);
      next.set(unitId, prev.get(unitId) !== true);
      return next;
    });
  };

  return (
    <TodaySection label={QUIET_SHARES_LABEL} help={QUIET_SHARES_HELP}>
      <LimitedList
        label={QUIET_SHARES_LABEL}
        items={properties}
        itemKey={(p) => p.unitId}
        noun="properties"
        expansion={{ expanded, onToggle: () => setExpanded((open) => !open) }}
        renderItem={(p) => (
          <PropertyLine
            property={p}
            open={openByUnit.get(p.unitId) === true}
            onToggle={() => toggle(p.unitId)}
            now={now}
          />
        )}
      />
      {quiet.truncated ? <p className={styles.note}>Showing the first 100 properties</p> : null}
    </TodaySection>
  );
}
