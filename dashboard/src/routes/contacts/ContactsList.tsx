// ContactsList — the Contacts list views (Contacts parent ▸ Tenants / Landlords
// / Unknown). ONE component used by four routes; the `filter` prop (route-driven
// in App.tsx) selects the audience + heading. On-page FILTER TABS link to the
// same four routes (the nav links are shortcuts; the active tab mirrors `filter`),
// a NEW CONTACT button opens the create dialog (ContactCreateForm), and each row's
// badge is `displayKind` = role ?? type — a custom kind ("Case worker") shows its
// role while filing under its base type. Accessible records list (heading - search
// - rows linking to the contact detail page); tokens + CSS Modules. See
// 2026-06-18-extensible-contact-creation-design.md.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { type Contact } from '../../api/index.js';
import { Button, Spinner, StatusBadge } from '../../ui/index.js';
import { contactDisplayName, formatPhone, humanize } from '../contact/format.js';
import { CONTACT_TYPE_LABEL, displayKind } from '../contact/contactProfile.js';
import { ContactCreateForm } from '../contact/ContactCreateForm.js';
import { TenantFilters } from './TenantFilters.js';
import {
  applySelection,
  applyToParams,
  buildFacets,
  factsLine,
  parseSelection,
  type TenantSelection,
} from './tenantFacets.js';
import { useContacts, type ContactsFilter } from './useContacts.js';
import styles from './ContactsList.module.css';

export interface ContactsListProps {
  /** Which audience to show - route-driven (App.tsx). */
  filter: ContactsFilter;
}

/** The page heading per filter. */
const HEADING: Record<ContactsFilter, string> = {
  all: 'Contacts',
  tenant: 'Tenants',
  landlord: 'Landlords',
  unknown: 'Unknown',
  deleted: 'Deleted',
};

/** On-page filter tabs. Each is a link to the SAME route the nav uses, so the URL
 *  stays the source of truth: switching here and the nav shortcuts land on the
 *  identical filtered view (and the active tab reflects the current `filter`).
 *  'Deleted' surfaces soft-deleted contacts (restore from their detail page). */
const FILTERS: { filter: ContactsFilter; label: string; to: string }[] = [
  { filter: 'all', label: 'All', to: '/contacts' },
  { filter: 'tenant', label: 'Tenants', to: '/contacts/tenants' },
  { filter: 'landlord', label: 'Landlords', to: '/contacts/landlords' },
  { filter: 'unknown', label: 'Unknown', to: '/contacts/unknown' },
  { filter: 'deleted', label: 'Deleted', to: '/contacts/deleted' },
];

/** Non-tenant status label (the coarse needs_review|active lifecycle): a naive
 *  capitalize. Tenants render a StatusBadge instead (the F1 tenant-status map). */
function statusLabel(status: string | undefined): string {
  if (!status) return '';
  return humanize(status);
}

/** An unconstrained selection - used to derive the SELECTION-INDEPENDENT
 *  authority option keys (see `validAuthorityKeys`). */
const NO_SELECTION: TenantSelection = {
  voucher: new Set<string>(),
  ha: new Set<string>(),
  porting: false,
};

/** "No search query active", for that same selection-independent derivation. */
const MATCH_ALL = (): boolean => true;

