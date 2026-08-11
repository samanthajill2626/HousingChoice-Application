// rosterWrites - the owner-agnostic seam over the roster endpoints, stated ONCE
// so the People card and both hubs cannot drift about WHICH endpoint a click
// reaches (contact-rosters spec section 7).
//
// There are two tour/placement mirrors of every roster endpoint. Without this
// seam the card would carry a `scope === 'tour' ? ... : ...` at each of six call
// sites, which is exactly how a placement quietly ends up posting to a tour
// route - or worse, how one hub keeps the raw relay member route (spec's
// call-through rule) while the other moves on.
import {
  ApiError,
  addPlacementRosterLiveMember,
  addPlacementRosterMember,
  addTourRosterLiveMember,
  addTourRosterMember,
  applyPlacementRosterActionNow,
  applyTourRosterActionNow,
  cancelPlacementRosterAction,
  cancelTourRosterAction,
  dismissPlacementRosterAction,
  dismissTourRosterAction,
  previewPlacementRosterAdd,
  previewPlacementRosterOpen,
  previewTourRosterAdd,
  previewTourRosterOpen,
  removePlacementRosterLiveMember,
  removePlacementRosterMember,
  removeTourRosterLiveMember,
  removeTourRosterMember,
  resetPlacementRoster,
  resetTourRoster,
  type RosterActionKind,
  type RosterActionSkipReason,
  type RosterMemberInput,
  type RosterPendingAction,
  type RosterPreview,
  type RosterSkippedAction,
  type RosterView,
} from '../../api/index.js';

/** WHICH tour or placement a roster belongs to. */
export interface RosterOwner {
  type: 'tour' | 'placement';
  id: string;
}

/** Every roster write/preview for ONE owner. `addLive` / `removeLive` are the
 *  OWNER-SCOPED call-through - never the raw relay member routes, which stay
 *  for standalone groups (the deferral + announcement policy lives on these). */
export interface RosterApi {
  addPlan: (member: RosterMemberInput) => Promise<RosterView>;
  removePlan: (memberKey: string) => Promise<RosterView>;
  reset: () => Promise<RosterView>;
  /** `force` is the confirm dialog's "Send now anyway": inside quiet hours the
   *  plain add DEFERS (202 + a pending row) and only this bypasses it. */
  addLive: (contactId: string, force: boolean) => Promise<RosterView>;
  removeLive: (memberKey: string) => Promise<RosterView>;
  previewOpen: (signal?: AbortSignal) => Promise<RosterPreview>;
  previewAdd: (contactId: string) => Promise<RosterPreview>;
  /** The three ways a quiet-hours deferral ends (spec 6.5). */
  cancelPending: (actionId: string) => Promise<RosterView>;
  applyPendingNow: (actionId: string) => Promise<RosterView>;
  dismissPending: (actionId: string) => Promise<RosterView>;
}

export function rosterApi(owner: RosterOwner): RosterApi {
  const { id } = owner;
  return owner.type === 'tour'
    ? {
        addPlan: (member) => addTourRosterMember(id, member),
        removePlan: (memberKey) => removeTourRosterMember(id, memberKey),
        reset: () => resetTourRoster(id),
        addLive: (contactId, force) => addTourRosterLiveMember(id, contactId, { force }),
        removeLive: (memberKey) => removeTourRosterLiveMember(id, memberKey),
        previewOpen: (signal) => previewTourRosterOpen(id, signal),
        previewAdd: (contactId) => previewTourRosterAdd(id, contactId),
        cancelPending: (actionId) => cancelTourRosterAction(id, actionId),
        applyPendingNow: (actionId) => applyTourRosterActionNow(id, actionId),
        dismissPending: (actionId) => dismissTourRosterAction(id, actionId),
      }
    : {
        addPlan: (member) => addPlacementRosterMember(id, member),
        removePlan: (memberKey) => removePlacementRosterMember(id, memberKey),
        reset: () => resetPlacementRoster(id),
        addLive: (contactId, force) => addPlacementRosterLiveMember(id, contactId, { force }),
        removeLive: (memberKey) => removePlacementRosterLiveMember(id, memberKey),
        previewOpen: (signal) => previewPlacementRosterOpen(id, signal),
        previewAdd: (contactId) => previewPlacementRosterAdd(id, contactId),
        cancelPending: (actionId) => cancelPlacementRosterAction(id, actionId),
        applyPendingNow: (actionId) => applyPlacementRosterActionNow(id, actionId),
        dismissPending: (actionId) => dismissPlacementRosterAction(id, actionId),
      };
}

