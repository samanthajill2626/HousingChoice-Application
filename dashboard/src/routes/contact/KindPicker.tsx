// KindPicker — unified "What kind of contact is this?" control.
// Segments: Tenant / Landlord / Partner / [Caseworker] / Property Manager / Other.
// Caseworker (spec 2026-10-06 D16, D22) is a preset {type:'partner',
// role:CASEWORKER_ROLE}, shown only when the host passes `offerCaseworker` (a
// NEW contact, or a STORED caseworker): an existing contact becomes a
// caseworker only through the conversion dialog, never a save.
// Picking Tenant/Landlord/Partner resolves directly to {type, role:''} (partner
// is a first-class ContactType, not a preset).
// Picking Property Manager is a preset: {type:'landlord', role:PM_ROLE}.
// Picking Other reveals a Role text input + a base-type sub-choice.
import { useEffect, useId, useState } from 'react';
import { type ContactType } from '../../api/index.js';
import {
  patchForSuggestedContactKind,
  PM_ROLE,
  type SuggestedContactKind,
} from './contactProfile.js';
import { CASEWORKER_ROLE, mentionsCaseworker } from './caseworkerRole.js';
import styles from './KindPicker.module.css';

export interface KindPickerValue {
  type: ContactType | null;
  role: string;
}

export interface KindPickerProps {
  value: KindPickerValue;
  onChange: (v: KindPickerValue) => void;
  roleSuggestions?: string[];
  /** Offer the "Caseworker" segment (spec D16). The HOST decides from the
   *  STORED contact (ruling R4-15): true on a new contact or when the stored
   *  contact is already a caseworker, never from the live kind. */
  offerCaseworker?: boolean;
}

type PrimarySegment = 'tenant' | 'landlord' | 'partner' | 'caseworker' | 'pm' | 'other';

/** The segment order (spec D22): the Unknown card's Mark-as order, then Other. */
const SEGMENTS: readonly PrimarySegment[] = ['tenant', 'landlord', 'partner', 'pm', 'other'];
const SEGMENTS_WITH_CASEWORKER: readonly PrimarySegment[] = [
  'tenant',
  'landlord',
  'partner',
  'caseworker',
  'pm',
  'other',
];

const SEGMENT_LABEL: Readonly<Record<PrimarySegment, string>> = {
  tenant: 'Tenant',
  landlord: 'Landlord',
  partner: 'Partner',
  caseworker: 'Caseworker',
  pm: 'Property Manager',
  other: 'Other',
};

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

/** True when the value is exactly the Caseworker preset (partner +
 *  CASEWORKER_ROLE, byte-exact as the PM preset is - ruling R4-15). A partner
 *  whose role is a variant ("Case worker") reads as Other. */
function isCaseworkerPresetValue(value: KindPickerValue): boolean {
  return value.type === 'partner' && value.role === CASEWORKER_ROLE;
}

/** Derive which primary segment button should appear "active". */
function activePrimarySegment(
  value: KindPickerValue,
  otherSelected: boolean,
  offerCaseworker: boolean,
): PrimarySegment | null {
  if (isPmPresetValue(value)) return 'pm';
  if (offerCaseworker && isCaseworkerPresetValue(value)) return 'caseworker';
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
  offerCaseworker = false,
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

  // The Other panel (bases Tenant and Landlord only) leaves out every role
  // that MENTIONS a caseworker (spec D16, D22): on those bases they are exactly
  // the records the Possible caseworkers list exists to clean up. Typing one
  // stays possible (ruling R4-17) - the list catches it.
  const suggestions = (roleSuggestions ?? []).filter((role) => !mentionsCaseworker(role));
  const isPmPreset = isPmPresetValue(value);
  const isCaseworkerPreset = offerCaseworker && isCaseworkerPresetValue(value);
  const inOtherMode =
    otherSelected || (value.role.trim() !== '' && !isPmPreset && !isCaseworkerPreset);
  const active = activePrimarySegment(value, otherSelected, offerCaseworker);

  function handleSegment(seg: PrimarySegment): void {
    if (seg === 'other') {
      if (inOtherMode) {
        // Already in Other mode — keep type+role as-is (don't wipe a chosen base).
        onChange({ type: value.type, role: value.role });
      } else {
        setOtherSelected(true);
        onChange({ type: null, role: value.role });
      }
    } else if (seg === 'caseworker') {
      // A preset, like Property Manager - but not a SuggestedContactKind: the
      // triage PATCH map never makes a caseworker (the conversion does).
      setOtherSelected(false);
      onChange({ type: 'partner', role: CASEWORKER_ROLE });
    } else {
      const canonicalKind: SuggestedContactKind = seg === 'pm' ? 'property_manager' : seg;
      const patch = patchForSuggestedContactKind(canonicalKind);
      setOtherSelected(false);
      onChange({ type: patch.type, role: patch.role });
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
        {(offerCaseworker ? SEGMENTS_WITH_CASEWORKER : SEGMENTS).map((seg) => {
          const label = SEGMENT_LABEL[seg];
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
            placeholder="e.g. Social worker, Inspector..."
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
