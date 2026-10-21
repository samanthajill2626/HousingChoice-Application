// RequirementsFields - the shared Requirements section (spec 2026-10-20 D1,
// D9, D10; plan 2.6) of the New and Edit property forms and the landlord edit
// form. The eight items in their four groups, every field tagged from the
// registry ("On flyer" / "Staff only" on a property form, "On property flyers"
// / "Staff only" on the landlord form), the public free-text boxes noted on a
// property form (never on the landlord form - planner ruling PR-2), and
// the two alternatives D1 couples: "One month's rent" clears and disables the
// fixed amount; "No application fee" records 0 and disables the amount (its
// own form flag, code review R2D-5 - never read off the amount text).
// Controlled: `values` is keyed by UNIT key (the landlord form maps req_ keys
// in and out, requirementForm.ts) and every change reports the whole next
// value. The host renders the section heading ("Requirements", or the landlord
// fieldset's "Requirements / Qualifications").
import { Fragment } from 'react';
import { TOUR_TYPE_LABELS, type TourType } from '../../api/index.js';
import type { FlyerAudience } from './FlyerTag.js';
import { NO_APPLICATION_FEE_FLAG, noApplicationFeeChecked, type RequirementFormValues } from './requirementForm.js';
import { REQUIREMENT_ITEMS, type RequirementField, type RequirementGroup, type RequirementItem } from './requirements.js';
import { TaggedCheckbox, TaggedField } from './TaggedField.js';
import formStyles from './ListingEditForm.module.css';
import styles from './RequirementsFields.module.css';

export type { RequirementFormValues } from './requirementForm.js';

export interface RequirementsFieldsProps {
  values: RequirementFormValues;
  onChange: (next: RequirementFormValues) => void;
  audience: FlyerAudience;
  disabled?: boolean;
}

const GROUPS: readonly RequirementGroup[] = ['Screening', 'Pets', 'Move-in costs', 'Touring'];

/** Free-text fields drawn as a textarea, with their rows. Tour process keeps the
 *  textarea it had (a one-line input would strip stored line breaks). */
const MULTILINE_ROWS: Readonly<Record<string, number>> = { qualifications: 3, tour_process: 2 };

/** The placeholder the property forms already showed for the pets text. */
const PLACEHOLDERS: Readonly<Record<string, string>> = { pets: 'e.g. Cats only' };

export function RequirementsFields({
  values,
  onChange,
  audience,
  disabled = false,
}: RequirementsFieldsProps): React.JSX.Element {
  const text = (key: string): string => {
    const v = values[key];
    return typeof v === 'string' ? v : '';
  };
  const checked = (key: string): boolean => values[key] === true;
  const set = (key: string, value: string | boolean): void => onChange({ ...values, [key]: value });
  // Code review R2D-5: "No application fee" is its own flag - set only by its
  // checkbox (it starts checked for a stored / prefilled 0) - never derived
  // from the amount text, so a partial amount reading 0 neither ticks it nor
  // disables the box under the caret.
  const noFee = noApplicationFeeChecked(values);
  const oneMonth = checked('deposit_one_month');

  function renderField(field: RequirementField): React.ReactNode {
    if (field.kind === 'checkbox') {
      return (
        <TaggedCheckbox
          key={field.key}
          label={field.label}
          visibility={field.flyer}
          audience={audience}
          checked={checked(field.key)}
          disabled={disabled}
          onChange={(on) => {
            // D1: "One month's rent" and a fixed amount are alternatives.
            if (field.key === 'deposit_one_month' && on) onChange({ ...values, deposit_one_month: true, deposit: '' });
            else set(field.key, on);
          }}
        />
      );
    }
    if (field.kind === 'money') {
      const isFee = field.key === 'application_fee';
      return (
        <Fragment key={field.key}>
          {isFee ? (
            <TaggedCheckbox
              label="No application fee"
              visibility={field.flyer}
              audience={audience}
              checked={noFee}
              disabled={disabled}
              onChange={(on) =>
                onChange({ ...values, application_fee: on ? '0' : '', [NO_APPLICATION_FEE_FLAG]: on })
              }
            />
          ) : null}
          <TaggedField label={field.label} visibility={field.flyer} audience={audience}>
            {(control) => (
              <input
                {...control}
                className={formStyles.input}
                type="number"
                min={0}
                // Planner ruling PR2-3: any amount, cents included (D1 money is
                // any finite number >= 0) - a stored or landlord-prefilled
                // 1250.5 must never trip native step validation and silently
                // block Save / Create.
                step="any"
                value={text(field.key)}
                disabled={disabled || (isFee ? noFee : oneMonth)}
                onChange={(e) =>
                  // R2D-5: an amount edit pins the flag as it stands, so the
                  // typed text never decides the checkbox.
                  isFee
                    ? onChange({ ...values, [field.key]: e.target.value, [NO_APPLICATION_FEE_FLAG]: noFee })
                    : set(field.key, e.target.value)
                }
              />
            )}
          </TaggedField>
        </Fragment>
      );
    }
    if (field.kind === 'tour_type') {
      return (
        <TaggedField key={field.key} label={field.label} visibility={field.flyer} audience={audience}>
          {(control) => (
            <select
              {...control}
              className={formStyles.input}
              value={text(field.key)}
              disabled={disabled}
              onChange={(e) => set(field.key, e.target.value)}
            >
              <option value="">Not set</option>
              {(Object.keys(TOUR_TYPE_LABELS) as TourType[]).map((t) => (
                <option key={t} value={t}>
                  {TOUR_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          )}
        </TaggedField>
      );
    }
    const rows = MULTILINE_ROWS[field.key];
    return (
      <TaggedField
        key={field.key}
        label={field.label}
        visibility={field.flyer}
        audience={audience}
        // D10: the note is the PROPERTY forms' - a landlord value reaches a
        // flyer only once it is copied to a property (D9; planner ruling PR-2,
        // code review PC-1).
        publicNote={audience === 'property' && field.kind === 'text' && field.flyer === 'on_flyer'}
      >
        {(control) =>
          rows !== undefined ? (
            <textarea
              {...control}
              className={formStyles.textarea}
              rows={rows}
              value={text(field.key)}
              disabled={disabled}
              onChange={(e) => set(field.key, e.target.value)}
            />
          ) : (
            <input
              {...control}
              className={formStyles.input}
              value={text(field.key)}
              placeholder={PLACEHOLDERS[field.key]}
              disabled={disabled}
              autoComplete="off"
              onChange={(e) => set(field.key, e.target.value)}
            />
          )
        }
      </TaggedField>
    );
  }

  function renderItem(item: RequirementItem): React.ReactNode {
    const fields = item.fields.map(renderField);
    // A multi-field item named apart from its group (Evictions, Deposit) is its
    // own sub-group, so "Fixed amount" reads as the deposit's.
    if (item.fields.length > 1 && item.label !== item.group) {
      return (
        <fieldset key={item.id} className={styles.item}>
          <legend className={styles.itemHeading}>{item.label}</legend>
          {fields}
        </fieldset>
      );
    }
    return <Fragment key={item.id}>{fields}</Fragment>;
  }

  return (
    <div className={styles.requirements}>
      {GROUPS.map((group) => (
        <fieldset key={group} className={styles.group}>
          <legend className={styles.groupHeading}>{group}</legend>
          {REQUIREMENT_ITEMS.filter((item) => item.group === group).map((item) => renderItem(item))}
        </fieldset>
      ))}
    </div>
  );
}