/** The lowercased haystack a row is searched against (name + phone). */
function searchKey(contact: Contact): string {
  return [
    contact.firstName,
    contact.lastName,
    contact.phone,
    formatPhone(contact.phone),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function Row({
  contact,
  showFacts,
}: {
  contact: Contact;
  /** Tenant rows outside the Deleted view carry the eligibility facts. */
  showFacts: boolean;
}): React.JSX.Element {
  const name = contactDisplayName(contact.firstName, contact.lastName, contact.phone);
  const phone = formatPhone(contact.phone);
  const facts = showFacts ? factsLine(contact) : null;
  const porting = showFacts && contact.porting === true;
  return (
    <li className={styles.rowItem}>
      <Link
        to={`/contacts/${contact.contactId}`}
        // .factsRow keys the wide-pane sacrifice order, so it goes on whenever ANY
        // chip was added - a porting-only tenant still gains a fourth unshrinkable
        // chip. PER-ROW, not per-route: facts render on /contacts (All) too.
        className={`${styles.row} ${facts !== null || porting ? styles.factsRow : ''}`}
      >
        <span className={styles.name}>{name}</span>
        {/* Meta chips grouped so on a tight content pane they wrap to their own
         *  line below the name instead of crushing it (container query in CSS). */}
        <span className={styles.meta}>
          <span className={styles.badge}>{displayKind(contact, (t) => CONTACT_TYPE_LABEL[t])}</span>
          <span className={styles.phone}>{phone}</span>
          {contact.type === 'tenant' && contact.status ? (
            <StatusBadge kind="tenant" status={contact.status} />
          ) : statusLabel(contact.status) ? (
            <span className={styles.status}>{statusLabel(contact.status)}</span>
          ) : null}
          {/* ONE text span (one accessible-name token stream, nothing hidden), the
           *  only compressible child of .meta, with the full value on `title`. */}
          {facts !== null ? (
            <span className={styles.facts} title={facts}>
              {facts}
            </span>
          ) : null}
          {porting ? (
            <span className={styles.porting} title="Tenant is porting">
              Porting
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

export function ContactsList({ filter }: ContactsListProps): React.JSX.Element {
  const { status, contacts } = useContacts(filter);
  // Deep-link filter: the Inbox/Today/conversation "unknown" links carry
  // `?phone=<E.164>` (e.g. /contacts/unknown?phone=%2B1404...). Seed the search
  // box from it — searchKey() indexes the raw phone, so the target row matches.
  // The component stays MOUNTED across the four filter routes (same element
  // position), so a mount-time-only read would miss later deep-links; the
  // effect re-seeds whenever the param value changes.
  const [searchParams, setSearchParams] = useSearchParams();
  const phoneParam = searchParams.get('phone') ?? '';
  const [query, setQuery] = useState(phoneParam);
  useEffect(() => {
    if (phoneParam) setQuery(phoneParam);
  }, [phoneParam]);
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();

  // The facet controls render - and APPLY - on the Tenants view only. Facet
  // params on any other view are inert: they filter nothing and no control shows.
  const isTenantView = filter === 'tenant';

  // The authority option keys, derived from the LOADED TENANTS ALONE (the option
  // list is selection-independent by design). A ghost `ha` key - a stale link, or
  // a hand-typed non-normalized `?ha=DCA` when the URL contract is the NORMALIZED
  // key - matches nobody, so it is pruned from the selection here: spec section 10
  // promises unknown values drop INDIVIDUALLY and a stale link never empties the
  // list. Pruning must precede buildFacets too, since a ghost left in the
  // selection zeroes the OTHER facet's counts. The URL is deliberately NOT
  // rewritten on mount; the next interaction re-serializes the pruned selection.
  const validAuthorityKeys = useMemo(
    () => new Set(buildFacets(contacts, NO_SELECTION, MATCH_ALL).authority.map((o) => o.key)),
    [contacts],
  );
  const selection = useMemo<TenantSelection>(() => {
    const parsed = parseSelection(searchParams);
    const ha = new Set<string>();
    for (const key of parsed.ha) if (validAuthorityKeys.has(key)) ha.add(key);
    return { ...parsed, ha };
  }, [searchParams, validAuthorityKeys]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const queried = q ? contacts.filter((c) => searchKey(c).includes(q)) : contacts;
    return isTenantView ? applySelection(queried, selection) : queried;
  }, [contacts, q, isTenantView, selection]);

  // Counts are contextual (the query + the other facets), so the query predicate
  // goes IN rather than the already-filtered rows.
  const facets = useMemo(
    () => buildFacets(contacts, selection, (c) => (q ? searchKey(c).includes(q) : true)),
    [contacts, selection, q],
  );

  /** Serialize a new selection, MERGING the query string (`?phone=` survives). */
  function updateSelection(next: TenantSelection): void {
    const params = new URLSearchParams(searchParams);
    applyToParams(params, next);
    // Replace, not push: Back leaves the page rather than walking chip toggles.
    setSearchParams(params, { replace: true });
  }

  const heading = HEADING[filter];

  function handleCreated(c: Contact): void {
    setCreateOpen(false);
    void navigate('/contacts/' + c.contactId);
  }

  function handleOpenExisting(id: string): void {
    setCreateOpen(false);
    void navigate('/contacts/' + id);
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>{heading}</h1>
        <Button variant="primary" size="sm" type="button" onClick={() => setCreateOpen(true)}>
          New contact
        </Button>
      </div>
      <p className={styles.sub}>
        All records{filter === 'all' ? '' : ` filtered to ${heading.toLowerCase()}`}.
      </p>

      <nav className={styles.filters} aria-label="Filter contacts">
        {FILTERS.map((f) => (
          <Link
            key={f.filter}
            // ONLY the Tenants tab carries facet params, and only while the Tenants
            // view is active - so a carried param can neither silently filter
            // another audience nor survive as invisible state. Re-clicking the
            // active tab preserves the facets; leaving the view drops them (the URL
            // is the only state carrier - spec section 10).
            to={
              f.filter === 'tenant'
                ? { pathname: f.to, search: isTenantView ? searchParams.toString() : '' }
                : f.to
            }
            className={`${styles.filter} ${f.filter === filter ? styles.filterActive : ''}`}
            {...(f.filter === filter && { 'aria-current': 'page' })}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {isTenantView && status === 'ready' ? (
        <TenantFilters model={facets} selection={selection} onChange={updateSelection} />
      ) : null}

      <div className={styles.search}>
        <label className={styles.searchLabel} htmlFor="contacts-search">
          Search contacts
        </label>
        <input
          id="contacts-search"
          type="search"
          className={styles.searchInput}
          placeholder="Search by name or phone"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={status !== 'ready'}
        />
      </div>

      {status === 'loading' ? <Spinner center /> : null}

      {status === 'error' ? (
        <p className={styles.error} role="alert">
          We couldn&apos;t load contacts. Please try again.
        </p>
      ) : null}

      {status === 'ready' && contacts.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No {heading.toLowerCase()} yet</p>
          <p className={styles.emptyBody}>Nothing here to show right now.</p>
        </div>
      ) : null}

      {status === 'ready' && contacts.length > 0 ? (
        visible.length > 0 ? (
          <ul
            className={`${styles.rows} ${isTenantView ? styles.tenantList : ''}`}
            aria-label={heading}
          >
            {visible.map((contact) => (
              <Row
                key={contact.contactId}
                contact={contact}
                showFacts={contact.type === 'tenant' && filter !== 'deleted'}
              />
            ))}
          </ul>
        ) : (
          <p className={styles.noMatches}>
            {/* The query message wins when both are active. Entity quotes, never
             *  literal curly ones - every new line here stays ASCII. */}
            {query.trim() ? (
              <>No matches for &ldquo;{query.trim()}&rdquo;.</>
            ) : (
              'No tenants match the selected filters.'
            )}
          </p>
        )
      ) : null}

      {createOpen ? (
        <ContactCreateForm
          candidates={contacts}
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
          onOpenExisting={handleOpenExisting}
        />
      ) : null}
    </div>
  );
}
