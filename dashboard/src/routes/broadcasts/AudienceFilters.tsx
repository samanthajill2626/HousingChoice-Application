// AudienceFilters — the extensible audience-filter framework (the composer's
// centerpiece). v1 ships two criteria: a prominent VoucherSize chip control
// (bedroomSize 0..4) and a HousingAuthority picker; the disabled "+ Add
// filter" seam is the placeholder for future criteria (neighborhood,
// accessibility…). The always-on hard fences (opted-out - unreachable) are noted
// as informational text (the server enforces them — never sent by the client).
// A live reach count + truncated warning surface the resolved audience size.
//
// The voucher-size control pre-fills from the property's beds when composing from
// a unit, shown with a "matches this N-bedroom property" tag (overridable — a
// 2-BR home may suit other sizes).
import { useId } from 'react';
import type { AudienceFilter } from '../../api/index.js';
import { OrgPicker } from '../orgs/OrgPicker.js';
import { HOUSING_AUTHORITY_KINDS, ORG_TYPED_NOT_A_FILTER, orgListLoadError } from '../orgs/orgCopy.js';
import { useOrgList } from '../orgs/useOrgList.js';
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
  /** A message for the housing authority filter, shown under its picker - the
   *  composer's "no longer on the list" after a 422 (spec 2026-10-06 D7). */
  authorityError?: string | null;
}

export function AudienceFilters({
  filter,
  onChange,
  propertyBeds,
  reachCount,
  reachPending,
  truncated,
  authorityError = null,
}: AudienceFiltersProps): React.JSX.Element {
  const uid = useId();
  // The housing authority list behind the picker (spec 2026-10-06 D7).
  const orgList = useOrgList();

  function pickSize(value: number): void {
    // Toggle: re-clicking the active chip clears the size narrower.
    const next: AudienceFilter = { contact_type: 'tenant' };
    if (filter.housing_authority !== undefined) next.housing_authority = filter.housing_authority;
    if (filter.bedroomSize !== value) next.bedroomSize = value; // (===) → cleared
    onChange(next);
  }

  /** A pick (an exact list name) or a removed chip (''): the only commits. */
  function setAuthority(name: string): void {
    const next: AudienceFilter = { contact_type: 'tenant' };
    if (filter.bedroomSize !== undefined) next.bedroomSize = filter.bedroomSize;
    if (name !== '') next.housing_authority = name;
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
      {/* No audience-base line: property sends are ALWAYS tenants (the filter is
          pinned to contact_type:'tenant'; the backend rejects anything else), so
          naming it here told the operator nothing they could act on. */}

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
                {isMatch ? <span className={styles.matchTag}> - matches property</span> : null}
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

      {/* Housing authority (spec 2026-10-06 D7): a picker over the stored
          list - names and spellings, NO add option. Only a pick or a removed
          chip changes the filter, so typing never recreates the draft - and
          the note under a field left holding text says so (R2-FE-6). A list
          that failed to load leaves this filter unsettable; the others work. */}
      <div className={styles.criterion}>
        <OrgPicker
          label="Housing authority"
          kinds={HOUSING_AUTHORITY_KINDS}
          entries={orgList.entries}
          loading={orgList.loading}
          disabled={orgList.error}
          value={filter.housing_authority ?? ''}
          onChange={setAuthority}
          pendingNote={ORG_TYPED_NOT_A_FILTER}
          error={authorityError ?? (orgList.error ? orgListLoadError(HOUSING_AUTHORITY_KINDS) : null)}
          placeholder="Any housing authority"
          labelClassName={styles.criterionLabel}
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
        Always excluded: <strong>opted-out</strong> - <strong>unreachable</strong>
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
