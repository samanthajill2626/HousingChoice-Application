// CreateRelayGroupModal - start a STANDALONE relay group (no tour, no
// placement) from the contact file's "Relay groups" card. Seeded with the
// contact whose page this is, plus anyone the operator picks, then confirmed
// against the SERVER-composed intro before anything is created.
//
// FOUR STATES, EXACTLY ONE MODAL MOUNTED AT A TIME:
//
//   picking      - this modal, the member list + search + tag.
//   confirming   - this modal unmounts, RosterConfirmDialog mounts.
//   connecting   - the dialog unmounts, this modal re-mounts showing the result
//                  panel instead of the member list.
//   maybeCreated - the create never got an answer. A terminal, ACTIONLESS
//                  panel: see the ambiguity rule below.
//
// Never two at once: `Modal` registers a DOCUMENT-level Escape handler with no
// propagation guard, so one keypress would close both and silently discard the
// assembled member list. Member state lives HERE, so Cancel from the confirm
// step restores the picker intact.
//
// TWO RULES THAT LOOK COSMETIC AND ARE NOT:
//
//   1. The SAME members array value is posted to the preview and to the create.
//      A standalone group has no stored roster before it exists, so the
//      client's list IS the input to both calls (spec 6.2); a rebuilt array
//      would make the confirm dialog a preview of a different send.
//   2. A member's `name` is built from firstName/lastName ONLY. Never
//      `contactDisplayName` and never ContactSearchField's `value.name` (which
//      IS that helper's output): its fallback is a FORMATTED PHONE NUMBER,
//      which would print a phone in the preview AND embed one in the outbound
//      intro. A nameless member is sent with no name and reads as
//      "Unnamed number" - the confirm dialog's own string for the same person.
//
// A create that answers `connecting` has NO number and sent NO intro yet, so
// it does not navigate: the operator was just shown that exact intro body, and
// silence would read as "sent".
//
// A FAILED CREATE FAILS IN ONE OF TWO WORLDS, AND ONLY ONE MAY BE RETRIED:
//
//   The SERVER ANSWERED (an ApiError with a real status) - it refused, nothing
//     exists, and confirming again is exactly right. The rejection PROPAGATES to
//     RosterConfirmDialog, which renders it inline and keeps its confirm armed.
//   NOBODY ANSWERED (a dropped connection, a timeout, the transport's own
//     `ApiError(0, 'network_error')`) - the request may well have COMMITTED
//     before the wire died. `POST /api/relay-groups` has no idempotency key, and
//     the 409 `relay_exists` that protects the owner-scoped opens has no
//     standalone equivalent (there is no owner row to key it on), so a retry
//     mints a SECOND group, buys a SECOND pool number and texts everyone a
//     second intro. No affordance can retry that safely, so this flow offers
//     none: it lands on `maybeCreated`, which has exactly one button and it is
//     Close.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ApiError,
  createRelayGroup,
  previewRelayGroup,
  type Contact,
  type ConversationHeader,
  type RelayGroupMemberInput,
  type RosterPreview,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { RosterConfirmDialog } from '../shared/RosterConfirmDialog.js';
import { refusalMessage } from '../shared/rosterWrites.js';
import { ContactSearchField, type ContactSearchValue } from './ContactSearchField.js';
import { Modal } from './Modal.js';
import styles from './CreateRelayGroupModal.module.css';

/** RosterConfirmDialog's own label for a member with no name. Reused verbatim
 *  so one person never reads as two different things across the two steps. */
const UNNAMED = 'Unnamed number';

/** Why the flow cannot start from this contact. Lower-case to match the
 *  dialog's "not receiving - ..." annotations. */
const NO_MOBILE = 'no mobile number - cannot start a relay group';

/** The connecting result. It names the UNSENT INTRO specifically: the
 *  conversation view's own connecting affordances (a status pill, a composer
 *  note about queued replies) never say the intro has not gone out. */
