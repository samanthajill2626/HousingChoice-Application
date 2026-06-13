// Reusable address pieces — so an address looks/edits the SAME everywhere
// (units today; tenant/contact addresses can adopt these later).
//
// - <AddressFields>: the editable form (5 labelled inputs) over an Address
//   value + onChange, built on the design-system Field/Input.
// - formatAddress / <AddressDisplay>: the read view. Both tolerate a legacy
//   plain-string address (a pre-contract dev record) by rendering it as-is,
//   so nothing crashes during the migration window.
import type { Address } from '../../api/index.js';
import { Field, Input } from '../../ui/index.js';
import styles from './records.module.css';

/** Format an Address (or a legacy plain string) for read views, omitting empty
 *  parts. e.g. "123 Main St, Apt 4 · Atlanta, GA 30303". Returns undefined when
 *  there is nothing to show (so callers can hide the row entirely). */
export function formatAddress(address: Address | string | undefined): string | undefined {
  if (address === undefined || address === null) return undefined;
  // Back-compat: an existing dev unit may have address as a plain string.
  if (typeof address === 'string') {
    const t = address.trim();
    return t.length > 0 ? t : undefined;
  }
  const clean = (s: string | undefined): string | undefined => {
    const t = (s ?? '').trim();
    return t.length > 0 ? t : undefined;
  };
  // Street line: "line1, line2" (e.g. "123 Main St, Apt 4").
  const street = [clean(address.line1), clean(address.line2)].filter(Boolean).join(', ');
  // Locality line: "city, ST zip" (e.g. "Atlanta, GA 30303").
  const cityState = [clean(address.city), clean(address.state)].filter(Boolean).join(', ');
  const locality = [cityState, clean(address.zip)].filter(Boolean).join(' ');
  const parts = [street, locality].filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Read view of an address. Renders the formatted address, or null when empty
 *  (caller decides whether to show a placeholder). */
export function AddressDisplay({ address }: { address: Address | string | undefined }): React.JSX.Element | null {
  const text = formatAddress(address);
  if (text === undefined) return null;
  return <span>{text}</span>;
}

export interface AddressFieldsProps {
  value: Address;
  onChange: (next: Address) => void;
  disabled?: boolean;
  /** Prefix for the generated label text / grouping (e.g. when more than one
   *  address lives on the same form). Defaults to "Address". */
  legend?: string;
}

/** Editable address: 5 labelled inputs (line 1, unit/apt #, city, state, zip).
 *  Controlled — emits a fresh Address on each keystroke. */
export function AddressFields({ value, onChange, disabled, legend = 'Address' }: AddressFieldsProps): React.JSX.Element {
  const set = (key: keyof Address) => (e: React.ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...value, [key]: e.target.value });
  };
  return (
    <fieldset className={styles.addressGroup}>
      <legend className={styles.addressLegend}>{legend}</legend>
      <Field label="Address line 1">
        {({ id }) => (
          <Input id={id} value={value.line1 ?? ''} disabled={disabled} autoComplete="address-line1" onChange={set('line1')} />
        )}
      </Field>
      <Field label="Unit / Apt #">
        {({ id }) => (
          <Input id={id} value={value.line2 ?? ''} disabled={disabled} autoComplete="address-line2" onChange={set('line2')} />
        )}
      </Field>
      <Field label="City">
        {({ id }) => (
          <Input id={id} value={value.city ?? ''} disabled={disabled} autoComplete="address-level2" onChange={set('city')} />
        )}
      </Field>
      <div className={styles.fieldRow}>
        <Field label="State">
          {({ id }) => (
            <Input
              id={id}
              value={value.state ?? ''}
              disabled={disabled}
              maxLength={2}
              autoCapitalize="characters"
              autoComplete="address-level1"
              placeholder="GA"
              onChange={set('state')}
            />
          )}
        </Field>
        <Field label="ZIP">
          {({ id }) => (
            <Input
              id={id}
              value={value.zip ?? ''}
              disabled={disabled}
              inputMode="numeric"
              autoComplete="postal-code"
              onChange={set('zip')}
            />
          )}
        </Field>
      </div>
    </fieldset>
  );
}
