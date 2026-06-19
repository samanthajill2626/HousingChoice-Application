// ContactsList — the Contacts list views (Contacts parent ▸ Tenants / Landlords
// / Unknown). ONE component used by four routes; the `filter` prop (route-driven
// in App.tsx) selects the audience + heading. On-page FILTER TABS link to the
// same four routes (the nav links are shortcuts; the active tab mirrors `filter`),
// a NEW CONTACT button opens the create dialog (ContactCreateForm), and each row's
// badge is `displayKind` = role ?? type — a custom kind ("Case worker") shows its
// role while filing under its base type. Accessible records list (heading · search
// · rows linking to the contact detail page); tokens + CSS Modules. See
// 2026-06-18-extensible-contact-creation-design.md.
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  TENANT_STATUS_LABELS,
  type Contact,
  type TenantStatus,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { contactDisplayName, formatPhone, humanize } from '../contact/format.js';
import { CONTACT_TYPE_LABEL, displayKind } from '../contact/contactProfile.js';
import { ContactCreateForm } from '../contact/ContactCreateForm.js';
import { useContacts, type ContactsFilter } from './useContacts.js';
import styles from './ContactsList.module.css';

export interface ContactsListProps {
  /** Which audience to show � route-driven (App.tsx). */
  filter: ContactsFilter;
}

/** The page heading per filter. */
const HEADING: Record<ContactsFilter, string> = {
  all: 'Contacts',
  tenant: 'Tenants',
  landlord: 'Landlords',
  unknown: 'Unknown',
};

/** On-page filter tabs. Each is a link to the SAME route the nav uses, so the URL
 *  stays the source of truth: switching here and the nav shortcuts land on the
 *  identical filtered view (and the active tab reflects the current `filter`). */
const FILTERS: { filter: ContactsFilter; label: string; to: string }[] = [
  { filter: 'all', label: 'All', to: '/contacts' },
  { filter: 'tenant', label: 'Tenants', to: '/contacts/tenants' },
  { filter: 'landlord', label: 'Landlords', to: '/contacts/landlords' },
  { filter: 'unknown', label: 'Unknown', to: '/contacts/unknown' },
];

/** Type-aware status label. For a tenant, look up the tenant-status label map
 *  (so 'needs_review' → "Needs review", 'on_hold' → "On hold"); otherwise a
 *  naive capitalize for the coarse needs_review|active lifecycle. Empty stays
 *  empty. */
function statusLabel(status: string | undefined, type: Contact['type']): string {
  if (!status) return '';
  if (type === 'tenant') {
    const label = TENANT_STATUS_LABELS[status as TenantStatus];
    if (label !== undefined) return label;
  }
  return humanize(status);
}

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

function Row({ contact }: { contact: Contact }): React.JSX.Element {
  const name = contactDisplayName(contact.firstName, contact.lastName, contact.phone);
  const phone = formatPhone(contact.phone);
  const status = statusLabel(contact.status, contact.type);
  return (
    <li className={styles.rowItem}>
      <Link to={`/contacts/${contact.contactId}`} className={styles.row}>
        <span className={styles.name}>{name}</span>
        <span className={styles.badge}>{displayKind(contact, (t) => CONTACT_TYPE_LABEL[t])}</span>
        <span className={styles.phone}>{phone}</span>
        {status ? <span className={styles.status}>{status}</span> : null}
      </Link>
    </li>
  );
}

export function ContactsList({ filter }: ContactsListProps): React.JSX.Element {
  const { status, contacts } = useContacts(filter);
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => searchKey(c).includes(q));
  }, [contacts, query]);

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
        Showing the first page of records{filter === 'all' ? '' : ` filtered to ${heading.toLowerCase()}`}.
      </p>

      <nav className={styles.filters} aria-label="Filter contacts">
        {FILTERS.map((f) => (
          <Link
            key={f.filter}
            to={f.to}
            className={`${styles.filter} ${f.filter === filter ? styles.filterActive : ''}`}
            {...(f.filter === filter && { 'aria-current': 'page' })}
          >
            {f.label}
          </Link>
        ))}
      </nav>

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
          <ul className={styles.rows} aria-label={heading}>
            {visible.map((contact) => (
              <Row key={contact.contactId} contact={contact} />
            ))}
          </ul>
        ) : (
          <p className={styles.noMatches}>No matches for &ldquo;{query.trim()}&rdquo;.</p>
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