const CONNECTING_NOTICE =
  'This group is still getting its number. The intro text has not been sent yet; it goes out once the number is ready.';

/** The AMBIGUOUS result - extends the A11 pinned-string contract. It has three
 *  jobs, in this order: say the outcome is UNKNOWN (never "it failed", which
 *  invites the retry), name WHERE the answer is (the card on this very page,
 *  which onAmbiguousCreate has just refreshed), and state the cost of guessing
 *  wrong. Byte-exact and ASCII, like every other pinned string here. */
const AMBIGUOUS_NOTICE =
  'The connection dropped before the server answered, so the group may or may not have been created. Check the Relay groups card on this page before trying again - creating it again could text everyone twice.';

/** One picked contact as the picker holds it. `name` is '' when the contact has
 *  neither a first nor a last name - see rule 2 in the header. */
interface PickedRow {
  contactId: string;
  phone: string;
  name: string;
}

type Phase =
  | { kind: 'picking' }
  | { kind: 'confirming'; members: RelayGroupMemberInput[]; preview: RosterPreview }
  | { kind: 'connecting'; conversationId: string }
  | { kind: 'maybeCreated' };

/** Did the SERVER answer? That - not "is this an ApiError" - is the question a
 *  retry hangs on. The transport wraps a failed fetch as
 *  `ApiError(0, 'network_error')` (api/client.ts, where status 0 is documented
 *  as exactly that), so an `instanceof` check alone would classify the single
 *  most likely commit-then-drop as a safe retry. A real status means the server
 *  received the request, decided, and said no. */
function serverRefused(err: unknown): boolean {
  return err instanceof ApiError && err.status > 0;
}

/** The number we would text. `phones` is OPTIONAL on the dashboard Contact, so
 *  the optional chain is required to typecheck. */
function primaryPhone(c: Contact): string | undefined {
  const phone = c.phones?.find((p) => p.primary)?.phone ?? c.phone;
  return phone !== undefined && phone.length > 0 ? phone : undefined;
}

/** A member name from the contact RECORD, never from a display helper. */
function builtName(c: Contact): string {
  return [c.firstName?.trim(), c.lastName?.trim()].filter(Boolean).join(' ');
}

function toMember(row: PickedRow): RelayGroupMemberInput {
  return {
    phone: row.phone,
    contactId: row.contactId,
    ...(row.name !== '' && { name: row.name }),
  };
}

export interface CreateRelayGroupModalProps {
  /** The contact whose page this is: the LOCKED first member. A group created
   *  from Sam's page that does not contain Sam is a foot-gun. */
  contact: Contact;
  /** Everyone else who can be added (ContactDetail's `editCandidates`). May be
   *  empty or arrive late - `useContacts` is still loading. */
  candidates: Contact[];
  /** Cancel, dismiss, or a finished create - the caller clears its state. */
  onClose: () => void;
  /** A group now EXISTS. Fired once per successful create, before the
   *  connecting/open branch, so the page can refresh what it already fetched:
   *  the `connecting` branch deliberately does not navigate, and the Relay
   *  groups card behind this modal read its rows once, on mount. Without a
   *  refresh the operator closes the panel onto "No relay groups yet." and a
   *  retry buys a second pool number. Optional - the flow works without it. */
  onCreated?: (conversation: ConversationHeader) => void;
  /** A group MAY exist: the create got no answer, so we cannot say. Same job as
   *  `onCreated` and fired for the same reason - the panel tells the operator to
   *  go and read the Relay groups card, so that card must already be showing
   *  what really happened by the time they look. No conversation is passed
   *  because none is known. Optional - the flow works without it. */
  onAmbiguousCreate?: () => void;
}

