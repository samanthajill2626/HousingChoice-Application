// OrgKindChoice - which list a NEW organization goes on (spec D6, D17;
// R2-F3): two radios, Housing authority and Agency, in a group named "Kind",
// with NO default - a default would silently file a new employer under the
// wrong list. NewOrgDialog's organization mode and Settings' settle confirm
// ("Add as new" on a "Not on the list" organization value) use it; each
// keeps its add button disabled until a kind is chosen.
import { useId } from 'react';
import type { OrgKind } from '../../api/index.js';
import { KIND_FIELD_LABEL } from './orgCopy.js';
import styles from './OrgPicker.module.css';

const KINDS: readonly OrgKind[] = ['housing_authority', 'agency'];

export interface OrgKindChoiceProps {
  /** null = nothing chosen yet. */
  value: OrgKind | null;
  onChange: (kind: OrgKind) => void;
  disabled?: boolean;
}

export function OrgKindChoice({ value, onChange, disabled = false }: OrgKindChoiceProps): React.JSX.Element {
  const name = useId();
  return (
    <fieldset className={styles.kindChoice}>
      <legend className={styles.dialogLabel}>Kind</legend>
      {KINDS.map((kind) => (
        <label key={kind} className={styles.kindOption}>
          <input
            type="radio"
            name={name}
            value={kind}
            checked={value === kind}
            disabled={disabled}
            onChange={() => onChange(kind)}
          />
          {KIND_FIELD_LABEL[kind]}
        </label>
      ))}
    </fieldset>
  );
}
