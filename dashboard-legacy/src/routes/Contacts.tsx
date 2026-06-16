// Contacts — the records list (route '/contacts', authenticated).
//
// A type filter (default Tenants), an optional status filter, and a phone
// search box. The backend REQUIRES `type` unless an exact `phone=` lookup is
// used — so when the search box has a value we send ONLY phone (exact match);
// otherwise we list by the selected type (+ optional status). Rows link to the
// contact detail. Honest identity: an un-triaged contact shows its phone + a
// "needs review" chip rather than a fabricated name.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listContacts,
  useApi,
  type Contact,
  type ContactType,
} from '../api/index.js';
import { Avatar, Badge, Button, ContactsIcon, EmptyState, Field, Input, PlusIcon, Spinner } from '../ui/index.js';
import { formatPhone } from './thread/identity.js';
import {
  CONTACT_TYPES,
  CONTACT_TYPE_LABEL,
  contactName,
  contactNeedsReview,
} from './records/records.js';
import styles from './records/records.module.css';

const PAGE_LIMIT = 50;

export default function Contacts(): React.JSX.Element {
  const [type, setType] = useState<ContactType>('tenant');
  const [status, setStatus] = useState<'' | 'needs_review' | 'active'>('');
  // The text in the search box (controlled) and the committed query we fetch on
  // (only updated on submit) — so we don't fire a request per keystroke.
  const [phoneInput, setPhoneInput] = useState('');
  const [phoneQuery, setPhoneQuery] = useState('');

  const searching = phoneQuery.trim().length > 0;

  const { data, loading, error, refetch } = useApi(
    (signal) =>
      searching
        ? listContacts({ phone: phoneQuery.trim(), limit: PAGE_LIMIT }, signal)
        : listContacts(
            { type, ...(status !== '' && { status }), limit: PAGE_LIMIT },
            signal,
          ),
    // Re-fetch when any committed filter changes.
    [searching, phoneQuery, type, status],
  );

  const contacts = data?.contacts ?? [];

  function handleSearch(e: React.FormEvent): void {
    e.preventDefault();
    setPhoneQuery(phoneInput);
  }

  function clearSearch(): void {
    setPhoneInput('');
    setPhoneQuery('');
  }

  return (
    <section className={styles.page} aria-labelledby="contacts-heading">
      <header className={styles.header}>
        <div>
          <h1 id="contacts-heading">Contacts</h1>
          <p className={styles.lead}>Tenants, landlords, property managers, and team members.</p>
        </div>
        <Button as="a" href="/contacts/new" size="sm">
          <PlusIcon size={16} />
          New contact
        </Button>
      </header>

      <div className={styles.toolbar}>
        <form className={styles.filters} onSubmit={handleSearch} noValidate>
          <Field label="Type">
            {({ id }) => (
              <select
                id={id}
                className={styles.select}
                value={type}
                disabled={searching}
                onChange={(e) => setType(e.target.value as ContactType)}
              >
                {CONTACT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CONTACT_TYPE_LABEL[t]}
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
                value={status}
                disabled={searching}
                onChange={(e) => setStatus(e.target.value as '' | 'needs_review' | 'active')}
              >
                <option value="">Any status</option>
                <option value="needs_review">Needs review</option>
                <option value="active">Active</option>
              </select>
            )}
          </Field>

          <Field label="Search by phone" hint="Exact match (e.g. +13135551234)">
            {({ id, describedBy }) => (
              <Input
                id={id}
                type="search"
                inputMode="tel"
                placeholder="+1 555 555 1234"
                value={phoneInput}
                {...(describedBy !== undefined && { 'aria-describedby': describedBy })}
                onChange={(e) => setPhoneInput(e.target.value)}
              />
            )}
          </Field>

          <div>
            <Button type="submit" variant="secondary">
              Search
            </Button>
          </div>
        </form>

        {searching && (
          <p className={styles.lead}>
            Showing exact-phone results for <strong>{phoneQuery}</strong>.{' '}
            <button type="button" className={styles.back} onClick={clearSearch}>
              Clear search
            </button>
          </p>
        )}
      </div>

      <ContactsList
        contacts={contacts}
        loading={loading && data === undefined}
        error={error !== undefined}
        onRetry={refetch}
        searching={searching}
      />
    </section>
  );
}

function ContactsList({
  contacts,
  loading,
  error,
  onRetry,
  searching,
}: {
  contacts: Contact[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  searching: boolean;
}): React.JSX.Element {
  if (loading) return <Spinner center label="Loading contacts" />;

  if (error) {
    return (
      <EmptyState
        icon={<ContactsIcon size={28} />}
        title="Couldn't load contacts"
        description="Something went wrong reaching the server."
        action={
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }

  if (contacts.length === 0) {
    return (
      <EmptyState
        icon={<ContactsIcon size={28} />}
        title={searching ? 'No contact with that phone' : 'No contacts yet'}
        description={
          searching
            ? 'Try a different number, or clear the search to browse by type.'
            : 'Contacts appear here as they come in, or add one with New contact.'
        }
      />
    );
  }

  return (
    <ul className={styles.list} aria-label="Contacts">
      {contacts.map((c) => (
        <ContactRow key={c.contactId} contact={c} />
      ))}
    </ul>
  );
}

function ContactRow({ contact }: { contact: Contact }): React.JSX.Element {
  const name = useMemo(() => contactName(contact), [contact]);
  const review = contactNeedsReview(contact);
  const phone = formatPhone(contact.phone);

  return (
    <li>
      <Link to={`/contacts/${encodeURIComponent(contact.contactId)}`} className={styles.cardLink}>
        <div className={styles.rowHead}>
          <Avatar name={review ? undefined : name} review={review} />
          <div className={styles.rowMain}>
            <span className={styles.rowTitle}>{name ?? phone}</span>
            <span className={styles.rowSub}>
              {CONTACT_TYPE_LABEL[contact.type]}
              {name !== undefined ? ` · ${phone}` : ''}
              {typeof contact.voucherSize === 'number' ? ` · ${contact.voucherSize} bed` : ''}
            </span>
          </div>
        </div>
        {review && (
          <div className={styles.cues}>
            <Badge tone="review" dot title="Identity not yet triaged">
              Needs review
            </Badge>
          </div>
        )}
      </Link>
    </li>
  );
}
