// CreateRelayGroupModal - start a STANDALONE relay group (no tour, no
// placement) from the contact file's "Relay groups" card. Seeded with the
// contact whose page this is, plus anyone the operator picks, then confirmed
// against the SERVER-composed intro before anything is created.
//
// THREE STATES, EXACTLY ONE MODAL MOUNTED AT A TIME:
//
//   picking    - this modal, the member list + search + tag.
//   confirming - this modal unmounts, RosterConfirmDialog mounts.
//   connecting - the dialog unmounts, this modal re-mounts showing the result
//                panel instead of the member list.
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
import { useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  createRelayGroup,
  previewRelayGroup,
  type Contact,
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
  | { kind: 'connecting'; conversationId: string };

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
}

export function CreateRelayGroupModal({
  contact,
  candidates,
  onClose,
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
    void previewRelayGroup(members)
      .then((preview) => {
        setBusy(false);
        // THIS array value is carried into the create untouched.
        setPhase({ kind: 'confirming', members, preview });
      })
      .catch((err: unknown) => {
        // The picker keeps the error: an operator must never confirm a send
        // whose content could not be shown.
        setBusy(false);
        setError(refusalMessage(err));
      });
  };

  /** The dialog's confirm. A rejection PROPAGATES so the dialog renders it
   *  inline and stays open - that path is the dialog's, not ours. */
  const confirmCreate = async (): Promise<void> => {
    if (phase.kind !== 'confirming') return;
    const trimmedTag = tag.trim();
    const { conversation } = await createRelayGroup(
      phase.members,
      trimmedTag === '' ? undefined : trimmedTag,
    );
    settled.current = true;
    if (conversation.status === 'connecting') {
      setPhase({ kind: 'connecting', conversationId: conversation.conversationId });
      return;
    }
    void navigate('/conversations/' + conversation.conversationId);
    onClose();
  };

  /** Cancel / Escape / backdrop on the confirm dialog. After a SUCCESSFUL
   *  create the dialog calls this too, and then it must do nothing. */
  const leaveConfirm = (): void => {
    if (settled.current) return;
    setPhase({ kind: 'picking' });
  };

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

  return (
    <Modal
      title="Create a relay group"
      onClose={onClose}
      footer={
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
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
