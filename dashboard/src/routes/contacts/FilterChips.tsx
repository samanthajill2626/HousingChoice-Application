// FilterChips - the chip-group controls shared by the contact list pages: the
// Tenants list's facets (TenantFilters) and the Caseworkers page's
// Organization chips (CaseworkersList, spec 2026-10-06 D18 - "built the way
// the Tenants page builds its housing authority chips"). Moved verbatim out of
// TenantFilters (ruling R4-12); the styles stay in TenantFilters.module.css,
// which both pages already load. Markup mirrors ListingsList's chip groups
// (divs + aria-pressed buttons) - deliberately NO ul/li, so a page's rows list
// stays its only source of listitems.
import { useId } from 'react';
import { type FacetOption } from './tenantFacets.js';
import styles from './TenantFilters.module.css';

const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

/**
 * One chip group: the uppercase label, then either its chips (plus a Clear while
 * the selection differs from its baseline - empty unless the group says
 * otherwise) or the muted "nothing recorded yet" line. The group
 * ALWAYS renders on the Tenants view - a promised control must not silently
 * vanish - and each group gets its OWN label id, or they would all collapse
 * into one accessible name.
 */
export function ChipGroup({
  label,
  emptyLine,
  options,
  selected,
  onToggle,
  onClear,
  baseline,
}: {
  label: string;
  /** Rendered instead of chips when the facet has zero recorded values. */
  emptyLine: string | null;
  options: FacetOption[];
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onClear: (() => void) | null;
  /** The selection Clear returns to (spec 2026-10-12 5.7, the Tenants Status
   *  group). Omitted = the empty set, as every other facet has always had.
   *  Clear shows only while `selected` DIFFERS from it - for the empty
   *  baseline that is exactly the old `selected.size > 0`, and an EMPTY
   *  selection against a non-empty baseline still differs (14.5 F12). */
  baseline?: ReadonlySet<string>;
}): React.JSX.Element {
  const labelId = useId();
  return (
    <div className={styles.control}>
      <span className={styles.controlLabel} id={labelId}>
        {label}
      </span>
      <div className={styles.chips} role="group" aria-labelledby={labelId}>
        {emptyLine !== null ? (
          <span className={styles.noneRecorded}>{emptyLine}</span>
        ) : (
          <>
            {options.map((o) => (
              <Chip
                key={o.key}
                label={`${o.label} (${o.count})`}
                on={selected.has(o.key)}
                count={o.count}
                onClick={() => onToggle(o.key)}
              />
            ))}
            {onClear !== null && !sameKeys(selected, baseline ?? EMPTY_KEYS) ? (
              <button
                type="button"
                className={styles.clear}
                aria-label={`Clear ${label.toLowerCase()} filter`}
                onClick={onClear}
              >
                Clear
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One facet chip. An UNSELECTED chip whose contextual count is 0 is inert:
 * `aria-disabled` on an ENABLED button (it stays in the tab order so keyboard
 * and screen-reader users can reach the explanation), the click a no-op, and a
 * muted variant whose hover reset outranks the base `.chip:hover`. A SELECTED
 * chip is always clickable - deselection must never lock.
 */
export function Chip({
  label,
  on,
  count,
  onClick,
  title,
}: {
  label: string;
  on: boolean;
  count: number;
  onClick: () => void;
  title?: string;
}): React.JSX.Element {
  const inert = count === 0 && !on;
  return (
    <button
      type="button"
      className={`${styles.chip} ${on ? styles.chipOn : ''} ${inert ? styles.chipDisabled : ''}`}
      aria-pressed={on}
      {...(inert && { 'aria-disabled': true })}
      {...(title !== undefined && { title })}
      onClick={() => {
        if (!inert) onClick();
      }}
    >
      {label}
    </button>
  );
}
