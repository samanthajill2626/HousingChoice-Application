// GroupTextView — the NATIVE group text thread (/conversations/:id where the
// header's type is 'group_text'). Same two-pane shell as the relay group view,
// but a different product: this is a REAL carrier group chat that already exists
// on everyone's handset, so it has no pool number, no masking, no lifecycle, and
// no roster editing (a different set of people IS a different thread - spec 4.1).
//
// LEFT: the shared <Timeline> fed by useGroupThread. Members' messages carry
// relay_sender_key + delivery_recipients, so the existing sender chips and
// per-member delivery rollups light up unchanged (spec 4.3).
// RIGHT: a READ-ONLY member panel - who is in the thread, whether their NUMBER
// is suppressed, and whether their contact is deleted.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getGroupMembers,
  markConversationRead,
  type ConversationHeader,
  type ConversationParticipant,
  type GroupMemberRow,
} from '../../api/index.js';
import { Timeline } from '../contact/Timeline.js';
import { Card } from '../contact/Card.js';
import { formatPhoneDisplay } from '../../lib/phone.js';
import { groupThreadLabel } from '../../lib/groupThread.js';
import { useGroupThread } from './useGroupThread.js';
import shell from '../../ui/twoPaneShell.module.css';
import styles from './ConversationDetail.module.css';

/**
 * Max OUTSIDE members a group send can address. Twilio's documented cap is 10
 * participants per group conversation and our own projected address consumes
 * one of them. 9 is the SAFE direction: if the inference is wrong, a 10th member
 * is needlessly blocked - never an API failure mid-send (spec 6.1).
 */
export const MAX_SENDABLE_MEMBERS = 9;

/** A member's display: their resolved name, else the formatted phone. */
function memberLabel(m: GroupMemberRow): string {
  const name = m.name?.trim();
  if (name && name.length > 0) return name;
  return formatPhoneDisplay(m.phone) || m.phone;
}

/** The suppression chip's words. NEVER "opted out" flatly: the state is scoped
 *  to a NUMBER, and saying otherwise about a member who silenced a different
 *  number of theirs would be a lie staff would act on. */
function suppressionLabel(m: GroupMemberRow): string {
  return m.suppressionScope === 'secondary' ? 'This number opted out' : 'Opted out';
}

export interface GroupTextViewProps {
  conversationId: string;
  header: ConversationHeader;
}

