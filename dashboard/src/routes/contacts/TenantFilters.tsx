// TenantFilters - the Tenants list's three facet controls (spec section 5 of
// docs/superpowers/specs/2026-08-06-tenant-list-visibility-design.md): voucher
// size, housing authority, and a Porting toggle. Pure presentation: the model
// and the selection come in, a NEXT selection goes out; tenantFacets owns every
// rule (bucketing, label merge, Not-recorded, contextual counts) and
// ContactsList owns the URL. Markup mirrors ListingsList's chip groups (divs +
// aria-pressed buttons) - deliberately NO ul/li, so the rows list stays the only
// source of listitems.
import { useId } from 'react';
import { type FacetOption, type TenantFacetModel, type TenantSelection } from './tenantFacets.js';
import styles from './TenantFilters.module.css';

export interface TenantFiltersProps {
  /** Options + contextual counts, from `buildFacets`. */
  model: TenantFacetModel;
  /** The active selection (parsed from the URL by ContactsList). */
  selection: TenantSelection;
  /** The NEXT selection after a chip/Clear interaction. */
  onChange: (next: TenantSelection) => void;
}

/** Toggle one key in a facet set, returning a new set. */
function toggled(keys: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(keys);
  if (!next.delete(key)) next.add(key);
  return next;
}

/**
 * One chip group: the uppercase label, then either its chips (plus a Clear once
 * the facet is non-empty) or the muted "nothing recorded yet" line. The group
 * ALWAYS renders on the Tenants view - a promised control must not silently
 * vanish - and each group gets its OWN label id, or all three would collapse
 * into one accessible name.
 */
function ChipGroup({
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
function Chip({
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

export function TenantFilters({ model, selection, onChange }: TenantFiltersProps): React.JSX.Element {
  const portingLabelId = useId();
  return (
    <div className={styles.controls}>
      <ChipGroup
        label="Voucher size"
        emptyLine={model.voucherEmpty ? 'No voucher sizes recorded yet' : null}
        options={model.voucher}
        selected={selection.voucher}
        onToggle={(key) => onChange({ ...selection, voucher: toggled(selection.voucher, key) })}
        onClear={() => onChange({ ...selection, voucher: new Set<string>() })}
      />
      <ChipGroup
        label="Housing authority"
        emptyLine={model.authorityEmpty ? 'No housing authorities recorded yet' : null}
        options={model.authority}
        selected={selection.ha}
        onToggle={(key) => onChange({ ...selection, ha: toggled(selection.ha, key) })}
        onClear={() => onChange({ ...selection, ha: new Set<string>() })}
      />
      {/* A toggle with nothing to match is dead UI, so Porting hides entirely
       *  until some tenant is porting. It is a SINGLE toggle: the chip is its own
       *  Clear, so no redundant second control is rendered. Label + title mirror
       *  the shipped placement chip (PlacementRow.tsx:41-45). */}
      {model.showPorting ? (
        <div className={styles.control}>
          <span className={styles.controlLabel} id={portingLabelId}>
            Porting
          </span>
          <div className={styles.chips} role="group" aria-labelledby={portingLabelId}>
            <Chip
              label={`Porting (${model.portingCount})`}
              on={selection.porting}
              count={model.portingCount}
              title="Tenant is porting"
              onClick={() => onChange({ ...selection, porting: !selection.porting })}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
