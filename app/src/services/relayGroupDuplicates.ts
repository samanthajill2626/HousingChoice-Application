// Duplicate relay-group detection (spec 2026-08-17-duplicate-relay-group-warning).
//
// ONE question: is there already a LIVE relay group whose members are EXACTLY the
// members of the group about to be opened? Used only to populate a preview warning -
// nothing here refuses anything, and a miss costs a confusing week rather than a
// misdelivered message (spec 2.1), which is why every failure mode here is silence.
//
// PII (doc section 9): a preview carries NAMES, never phones. DuplicateOpenGroup
// therefore holds display names only, and the log lines carry ids and counts.
import type {
  ConversationItem,
  ConversationParticipant,
  ConversationsRepo,
} from '../repos/conversationsRepo.js';
import type { Logger } from '../lib/logger.js';

/** The live group a proposed roster duplicates. Names only - never phones. */
export interface DuplicateOpenGroup {
  conversationId: string;
  /**
   * The PARTITION the match was found in, not the row's own `status` field. Those
   * can skew: touchLastActivity leaves a re-flagged closed group at status 'open'
   * with relay_status 'relay_group#closed' (spec 7).
   */
  partition: 'open' | 'connecting';
  /** Display names of the existing group's members, for the warning copy. */
  memberNames: string[];
}

/** The statuses a live group can be in. Closed groups are NOT duplicates. */
const LIVE_PARTITIONS = ['open', 'connecting'] as const;

/** Exact set equality (spec D1). Supersets and subsets are NOT matches. */
export function samePhoneSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const phone of a) if (!b.has(phone)) return false;
  return true;
}

/**
 * THE ONE definition of who is on a group's roster: the participants carrying a
 * non-empty phone. `ConversationParticipant.phone` is typed as required, but rows
 * are unvalidated casts off DynamoDB and legacy/imported rows really can carry a
 * blank one, so the guard is a runtime check rather than a type assumption.
 *
 * Both the phone set the MATCH is made on and the names the WARNING renders read
 * this, so neither can include a member the other left out. Split them and a
 * phoneless participant is excluded from the comparison but still named in the
 * copy - the warning then names somebody who was never part of the set that
 * matched.
 *
 * They are NOT one-to-one, and the difference is deliberate: `rosterPhones`
 * collapses to a Set, so two members sharing one handset contribute one phone but
 * two names. A two-phone match can therefore render three names. That is honest -
 * all three people really are on the thread - and naming fewer people than the
 * thread holds would be worse. Do not "fix" it by deduping the names.
 */
function rosterMembers(conv: ConversationItem): ConversationParticipant[] {
  return (conv.participants ?? []).filter(
    (member) => typeof member.phone === 'string' && member.phone.length > 0,
  );
}

/**
 * The phones of a group's CURRENT roster (spec D2a).
 *
 * Deliberately `participants`, never `ever_member_phones` - the latter sits directly
 * beside it on ConversationItem with OPPOSITE semantics (add-only burn provenance a
 * member remove never clears), so it answers "who was ever here" rather than "who is
 * on this thread". Comparing it would warn about groups whose live roster does not
 * match at all.
 */
function rosterPhones(conv: ConversationItem): Set<string> {
  return new Set(rosterMembers(conv).map((member) => member.phone));
}

/**
 * True for a row the IMPORTER wrote (spec D4). It writes type 'relay_group' with
 * relay_status 'relay_group#connecting' for unconverted carrier group texts, which
 * are not relay groups we provisioned - warning "a relay group already exists" about
 * one would be false in every clause. Checked ONLY against the connecting
 * partition, for the reason given at the call site.
 *
 * `imported_from` is NOT a declared field on ConversationItem; it rides the
 * `[key: string]: unknown` index signature, so this is a keyed read, not a property
 * access.
 */
function isImported(conv: ConversationItem): boolean {
  return typeof conv['imported_from'] === 'string';
}

