// GroupTextView - the NATIVE group text thread (/conversations/:id where the
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
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getGroupMembers,
  markConversationRead,
  sendMessage,
  type ConversationHeader,
  type ConversationParticipant,
  type GroupMemberRow,
} from '../../api/index.js';
import { Timeline } from '../contact/Timeline.js';
import { Card } from '../contact/Card.js';
import { formatPhoneDisplay } from '../../lib/phone.js';
import { groupMemberLabel, groupThreadLabel } from '../../lib/groupThread.js';
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

/**
 * How often the member panel re-reads itself while the thread is open (fix wave
 * 4, item 3).
 *
 * THE GAP THIS COVERS, stated plainly because it is a real product hole and not
 * a nicety. The panel's beat is `thread.refetchSignal` - the debounced SSE tick
 * - and SSE only ticks for events emitted ON THIS THREAD. Number-scoped
 * suppression is not one of them: a member texting STOP to their 1:1 thread
 * flips their suppression state through the 1:1 conversation row, which emits
 * `message.persisted` for THAT conversation. Nothing is emitted here, so the
 * group panel keeps rendering the member as reachable, and the header keeps
 * saying nobody has opted out, until something else on this thread happens to
 * tick or the operator reloads. (The reverse case - a member texting STOP INTO
 * the group - does tick, because that inbound is filed on this thread.)
 *
 * A slow poll plus a refetch on window focus does not close that gap, it BOUNDS
 * it: the panel is at most this stale, and returning to the tab is always
 * fresh. The proper fix is a number-scoped suppression event fanned out to every
 * thread the number is in, which is a server change with its own design, filed
 * as `docs/issues/number-suppression-change-emits-no-cross-thread-event.md`
 * rather than smuggled in here.
 *
 * Slow on purpose: this is a read of N contacts plus N suppression lookups, and
 * the screen is one an operator leaves open.
 */
export const MEMBERS_REFRESH_MS = 60_000;

/** The suppression chip's words. NEVER "opted out" flatly: the state is scoped
 *  to a NUMBER, and saying otherwise about a member who silenced a different
 *  number of theirs would be a lie staff would act on. */
function suppressionLabel(m: GroupMemberRow): string {
  return m.suppressionScope === 'secondary' ? 'This number opted out' : 'Opted out';
}

export interface GroupTextViewProps {
  conversationId: string;
  header: ConversationHeader;
  /** Apply a fresher header in place - the same seam the relay arm uses. Here it
   *  carries the roster-name CONVERGENCE (adversarial 17): `/group-members`
   *  resolves fresher contact names AND writes them back to the stored snapshot
   *  server-side, so the header has to adopt them or it contradicts the panel
   *  beside it (and, once the write-back lands, the inbox row too). */
  onHeader: (h: ConversationHeader) => void;
}

