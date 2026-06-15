// BoardNew (M1.10) — open a new case (route '/boards/new'). A minimal create
// form (mirrors UnitForm's create shape): pick the tenant (tenant contacts), pick
// the listing (units), and an optional placement tag. On submit → createCase →
// navigate to the case detail. Staff-facing: we say "listing", never "property".
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ApiError,
  createCase,
  listContacts,
  listUnits,
  useApi,
  type Contact,
  type UnitItem,
} from '../api/index.js';
import { Button, ChevronLeftIcon, Field, Input, useToast } from '../ui/index.js';
import { formatAddress } from './records/Address.js';
import { contactName } from './records/records.js';
import { formatPhone } from './thread/identity.js';
import styles from './records/records.module.css';

/** An honest tenant picker label: a real name when known, else the phone, else
 *  the raw id (never a fabricated name). */
function contactPickerLabel(c: Contact): string {
  const name = contactName(c);
  if (name !== undefined) return name;
  if (typeof c.phone === 'string' && c.phone.length > 0) return formatPhone(c.phone);
  return c.contactId;
}

/** A listing picker label: its one-line address, else jurisdiction, else id. */
function unitPickerLabel(u: UnitItem): string {
  return formatAddress(u.address) ?? u.jurisdiction ?? `Listing ${u.unitId}`;
}

export default function BoardNew(): React.JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();

  // Pickers: tenant contacts (for tenantId) and units (for unitId). Fetched once.
  const { data: tenantPage } = useApi(
    (signal) => listContacts({ type: 'tenant', limit: 100 }, signal),
    [],
  );
  const { data: unitsPage } = useApi((signal) => listUnits({ limit: 100 }, signal), []);

  const tenants = useMemo(() => tenantPage?.contacts ?? [], [tenantPage]);
  const units = useMemo(() => unitsPage?.units ?? [], [unitsPage]);

  const [tenantId, setTenantId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [placementTag, setPlacementTag] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setError(undefined);
    if (tenantId.trim().length === 0) {
      setError('Pick the tenant this case is for.');
      return;
    }
    if (unitId.trim().length === 0) {
      setError('Pick the listing this case is on.');
      return;
    }
    const tag = placementTag.trim();
    setSubmitting(true);
    try {
      const created = await createCase({
        tenantId: tenantId.trim(),
        unitId: unitId.trim(),
        ...(tag.length > 0 && { placement_tag: tag }),
      });
      toast.success('Case opened');
      navigate(`/boards/${encodeURIComponent(created.caseId)}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not open the case.';
      setError(msg);
      toast.error('Could not open the case');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={styles.page} aria-labelledby="board-new-heading">
      <Link to="/boards" className={styles.back}>
        <ChevronLeftIcon size={16} />
        Back to boards
      </Link>

      <header className={styles.header}>
        <div>
          <h1 id="board-new-heading">New case</h1>
          <p className={styles.lead}>One case is one tenant–listing deal. Pick both to begin.</p>
        </div>
      </header>

      <div className={styles.surface}>
        <form className={styles.form} noValidate onSubmit={(e) => void handleSubmit(e)}>
          <Field label="Tenant" required hint="The tenant this case is for.">
            {({ id }) => (
              <select
                id={id}
                className={styles.select}
                value={tenantId}
                disabled={submitting}
                onChange={(e) => setTenantId(e.target.value)}
              >
                <option value="">Select a tenant…</option>
                {tenants.map((c) => (
                  <option key={c.contactId} value={c.contactId}>
                    {contactPickerLabel(c)}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Listing" required hint="The listing this case is on.">
            {({ id }) => (
              <select
                id={id}
                className={styles.select}
                value={unitId}
                disabled={submitting}
                onChange={(e) => setUnitId(e.target.value)}
              >
                <option value="">Select a listing…</option>
                {units.map((u) => (
                  <option key={u.unitId} value={u.unitId}>
                    {unitPickerLabel(u)}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Placement tag" hint="Optional label for this deal (shown on the card).">
            {({ id }) => (
              <Input
                id={id}
                value={placementTag}
                disabled={submitting}
                placeholder="Optional"
                onChange={(e) => setPlacementTag(e.target.value)}
              />
            )}
          </Field>

          {error !== undefined && (
            <p className={styles.formError} role="alert">
              {error}
            </p>
          )}

          <div className={styles.formActions}>
            <Button type="submit" loading={submitting}>
              Open case
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={submitting}
              onClick={() => navigate('/boards')}
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}
