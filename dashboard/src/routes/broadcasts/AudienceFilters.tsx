// AudienceFilters — the extensible audience-filter framework (the composer's
// centerpiece). v1 ships two criteria: a prominent VoucherSize chip control
// (bedroomSize 0..4) and a "Housing authorities" multi-picker (any-of,
// matching-blast-rules D2); the disabled "+ Add
// filter" seam is the placeholder for future criteria (neighborhood,
// accessibility…). The always-on hard fences (opted-out - unreachable) are noted
// as informational text (the server enforces them — never sent by the client).
// A caption says who the filters include (matching-blast-rules D8), and a
// live reach - the rows that will start checked - carries an incomplete-list
// suffix when the read was truncated (D7).
//
// The voucher-size control pre-fills with the voucher size the property takes
// (its recorded size, else its beds - acceptedVoucherSizes) when composing from
// a unit, shown with a "matches property" tag (overridable - a home may suit
// other sizes). The composer prefills the housing authorities from the
// property too (D3) and owns that prefill; this component shows its notes:
// the property's names that are not on the organization list, and why nothing
// was filled in (a failed property load or list read).
import { useId, useState } from 'react';
import type { AudienceFilter } from '../../api/index.js';
import { OrgPicker } from '../orgs/OrgPicker.js';
import {
  HOUSING_AUTHORITY_KINDS,
  ORG_TYPED_NOT_A_FILTER,
  orgListLoadError,
  orgListUnknown,
  type OrgListView,
} from '../orgs/orgCopy.js';
import {
  VOUCHER_SIZE_CHOICES,
  bedroomPhrase,
} from './broadcastFormat.js';
import styles from './AudienceFilters.module.css';

/** matching-blast-rules D8 caption: who the filters include. The middle
 *  sentence shows only while a housing authority is selected. */
const CAPTION_STATUS = 'Only tenants in Onboarding or Searching are included.';
const CAPTION_AUTHORITY =
  'While a housing authority is selected, tenants whose housing authority is missing or not on the organization list are left out.';
const CAPTION_BY_HAND = 'Add any other tenant by hand when you review recipients.';
/** D3: the property's accepted authorities that map to no list entry. */
const NOT_USED_PREFIX = 'Not used (not on the organization list): ';
/** D3: none of the property's authorities mapped (and none is selected). */
const NOT_LIMITED = ' This blast is not limited by housing authority.';
/** D7: the reach line's suffix while the audience read was truncated. */
const REACH_INCOMPLETE = ' - the list is incomplete';

export interface AudienceFiltersProps {
  /** The current client-shape filter (contact_type fixed 'tenant'). */
  filter: AudienceFilter;
  onChange: (next: AudienceFilter) => void;
  /** The organization list behind the housing authorities picker. The
   *  composer reads it ONCE (useOrgList) and passes it down: its property
   *  prefill and its Preview gate read the same answer (matching-blast-rules D3). */
  orgList: OrgListView;
  /** The voucher size the composed-from property takes (its recorded size, else
   *  its beds - acceptedVoucherSizes); drives the "matches property" tag on the
   *  matching chip. Undefined when not unit-scoped or nothing is recorded. */
  propertyVoucherSize?: number;
  /** D3: the property's accepted authorities that map to no list entry -
   *  "Not used (not on the organization list): <names>". */
  unusedAuthorities?: readonly string[];
  /** D3: the property lists authorities and NONE of them mapped - while no
   *  authority is selected the note adds "This blast is not limited by
   *  housing authority." */
  noAuthorityMapped?: boolean;
  /** D3: why the prefill filled nothing in (a failed property load, a failed
   *  organization list read) - shown under the picker. */
  prefillNotices?: readonly string[];
  /** The live reach: how many review rows will start checked
   *  (matching-blast-rules D8), or undefined while the debounced estimate is
   *  pending / not yet computed / not computable (a rules read failed). */
  reachCount?: number;
  /** True while the reach estimate is being (re)computed. */
  reachPending: boolean;
  /** True when the reach estimate hit the page/recipient cap (incomplete). */
  truncated: boolean;
  /** A message for the housing authority filter, shown under its picker - the
   *  composer's "no longer on the list" after a 422 (spec 2026-10-06 D7). */
  authorityError?: string | null;
  /** The text typed in the housing authority picker that is not a pick, on
   *  every change ('' after a pick, an emptied field or an unmount). It is
   *  never a filter (D7), so the composer holds Preview back while there is
   *  any (code review R2-FE-3). */
  onAuthorityTextChange?: (text: string) => void;
  /** True while a Preview is in flight: the audience is frozen - no voucher
   *  chip, pick, typing or chip removal - because the candidates it returns
   *  belong to the draft it previewed (code review R3-FE-1). */
  disabled?: boolean;
}