export function GroupTextView({
  conversationId,
  header,
  onHeader,
}: GroupTextViewProps): React.JSX.Element {
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
  // STICKY (adversarial 19 / conformance F8). A read FAILED and has not since
  // succeeded - deliberately not a three-state status. There is no `loading`
  // branch in the render, so the old per-tick `setMembersStatus('loading')` was
  // indistinguishable from `ready`: every tick silently withdrew the alert for
  // the duration of the request, and with /group-members failing under steady
  // SSE traffic the alert stopped rendering at all once latency exceeded the
  // inter-tick gap. That is the exact false negative A27 exists to prevent. It
  // is raised by a failure and lowered only by a SUCCESS.
  const [membersReadFailed, setMembersReadFailed] = useState(false);

  // Latest-value boxes for the convergence write below. They must not be effect
  // dependencies: the effect's beat is the SSE tick, and re-running it because a
  // header object changed identity is precisely the extra read this wave is
  // removing (adversarial 20).
  const headerRef = useRef(header);
  const onHeaderRef = useRef(onHeader);
  useEffect(() => {
    headerRef.current = header;
    onHeaderRef.current = onHeader;
  });

  // A15. The member panel is REFETCHED on the same debounced SSE tick that
  // refetches the transcript (`thread.refetchSignal`), because the two are one
  // screen: a member texts STOP, the receipts path records the suppression and
  // emits message.persisted, and the bubble's delivery chip updates. A panel
  // frozen at mount then keeps that member chipless and the banner silent - two
  // contradictory statements side by side, on the screen staff use to decide
  // whether to text a group, reconciled only by a reload.
  //
  // OVERLAP GUARD: a generation ref, not just the AbortController. Abort covers
  // the request we know about; the generation covers a response that was already
  // resolving when the next tick started, so a slow first read can never land on
  // top of a newer one.
  //
  // ...AND ON THREE OTHER BEATS (fix wave 4, item 3), because the SSE tick alone
  // leaves the panel able to sit wrong indefinitely: a RETRY the operator can
  // press, window FOCUS, and a slow INTERVAL. `membersRefreshTick` is what all
  // three move; the effect is otherwise unchanged, so the generation guard and
  // the abort still cover every one of them. See MEMBERS_REFRESH_MS for what
  // this bounds and what it does not fix.
  const [membersRefreshTick, setMembersRefreshTick] = useState(0);
  const refreshMembers = (): void => {
    setMembersRefreshTick((t) => t + 1);
  };
  useEffect(() => {
    // VISIBILITY-GATED. An operator with the thread open in a background tab is
    // the normal case on this screen, and polling a hidden tab spends N contact
    // reads a minute to update pixels nobody is looking at. The focus listener
    // is what makes coming back to the tab immediate, so the interval only has
    // to cover the tab that is already in front of them.
    const onFocus = (): void => {
      refreshMembers();
    };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        refreshMembers();
      }
    }, MEMBERS_REFRESH_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, []);

  const membersGenRef = useRef(0);
  useEffect(() => {
    membersGenRef.current += 1;
    const gen = membersGenRef.current;
    const controller = new AbortController();
    getGroupMembers(conversationId, controller.signal)
      .then((roster) => {
        if (gen !== membersGenRef.current) return;
        setMembers(roster);
        setMembersReadFailed(false);
        // CONVERGENCE (adversarial 17), applying client-side exactly the
        // transform the route applies server-side: a resolved name replaces the
        // snapshot's for that phone, everything else is left alone. The route
        // writes that same roster back (backfillGroupTextRoster), so this is not
        // the header inventing a title from a different input - it is the header
        // reading the input it is about to be given. Silent otherwise, so a
        // snapshot that is already current re-renders nothing.
        //
        // WHERE THIS DIVERGES FROM THE SERVER, RECORDED RATHER THAN PRETENDED
        // AWAY (fix wave 4, item 10; wording corrected post-verification). The
        // staleness COMPARISON itself is fully reproducible client-side: the
        // served `name` is contactName-else-rosterName, so served-vs-stored
        // inequality holds exactly when the route's rosterNamesAreStale did.
        // What the client genuinely cannot observe is whether the route's
        // best-effort WRITE-BACK succeeded. Two consequences follow and both
        // are accepted:
        //   - if the route's own `backfillGroupTextRoster` write FAILS (it is
        //     best-effort and logs a WARN), this header still adopts the fresher
        //     names while the inbox row keeps the numbers. The panel and the
        //     header agree, which is the pair an operator reads side by side;
        //     the inbox catches up on the next successful read.
        //   - on the FIRST open after a nameless stub is triaged into a real
        //     contact, the header renders the snapshot's numbers and then
        //     re-titles a beat later. That flicker is the price of not titling
        //     the header from `members` directly (A13), which is what made the
        //     divergence permanent.
        // The comparison is TRIMMED on both sides so a whitespace-only
        // difference - which the route does not consider stale and therefore
        // never writes back - cannot re-title on every single open.
        const prior = headerRef.current.participants ?? [];
        let changed = false;
        const refreshed = prior.map((p) => {
          const resolved = roster.find((r) => r.phone === p.phone);
          const name = resolved?.name?.trim();
          if (name === undefined || name.length === 0 || name === p.name?.trim()) return p;
          changed = true;
          return { ...p, name };
        });
        if (changed) onHeaderRef.current({ ...headerRef.current, participants: refreshed });
      })
      .catch((err: unknown) => {
        if (gen !== membersGenRef.current || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        // The membership itself still renders from the header, and the last
        // roster we DID read stays on screen - blanking it would trade a stale
        // truth for no truth. Only the STATE is missing, and the panel says so
        // rather than implying "nobody is suppressed".
        setMembersReadFailed(true);
      });
    return () => {
      controller.abort();
    };
  }, [conversationId, thread.refetchSignal, membersRefreshTick]);

  // THE PER-THREAD RESET EFFECT THAT USED TO LIVE HERE IS GONE (fix wave 4, item
  // 10) - it could not run. It guarded against a stale `membersReadFailed`
  // carrying from one thread to the next "under a live mount", but there is no
  // live mount to carry across: `ConversationDetail`'s header effect calls
  // `setStatus('loading')` synchronously on every `conversationId` change, which
  // renders the spinner branch and UNMOUNTS this component. A fresh mount starts
  // from `useState(false)` and the header's own roster, which is exactly what
  // the effect was reaching for. Dead code that looks like a safety net is worse
  // than no safety net: the next reader trusts it.

  // Viewing the thread marks it read - the inbox unread badge clears once seen.
  // DELIBERATELY UNWIRED from the badge's optimistic layer (the same ruling
  // useMarkContactRead carries, and its regression test): this fires BLIND on
  // mount, with no unread knowledge, so an optimistic decrement here could
  // subtract a row the badge never counted. It reconciles through the cheap
  // count refetch this mark-read's own SSE event triggers. The visible
  // asymmetry is intended - opening a thread from an Inbox ROW decrements
  // instantly (useInbox knows that row's unread), opening it from Today or a
  // deep link does not. Wiring it later is safe (the clear key would be
  // `cv:<conversationId>`, the vocabulary useInbox already mints, so the two
  // would dedupe rather than double-decrement) but it needs the unread count.
  useEffect(() => {
    void markConversationRead(conversationId).catch(() => {
      /* best-effort - a failed mark-read must not break the view */
    });
  }, [conversationId]);

  // A13 (dashboard half), as corrected by adversarial 17. ONE naming rule
  // (`groupThreadLabel`, mirrored server-side in app/src/lib/groupTitle.ts for
  // the inbox row and the contact card) over ONE input: the participants
  // SNAPSHOT, converged above with whatever fresher names the members read
  // found. Titling the header from the resolved `members` DIRECTLY is what A13
  // removed and must stay removed - the snapshot is the roster all three
  // surfaces share - but ignoring the convergence made the header contradict the
  // panel two inches away for the life of the mount. The resolved `members`
  // still owns the member PANEL below, where per-person detail belongs.
  const title = groupThreadLabel(headerRoster);
  const overCap = members.length > MAX_SENDABLE_MEMBERS;
  const deletedMembers = members.filter((m) => m.deleted === true);
  // A27(b). `suppressionUnknown` means the read behind that member FAILED, so
  // `suppressed:false` is the ABSENCE of an answer. Counting only
  // `suppressed === true` made those members invisible outside a chip in the
  // Details pane. They are surfaced separately, and never as "opted out" - we
  // do not know that, and staff would act on the claim.
  const unknownStateMembers = members.filter((m) => m.suppressionUnknown === true);
  // PRECEDENCE, the panel chip's (adversarial 18): UNKNOWN outranks suppressed,
  // so the two sets are DISJOINT and every member is counted exactly once. Both
  // flags can be true for one person through a real server path - a
  // `contacts.findByPhone` failure marks the member unknown while the
  // conversations-GSI read behind it still answers `suppressed: true` - and
  // without this the same screen said "1 member opted out" AND "Opt-out state
  // unknown for 1 member" about that one person, with the chip corroborating
  // neither. When we could not read the state we do not get to assert it.
  const suppressedMembers = members.filter(
    (m) => m.suppressed === true && m.suppressionUnknown !== true,
  );

  // Composer (S5). Sending is OFF only when it is STRUCTURALLY impossible - an
  // over-cap roster is permanently unsendable, so its note replaces the composer
  // outright. The other blockers (a deleted member, a member with no consent
  // basis) are SERVER refusals: they are surfaced here as standing notes, but the
  // composer stays live because the state can change under the operator (a
  // restore, a consent record) and the server is the authority either way.
  const canSend = !overCap;
  const onSend = (body: string): Promise<void> => {
    const tempId = thread.addOptimistic(conversationId, body);
    return sendMessage(conversationId, { body })
      .then((result) => {
        thread.resolveOptimistic(tempId, result);
      })
      .catch((err: unknown) => {
        thread.failOptimistic(tempId);
        // Rethrown so the composer restores the draft and renders the mapped
        // refusal reason - losing the operator's words to a 409 is the failure
        // this whole seam exists to avoid.
        throw err;
      });
  };

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
          {/* A27(c). The Details pane (and its per-member chips) is display:none
           *  at <=860px, and the left-pane banners live inside the Conversation
           *  pane, so on a phone this thread used to look entirely normal with
           *  ZERO indication that a member was opted out or that their state was
           *  never read. The header is the one region rendered at every width, so
           *  the reachability summary belongs here as well. Deliberately NOT
           *  role="status": the left-pane banners already announce it, and two
           *  live regions saying the same thing is noise for a screen reader. */}
          {suppressedMembers.length > 0 || unknownStateMembers.length > 0 ? (
            <p className={styles.groupHeaderFlags}>
              {suppressedMembers.length > 0 ? (
                <span className={styles.groupHeaderFlag}>
                  {suppressedMembers.length === 1
                    ? '1 member opted out'
                    : `${suppressedMembers.length} members opted out`}
                </span>
              ) : null}
              {unknownStateMembers.length > 0 ? (
                <span className={styles.groupHeaderFlag}>
                  {unknownStateMembers.length === 1
                    ? 'Opt-out state unknown for 1 member'
                    : `Opt-out state unknown for ${unknownStateMembers.length} members`}
                </span>
              ) : null}
            </p>
          ) : null}
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
          {/* The notices and the timeline STACK. `shell.left` is a flex row (its
           *  only child on every other page is the timeline), so rendering these
           *  as bare siblings turned each one into a column beside the
           *  conversation - the live-QA L5 report of a "huge left panel". */}
          <div className={styles.groupLeftStack}>
            {overCap ? (
              <p role="status" className={styles.groupBanner}>
                This group text has {members.length} members, more than the {MAX_SENDABLE_MEMBERS} a
                group send can reach, so it is read-only. Reply to people one at a time from their
                contact pages, linked under Members.
              </p>
            ) : null}
            {deletedMembers.length > 0 ? (
              <p role="status" className={styles.groupBanner}>
                Sending is refused while a member is a deleted contact. Restore them, or reply one
                to one from the member links.
              </p>
            ) : null}
            {/* COPY CORRECTED (live QA round 2): this used to say "their carrier
             *  drops it", which the live evidence contradicts. Twilio's
             *  Conversations layer SKIPS an opted-out participant outright - it
             *  never creates the leg, so the carrier never sees the message and
             *  no delivery receipt is ever sent for it. Saying "their carrier
             *  drops it" would send an operator looking for a carrier failure
             *  that does not exist. */}
            {suppressedMembers.length > 0 ? (
              <p role="status" className={styles.groupNotice}>
                {suppressedMembers.length === 1
                  ? 'One member has'
                  : `${suppressedMembers.length} members have`}{' '}
                opted out. The group text still goes to everyone else - Twilio skips them, so their
                phone never receives it and their delivery chip says so.
              </p>
            ) : null}
            {/* A27(b). HONEST, and deliberately not folded into the banner above:
             *  a failed read is not an opt-out. Saying "N members have opted out"
             *  about someone we could not read would be a claim staff act on
             *  (they would stop texting a reachable person); saying nothing at
             *  all reads as "everyone is reachable", which is the false negative
             *  the suppressionUnknown flag exists to prevent. */}
            {unknownStateMembers.length > 0 ? (
              <p role="status" className={styles.groupNotice}>
                {unknownStateMembers.length === 1
                  ? 'Opt-out state could not be read for 1 member.'
                  : `Opt-out state could not be read for ${unknownStateMembers.length} members.`}{' '}
                They may or may not have opted out. The send still goes to the whole group, and
                Twilio skips anyone who has.
              </p>
            ) : null}
            <Timeline
              status={thread.status}
              items={thread.items}
              upcoming={[]}
              upcomingTimezone={undefined}
              source="server"
              canSend={canSend}
              {...(canSend && { onSend })}
              {...(overCap && {
                readOnlyNote:
                  'Too many members to send as a group - reply one to one from the member links.',
              })}
              relayRoster={timelineRoster}
              rosterKind="group_text"
              paging={{
                hasOlder: thread.hasOlder,
                loadingOlder: thread.loadingOlder,
                olderPagesLoaded: thread.olderPagesLoaded,
                onLoadOlder: thread.loadOlder,
              }}
              resetScrollKey={conversationId}
            />
          </div>
        </div>
        <div className={`${shell.right} ${pane === 'details' ? shell.paneActive : shell.paneHidden}`}>
          <div className={shell.rightInner}>
            <Card title="Members">
              {/* STICKY, AND NOW ESCAPABLE (fix wave 4, item 3). The alert is
               *  raised by a failure and lowered only by a SUCCESS, which was
               *  right and left the operator with nothing to do about it but
               *  reload the page: the panel's only other beat is an SSE tick
               *  this thread may not produce for hours. A retry is one request
               *  and it is the request the alert is about. */}
              {membersReadFailed ? (
                <p role="alert" className={styles.error}>
                  We couldn&apos;t load member details. Opt-out state may be missing.{' '}
                  <button type="button" className={styles.linkBtn} onClick={refreshMembers}>
                    Try again
                  </button>
                </p>
              ) : null}
              <ul className={styles.memberList} aria-label="Group members">
                {members.map((m) => (
                  <li key={m.phone} className={styles.memberRow}>
                    {/* Link to the member's contact page when known - and for an
                     *  over-cap thread this list IS the reply affordance. */}
                    {m.contactId ? (
                      <Link to={`/contacts/${m.contactId}`} className={styles.memberLink}>
                        {groupMemberLabel(m)}
                      </Link>
                    ) : (
                      <span className={styles.memberName}>{groupMemberLabel(m)}</span>
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
                    {/* UNKNOWN outranks the suppression chip. A read behind this
                        member failed server-side, so `suppressed:false` is the
                        absence of an answer - saying nothing here would read as
                        "reachable", which is the false negative that matters on
                        the screen staff use to decide whether to text a group. */}
                    {m.suppressionUnknown === true ? (
                      <span className={styles.memberFlag}>Opt-out state unknown</span>
                    ) : m.suppressed ? (
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
