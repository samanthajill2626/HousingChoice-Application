// AudienceFilters — the extensible audience-filter framework (the composer's
// centerpiece). v1 ships two criteria: a prominent VoucherSize chip control
// (bedroomSize 0..4) and a HousingAuthority text input; the disabled "+ Add
// filter" seam is the placeholder for future criteria (neighborhood,
// accessibility…). The always-on hard fences (opted-out · unreachable) are noted
// as informational text (the server enforces them — never sent by the client).
// A live reach count + truncated warning surface the resolved audience size.
//
// The voucher-size control pre-fills from the property's beds when composing from
// a unit, shown with a "matches this N-bedroom property" tag (overridable — a
// 2-BR home may suit other sizes).
import { useId } from 'react';
import type { AudienceFilter } from '../../api/index.js';
import {
  VOUCHER_SIZE_CHOICES,
  bedroomPhrase,
} from './broadcastFormat.js';
import styles from './AudienceFilters.module.css';

export interface AudienceFiltersProps {
  /** The current client-shape filter (contact_type fixed 'tenant'). */
  filter: AudienceFilter;
  onChange: (next: AudienceFilter) => void;
  /** The composed-from property's beds (drives the "matches this N-bedroom
   *  property" tag on the matching chip), or undefined when not unit-scoped. */
  propertyBeds?: number;
  /** The live reach estimate (resolved audience size), or undefined while the
   *  debounced estimate is pending / not yet computed. */
  reachCount?: number;
  /** True while the reach estimate is being (re)computed. */
  reachPending: boolean;
  /** True when the reach estimate hit the page/recipient cap (incomplete). */
  truncated: boolean;
}

export function AudienceFilters({
  filter,
  onChange,
  propertyBeds,
  reachCount,
  reachPending,
  truncated,
}: AudienceFiltersProps): React.JSX.Element {
  const uid = useId();
  const authorityId = `${uid}-authority`;

  function pickSize(value: number): void {
    // Toggle: re-clicking the active chip clears the size narrower.
    const next: AudienceFilter = { contact_type: 'tenant' };
    if (filter.housing_authority !== undefined) next.housing_authority = filter.housing_authority;
    if (filter.bedroomSize !== value) next.bedroomSize = value; // (===) → cleared
    onChange(next);
  }

  function setAuthority(raw: string): void {
    const next: AudienceFilter = { contact_type: 'tenant' };
    if (filter.bedroomSize !== undefined) next.bedroomSize = filter.bedroomSize;
    if (raw.trim().length > 0) next.housing_authority = raw;
    onChange(next);
  }

  // The chip that matches the property's beds (capped at the top "4+" chip).
  const matchedChipValue =
    propertyBeds !== undefined ? Math.max(0, Math.min(4, propertyBeds)) : undefined;

  return (
    <section className={styles.filters} aria-labelledby={`${uid}-heading`}>
      <h2 id={`${uid}-heading`} className={styles.heading}>
        Audience
      </h2>
      <p className={styles.audienceKind}>Tenants</p>

      {/* Voucher size — the prominent criterion. */}
      <div className={styles.criterion}>
        <span className={styles.criterionLabel}>Voucher size</span>
        <div className={styles.chips} role="group" aria-label="Voucher size">
          {VOUCHER_SIZE_CHOICES.map((choice) => {
            const active = filter.bedroomSize === choice.value;
            const isMatch = matchedChipValue === choice.value;
            return (
              <button
                key={choice.value}
                type="button"
                className={`${styles.chip} ${active ? styles.chipActive : ''}`.trim()}
                aria-pressed={active}
                onClick={() => pickSize(choice.value)}
              >
                {choice.label}
                {isMatch ? <span className={styles.matchTag}> · matches property</span> : null}
              </button>
            );
          })}
        </div>
        {matchedChipValue !== undefined && propertyBeds !== undefined ? (
          <p className={styles.matchNote}>
            Pre-filled to match this {bedroomPhrase(propertyBeds)} property — change it to reach
            other sizes.
          </p>
        ) : null}
      </div>

      {/* Housing authority. */}
      <div className={styles.criterion}>
        <label className={styles.criterionLabel} htmlFor={authorityId}>
          Housing authority
        </label>
        <input
          id={authorityId}
          type="text"
          className={styles.input}
          value={filter.housing_authority ?? ''}
          placeholder="Any housing authority"
          autoComplete="off"
          onChange={(e) => setAuthority(e.target.value)}
        />
      </div>

      {/* The extensibility seam — disabled in v1. */}
      <button
        type="button"
        className={styles.addFilter}
        disabled
        title="More audience criteria (neighborhood, accessibility, income…) are coming soon."
      >
        + Add filter
      </button>

      <p className={styles.excludedNote}>
        Always excluded: <strong>opted-out</strong> · <strong>unreachable</strong>
      </p>

      {/* Live reach. */}
      <div className={styles.reach} role="status" aria-live="polite">
        {reachPending ? (
          <span className={styles.reachPending}>Estimating reach…</span>
        ) : reachCount !== undefined ? (
          <span className={styles.reachCount}>
            Reaches <strong>{reachCount}</strong> tenant{reachCount === 1 ? '' : 's'}
          </span>
        ) : (
          <span className={styles.reachPending}>Reach estimate unavailable</span>
        )}
        {truncated ? (
          <span className={styles.truncated}>
            {' '}
            — list is capped; narrow the size or housing authority for a complete audience
          </span>
        ) : null}
      </div>
    </section>
  );
}
