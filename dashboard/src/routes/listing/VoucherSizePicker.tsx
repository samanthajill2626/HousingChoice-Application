// VoucherSizePicker - picker B for the property forms' "Voucher sizes
// accepted" (spec 2026-10-20 D4; plan 1.1, 2.6). Toggle chips Studio and 1-4,
// and "More sizes (5-12)" for the larger ones - open by themselves when a
// stored size is 5 or more; "Fewer sizes" hides them again only while none of
// them is selected. A line under the chips says what the property accepts,
// and stored values with no chip are listed as removed by the next save (the
// form sends the list without them). The group's accessible name is its label;
// the host's flyer tag rides in `labelAside` / `describedBy` (C5). The chip
// style mirrors AudienceFilters.
import { useId, useState } from 'react';
import { VOUCHER_SIZE_MAX } from './requirements.js';
import styles from './VoucherSizePicker.module.css';

export interface VoucherSizePickerProps {
  /** The selected sizes (integers 0..12). */
  value: number[];
  /** Stored values the picker has no chip for (a non-integer, or above 12). */
  invalid: readonly unknown[];
  /** The next selection, ascending and de-duplicated ([] = none). */
  onChange: (next: number[]) => void;
  disabled?: boolean;
  /** Rendered beside the group label (the host's flyer tag). */
  labelAside?: React.ReactNode;
  /** Extra ids for the group's aria-describedby (the tag's id), before its own lines. */
  describedBy?: string;
}

const BASE_SIZES: readonly number[] = [0, 1, 2, 3, 4];
const LARGE_SIZES: readonly number[] = Array.from({ length: VOUCHER_SIZE_MAX - 4 }, (_, i) => i + 5);

function chipLabel(size: number): string {
  return size === 0 ? 'Studio' : String(size);
}

/** The line under the chips (plan 1.1): "Accepts: Studio, 2 BR", or "Accepts: none recorded". */
export function acceptsSummary(sizes: readonly number[]): string {
  if (sizes.length === 0) return 'Accepts: none recorded';
  const words = [...sizes].sort((a, b) => a - b).map((n) => (n === 0 ? 'Studio' : `${n} BR`));
  return `Accepts: ${words.join(', ')}`;
}

export function VoucherSizePicker({
  value,
  invalid,
  onChange,
  disabled = false,
  labelAside,
  describedBy,
}: VoucherSizePickerProps): React.JSX.Element {
  const uid = useId();
  const labelId = `${uid}-label`;
  const summaryId = `${uid}-summary`;
  const invalidId = `${uid}-invalid`;
  const [expanded, setExpanded] = useState(() => value.some((n) => n >= 5));
  const largeSelected = value.some((n) => n >= 5);
  const showLarge = expanded || largeSelected;
  const sizes = showLarge ? [...BASE_SIZES, ...LARGE_SIZES] : BASE_SIZES;
  const describedByIds = [describedBy, summaryId, invalid.length > 0 ? invalidId : undefined]
    .filter((id): id is string => id !== undefined && id !== '')
    .join(' ');

  function toggle(size: number): void {
    const next = value.includes(size) ? value.filter((n) => n !== size) : [...value, size];
    onChange([...new Set(next)].sort((a, b) => a - b));
  }

  return (
    <div className={styles.picker}>
      <div className={styles.labelRow}>
        <span id={labelId} className={styles.label}>
          Voucher sizes accepted
        </span>
        {labelAside}
      </div>
      <div className={styles.chipRow}>
        <div className={styles.chips} role="group" aria-labelledby={labelId} aria-describedby={describedByIds}>
          {sizes.map((size) => {
            const on = value.includes(size);
            return (
              <button
                key={size}
                type="button"
                className={on ? `${styles.chip} ${styles.chipOn}` : styles.chip}
                aria-pressed={on}
                disabled={disabled}
                onClick={() => toggle(size)}
              >
                {chipLabel(size)}
              </button>
            );
          })}
        </div>
        {!showLarge ? (
          <button type="button" className={styles.more} disabled={disabled} onClick={() => setExpanded(true)}>
            More sizes (5-12)
          </button>
        ) : !largeSelected ? (
          <button type="button" className={styles.more} disabled={disabled} onClick={() => setExpanded(false)}>
            Fewer sizes
          </button>
        ) : null}
      </div>
      <p id={summaryId} className={styles.summary}>
        {acceptsSummary(value)}
      </p>
      {invalid.length > 0 ? (
        <p id={invalidId} className={styles.invalid}>
          {`Not a valid size, removed when you save: ${invalid.map((v) => String(v)).join(', ')}`}
        </p>
      ) : null}
    </div>
  );
}
