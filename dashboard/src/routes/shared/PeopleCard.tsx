// PeopleCard - the READ-ONLY roster card BOTH hubs render (contact-rosters
// spec 6.2). One component, one payload: the same GET .../roster response that
// drives the 1:1 tabs drives these rows, so the card and the tabs can never
// disagree about who is on a tour/placement.
//
// What it renders, and why each rule exists:
//   - people are a LIST; the role is subtle on the right; there are NO phone
//     numbers (a bare-phone member is named by its last 4 - the only handle it
//     has). The type-derived "Property manager" / "Landlord" key is GONE: role
//     comes from the roster now, so the card can no longer claim a PM and render
//     an owner.
//   - a member the group text cannot reach is muted WITH the reason. They are
//     still on the roster and still get a tab (spec D6).
//   - source 'unavailable' (a thread pointer that would not read) renders a
//     retry, NEVER the property default in its place - the plan was already
//     consumed, so the default would be exactly the roster the operator edited
//     away from (Task 3's cardinal rule).
//   - the Property row and the placement's "converted from tour" provenance row
//     are NOT people: the hub page passes them as `children` and they render
//     below the divider (spec 6.2).
//
// Read mode only. Per-row remove, the inline suggestions, the confirm dialogs
// and the live [Open group text] wiring are Task 11; the reset control here is
// deliberately a DISABLED placeholder with its reason.
import { Link } from 'react-router-dom';
import type { RosterMemberRole, RosterMemberView, RosterView } from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { Card, EmptyRow } from '../contact/Card.js';
import styles from './PeopleCard.module.css';

/** The subtle right-hand role word. Deliberately lower-case prose (except the
 *  initialism) - it is an annotation, not a heading. */
const ROLE_LABELS: Readonly<Record<RosterMemberRole, string>> = {
  tenant: 'tenant',
  landlord: 'landlord',
  pm: 'PM',
  owner: 'owner',
  other: 'contact',
  added: 'added',
  removed_contact: 'removed contact',
};

/** Why the group text cannot reach a member (muted, under the name). */
const REACHABILITY_NOTES: Readonly<Record<string, string>> = {
  no_phone: 'not on the group text - no mobile number',
  opted_out: 'not on the group text - opted out',
};

export interface PeopleCardProps {
  /** Which hub is rendering - drives the scope words in the notes only. */
  scope: 'tour' | 'placement';
  /** The roster fetch state (useRoster). */
  status: 'loading' | 'ready' | 'error';
  roster: RosterView | null;
  /** Retry the roster fetch (the unavailable / error state's control). */
  onRetry: () => void;
  /** The TENANT contact's free-text `caseworker` name, when they have one.
   *  Always hinted when set: matching a free-text name against contact records
   *  is guesswork, so this is a nudge at the moment of review, never an
   *  affordance (spec 6.2). */
  caseworker?: string;
  /** The hub page's own non-people rows (Property, provenance) - rendered below
   *  the divider. They stay OWNED BY THE PAGE; this card only places them. */
  children?: React.ReactNode;
}

export function PeopleCard({
  scope,
  status,
  roster,
  onRetry,
  caseworker,
  children,
}: PeopleCardProps): React.JSX.Element {
  const scopeWord = scope === 'tour' ? 'tour' : 'placement';
  // An 'unavailable' roster is a SUCCESSFUL response that says "I could not read
  // the thread". It gets the same honest treatment as a failed fetch.
  const unreadable = status === 'error' || roster === null || roster.source === 'unavailable';

  let body: React.ReactNode;
  if (status === 'loading') {
    body = <Spinner center />;
  } else if (unreadable) {
    body = (
      <div className={styles.unavailable}>
        <p className={styles.note}>Couldn&apos;t load this roster.</p>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  } else if (roster.members.length === 0) {
    body = <EmptyRow>No one is on this roster yet.</EmptyRow>;
  } else {
    body = (
      <>
        <ul className={styles.roster} aria-label="Roster">
          {roster.members.map((m) => (
            <MemberRow key={m.memberKey} member={m} />
          ))}
        </ul>
        {roster.tenantOnRoster ? null : (
          <p className={styles.note}>
            {`Tenant is not on this roster - ${
              scope === 'tour' ? 'tour reminders' : 'placement nudges'
            } are paused`}
          </p>
        )}
        {roster.customized ? (
          <p className={styles.note}>
            {roster.defaultPrimaryName !== undefined
              ? `Customized for this ${scopeWord} - the property's default is ${roster.defaultPrimaryName}.`
              : `Customized for this ${scopeWord}.`}
          </p>
        ) : null}
        {roster.customized && roster.threadExists ? (
          <div className={styles.resetRow}>
            <Button variant="secondary" size="sm" disabled>
              Reset to property default
            </Button>
            <span className={styles.note}>
              members are on a live group text - add or remove them individually
            </span>
          </div>
        ) : null}
        {!roster.threadExists && !roster.canOpenGroup ? (
          <p className={styles.note}>
            Not enough people to open a group text - two reachable members are needed
          </p>
        ) : null}
      </>
    );
  }

  return (
    <Card title="People" aside={`on this ${scopeWord}`}>
      {body}
      {caseworker !== undefined && caseworker.trim().length > 0 ? (
        <p className={styles.hint}>{`Caseworker on file: ${caseworker} - not a contact record`}</p>
      ) : null}
      {children !== undefined ? (
        <>
          <hr className={styles.divider} />
          {children}
        </>
      ) : null}
    </Card>
  );
}

/** One roster row: the name line (name + subtle role) plus any muted notes.
 *  The role WRAPS UNDER the name below 860px (spec 6.7) - the wrap lives on
 *  .nameLine so a future per-row remove control can anchor to the name line and
 *  not move when it wraps. */
function MemberRow({ member }: { member: RosterMemberView }): React.JSX.Element {
  const gone = member.role === 'removed_contact';
  const fallbackName =
    member.phoneLast4 !== undefined ? `Number ending ${member.phoneLast4}` : member.memberKey;
  const label = member.name ?? (gone ? 'Removed contact' : fallbackName);
  // A dangling / soft-deleted contact gets no link (the record is gone), and a
  // bare-phone participant has no contact page to link to.
  const linkable = member.contactId !== undefined && !gone;
  const reachNote = REACHABILITY_NOTES[member.reachability];
  return (
    <li className={styles.row}>
      <div className={styles.nameLine}>
        {linkable ? (
          <Link className={styles.name} to={`/contacts/${member.contactId ?? ''}`}>
            {label}
          </Link>
        ) : (
          <span className={styles.name}>{label}</span>
        )}
        <span className={styles.role}>{ROLE_LABELS[member.role]}</span>
      </div>
      {reachNote !== undefined ? <p className={styles.note}>{reachNote}</p> : null}
      {member.sharesPhoneWithName !== undefined ? (
        <p className={styles.note}>{`shares a number with ${member.sharesPhoneWithName} - one message`}</p>
      ) : null}
    </li>
  );
}
