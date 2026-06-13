// ContactPanel — the contact side panel. Shows the contact details and hosts
// the needs-review TriageForm. Rendered into a side column on wide screens and
// into a Sheet on mobile (the parent picks the container).
//
// H1: the contact is fetched by the PARENT (Thread) and passed in as props, so
// the same fetched contact feeds the lifted header identity (the header shows
// the real name post-triage, not just the phone). When triage saves,
// onResolved() bubbles up so the parent refetches BOTH the conversation (the
// backend may have flipped its type) and the contact, and the header updates.
import { Avatar, Badge, EmptyState, Spinner } from '../../ui';
import { type ApiError, type Contact } from '../../api';
import { TriageForm } from './TriageForm';
import { contactFullName, formatPhone, isContactNeedsReview } from './identity';
import styles from './ContactPanel.module.css';

export interface ContactPanelProps {
  contactId: string | undefined;
  /** The contact, fetched by the parent (Thread) and shared with the header. */
  contact: Contact | undefined;
  /** True while the parent's contact fetch is in flight. */
  loading: boolean;
  /** The parent's contact-fetch error, if any. */
  error: ApiError | undefined;
  /** Called after triage saves with the updated contact (parent refetches convo+contact). */
  onResolved: (updated: Contact) => void;
}

const TYPE_LABEL: Record<string, string> = {
  tenant: 'Tenant',
  landlord: 'Landlord',
  pm: 'Property manager',
  team_member: 'Team member',
  unknown: 'Unknown',
};

export function ContactPanel({
  contactId,
  contact,
  loading,
  error,
  onResolved,
}: ContactPanelProps): React.JSX.Element {
  if (contactId === undefined) {
    return (
      <div className={styles.panel}>
        <EmptyState title="No contact linked" description="This conversation has no linked contact yet." />
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.panel}>
        <Spinner center label="Loading contact" />
      </div>
    );
  }

  if (error || !contact) {
    return (
      <div className={styles.panel}>
        <EmptyState
          title="Couldn't load contact"
          description="The contact details are unavailable right now."
        />
      </div>
    );
  }

  const name = contactFullName(contact);
  const needsReview = isContactNeedsReview(contact);
  const phone = formatPhone(contact.phone);

  function handleSaved(updated: Contact): void {
    // The parent owns the fetch now (H1) — tell it to refetch the conversation
    // AND the contact so both the header identity and this panel update.
    onResolved(updated);
  }

  return (
    <div className={styles.panel}>
      <div className={styles.summary}>
        <Avatar name={name} review={needsReview} size="lg" />
        <div className={styles.head}>
          <div className={styles.name}>{name ?? phone}</div>
          {needsReview ? (
            <Badge tone="review" dot>
              Needs review
            </Badge>
          ) : (
            <Badge tone="info">{TYPE_LABEL[contact.type] ?? contact.type}</Badge>
          )}
        </div>
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>Phone</dt>
            <dd>{phone}</dd>
          </div>
          {contact.voucherSize !== undefined && (
            <div className={styles.fact}>
              <dt>Voucher</dt>
              <dd>{contact.voucherSize} bed</dd>
            </div>
          )}
          {contact.sms_opt_out === true && (
            <div className={styles.fact}>
              <dt>Texting</dt>
              <dd>Opted out (STOP)</dd>
            </div>
          )}
        </dl>
      </div>

      <h3 className={styles.triageTitle}>Triage</h3>
      <TriageForm contact={contact} onSaved={handleSaved} />
    </div>
  );
}
