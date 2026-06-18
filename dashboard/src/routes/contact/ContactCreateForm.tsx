// ContactCreateForm — the "New contact" dialog (Modal) with KindPicker + standard
// fields + RelationshipsEditor + CustomFieldsEditor + 409 conflict handling.
// The Create button is disabled until a base type resolves (KindPicker type !== null).
// On 409 an inline conflict notice is rendered; the dialog stays open.
import { useState } from 'react';
import {
  createContact,
  ApiError,
  type Contact,
  type Relationship,
  type CustomField,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { contactDisplayName } from './format.js';
import { KindPicker, type KindPickerValue } from './KindPicker.js';
import { RelationshipsEditor } from './RelationshipsEditor.js';
import { CustomFieldsEditor } from './CustomFieldsEditor.js';
import { useContactVocabulary } from './useContactVocabulary.js';
import { normalizeRelationships, normalizeCustomFields } from './contactProfile.js';
import { Modal } from './Modal.js';
import styles from './ContactCreateForm.module.css';

export interface ContactCreateFormProps {
  candidates: Contact[];
  onClose: () => void;
  onCreated: (c: Contact) => void;
  onOpenExisting: (contactId: string) => void;
}

export function ContactCreateForm({
  candidates,
  onClose,
  onCreated,
  onOpenExisting,
}: ContactCreateFormProps): React.JSX.Element {
  const vocab = useContactVocabulary();

  // KindPicker controlled state
  const [kind, setKind] = useState<KindPickerValue>({ type: null, role: '' });

  // Standard fields
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [voucher, setVoucher] = useState('');
  const [company, setCompany] = useState('');

  // Collapsible editors: track whether the user has opted in
  const [showRelationships, setShowRelationships] = useState(false);
  const [showCustomFields, setShowCustomFields] = useState(false);

  // Editor rows
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);

  // Submission state
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictContact, setConflictContact] = useState<Contact | null>(null);

  const resolvedType = kind.type;
  const isTenant = resolvedType === 'tenant';
  const isLandlordOrPm = resolvedType === 'landlord' || resolvedType === 'pm';
  const canCreate = resolvedType !== null && !busy;

  function handleShowRelationships(): void {
    setShowRelationships(true);
    // Pre-add one empty row so the editor is immediately useful
    if (relationships.length === 0) {
      setRelationships([{ role: '', name: '' }]);
    }
  }

  function handleShowCustomFields(): void {
    setShowCustomFields(true);
    if (customFields.length === 0) {
      setCustomFields([{ label: '', value: '' }]);
    }
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canCreate || resolvedType === null) return;

    setBusy(true);
    setError(null);
    setConflictContact(null);

    // Build the body, including only non-empty fields.
    const body: Record<string, unknown> = { type: resolvedType };

    const trimmedRole = kind.role.trim();
    if (trimmedRole) body['role'] = trimmedRole;
    if (firstName.trim()) body['firstName'] = firstName.trim();
    if (lastName.trim()) body['lastName'] = lastName.trim();
    if (phone.trim()) body['phone'] = phone.trim();

    if (isTenant && voucher.trim()) {
      const n = Number(voucher.trim());
      if (Number.isInteger(n) && n >= 0 && n <= 12) {
        body['voucherSize'] = n;
      }
    }

    if (isLandlordOrPm && company.trim()) {
      body['company'] = company.trim();
    }

    // Filter relationships and custom fields via shared helpers (matches backend accept rules).
    const validRelationships = normalizeRelationships(relationships);
    if (validRelationships.length > 0) {
      body['relationships'] = validRelationships;
    }

    const validCustomFields = normalizeCustomFields(customFields);
    if (validCustomFields.length > 0) {
      body['customFields'] = validCustomFields;
    }

    try {
      const contact = await createContact(body as unknown as Parameters<typeof createContact>[0]);
      onCreated(contact);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Narrow err.body to extract the existing contact.
        const b = err.body;
        if (
          b !== null &&
          typeof b === 'object' &&
          'contact' in b &&
          typeof (b as Record<string, unknown>)['contact'] === 'object' &&
          (b as Record<string, unknown>)['contact'] !== null &&
          typeof ((b as Record<string, unknown>)['contact'] as Record<string, unknown>)['contactId'] === 'string'
        ) {
          const existing = (b as Record<string, unknown>)['contact'] as Contact;
          setConflictContact(existing);
        } else {
          setError('That number already belongs to another contact.');
        }
      } else {
        setError("Couldn't create contact — please try again.");
      }
      setBusy(false);
    }
  }

  // Compute the conflict display name when we have a conflict.
  const conflictName = conflictContact
    ? contactDisplayName(conflictContact.firstName, conflictContact.lastName, conflictContact.phone)
    : null;

  return (
    <Modal
      title="New contact"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form="contact-create-form"
            disabled={!canCreate}
          >
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="contact-create-form" className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        <KindPicker value={kind} onChange={setKind} roleSuggestions={vocab.roles} />

        {/* Standard fields — always shown */}
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

        <label className={styles.field}>
          <span className={styles.label}>Phone</span>
          <input
            className={styles.input}
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="e.g. +14041112222"
            autoComplete="off"
          />
        </label>

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

        {isLandlordOrPm ? (
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

        {/* Relationships — collapsed behind "+ Add relationship" */}
        {showRelationships ? (
          <div className={styles.section}>
            <span className={styles.sectionLabel}>Relationships</span>
            <RelationshipsEditor
              rows={relationships}
              onChange={setRelationships}
              candidates={candidates}
              roleSuggestions={vocab.relationshipRoles}
            />
          </div>
        ) : (
          <Button variant="secondary" size="sm" type="button" onClick={handleShowRelationships}>
            + Add relationship
          </Button>
        )}

        {/* Custom fields — collapsed behind "+ Add custom field" */}
        {showCustomFields ? (
          <div className={styles.section}>
            <span className={styles.sectionLabel}>Custom fields</span>
            <CustomFieldsEditor
              rows={customFields}
              onChange={setCustomFields}
              labelSuggestions={vocab.fieldLabels}
            />
          </div>
        ) : (
          <Button variant="secondary" size="sm" type="button" onClick={handleShowCustomFields}>
            + Add custom field
          </Button>
        )}

        {/* Conflict notice (409) */}
        {conflictContact !== null && conflictName !== null ? (
          <div role="alert" className={styles.conflict}>
            <span>
              That number already belongs to <strong>{conflictName}</strong>.
            </span>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => onOpenExisting(conflictContact.contactId)}
            >
              Open their page
            </Button>
          </div>
        ) : null}

        {/* Generic error */}
        {error !== null ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
