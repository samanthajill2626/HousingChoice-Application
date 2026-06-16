// UnitForm — create or edit a unit (routes '/units/new' and
// '/units/:unitId/edit'). One component drives both: in edit mode it loads the
// unit first and seeds the form; in create mode it starts blank.
//
// The unit intake form covers every contract field. Numbers are validated
// client-side (non-negative, integer beds; rent_min ≤ rent_max). landlordId is
// REQUIRED by the backend — we satisfy it with a "Landlord" picker over
// landlord contacts. The primary voice contact (CO1 per-unit primary voice
// contact, pending founder confirmation — note kept off-screen) is a separate
// optional picker over landlord + pm contacts. Media + accepted programs are
// simple newline / comma lists. The address is the shared structured Address.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  createUnit,
  getUnit,
  listContacts,
  updateUnit,
  useApi,
  type Address,
  type Contact,
  type CreateUnitBody,
  type UnitItem,
  type UnitPatch,
  type UnitStatus,
} from '../api/index.js';
import { Button, ChevronLeftIcon, EmptyState, Field, Input, Spinner, Textarea, useToast } from '../ui/index.js';
import { AddressFields } from './records/Address.js';
import { contactName } from './records/records.js';
import { formatPhone } from './thread/identity.js';
import styles from './records/records.module.css';

const STATUS_OPTIONS: { value: UnitStatus; label: string }[] = [
  { value: 'available', label: 'Available' },
  { value: 'placed', label: 'Placed' },
  { value: 'inactive', label: 'Inactive' },
];

interface FormState {
  landlordId: string;
  status: UnitStatus;
  address: Address;
  jurisdiction: string;
  acceptedPrograms: string; // comma-separated
  beds: string;
  baths: string;
  area: string;
  subzone: string;
  rentMin: string;
  rentMax: string;
  paymentStandard: string;
  deposit: string;
  lif: string;
  utilities: string;
  accessibility: string;
  pets: string;
  priority: string;
  listingLink: string;
  media: string; // newline-separated URLs/keys
  tourProcess: string;
  applicationProcess: string;
  primaryVoiceContact: string;
}

function emptyForm(): FormState {
  return {
    landlordId: '',
    status: 'available',
    address: {},
    jurisdiction: '',
    acceptedPrograms: '',
    beds: '',
    baths: '',
    area: '',
    subzone: '',
    rentMin: '',
    rentMax: '',
    paymentStandard: '',
    deposit: '',
    lif: '',
    utilities: '',
    accessibility: '',
    pets: '',
    priority: '',
    listingLink: '',
    media: '',
    tourProcess: '',
    applicationProcess: '',
    primaryVoiceContact: '',
  };
}

function fromUnit(unit: UnitItem): FormState {
  const numStr = (n: number | undefined): string => (typeof n === 'number' ? String(n) : '');
  // Back-compat: a pre-contract dev record may carry a plain-string address.
  // We can't reliably parse that into parts, so AddressFields starts empty for
  // such records (no data migration); structured addresses seed as-is.
  const address: Address = typeof unit.address === 'object' && unit.address !== null ? unit.address : {};
  return {
    landlordId: unit.landlordId ?? '',
    status: unit.status,
    address,
    jurisdiction: unit.jurisdiction ?? '',
    acceptedPrograms: (unit.accepted_programs ?? []).join(', '),
    beds: numStr(unit.beds),
    baths: numStr(unit.baths),
    area: unit.area ?? '',
    subzone: unit.subzone ?? '',
    rentMin: numStr(unit.rent_min),
    rentMax: numStr(unit.rent_max),
    paymentStandard: numStr(unit.payment_standard),
    deposit: numStr(unit.deposit),
    lif: unit.lif ?? '',
    utilities: unit.utilities ?? '',
    accessibility: unit.accessibility ?? '',
    pets: unit.pets ?? '',
    priority: unit.priority ?? '',
    listingLink: unit.listing_link ?? '',
    media: (unit.media ?? []).join('\n'),
    tourProcess: unit.tour_process ?? '',
    applicationProcess: unit.application_process ?? '',
    primaryVoiceContact: unit.primary_voice_contact ?? '',
  };
}

/** Parse a non-negative number string; returns undefined when blank, NaN flag
 *  when invalid. */
function parseNum(raw: string): { value?: number; invalid: boolean } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { invalid: false };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return { invalid: true };
  return { value: n, invalid: false };
}

