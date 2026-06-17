// ContactsList — the Contacts list views (§IA: Contacts parent ▸ Tenants /
// Landlords / Unknown). ONE component used by four routes; the `filter` prop
// (route-driven in App.tsx) selects which audience the page shows and its
// heading. FIRST-PASS / pending-design: a clean, conventional, accessible
// records list (heading · search box · a table-style list of rows linking to
// the contact detail page) in the new design language (tokens + CSS Modules).
// Not the final visual design — deliberately low-risk.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Contact, ContactType } from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { contactDisplayName, formatPhone } from '../contact/format.js';
import { useContacts, type ContactsFilter } from './useContacts.js';
import styles from './ContactsList.module.css';

export interface ContactsListProps {
  /** Which audience to show — route-driven (App.tsx). */
  filter: ContactsFilter;
}

/** The page heading per filter. */
const HEADING: Record<ContactsFilter, string> = {
  all: 'Contacts',
  tenant: 'Tenants',
  landlord: 'Landlords',
  unknown: 'Unknown',
};

/** A human label for a contact's type badge. `pm` reads as "Property mgr". */
const TYPE_LABEL: Record<ContactType, string> = {
  tenant: 'Tenant',
  landlord: 'Landlord',
  pm: 'Property mgr',
  team_member: 'Team',
  unknown: 'Unknown',
};

/** Status label, e.g. 'active' → "Active"; empty stays empty. */
function statusLabel(status: string | undefined): string {
  if (!status) return '';
  return status.charAt(0).toUpperCase() + status.slice(1);
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
  const status = statusLabel(contact.status);
  return (
    <li className={styles.rowItem}>
      <Link to={`/contacts/${contact.contactId}`} className={styles.row}>
        <span className={styles.name}>{name}</span>
        <span className={styles.badge}>{TYPE_LABEL[contact.type]}</span>
        <span className={styles.phone}>{phone}</span>
        {status ? <span className={styles.status}>{status}</span> : null}
      </Link>
    </li>
  );
}

export function ContactsList({ filter }: ContactsListProps): React.JSX.Element {
  const { status, contacts } = useContacts(filter);
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => searchKey(c).includes(q));
  }, [contacts, query]);

  const heading = HEADING[filter];

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{heading}</h1>
      <p className={styles.sub}>
        Showing the first page of records{filter === 'all' ? '' : ` filtered to ${heading.toLowerCase()}`}.
      </p>

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
    </div>
  );
}
