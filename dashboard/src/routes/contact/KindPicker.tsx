// KindPicker — unified "What kind of contact is this?" control.
// Segments: Tenant / Landlord / Property Manager / Other.
// Picking Tenant/Landlord resolves directly to {type, role:''}.
// Picking Property Manager is a preset: {type:'landlord', role:PM_ROLE}.
// Picking Other reveals a Role text input + a base-type sub-choice.
import { useEffect, useId, useState } from 'react';
import { type ContactType } from '../../api/index.js';
import { PM_ROLE } from './contactProfile.js';
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

/** True when the value is exactly the Property Manager preset (landlord + PM_ROLE),
 *  regardless of how the user arrived there (preset click OR Other→role→base). */
function isPmPresetValue(value: KindPickerValue): boolean {
  return value.type === 'landlord' && value.role === PM_ROLE;
}

/** Derive which primary segment button should appear "active". */
function activePrimarySegment(
  value: KindPickerValue,
  otherSelected: boolean,
): PrimarySegment | null {
  if (isPmPresetValue(value)) return 'pm';
  const inOtherMode = otherSelected || value.role.trim() !== '';
  if (inOtherMode) return 'other';
  if (value.type === 'tenant') return 'tenant';
  if (value.type === 'landlord') return 'landlord';
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
  // Adjusts a local UI flag to an EXTERNAL prop change (controlled rehydration) —
  // a legitimate effect, not the cascading-render smell the rule targets.
  useEffect(() => {
    if (value.type !== null && value.role.trim() === '') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOtherSelected(false);
    }
  }, [value.type, value.role]);

  // Fix 5: use useId() for stable, instance-unique ids
  const uid = useId();
  const datalistId = `${uid}-role-suggestions`;
  const roleInputId = `${uid}-role`;

  const suggestions = roleSuggestions ?? [];
  const isPmPreset = isPmPresetValue(value);
  const inOtherMode = otherSelected || (value.role.trim() !== '' && !isPmPreset);
  const active = activePrimarySegment(value, otherSelected);

  function handleSegment(seg: PrimarySegment): void {
    if (seg === 'other') {
      if (inOtherMode) {
        // Already in Other mode — keep type+role as-is (don't wipe a chosen base).
        onChange({ type: value.type, role: value.role });
      } else {
        setOtherSelected(true);
        onChange({ type: null, role: value.role });
      }
    } else if (seg === 'pm') {
      // Property Manager preset: a custom kind on the landlord base.
      setOtherSelected(false);
      onChange({ type: 'landlord', role: PM_ROLE });
    } else {
      setOtherSelected(false);
      const typeMap: Record<'tenant' | 'landlord', ContactType> = {
        tenant: 'tenant',
        landlord: 'landlord',
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
                  ? 'Property Manager'
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
