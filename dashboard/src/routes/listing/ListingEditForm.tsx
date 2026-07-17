// ListingEditForm — the edit dialog for a property (unit). Mirrors ContactEditForm:
// stacked labelled fields in a Modal, DIRTY-TRACKED (only the changed fields are
// PATCHed; the server SET-merges, so an untouched field is never blanked). On
// success the parent applies the returned unit in place (no refetch). The field
// set + types match the backend allowlist (app/src/lib/unitFields.ts).
import { useState } from 'react';
import {
  updateUnit,
  TOUR_TYPE_LABELS,
  type Address,
  type TourType,
  type UnitItem,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import styles from './ListingEditForm.module.css';

export interface ListingEditFormProps {
  unit: UnitItem;
  onClose: () => void;
  onSaved: (updated: UnitItem) => void;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** A number field's initial string (empty when unset). */
function numStr(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

export function ListingEditForm({ unit, onClose, onSaved }: ListingEditFormProps): React.JSX.Element {
  const [jurisdiction, setJurisdiction] = useState(str(unit.jurisdiction));
  const [beds, setBeds] = useState(numStr(unit.beds));
  const [baths, setBaths] = useState(numStr(unit.baths));
  const [rentMin, setRentMin] = useState(numStr(unit.rent_min));
  const [rentMax, setRentMax] = useState(numStr(unit.rent_max));
  const [paymentStandard, setPaymentStandard] = useState(numStr(unit.payment_standard));
  const [deposit, setDeposit] = useState(numStr(unit.deposit));
  const [utilities, setUtilities] = useState(str(unit.utilities));
  const [accessibility, setAccessibility] = useState(str(unit.accessibility));
  const [notes, setNotes] = useState(str(unit.notes));
  const [leaseTerms, setLeaseTerms] = useState(str(unit.lease_terms));
  const [pets, setPets] = useState(
    typeof unit.pets === 'string'
      ? unit.pets
      : unit.pets === true
        ? 'Yes'
        : unit.pets === false
          ? 'No'
          : '',
  );
  const initialPrograms = (unit.accepted_programs ?? []).join(', ');
  const [programs, setPrograms] = useState(initialPrograms);
  const [tourProcess, setTourProcess] = useState(str(unit.tour_process));
  const [tourType, setTourType] = useState<string>(str(unit.tour_type));
  const [applicationProcess, setApplicationProcess] = useState(str(unit.application_process));
  const [listingLink, setListingLink] = useState(str(unit.listing_link));
  // Public flyer details (public-pages §5): tenants see these on the post-intake
  // reveal. video URL (text) + application fee (number) + same-day RTA (boolean).
  const [videoUrl, setVideoUrl] = useState(str(unit.video_url));
  const [applicationFee, setApplicationFee] = useState(numStr(unit.application_fee));
  // Accepted voucher size (bedroom count the voucher covers) — distinct from beds.
  const [voucherSize, setVoucherSize] = useState(numStr(unit.voucher_size_accepted));
  const [sameDayRta, setSameDayRta] = useState(unit.same_day_rta === true);

  // Address parts (a structured object, or a legacy string folded into line1).
  const addrObj: Partial<Address> =
    typeof unit.address === 'object' && unit.address !== null ? unit.address : {};
  const initAddr = {
    line1: str(addrObj.line1) || (typeof unit.address === 'string' ? unit.address : ''),
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

  /** Diff a number field: unchanged → skip; cleared → leave untouched (the
   *  server expects a number, and clearing a number isn't a supported edit);
   *  else validate finite >= 0. Returns false on a validation failure. */
  function addNumber(
    patch: Record<string, unknown>,
    key: keyof UnitItem,
    value: string,
    initial: string,
    label: string,
  ): boolean {
    if (value === initial) return true;
    if (value.trim() === '') return true; // clearing a number isn't supported
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      setError(`${label} must be a number 0 or greater.`);
      return false;
    }
    patch[key as string] = n;
    return true;
  }

  function buildPatch(): Record<string, unknown> | null {
    const patch: Record<string, unknown> = {};
    if (jurisdiction !== str(unit.jurisdiction)) patch['jurisdiction'] = jurisdiction;
    if (utilities !== str(unit.utilities)) patch['utilities'] = utilities;
    if (videoUrl !== str(unit.video_url)) patch['video_url'] = videoUrl;
    // same_day_rta — a boolean toggle; send when it differs from the stored value.
    if (sameDayRta !== (unit.same_day_rta === true)) patch['same_day_rta'] = sameDayRta;
    if (accessibility !== str(unit.accessibility)) patch['accessibility'] = accessibility;
    if (notes !== str(unit.notes)) patch['notes'] = notes;
    if (leaseTerms !== str(unit.lease_terms)) patch['lease_terms'] = leaseTerms;
    if (listingLink !== str(unit.listing_link)) patch['listing_link'] = listingLink;
    if (tourProcess !== str(unit.tour_process)) patch['tour_process'] = tourProcess;
    // Sends '' on clear -> the backend tour_type FieldKind maps ''->null->REMOVE.
    if (tourType !== str(unit.tour_type)) patch['tour_type'] = tourType;
    if (applicationProcess !== str(unit.application_process)) {
      patch['application_process'] = applicationProcess;
    }

    // Pets — initial reflects the boolean/string normalization above.
    const initialPets =
      typeof unit.pets === 'string'
        ? unit.pets
        : unit.pets === true
          ? 'Yes'
          : unit.pets === false
            ? 'No'
            : '';
    if (pets !== initialPets) patch['pets'] = pets;

    if (!addNumber(patch, 'beds', beds, numStr(unit.beds), 'Beds')) return null;
    if (!addNumber(patch, 'baths', baths, numStr(unit.baths), 'Baths')) return null;
    if (!addNumber(patch, 'rent_min', rentMin, numStr(unit.rent_min), 'Rent min')) return null;
    if (!addNumber(patch, 'rent_max', rentMax, numStr(unit.rent_max), 'Rent max')) return null;
    if (!addNumber(patch, 'payment_standard', paymentStandard, numStr(unit.payment_standard), 'Payment standard')) {
      return null;
    }
    if (!addNumber(patch, 'deposit', deposit, numStr(unit.deposit), 'Deposit')) return null;
    if (!addNumber(patch, 'application_fee', applicationFee, numStr(unit.application_fee), 'Application fee')) {
      return null;
    }
    if (!addNumber(patch, 'voucher_size_accepted', voucherSize, numStr(unit.voucher_size_accepted), 'Voucher size accepted')) {
      return null;
    }

    // Accepted programs — comma-separated; normalize (trim, drop empties) and
    // send the array only when the normalized form changed.
    const normPrograms = programs
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const initNorm = (unit.accepted_programs ?? []).map((p) => p.trim()).filter(Boolean);
    if (JSON.stringify(normPrograms) !== JSON.stringify(initNorm)) {
      patch['accepted_programs'] = normPrograms;
    }

    // Address: if ANY part changed, send the whole object (the server keeps only
    // the non-empty parts).
    if (
      line1 !== initAddr.line1 ||
      line2 !== initAddr.line2 ||
      city !== initAddr.city ||
      stateField !== initAddr.state ||
      zip !== initAddr.zip
    ) {
      patch['address'] = { line1, line2, city, state: stateField, zip };
    }

    return patch;
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (saving) return;
    setError(null);
    const patch = buildPatch();
    if (patch === null) return; // a validation error was set
    if (Object.keys(patch).length === 0) {
      onClose(); // nothing changed
      return;
    }
    setSaving(true);
    try {
      const updated = await updateUnit(unit.unitId, patch);
      onSaved(updated);
    } catch {
      setError("Couldn't save — please try again.");
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Edit property"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="submit" form="listing-edit-form" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form id="listing-edit-form" className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        <p className={styles.hint}>
          Address, rent, deposit, fees, utilities, pets, accessibility, and lease
          terms are shown on the public flyer.
        </p>
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
          <span className={styles.label}>Tour type</span>
          <select
            className={styles.input}
            aria-label="Tour type"
            value={tourType}
            onChange={(e) => setTourType(e.target.value)}
          >
            <option value="">Not set</option>
            {(Object.keys(TOUR_TYPE_LABELS) as TourType[]).map((t) => (
              <option key={t} value={t}>
                {TOUR_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
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
