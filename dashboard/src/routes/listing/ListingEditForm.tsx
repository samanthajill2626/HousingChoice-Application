// ListingEditForm - the edit dialog for a property (unit). Mirrors ContactEditForm:
// stacked labelled fields in a Modal, DIRTY-TRACKED (only the changed fields are
// PATCHed; the server SET-merges, so an untouched field is never blanked). On
// success the parent applies the returned unit in place (no refetch). The field
// set + types match the backend allowlist (app/src/lib/unitFields.ts).
//
// Spec 2026-10-20 (property requirements) D10: the fields run in the D10 order
// and EVERY field carries an "On flyer" / "Staff only" tag from the D10a table
// (PROPERTY_FORM_FIELDS) - outside its <label>, tied by aria-describedby, so
// each field's accessible name stays its label. A legend under the title
// explains both tags. The Requirements section is the shared
// RequirementsFields, read through the D1 interpretation (a legacy boolean
// `pets` included) and diffed by buildRequirementPatch; the voucher sizes are
// picker B (D4). A 409 property_changed keeps the form open with what staff
// typed (D5): the patch carries only changed keys, so saving again is safe.
import { useId, useRef, useState } from 'react';
import { ApiError, updateUnit, type Address, type UnitItem } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import { NewOrgDialog } from '../orgs/NewOrgDialog.js';
import { OrgPicker, type OrgPickerHandle } from '../orgs/OrgPicker.js';
import {
  HOUSING_AUTHORITY_KINDS,
  notOnListMessage,
  orgListLoadError,
  orgListUnknown,
  orgNotOnListBody,
  refusesSave,
} from '../orgs/orgCopy.js';
import { useOrgList } from '../orgs/useOrgList.js';
import { useTypedOrgText } from '../orgs/useTypedOrgText.js';
import { FlyerLegend, FlyerTag } from './FlyerTag.js';
import { authoritiesOf } from './listingFormat.js';
import {
  buildRequirementPatch,
  formFieldVisibility,
  requirementFormValuesFromUnit,
  splitVoucherSizes,
  voucherSizesPatchValue,
  type RequirementFormValues,
} from './requirementForm.js';
import { WASHER_DRYER_LABELS, WASHER_DRYER_VALUES } from './requirements.js';
import { RequirementsFields } from './RequirementsFields.js';
import { TaggedCheckbox, TaggedField, TaggedGroupLabel } from './TaggedField.js';
import { VoucherSizePicker } from './VoucherSizePicker.js';
import styles from './ListingEditForm.module.css';

export interface ListingEditFormProps {
  unit: UnitItem;
  onClose: () => void;
  onSaved: (updated: UnitItem) => void;
}

/** Spec 2026-10-20 D5: the PATCH's 409 after its fenced retries. */
const PROPERTY_CHANGED = 'This property changed while you were saving. Save again.';

/** Spec 2026-10-20 D1 (planner ruling PR1-1): the 400 deposit_conflict - the
 *  property would hold one month's rent AND a fixed amount. */
