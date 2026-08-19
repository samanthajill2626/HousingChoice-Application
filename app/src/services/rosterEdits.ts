// Owner-scoped roster EDITING - the engine behind the tour and placement
// roster endpoints (contact-rosters Task 10). One implementation, two owners:
// routes/tours.ts and routes/placements.ts differ only in which repo backs the
// plan and which 404 token they answer with.
//
// Two jobs live here:
//
//   1. PLAN WRITES (no thread yet). Per-member edits, never a whole-array
//      PATCH. The exact sequence (spec section 7) is MATERIALIZE-THEN-APPLY:
//        a. no override yet -> write the RESOLVED DEFAULT with
//           `attribute_not_exists(roster)`;
//        b. that condition failing means a concurrent operator materialized
//           first - re-read and continue onto THEIR override, never overwrite;
//        c. apply the single member change under the `rosterVersion` guard,
//           bounded retries, then 409 roster_conflict.
//      Both edits are therefore additive under concurrency: two operators
//      making their first edit at once end with BOTH members on the roster.
//
//   2. PREVIEWS. The confirm dialogs (spec 6.3 / 6.4) render the body the
//      group will ACTUALLY receive, so it is composed here with the SAME
//      composers the fan-out uses (jobs/relayFanOut composeIntroBody /
//      composeMemberAddedBody) - never resolveMessage directly, or a template
//      edit would drift preview from send. INPUT IS THE OWNER ONLY: the roster
//      is resolved server-side, so a client list can never disagree with what
//      provision resolves.
//
// The resolver's 'unavailable' state (pointer set, thread unreadable) NEVER
// falls through to the plan or the default here either - it refuses.
//
// PII (doc section 9), as amended by the founder ruling 2026-08-19: the line is
// OUTBOUND vs STAFF-ONLY, not preview vs not-preview. The intro/member-added BODY
// (composed from `bodyMembers`) carries names and NEVER a phone - that is what a
// tenant or landlord receives and it is unchanged. The confirm dialog's RECIPIENT
// ROWS are staff-only chrome: a member with no saved name renders as
// "Unnamed number ...1234" from `phoneLast4`, so a navigator can tell two nameless
// members apart. The FULL number still never leaves the server on either shape.
// The two lists are built separately here; keep them that way.
import { composeIntroBody, composeMemberAddedBody } from '../jobs/relayFanOut.js';
import {
  clampOutOfQuietHours,
  isQuietTime,
  type QuietHoursWindow,
} from '../lib/quietHours.js';
import { normalizeToE164 } from '../lib/phone.js';
import {
  describeRoster,
  RosterPlanConflictError,
  resolveRoster,
  type ResolvedMember,
  type RosterEntry,
  type RosterOwner,
  type RosterReachability,
  type RosterResolutionDeps,
} from '../lib/rosterResolution.js';
import { isDeleted, type ContactsRepo } from '../repos/contactsRepo.js';
import type {
  ConversationParticipant,
  ConversationsRepo,
} from '../repos/conversationsRepo.js';
import { isMemberSuppressed } from './relayAnnouncements.js';
import type { DuplicateOpenGroup } from './relayGroupDuplicates.js';
import { LAST_MEMBER_REFUSAL, nameFromContact, resolveMemberName } from './relayMembers.js';

/** A refusal the route renders verbatim. */
export interface RosterEditRefusal {
  status: number;
  error: string;
  message?: string;
}

export type RosterEditOutcome = { ok: true } | { ok: false; refusal: RosterEditRefusal };

// --- The refusals both owners share (the dashboard branches on `error`) -----

/** A thread exists: the roster is a FACT, edited through the live endpoints. */
export const ROSTER_THREAD_EXISTS: RosterEditRefusal = {
  status: 409,
  error: 'thread_exists',
  message: 'This relay group is already open. Edit its members from the live group.',
};

/** No thread yet: the roster is a PLAN, edited through the plan endpoints. */
export const ROSTER_NO_THREAD: RosterEditRefusal = {
  status: 409,
  error: 'no_thread',
  message: 'This roster has no relay group yet, so there is nothing to change live.',
};

/**
 * The pointer is set but the thread could not be read. NEVER a fallback to the
 * plan or the property default - the cardinal rule (lib/rosterResolution).
 */