// --- Quiet-hours copy, stated ONCE (spec 6.5) -------------------------------
//
// The card, the confirm dialog and the [Open relay group] control all say the
// same things about a deferral, so they say them from here. The INSTANT is
// always the server's (it owns the DST-safe window math); we only format it.

/** A clock label for an ISO instant, in the VIEWER's zone (the ToursPage
 *  idiom). Empty string for an unparseable instant - a broken clock must never
 *  render as "Invalid Date" in front of staff. */
export function quietClockLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** The banner on a pending row / the open control: "Joins at 8:00 AM - quiet
 *  hours" / "Opens at 8:00 AM - quiet hours" (spec 6.5). */
export function pendingActionNote(action: RosterPendingAction): string {
  const verb = action.kind === 'add_member' ? 'Joins' : 'Opens';
  const clock = quietClockLabel(action.dueAt);
  return clock === ''
    ? `${verb} when quiet hours end`
    : `${verb} at ${clock} - quiet hours`;
}

/** WHO/WHAT a notice is about, mid-sentence ("Alicia Grant" / "the group
 *  text"). Also the dismiss control's subject, so the two never disagree. */
export function skippedActionSubject(row: RosterSkippedAction): string {
  if (row.kind === 'open_group') return 'the relay group';
  return row.name ?? 'that contact';
}

/**
 * The whole notice, in one honest sentence (spec 6.5). EVERY reason the server
 * can serve gets one: an operator who comes back at 8:05 must be able to tell
 * what happened without reading a log. `'canceled'` is a human's own decision,
 * so it reads as a fact, never as a failure.
 */
export function skippedActionNote(
  row: RosterSkippedAction,
  scope: 'tour' | 'placement',
): string {
  const mid = skippedActionSubject(row);
  const subject = mid.charAt(0).toUpperCase() + mid.slice(1);
  const verb = row.kind === 'add_member' ? 'was not added' : 'was not opened';
  if (row.reason === 'canceled') return `Canceled - ${mid} ${verb}.`;
  return `${subject} ${verb} - ${skipTail(row.reason, row.kind, scope)}`;
}

/** The "why" half of a notice. Exhaustive over the server's union, so widening
 *  it upstream is a TYPE error here rather than a blank row. */
function skipTail(
  reason: RosterActionSkipReason,
  kind: RosterActionKind,
  scope: 'tour' | 'placement',
): string {
  switch (reason) {
    case 'group_closed':
      return kind === 'add_member' ? 'the relay group was closed.' : 'it had already been closed.';
    case 'owner_canceled':
      return scope === 'tour' ? 'this tour was canceled.' : 'this placement closed.';
    case 'already_member':
      return 'they were already on the relay group.';
    case 'contact_deleted':
      return 'that contact is gone or has no mobile number.';
    case 'member_no_longer_on_roster':
      return `they were removed from this ${scope} first.`;
    case 'roster_too_thin':
      return 'two reachable members are needed.';
    case 'provisioning_unavailable':
      return 'live number provisioning is off.';
    case 'converted':
      return 'this tour became a placement first.';
    default: {
      // A server that grows a reason we do not know about still gets a truthful
      // (if vague) sentence rather than a blank one.
      const exhaustive: never = reason;
      void exhaustive;
      return 'it could no longer be done.';
    }
  }
}

/** The generic fallback when a failure carries no renderable copy. */
export const GENERIC_WRITE_FAILURE = "Couldn't save that change - please try again.";

/**
 * The staff-facing sentence for a refusal. `ApiError.message` is the RAW
 * machine code (`errorFrom` builds it from `{ error }`), so it must never reach
 * an operator; the roster routes ship a renderable `message` on every refusal
 * that has one, and that is what we show. Anything else gets the generic retry
 * sentence, so a newer server can never put a snake_case token in front of
 * staff.
 */
export function refusalMessage(err: unknown): string {
  if (err instanceof ApiError && err.body !== null && typeof err.body === 'object') {
    const m = (err.body as Record<string, unknown>)['message'];
    if (typeof m === 'string' && m.trim().length > 0) return m;
  }
  return GENERIC_WRITE_FAILURE;
}

/**
 * The 409 `thread_exists` race, in words (spec section 7). Operator A edits the
 * plan while operator B's open lands: the edit is DROPPED, deliberately - never
 * auto-resubmitted through the live endpoint, because that would escalate a
 * no-send plan edit into a `member_added` text nobody confirmed. Say so, and
 * say what to do instead.
 */
export function threadExistsNote(scope: 'tour' | 'placement'): string {
  return `A relay group was just opened for this ${scope} - that change was not applied. Try it again to notify the group.`;
}