const DEPOSIT_CONFLICT =
  "A deposit can be one month's rent or a fixed amount, not both. Reload the property and try again.";

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** A number field's initial string (empty when unset). */
function numStr(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

export function ListingEditForm({ unit, onClose, onSaved }: ListingEditFormProps): React.JSX.Element {
  // The housing authorities picker (spec 2026-10-06 D6), prefilled from the
  // SYNTHESIZED list: a legacy unit that only carries `jurisdiction` shows that
  // value as a chip, so the first real edit migrates it into
  // `accepted_authorities`. Untouched members stay byte-exact.
  const orgList = useOrgList();
  const [authorities, setAuthorities] = useState<string[]>(() => authoritiesOf(unit));
  const [authoritiesError, setAuthoritiesError] = useState<string | null>(null);
  // "Is this really new?" - rendered after the </form> (R5 ruling).
  const [addingAuthority, setAddingAuthority] = useState<string | null>(null);
  function addAuthority(name: string): void {
    setAuthorities((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setAuthoritiesError(null);
  }
  // Text typed in the picker but never picked (code review R1-ADV-FE-1,
  // R2-FE-6): never dropped silently. One rule (useTypedOrgText) writes the
  // note under the picker and decides Save: text naming exactly one entry is
  // added as a pick would be; any other text refuses the save, saying why.
  const authoritiesPicker = useRef<OrgPickerHandle>(null);
  const authorityText = useTypedOrgText(orgList, HOUSING_AUTHORITY_KINDS, authoritiesPicker);
  /** The authorities to save with the typed text settled, or null when Save is refused. */
  function settleTypedAuthority(): string[] | null {
    const typed = authorityText.settle();
    if (refusesSave(typed)) {
      authorityText.focus();
      return null;
    }
    if (typed.status !== 'resolved') return authorities;
    addAuthority(typed.name);
    return authorities.includes(typed.name) ? authorities : [...authorities, typed.name];
  }
  const [beds, setBeds] = useState(numStr(unit.beds));
  const [baths, setBaths] = useState(numStr(unit.baths));
  // Voucher sizes accepted (D4): the recorded sizes the picker has a chip for;
  // any other stored value is listed under the chips and dropped by the save.
  const [storedSizes] = useState(() => splitVoucherSizes(unit.voucher_size_accepted));
  const [voucherSizes, setVoucherSizes] = useState<number[]>(storedSizes.sizes);
  const [rentMin, setRentMin] = useState(numStr(unit.rent_min));
  const [rentMax, setRentMax] = useState(numStr(unit.rent_max));
  const [paymentStandard, setPaymentStandard] = useState(numStr(unit.payment_standard));
  const [subzone, setSubzone] = useState(str(unit.subzone));
  const [washerDryer, setWasherDryer] = useState(str(unit.washer_dryer));
  const [utilities, setUtilities] = useState(str(unit.utilities));
  const [accessibility, setAccessibility] = useState(str(unit.accessibility));
  const [leaseTerms, setLeaseTerms] = useState(str(unit.lease_terms));
  const [listingLink, setListingLink] = useState(str(unit.listing_link));
  const [videoUrl, setVideoUrl] = useState(str(unit.video_url));
  const [sameDayRta, setSameDayRta] = useState(unit.same_day_rta === true);
  // The Requirements section (D1): the baseline is the INTERPRETED value, so a
  // legacy boolean `pets` shows as No pets / "Allowed" and is never re-sent
  // untouched; buildRequirementPatch diffs against it.
  const [initialRequirements] = useState(() => requirementFormValuesFromUnit(unit));
  const [requirements, setRequirements] = useState<RequirementFormValues>(initialRequirements);
  const [applicationProcess, setApplicationProcess] = useState(str(unit.application_process));
  const [notes, setNotes] = useState(str(unit.notes));

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

  // The tags the authorities picker, the voucher sizes and the address parts
  // point at (D10).
  const uid = useId();
  const authoritiesTagId = `${uid}-authorities-tag`;
  const voucherTagId = `${uid}-voucher-tag`;
  const addressTagId = `${uid}-address-tag`;

  /** Diff a number field: unchanged -> skip; cleared -> leave untouched (beds,
   *  baths, rent and the payment standard are not clearable); else validate
   *  finite >= 0. Returns false on a validation failure. The requirement
   *  amounts clear through buildRequirementPatch, the voucher sizes through
   *  the picker. */
  function addNumber(
    patch: Record<string, unknown>,
    key: keyof UnitItem,
    value: string,
    initial: string,
    label: string,
  ): boolean {
    if (value === initial) return true;
    if (value.trim() === '') return true;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      setError(`${label} must be a number 0 or greater.`);
      return false;
    }
    patch[key as string] = n;
    return true;
  }

  /** `authoritiesNow`: the picker's list as Save settled it (settleTypedAuthority). */
  function buildPatch(authoritiesNow: string[]): Record<string, unknown> | null {
    const patch: Record<string, unknown> = {};
    if (subzone !== str(unit.subzone)) patch['subzone'] = subzone;
    // '' for "Not recorded" -> the server REMOVEs it (D3).
    if (washerDryer !== str(unit.washer_dryer)) patch['washer_dryer'] = washerDryer;
    if (utilities !== str(unit.utilities)) patch['utilities'] = utilities;
    if (accessibility !== str(unit.accessibility)) patch['accessibility'] = accessibility;
    if (leaseTerms !== str(unit.lease_terms)) patch['lease_terms'] = leaseTerms;
    if (listingLink !== str(unit.listing_link)) patch['listing_link'] = listingLink;
    if (videoUrl !== str(unit.video_url)) patch['video_url'] = videoUrl;
    // same_day_rta - a boolean toggle; send when it differs from the stored value.
    if (sameDayRta !== (unit.same_day_rta === true)) patch['same_day_rta'] = sameDayRta;
    if (applicationProcess !== str(unit.application_process)) {
      patch['application_process'] = applicationProcess;
    }
    if (notes !== str(unit.notes)) patch['notes'] = notes;

    if (!addNumber(patch, 'beds', beds, numStr(unit.beds), 'Beds')) return null;
    if (!addNumber(patch, 'baths', baths, numStr(unit.baths), 'Baths')) return null;
    if (!addNumber(patch, 'rent_min', rentMin, numStr(unit.rent_min), 'Rent min')) return null;
    if (!addNumber(patch, 'rent_max', rentMax, numStr(unit.rent_max), 'Rent max')) return null;
    if (!addNumber(patch, 'payment_standard', paymentStandard, numStr(unit.payment_standard), 'Payment standard')) {
      return null;
    }

    // D4: the picker's list, sent when it changed - or when the stored value
    // held a size the picker has no chip for (dropped now, as the line under
    // the chips said). Emptied, it sends null: the property falls back to its
    // bedroom count wherever a voucher size is read.
    const sizes = voucherSizesPatchValue(unit.voucher_size_accepted, voucherSizes);
    if (sizes !== undefined) patch['voucher_size_accepted'] = sizes;

    // The eight requirement items (D1): only the changed keys; the save that
    // checks "One month's rent" also sends the amount as null.
    const req = buildRequirementPatch(initialRequirements, requirements);
    if (!req.ok) {
      setError(req.error);
      return null;
    }
    Object.assign(patch, req.patch);

    // Housing authorities - the picker's list, sent only when it changed. The
    // baseline is the SYNTHESIZED list, so a legacy `jurisdiction` value that
    // the operator leaves untouched stays put instead of being re-sent (and an
    // unchanged list is never refused, spec 2026-10-06 D5); the retired
    // `jurisdiction` / `accepted_programs` keys are never written again (both
    // are server-side tombstones - app/src/lib/unitFields.ts).
    if (JSON.stringify(authoritiesNow) !== JSON.stringify(authoritiesOf(unit))) {
      patch['accepted_authorities'] = authoritiesNow;
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
    const authoritiesNow = settleTypedAuthority();
    if (authoritiesNow === null) return; // refused: the picker says why
    const patch = buildPatch(authoritiesNow);
    if (patch === null) return; // a validation error was set
    if (Object.keys(patch).length === 0) {
      onClose(); // nothing changed
      return;
    }
    setSaving(true);
    try {
      const updated = await updateUnit(unit.unitId, patch);
      onSaved(updated);
    } catch (err) {
      // A refused authority (422 org_not_on_list, spec D5): say why under the
      // picker, from the body - never the raw code.
      const refused = orgNotOnListBody(err);
      if (refused !== null) {
        setAuthoritiesError(notOnListMessage(refused));
        setSaving(false);
        return;
      }
      // Spec 2026-10-20 D5: the property changed under the save (its landlord or
      // requirement record moved). The form stays open with what staff typed;
      // the patch holds only the changed keys, so saving again is safe.
      if (err instanceof ApiError && err.status === 409 && err.code === 'property_changed') {
        setError(PROPERTY_CHANGED);
        setSaving(false);
        return;
      }
      // D1: the save would leave one month's rent AND a fixed amount (a
      // colleague ticked One month's rent after this form opened, and this save
      // sent an amount). Say so; the form stays open with what staff typed.
      if (err instanceof ApiError && err.status === 400 && err.code === 'deposit_conflict') {
        setError(DEPOSIT_CONFLICT);
        setSaving(false);
        return;
      }
      setError("Couldn't save - please try again.");
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
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </>
      }
    >
      <form id="listing-edit-form" className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        <FlyerLegend audience="property" />

        <div className={styles.row}>
          <OrgPicker
            ref={authoritiesPicker}
            multiple
            label="Housing authorities"
            kinds={HOUSING_AUTHORITY_KINDS}
            entries={orgList.entries}
            loading={orgListUnknown(orgList)}
            disabled={authorityText.disabled}
            value={authorities}
            onChange={(next) => {
              setAuthorities(next);
              setAuthoritiesError(null);
            }}
            onPendingTextChange={authorityText.onPendingTextChange}
            pendingNote={authorityText.note}
            onRequestAdd={setAddingAuthority}
            error={
              authorityText.refusal ??
              authoritiesError ??
              (orgList.error ? orgListLoadError(HOUSING_AUTHORITY_KINDS) : null)
            }
            errorAttempt={authorityText.refusalAttempt}
            className={styles.field}
            labelClassName={styles.label}
            labelAside={
              <FlyerTag
                id={authoritiesTagId}
                visibility={formFieldVisibility('Housing authorities')}
                audience="property"
              />
            }
            describedBy={authoritiesTagId}
          />
        </div>

        <div className={styles.row}>
          <TaggedField label="Beds" visibility={formFieldVisibility('Beds')} audience="property">
            {(control) => (
              <input
                {...control}
                className={styles.input}
                type="number"
                min={0}
                step={1}
                value={beds}
                onChange={(e) => setBeds(e.target.value)}
              />
            )}
          </TaggedField>
          <TaggedField label="Baths" visibility={formFieldVisibility('Baths')} audience="property">
            {(control) => (
              <input
                {...control}
                className={styles.input}
                type="number"
                min={0}
                step={0.5}
                value={baths}
                onChange={(e) => setBaths(e.target.value)}
              />
            )}
          </TaggedField>
        </div>

        <VoucherSizePicker
          value={voucherSizes}
          invalid={storedSizes.invalid}
          onChange={setVoucherSizes}
          labelAside={
            <FlyerTag
              id={voucherTagId}
              visibility={formFieldVisibility('Voucher sizes accepted')}
              audience="property"
            />
          }
          describedBy={voucherTagId}
        />

        <div className={styles.row}>
          <TaggedField label="Rent min" visibility={formFieldVisibility('Rent min')} audience="property">
            {(control) => (
              <input
                {...control}
                className={styles.input}
                type="number"
                min={0}
                step={1}
                value={rentMin}
                onChange={(e) => setRentMin(e.target.value)}
              />
            )}
          </TaggedField>
          <TaggedField label="Rent max" visibility={formFieldVisibility('Rent max')} audience="property">
            {(control) => (
              <input
                {...control}
                className={styles.input}
                type="number"
                min={0}
                step={1}
                value={rentMax}
                onChange={(e) => setRentMax(e.target.value)}
              />
            )}
          </TaggedField>
        </div>

        <TaggedField label="Payment standard" visibility={formFieldVisibility('Payment standard')} audience="property">
          {(control) => (
            <input
              {...control}
              className={styles.input}
              type="number"
              min={0}
              step={1}
              value={paymentStandard}
              onChange={(e) => setPaymentStandard(e.target.value)}
            />
          )}
        </TaggedField>

        <div className={styles.fieldset}>
          <TaggedGroupLabel
            label="Address"
            visibility={formFieldVisibility('Address')}
            audience="property"
            tagId={addressTagId}
          />
          <label className={styles.field}>
            <span className={styles.srLabel}>Street address</span>
            <input
              className={styles.input}
              value={line1}
              onChange={(e) => setLine1(e.target.value)}
              placeholder="Street address"
              autoComplete="off"
              aria-describedby={addressTagId}
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
              aria-describedby={addressTagId}
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
                aria-describedby={addressTagId}
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
                aria-describedby={addressTagId}
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
                aria-describedby={addressTagId}
              />
            </label>
          </div>
        </div>

        <div className={styles.row}>
          <TaggedField label="Subzone" visibility={formFieldVisibility('Subzone')} audience="property">
            {(control) => (
              <input
                {...control}
                className={styles.input}
                value={subzone}
                onChange={(e) => setSubzone(e.target.value)}
                placeholder="e.g. E8"
                autoComplete="off"
              />
            )}
          </TaggedField>
          <TaggedField label="Washer / dryer" visibility={formFieldVisibility('Washer / dryer')} audience="property">
            {(control) => (
              <select
                {...control}
                className={styles.input}
                value={washerDryer}
                onChange={(e) => setWasherDryer(e.target.value)}
              >
                <option value="">Not recorded</option>
                {WASHER_DRYER_VALUES.map((v) => (
                  <option key={v} value={v}>
                    {WASHER_DRYER_LABELS[v]}
                  </option>
                ))}
              </select>
            )}
          </TaggedField>
        </div>

        <TaggedField
          label="Tenant-paid utilities"
          visibility={formFieldVisibility('Tenant-paid utilities')}
          audience="property"
          publicNote
        >
          {(control) => (
            <input
              {...control}
              className={styles.input}
              value={utilities}
              onChange={(e) => setUtilities(e.target.value)}
              placeholder="e.g. Electric and gas"
              autoComplete="off"
            />
          )}
        </TaggedField>

        <TaggedField label="Accessibility" visibility={formFieldVisibility('Accessibility')} audience="property" publicNote>
          {(control) => (
            <input
              {...control}
              className={styles.input}
              value={accessibility}
              onChange={(e) => setAccessibility(e.target.value)}
              placeholder="e.g. Ground floor"
              autoComplete="off"
            />
          )}
        </TaggedField>

        <TaggedField label="Lease terms" visibility={formFieldVisibility('Lease terms')} audience="property" publicNote>
          {(control) => (
            <input
              {...control}
              className={styles.input}
              value={leaseTerms}
              onChange={(e) => setLeaseTerms(e.target.value)}
              placeholder="e.g. 12-month minimum, month-to-month after"
              autoComplete="off"
            />
          )}
        </TaggedField>

        <TaggedField
          label="Public listing link"
          visibility={formFieldVisibility('Public listing link')}
          audience="property"
        >
          {(control) => (
            <input
              {...control}
              className={styles.input}
              value={listingLink}
              onChange={(e) => setListingLink(e.target.value)}
              placeholder="https://..."
              autoComplete="off"
            />
          )}
        </TaggedField>

        <TaggedField label="Video URL" visibility={formFieldVisibility('Video URL')} audience="property">
          {(control) => (
            <input
              {...control}
              className={styles.input}
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="https://... (tour video)"
              autoComplete="off"
            />
          )}
        </TaggedField>

        <TaggedCheckbox
          label="Same-day RTA"
          visibility={formFieldVisibility('Same-day RTA')}
          audience="property"
          checked={sameDayRta}
          onChange={setSameDayRta}
        />

        <h3 className={styles.sectionHeading}>Requirements</h3>
        <RequirementsFields values={requirements} onChange={setRequirements} audience="property" />

        <TaggedField
          label="Application process"
          visibility={formFieldVisibility('Application process')}
          audience="property"
        >
          {(control) => (
            <textarea
              {...control}
              className={styles.textarea}
              value={applicationProcess}
              onChange={(e) => setApplicationProcess(e.target.value)}
              rows={2}
            />
          )}
        </TaggedField>

        <TaggedField label="Notes" visibility={formFieldVisibility('Notes')} audience="property">
          {(control) => (
            <textarea
              {...control}
              className={styles.textarea}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. No dishwasher"
              rows={3}
            />
          )}
        </TaggedField>

        {error !== null ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </form>
      {addingAuthority !== null ? (
        <NewOrgDialog
          kind="housing_authority"
          text={addingAuthority}
          mode="field"
          onUse={(ref) => {
            // The server's own answer: counted as on the list at once, even
            // when this form's list was read before the name joined it
            // (code review R1-ADV-FE-7).
            orgList.noteAdded(ref);
            addAuthority(ref.name);
            setAddingAuthority(null);
          }}
          onAdded={(entry) => {
            // Counted as on the list at once: no "Not on the list" flash on its chip.
            orgList.noteAdded(entry);
            addAuthority(entry.name);
            setAddingAuthority(null);
          }}
          onClose={() => setAddingAuthority(null)}
        />
      ) : null}
    </Modal>
  );
}
