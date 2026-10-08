// CaseworkersList - Contacts > Caseworkers (spec 2026-10-06 D18, D19; ruling
// R4-12). Its own page, not a ContactsList filter: "a caseworker" is a partner
// whose role satisfies isCaseworkerRole, and the server has no role filter, so
// the page reads every live partner (getAllContacts type=partner) and keeps the
// caseworkers client-side. Organization chips are built the way the Tenants
// page builds its housing authority chips (normalized keys, the most frequent
// spelling as the label, Not recorded last; URL param `org`). Below them,
// "Possible caseworkers" (GET /api/contacts/possible-caseworkers - one server
// read of three partitions, ONLY this page reads it): each row says why it is
// there and offers "Make caseworker" (the conversion dialog) and "Not a
// caseworker" (a confirm, then a permanent dismissal). The route is excluded
// from the page profiler (docs/issues/perf-pages-contacts-caseworkers-surface.md).
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  dismissPossibleCaseworker,
  getAllContacts,
  listPossibleCaseworkers,
  type Contact,
  type PossibleCaseworkerRow,
  type PossibleSignal,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { CaseworkerDialog } from '../contact/CaseworkerDialog.js';
import { isCaseworkerContact } from '../contact/caseworkerRole.js';
import { Modal } from '../contact/Modal.js';
import { CONTACT_TYPE_LABEL, displayKind } from '../contact/contactProfile.js';
import { contactDisplayName, formatPhone } from '../contact/format.js';
import { ContactsFilterTabs } from './ContactsList.js';
import { ChipGroup } from './FilterChips.js';
import {
  NONE_KEY,
  NONE_LABEL,
  displaySpelling,
  normalizeAuthorityKey,
  type FacetOption,
} from './tenantFacets.js';
import listStyles from './ContactsList.module.css';
import styles from './CaseworkersList.module.css';

/** Why a row is on the Possible list - one staff label per signal (plan 3.9). */
export const SIGNAL_LABEL: Readonly<Record<PossibleSignal, string>> = {
  role_mentions: 'Role mentions caseworker',
  ai_note: 'AI noted caseworker',
  relationship: 'Linked as a caseworker',
  partner_no_role: 'Partner with no role',
};

export const NO_CASEWORKERS = 'No caseworkers yet.';
export const DISMISS_FAILED = "Couldn't hide this contact - please try again.";

/** One read's outcome, tagged with the generation it answers. */
type Loaded<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T };

/** Read once per `generation` (bumped after a conversion). A read for an
 *  earlier generation is never shown as this one's; state is set only in the
 *  promise callbacks (the useContacts idiom). `load` must be module-level. */
function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, generation: number): Loaded<T> {
  const [state, setState] = useState<{ generation: number; result: Loaded<T> } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setState({ generation, result: { status: 'ready', value } });
      },
      () => {
        if (!controller.signal.aborted) setState({ generation, result: { status: 'error' } });
      },
    );
    return () => controller.abort();
  }, [load, generation]);
  return state !== null && state.generation === generation ? state.result : { status: 'loading' };
}

function byName(a: Contact, b: Contact): number {
  const an = contactDisplayName(a.firstName, a.lastName, a.phone).toLowerCase();
  const bn = contactDisplayName(b.firstName, b.lastName, b.phone).toLowerCase();
  return an < bn ? -1 : an > bn ? 1 : a.contactId < b.contactId ? -1 : 1;
}

const loadCaseworkers = (signal: AbortSignal): Promise<Contact[]> =>
  getAllContacts({ type: 'partner' }, signal).then((partners) =>
    partners.filter((c) => isCaseworkerContact(c)).sort(byName),
  );
const loadPossible = (signal: AbortSignal): Promise<PossibleCaseworkerRow[]> => listPossibleCaseworkers(signal);

/** The recorded organization, or null (a blank or whitespace-only value counts
 *  as unrecorded, the Tenants authority rule). */
function organizationOf(c: Contact): string | null {
  const raw = c.organization;
  return typeof raw === 'string' && normalizeAuthorityKey(raw) !== '' ? raw : null;
}

/** The Organization chips: one per normalized key, labelled by the most
 *  frequent spelling, sorted by key, then Not recorded - or none at all when
 *  no caseworker has an organization (the group shows its empty line). */
