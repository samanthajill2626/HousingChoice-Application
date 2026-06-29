// ContactEditForm � the edit dialog for a contact's details. Type + role are
// editable via the SAME KindPicker the create dialog uses, but kept collapsed
// behind a "Change type" button (retyping a contact is rare) so the common edit
// stays compact. The resolved kind drives the type-aware fields: name + status +
// notes for everyone, voucher size for tenants, company for landlords/PMs, plus
// Relationships + Custom fields. Dirty-tracked: only the changed fields are
// PATCHed (the server SET-merges, so an untouched field is never blanked) �
// switching type leaves the other type's old fields on the record (harmless; they
// just stop showing). On success the parent applies the returned contact in place.
import { useState } from 'react';
import {
  TENANT_STATUSES,
  TENANT_STATUS_LABELS,
  setTenantStatus,
  updateContact,
  type Address,
  type Contact,
  type ContactPatch,
  type Relationship,
  type CustomField,
  type TenantStatus,
  type ContactType,
} from '../../api/index.js';

// The valid status values, per contact type. Tenants use the 7-value tenant
// lifecycle; everyone else uses the coarse needs_review|active lifecycle.
const NON_TENANT_STATUS_VALUES = ['needs_review', 'active'] as const;
type NonTenantStatus = (typeof NON_TENANT_STATUS_VALUES)[number];

function isTenantStatus(v: string): v is TenantStatus {
  return (TENANT_STATUSES as readonly string[]).includes(v);
}

function isNonTenantStatus(v: string): v is NonTenantStatus {
  return (NON_TENANT_STATUS_VALUES as readonly string[]).includes(v);
}

/** The set of valid status values for a given type. */
function validStatusesForType(type: ContactType): readonly string[] {
  return type === 'tenant' ? TENANT_STATUSES : NON_TENANT_STATUS_VALUES;
}

/** The status to start with (and to reset to) for a type, given the contact's
 *  stored status. Keeps the selection VALID for the type: a stored value that's
 *  off-list for the type falls back to that type's front door � tenant ?
 *  'needs_review'; non-tenant ? keep 'active' if that's what was stored, else
 *  'needs_review'. Never surfaces an off-list value as a selectable option. */
function defaultStatusForType(type: ContactType, storedStatus: string): string {
  if (type === 'tenant') {
    return isTenantStatus(storedStatus) ? storedStatus : 'needs_review';
  }
  return isNonTenantStatus(storedStatus) ? storedStatus : 'needs_review';
}
import { Button } from '../../ui/index.js';
import { RelationshipsEditor } from './RelationshipsEditor.js';
import { CustomFieldsEditor } from './CustomFieldsEditor.js';
import { KindPicker, type KindPickerValue } from './KindPicker.js';
import { useContactVocabulary } from './useContactVocabulary.js';
import {
  CONTACT_TYPE_LABEL,
  normalizeRelationships,
  normalizeCustomFields,
} from './contactProfile.js';
import { Modal } from './Modal.js';
import styles from './ContactEditForm.module.css';

export interface ContactEditFormProps {
  contact: Contact;
  onClose: () => void;
  onSaved: (updated: Contact) => void;
  candidates?: Contact[];
}

// Non-tenant contacts use the coarse needs_review|active lifecycle.
const NON_TENANT_STATUSES: { value: string; label: string }[] = [
  { value: 'needs_review', label: 'Needs review' },
  { value: 'active', label: 'Active' },
];

/** The selectable status options for a type (no off-list value ever prepended). */
function statusOptionsForType(type: ContactType): { value: string; label: string }[] {
  return type === 'tenant' ? TENANT_STATUS_OPTIONS : NON_TENANT_STATUSES;
}

