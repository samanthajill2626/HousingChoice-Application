// UnitCreateForm — the "New property" dialog (Modal). Originates a unit under a
// landlord (POST /api/units). Mirrors PlacementCreateForm's locked/editable
// pattern: a pre-filled `landlordId` prop renders the owning landlord LOCKED
// read-only (the landlord-page entry point already knows the owner); with no
// prop, a landlord typeahead lets the caller pick one (the Properties-list entry).
//
// The field inputs mirror ListingEditForm (same field set + types + CSS module),
// but this is a CREATE: only the non-empty fields are sent, and the server stamps
// the initial status ('setup') — status is NOT a writable field here. Navigation
// lives in the entry points: on a 201 the form calls onCreated and the caller
// closes + navigates (parity with ContactCreateForm / PlacementCreateForm).
import { useEffect, useState } from 'react';
import {
  createUnit,
  getContact,
  getContacts,
  type Contact,
  type UnitItem,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import { ContactSearchField, type ContactSearchValue } from '../contact/ContactSearchField.js';
import { contactDisplayName } from '../contact/format.js';
import styles from './ListingEditForm.module.css';

export interface UnitCreateFormProps {
  /** Pre-fill + lock the owning landlord (the landlord-page entry point). */
  landlordId?: string;
  onClose: () => void;
  onCreated: (unit: UnitItem) => void;
}

const FORM_ID = 'unit-create-form';

/** Display name for a landlord contact (name → phone → "Unknown contact"). */
function landlordLabel(c: Contact): string {
  const phone = c.phones?.find((p) => p.primary)?.phone ?? c.phone;
  return contactDisplayName(c.firstName, c.lastName, phone);
}

export function UnitCreateForm({
  landlordId,
  onClose,
  onCreated,
}: UnitCreateFormProps): React.JSX.Element {
  // Landlord candidates for the picker (fetched on mount) + the locked-side label.
  const [landlords, setLandlords] = useState<Contact[]>([]);
  const [lockedLandlordLabel, setLockedLandlordLabel] = useState<string | null>(null);
  const [landlordPick, setLandlordPick] = useState<ContactSearchValue>({ name: '' });

  // Property fields (mirror ListingEditForm; all optional on create).
  const [jurisdiction, setJurisdiction] = useState('');
  const [beds, setBeds] = useState('');
  const [baths, setBaths] = useState('');
  const [rentMin, setRentMin] = useState('');
  const [rentMax, setRentMax] = useState('');
  const [paymentStandard, setPaymentStandard] = useState('');
  const [deposit, setDeposit] = useState('');
  const [utilities, setUtilities] = useState('');
  const [accessibility, setAccessibility] = useState('');
  const [notes, setNotes] = useState('');
  const [leaseTerms, setLeaseTerms] = useState('');
  const [pets, setPets] = useState('');
  const [programs, setPrograms] = useState('');
  const [listingLink, setListingLink] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [applicationFee, setApplicationFee] = useState('');
  const [voucherSize, setVoucherSize] = useState('');
  const [sameDayRta, setSameDayRta] = useState(false);
  const [tourProcess, setTourProcess] = useState('');
  const [applicationProcess, setApplicationProcess] = useState('');

  // Address parts.
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [stateField, setStateField] = useState('');
  const [zip, setZip] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const landlordLocked = landlordId !== undefined;
  const resolvedLandlordId = landlordId ?? landlordPick.contactId;
  const canCreate = resolvedLandlordId !== undefined && !busy;

  // ── Fetch the landlord candidates + resolve a locked-side label on mount. ──
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const page = await getContacts({ type: 'landlord' }, ac.signal);
        if (ac.signal.aborted) return;
        setLandlords(page.contacts);
        if (landlordId !== undefined) {
          const hit = page.contacts.find((c) => c.contactId === landlordId);
          if (hit) setLockedLandlordLabel(landlordLabel(hit));
        }
      } catch {
        // Non-fatal: the picker stays empty; a locked side still submits.
      }
    })();

    // Fallback label resolution for a locked landlord not on the first page.
    if (landlordId !== undefined) {
      void (async () => {
        try {
          const c = await getContact(landlordId, ac.signal);
          if (!ac.signal.aborted) setLockedLandlordLabel((prev) => prev ?? landlordLabel(c));
        } catch {
          /* fall back to the id below */
        }
      })();
    }

    return () => ac.abort();
  }, [landlordId]);

  /** Add a number field to the body: blank → skip; else validate finite >= 0.
   *  Returns false (and sets an inline error) on a validation failure. */
  function addNumber(
    body: Record<string, unknown>,
    key: string,
    value: string,
    label: string,
  ): boolean {
    if (value.trim() === '') return true;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      setError(`${label} must be a number 0 or greater.`);
      return false;
    }
    body[key] = n;
    return true;
  }

  /** Build the create body from the non-empty fields, or null on a validation
   *  failure (an inline error was set). landlordId is guaranteed by canCreate. */
  function buildBody(): Record<string, unknown> | null {
    const body: Record<string, unknown> = { landlordId: resolvedLandlordId };

    const addStr = (key: string, value: string): void => {
      const v = value.trim();
      if (v) body[key] = v;
    };
    addStr('jurisdiction', jurisdiction);
    addStr('utilities', utilities);
    addStr('accessibility', accessibility);
    addStr('notes', notes);
    addStr('lease_terms', leaseTerms);
    addStr('pets', pets);
    addStr('listing_link', listingLink);
    addStr('video_url', videoUrl);
    addStr('tour_process', tourProcess);
    addStr('application_process', applicationProcess);
    if (sameDayRta) body['same_day_rta'] = true;

    if (!addNumber(body, 'beds', beds, 'Beds')) return null;
    if (!addNumber(body, 'baths', baths, 'Baths')) return null;
    if (!addNumber(body, 'rent_min', rentMin, 'Rent min')) return null;
    if (!addNumber(body, 'rent_max', rentMax, 'Rent max')) return null;
    if (!addNumber(body, 'payment_standard', paymentStandard, 'Payment standard')) return null;
    if (!addNumber(body, 'deposit', deposit, 'Deposit')) return null;
    if (!addNumber(body, 'application_fee', applicationFee, 'Application fee')) return null;
    if (!addNumber(body, 'voucher_size_accepted', voucherSize, 'Voucher size accepted')) return null;

    // Accepted programs — comma-separated; send the array only when non-empty.
    const normPrograms = programs
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (normPrograms.length > 0) body['accepted_programs'] = normPrograms;

    // Address — send the object only when at least one part is filled. The server
    // keeps only the non-empty parts.
    if ([line1, line2, city, stateField, zip].some((s) => s.trim() !== '')) {
      body['address'] = { line1, line2, city, state: stateField, zip };
    }

    return body;
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canCreate) return;
    setError(null);
    const body = buildBody();
    if (body === null) return; // a validation error was set
    setBusy(true);
    try {
      const unit = await createUnit(body);
      setBusy(false);
      onCreated(unit);
    } catch {
      setError("Couldn't create the property — please try again.");
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New property"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="submit" form={FORM_ID} disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        {/* Owning landlord (required; locked when the landlordId prop is set) */}
        <div className={styles.field}>
          <span className={styles.label}>Owning landlord</span>
          {landlordLocked ? (
            // Read-only display of the pre-filled owner — the visible label span
            // above provides its name; no landmark role (it groups no controls).
            <div className={styles.locked}>{lockedLandlordLabel ?? landlordId}</div>
          ) : (
            <ContactSearchField
              value={landlordPick}
              onChange={setLandlordPick}
              candidates={landlords}
              inputLabel="Owning landlord"
            />
          )}
        </div>

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>Housing authority</span>
            <input
              className={styles.input}
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
              placeholder="e.g. ga_dca"
              autoComplete="off"
            />
          </label>
        </div>

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>Beds</span>
            <input
              className={styles.input}
              type="number"
              min={0}
              step={1}
              value={beds}
              onChange={(e) => setBeds(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Baths</span>
            <input
              className={styles.input}
              type="number"
              min={0}
              step={0.5}
              value={baths}
              onChange={(e) => setBaths(e.target.value)}
            />
          </label>
        </div>

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>Rent min</span>
            <input
              className={styles.input}
              type="number"
              min={0}
              step={1}
              value={rentMin}
              onChange={(e) => setRentMin(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Rent max</span>
            <input
              className={styles.input}
              type="number"
              min={0}
              step={1}
              value={rentMax}
              onChange={(e) => setRentMax(e.target.value)}
            />
          </label>
        </div>

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>Payment standard</span>
            <input
              className={styles.input}
              type="number"
              min={0}
              step={1}
              value={paymentStandard}
              onChange={(e) => setPaymentStandard(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Deposit</span>
            <input
              className={styles.input}
              type="number"
              min={0}
              step={1}
              value={deposit}
              onChange={(e) => setDeposit(e.target.value)}
            />
          </label>
        </div>

        <div className={styles.fieldset}>
          <span className={styles.label}>Address</span>
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

        <label className={styles.field}>
          <span className={styles.label}>Tenant-paid utilities</span>
          <input
            className={styles.input}
            value={utilities}
            onChange={(e) => setUtilities(e.target.value)}
            placeholder="e.g. Electric and gas"
            autoComplete="off"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Accessibility</span>
          <input
            className={styles.input}
            value={accessibility}
            onChange={(e) => setAccessibility(e.target.value)}
            placeholder="e.g. Ground floor"
            autoComplete="off"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Notes</span>
          <textarea
            className={styles.textarea}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. In-unit washer/dryer; no dishwasher"
            rows={3}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Pets</span>
          <input
            className={styles.input}
            value={pets}
            onChange={(e) => setPets(e.target.value)}
            placeholder="e.g. Cats only"
            autoComplete="off"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Lease terms</span>
          <input
            className={styles.input}
            value={leaseTerms}
            onChange={(e) => setLeaseTerms(e.target.value)}
            placeholder="e.g. 12-month minimum, month-to-month after"
            autoComplete="off"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Accepted vouchers / programs</span>
          <input
            className={styles.input}
            value={programs}
            onChange={(e) => setPrograms(e.target.value)}
            placeholder="Comma-separated, e.g. HCV, VASH"
            autoComplete="off"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Public listing link</span>
          <input
            className={styles.input}
            value={listingLink}
            onChange={(e) => setListingLink(e.target.value)}
            placeholder="https://…"
            autoComplete="off"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Video URL</span>
          <input
            className={styles.input}
            value={videoUrl}
            onChange={(e) => setVideoUrl(e.target.value)}
            placeholder="https://… (tour video)"
            autoComplete="off"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Application fee</span>
          <input
            className={styles.input}
            type="number"
            min={0}
            step={1}
            value={applicationFee}
            onChange={(e) => setApplicationFee(e.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Voucher size accepted</span>
          <input
            className={styles.input}
            type="number"
            min={0}
            step={1}
            value={voucherSize}
            onChange={(e) => setVoucherSize(e.target.value)}
          />
        </label>

        <label className={`${styles.field} ${styles.checkField}`}>
          <input
            className={styles.checkbox}
            type="checkbox"
            checked={sameDayRta}
            onChange={(e) => setSameDayRta(e.target.checked)}
          />
          <span className={styles.label}>Same-day RTA</span>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Tour process</span>
          <textarea
            className={styles.textarea}
            value={tourProcess}
            onChange={(e) => setTourProcess(e.target.value)}
            rows={2}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Application process</span>
          <textarea
            className={styles.textarea}
            value={applicationProcess}
            onChange={(e) => setApplicationProcess(e.target.value)}
            rows={2}
          />
        </label>

        {error !== null ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