export function GroupTextView({ conversationId, header }: GroupTextViewProps): React.JSX.Element {
  const [pane, setPane] = useState<'conversation' | 'details'>('conversation');
  const thread = useGroupThread(conversationId);

  // The roster is IMMUTABLE (written once at creation, spec 4.2), so the header
  // copy is the authoritative membership and renders instantly. The
  // group-members read only adds per-member STATE (suppression, deleted) - and
  // /members is relay-only by a positive type guard, so it would 404 here.
  const headerRoster = useMemo<GroupMemberRow[]>(
    () =>
      (header.participants ?? []).map((p) => ({
        contactId: p.contactId,
        phone: p.phone,
        ...(p.name !== undefined && { name: p.name }),
        suppressed: false,
        suppressionScope: 'no_contact' as const,
      })),
    [header.participants],
  );
  const [members, setMembers] = useState<GroupMemberRow[]>(headerRoster);
  const [membersStatus, setMembersStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMembersStatus('loading');
    getGroupMembers(conversationId, controller.signal)
      .then((roster) => {
        if (cancelled) return;
        setMembers(roster);
        setMembersStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        // The membership itself still renders from the header - only the STATE
        // is missing, and the panel says so rather than implying "nobody is
        // suppressed".
        setMembersStatus('error');
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [conversationId]);

  // Viewing the thread marks it read — the inbox unread badge clears once seen.
  useEffect(() => {
    void markConversationRead(conversationId).catch(() => {
      /* best-effort — a failed mark-read must not break the view */
    });
  }, [conversationId]);

  const title = groupThreadLabel(members);
  const overCap = members.length > MAX_SENDABLE_MEMBERS;
  const deletedMembers = members.filter((m) => m.deleted === true);

  // The roster the shared Timeline resolves sender + per-member delivery chips
  // against. Keys are phone-scoped for a native group (spec 15.6); the shared
  // resolver matches EITHER convention, so no mode flag rides down here.
  const timelineRoster: ConversationParticipant[] = members.map((m) => ({
    contactId: m.contactId,
    phone: m.phone,
    ...(m.name !== undefined && { name: m.name }),
  }));

  return (
    <div className={shell.page}>
      <header className={shell.header}>
        <Link to="/inbox" className={styles.backBtn} aria-label="Back to inbox">
          &larr;
        </Link>
        <div className={shell.identity}>
          <div className={shell.nameRow}>
            <span className={shell.name}>Group text</span>
          </div>
          <div className={styles.facts}>{title}</div>
          {/* The one thing staff must understand before they type: this is not a
           *  masked relay. Everyone's real number is already visible to everyone
           *  else, because the carrier group exists on their handsets. */}
          <p className={styles.groupUnmasked}>
            Everyone in this group text sees everyone&apos;s real number.
          </p>
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
          {overCap ? (
            <p role="status" className={styles.groupBanner}>
              This group text has {members.length} members, more than the {MAX_SENDABLE_MEMBERS} a
              group send can reach, so it is read-only. Reply to people one at a time from their
              contact pages, linked under Members.
            </p>
          ) : null}
          {/* COMPOSER SEAM (S5, T5.2): sending is OFF for the whole slice.
              A POST today falls through the relay branch into the 1:1 send path
              and dies on the missing participant_phone with an untyped,
              wrong-named relay error - so S4 ships no composer at all rather
              than a button that produces one. S5 lands the typed refusal and the
              group send, then flips `canSend` to `!overCap` and passes its own
              `onSend` (text only in v1; outbound group media is a follow-up). */}
          <Timeline
            status={thread.status}
            items={thread.items}
            upcoming={[]}
            upcomingTimezone={undefined}
            source="server"
            canSend={false}
            readOnlyNote={
              overCap
                ? 'Too many members to send as a group - reply one to one from the member links.'
                : 'Replying to a group text is coming next - open a member below to reply one to one.'
            }
            relayRoster={timelineRoster}
            resetScrollKey={conversationId}
          />
        </div>
        <div className={`${shell.right} ${pane === 'details' ? shell.paneActive : shell.paneHidden}`}>
          <div className={shell.rightInner}>
            <Card title="Members">
              {membersStatus === 'error' ? (
                <p role="alert" className={styles.error}>
                  We couldn&apos;t load member details. Opt-out state may be missing.
                </p>
              ) : null}
              <ul className={styles.memberList} aria-label="Group members">
                {members.map((m) => (
                  <li key={m.phone} className={styles.memberRow}>
                    {/* Link to the member's contact page when known - and for an
                     *  over-cap thread this list IS the reply affordance. */}
                    {m.contactId ? (
                      <Link to={`/contacts/${m.contactId}`} className={styles.memberLink}>
                        {memberLabel(m)}
                      </Link>
                    ) : (
                      <span className={styles.memberName}>{memberLabel(m)}</span>
                    )}
                    {/* The number is a SECOND line of information only when the
                        member has a name; for a nameless member the label
                        already IS the number, and repeating it reads as two
                        different people. */}
                    {m.name !== undefined && m.name.trim().length > 0 ? (
                      <span className={styles.memberMeta}>
                        {formatPhoneDisplay(m.phone) || m.phone}
                      </span>
                    ) : null}
                    {m.suppressed ? (
                      <span className={styles.memberFlag}>{suppressionLabel(m)}</span>
                    ) : null}
                    {m.deleted ? <span className={styles.memberFlag}>Deleted</span> : null}
                  </li>
                ))}
              </ul>
              {deletedMembers.length > 0 ? (
                <p className={styles.memberNote}>
                  A deleted contact is still in this group text on everyone&apos;s phones. Sending
                  is refused while they are deleted - restore them, or reply one to one.
                </p>
              ) : null}
            </Card>

            <Card title="About this thread">
              <p className={styles.memberNote}>
                A group text is a real carrier group chat that already exists on every member&apos;s
                phone. It has no masked number, no members to add or remove, and no close - a
                different set of people is a different thread.
              </p>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
