// HousingAuthoritySelect - the /join "Housing authority" field
// (join-housing-authority spec D8). Presentational only: HousingFairIntake
// owns the list read, the chosen value and the not-listed recovery, and hands
// this to IntakeForm as its extraField (rendered after "Voucher size", before
// the consent box). It never fetches, so the keyed IntakeForm remount on
// "Sign up another person" reads nothing. The flyer never renders it.
//
// A NATIVE <select> (e2e drives it with getByLabel + selectOption by label).
// Option values: a listed authority's value is its EXACT stored name, so the
// page sends that string as-is and an e2e reads the plain name back with
// toHaveValue. "Not sure" is the empty string (it records no authority); the
// "Choose one" placeholder's value starts with a space. A stored organization
// name is always trimmed and never empty (checkNewName,
// app/src/lib/orgNames.ts), so neither can collide with a listed name.
//
// Accessibility: a real <label> (getByLabel-resolvable); the help text, plus
// the failed-list note when shown, describe the select via aria-describedby.
// Styling reuses IntakeForm's field classes so it matches the other fields.
import styles from './IntakeForm.module.css';

export const HOUSING_AUTHORITY_LABEL = 'Housing authority';
export const HOUSING_AUTHORITY_HELP = 'The organization that runs your voucher.';
export const NOT_SURE_LABEL = 'Not sure';
export const LOADING_LABEL = 'Loading...';
export const CHOOSE_ONE_LABEL = 'Choose one';
export const LIST_FAILED_NOTE = 'The list of housing authorities could not be loaded.';

/** D8: the default when this exact name is listed (else "Not sure"). */
export const DEFAULT_HOUSING_AUTHORITY = 'Atlanta Housing Authority';

/** "Not sure": records no authority. */
export const NOT_SURE_VALUE = '';
/** The "Choose one" placeholder shown after a housing_authority_not_listed
 *  refusal; send stays blocked while it is the value. */
export const CHOOSE_ONE_VALUE = ' choose-one';
const LOADING_VALUE = ' loading';

/** The public list's state, owned by HousingFairIntake. */
export type AuthorityList =
  | { kind: 'loading' }
  | { kind: 'ready'; names: readonly string[] }
  | { kind: 'failed' };

/** D8 default rule: "Atlanta Housing Authority" when that EXACT name is
 *  listed, else "Not sure". */
export function defaultAuthorityChoice(names: readonly string[]): string {
  return names.includes(DEFAULT_HOUSING_AUTHORITY) ? DEFAULT_HOUSING_AUTHORITY : NOT_SURE_VALUE;
}

/** What the sign-up sends: the chosen name only when the list is ready and
 *  the value is one of its names; undefined ("Not sure", "Choose one", a
 *  failed or loading list) sends no housingAuthority. */
export function authorityToSend(list: AuthorityList, value: string): string | undefined {
  if (list.kind !== 'ready') return undefined;
  return list.names.includes(value) ? value : undefined;
}

interface AuthorityOption {
  value: string;
  label: string;
}

function optionsFor(list: AuthorityList, value: string): { selected: string; options: AuthorityOption[] } {
  if (list.kind === 'loading') {
    return { selected: LOADING_VALUE, options: [{ value: LOADING_VALUE, label: LOADING_LABEL }] };
  }
  if (list.kind === 'failed') {
    return { selected: NOT_SURE_VALUE, options: [{ value: NOT_SURE_VALUE, label: NOT_SURE_LABEL }] };
  }
  const options: AuthorityOption[] = [];
  if (value === CHOOSE_ONE_VALUE) options.push({ value: CHOOSE_ONE_VALUE, label: CHOOSE_ONE_LABEL });
  for (const name of list.names) options.push({ value: name, label: name });
  options.push({ value: NOT_SURE_VALUE, label: NOT_SURE_LABEL });
  return { selected: value, options };
}

const SELECT_ID = 'intake-authority';
const HELP_ID = 'intake-authority-help';
const NOTE_ID = 'intake-authority-note';

export interface HousingAuthoritySelectProps {
  list: AuthorityList;
  /** A listed name, NOT_SURE_VALUE or CHOOSE_ONE_VALUE. Ignored while the
   *  list is loading or failed. */
  value: string;
  onChange: (value: string) => void;
  /** Disabled while a sign-up is sending (always disabled while loading). */
  disabled?: boolean;
}

export function HousingAuthoritySelect({
  list,
  value,
  onChange,
  disabled = false,
}: HousingAuthoritySelectProps): React.JSX.Element {
  const { selected, options } = optionsFor(list, value);
  const failed = list.kind === 'failed';
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={SELECT_ID}>
        {HOUSING_AUTHORITY_LABEL}
      </label>
      <select
        id={SELECT_ID}
        className={styles.input}
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || list.kind === 'loading'}
        aria-describedby={failed ? `${HELP_ID} ${NOTE_ID}` : HELP_ID}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <p id={HELP_ID} className={styles.help}>
        {HOUSING_AUTHORITY_HELP}
      </p>
      {failed && (
        <p id={NOTE_ID} className={styles.help}>
          {LIST_FAILED_NOTE}
        </p>
      )}
    </div>
  );
}
