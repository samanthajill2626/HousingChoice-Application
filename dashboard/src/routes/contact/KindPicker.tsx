// KindPicker — unified "What kind of contact is this?" control.
// Segments: Tenant / Landlord / Partner / Property Manager / Other.
// Picking Tenant/Landlord/Partner resolves directly to {type, role:''} (partner
// is a first-class ContactType, not a preset).
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

type PrimarySegment = 'tenant' | 'landlord' | 'partner' | 'pm' | 'other';

/** The two record shapes a custom kind can be based on. The description spells
 *  out the data shape (fields + behaviour) the new kind inherits, so picking one
 *  is an informed choice, not a mystery toggle. */
const BASE_OPTIONS: { type: 'tenant' | 'landlord'; title: string; desc: string }[] = [
  {
    type: 'tenant',
    title: 'Tenant',
    desc: 'Someone seeking housing — voucher size, housing authority, current address, and properties sent.',
  },
  {
    type: 'landlord',
    title: 'Landlord',
    desc: 'Someone offering housing — their company and their properties.',
  },
];

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
  if (value.type === 'partner') return 'partner';
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
  const baseLabelId = `${uid}-base-label`;

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
      const typeMap: Record<'tenant' | 'landlord' | 'partner', ContactType> = {
        tenant: 'tenant',
        landlord: 'landlord',
        partner: 'partner',
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
        {(['tenant', 'landlord', 'partner', 'pm', 'other'] as PrimarySegment[]).map((seg) => {
          const label =
            seg === 'tenant'
              ? 'Tenant'
              : seg === 'landlord'
                ? 'Landlord'
                : seg === 'partner'
                  ? 'Partner'
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

          {/* Base-record-shape choice — explained, not a mystery toggle. */}
          <div className={styles.baseGroup} role="radiogroup" aria-labelledby={baseLabelId}>
            <span className={styles.baseLabel} id={baseLabelId}>
              Which record type should it use?
            </span>
            <p className={styles.baseHelp}>
              A custom kind reuses an existing record shape — this sets which fields and
              behaviour{' '}
              {value.role.trim() !== '' ? <strong>“{value.role.trim()}”</strong> : 'this contact'} gets.
            </p>
            {BASE_OPTIONS.map((o) => {
              const selected = value.type === o.type;
              return (
                <button
                  key={o.type}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-describedby={`${uid}-${o.type}-desc`}
                  className={`${styles.baseOption} ${selected ? styles.baseOptionActive : ''}`}
                  onClick={() => handleBaseType(o.type)}
                >
                  <span className={styles.baseOptionMain}>
                    <span className={styles.baseOptionTitle}>{o.title}</span>
                    {selected ? (
                      <span className={styles.check} aria-hidden="true">
                        ✓
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.baseOptionDesc} id={`${uid}-${o.type}-desc`}>
                    {o.desc}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