export const ROSTER_UNAVAILABLE: RosterEditRefusal = {
  status: 409,
  error: 'roster_unavailable',
  message: 'This roster could not be read just now. Refresh and try again.',
};

/**
 * Apply-now hit the applier's 'waiting' outcome: the world could not be read,
 * so NOTHING was claimed and nothing happened - the row is still pending and
 * the poller still owns it. An honest refusal, never a 200 with an unchanged
 * payload that reads as "your click landed".
 */
export const ROSTER_ACTION_NOT_READY: RosterEditRefusal = {
  status: 409,
  error: 'action_not_ready',
  message:
    'We could not read this roster just now, so nothing changed. It will retry on its own - or try again in a moment.',
};

/** The owner's stored plan state - the attributes the write path guards on. */
export interface RosterPlanState {
  roster?: RosterEntry[];
  rosterVersion?: number;
  /**
   * The owner's thread pointer (tours: `groupThreadId`; placements:
   * `group_thread`), present ONLY so a lost MATERIALIZE can be told apart from
   * a lost race with another editor - the plan writes themselves never read it.
   */
  groupThreadId?: string;
}

/** The owner's repo, narrowed to the three plan operations. */
export interface RosterPlanStore {
  /** Re-read after a lost race. `undefined` = the owner is gone. */
  reload(): Promise<RosterPlanState | undefined>;
  setRoster(roster: RosterEntry[], expectedVersion: number | undefined): Promise<RosterPlanState>;
  clearRoster(): Promise<void>;
}

export type RosterPlanEdit =
  | { kind: 'add'; entry: RosterEntry }
  | { kind: 'remove'; memberKey: string };

export interface RosterPlanEditRequest {
  /** The owner WITHOUT its plan override or thread pointer (both supplied here). */
  owner: Omit<RosterOwner, 'roster' | 'groupThreadId'>;
  /** The state the route just read - saves one round trip on the common path. */
  state: RosterPlanState;
  edit: RosterPlanEdit;
  /** The route's own 404 token, for an owner that vanishes mid-write. */
  notFoundError: string;
}

/**
 * Bounded retries. Each miss costs one re-read + one conditional write, and
 * every loser of a race re-reads the WINNER's roster, so four attempts covers
 * far more concurrent editors than a roster ever has.
 */
const MAX_PLAN_WRITE_ATTEMPTS = 4;

/**
 * The key a client sends back for one roster entry: the contactId when there
 * is one, else `phone:<E164>`. IDENTICAL to describeRoster's `memberKey`, and
 * deliberately NOT relayMemberKey's `phone#<E164>` (an internal delivery key).
 */
export function rosterEntryKey(entry: RosterEntry): string {
  const contactId =
    typeof entry.contactId === 'string' && entry.contactId.length > 0 ? entry.contactId : undefined;
  if (contactId !== undefined) return contactId;
  const phone = typeof entry.phone === 'string' && entry.phone.length > 0 ? entry.phone : undefined;
  return `phone:${phone === undefined ? '' : (normalizeToE164(phone) ?? phone)}`;
}

/** The same key over a RESOLVED member (describeRoster's rule, verbatim). */
function resolvedMemberKey(member: ResolvedMember): string {
  const contactId =
    typeof member.contactId === 'string' && member.contactId.length > 0
      ? member.contactId
      : undefined;
  return contactId ?? `phone:${member.phone ?? ''}`;
}

/**
 * Validate ONE roster entry from a request body: EXACTLY ONE of contactId /
 * phone (spec section 7 - a member is a person or a number, never both, so the
 * stored entry has one identity and one key).
 */
export function parseRosterEntryInput(raw: unknown): RosterEntry | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'body must be a JSON object' };
  }
  const b = raw as { contactId?: unknown; phone?: unknown };
  const contactId = typeof b.contactId === 'string' && b.contactId.length > 0 ? b.contactId : undefined;
  const rawPhone = typeof b.phone === 'string' && b.phone.length > 0 ? b.phone : undefined;
  if ((contactId === undefined) === (rawPhone === undefined)) {
    return { error: 'exactly one of contactId or phone is required' };
  }
  if (contactId !== undefined) return { contactId };
  const phone = normalizeToE164(rawPhone as string);
  if (phone === undefined) return { error: `phone is not a valid phone number: ${rawPhone}` };
  return { phone };
}