export function CreateRelayGroupModal({
  contact,
  candidates,
  onClose,
  onCreated,
  onAmbiguousCreate,
}: CreateRelayGroupModalProps): React.JSX.Element {
  const navigate = useNavigate();
  const tagId = useId();
  const [added, setAdded] = useState<PickedRow[]>([]);
  const [search, setSearch] = useState<ContactSearchValue>({ name: '' });
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'picking' });
  // A create that SUCCEEDED owns what happens next (navigate, or the connecting
  // panel). RosterConfirmDialog calls its onClose after a resolved confirm, and
  // that must not drag the flow back to the picker over the result.
  const settled = useRef(false);
  // The create is ON THE WIRE. `settled` is only true AFTER it resolves, so it
  // says nothing about the round trip itself - and that round trip buys a pool
  // number and texts everyone on the list. RosterConfirmDialog now refuses its
  // own dismissals while busy (the first line of defence); this ref is the
  // second, so a future dialog rewrite cannot silently restore a flow that
  // hands the picker - and its "Create group" button - back mid-create.
  const creating = useRef(false);
  // The in-flight preview, so an abandoned flow does not keep a request running
  // against a component that is gone. Cleared when the preview settles, so the
  // ref means "in flight" and nothing else.
  const previewAbort = useRef<AbortController | null>(null);
  useEffect(() => () => previewAbort.current?.abort(), []);

  const seedPhone = primaryPhone(contact);
  const seedName = builtName(contact);

  // Drop anyone create would silently refuse or collapse: no phone at all,
  // already on the list, or a duplicate of a number already on it (the create
  // route de-dupes by phone, FIRST WINS).
  const pickCandidates = useMemo(() => {
    const takenIds = new Set([contact.contactId, ...added.map((r) => r.contactId)]);
    const takenPhones = new Set(added.map((r) => r.phone));
    if (seedPhone !== undefined) takenPhones.add(seedPhone);
    return candidates.filter((c) => {
      const phone = primaryPhone(c);
      if (phone === undefined) return false;
      if (takenIds.has(c.contactId)) return false;
      return !takenPhones.has(phone);
    });
  }, [candidates, added, contact.contactId, seedPhone]);

  /** ContactSearchField emits on EVERY keystroke. Only a COMMITTED pick (one
   *  carrying a contactId) may add a member; free text never can. */
  const onSearchChange = (v: ContactSearchValue): void => {
    if (v.contactId === undefined) {
      setSearch(v);
      return;
    }
    const picked = candidates.find((c) => c.contactId === v.contactId);
    const phone = picked === undefined ? undefined : primaryPhone(picked);
    if (picked === undefined || phone === undefined) {
      setSearch({ name: '' });
      return;
    }
    setAdded((rows) => [...rows, { contactId: picked.contactId, phone, name: builtName(picked) }]);
    setSearch({ name: '' });
  };

  // An affordance over PICKED ROWS, not a promise about the resulting group:
  // opted-out legs are suppressed at send, so two rows can still be a
  // one-recipient send. The confirm dialog carries the true count.
  const canCreate = seedPhone !== undefined && added.length >= 1;

  const startPreview = (): void => {
    if (seedPhone === undefined || busy) return;
    const members: RelayGroupMemberInput[] = [
      {
        phone: seedPhone,
        contactId: contact.contactId,
        ...(seedName !== '' && { name: seedName }),
      },
      ...added.map(toMember),
    ];
    if (members.length < 2) return;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    previewAbort.current = controller;
    void previewRelayGroup(members, controller.signal)
      .then((preview) => {
        // Settled: the ref means "a preview is in flight", so it must stop
        // pointing at a finished controller (the unmount cleanup would
        // otherwise abort one nobody is waiting on).
        previewAbort.current = null;
        setBusy(false);
        // THIS array value is carried into the create untouched.
        setPhase({ kind: 'confirming', members, preview });
      })
      .catch((err: unknown) => {
        previewAbort.current = null;
        // An abandoned flow is not a failure to report - there is no picker
        // left to render the message into.
        if (controller.signal.aborted) return;
        // The picker keeps the error: an operator must never confirm a send
        // whose content could not be shown.
        setBusy(false);
        setError(refusalMessage(err));
      });
  };

  /** The dialog's confirm. A rejection the SERVER SENT propagates, so the dialog
   *  renders it inline and stays open with its confirm re-armed - that path is
   *  the dialog's, not ours, and it is correct: nothing was created. A rejection
   *  with no answer behind it must NOT take that path (see the header). */
  const confirmCreate = async (): Promise<void> => {
    if (phase.kind !== 'confirming') return;
    const trimmedTag = tag.trim();
    creating.current = true;
    try {
      let created: { conversation: ConversationHeader };
      try {
        created = await createRelayGroup(
          phase.members,
          trimmedTag === '' ? undefined : trimmedTag,
        );
      } catch (err) {
        if (serverRefused(err)) throw err;
        // AMBIGUOUS. `settled` first, and before any render: resolving normally
        // makes RosterConfirmDialog call its onClose, and without this that lands
        // in leaveConfirm and drags the flow back to the picker - over the one
        // panel that exists to stop a second create - with "Create group" armed
        // and the member list intact.
        settled.current = true;
        // SWALLOWED for the same reason as onCreated: this call sits inside the
        // promise the dialog awaits, so a throwing page callback would be caught
        // by the dialog's .catch and rendered as "please try again" over a group
        // that may well exist.
        try {
          onAmbiguousCreate?.();
        } catch {
          /* a group may exist; refreshing the page behind it is not our failure */
        }
        setPhase({ kind: 'maybeCreated' });
        return;
      }
      const { conversation } = created;
      settled.current = true;
      // BEFORE the branch: both outcomes leave a group behind. The connecting one
      // stays on the page whose card must now list it; the open one navigates,
      // but the page it leaves is the one an operator navigates back to.
      //
      // SWALLOWED, not deferred past the branch: this call sits inside the
      // promise RosterConfirmDialog awaits, so a callback that throws would be
      // caught by the dialog's own .catch and rendered as "please try again"
      // over a group that WAS created - the exact invitation to a second
      // purchased number this flow exists to avoid. Ordering is a contract of
      // its own ("before the panel renders"), so the guard is the try, not a
      // move. Today's only caller is a setState bump that cannot throw.
      try {
        onCreated?.(conversation);
      } catch {
        /* the group exists; refreshing the page behind it is not our failure */
      }
      if (conversation.status === 'connecting') {
        setPhase({ kind: 'connecting', conversationId: conversation.conversationId });
        return;
      }
      void navigate('/conversations/' + conversation.conversationId);
      onClose();
    } finally {
      creating.current = false;
    }
  };

  /** Cancel / Escape / backdrop on the confirm dialog. After a SUCCESSFUL
   *  create the dialog calls this too, and then it must do nothing - and while
   *  one is still ON THE WIRE it must do nothing either, or the picker comes
   *  back with the list intact and a second create is one click away. */
  const leaveConfirm = (): void => {
    if (settled.current || creating.current) return;
    setPhase({ kind: 'picking' });
  };

  /** Leave the PICKER - Escape, the backdrop, the header X and Cancel, which all
   *  arrive here and all work WHILE A PREVIEW IS IN FLIGHT. That is deliberate
   *  and it is the opposite of the rule the confirm step follows: the preview is
   *  a pure read (it provisions nothing, buys nothing, texts nobody), so the only
   *  thing a dismissal can cost is a member list the operator is choosing to
   *  abandon - while a preview that hangs behind a busy-guard traps them in a
   *  dialog they have to reload the page to leave. The request is aborted on the
   *  way out so an abandoned flow does not keep a fetch alive.
   *
   *  The list is still FROZEN mid-flight (the search field and every Remove stay
   *  disabled={busy}): an ADD would show on screen and be absent from the
   *  previewed group. Leaving and editing are independent, and only editing is
   *  refused. The CONFIRM dialog's own busy-guard is untouched - that one covers
   *  a round trip that buys a pool number.
   *
   *  MEMOIZED ON PURPOSE. Modal keys its Escape-handler effect on `onClose`, and
   *  that effect's cleanup returns focus to the previously focused element while
   *  the fresh run re-focuses the dialog. A callback rebuilt on every render
   *  therefore steals focus out of the search field on EVERY KEYSTROKE - typing
   *  lands one character and stops. This one never changes identity at all: it
   *  reads no state, only refs, and the `onClose` it closes over is itself
   *  stable (ContactDetail memoizes the handler it passes here for exactly this
   *  reason - an inline arrow there would make this callback change on every
   *  PARENT render, which on this page means every SSE tick).
   *  TODO(modal-onclose-refocus-trap): the residual trap is Modal's - it keys the
   *  effect on `onClose` at all. Fixing it there (the callback in a ref, the
   *  effect keyed []) retires this whole class and covers ContactEditForm and
   *  PhoneManager, which share the wiring and also hold text inputs. */
  const closePicker = useCallback((): void => {
    previewAbort.current?.abort();
    onClose();
  }, [onClose]);

  if (phase.kind === 'confirming') {
    return (
      <RosterConfirmDialog
        title="Open the relay group?"
        preview={phase.preview}
        confirmLabel="Open relay group"
        deferLabel="Open"
        // POST /api/relay-groups has no quiet-hours deferral and no owner row to
        // hold a pending action, so the deferral button must not be offered.
        allowDefer={false}
        onConfirm={confirmCreate}
        onClose={leaveConfirm}
      />
    );
  }

  if (phase.kind === 'connecting') {
    return (
      <Modal
        title="Create a relay group"
        onClose={onClose}
        footer={
          <Link className={styles.goLink} to={'/conversations/' + phase.conversationId}>
            Go to the group
          </Link>
        }
      >
        <p className={styles.notice}>{CONNECTING_NOTICE}</p>
      </Modal>
    );
  }

  if (phase.kind === 'maybeCreated') {
    return (
      <Modal
        title="Create a relay group"
        onClose={onClose}
        footer={
          <div className={styles.actions}>
            {/* The ONLY action. There is deliberately no retry here and no way
                back to the picker: the whole point of this state is that a
                second create could be the second one. */}
            <Button variant="secondary" size="sm" type="button" onClick={onClose}>
              Close
            </Button>
          </div>
        }
      >
        <p className={styles.notice}>{AMBIGUOUS_NOTICE}</p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Create a relay group"
      onClose={closePicker}
      footer={
        <div className={styles.actions}>
          {/* NOT disabled={busy}: a pure-read preview must never trap the
              operator - see closePicker. */}
          <Button variant="secondary" size="sm" type="button" onClick={closePicker}>
            Cancel
          </Button>
          <Button size="sm" type="button" onClick={startPreview} disabled={!canCreate || busy}>
            Create group
          </Button>
        </div>
      }
    >
      <ul className={styles.members} aria-label="Members">
        {/* The seeded contact is LOCKED - no remove affordance at all. */}
        <li className={styles.member}>
          <span className={styles.memberName}>{seedName === '' ? UNNAMED : seedName}</span>
          {seedPhone === undefined ? <span className={styles.note}>{NO_MOBILE}</span> : null}
        </li>
        {added.map((row) => {
          const label = row.name === '' ? UNNAMED : row.name;
          return (
            <li key={row.contactId} className={styles.member}>
              <span className={styles.memberName}>{label}</span>
              <button
                type="button"
                className={styles.removeBtn}
                aria-label={`Remove ${label}`}
                disabled={busy}
                onClick={() => setAdded((rows) => rows.filter((r) => r.contactId !== row.contactId))}
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>

      <ContactSearchField
        value={search}
        onChange={onSearchChange}
        candidates={pickCandidates}
        inputLabel="Add member"
        // The members array is snapshotted into the preview and installed on
        // resolve, so a member added mid-flight would show on screen and be
        // absent from the created group. Remove was already frozen; this is the
        // other half.
        disabled={busy}
      />

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={tagId}>
          Name (optional)
        </label>
        <input
          id={tagId}
          className={styles.input}
          type="text"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
        />
      </div>

      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
