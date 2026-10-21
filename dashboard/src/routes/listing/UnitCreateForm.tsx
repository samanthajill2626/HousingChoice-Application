// UnitCreateForm - the "New property" dialog (Modal). Originates a unit under a
// landlord (POST /api/units). Mirrors PlacementCreateForm's locked/editable
// pattern: a pre-filled `landlordId` prop renders the owning landlord LOCKED
// read-only (the landlord-page entry point already knows the owner); with no
// prop, a landlord typeahead lets the caller pick one (the Properties-list entry).
//
// The fields mirror ListingEditForm (same fields, D10 order, flyer tags and CSS
// module), but this is a CREATE: only the non-empty fields are sent, and the
// server stamps the initial status ('setup') - status is NOT a writable field
// here. Navigation lives in the entry points: on a 201 the form calls onCreated
// and the caller closes + navigates (parity with ContactCreateForm /
// PlacementCreateForm).
//
// The landlord's requirements (spec 2026-10-20 D7): the Requirements section
// starts filled in from the chosen landlord's full record - the picked list
// entry (the landlord list holds full contacts), or, locked, a getContact read
// with loading / failure / Try again states and Create waiting while it loads -
// and the body carries the values it filled in as `requirements_snapshot` (D5).
// Only non-blank requirement fields are sent: a key left out counts as blank
// against the snapshot (plan 2.4), so a pre-filled field staff cleared still
// classifies as set on this property. A failed read sends no snapshot, so only
// what staff typed is recorded; Try again then fills in only the items staff
// left blank (code review R2D-7).
import { useEffect, useId, useRef, useState } from 'react';
import {
  createUnit,
  getContact,
  getAllContacts,
  type Contact,
  type CreateUnitBody,
  type RequirementsSnapshotWire,
  type UnitItem,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import { ContactSearchField, type ContactSearchValue } from '../contact/ContactSearchField.js';
import { landlordDisplayName } from '../contact/format.js';
import { contactTypeErrorMessage } from '../../lib/contactTypeErrors.js';
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
import {
  buildRequirementCreateFields,
  emptyRequirementFormValues,
  fillBlankRequirementItems,
  formFieldVisibility,
  requirementFormValuesFromLandlord,
  requirementsSnapshotOf,
  type RequirementFormValues,
} from './requirementForm.js';
import {
  REQUIREMENT_ITEM_IDS,
  WASHER_DRYER_LABELS,
  WASHER_DRYER_VALUES,
  isItemBlank,
  landlordItemValue,
} from './requirements.js';
import { RequirementsFields } from './RequirementsFields.js';
import { TaggedCheckbox, TaggedField, TaggedGroupLabel } from './TaggedField.js';
import { VoucherSizePicker } from './VoucherSizePicker.js';
import styles from './ListingEditForm.module.css';

export interface UnitCreateFormProps {
  /** Pre-fill + lock the owning landlord (the landlord-page entry point). */
  landlordId?: string;
  onClose: () => void;
  onCreated: (unit: UnitItem) => void;
}

const FORM_ID = 'unit-create-form';

/** What the Requirements section was filled in from (D7). */
interface FilledFrom {
  landlordId: string;
  /** <L> in the note: landlordDisplayName, the ONE landlord name rule the
   *  property Requirements card uses too (code review RD-9) - the contact page
   *  header's name, which this form's landlord picker shows as well (OR-33). */
  name: string;
  /** D5: sent as `requirements_snapshot` while this landlord is the body's. */
  snapshot: RequirementsSnapshotWire;
  /** C7: the note shows only when the landlord holds a requirement. */
  hasRequirements: boolean;
}

/** The section's values and the record of where they came from, for one landlord. */
function fillFromLandlord(c: Contact): { values: RequirementFormValues; filled: FilledFrom } {
  return {
    values: requirementFormValuesFromLandlord(c),
    filled: {
      landlordId: c.contactId,
      name: landlordDisplayName(c),
      snapshot: requirementsSnapshotOf(c),
      hasRequirements: REQUIREMENT_ITEM_IDS.some((id) => !isItemBlank(landlordItemValue(c, id))),
    },
  };
}

/** The LOCKED landlord's record read (D7). The picker path needs no read: 'done'. */
type LandlordRead = 'loading' | 'failed' | 'done';

export function UnitCreateForm({
  landlordId,
  onClose,
  onCreated,
}: UnitCreateFormProps): React.JSX.Element {
  // Landlord candidates for the picker (fetched on mount) + the locked-side label.
  const [landlords, setLandlords] = useState<Contact[]>([]);
  const [lockedLandlordLabel, setLockedLandlordLabel] = useState<string | null>(null);
  const [landlordPick, setLandlordPick] = useState<ContactSearchValue>({ name: '' });
  // D7: the locked landlord's full record (its requirements) - re-read by Try again.
  const [landlordRead, setLandlordRead] = useState<LandlordRead>(landlordId !== undefined ? 'loading' : 'done');
  const [readAttempt, setReadAttempt] = useState(0);
  const [filled, setFilled] = useState<FilledFrom | null>(null);
  const [requirements, setRequirements] = useState<RequirementFormValues>(emptyRequirementFormValues);

  // Property fields (mirror ListingEditForm; all optional on create).
  // The housing authorities the property takes: a multi-picker over the
  // stored list (spec 2026-10-06 D6). It replaced the retired single
  // `jurisdiction` field and the `accepted_programs` list (spec section 8).
  const orgList = useOrgList();
  const [authorities, setAuthorities] = useState<string[]>([]);
  const [authoritiesError, setAuthoritiesError] = useState<string | null>(null);
  // "Is this really new?" - rendered after the </form> (R5 ruling).
  const [addingAuthority, setAddingAuthority] = useState<string | null>(null);
  function addAuthority(name: string): void {
    setAuthorities((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setAuthoritiesError(null);
  }
  // Text typed in the picker but never picked (code review R1-ADV-FE-1,
  // R2-FE-6): one rule (useTypedOrgText) writes the note under the picker and
  // decides Create - text naming exactly one entry is sent as a pick would
  // be; any other text refuses to create, saying why under the picker. A
  // property is never created without the authority staff typed - not even
  // when the list failed to load (code review R3-FE-3): a failed re-read
  // settles against the list in hand, and with no list in hand Create
  // refuses until the text is cleared (the field stays usable while it
  // holds text).
  const authoritiesPicker = useRef<OrgPickerHandle>(null);
  const authorityText = useTypedOrgText(orgList, HOUSING_AUTHORITY_KINDS, authoritiesPicker);
  /** The authorities to send with the typed text settled, or null when Create is refused. */
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
  const [beds, setBeds] = useState('');
  const [baths, setBaths] = useState('');
  const [voucherSizes, setVoucherSizes] = useState<number[]>([]);
  const [rentMin, setRentMin] = useState('');
  const [rentMax, setRentMax] = useState('');
  const [paymentStandard, setPaymentStandard] = useState('');
  const [subzone, setSubzone] = useState('');
  const [washerDryer, setWasherDryer] = useState('');
  const [utilities, setUtilities] = useState('');
  const [accessibility, setAccessibility] = useState('');
  const [leaseTerms, setLeaseTerms] = useState('');
  const [listingLink, setListingLink] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [sameDayRta, setSameDayRta] = useState(false);
  const [applicationProcess, setApplicationProcess] = useState('');
  const [notes, setNotes] = useState('');

  // Address parts.
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [stateField, setStateField] = useState('');
  const [zip, setZip] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The tags the owner, the authorities picker, the voucher sizes and the
  // address parts point at (D10; the owner's per planner ruling C8).
  const uid = useId();
  const landlordTagId = `${uid}-landlord-tag`;
  const authoritiesTagId = `${uid}-authorities-tag`;
  const voucherTagId = `${uid}-voucher-tag`;
  const addressTagId = `${uid}-address-tag`;

  const landlordLocked = landlordId !== undefined;
  const resolvedLandlordId = landlordId ?? landlordPick.contactId;
  // D7: Create waits while the locked landlord's record loads.
  const canCreate = resolvedLandlordId !== undefined && !busy && landlordRead !== 'loading';

  // -- Fetch the landlord candidates + resolve a locked-side label on mount. --
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        // EVERY page. Landlords fit inside one page today, which is exactly why
        // this was easy to miss: it would have started dropping candidates
        // silently at 51, with nothing to distinguish a short list from a
        // complete one.
        const items = await getAllContacts({ type: 'landlord' }, ac.signal);
        if (ac.signal.aborted) return;
        setLandlords(items);
        if (landlordId !== undefined) {
          const hit = items.find((c) => c.contactId === landlordId);
          if (hit) setLockedLandlordLabel(landlordDisplayName(hit));
        }
      } catch {
        // Non-fatal: the picker stays empty; a locked side still submits.
      }
    })();
    return () => ac.abort();
  }, [landlordId]);

  // D7: the LOCKED landlord's full record - its label, and the requirements the
  // section starts with. Re-run by Try again (readAttempt).
  useEffect(() => {
    if (landlordId === undefined) return;
    const ac = new AbortController();
    void (async () => {
      try {
        const c = await getContact(landlordId, ac.signal);
        if (ac.signal.aborted) return;
        const fill = fillFromLandlord(c);
        setLockedLandlordLabel(fill.filled.name);
        // Code review R2D-7: only what staff left blank is filled in - after a
        // failed read the fields stayed usable, and Try again must not replace
        // what was typed (D7 replaces typed values only for a DIFFERENT
        // landlord pick). On the first read everything is blank, so the
        // section is the landlord's values. The snapshot stays the landlord's
        // values either way (D5).
        setRequirements((typed) => fillBlankRequirementItems(typed, fill.values));
        setFilled(fill.filled);
        setLandlordRead('done');
      } catch {
        if (!ac.signal.aborted) setLandlordRead('failed');
      }
    })();
    return () => ac.abort();
  }, [landlordId, readAttempt]);

  /** The picker path (D7): a pick of a DIFFERENT landlord refills the section
   *  from that landlord's record - the picker list holds it - replacing
   *  anything typed there. Re-picking the same landlord keeps what was typed. */
  function onPickLandlord(next: ContactSearchValue): void {
    setLandlordPick(next);
    if (next.contactId === undefined || next.contactId === filled?.landlordId) return;
    const picked = landlords.find((c) => c.contactId === next.contactId);
    if (picked === undefined) return;
    const fill = fillFromLandlord(picked);
    setRequirements(fill.values);
    setFilled(fill.filled);
  }

  function retryLandlordRead(): void {
    setLandlordRead('loading');
    setReadAttempt((n) => n + 1);
  }

  /** Add a number field to the body: blank -> skip; else validate finite >= 0.
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
   *  failure (an inline error was set). landlordId is guaranteed by canCreate.
   *  `authoritiesNow`: the picker's list as Create settled it. */
  function buildBody(authoritiesNow: string[]): CreateUnitBody | null {
    if (resolvedLandlordId === undefined) return null; // canCreate rules this out
    const body: CreateUnitBody = { landlordId: resolvedLandlordId };

    const addStr = (key: string, value: string): void => {
      const v = value.trim();
      if (v) body[key] = v;
    };
    addStr('subzone', subzone);
    addStr('utilities', utilities);
    addStr('accessibility', accessibility);
    addStr('lease_terms', leaseTerms);
    addStr('listing_link', listingLink);
    addStr('video_url', videoUrl);
    addStr('application_process', applicationProcess);
    addStr('notes', notes);
    // Only send a recorded washer / dryer; "Not recorded" -> omit (D3).
    if (washerDryer) body['washer_dryer'] = washerDryer;
    if (sameDayRta) body['same_day_rta'] = true;

    if (!addNumber(body, 'beds', beds, 'Beds')) return null;
    if (!addNumber(body, 'baths', baths, 'Baths')) return null;
    if (!addNumber(body, 'rent_min', rentMin, 'Rent min')) return null;
    if (!addNumber(body, 'rent_max', rentMax, 'Rent max')) return null;
    if (!addNumber(body, 'payment_standard', paymentStandard, 'Payment standard')) return null;
    // D4: the picked sizes as a list (ascending); none picked -> omit.
    if (voucherSizes.length > 0) body['voucher_size_accepted'] = voucherSizes;

    // The eight requirement items (D1): only the non-blank fields.
    const req = buildRequirementCreateFields(requirements);
    if (!req.ok) {
      setError(req.error);
      return null;
    }
    Object.assign(body, req.fields);
    // D5: the landlord's values this form filled in, while that landlord is the
    // body's. After a failed read nothing was filled in, so no snapshot goes.
    if (filled !== null && filled.landlordId === resolvedLandlordId) {
      body.requirements_snapshot = filled.snapshot;
    }

    // Housing authorities - the picked list names; send the array only when
    // non-empty. The retired `jurisdiction` / `accepted_programs` keys are
    // never written again (both are server-side tombstones -
    // app/src/lib/unitFields.ts).
    if (authoritiesNow.length > 0) body['accepted_authorities'] = authoritiesNow;

    // Address - send the object only when at least one part is filled. The server
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
    const authoritiesNow = settleTypedAuthority();
    if (authoritiesNow === null) return; // refused: the picker says why
    const body = buildBody(authoritiesNow);
    if (body === null) return; // a validation error was set
    setBusy(true);
    try {
      const unit = await createUnit(body);
      setBusy(false);
      onCreated(unit);
    } catch (err) {
      // A refused authority (422 org_not_on_list, spec D5): say why under the
      // picker, from the body - never the raw code.
      const refused = orgNotOnListBody(err);
      if (refused !== null) {
        setAuthoritiesError(notOnListMessage(refused));
        setBusy(false);
        return;
      }
      // caseworker-integrity I3 (spec section 4): the owning landlord was
      // refused - gone (404 landlord_not_found) or no longer a landlord (409
      // landlord_not_landlord). Say which, never the raw code.
      const typed = contactTypeErrorMessage(err);
      if (typed !== null) {
        setError(typed);
        setBusy(false);
        return;
      }
      setError("Couldn't create the property - please try again.");
      setBusy(false);
    }
  }

  // C6: <L> is the landlord's name (landlordDisplayName, code review RD-9 and
  // worklist OR-33) once either read has landed.
  const statusName = lockedLandlordLabel ?? 'the landlord';
  /** D7's status line for the locked read (plan 1.1 copy); '' once it landed. */
  const readStatus =
    landlordRead === 'loading'
      ? `Loading ${statusName}'s requirements...`
      : landlordRead === 'failed'
        ? `Couldn't load ${statusName}'s requirements, so this property starts without them. You can apply them from the landlord page later.`
        : '';
  const filledNote =
    landlordRead === 'done' && filled !== null && filled.landlordId === resolvedLandlordId && filled.hasRequirements
      ? `Filled in from ${filled.name}'s requirements. Change anything that is different for this property.`
      : null;

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
            {busy ? 'Creating...' : 'Create'}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        <FlyerLegend audience="property" />

        {/* Owning landlord (required; locked when the landlordId prop is set).
            Staff only (planner ruling C8: D10a's first row). */}
        <div className={styles.field}>
          <TaggedGroupLabel
            label="Owning landlord"
            visibility={formFieldVisibility('Owning landlord')}
            audience="property"
            tagId={landlordTagId}
          />
          {landlordLocked ? (
            // Read-only display of the pre-filled owner - the visible label above
            // provides its name; no landmark role (it groups no controls).
            <div className={styles.locked}>{lockedLandlordLabel ?? landlordId}</div>
          ) : (
            <ContactSearchField
              value={landlordPick}
              onChange={onPickLandlord}
              candidates={landlords}
              inputLabel="Owning landlord"
              describedBy={landlordTagId}
            />
          )}
        </div>

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
          invalid={[]}
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

        <div className={styles.sectionHead}>
          <h3 className={styles.sectionHeading}>Requirements</h3>
          {/* Code review R2D-6 (the RD-7 pattern): the locked landlord's read
              has ONE live region, mounted from the first render, whose TEXT
              changes - loading, then the failure (which also re-enables
              Create), then loading again on Try again, then empty - so
              assistive technology hears each change; a region inserted
              already filled may not be announced. It takes no space while
              empty. The picker path reads nothing, so it has none. */}
          {landlordLocked ? (
            <div className={readStatus !== '' ? styles.sectionStatus : undefined}>
              <p className={styles.hint} role="status">
                {readStatus}
              </p>
              {landlordRead === 'failed' ? (
                <Button variant="secondary" size="sm" type="button" onClick={retryLandlordRead}>
                  Try again
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {landlordRead !== 'loading' ? (
          <>
            {filledNote !== null ? <p className={styles.hint}>{filledNote}</p> : null}
            <RequirementsFields values={requirements} onChange={setRequirements} audience="property" />
          </>
        ) : null}

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