export function AudienceFilters({
  filter,
  onChange,
  orgList,
  propertyVoucherSize,
  unusedAuthorities = [],
  noAuthorityMapped = false,
  prefillNotices = [],
  reachCount,
  reachPending,
  truncated,
  authorityError = null,
  onAuthorityTextChange,
  disabled = false,
}: AudienceFiltersProps): React.JSX.Element {
  const uid = useId();
  // The housing authority list behind the picker (spec 2026-10-06 D7) is the
  // composer's `orgList` prop (matching-blast-rules D3).
  const authorities = filter.housing_authorities ?? [];
  // The picker's typed text: while it holds any, a list that failed to load
  // leaves the field enabled so the text can still be cleared - it holds
  // Preview back, and a disabled field could never let it go (R2-FE-3). The
  // forms keep a picker holding text usable the same way (useTypedOrgText,
  // R3-FE-3): nothing ever waits on a field staff cannot use. An empty field
  // follows their rule too (R4-3): only a failed read with no list in hand
  // disables it - this list is read once per mount, so its failed read never
  // has one.
  const [typed, setTyped] = useState('');

  function pickSize(value: number): void {
    // Toggle: re-clicking the active chip clears the size narrower.
    const next: AudienceFilter = { contact_type: 'tenant' };
    if (authorities.length > 0) next.housing_authorities = authorities;
    if (filter.bedroomSize !== value) next.bedroomSize = value; // (===) → cleared
    onChange(next);
  }

  /** A pick (an exact list name, ADDED) or a removed chip: the only commits.
   *  An empty list is no housing authority filter (matching-blast-rules D2). */
  function setAuthorities(names: string[]): void {
    const next: AudienceFilter = { contact_type: 'tenant' };
    if (names.length > 0) next.housing_authorities = names;
    if (filter.bedroomSize !== undefined) next.bedroomSize = filter.bedroomSize;
    onChange(next);
  }

  // The chip that matches the property's voucher size (capped at the top "4+" chip).
  const matchedChipValue =
    propertyVoucherSize !== undefined ? Math.max(0, Math.min(4, propertyVoucherSize)) : undefined;

  return (
    <section className={styles.filters} aria-labelledby={`${uid}-heading`}>
      <h2 id={`${uid}-heading`} className={styles.heading}>
        Audience
      </h2>
      {/* No audience-base line: the FILTER reaches tenants only (pinned to
          contact_type:'tenant'; the backend rejects anything else) - a partner
          joins a share only as a hand-picked seed (spec 2026-10-06 D20). Which
          tenants it reaches (Onboarding or Searching, matching-blast-rules D1)
          is the caption's job, under the filters (D8). */}

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
                disabled={disabled}
                onClick={() => pickSize(choice.value)}
              >
                {choice.label}
                {isMatch ? <span className={styles.matchTag}> - matches property</span> : null}
              </button>
            );
          })}
        </div>
        {matchedChipValue !== undefined && propertyVoucherSize !== undefined ? (
          <p className={styles.matchNote}>
            Pre-filled to the {bedroomPhrase(propertyVoucherSize)} voucher this property takes -
            change it to reach other sizes.
          </p>
        ) : null}
      </div>

      {/* Housing authorities (spec 2026-10-06 D7; matching-blast-rules D2): a
          MULTI-picker over the stored list - names and spellings, NO add
          option; a tenant matches when their housing authority is any member.
          Only a pick or a removed chip changes the filter, so typing never
          recreates the draft - and the note under a field left holding text
          says so (R2-FE-6), and the composer holds Preview back until it is
          picked or cleared (R2-FE-3). A list that failed to load leaves this
          filter unsettable; the others work. Under it: the property
          prefill's notes (D3). */}
      <div className={styles.criterion}>
        <OrgPicker
          multiple
          label="Housing authorities"
          kinds={HOUSING_AUTHORITY_KINDS}
          entries={orgList.entries}
          loading={orgListUnknown(orgList)}
          disabled={disabled || (orgList.error && orgListUnknown(orgList) && typed.trim() === '')}
          value={authorities}
          onChange={setAuthorities}
          onPendingTextChange={(text) => {
            setTyped(text);
            onAuthorityTextChange?.(text);
          }}
          pendingNote={ORG_TYPED_NOT_A_FILTER}
          error={authorityError ?? (orgList.error ? orgListLoadError(HOUSING_AUTHORITY_KINDS) : null)}
          placeholder="Any housing authority"
          labelClassName={styles.criterionLabel}
        />
        {unusedAuthorities.length > 0 ? (
          <p className={styles.matchNote}>
            {NOT_USED_PREFIX}
            {unusedAuthorities.join(', ')}
            {noAuthorityMapped && authorities.length === 0 ? NOT_LIMITED : null}
          </p>
        ) : null}
        {prefillNotices.map((notice) => (
          <p key={notice} className={styles.prefillNotice}>
            {notice}
          </p>
        ))}
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

      {/* matching-blast-rules D8: who the filters include - the middle
          sentence only while a housing authority is selected. */}
      <p className={styles.caption}>
        {authorities.length > 0
          ? `${CAPTION_STATUS} ${CAPTION_AUTHORITY} ${CAPTION_BY_HAND}`
          : `${CAPTION_STATUS} ${CAPTION_BY_HAND}`}
      </p>

      {/* Live reach. */}
      <div className={styles.reach} role="status" aria-live="polite">
        {reachPending ? (
          <span className={styles.reachPending}>Estimating reach…</span>
        ) : reachCount !== undefined ? (
          <span className={styles.reachCount}>
            Reaches <strong>{reachCount}</strong> recipient{reachCount === 1 ? '' : 's'}
          </span>
        ) : (
          <span className={styles.reachPending}>Reach estimate unavailable</span>
        )}
        {truncated ? <span className={styles.truncated}>{REACH_INCOMPLETE}</span> : null}
      </div>
    </section>
  );
}
