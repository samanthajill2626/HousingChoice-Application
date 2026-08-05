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
  type RosterMemberInput,
  type RosterPreview,
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
  addLive: (contactId: string) => Promise<RosterView>;
  removeLive: (memberKey: string) => Promise<RosterView>;
  previewOpen: (signal?: AbortSignal) => Promise<RosterPreview>;
  previewAdd: (contactId: string) => Promise<RosterPreview>;
}

export function rosterApi(owner: RosterOwner): RosterApi {
  const { id } = owner;
  return owner.type === 'tour'
    ? {
        addPlan: (member) => addTourRosterMember(id, member),
        removePlan: (memberKey) => removeTourRosterMember(id, memberKey),
        reset: () => resetTourRoster(id),
        addLive: (contactId) => addTourRosterLiveMember(id, contactId),
        removeLive: (memberKey) => removeTourRosterLiveMember(id, memberKey),
        previewOpen: (signal) => previewTourRosterOpen(id, signal),
        previewAdd: (contactId) => previewTourRosterAdd(id, contactId),
      }
    : {
        addPlan: (member) => addPlacementRosterMember(id, member),
        removePlan: (memberKey) => removePlacementRosterMember(id, memberKey),
        reset: () => resetPlacementRoster(id),
        addLive: (contactId) => addPlacementRosterLiveMember(id, contactId),
        removeLive: (memberKey) => removePlacementRosterLiveMember(id, memberKey),
        previewOpen: (signal) => previewPlacementRosterOpen(id, signal),
        previewAdd: (contactId) => previewPlacementRosterAdd(id, contactId),
      };
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
  return `A group text was just opened for this ${scope} - that change was not applied. Try it again to notify the group.`;
}