export function organizationOptions(caseworkers: readonly Contact[]): FacetOption[] {
  const byKey = new Map<string, Map<string, number>>();
  let unrecorded = 0;
  for (const c of caseworkers) {
    const raw = organizationOf(c);
    if (raw === null) {
      unrecorded += 1;
      continue;
    }
    const key = normalizeAuthorityKey(raw);
    const spellings = byKey.get(key) ?? new Map<string, number>();
    spellings.set(raw, (spellings.get(raw) ?? 0) + 1);
    byKey.set(key, spellings);
  }
  if (byKey.size === 0) return [];
  const options: FacetOption[] = [...byKey.entries()]
    .map(([key, spellings]) => ({
      key,
      label: displaySpelling(spellings),
      count: [...spellings.values()].reduce((sum, n) => sum + n, 0),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  options.push({ key: NONE_KEY, label: NONE_LABEL, count: unrecorded });
  return options;
}

function matchesOrganization(c: Contact, keys: ReadonlySet<string>): boolean {
  if (keys.size === 0) return true;
  const raw = organizationOf(c);
  return raw === null ? keys.has(NONE_KEY) : keys.has(normalizeAuthorityKey(raw));
}

const NO_CONTACTS: Contact[] = [];

export function CaseworkersList(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  // Bumped after a conversion: the new caseworker joins the list and leaves
  // the Possible list, so both are read again.
  const [generation, setGeneration] = useState(0);
  const caseworkers = useLoad(loadCaseworkers, generation);
  const possible = useLoad(loadPossible, generation);
  // Rows "Not a caseworker" dismissed: the server answered, no re-read needed.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [converting, setConverting] = useState<PossibleCaseworkerRow | null>(null);
  const [dismissing, setDismissing] = useState<PossibleCaseworkerRow | null>(null);
  const [dismissBusy, setDismissBusy] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const possibleHeadingId = useId();

  const all = caseworkers.status === 'ready' ? caseworkers.value : NO_CONTACTS;
  const options = useMemo(() => organizationOptions(all), [all]);
  // A key no chip carries (a stale or hand-typed link) is pruned before it
  // can filter: a selection nobody can see or clear must not empty the list.
  const selected = useMemo(() => {
    const valid = new Set(options.map((o) => o.key));
    const keys = new Set<string>();
    for (const raw of searchParams.getAll('org')) if (valid.has(raw)) keys.add(raw);
    return keys;
  }, [searchParams, options]);
  const visible = all.filter((c) => matchesOrganization(c, selected));

  /** Write the selection, MERGING the query string; replace, not push. */
  function updateSelection(next: ReadonlySet<string>): void {
    const params = new URLSearchParams(searchParams);
    params.delete('org');
    for (const key of next) params.append('org', key);
    setSearchParams(params, { replace: true });
  }

  function toggle(key: string): void {
    const next = new Set(selected);
    if (!next.delete(key)) next.add(key);
    updateSelection(next);
  }

  async function onHide(): Promise<void> {
    if (dismissing === null || dismissBusy) return;
    const id = dismissing.contactId;
    setDismissBusy(true);
    setDismissError(null);
    try {
      await dismissPossibleCaseworker(id);
      setHidden((prev) => new Set([...prev, id]));
      setDismissing(null);
    } catch {
      setDismissError(DISMISS_FAILED);
    } finally {
      setDismissBusy(false);
    }
  }

  const rowName = (r: PossibleCaseworkerRow): string => contactDisplayName(r.firstName, r.lastName, r.phone);
  const possibleRows = possible.status === 'ready' ? possible.value.filter((r) => !hidden.has(r.contactId)) : [];

  return (
    <div className={listStyles.page}>
      <div className={listStyles.header}>
        <h1 className={listStyles.title}>Caseworkers</h1>
      </div>
      <p className={listStyles.sub}>All records filtered to caseworkers.</p>

      <ContactsFilterTabs active="caseworkers" tenantSearch="" />

      {caseworkers.status === 'ready' && all.length > 0 ? (
        <div className={styles.controls}>
          <ChipGroup
            label="Organization"
            emptyLine={options.length === 0 ? 'No organizations recorded yet' : null}
            options={options}
            selected={selected}
            onToggle={toggle}
            onClear={() => updateSelection(new Set())}
          />
        </div>
      ) : null}

      {caseworkers.status === 'loading' ? <Spinner center /> : null}
      {caseworkers.status === 'error' ? (
        <p className={listStyles.error} role="alert">
          We couldn&apos;t load caseworkers. Please try again.
        </p>
      ) : null}
      {caseworkers.status === 'ready' && all.length === 0 ? <p className={styles.note}>{NO_CASEWORKERS}</p> : null}
      {caseworkers.status === 'ready' && all.length > 0 ? (
        visible.length > 0 ? (
          <ul className={listStyles.rows} aria-label="Caseworkers">
            {visible.map((c) => {
              const org = organizationOf(c);
              return (
                <li key={c.contactId} className={listStyles.rowItem}>
                  <Link to={`/contacts/${c.contactId}`} className={listStyles.row}>
                    <span className={listStyles.name}>{contactDisplayName(c.firstName, c.lastName, c.phone)}</span>
                    <span className={listStyles.meta}>
                      {org !== null ? <span className={styles.org}>{org}</span> : null}
                      <span className={listStyles.phone}>{formatPhone(c.phone)}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={listStyles.noMatches}>No caseworkers match the selected filters.</p>
        )
      ) : null}

      <section className={styles.possible} aria-labelledby={possibleHeadingId}>
        <h2 className={styles.subheading} id={possibleHeadingId}>
          Possible caseworkers
        </h2>
        {possible.status === 'loading' ? <Spinner center /> : null}
        {possible.status === 'error' ? (
          <p className={styles.error} role="alert">
            We couldn&apos;t load possible caseworkers. Please try again.
          </p>
        ) : null}
        {possible.status === 'ready' && possibleRows.length === 0 ? (
          <p className={styles.note}>No possible caseworkers right now.</p>
        ) : null}
        {possibleRows.length > 0 ? (
          <ul className={styles.possibleRows} aria-label="Possible caseworkers">
            {possibleRows.map((row) => {
              const name = rowName(row);
              return (
                <li key={row.contactId} className={styles.possibleRow}>
                  <Link to={`/contacts/${row.contactId}`} className={styles.possibleName}>
                    {name}
                  </Link>
                  <span className={listStyles.badge}>{displayKind(row, (t) => CONTACT_TYPE_LABEL[t])}</span>
                  {row.phone !== undefined ? <span className={listStyles.phone}>{formatPhone(row.phone)}</span> : null}
                  <span className={styles.signals}>
                    {row.signals.map((s) => (
                      <span key={s} className={styles.signal}>
                        {SIGNAL_LABEL[s]}
                      </span>
                    ))}
                  </span>
                  <span className={styles.actions}>
                    <Button
                      variant="primary"
                      size="sm"
                      type="button"
                      aria-label={`Make ${name} a caseworker`}
                      onClick={() => setConverting(row)}
                    >
                      Make caseworker
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      aria-label={`${name} is not a caseworker`}
                      onClick={() => {
                        setDismissError(null);
                        setDismissing(row);
                      }}
                    >
                      Not a caseworker
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      {converting !== null ? (
        <CaseworkerDialog
          contactId={converting.contactId}
          name={rowName(converting)}
          onConverted={() => {
            setConverting(null);
            setGeneration((n) => n + 1);
          }}
          onClose={() => setConverting(null)}
        />
      ) : null}

      {/* "Not a caseworker" (ruling R4-09): dismissal is permanent with no UI
          undo, so it asks first. The dialog's name is the question. */}
      {dismissing !== null ? (
        <Modal
          title={`Hide ${rowName(dismissing)} from Possible caseworkers?`}
          onClose={dismissBusy ? () => {} : () => setDismissing(null)}
          footer={
            <>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setDismissing(null)}
                disabled={dismissBusy}
              >
                Cancel
              </Button>
              <Button variant="primary" size="sm" type="button" onClick={() => void onHide()} disabled={dismissBusy}>
                Hide
              </Button>
            </>
          }
        >
          <p className={styles.note}>This can&apos;t be undone in the app.</p>
          {dismissError !== null ? (
            <p className={styles.error} role="alert">
              {dismissError}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