export default function UnitForm(): React.JSX.Element {
  const { unitId } = useParams<{ unitId: string }>();
  const editing = unitId !== undefined;
  const navigate = useNavigate();

  // In edit mode, load the unit first.
  const { data: unit, loading, error } = useApi(
    (signal) => (editing ? getUnit(unitId, signal) : Promise.resolve(undefined)),
    [unitId, editing],
  );

  if (editing && loading && unit === undefined) {
    return (
      <section className={styles.page}>
        <Spinner center label="Loading listing" />
      </section>
    );
  }

  if (editing && (error || !unit)) {
    const notFound = error?.status === 404 || error?.code === 'unit_not_found';
    return (
      <section className={styles.page}>
        <EmptyState
          title={notFound ? 'Listing not found' : "Couldn't load this listing"}
          description="The listing couldn't be loaded for editing."
          action={
            <Button variant="secondary" onClick={() => navigate('/units')}>
              Back to listings
            </Button>
          }
        />
      </section>
    );
  }

  return <UnitEditor {...(unit !== undefined && { unit })} />;
}

function UnitEditor({ unit }: { unit?: UnitItem }): React.JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const editing = unit !== undefined;

  const [form, setForm] = useState<FormState>(() => (unit ? fromUnit(unit) : emptyForm()));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  // Contacts for the pickers: landlords (for landlordId) and landlord+pm (for
  // the primary voice contact). Fetched once.
  const { data: landlordPage } = useApi((signal) => listContacts({ type: 'landlord', limit: 100 }, signal), []);
  const { data: pmPage } = useApi((signal) => listContacts({ type: 'pm', limit: 100 }, signal), []);

  const landlords = useMemo(() => landlordPage?.contacts ?? [], [landlordPage]);
  const voiceContacts = useMemo(
    () => [...(landlordPage?.contacts ?? []), ...(pmPage?.contacts ?? [])],
    [landlordPage, pmPage],
  );

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
    setFieldErrors((fe) => (fe[key] !== undefined ? { ...fe, [key]: undefined } : fe));
  }

  function validate(): { ok: boolean; errors: Partial<Record<keyof FormState, string>> } {
    const errors: Partial<Record<keyof FormState, string>> = {};
    if (form.landlordId.trim().length === 0) {
      errors.landlordId = 'Pick the landlord this listing belongs to.';
    }
    // Only the string-valued numeric fields (address is structured, not a
    // string) — keeps form[key] a string for parseNum.
    type NumericFieldKey = 'beds' | 'baths' | 'rentMin' | 'rentMax' | 'paymentStandard' | 'deposit';
    const numericFields: [NumericFieldKey, string][] = [
      ['beds', 'Beds'],
      ['baths', 'Baths'],
      ['rentMin', 'Min rent'],
      ['rentMax', 'Max rent'],
      ['paymentStandard', 'Payment standard'],
      ['deposit', 'Deposit'],
    ];
    for (const [key, label] of numericFields) {
      if (parseNum(form[key]).invalid) {
        errors[key] = `${label} must be a non-negative number.`;
      }
    }
    const min = parseNum(form.rentMin);
    const max = parseNum(form.rentMax);
    if (min.value !== undefined && max.value !== undefined && min.value > max.value) {
      errors.rentMax = 'Max rent must be at least the min rent.';
    }
    return { ok: Object.keys(errors).length === 0, errors };
  }

  function buildBody(): CreateUnitBody {
    const programs = form.acceptedPrograms
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const media = form.media
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const body: CreateUnitBody = {
      landlordId: form.landlordId.trim(),
      status: form.status,
    };
    const str = (k: keyof CreateUnitBody, v: string): void => {
      const t = v.trim();
      if (t.length > 0) (body[k] as string) = t;
    };
    // Structured address: trim each part, keep only non-empty ones; omit the
    // whole field when nothing was entered.
    const address: Address = {};
    for (const key of ['line1', 'line2', 'city', 'state', 'zip'] as const) {
      const t = (form.address[key] ?? '').trim();
      if (t.length > 0) address[key] = t;
    }
    if (Object.keys(address).length > 0) body.address = address;
    str('jurisdiction', form.jurisdiction);
    str('area', form.area);
    str('subzone', form.subzone);
    str('lif', form.lif);
    str('utilities', form.utilities);
    str('accessibility', form.accessibility);
    str('pets', form.pets);
    str('priority', form.priority);
    str('listing_link', form.listingLink);
    str('tour_process', form.tourProcess);
    str('application_process', form.applicationProcess);
    str('primary_voice_contact', form.primaryVoiceContact);
    if (programs.length > 0) body.accepted_programs = programs;
    if (media.length > 0) body.media = media;
    const num = (k: keyof CreateUnitBody, raw: string): void => {
      const { value } = parseNum(raw);
      if (value !== undefined) (body[k] as number) = value;
    };
    num('beds', form.beds);
    num('baths', form.baths);
    num('rent_min', form.rentMin);
    num('rent_max', form.rentMax);
    num('payment_standard', form.paymentStandard);
    num('deposit', form.deposit);
    return body;
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setError(undefined);
    const { ok, errors } = validate();
    if (!ok) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      const body = buildBody();
      if (editing && unit) {
        const patch: UnitPatch = body;
        const updated = await updateUnit(unit.unitId, patch);
        toast.success('Listing saved');
        navigate(`/units/${encodeURIComponent(updated.unitId)}`);
      } else {
        const created = await createUnit(body);
        toast.success('Listing created');
        navigate(`/units/${encodeURIComponent(created.unitId)}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the listing.');
      toast.error('Could not save the listing');
    } finally {
      setSubmitting(false);
    }
  }

  const heading = editing ? 'Edit listing' : 'New listing';

  return (
    <section className={styles.page} aria-labelledby="unit-form-heading">
      <Link to={editing && unit ? `/units/${encodeURIComponent(unit.unitId)}` : '/units'} className={styles.back}>
        <ChevronLeftIcon size={16} />
        {editing ? 'Back to listing' : 'Back to listings'}
      </Link>

      <header className={styles.header}>
        <div>
          <h1 id="unit-form-heading">{heading}</h1>
          <p className={styles.lead}>Capture what we know — fields can be filled in over time.</p>
        </div>
      </header>

      <div className={styles.surface}>
        <form className={styles.form} noValidate onSubmit={(e) => void handleSubmit(e)}>
          <Field
            label="Landlord"
            required
            hint="The landlord this listing belongs to."
            {...(fieldErrors.landlordId !== undefined && { error: fieldErrors.landlordId })}
          >
            {({ id }) => (
              <select
                id={id}
                className={styles.select}
                value={form.landlordId}
                disabled={submitting}
                onChange={(e) => set('landlordId', e.target.value)}
              >
                <option value="">Select a landlord…</option>
                {landlords.map((c) => (
                  <option key={c.contactId} value={c.contactId}>
                    {contactPickerLabel(c)}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Status">
            {({ id }) => (
              <select
                id={id}
                className={styles.select}
                value={form.status}
                disabled={submitting}
                onChange={(e) => set('status', e.target.value as UnitStatus)}
              >
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <AddressFields
            value={form.address}
            disabled={submitting}
            onChange={(next) => set('address', next)}
          />

          <div className={styles.fieldRow}>
            <Field label="Jurisdiction">
              {({ id }) => (
                <Input id={id} value={form.jurisdiction} disabled={submitting} onChange={(e) => set('jurisdiction', e.target.value)} />
              )}
            </Field>
            <Field label="Accepted programs" hint="Comma-separated (e.g. HCV, VASH)">
              {({ id }) => (
                <Input id={id} value={form.acceptedPrograms} disabled={submitting} onChange={(e) => set('acceptedPrograms', e.target.value)} />
              )}
            </Field>
          </div>

          <div className={styles.fieldRow}>
            <Field label="Beds" {...(fieldErrors.beds !== undefined && { error: fieldErrors.beds })}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="number" inputMode="numeric" min={0} step={1} value={form.beds} invalid={invalid} disabled={submitting} {...(describedBy !== undefined && { 'aria-describedby': describedBy })} onChange={(e) => set('beds', e.target.value)} />
              )}
            </Field>
            <Field label="Baths" {...(fieldErrors.baths !== undefined && { error: fieldErrors.baths })}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="number" inputMode="decimal" min={0} step={0.5} value={form.baths} invalid={invalid} disabled={submitting} {...(describedBy !== undefined && { 'aria-describedby': describedBy })} onChange={(e) => set('baths', e.target.value)} />
              )}
            </Field>
          </div>

          <div className={styles.fieldRow}>
            <Field label="Area">
              {({ id }) => (
                <Input id={id} value={form.area} disabled={submitting} onChange={(e) => set('area', e.target.value)} />
              )}
            </Field>
            <Field label="Subzone">
              {({ id }) => (
                <Input id={id} value={form.subzone} disabled={submitting} onChange={(e) => set('subzone', e.target.value)} />
              )}
            </Field>
          </div>

          <div className={styles.fieldRow}>
            <Field label="Min rent" {...(fieldErrors.rentMin !== undefined && { error: fieldErrors.rentMin })}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="number" inputMode="numeric" min={0} step={1} value={form.rentMin} invalid={invalid} disabled={submitting} {...(describedBy !== undefined && { 'aria-describedby': describedBy })} onChange={(e) => set('rentMin', e.target.value)} />
              )}
            </Field>
            <Field label="Max rent" {...(fieldErrors.rentMax !== undefined && { error: fieldErrors.rentMax })}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="number" inputMode="numeric" min={0} step={1} value={form.rentMax} invalid={invalid} disabled={submitting} {...(describedBy !== undefined && { 'aria-describedby': describedBy })} onChange={(e) => set('rentMax', e.target.value)} />
              )}
            </Field>
          </div>

          <div className={styles.fieldRow}>
            <Field label="Payment standard" {...(fieldErrors.paymentStandard !== undefined && { error: fieldErrors.paymentStandard })}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="number" inputMode="numeric" min={0} step={1} value={form.paymentStandard} invalid={invalid} disabled={submitting} {...(describedBy !== undefined && { 'aria-describedby': describedBy })} onChange={(e) => set('paymentStandard', e.target.value)} />
              )}
            </Field>
            <Field label="Deposit" {...(fieldErrors.deposit !== undefined && { error: fieldErrors.deposit })}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="number" inputMode="numeric" min={0} step={1} value={form.deposit} invalid={invalid} disabled={submitting} {...(describedBy !== undefined && { 'aria-describedby': describedBy })} onChange={(e) => set('deposit', e.target.value)} />
              )}
            </Field>
          </div>

          <div className={styles.fieldRow}>
            <Field label="LIF">
              {({ id }) => (
                <Input id={id} value={form.lif} disabled={submitting} onChange={(e) => set('lif', e.target.value)} />
              )}
            </Field>
            <Field label="Utilities">
              {({ id }) => (
                <Input id={id} value={form.utilities} disabled={submitting} onChange={(e) => set('utilities', e.target.value)} />
              )}
            </Field>
          </div>

          <div className={styles.fieldRow}>
            <Field label="Accessibility">
              {({ id }) => (
                <Input id={id} value={form.accessibility} disabled={submitting} onChange={(e) => set('accessibility', e.target.value)} />
              )}
            </Field>
            <Field label="Pets">
              {({ id }) => (
                <Input id={id} value={form.pets} disabled={submitting} onChange={(e) => set('pets', e.target.value)} />
              )}
            </Field>
          </div>

          <div className={styles.fieldRow}>
            <Field label="Priority">
              {({ id }) => (
                <Input id={id} value={form.priority} disabled={submitting} onChange={(e) => set('priority', e.target.value)} />
              )}
            </Field>
            <Field label="Listing link">
              {({ id }) => (
                <Input id={id} type="url" inputMode="url" value={form.listingLink} disabled={submitting} onChange={(e) => set('listingLink', e.target.value)} />
              )}
            </Field>
          </div>

          {/* CO1 per-unit primary voice contact, pending founder
              confirmation — that internal note stays in code, off the screen. */}
          <Field label="Primary contact for calls" hint="A landlord or property manager to call about this listing.">
            {({ id }) => (
              <select
                id={id}
                className={styles.select}
                value={form.primaryVoiceContact}
                disabled={submitting}
                onChange={(e) => set('primaryVoiceContact', e.target.value)}
              >
                <option value="">No primary contact yet</option>
                {voiceContacts.map((c) => (
                  <option key={c.contactId} value={c.contactId}>
                    {contactPickerLabel(c)}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Media" hint="One URL or storage key per line.">
            {({ id }) => (
              <Textarea id={id} rows={3} value={form.media} disabled={submitting} onChange={(e) => set('media', e.target.value)} />
            )}
          </Field>

          <Field label="Tour process">
            {({ id }) => (
              <Textarea id={id} rows={3} value={form.tourProcess} disabled={submitting} onChange={(e) => set('tourProcess', e.target.value)} />
            )}
          </Field>

          <Field label="Application process">
            {({ id }) => (
              <Textarea id={id} rows={3} value={form.applicationProcess} disabled={submitting} onChange={(e) => set('applicationProcess', e.target.value)} />
            )}
          </Field>

          {error !== undefined && (
            <p className={styles.formError} role="alert">
              {error}
            </p>
          )}

          <div className={styles.formActions}>
            <Button type="submit" loading={submitting}>
              {editing ? 'Save listing' : 'Create listing'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={submitting}
              onClick={() => navigate(editing && unit ? `/units/${encodeURIComponent(unit.unitId)}` : '/units')}
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}

/** A picker label that is honest: a real name when known, else the phone, else
 *  the raw id. */
function contactPickerLabel(c: Contact): string {
  const name = contactName(c);
  if (name !== undefined) return name;
  if (typeof c.phone === 'string' && c.phone.length > 0) return formatPhone(c.phone);
  return c.contactId;
}
