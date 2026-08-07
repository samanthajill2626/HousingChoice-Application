// PeopleCard - the roster card BOTH hubs render, and (with `edit`) the roster
// EDITOR (contact-rosters spec 6.2). One component, one payload: the same
// GET .../roster response that drives the 1:1 tabs drives these rows, so the
// card and the tabs can never disagree about who is on a tour/placement.
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
//     away from (Task 3's cardinal rule). Editing is OFF in that state for the
//     same reason: we do not know what we would be editing.
//   - the Property row and the placement's "converted from tour" provenance row
//     are NOT people: the hub page passes them as `children` and they render
//     below the divider (spec 6.2).
//
// EDIT MODE (spec 6.2 / D5). Every action persists THE MOMENT IT IS CLICKED -
// there is never a pending edit to lose, so "Done" is only a view toggle. WHICH
// endpoint it persists through is the safety story (spec section 7):
//
//   no thread  -> the PLAN endpoints. Silent: nothing has been sent, the roster
//                 is only a plan, so an add/remove/reset confirms nothing.
//   a thread   -> the OWNER-SCOPED live call-through. An ADD is a real text to
//                 real people, so it goes through RosterConfirmDialog first. A
//                 REMOVE sends nothing and is immediate - no confirm - and it
//                 travels by MEMBER KEY: the server finds the participant row
//                 and deletes by the phone stored on it, so this component
//                 never handles a phone number at all.
//
// A plan write that 409s `thread_exists` (operator A edits the plan while
// operator B's open lands) is DROPPED with a visible note and a refetch. It is
// never auto-resubmitted through the live endpoint: that would escalate a
// no-send plan edit into a `member_added` text nobody confirmed.
// PENDING / SKIPPED (spec 6.5): a change confirmed inside quiet hours has NOT
// happened yet. It rides the same payload as its own row - "Joins at 8:00 AM -
// quiet hours" with Add now / Cancel - and a pending add is deliberately NOT a
// member, because membership defers WITH the message (D7). An action that
// resolved WITHOUT happening leaves a NOTICE that stays until it is dismissed;
// the server then excludes it for good, so a dismissed notice never returns.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  type Contact,
  type RosterMemberRole,
  type RosterMemberView,
  type RosterPendingAction,
  type RosterPreview,
  type RosterSkippedAction,
  type RosterView,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { Card, CardAction, EmptyRow } from '../contact/Card.js';
import { ContactSearchField, type ContactSearchValue } from '../contact/ContactSearchField.js';
import { useContacts } from '../contacts/useContacts.js';
import { RosterConfirmDialog } from './RosterConfirmDialog.js';
import type { RosterSuggestion } from './rosterPeople.js';
import {
  pendingActionNote,
  rosterApi,
  refusalMessage,
  skippedActionNote,
  skippedActionSubject,
  threadExistsNote,
  type RosterOwner,
} from './rosterWrites.js';
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

/** The server's own last-member refusal, said BEFORE the doomed click (the
 *  control is disabled and carries this) rather than after it. Kept verbatim so
 *  the card and the 409 that backstops a race read identically. */
const LAST_MEMBER_REASON =
  'A roster needs at least one member. Add someone else before removing this one.';

/** The reset control's reason once a thread exists: the plan was consumed at
 *  open, and the thread's participants are the fact now (spec D1). */
const RESET_DISABLED_REASON =
  'members are on a live group text - add or remove them individually';

/** Row keys for the inline error slot (one write at a time, one place to look). */
const ADD_FORM_KEY = 'add-any-contact';
const RESET_KEY = 'reset';
const suggestionKey = (contactId: string): string => `suggest:${contactId}`;
const pendingKey = (actionId: string): string => `pending:${actionId}`;
const skippedKey = (actionId: string): string => `skipped:${actionId}`;

/** What the card needs to BE the editor. Absent -> read-only, byte-identical to
 *  the Task 8 card. */
export interface PeopleCardEdit {
  /** Which tour/placement these writes address. */
  owner: RosterOwner;
  /** People who belong here but are not on the roster (rosterSuggestions). */
  suggestions: RosterSuggestion[];
  /** Apply a write's returned RosterView - the SAME shape GET serves - into the
   *  hub's roster state, so the card, the 1:1 tabs and the notes all move
   *  together without a refetch round-trip. */
  onApply: (roster: RosterView) => void;
  /**
   * "Send now" on a DEFERRED OPEN (spec 6.5). The HUB owns the relay-open path -
   * it is the only place that can mount the freshly provisioned thread - so the
   * card delegates instead of opening a group text it could not then show.
   * Absent -> the banner still explains the deferral and still offers Cancel.
   */
  onOpenNow?: () => void;
}

