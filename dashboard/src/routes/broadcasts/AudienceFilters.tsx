// AudienceFilters — the extensible audience-filter framework (the composer's
// centerpiece). v1 ships two criteria: a prominent VoucherSize chip control
// (multi-select, property-requirements D12: bedroomSizes of 0..4, the 4+ chip
// meaning 4 or more) and a "Housing authorities" multi-picker (any-of,
// matching-blast-rules D2); the disabled "+ Add
// filter" seam is the placeholder for future criteria (neighborhood,
// accessibility…). The always-on hard fences (opted-out - unreachable) are noted
// as informational text (the server enforces them — never sent by the client).
// A caption says who the filters include (matching-blast-rules D8), and a
// live reach - the rows that will start checked - carries an incomplete-list
// suffix when the read was truncated (D7).
//
// The voucher-size control pre-fills one chip per voucher size the property
// takes (its recorded sizes, else its beds - acceptedVoucherSizes; 4 and up on
// the 4+ chip) when composing from a unit, each shown with a "matches
// property" tag (staff press or unpress any chip, D12). The composer prefills
// the housing authorities from the
// property too (D3) and owns that prefill; this component shows its notes:
// the property's names that are not on the organization list, and why the
// prefill is held (a failed property load or list read), each with a Try
// again that re-runs only that read (AR44).
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
  bedroomSizesOfFilter,
  voucherSizesLabel,
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
/** property-requirements D12: the pre-fill note, followed by the chip labels. */
const PREFILL_SIZES_NOTE = 'Pre-filled to the voucher sizes this property takes: ';

/** D3 (AR44): a failed read the prefill is held on - the composer's notice
 *  and the retry of THAT read alone (the property load, or the organization
 *  list read), shown under the picker with a "Try again" button. */
export interface PrefillNotice {
  text: string;
  onRetry: () => void;
}

export interface AudienceFiltersProps {
  /** The current client-shape filter (contact_type fixed 'tenant'). */
  filter: AudienceFilter;
  onChange: (next: AudienceFilter) => void;
  /** The organization list behind the housing authorities picker. The
   *  composer reads it (useOrgList: once per mount, and again only by a failed
   *  read's Try again - AR44) and passes it down: its property prefill and its
   *  Preview gate read the same answer (matching-blast-rules D3). */
  orgList: OrgListView;
  /** property-requirements D12: the chips the composed-from property's voucher
   *  sizes press (prefillVoucherChips of acceptedVoucherSizes - 4 and up on
   *  the 4+ chip). Each carries the "matches property" tag and the pre-fill
   *  note names them. Undefined or empty when not unit-scoped or none maps. */
  propertyVoucherSizes?: readonly number[];
  /** D3: the property's accepted authorities that map to no list entry -
   *  "Not used (not on the organization list): <names>." */
  unusedAuthorities?: readonly string[];
  /** D3: the property lists authorities and NONE of them mapped - while no
   *  authority is selected the note adds "This blast is not limited by
   *  housing authority." */
  noAuthorityMapped?: boolean;
  /** D3 (AR44): why the prefill is held (a failed property load, a failed
   *  organization list read) - shown under the picker, each with a "Try
   *  again" that calls its own `onRetry`. */
  prefillNotices?: readonly PrefillNotice[];
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
  propertyVoucherSizes = [],
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
  // disables it - this list is read once per mount and again only by the hold
  // notice's Try again after a failed read (AR44), so a failed read here never
  // has one.
  const [typed, setTyped] = useState('');

  // property-requirements D12: the sizes on screen, read through the one
  // reader (an old-shape filter's one bedroomSize included).
  const sizes = bedroomSizesOfFilter(filter);

  /** D12: a chip toggles ITS size in or out of the list (kept ascending); the
   *  last one off is no size filter. Never the legacy bedroomSize. */
  function toggleSize(value: number): void {
    const nextSizes = sizes.includes(value)
      ? sizes.filter((s) => s !== value)
      : [...sizes, value].sort((a, b) => a - b);
    const next: AudienceFilter = { contact_type: 'tenant' };
    if (authorities.length > 0) next.housing_authorities = authorities;
    if (nextSizes.length > 0) next.bedroomSizes = nextSizes;
    onChange(next);
  }

  /** A pick (an exact list name, ADDED) or a removed chip: the only commits.
   *  An empty list is no housing authority filter (matching-blast-rules D2). */
  function setAuthorities(names: string[]): void {
    const next: AudienceFilter = { contact_type: 'tenant' };
    if (names.length > 0) next.housing_authorities = names;
    if (sizes.length > 0) next.bedroomSizes = sizes;
    onChange(next);
  }

  // D3 (AR44): the "Not used" names end with ONE period - none is added when
  // the last name already ends with one (fix-wave-2 review FW2-7).
  const unusedNames = unusedAuthorities.join(', ');
  const unusedNote = `${NOT_USED_PREFIX}${unusedNames}${unusedNames.endsWith('.') ? '' : '.'}`;

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
            const active = sizes.includes(choice.value);
            const isMatch = propertyVoucherSizes.includes(choice.value);
            return (
              <button
                key={choice.value}
                type="button"
                className={`${styles.chip} ${active ? styles.chipActive : ''}`.trim()}
                aria-pressed={active}
                disabled={disabled}
                onClick={() => toggleSize(choice.value)}
              >
                {choice.label}
                {isMatch ? <span className={styles.matchTag}> - matches property</span> : null}
              </button>
            );
          })}
        </div>
        {propertyVoucherSizes.length > 0 ? (
          <p className={styles.matchNote}>{`${PREFILL_SIZES_NOTE}${voucherSizesLabel(propertyVoucherSizes)}`}</p>
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
            {/* The names end with a period (spec revision 7, AR44); the
                not-limited sentence follows it. */}
            {unusedNote}
            {noAuthorityMapped && authorities.length === 0 ? NOT_LIMITED : null}
          </p>
        ) : null}
        {/* AR44: a hold notice is the one thing that says why Preview is
            disabled, so it is announced - an alert with its Try again inside,
            as the compose step's 503 notice is (fix-wave-2 review FW2-2). */}
        {prefillNotices.map((notice) => (
          <p key={notice.text} className={styles.prefillNotice} role="alert">
            {notice.text}{' '}
            <button type="button" className={styles.prefillRetry} onClick={notice.onRetry}>
              Try again
            </button>
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