/** The plan entries that hold a resolved roster (one entry per member). */
function entriesOf(members: ResolvedMember[]): RosterEntry[] {
  const entries: RosterEntry[] = [];
  for (const member of members) {
    const contactId =
      typeof member.contactId === 'string' && member.contactId.length > 0
        ? member.contactId
        : undefined;
    if (contactId !== undefined) {
      entries.push({ contactId });
      continue;
    }
    const phone = typeof member.phone === 'string' && member.phone.length > 0 ? member.phone : undefined;
    // A member with neither identity cannot be addressed OR removed; dropping
    // it is the only thing a materialized plan can honestly say about it.
    if (phone !== undefined) entries.push({ phone });
  }
  return entries;
}

type EditApplication =
  | { entries: RosterEntry[] }
  | { unchanged: true }
  | { refusal: RosterEditRefusal };

/** Apply ONE member change to a plan array (pure). */
function applyEdit(entries: RosterEntry[], edit: RosterPlanEdit): EditApplication {
  if (edit.kind === 'add') {
    const key = rosterEntryKey(edit.entry);
    // Idempotent: the card can fire the same add twice (double-click, retry)
    // and the second one must not duplicate the row or bump the version.
    if (entries.some((e) => rosterEntryKey(e) === key)) return { unchanged: true };
    return { entries: [...entries, edit.entry] };
  }
  const index = entries.findIndex((e) => rosterEntryKey(e) === edit.memberKey);
  if (index < 0) {
    return { refusal: { status: 404, error: 'member_not_found' } };
  }
  // D6 lets ANYONE be removed - but never the last one: an empty roster can
  // open no group and would silently re-resolve to nobody.
  if (entries.length <= 1) {
    return { refusal: LAST_MEMBER_REFUSAL };
  }
  return { entries: entries.filter((_, i) => i !== index) };
}

/**
 * MATERIALIZE-THEN-APPLY one member change onto the owner's plan override.
 * Callers must have already refused a thread-bearing owner (409 thread_exists)
 * - the plan is only the roster while no thread exists (D1).
 */
export async function applyRosterPlanEdit(
  deps: RosterResolutionDeps,
  store: RosterPlanStore,
  req: RosterPlanEditRequest,
): Promise<RosterEditOutcome> {
  let state = req.state;
  for (let attempt = 0; attempt < MAX_PLAN_WRITE_ATTEMPTS; attempt += 1) {
    // (a) MATERIALIZE - hold the currently resolved roster under
    // attribute_not_exists(roster). A concurrent reset can also land us here on
    // a later attempt, which is why this is inside the loop.
    if (state.roster === undefined) {
      const resolved = await resolveRoster(deps, { ...req.owner });
      if (resolved.source === 'unavailable') {
        // Unreachable while no pointer exists; refused rather than resolved so
        // the cardinal rule holds on every path (never plan/default here).
        return {
          ok: false,
          refusal: { status: 409, error: 'roster_unavailable' },
        };
      }
      try {
        state = await store.setRoster(entriesOf(resolved.members), undefined);
      } catch (err) {
        if (!(err instanceof RosterPlanConflictError)) throw err;
        // (b) The materialize lost - and its condition now has TWO ways to
        // fail, so re-read the owner to tell them apart:
        //   - a THREAD landed (the pointer guard): the plan is no longer the
        //     roster (D1), and materializing here would write an INERT plan
        //     while answering "saved". Refuse with the SAME 409 the route
        //     itself answers for a thread-bearing owner.
        //   - someone materialized first: continue onto THEIR override.
        const fresh = await store.reload();
        if (fresh === undefined) {
          return { ok: false, refusal: { status: 404, error: req.notFoundError } };
        }
        if (typeof fresh.groupThreadId === 'string' && fresh.groupThreadId.length > 0) {
          return { ok: false, refusal: ROSTER_THREAD_EXISTS };
        }
        state = fresh;
        continue;
      }
    }
    // (c) APPLY under the optimistic-concurrency guard.
    const application = applyEdit(state.roster ?? [], req.edit);
    if ('refusal' in application) return { ok: false, refusal: application.refusal };
    if ('unchanged' in application) return { ok: true };
    try {
      state = await store.setRoster(application.entries, state.rosterVersion ?? 0);
      return { ok: true };
    } catch (err) {
      if (!(err instanceof RosterPlanConflictError)) throw err;
      const fresh = await store.reload();
      if (fresh === undefined) {
        return { ok: false, refusal: { status: 404, error: req.notFoundError } };
      }
      state = fresh;
    }
  }
  return {
    ok: false,
    refusal: {
      status: 409,
      error: 'roster_conflict',
      message: 'Someone else changed this roster. Refresh and try again.',
    },
  };
}