export interface PeopleCardProps {
  /** Which hub is rendering - drives the scope words in the notes only. */
  scope: 'tour' | 'placement';
  /** The roster fetch state (useRoster). */
  status: 'loading' | 'ready' | 'error';
  roster: RosterView | null;
  /** Re-run the roster fetch. It is the unavailable/error state's Retry control
   *  AND the settle after any refused write - a lost race must never read as a
   *  dead click. */
  onRetry: () => void;
  /** The TENANT contact's free-text `caseworker` name, when they have one.
   *  Always hinted when set: matching a free-text name against contact records
   *  is guesswork, so this is a nudge at the moment of review, never an
   *  affordance (spec 6.2). */
  caseworker?: string;
  /** Turns the card into the roster editor. */
  edit?: PeopleCardEdit;
  /** The hub page's own non-people rows (Property, provenance) - rendered below
   *  the divider. They stay OWNED BY THE PAGE; this card only places them. */
  children?: React.ReactNode;
}

interface PendingConfirm {
  key: string;
  contactId: string;
  name: string;
  preview: RosterPreview;
}

export function PeopleCard({
  scope,
  status,
  roster,
  onRetry,
  caseworker,
  edit,
  children,
}: PeopleCardProps): React.JSX.Element {
  const scopeWord = scope === 'tour' ? 'tour' : 'placement';
  // An 'unavailable' roster is a SUCCESSFUL response that says "I could not read
  // the thread". It gets the same honest treatment as a failed fetch.
  const unreadable = status === 'error' || roster === null || roster.source === 'unavailable';

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  // Editing is offered only when we actually know the roster.
  const canEdit = edit !== undefined && !unreadable;
  const isEditing = canEdit && editing;
  const api = edit !== undefined ? rosterApi(edit.owner) : null;

  const closeAdd = (): void => setAddOpen(false);

  const toggleEdit = (): void => {
    setEditing((v) => !v);
    setRowError(null);
    closeAdd();
  };

  /**
   * Run ONE roster write. Resolving with a RosterView applies it (the response
   * IS the fresh roster - one shape, one decoder); resolving with null means the
   * action opened a dialog instead. Any refusal renders the SERVER's own copy
   * inline and refetches, so the row the operator touched settles into the state
   * that actually won.
   */
  const run = (key: string, write: () => Promise<RosterView | null>, after?: () => void): void => {
    if (busy !== null || edit === undefined) return;
    setBusy(key);
    setRowError(null);
    void write()
      .then((next) => {
        if (next !== null) edit.onApply(next);
        after?.();
      })
      .catch((err: unknown) => {
        const raced = err instanceof ApiError && err.code === 'thread_exists';
        setRowError({ key, message: raced ? threadExistsNote(scope) : refusalMessage(err) });
        // Settle onto the truth. On the thread_exists race the queued intent is
        // DROPPED here, deliberately - never resubmitted through live-members.
        onRetry();
      })
      .finally(() => setBusy(null));
  };

  const removeMember = (member: RosterMemberView): void => {
    if (api === null || roster === null) return;
    const key = member.memberKey;
    run(key, () =>
      roster.threadExists ? api.removeLive(key) : api.removePlan(key),
    );
  };

  /** Add one contact. Pre-open it is a silent plan edit; against a LIVE group it
   *  previews first and writes nothing until the operator confirms (spec 6.4). */
  const addContact = (key: string, contactId: string, name: string, after?: () => void): void => {
    if (api === null || roster === null) return;
    if (!roster.threadExists) {
      run(key, () => api.addPlan({ contactId }), after);
      return;
    }
    run(
      key,
      async () => {
        setConfirm({ key, contactId, name, preview: await api.previewAdd(contactId) });
        return null;
      },
      after,
    );
  };

  const resetRoster = (): void => {
    if (api === null) return;
    run(RESET_KEY, () => api.reset());
  };

  /** "Add now" / "Send now" on a pending row. An ADD goes through apply-now -
   *  the SAME applier the poller runs, so a world that moved lands a visible
   *  skip notice instead of a surprise send. An OPEN is the hub's to run. */
  const applyPendingNow = (action: RosterPendingAction): void => {
    if (api === null) return;
    if (action.kind === 'open_group') {
      edit?.onOpenNow?.();
      return;
    }
    run(pendingKey(action.actionId), () => api.applyPendingNow(action.actionId));
  };

  const cancelPending = (action: RosterPendingAction): void => {
    if (api === null) return;
    run(pendingKey(action.actionId), () => api.cancelPending(action.actionId));
  };

  /** The operator has read the notice. The server drops it from `skipped` for
   *  good, so a later refetch cannot bring it back. */
  const dismissSkipped = (row: RosterSkippedAction): void => {
    if (api === null) return;
    run(skippedKey(row.actionId), () => api.dismissPending(row.actionId));
  };

  const errorFor = (key: string): string | null =>
    rowError !== null && rowError.key === key ? rowError.message : null;

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
  } else if (roster.members.length === 0 && !isEditing) {
    body = <EmptyRow>No one is on this roster yet.</EmptyRow>;
  } else {
    const onlyMember = roster.members.length === 1;
    body = (
      <>
        <ul className={styles.roster} aria-label="Roster">
          {roster.members.map((m) => (
            <MemberRow
              key={m.memberKey}
              member={m}
              editing={isEditing}
              scopeWord={scopeWord}
              disableRemove={onlyMember}
              busy={busy !== null}
              onRemove={() => removeMember(m)}
              error={errorFor(m.memberKey)}
            />
          ))}
        </ul>
        {isEditing && edit !== undefined ? (
          <>
            {edit.suggestions.map((s) => (
              <SuggestionRow
                key={s.contactId}
                suggestion={s}
                scopeWord={scopeWord}
                busy={busy !== null}
                onAdd={() => addContact(suggestionKey(s.contactId), s.contactId, s.name)}
                error={errorFor(suggestionKey(s.contactId))}
              />
            ))}
            {addOpen ? (
              <AddAnyContactForm
                scopeWord={scopeWord}
                roster={roster}
                busy={busy !== null}
                error={errorFor(ADD_FORM_KEY)}
                onAdd={(contactId, name) => addContact(ADD_FORM_KEY, contactId, name, closeAdd)}
                onCancel={closeAdd}
              />
            ) : (
              <button type="button" className={styles.addBtn} onClick={() => setAddOpen(true)}>
                + Add any contact
              </button>
            )}
          </>
        ) : null}
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
        {roster.customized && (roster.threadExists || canEdit) ? (
          <div className={styles.resetRow}>
            <Button
              variant="secondary"
              size="sm"
              onClick={resetRoster}
              disabled={roster.threadExists || !canEdit || busy !== null}
            >
              Reset to property default
            </Button>
            {roster.threadExists ? (
              <span className={styles.note}>{RESET_DISABLED_REASON}</span>
            ) : null}
            {errorFor(RESET_KEY) !== null ? (
              <p role="alert" className={styles.rowError}>
                {errorFor(RESET_KEY)}
              </p>
            ) : null}
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
    <Card
      title="People"
      aside={
        <>
          {`on this ${scopeWord}`}
          {canEdit ? (
            <CardAction
              onClick={toggleEdit}
              label={isEditing ? 'Done editing people' : 'Edit people'}
            >
              {isEditing ? 'Done' : 'Edit'}
            </CardAction>
          ) : null}
        </>
      }
    >
      {body}
      {/* Pending + skipped are card STATE, not an edit gesture: they render in
          read mode too, and OUTSIDE the roster list because a pending add is
          not a member yet. Their controls appear only when there is a write
          seam to run them through. */}
      {roster !== null && !unreadable && roster.pending.length > 0 ? (
        <ul className={styles.pendingList} aria-label="Waiting for quiet hours to end">
          {roster.pending.map((action) => (
            <PendingRow
              key={action.actionId}
              action={action}
              canAct={api !== null}
              canApplyNow={action.kind === 'add_member' || edit?.onOpenNow !== undefined}
              busy={busy !== null}
              onApplyNow={() => applyPendingNow(action)}
              onCancel={() => cancelPending(action)}
              error={errorFor(pendingKey(action.actionId))}
            />
          ))}
        </ul>
      ) : null}
      {roster !== null && !unreadable && roster.skipped.length > 0 ? (
        <ul className={styles.pendingList} aria-label="Roster notices">
          {roster.skipped.map((row) => (
            <SkippedRow
              key={row.actionId}
              row={row}
              scope={scope}
              canAct={api !== null}
              busy={busy !== null}
              onDismiss={() => dismissSkipped(row)}
              error={errorFor(skippedKey(row.actionId))}
            />
          ))}
        </ul>
      ) : null}
      {caseworker !== undefined && caseworker.trim().length > 0 ? (
        <p className={styles.hint}>{`Caseworker on file: ${caseworker} - not a contact record`}</p>
      ) : null}
      {children !== undefined ? (
        <>
          <hr className={styles.divider} />
          {children}
        </>
      ) : null}
      {confirm !== null && edit !== undefined && api !== null ? (
        <RosterConfirmDialog
          title={`Add ${confirm.name} to the group text?`}
          preview={confirm.preview}
          confirmLabel="Add and notify"
          deferLabel="Add and notify"
          onConfirm={async (force) => {
            try {
              // Inside quiet hours the unforced call answers 202: nobody is
              // added yet and the returned roster carries the pending row.
              edit.onApply(await api.addLive(confirm.contactId, force));
            } catch (err) {
              onRetry();
              throw err;
            }
          }}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </Card>
  );
}

/** The name a row renders by. A dangling / soft-deleted contact has no name to
 *  trust, and a bare-phone participant has only its last 4 - which is why the
 *  server ships `phoneLast4` and nothing else (spec 6.2 forbids phone numbers). */
function memberLabel(member: RosterMemberView): string {
  const gone = member.role === 'removed_contact';
  const fallbackName =
    member.phoneLast4 !== undefined ? `Number ending ${member.phoneLast4}` : member.memberKey;
  return member.name ?? (gone ? 'Removed contact' : fallbackName);
}

/** One roster row: the name line (name + subtle role, plus the remove control
 *  while editing) then any muted notes. The role WRAPS UNDER the name below
 *  860px (spec 6.7) - the wrap lives on .nameLine, and the remove control is
 *  anchored THERE so it does not move when the role wraps. */
function MemberRow({
  member,
  editing,
  scopeWord,
  disableRemove,
  busy,
  onRemove,
  error,
}: {
  member: RosterMemberView;
  editing: boolean;
  scopeWord: string;
  disableRemove: boolean;
  busy: boolean;
  onRemove: () => void;
  error: string | null;
}): React.JSX.Element {
  const gone = member.role === 'removed_contact';
  const label = memberLabel(member);
  // A dangling / soft-deleted contact gets no link (the record is gone), and a
  // bare-phone participant has no contact page to link to. While EDITING no row
  // is a link at all - a click there is an edit gesture, not a navigation.
  const linkable = member.contactId !== undefined && !gone && !editing;
  const reachNote = REACHABILITY_NOTES[member.reachability];
  return (
    <li className={editing ? `${styles.row} ${styles.rowEditing}` : styles.row}>
      <div className={styles.nameLine}>
        {linkable ? (
          <Link className={styles.name} to={`/contacts/${member.contactId ?? ''}`}>
            {label}
          </Link>
        ) : (
          <span className={styles.name}>{label}</span>
        )}
        <span className={styles.role}>{ROLE_LABELS[member.role]}</span>
        {editing ? (
          <button
            type="button"
            className={styles.rowAction}
            aria-label={`Remove ${label} from this ${scopeWord}`}
            onClick={onRemove}
            disabled={disableRemove || busy}
          >
            Remove
          </button>
        ) : null}
      </div>
      {reachNote !== undefined ? <p className={styles.note}>{reachNote}</p> : null}
      {member.sharesPhoneWithName !== undefined ? (
        <p className={styles.note}>{`shares a number with ${member.sharesPhoneWithName} - one message`}</p>
      ) : null}
      {/* Said BEFORE the doomed click, not after it. */}
      {editing && disableRemove ? <p className={styles.note}>{LAST_MEMBER_REASON}</p> : null}
      {error !== null ? (
        <p role="alert" className={styles.rowError}>
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** WHO a pending row is about, mid-sentence - the subject of both its control
 *  labels, so the two can never name different people. */
function pendingSubject(action: RosterPendingAction): string {
  if (action.kind === 'open_group') return 'the group text';
  return action.name ?? 'that contact';
}

/**
 * One deferred change, waiting for quiet-end (spec 6.5):
 *
 *   Alicia Grant
 *     Joins at 8:00 AM - quiet hours
 *     Add now - Cancel
 *
 * The two controls are the only two honest ways out: do it now, or call it off.
 * A read-only card (no write seam) renders the sentence WITHOUT them rather
 * than a button that could not fire.
 */
function PendingRow({
  action,
  canAct,
  canApplyNow,
  busy,
  onApplyNow,
  onCancel,
  error,
}: {
  action: RosterPendingAction;
  canAct: boolean;
  /** An OPEN's "Send now" needs the hub (it mounts the new thread). */
  canApplyNow: boolean;
  busy: boolean;
  onApplyNow: () => void;
  onCancel: () => void;
  error: string | null;
}): React.JSX.Element {
  const subject = pendingSubject(action);
  const title = action.kind === 'open_group' ? 'Group text' : (action.name ?? 'That contact');
  return (
    <li className={styles.pendingRow}>
      <div className={styles.nameLine}>
        <span className={styles.name}>{title}</span>
        {canAct ? (
          <span className={styles.pendingActions}>
            {canApplyNow ? (
              <button
                type="button"
                className={styles.rowAction}
                aria-label={
                  action.kind === 'add_member' ? `Add ${subject} now` : `Send ${subject} now`
                }
                onClick={onApplyNow}
                disabled={busy}
              >
                {action.kind === 'add_member' ? 'Add now' : 'Send now'}
              </button>
            ) : null}
            <button
              type="button"
              className={styles.rowAction}
              aria-label={
                action.kind === 'add_member'
                  ? `Cancel adding ${subject}`
                  : `Cancel opening ${subject}`
              }
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
          </span>
        ) : null}
      </div>
      <p className={styles.note}>{pendingActionNote(action)}</p>
      {error !== null ? (
        <p role="alert" className={styles.rowError}>
          {error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * One notice for a deferral that resolved WITHOUT happening (spec 6.5). It
 * stays until the operator dismisses it - a change they confirmed and that
 * silently did not happen is exactly the thing this feature must never do.
 */
function SkippedRow({
  row,
  scope,
  canAct,
  busy,
  onDismiss,
  error,
}: {
  row: RosterSkippedAction;
  scope: 'tour' | 'placement';
  canAct: boolean;
  busy: boolean;
  onDismiss: () => void;
  error: string | null;
}): React.JSX.Element {
  return (
    <li className={styles.pendingRow}>
      <div className={styles.nameLine}>
        <span className={styles.note}>{skippedActionNote(row, scope)}</span>
        {canAct ? (
          <button
            type="button"
            className={styles.rowAction}
            aria-label={`Dismiss notice for ${skippedActionSubject(row)}`}
            onClick={onDismiss}
            disabled={busy}
          >
            Dismiss
          </button>
        ) : null}
      </div>
      {error !== null ? (
        <p role="alert" className={styles.rowError}>
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** One inline suggestion: someone who belongs here but is not on the roster.
 *  This is the whole point of edit mode - the common swap is two clicks and a
 *  removed tenant is one. */
function SuggestionRow({
  suggestion,
  scopeWord,
  busy,
  onAdd,
  error,
}: {
  suggestion: RosterSuggestion;
  scopeWord: string;
  busy: boolean;
  onAdd: () => void;
  error: string | null;
}): React.JSX.Element {
  const line = `${suggestion.lead}: ${suggestion.name} - ${suggestion.roleLabel}${
    suggestion.primaryContact === true ? ' - primary contact' : ''
  }`;
  return (
    <div className={styles.suggestion}>
      <div className={styles.suggestionLine}>
        <span className={styles.suggestionText}>{line}</span>
        <button
          type="button"
          className={styles.rowAction}
          aria-label={`Add ${suggestion.name} to this ${scopeWord}`}
          onClick={onAdd}
          disabled={busy}
        >
          + Add
        </button>
      </div>
      {error !== null ? (
        <p role="alert" className={styles.rowError}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Add any contact..." - the general contact search, MOUNTED ONLY WHILE OPEN so
 * the hub pages never pay for a contacts fan-out they may not use. Committed
 * pick (the unit-search contract): typing alone never carries a contactId, so
 * nobody can be added by a near-miss.
 */
function AddAnyContactForm({
  scopeWord,
  roster,
  busy,
  error,
  onAdd,
  onCancel,
}: {
  scopeWord: string;
  roster: RosterView;
  busy: boolean;
  error: string | null;
  onAdd: (contactId: string, name: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { contacts } = useContacts('all');
  const [value, setValue] = useState<ContactSearchValue>({ name: '' });
  const onRoster = new Set(roster.members.map((m) => m.contactId));
  // Already on the roster -> not a candidate (an add there is a no-op).
  const candidates: Contact[] = contacts.filter((c) => !onRoster.has(c.contactId));
  const picked = value.contactId;
  return (
    <div className={styles.addForm}>
      <ContactSearchField
        value={value}
        onChange={setValue}
        candidates={candidates}
        inputLabel="Add any contact"
      />
      <div className={styles.addActions}>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          aria-label={`Add contact to this ${scopeWord}`}
          onClick={() => {
            if (picked !== undefined) onAdd(picked, value.name);
          }}
          disabled={picked === undefined || busy}
        >
          Add
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      {error !== null ? (
        <p role="alert" className={styles.rowError}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
