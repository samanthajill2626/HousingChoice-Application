// ContactEditForm — the edit dialog for a contact's details. Type-aware fields:
// name + status + notes for everyone, voucher size for tenants, company for
// landlords/PMs. Also: Role (datalist), Relationships, and Custom fields sections.
// Dirty-tracked: only the changed fields are PATCHed (the server SET-merges, so
// an untouched field is never blanked). On success the parent applies the returned
// contact in place (no refetch).
import { useState } from 'react';
import {
  updateContact,
  type Address,
  type Contact,
  type ContactPatch,
  type Relationship,
  type CustomField,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { RelationshipsEditor } from './RelationshipsEditor.js';
import { CustomFieldsEditor } from './CustomFieldsEditor.js';
import { useContactVocabulary } from './useContactVocabulary.js';
import { normalizeRelationships, normalizeCustomFields } from './contactProfile.js';
import { Modal } from './Modal.js';
import styles from './ContactEditForm.module.css';

export interface ContactEditFormProps {
  contact: Contact;
  onClose: () => void;
  onSaved: (updated: Contact) => void;
  candidates?: Contact[];
}

const STATUSES: { value: string; label: string }[] = [
  { value: 'needs_review', label: 'Needs review' },
  { value: 'active', label: 'Active' },
];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function ContactEditForm({ contact, onClose, onSaved, candidates = [] }: ContactEditFormProps): React.JSX.Element {
  const isLandlord = contact.type === 'landlord';
  const isTenant = contact.type === 'tenant';
  const vocab = useContactVocabulary();

  const [firstName, setFirstName] = useState(str(contact.firstName));
  const [lastName, setLastName] = useState(str(contact.lastName));
  const [status, setStatus] = useState(str(contact.status) || 'needs_review');
  const [notes, setNotes] = useState(str(contact.notes));
  const [voucher, setVoucher] = useState(
    typeof contact.voucherSize === 'number' ? String(contact.voucherSize) : '',
  );
  const [company, setCompany] = useState(str(contact['company']));
  const [housingAuthority, setHousingAuthority] = useState(str(contact.housingAuthority));
  const [role, setRole] = useState(str(contact.role));
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
    if (firstName !== str(contact.firstName)) patch.firstName = firstName;
    if (lastName !== str(contact.lastName)) patch.lastName = lastName;
    if (status !== (str(contact.status) || 'needs_review')) patch.status = status;
    if (notes !== str(contact.notes)) patch.notes = notes;
    if (isLandlord && company !== str(contact['company'])) patch.company = company;

    // Role — a cleared role sends '' (the server clears it).
    const roleTrimmed = role.trim();
    if (roleTrimmed !== str(contact.role).trim()) patch.role = roleTrimmed;

    // Relationships — only send if the normalized form changed.
    const normRel = normalizeRelationships(relRows);
    const initRel = normalizeRelationships(contact.relationships ?? []);
    if (JSON.stringify(normRel) !== JSON.stringify(initRel)) patch.relationships = normRel;

    // Custom fields — only send if the normalized form changed.
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
    if (Object.keys(result).length === 0) {
      onClose(); // nothing changed
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateContact(contact.contactId, result);
      onSaved(updated);
    } catch {
      setError("Couldn't save — please try again.");
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Edit contact"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="submit" form="contact-edit-form" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
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
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Notes</span>
          <textarea
            className={styles.textarea}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
        </label>

        {/* Role — datalist from vocabulary */}
        <label className={styles.field}>
          <span className={styles.label}>Role</span>
          <input
            id="edit-role"
            className={styles.input}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            autoComplete="off"
            list="edit-role-suggestions"
            aria-label="Role"
          />
          {vocab.roles.length > 0 && (
            <datalist id="edit-role-suggestions">
              {vocab.roles.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          )}
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