// ---------------------------------------------------------------------------
// Previews (spec 6.3 / 6.4)
// ---------------------------------------------------------------------------

export interface RosterPreviewRecipient {
  name?: string;
  reachability: RosterReachability;
}

export interface RosterPreview {
  /** The body the group will actually receive, composed server-side. */
  body: string;
  /** Everyone the send touches, receiving or not, with the reason. */
  recipients: RosterPreviewRecipient[];
  /** DISTINCT reachable numbers - what "3 recipients" honestly means. */
  recipientCount: number;
  /** Quiet hours hold right now (slice 6 turns this into a deferral). */
  deferred: boolean;
  /** The clamped quiet-END instant; absent when not deferred. */
  quietEndsAt?: string;
  /**
   * A LIVE relay group with EXACTLY these members already exists (spec D1). Absent
   * when there is none AND when detection could not tell - the dialog cannot
   * distinguish those, by design: both mean "say nothing".
   */
  duplicateOf?: DuplicateOpenGroup;
}

export type RosterPreviewOutcome =
  | { ok: true; preview: RosterPreview }
  | { ok: false; refusal: RosterEditRefusal };

/** The clock + window a preview evaluates quiet hours against. */
export interface QuietHoursState {
  nowIso: string;
  window: QuietHoursWindow;
}

function withQuietHours(
  body: string,
  recipients: RosterPreviewRecipient[],
  recipientCount: number,
  quiet: QuietHoursState,
): RosterPreview {
  const deferred = isQuietTime(quiet.nowIso, quiet.window);
  return {
    body,
    recipients,
    recipientCount,
    deferred,
    // The server owns the DST-safe window math (lib/quietHours); the client
    // never re-derives this instant.
    ...(deferred && { quietEndsAt: clampOutOfQuietHours(quiet.nowIso, quiet.window) }),
  };
}

/**
 * ONE recipient row's STAFF-FACING label: their name, else `Unnamed number ...1234`.
 *
 * Founder ruling 2026-08-19. The confirm dialog is dashboard-only, behind
 * requireAuth, and nothing a tenant or landlord receives is built from
 * `recipients` - the outbound body is composed from `bodyMembers` (see
 * buildOpenPreviewFromParts), a separate list that keeps the names-only rule. A bare
 * 'Unnamed number' gave a navigator nothing to tell two nameless members apart with.
 *
 * LAST FOUR, NOT THE FULL NUMBER - the founder's call, and it is also the only form
 * that works the same on every path. `phoneLast4` is what `RosterMemberView` already
 * exposes (rosterResolution), so BOTH a bare-phone member and a contact-keyed member
 * with no saved name render identically. Reaching for the full E.164 would have meant
 * widening that wire type for the contact-keyed case, which is a decision nobody has
 * made, and would have produced two different renderings of the same situation.
 *
 * Returns undefined only for a member carrying neither a name nor any phone at all;
 * the dialog still renders its own 'Unnamed number' fallback for that.
 */
/** Last 4 digits of an E.164, or undefined when there is no usable number. The
 *  owner path gets this from RosterMemberView; the standalone and add paths hold
 *  the full number and derive it here so all three render identically. */
