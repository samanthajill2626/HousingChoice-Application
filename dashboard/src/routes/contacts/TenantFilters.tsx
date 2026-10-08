// TenantFilters - the Tenants list's three facet controls (spec section 5 of
// docs/superpowers/specs/2026-08-06-tenant-list-visibility-design.md): voucher
// size, housing authority, and a Porting toggle. Pure presentation: the model
// and the selection come in, a NEXT selection goes out; tenantFacets owns every
// rule (bucketing, label merge, Not-recorded, contextual counts) and
// ContactsList owns the URL. Markup mirrors ListingsList's chip groups (divs +
// aria-pressed buttons) - deliberately NO ul/li, so the rows list stays the only
// source of listitems.
import { useId } from 'react';
import { Chip, ChipGroup } from './FilterChips.js';
import { type TenantFacetModel, type TenantSelection } from './tenantFacets.js';
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
