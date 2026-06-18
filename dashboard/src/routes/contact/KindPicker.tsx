// KindPicker — unified "What kind of contact is this?" control.
// Segments: Tenant / Landlord / Property mgr / Other.
// Picking Tenant/Landlord/PM resolves directly to {type, role:''}.
// Picking Other reveals a Role text input + a base-type sub-choice.
import { useEffect, useId, useState } from 'react';
import { type ContactType } from '../../api/index.js';
import styles from './KindPicker.module.css';

export interface KindPickerValue {
  type: ContactType | null;
  role: string;
}

export interface KindPickerProps {
  value: KindPickerValue;
  onChange: (v: KindPickerValue) => void;
  roleSuggestions?: string[];
}

type PrimarySegment = 'tenant' | 'landlord' | 'pm' | 'other';

/** Derive which primary segment button should appear "active". */
function activePrimarySegment(
  value: KindPickerValue,
  otherSelected: boolean,
): PrimarySegment | null {
  const inOtherMode = otherSelected || value.role.trim() !== '';
  if (inOtherMode) return 'other';
  if (value.type === 'tenant') return 'tenant';
  if (value.type === 'landlord') return 'landlord';
  if (value.type === 'pm') return 'pm';
  return null;
}

export function KindPicker({
  value,
  onChange,
  roleSuggestions,
}: KindPickerProps): React.JSX.Element {
  // otherSelected tracks whether the user explicitly clicked Other.
  // We also treat a non-empty role as implying Other mode (for edit/re-hydration).
  const [otherSelected, setOtherSelected] = useState(false);

  // Fix 1: Clear otherSelected when the parent rehydrates to a resolved standard kind
  // (non-null type with empty role = plain Tenant/Landlord/PM selection).
  useEffect(() => {
    if (value.type !== null && value.role.trim() === '') {
      setOtherSelected(false);
    }
  }, [value.type, value.role]);

  // Fix 5: use useId() for stable, instance-unique ids
  const uid = useId();
  const datalistId = `${uid}-role-suggestions`;
  const roleInputId = `${uid}-role`;

  const suggestions = roleSuggestions ?? [];
  const inOtherMode = otherSelected || value.role.trim() !== '';
  const active = activePrimarySegment(value, otherSelected);

  function handleSegment(seg: PrimarySegment): void {
    if (seg === 'other') {
      // Fix 2: when already in Other mode, preserve the current type+role (no-op).
      // Only reset type to null when entering Other from a plain selection.
      if (inOtherMode) {
        // Already in Other mode — keep everything as-is.
        onChange({ type: value.type, role: value.role });
      } else {
        setOtherSelected(true);
        onChange({ type: null, role: value.role });
      }
    } else {
      setOtherSelected(false);
      const typeMap: Record<Exclude<PrimarySegment, 'other'>, ContactType> = {
        tenant: 'tenant',
        landlord: 'landlord',
        pm: 'pm',
      };
      onChange({ type: typeMap[seg], role: '' });
    }
  }

  function handleRoleChange(role: string): void {
    onChange({ type: value.type, role });
  }

  function handleBaseType(baseType: ContactType): void {
    onChange({ type: baseType, role: value.role });
  }

  return (
    <div className={styles.picker}>
      {/* Primary segment bar */}
      <div className={styles.segmentBar} role="group" aria-label="Contact kind">
        {(['tenant', 'landlord', 'pm', 'other'] as PrimarySegment[]).map((seg) => {
          const label =
            seg === 'tenant'
              ? 'Tenant'
              : seg === 'landlord'
                ? 'Landlord'
                : seg === 'pm'
                  ? 'Property mgr'
                  : 'Other';
          return (
            <button
              key={seg}
              type="button"
              className={`${styles.segment} ${active === seg ? styles.segmentActive : ''}`}
              onClick={() => handleSegment(seg)}
              aria-pressed={active === seg}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Other sub-UI */}
      {inOtherMode && (
        <div className={styles.otherPanel}>
          {suggestions.length > 0 && (
            <datalist id={datalistId}>
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}

          <label className={styles.roleLabel} htmlFor={roleInputId}>
            Role
          </label>
          <input
            id={roleInputId}
            type="text"
            className={styles.roleInput}
            value={value.role}
            onChange={(e) => handleRoleChange(e.target.value)}
            placeholder="e.g. Case worker, Social worker…"
            list={suggestions.length > 0 ? datalistId : undefined}
          />

          {/* Base-type sub-choice */}
          <div
            className={styles.subSegmentBar}
            role="group"
            aria-label="Base contact type"
          >
            {(
              [
                ['tenant', 'Tenant'],
                ['landlord', 'Landlord'],
                ['pm', 'Property mgr'],
              ] as [ContactType, string][]
            ).map(([t, label]) => (
              <button
                key={t}
                type="button"
                className={`${styles.segment} ${value.type === t ? styles.segmentActive : ''}`}
                onClick={() => handleBaseType(t)}
                aria-pressed={value.type === t}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
