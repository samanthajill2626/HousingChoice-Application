// ConversationDetail — the /conversations/:conversationId view. It fetches the
// conversation header (GET /api/conversations/:id) and DISPATCHES by type:
//   • relay_group → the group view (transcript + reply + roster/close management)
//   • a plain 1:1 → REDIRECT to its owning contact (/contacts/:contactId); 1:1
//     threads live on the contact page, so this generic URL stays honest without
//     duplicating the timeline. An unresolvable contact degrades to a minimal
//     fallback link (never a crash).
//   • not found / unauthorized → the standard not-found treatment.
//
// The group view reuses the proven ContactDetail shell (ui/twoPaneShell): a dark
// header band over a two-pane body (Conversation LEFT / Details RIGHT) with a
// segmented toggle at ≤860px. LEFT = the shared <Timeline> fed by useRelayThread
// (a fixed conversationId, bypassing the 1:1-only resolveSingleConversation); the
// composer posts a team reply that the server fans out to all members. RIGHT =
// three cards (Group / Members / Actions). Sending is HARD-disabled when closed.
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import {
  addConversationMember,
  ApiError,
  closeConversation,
  getConversation,
  getConversationMembers,
  markConversationRead,
  removeConversationMember,
  sendMessage,
  type ConversationHeader,
  type ConversationParticipant,
  type RelayOwner,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { Timeline } from '../contact/Timeline.js';
import { Modal } from '../contact/Modal.js';
import { Card, CardAction, KV } from '../contact/Card.js';
import { ContactSearchField, type ContactSearchValue } from '../contact/ContactSearchField.js';
import { useContacts } from '../contacts/useContacts.js';
import { normalizeToE164, formatPhoneDisplay } from '../../lib/phone.js';
import { useRelayThread } from './useRelayThread.js';
import shell from '../../ui/twoPaneShell.module.css';
import styles from './ConversationDetail.module.css';

type LoadStatus = 'loading' | 'ready' | 'notfound' | 'error';

/** The first participant's contactId, tolerating BOTH wire shapes: a roster of
 *  `{ contactId }` objects (the contract) and a roster of bare contactId STRINGS
 *  (how some 1:1 conversations serialize). Undefined when none resolves. */
function firstParticipantContactId(participants: readonly unknown[] | undefined): string | undefined {
  for (const p of participants ?? []) {
    if (typeof p === 'string') {
      if (p.length > 0) return p;
    } else if (p !== null && typeof p === 'object') {
      const id = (p as { contactId?: unknown }).contactId;
      if (typeof id === 'string' && id.length > 0) return id;
    }
  }
  return undefined;
}

/** The owner's detail-page target + human label, or null when standalone/absent. */
function ownerTarget(owner: RelayOwner | undefined): { to: string; label: string } | null {
  if (owner === undefined || owner.type === null) return null;
  if (owner.type === 'tour') return { to: `/tours/${owner.id}`, label: 'Tour' };
  return { to: `/placements/${owner.id}`, label: 'Placement' };
}

/** A member's display: its resolved name, else the formatted phone. */
function memberDisplayName(m: ConversationParticipant): string {
  const name = m.name?.trim();
  if (name && name.length > 0) return name;
  return formatPhoneDisplay(m.phone) || m.phone;
}

export function ConversationDetail(): React.JSX.Element {
  const { conversationId = '' } = useParams<{ conversationId: string }>();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [header, setHeader] = useState<ConversationHeader | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    getConversation(conversationId, controller.signal)
      .then((c) => {
        if (cancelled) return;
        setHeader(c);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        // Missing / unauthorized → the standard not-found treatment (never a crash).
        if (err instanceof ApiError && (err.status === 404 || err.status === 401 || err.status === 403)) {
          setStatus('notfound');
          return;
        }
        setStatus('error');
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [conversationId]);

  if (status === 'loading') {
    return (
      <div className={styles.center}>
        <Spinner center />
      </div>
    );
  }

  if (status === 'notfound') {
    return (
      <div className={styles.center}>
        <p role="alert" className={styles.error}>
          We couldn&apos;t find this conversation.
        </p>
      </div>
    );
  }

  if (status === 'error' || header === null) {
    return (
      <div className={styles.center}>
        <p role="alert" className={styles.error}>
          We couldn&apos;t load this conversation.
        </p>
      </div>
    );
  }

  // A plain 1:1 lives on the contact page — redirect there. When the contact
  // can't be resolved, degrade to a minimal fallback link (never crash).
  if (header.type !== 'relay_group') {
    const contactId = firstParticipantContactId(header.participants as readonly unknown[] | undefined);
    if (contactId !== undefined) return <Navigate to={`/contacts/${contactId}`} replace />;
    const phone = typeof header.participant_phone === 'string' ? header.participant_phone : '';
    return (
      <div className={styles.fallback}>
        <p>This is a direct conversation. Open it on the contact:</p>
        <Link to={`/contacts/unknown?phone=${encodeURIComponent(phone)}`}>
          Open the contact
        </Link>
      </div>
    );
  }

  return <RelayGroupView conversationId={conversationId} header={header} onHeader={setHeader} />;
}

interface RelayGroupViewProps {
  conversationId: string;
  header: ConversationHeader;
  onHeader: (h: ConversationHeader) => void;
}

function RelayGroupView({ conversationId, header, onHeader }: RelayGroupViewProps): React.JSX.Element {
  const [pane, setPane] = useState<'conversation' | 'details'>('conversation');
  const thread = useRelayThread(conversationId);

  const [members, setMembers] = useState<ConversationParticipant[]>(header.participants ?? []);
  const [membersStatus, setMembersStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [addingMember, setAddingMember] = useState(false);
  const [addValue, setAddValue] = useState<ContactSearchValue>({ name: '' });
  const [addError, setAddError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ConversationParticipant | null>(null);
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // The candidate roster for the contact-search-first add field.
  const { contacts: allContacts } = useContacts('all');

  const closed = header.status === 'closed';

  // Load the roster (and refresh it whenever the conversation changes).
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMembersStatus('loading');
    getConversationMembers(conversationId, controller.signal)
      .then((roster) => {
        if (cancelled) return;
        setMembers(roster);
        setMembersStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setMembersStatus('error');
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [conversationId]);

  // Viewing the group marks it read — the Inbox unread badge clears once seen.
  useEffect(() => {
    void markConversationRead(conversationId).catch(() => {
      /* best-effort — a failed mark-read must not break the view */
    });
  }, [conversationId]);

  // Refetch the authoritative roster (used on a 409 roster_conflict).
  const refetchMembers = (): void => {
    getConversationMembers(conversationId)
      .then(setMembers)
      .catch(() => {
        /* leave the current roster; a transient refetch failure is non-fatal */
      });
  };

  // Composer: post a team reply (server fans out to all members). Optimistic,
  // mirroring ContactDetail's postSend. HARD-disabled when the group is closed.
  const canSend = !closed;
  const onSend = (body: string, attachmentKeys?: string[]): Promise<void> => {
    const tempId = thread.addOptimistic(conversationId, body, undefined, attachmentKeys);
    return sendMessage(conversationId, {
      body,
      ...(attachmentKeys !== undefined && attachmentKeys.length > 0 && { attachmentKeys }),
    })
      .then((result) => {
        thread.resolveOptimistic(tempId, result);
      })
      .catch((err: unknown) => {
        thread.failOptimistic(tempId);
        throw err;
      });
  };

  // Add a member: contact-search-first (resolve the picked contact's primary
  // phone), else a raw-phone fallback via normalizeToE164. Optimistic, with a
  // 409 roster_conflict → REFETCH.
  const submitAdd = (): void => {
    setAddError(null);
    let phone: string | undefined;
    let contactId: string | undefined;
    let name: string | undefined;
    if (addValue.contactId !== undefined) {
      const c = allContacts.find((x) => x.contactId === addValue.contactId);
      phone = c?.phones?.find((p) => p.primary)?.phone ?? c?.phone;
      contactId = addValue.contactId;
      name = addValue.name;
    } else {
      // Raw-phone fallback: the typed text is a phone number.
      phone = normalizeToE164(addValue.name);
    }
    if (phone === undefined) {
      setAddError('Enter a valid phone number, or pick a contact.');
      return;
    }
    const resolvedPhone = phone;
    if (members.some((m) => m.phone === resolvedPhone)) {
      setAddError('That number is already a member.');
      return;
    }
    const optimistic: ConversationParticipant = {
      contactId: contactId ?? '',
      phone: resolvedPhone,
      ...(name !== undefined && name.length > 0 && { name }),
    };
    const prev = members;
    setMembers((m) => [...m, optimistic]);
    setAddingMember(false);
    setAddValue({ name: '' });
    addConversationMember(conversationId, {
      phone: resolvedPhone,
      ...(contactId !== undefined && { contactId }),
      ...(name !== undefined && name.length > 0 && { name }),
    })
      .then(setMembers)
      .catch((err: unknown) => {
        setMembers(prev);
        if (err instanceof ApiError && err.status === 409 && err.code === 'roster_conflict') {
          // The roster changed under us — refetch (don't swallow) and let the
          // operator retry against the fresh roster.
          refetchMembers();
          setAddError('The roster just changed — refreshed it. Try adding again.');
        } else {
          setAddError("Couldn't add that member. Please try again.");
        }
        setAddingMember(true);
      });
  };

  // Remove a member (confirmed). Optimistic, with a 409 roster_conflict → REFETCH.
  const doRemove = (): void => {
    const member = removing;
    if (member === null) return;
    setRemoving(null);
    const prev = members;
    setMembers((m) => m.filter((x) => x.phone !== member.phone));
    removeConversationMember(conversationId, member.phone)
      .then(setMembers)
      .catch((err: unknown) => {
        setMembers(prev);
        if (err instanceof ApiError && err.status === 409 && err.code === 'roster_conflict') {
          refetchMembers();
        }
      });
  };

  // Close / reopen (confirmed). The returned header carries the new status +
  // pool number; apply it in place.
  const applyClose = (next: boolean): void => {
    setActionBusy(true);
    setActionError(null);
    closeConversation(conversationId, next)
      .then((updated) => {
        onHeader(updated);
        setClosing(false);
        setReopening(false);
      })
      .catch(() => {
        setActionError(next ? "Couldn't close the group." : "Couldn't reopen the group.");
      })
      .finally(() => setActionBusy(false));
  };

  const owner = ownerTarget(header.owner);
  const memberNames = useMemo(
    () => members.map((m) => m.name?.trim()).filter((n): n is string => !!n && n.length > 0),
    [members],
  );
  const identityFacts =
    memberNames.length > 0
      ? `With ${memberNames.join(' & ')}`
      : formatPhoneDisplay(header.pool_number) || 'Group text';

  return (
    <div className={shell.page}>
      <header className={shell.header}>
        <Link to="/inbox" className={styles.backBtn} aria-label="Back to inbox">
          ←
        </Link>
        <div className={shell.identity}>
          <div className={shell.nameRow}>
            <span className={shell.name}>Group text</span>
            <span
              className={`${styles.statusPill} ${closed ? styles.statusClosed : styles.statusOpen}`}
            >
              {closed ? 'Closed' : 'Open'}
            </span>
          </div>
          <div className={styles.facts}>{identityFacts}</div>
        </div>
        <div className={shell.actions}>
          <button
            type="button"
            className={styles.actionBtn}
            disabled={closed}
            onClick={() => {
              setAddingMember(true);
              setPane('details');
            }}
          >
            Add member
          </button>
          {closed ? (
            <button
              type="button"
              className={styles.actionBtn}
              disabled={actionBusy}
              onClick={() => setReopening(true)}
            >
              Reopen
            </button>
          ) : (
            <button
              type="button"
              className={styles.actionBtn}
              disabled={actionBusy}
              onClick={() => setClosing(true)}
            >
              Close
            </button>
          )}
        </div>
      </header>

      {/* Narrow-width segmented toggle (hidden on wide via the shell CSS). */}
      <div className={shell.segMobile} role="group" aria-label="View">
        <button
          type="button"
          className={pane === 'conversation' ? shell.segOn : shell.segBtn}
          aria-pressed={pane === 'conversation'}
          onClick={() => setPane('conversation')}
        >
          Conversation
        </button>
        <button
          type="button"
          className={pane === 'details' ? shell.segOn : shell.segBtn}
          aria-pressed={pane === 'details'}
          onClick={() => setPane('details')}
        >
          Details
        </button>
      </div>

      <div className={shell.body}>
        <div
          className={`${shell.left} ${pane === 'conversation' ? shell.paneActive : shell.paneHidden}`}
        >
          <Timeline
            status={thread.status}
            items={thread.items}
            upcoming={thread.upcoming}
            source="server"
            canSend={canSend}
            {...(canSend && { onSend })}
            relayRoster={members}
            relayClosed={closed}
            resetScrollKey={conversationId}
          />
        </div>
        <div className={`${shell.right} ${pane === 'details' ? shell.paneActive : shell.paneHidden}`}>
          <div className={shell.rightInner}>
            {/* --- Group card --- */}
            <Card title="Group">
              <KV k="Pool number" v={formatPhoneDisplay(header.pool_number) || '—'} />
              <KV
                k="Owner"
                v={
                  owner ? (
                    <Link to={owner.to}>{owner.label}</Link>
                  ) : (
                    <span className={styles.memberMeta}>Standalone</span>
                  )
                }
              />
              <KV k="Status" v={closed ? 'Closed' : 'Open'} />
              {header.placement_tag && header.placement_tag.length > 0 ? (
                <KV k="Tag" v={header.placement_tag} />
              ) : null}
            </Card>

            {/* --- Members card --- */}
            <Card
              title="Members"
              aside={
                <CardAction onClick={() => setAddingMember((v) => !v)} label="Add a member">
                  + Add
                </CardAction>
              }
            >
              {membersStatus === 'error' ? (
                <p role="alert" className={styles.error}>
                  We couldn&apos;t load the members.
                </p>
              ) : (
                <ul className={styles.memberList} aria-label="Group members">
                  {members.map((m) => (
                    <li key={m.phone} className={styles.memberRow}>
                      {/* Link to the member's contact page when known; an
                       *  unknown-number member (no contactId) stays plain text. */}
                      {m.contactId ? (
                        <Link to={`/contacts/${m.contactId}`} className={styles.memberLink}>
                          {memberDisplayName(m)}
                        </Link>
                      ) : (
                        <span className={styles.memberName}>{memberDisplayName(m)}</span>
                      )}
                      <span className={styles.memberMeta}>{formatPhoneDisplay(m.phone) || m.phone}</span>
                      <button
                        type="button"
                        className={styles.remove}
                        aria-label={`Remove ${memberDisplayName(m)}`}
                        onClick={() => setRemoving(m)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {addingMember ? (
                <div className={styles.addForm}>
                  <p className={styles.addHint}>Search a contact, or type a phone number.</p>
                  <ContactSearchField
                    value={addValue}
                    onChange={(v) => {
                      setAddValue(v);
                      setAddError(null);
                    }}
                    candidates={allContacts}
                    inputLabel="Add member"
                  />
                  {addError !== null ? (
                    <p role="alert" className={styles.error}>
                      {addError}
                    </p>
                  ) : null}
                  <div className={styles.addActions}>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => {
                        setAddingMember(false);
                        setAddValue({ name: '' });
                        setAddError(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      onClick={submitAdd}
                      disabled={addValue.name.trim().length === 0}
                    >
                      Add
                    </Button>
                  </div>
                </div>
              ) : null}
            </Card>

            {/* --- Actions card --- */}
            <Card title="Actions">
              {closed ? (
                <Button variant="secondary" size="sm" type="button" onClick={() => setReopening(true)}>
                  Reopen group
                </Button>
              ) : (
                <Button variant="danger" size="sm" type="button" onClick={() => setClosing(true)}>
                  Close group
                </Button>
              )}
            </Card>
          </div>
        </div>
      </div>

      {removing !== null ? (
        <Modal
          title="Remove member?"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button variant="secondary" size="sm" type="button" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" type="button" onClick={doRemove}>
                Remove
              </Button>
            </>
          }
        >
          <p>
            <strong>{memberDisplayName(removing)}</strong> will be removed from this group text and
            will no longer receive its messages.
          </p>
        </Modal>
      ) : null}

      {closing ? (
        <Modal
          title="Close group?"
          onClose={() => {
            if (!actionBusy) {
              setClosing(false);
              setActionError(null);
            }
          }}
          footer={
            <>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setClosing(false)}
                disabled={actionBusy}
              >
                Cancel
              </Button>
              <Button variant="danger" size="sm" type="button" onClick={() => applyClose(true)} disabled={actionBusy}>
                {actionBusy ? 'Closing…' : 'Close group'}
              </Button>
            </>
          }
        >
          <p>
            Closing this group <strong>releases the pool number</strong> — members can no longer
            reach the group at that number, and sending is disabled.
          </p>
          {actionError !== null ? (
            <p role="alert" className={styles.error}>
              {actionError}
            </p>
          ) : null}
        </Modal>
      ) : null}

      {reopening ? (
        <Modal
          title="Reopen group?"
          onClose={() => {
            if (!actionBusy) {
              setReopening(false);
              setActionError(null);
            }
          }}
          footer={
            <>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setReopening(false)}
                disabled={actionBusy}
              >
                Cancel
              </Button>
              <Button size="sm" type="button" onClick={() => applyClose(false)} disabled={actionBusy}>
                {actionBusy ? 'Reopening…' : 'Reopen group'}
              </Button>
            </>
          }
        >
          <p>
            Reopening <strong>provisions a fresh pool number and re-intros members</strong> — the
            group gets a new number and everyone is reconnected.
          </p>
          {actionError !== null ? (
            <p role="alert" className={styles.error}>
              {actionError}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
