// TaggedField / TaggedCheckbox / TaggedGroupLabel - one property-form field
// with its "On flyer" / "Staff only" tag (spec 2026-10-20 D10). The visible
// <label> names the control; the tag sits OUTSIDE the <label> element and is
// tied to the control by aria-describedby, so the field's accessible name -
// and every getByLabel selector - stays the label alone. Shared by
// ListingEditForm, UnitCreateForm and RequirementsFields (and, through
// RequirementsFields, the landlord form).
import { useId } from 'react';
import { FlyerTag, type FlyerAudience } from './FlyerTag.js';
import type { FlyerVisibility } from './requirements.js';
import formStyles from './ListingEditForm.module.css';
import styles from './TaggedField.module.css';

/** D10: under each public free-text box (pets details, pet fee, tenant-paid
 *  utilities, accessibility, lease terms). */
export const PUBLIC_FLYER_NOTE = 'Tenants see this on the public flyer.';

/** The props a TaggedField hands its control (spread them onto it). */
export interface TaggedControlProps {
  id: string;
  'aria-describedby': string;
}

export interface TaggedFieldProps {
  label: string;
  visibility: FlyerVisibility;
  audience: FlyerAudience;
  /** Show PUBLIC_FLYER_NOTE under the control (and describe the control by it). */
  publicNote?: boolean;
  /** The root class; defaults to the form's stacked `.field`. */
  className?: string;
  children: (control: TaggedControlProps) => React.ReactNode;
}

export function TaggedField({
  label,
  visibility,
  audience,
  publicNote = false,
  className,
  children,
}: TaggedFieldProps): React.JSX.Element {
  const uid = useId();
  const controlId = `${uid}-control`;
  const tagId = `${uid}-tag`;
  const noteId = `${uid}-note`;
  return (
    <div className={className ?? formStyles.field}>
      <div className={styles.labelRow}>
        <label htmlFor={controlId} className={formStyles.label}>
          {label}
        </label>
        <FlyerTag id={tagId} visibility={visibility} audience={audience} />
      </div>
      {children({ id: controlId, 'aria-describedby': publicNote ? `${tagId} ${noteId}` : tagId })}
      {publicNote ? (
        <p id={noteId} className={styles.publicNote}>
          {PUBLIC_FLYER_NOTE}
        </p>
      ) : null}
    </div>
  );
}

export interface TaggedCheckboxProps {
  label: string;
  visibility: FlyerVisibility;
  audience: FlyerAudience;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** A checkbox field (label text after the box, as the forms already draw one),
 *  with its tag after the <label> element. */
export function TaggedCheckbox({
  label,
  visibility,
  audience,
  checked,
  onChange,
  disabled = false,
}: TaggedCheckboxProps): React.JSX.Element {
  const uid = useId();
  const tagId = `${uid}-tag`;
  return (
    <div className={styles.checkRow}>
      <label className={`${formStyles.field} ${formStyles.checkField}`}>
        <input
          className={formStyles.checkbox}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={tagId}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className={formStyles.label}>{label}</span>
      </label>
      <FlyerTag id={tagId} visibility={visibility} audience={audience} />
    </div>
  );
}

export interface TaggedGroupLabelProps {
  label: string;
  visibility: FlyerVisibility;
  audience: FlyerAudience;
  /** The tag's id - every control of the group puts it in its aria-describedby. */
  tagId: string;
}

/** A field GROUP's visible label with its tag (the Address parts, whose own
 *  labels are visually hidden). */
export function TaggedGroupLabel({ label, visibility, audience, tagId }: TaggedGroupLabelProps): React.JSX.Element {
  return (
    <div className={styles.labelRow}>
      <span className={formStyles.label}>{label}</span>
      <FlyerTag id={tagId} visibility={visibility} audience={audience} />
    </div>
  );
}
