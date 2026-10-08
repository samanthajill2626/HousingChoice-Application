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

/**
 * One chip group: the uppercase label, then either its chips (plus a Clear once
 * the facet is non-empty) or the muted "nothing recorded yet" line. The group
 * ALWAYS renders on the Tenants view - a promised control must not silently
 * vanish - and each group gets its OWN label id, or all three would collapse
 * into one accessible name.
 */
export function ChipGroup({
  label,
  emptyLine,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  /** Rendered instead of chips when the facet has zero recorded values. */
  emptyLine: string | null;
  options: FacetOption[];
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onClear: (() => void) | null;
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
            {onClear !== null && selected.size > 0 ? (
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