function lastFour(phone: string | undefined): string | undefined {
  const digits = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

function recipientLabel(member: { name?: string; phoneLast4?: string }): string | undefined {
  const name = typeof member.name === 'string' ? member.name.trim() : '';
  if (name.length > 0) return member.name;

  const last4 = typeof member.phoneLast4 === 'string' ? member.phoneLast4.trim() : '';
  return last4.length > 0 ? `Unnamed number ...${last4}` : undefined;
}

function toRecipient(member: {
  name?: string;
  phoneLast4?: string;
  reachability: RosterReachability;
}): RosterPreviewRecipient {
  const label = recipientLabel(member);
  return {
    ...(label !== undefined && { name: label }),
    reachability: member.reachability,
  };
}

/** One member as the INTRO BODY composer sees them: phone-bearing and
 *  phone-de-duplicated, carrying the name the send path will actually use. */
export interface PreviewBodyMember {
  name?: string;
  memberKey: string;
}

/** One row the confirm dialog lists, with the DISPLAY name (which may be
 *  backfilled from the contact and so differ from the body name). */
export interface PreviewRecipientRow {
  name?: string;
  memberKey: string;
  /** Last 4 of the number this member is texted on - the staff-facing fallback
   *  label when they have no saved name (recipientLabel). Display only; the full
   *  number never rides this shape. */
  phoneLast4?: string;
  reachability: RosterReachability;
}

/**
 * The two lists a caller resolves; see spec 6.1. They are separate because the
 * owner path composes the body from `resolveRoster` (stored names) and the
 * recipient list from `describeRoster` (backfilled names) - one field cannot
 * carry both.
 */
export interface OpenPreviewParts {
  bodyMembers: PreviewBodyMember[];
  recipients: PreviewRecipientRow[];
  /** Set by the two OPEN builders; the ADD preview never sets it (spec 5). */
  duplicateOf?: DuplicateOpenGroup;
}

/**
 * THE ONE implementation of "what an open sends". The tour, placement, and
 * standalone preview routes all funnel through here so the body composition,
 * the recipient shape, the count rule, and the quiet-hours math cannot drift.
 *
 * COUNT RULE, preserved verbatim from the pre-refactor code: de-dupe by phone
 * FIRST (the caller does that when building `bodyMembers`), THEN keep the ones
 * whose key is reachable. A phone does not become reachable because a LATER
 * member on the same number is.
 *
 * `memberKey` is an INPUT-ONLY join key. `toRecipient` copies name and
 * reachability only, which is what keeps a bare-phone member's key - the full
 * E.164 - off the wire (doc section 9: previews carry names, never phones).
 */
export function buildOpenPreviewFromParts(
  parts: OpenPreviewParts,
  quiet: QuietHoursState,
): RosterPreview {
  const reachableKeys = new Set(
    parts.recipients.filter((r) => r.reachability === 'reachable').map((r) => r.memberKey),
  );
  const recipientCount = parts.bodyMembers.filter((m) => reachableKeys.has(m.memberKey)).length;
  const preview = withQuietHours(
    composeIntroBody(parts.bodyMembers.map((m) => m.name)),
    parts.recipients.map(toRecipient),
    recipientCount,
    quiet,
  );
  return parts.duplicateOf === undefined
    ? preview
    : { ...preview, duplicateOf: parts.duplicateOf };
}

/**
 * Resolve the duplicate warning for a proposed roster (spec 5). Injected rather
 * than imported so neither builder needs a ConversationsRepo with listRelayGroups
 * nor a Logger - the preview ROUTES hold both and construct this. Omitted, the
 * preview simply carries no warning, which is the correct degradation for a
 * feature that never refuses.
 *
 * The phones are passed IN because the deduped set does not exist until the
 * builder has resolved the roster: a caller has nothing to compute it from.
 */
export type FindDuplicateFn = (
  phones: Set<string>,
) => Promise<DuplicateOpenGroup | undefined>;

/**
 * Preview OPENING the group: the relay.intro body, per-member deliverability,
 * and the true recipient count.
 *
 * The body names the members PROVISION will actually put on the thread (a
 * phone-bearing, phone-de-duplicated set - the same filter routes/tours.ts and
 * routes/placements.ts apply), because the intro job composes from the
 * conversation's participants. Opted-out members ARE named: they are
 * participants whose leg is suppressed at send, which is exactly why they are
 * listed as recipients and excluded from the count.
 */
export async function buildOpenPreview(
  deps: RosterResolutionDeps,
  owner: RosterOwner,
  quiet: QuietHoursState,
  findDuplicate?: FindDuplicateFn,
): Promise<RosterPreviewOutcome> {
  const view = await describeRoster(deps, owner);
  if (view.source === 'unavailable') return { ok: false, refusal: ROSTER_UNAVAILABLE };
  const resolved = await resolveRoster(deps, owner);
  if (resolved.source === 'unavailable') return { ok: false, refusal: ROSTER_UNAVAILABLE };

  const provisioned: ResolvedMember[] = [];
  const seenPhones = new Set<string>();
  for (const member of resolved.members) {
    const phone = member.phone;
    if (typeof phone !== 'string' || phone.length === 0) continue; // unreachable member
    if (seenPhones.has(phone)) continue; // one slot per number (shared phones)
    seenPhones.add(phone);
    provisioned.push(member);
  }

  // Do NOT wrap this in try/catch. Error swallowing belongs to the detector, which
  // is the only layer that knows a failed lookup means silence rather than a broken
  // preview; a second catch here would also hide a genuine bug in a test stub.
  //
  // `seenPhones` IS the deduped, phone-bearing set (spec D2): a member reaches
  // `provisioned` only after its phone was added here, on the same guarded local.
  const duplicateOf =
    findDuplicate === undefined ? undefined : await findDuplicate(new Set(seenPhones));

  return {
    ok: true,
    preview: buildOpenPreviewFromParts(
      {
        bodyMembers: provisioned.map((m) => ({
          ...(m.name !== undefined && { name: m.name }),
          memberKey: resolvedMemberKey(m),
        })),
        recipients: view.members.map((m) => ({
          ...(m.name !== undefined && { name: m.name }),
          memberKey: m.memberKey,
          // Feeds recipientLabel's "Unnamed number ...1234" for a member with no
          // saved name. RosterMemberView already exposes it; nothing widened.
          ...(m.phoneLast4 !== undefined && { phoneLast4: m.phoneLast4 }),
          reachability: m.reachability,
        })),
        ...(duplicateOf !== undefined && { duplicateOf }),
      },
      quiet,
    ),
  };
}

/**
 * Preview a STANDALONE relay-group open from an explicit member list.
 *
 * INPUT IS THE CLIENT'S LIST, deliberately - and this does NOT break the
 * "input is the owner only" rule the owner-scoped previews follow (see this
 * file's header). That rule exists so a client list can never disagree with a
 * SERVER-RESOLVED roster; a standalone group has no stored roster before it
 * exists, so there is nothing to disagree with. The caller MUST post the
 * identical array to this preview and to POST /api/relay-groups.
 *
 * REACHABILITY ASYMMETRY, intentional: this uses `isMemberSuppressed`, the real
 * send-time gate (contact flag + per-phone STOP record), while the owner path
 * keeps `describeRoster`'s narrower rule. The owner path is not changed here,
 * and that divergence is already filed
 * (docs/issues/relay-member-suppression-diverges-from-number-seam.md). Matching
 * the SEND is the entire point of a preview.
 *
 * Names come from `resolveMemberName` - the SAME resolver the create route
 * uses, short-circuit included - so a client-supplied name renders identically
 * in the dialog and in the intro that actually goes out. Suppression is a
 * DIFFERENT question with different resolution rules, so it gets its own read;
 * do not try to serve both from one.
 *
 * There is no `no_phone` case: `parseRelayMember` guarantees a phone or 400s.
 */
export async function buildStandaloneOpenPreview(
  deps: {
    contacts: ContactsRepo;
    conversations: ConversationsRepo;
  },
  members: ConversationParticipant[],
  quiet: QuietHoursState,
  findDuplicate?: FindDuplicateFn,
): Promise<RosterPreview> {
  // De-dupe by phone, FIRST WINS - exactly what POST /api/relay-groups does, so
  // the dialog lists only people who will really be on the thread.
  const deduped: ConversationParticipant[] = [];
  const seenPhones = new Set<string>();
  for (const m of members) {
    if (seenPhones.has(m.phone)) continue;
    seenPhones.add(m.phone);
    deduped.push(m);
  }

  // See buildOpenPreview: no try/catch here, the detector owns its own failures.
  const duplicateOf =
    findDuplicate === undefined
      ? undefined
      : await findDuplicate(new Set(deduped.map((m) => m.phone)));

  const rows: PreviewRecipientRow[] = [];
  const bodyMembers: PreviewBodyMember[] = [];
  for (const member of deduped) {
    const named = await resolveMemberName(deps.contacts, member);
    const suppressed = await isMemberSuppressed(deps.contacts, deps.conversations, member);
    const memberKey =
      member.contactId && member.contactId.length > 0 ? member.contactId : `phone:${member.phone}`;
    rows.push({
      ...(named.name !== undefined && { name: named.name }),
      memberKey,
      ...(lastFour(member.phone) !== undefined && { phoneLast4: lastFour(member.phone) }),
      reachability: suppressed ? 'opted_out' : 'reachable',
    });
    bodyMembers.push({
      ...(named.name !== undefined && { name: named.name }),
      memberKey,
    });
  }

  return buildOpenPreviewFromParts(
    {
      bodyMembers,
      recipients: rows,
      ...(duplicateOf !== undefined && { duplicateOf }),
    },
    quiet,
  );
}

/** The person an add-preview / live add is about, already resolved + validated. */
export interface RosterCandidate {
  contactId: string;
  phone: string;
  name?: string;
  optedOut: boolean;
}

/**
 * Preview ADDING a member to a live group: the relay.member_added body the
 * WHOLE group receives, per-member deliverability including the candidate, and
 * the recipient count.
 *
 * Parity with the job (jobs/relayFanOut RELAY_MEMBER_ADDED_JOB): it composes
 * from the roster AFTER the add, so the candidate is appended to the member
 * names here - unless they are already a participant, in which case the add is
 * idempotent and the roster is unchanged.
 */
export async function buildAddPreview(
  deps: RosterResolutionDeps,
  owner: RosterOwner,
  candidate: RosterCandidate,
  quiet: QuietHoursState,
): Promise<RosterPreviewOutcome> {
  const view = await describeRoster(deps, owner);
  if (view.source === 'unavailable') return { ok: false, refusal: ROSTER_UNAVAILABLE };
  const resolved = await resolveRoster(deps, owner);
  if (resolved.source === 'unavailable') return { ok: false, refusal: ROSTER_UNAVAILABLE };

  const alreadyMember = resolved.members.some(
    (m) => m.contactId === candidate.contactId || m.phone === candidate.phone,
  );
  const memberNames = resolved.members.map((m) => m.name);
  const body = composeMemberAddedBody(
    candidate.name,
    alreadyMember ? memberNames : [...memberNames, candidate.name],
  );

  const reachableKeys = new Set(
    view.members.filter((m) => m.reachability === 'reachable').map((m) => m.memberKey),
  );
  const reachablePhones = new Set<string>();
  for (const member of resolved.members) {
    if (typeof member.phone !== 'string' || member.phone.length === 0) continue;
    if (reachableKeys.has(resolvedMemberKey(member))) reachablePhones.add(member.phone);
  }
  if (!candidate.optedOut) reachablePhones.add(candidate.phone);

  const recipients = view.members.map(toRecipient);
  if (!alreadyMember) {
    recipients.push(
      toRecipient({
        ...(candidate.name !== undefined && { name: candidate.name }),
        ...(lastFour(candidate.phone) !== undefined && { phoneLast4: lastFour(candidate.phone) }),
        reachability: candidate.optedOut ? 'opted_out' : 'reachable',
      }),
    );
  }
  return {
    ok: true,
    preview: withQuietHours(body, recipients, reachablePhones.size, quiet),
  };
}

/**
 * Resolve the `{ contactId }` body the live-add and add-preview endpoints
 * take. A relay member needs a NUMBER, so a phone-less (or gone) contact is
 * refused here rather than being added to a group that can never reach them.
 */
export async function resolveRosterCandidate(
  contacts: Pick<ContactsRepo, 'getById'>,
  raw: unknown,
): Promise<{ ok: true; candidate: RosterCandidate } | { ok: false; refusal: RosterEditRefusal }> {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as { contactId?: unknown };
  const contactId = typeof body.contactId === 'string' && body.contactId.length > 0 ? body.contactId : undefined;
  if (contactId === undefined) {
    return {
      ok: false,
      refusal: { status: 400, error: 'invalid_member', message: 'contactId is required' },
    };
  }
  const contact = await contacts.getById(contactId);
  if (!contact || isDeleted(contact)) {
    return { ok: false, refusal: { status: 404, error: 'contact_not_found' } };
  }
  const storedPhone =
    typeof contact.phone === 'string' && contact.phone.length > 0 ? contact.phone : undefined;
  const phone = storedPhone === undefined ? undefined : normalizeToE164(storedPhone);
  if (phone === undefined) {
    return {
      ok: false,
      refusal: {
        status: 400,
        error: 'contact_unreachable',
        message: 'This contact has no phone number, so they cannot join a relay group.',
      },
    };
  }
  const name = nameFromContact(contact);
  return {
    ok: true,
    candidate: {
      contactId,
      phone,
      ...(name !== undefined && { name }),
      optedOut: contact.sms_opt_out === true,
    },
  };
}