// Tenants use the 7-value tenant lifecycle (the status model).
const TENANT_STATUS_OPTIONS: { value: string; label: string }[] = TENANT_STATUSES.map((s) => ({
  value: s,
  label: TENANT_STATUS_LABELS[s],
}));

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function ContactEditForm({ contact, onClose, onSaved, candidates = [] }: ContactEditFormProps): React.JSX.Element {
  const vocab = useContactVocabulary();

  // Type + role together � a KindPicker value, kept collapsed behind "Change type"
  // (changingType) since retyping is rare. isTenant/isLandlord derive from the
  // LIVE kind so the type-specific fields swap the moment the base type changes.
  const [kind, setKind] = useState<KindPickerValue>({
    type: contact.type,
    role: str(contact.role),
  });
  const [changingType, setChangingType] = useState(false);
  const isLandlord = kind.type === 'landlord';
  const isTenant = kind.type === 'tenant';
  // The live base type for status scoping (KindPicker may be momentarily null
  // mid-change; fall back to the stored type).
  const liveType: ContactType = kind.type ?? contact.type;

  const [firstName, setFirstName] = useState(str(contact.firstName));
  const [lastName, setLastName] = useState(str(contact.lastName));
  // The status selection is ALWAYS valid for the current type. Seed it from the
  // stored status, defaulting off-list values to the type's front door (so a
  // legacy tenant stored as 'active' starts on 'needs_review', never on the
  // off-list 'active'). A type change re-derives it (see the effect below).
  const [status, setStatus] = useState(() =>
    defaultStatusForType(contact.type, str(contact.status)),
  );
  const [porting, setPorting] = useState(contact.porting === true);
  const [notes, setNotes] = useState(str(contact.notes));
  const [voucher, setVoucher] = useState(
    typeof contact.voucherSize === 'number' ? String(contact.voucherSize) : '',
  );
  const [company, setCompany] = useState(str(contact['company']));
  const [housingAuthority, setHousingAuthority] = useState(str(contact.housingAuthority));
  const [pets, setPets] = useState(str(contact['pets']));
  const [evictions, setEvictions] = useState(str(contact['evictions']));
  const [tenure, setTenure] = useState(str(contact['tenure']));
  const [lifEligible, setLifEligible] = useState(contact['lifEligible'] === true);
  const [relRows, setRelRows] = useState<Relationship[]>(contact.relationships ?? []);
  const [cfRows, setCfRows] = useState<CustomField[]>(contact.customFields ?? []);
  // Track whether the editors have been expanded (start collapsed to keep the
  // form clean when there is no pre-existing data).
  const [showRelationships, setShowRelationships] = useState(
    (contact.relationships ?? []).length > 0,
  );
  const [showCustomFields, setShowCustomFields] = useState(
    (contact.customFields ?? []).length > 0,
  );

  // Changing the type re-scopes the valid status set. If the current selection
  // isn't valid for the new type, reset it to that type's default (tenant ?
  // 'needs_review'; non-tenant ? keep 'active' if stored else 'needs_review') so
  // we never carry a type-invalid status (e.g. landlord 'active' ? tenant).
  function handleKindChange(next: KindPickerValue): void {
    setKind(next);
    if (next.type !== null && !validStatusesForType(next.type).includes(status)) {
      setStatus(defaultStatusForType(next.type, str(contact.status)));
    }
  }

  function handleShowRelationships(): void {
    setShowRelationships(true);
    if (relRows.length === 0) setRelRows([{ role: '', name: '' }]);
  }

  function handleShowCustomFields(): void {
    setShowCustomFields(true);
    if (cfRows.length === 0) setCfRows([{ label: '', value: '' }]);
  }
  // Initial address parts (a structured object, or a legacy string folded into line1).
  const addrObj: Partial<Address> =
    typeof contact.address === 'object' && contact.address !== null ? contact.address : {};
  const initAddr = {
    line1: str(addrObj.line1) || (typeof contact.address === 'string' ? contact.address : ''),
    line2: str(addrObj.line2),
    city: str(addrObj.city),
    state: str(addrObj.state),
    zip: str(addrObj.zip),
  };
  const [line1, setLine1] = useState(initAddr.line1);
  const [line2, setLine2] = useState(initAddr.line2);
  const [city, setCity] = useState(initAddr.city);
  const [stateField, setStateField] = useState(initAddr.state);
  const [zip, setZip] = useState(initAddr.zip);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Build the PATCH from only the fields the user actually changed.
  function buildPatch(): ContactPatch | { error: string } {
    const patch: ContactPatch = {};
    // Type + role from the KindPicker (kind.type is non-null whenever Save is
    // enabled). A cleared role sends '' (the server clears it).
    if (kind.type !== null && kind.type !== contact.type) patch.type = kind.type;
    const roleTrimmed = kind.role.trim();
    if (roleTrimmed !== str(contact.role).trim()) patch.role = roleTrimmed;

    if (firstName !== str(contact.firstName)) patch.firstName = firstName;
    if (lastName !== str(contact.lastName)) patch.lastName = lastName;
    // For TENANTS the status (and porting) is written via setTenantStatus (which
    // applies provenance/derivation) � NOT this plain PATCH, which would bypass
    // it. Non-tenant status may ride the plain PATCH. Compare against the initial
    // VALID selection (the stored value normalized to the type's valid set), so
    // an off-list stored value doesn't masquerade as a no-op change.
    if (!isTenant && status !== defaultStatusForType(liveType, str(contact.status))) {
      patch.status = status;
    }
    if (notes !== str(contact.notes)) patch.notes = notes;
    if (isLandlord && company !== str(contact['company'])) patch.company = company;

    // Relationships � only send if the normalized form changed.
    const normRel = normalizeRelationships(relRows);
    const initRel = normalizeRelationships(contact.relationships ?? []);
    if (JSON.stringify(normRel) !== JSON.stringify(initRel)) patch.relationships = normRel;

    // Custom fields � only send if the normalized form changed.
    const normCf = normalizeCustomFields(cfRows);
    const initCf = normalizeCustomFields(contact.customFields ?? []);
    if (JSON.stringify(normCf) !== JSON.stringify(initCf)) patch.customFields = normCf;

    if (isTenant) {
      const initialVoucher = typeof contact.voucherSize === 'number' ? String(contact.voucherSize) : '';
      if (voucher !== initialVoucher) {
        if (voucher === '') {
          // Leave voucher untouched rather than send a blank (the server expects a
          // 0..12 integer); clearing a voucher isn't a supported edit.
        } else {
          const n = Number(voucher);
          if (!Number.isInteger(n) || n < 0 || n > 12) {
            return { error: 'Voucher size must be a whole number from 0 to 12.' };
          }
          patch.voucherSize = n;
        }
      }
      if (housingAuthority !== str(contact.housingAuthority)) patch.housingAuthority = housingAuthority;
      if (pets !== str(contact['pets'])) patch.pets = pets;
      if (evictions !== str(contact['evictions'])) patch.evictions = evictions;
      if (tenure !== str(contact['tenure'])) patch.tenure = tenure;
      if (lifEligible !== (contact['lifEligible'] === true)) patch.lifEligible = lifEligible;
      // Address: if ANY part changed, send the whole object (the server keeps only
      // the non-empty parts).
      if (
        line1 !== initAddr.line1 ||
        line2 !== initAddr.line2 ||
        city !== initAddr.city ||
        stateField !== initAddr.state ||
        zip !== initAddr.zip
      ) {
        patch.address = { line1, line2, city, state: stateField, zip };
      }
    }
    return patch;
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (saving) return;
    const result = buildPatch();
    if ('error' in result) {
      setError(result.error);
      return;
    }
    // For a tenant, a status OR porting change is a SEPARATE write through the
    // transition service (NOT the plain PATCH). Detect either, comparing status
    // against the initial VALID tenant selection (a legacy off-list value was
    // normalized to 'needs_review' on load).
    const initialStatus = defaultStatusForType(liveType, str(contact.status));
    const tenantStatusChanged =
      isTenant && (status !== initialStatus || porting !== (contact.porting === true));

    if (Object.keys(result).length === 0 && !tenantStatusChanged) {
      onClose(); // nothing changed
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Field edits (name, notes, voucher, address, �) ride the plain PATCH.
      let updated: Contact = contact;
      if (Object.keys(result).length > 0) {
        updated = await updateContact(contact.contactId, result);
      }
      // Tenant lifecycle status + porting go through setTenantStatus so
      // provenance/derivation apply. The returned contact supersedes the PATCH's.
      // toStatus is GUARANTEED valid here (the selection is kept in the tenant
      // set), but narrow defensively � never cast an unchecked value, and fall
      // back to the front door if somehow off-list.
      if (tenantStatusChanged) {
        const toStatus: TenantStatus = isTenantStatus(status) ? status : 'needs_review';
        updated = await setTenantStatus(contact.contactId, {
          toStatus,
          source: 'manual',
          porting,
        });
      }
      onSaved(updated);
    } catch {
      setError("Couldn't save � please try again.");
      setSaving(false);
    }
  }

  // The current saved kind, shown in the collapsed summary: role (custom kind) +
  // its base record type, else just the base type label.
  const savedRole = str(contact.role).trim();
  const currentKindLabel = savedRole
    ? `${savedRole} � ${CONTACT_TYPE_LABEL[contact.type]}`
    : CONTACT_TYPE_LABEL[contact.type];
  // Save is blocked only while a type change is mid-flight with no base picked
  // (KindPicker "Other" before choosing Tenant/Landlord ? kind.type null).
  const canSave = !saving && kind.type !== null;

  // Status options for the live type � ALWAYS just that type's valid set (no
  // off-list value is ever prepended). The selected `status` is guaranteed to be
  // a member (seeded valid; re-derived on type change), so the select never shows
  // nor submits an off-list/type-invalid value.
  const statusOptions = statusOptionsForType(liveType);

  return (
    <Modal
      title="Edit contact"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="submit" form="contact-edit-form" disabled={!canSave}>
            {saving ? 'Saving�' : 'Save'}
          </Button>
        </>
      }
    >
      <form id="contact-edit-form" className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>First name</span>
            <input
              className={styles.input}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Last name</span>
            <input
              className={styles.input}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              autoComplete="off"
            />
          </label>
        </div>

        {/* Type � collapsed to a summary + "Change type"; expands to the full
            KindPicker (the same control the create dialog uses). */}
        {changingType ? (
          <div className={styles.fieldset}>
            <span className={styles.label}>Type</span>
            <KindPicker value={kind} onChange={handleKindChange} roleSuggestions={vocab.roles} />
          </div>
        ) : (
          <div className={styles.kindRow}>
            <div className={styles.kindInfo}>
              <span className={styles.label}>Type</span>
              <span className={styles.kindValue}>{currentKindLabel}</span>
            </div>
            <Button variant="secondary" size="sm" type="button" onClick={() => setChangingType(true)}>
              Change type
            </Button>
          </div>
        )}

        {isTenant ? (
          <label className={styles.field}>
            <span className={styles.label}>Voucher size (bedrooms)</span>
            <input
              className={styles.input}
              type="number"
              min={0}
              max={12}
              step={1}
              value={voucher}
              onChange={(e) => setVoucher(e.target.value)}
              placeholder="e.g. 2"
            />
          </label>
        ) : null}

        {isTenant ? (
          <label className={styles.field}>
            <span className={styles.label}>Housing authority</span>
            <input
              className={styles.input}
              value={housingAuthority}
              onChange={(e) => setHousingAuthority(e.target.value)}
              placeholder="e.g. atlanta_housing"
              autoComplete="off"
            />
          </label>
        ) : null}

        {isTenant ? (
          <div className={styles.fieldset}>
            <span className={styles.label}>Eligibility intake</span>
            <label className={styles.field}>
              <span className={styles.label}>Pets</span>
              <input
                className={styles.input}
                value={pets}
                onChange={(e) => setPets(e.target.value)}
                placeholder="e.g. 1 cat"
                autoComplete="off"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Evictions</span>
              <input
                className={styles.input}
                value={evictions}
                onChange={(e) => setEvictions(e.target.value)}
                placeholder="e.g. none"
                autoComplete="off"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Time at current address</span>
              <input
                className={styles.input}
                value={tenure}
                onChange={(e) => setTenure(e.target.value)}
                placeholder="e.g. 3 years"
                autoComplete="off"
              />
            </label>
            <label className={styles.checkboxField}>
              <input
                type="checkbox"
                checked={lifEligible}
                onChange={(e) => setLifEligible(e.target.checked)}
              />
              <span className={styles.label}>LIF eligible</span>
            </label>
          </div>
        ) : null}

        {isTenant ? (
          <div className={styles.fieldset}>
            <span className={styles.label}>Current address</span>
            <label className={styles.field}>
              <span className={styles.srLabel}>Street address</span>
              <input
                className={styles.input}
                value={line1}
                onChange={(e) => setLine1(e.target.value)}
                placeholder="Street address"
                autoComplete="off"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.srLabel}>Apt / unit</span>
              <input
                className={styles.input}
                value={line2}
                onChange={(e) => setLine2(e.target.value)}
                placeholder="Apt, suite, unit (optional)"
                autoComplete="off"
              />
            </label>
            <div className={styles.row}>
              <label className={styles.field}>
                <span className={styles.srLabel}>City</span>
                <input
                  className={styles.input}
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="City"
                  autoComplete="off"
                />
              </label>
              <label className={`${styles.field} ${styles.stateField}`}>
                <span className={styles.srLabel}>State</span>
                <input
                  className={styles.input}
                  value={stateField}
                  onChange={(e) => setStateField(e.target.value)}
                  placeholder="State"
                  autoComplete="off"
                />
              </label>
              <label className={`${styles.field} ${styles.zipField}`}>
                <span className={styles.srLabel}>ZIP</span>
                <input
                  className={styles.input}
                  value={zip}
                  onChange={(e) => setZip(e.target.value)}
                  placeholder="ZIP"
                  autoComplete="off"
                />
              </label>
            </div>
          </div>
        ) : null}

        {isLandlord ? (
          <label className={styles.field}>
            <span className={styles.label}>Company</span>
            <input
              className={styles.input}
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              autoComplete="off"
            />
          </label>
        ) : null}

        <label className={styles.field}>
          <span className={styles.label}>Status</span>
          <select className={styles.input} value={status} onChange={(e) => setStatus(e.target.value)}>
            {statusOptions.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        {isTenant ? (
          <label className={styles.checkboxField}>
            <input
              type="checkbox"
              checked={porting}
              onChange={(e) => setPorting(e.target.checked)}
            />
            <span className={styles.label}>Porting in from another jurisdiction</span>
          </label>
        ) : null}

        <label className={styles.field}>
          <span className={styles.label}>Notes</span>
          <textarea
            className={styles.textarea}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
        </label>

        {/* Relationships */}
        {showRelationships ? (
          <div className={styles.fieldset}>
            <span className={styles.label}>Relationships</span>
            <RelationshipsEditor
              rows={relRows}
              onChange={setRelRows}
              candidates={candidates}
              roleSuggestions={vocab.relationshipRoles}
            />
          </div>
        ) : (
          <Button variant="secondary" size="sm" type="button" onClick={handleShowRelationships}>
            + Add relationship
          </Button>
        )}

        {/* Custom fields */}
        {showCustomFields ? (
          <div className={styles.fieldset}>
            <span className={styles.label}>Custom fields</span>
            <CustomFieldsEditor
              rows={cfRows}
              onChange={setCfRows}
              labelSuggestions={vocab.fieldLabels}
            />
          </div>
        ) : (
          <Button variant="secondary" size="sm" type="button" onClick={handleShowCustomFields}>
            + Add custom field
          </Button>
        )}

        {error !== null ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