/** Newest-activity-first, for picking among several matches in one partition. */
function byNewestActivity(a: ConversationItem, b: ConversationItem): number {
  const at = typeof a.last_activity_at === 'string' ? a.last_activity_at : '';
  const bt = typeof b.last_activity_at === 'string' ? b.last_activity_at : '';
  if (at === bt) return 0;
  return at < bt ? 1 : -1;
}

function toDuplicate(
  conv: ConversationItem,
  partition: 'open' | 'connecting',
): DuplicateOpenGroup {
  return {
    conversationId: conv.conversationId,
    partition,
    // Named from `rosterMembers`, the SAME walk the match was made on - never from
    // the raw participants array (see that function). A nameless participant renders
    // as 'Unknown'. NEVER fall back to the phone - doc section 9 forbids it on the
    // wire.
    memberNames: rosterMembers(conv).map((m) =>
      typeof m.name === 'string' && m.name.length > 0 ? m.name : 'Unknown',
    ),
  };
}

/**
 * Find a LIVE relay group whose roster phones equal `phones` exactly.
 *
 * A MATCH ALWAYS WINS (spec D6). A group found before a walk truncated or threw is
 * still returned - a duplicate we actually saw is not made less true by failing to
 * finish looking. `undefined` means "no match was found"; when the search was ALSO
 * incomplete that is logged as a WARN rather than changing the answer.
 *
 * NEVER THROWS. The preview routes that call this deliberately do not catch, so an
 * escaping error would take down the whole confirm dialog. That posture is correct
 * for member SUPPRESSION, which changes who receives a message; a missing duplicate
 * warning changes nobody's delivery, so this swallows its own errors instead.
 *
 * TIE-BREAK: prefer an OPEN match over a CONNECTING one, and only then take the
 * newest. Ranking purely by activity hands the warning to a just-created connecting
 * shell - stamp of now, never texted - over a real open thread that happens to be
 * quiet.
 */
export async function findOpenGroupWithSamePhones(
  deps: { conversations: Pick<ConversationsRepo, 'listRelayGroups'>; log: Logger },
  phones: Set<string>,
): Promise<DuplicateOpenGroup | undefined> {
  if (phones.size === 0) return undefined;
  let incomplete = false;

  for (const partition of LIVE_PARTITIONS) {
    let items: ConversationItem[] = [];
    try {
      const page = await deps.conversations.listRelayGroups(partition);
      items = page.items;
      if (page.truncated) incomplete = true;
    } catch (err) {
      // Silence, not a broken dialog. See the NEVER THROWS note above.
      //
      // Says ONLY what is true HERE: this partition could not be read, so nothing in
      // it is represented in the answer. It does NOT claim the preview went unwarned
      // - the other partition is still walked and may well match, in which case a
      // warning IS shown. The "found nothing" claim belongs to the summary WARN
      // below, which is reached only when no partition matched.
      deps.log.warn(
        { err, partition },
        'duplicate relay-group scan could not read this partition - it is not represented in the answer',
      );
      incomplete = true;
      continue;
    }

    const matches = items
      // The imported skip applies ONLY to the connecting partition, where the
      // importer parks unconverted carrier group texts. `imported_from` is never
      // cleared (nothing in app/src removes it, and the group-text conversion
      // drops relay_status but keeps it), so filtering it in the OPEN partition
      // would permanently silence any import-origin group that later went live.
      .filter((conv) => partition !== 'connecting' || !isImported(conv))
      .filter((conv) => samePhoneSet(rosterPhones(conv), phones));

    if (matches.length > 0) {
      const winner = [...matches].sort(byNewestActivity)[0]!;
      if (matches.length > 1) {
        deps.log.warn(
          { partition, matchCount: matches.length, conversationId: winner.conversationId },
          'several live relay groups share this exact roster - warning names the newest',
        );
      }
      return toDuplicate(winner, partition);
    }
  }

  if (incomplete) {
    deps.log.warn(
      { event: 'relay_duplicate_scan_incomplete' },
      'duplicate relay-group scan was incomplete and found nothing - no warning shown',
    );
  }
  return undefined;
}
