// Group text numbers - the admin-only, READ-ONLY pool-number inventory
// (spec docs/superpowers/specs/2026-07-18-pool-numbers-admin-design.md sec 3).
//
//   GET /api/pool-numbers -> { numbers: PoolNumberRow[] }
//
// Assembly (no mutations anywhere - Query/Get only): listByState for each of
// active/releasing/released, then per record the number's full group history via
// the byPoolNumber GSI (conversations.getAllByPoolNumber). The retire block
// MIRRORS services/poolNumbers.ts retireEligible so the page never disagrees with
// the CLI sweep (npm run pool:retire).
//
// PII (doc section 9): a phone number is PII in LOGS - this router logs counts +
// states only, NEVER a poolNumber or a participant phone/name. burned_phones
// CONTENTS never leave the API either (the response carries the count only); the
// numbers/names that DO appear in the response body are display data for an
// authenticated admin (same class as the existing roster surfaces).
import { Router } from 'express';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { requireRole } from '../middleware/auth.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import {
  createPoolNumbersRepo,
  RELEASE_GRACE_MS,
  type PoolNumberItem,
  type PoolNumberLifecycleState,
  type PoolNumbersRepo,
} from '../repos/poolNumbersRepo.js';

/** One relay group hosted by a pool number (wire row; T3 copies this verbatim). */
export interface PoolNumberGroupRow {
  conversationId: string;
  label: string;
  memberCount: number;
  status: 'open' | 'closed';
  createdAt?: string;
  closedAt?: string;
  lastActivityAt?: string;
}

/** One pool number + its group history (wire row; T3 copies this verbatim). */
export interface PoolNumberRow {
  number: string;
  state: 'active' | 'releasing' | 'released';
  openGroups: number;
  totalGroups: number;
  burnedCount: number;
  lastActivityAt?: string;
  lastGroupClosedAt?: string;
  releasedAt?: string;
  retire: { eligible: boolean; daysRemaining?: number };
  groups: PoolNumberGroupRow[];
}

export interface PoolNumbersAdminRouterDeps {
  logger?: Logger;
  poolNumbersRepo?: PoolNumbersRepo;
  conversationsRepo?: ConversationsRepo;
  /** Injectable clock for the retire-mirror grace cutoff (tests); default wall clock. */
  now?: () => Date;
}

/** Milliseconds in one day - the daysRemaining divisor (a day length, not a grace literal). */
const ONE_DAY_MS = 86_400_000;

/**
 * Lifecycle progression rank for the W1 de-dupe (higher = further along):
 * released > releasing > active. A pool number lives in exactly ONE lifecycle
 * partition, so the only way the three listByState Queries can return it under
 * two states at once is a state transition (active -> releasing -> released)
 * racing the reads: the byLifecycleState GSI is eventually consistent, so it can
 * still project the row under its OLD partition while the NEW one already sees
 * it. We keep the FURTHEST-ALONG copy because a mid-transition duplicate always
 * reflects a FORWARD transition, so the furthest state is the honest render.
 */
const LIFECYCLE_RANK: Record<PoolNumberLifecycleState, number> = {
  active: 0,
  releasing: 1,
  released: 2,
};

/**
 * Server-side group label, precedence (spec sec 3; adjudication A6): (1) ALL
 * participants that carry a non-empty name, joined with ' & ' under a 'With '
 * prefix (admin view - no "self" to exclude); (2) the placement_tag, read
 * DEFENSIVELY via the index signature (it is written by createRelayGroup but not
 * declared on ConversationItem - mirrors inbox.ts / contacts.ts); (3) the literal
 * 'Group text'. No pool-number rung - the number is the parent row's own column.
 */
function serverLabel(conv: ConversationItem): string {
  const names = (conv.participants ?? [])
    .map((p) => p.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  if (names.length > 0) return `With ${names.join(' & ')}`;
  const tag = conv['placement_tag'];
  if (typeof tag === 'string' && tag.length > 0) return tag;
  return 'Group text';
}

/**
 * A group's close instant (adjudication A5): close_announced_at is honestly
 * stamped by the atomic close claim and cleared on reopen - so emit it as closedAt
 * ONLY when the group is CLOSED and the marker is present. Never for an open group
 * (the crash-window marker can be set while still open), never synthesized, never
 * the pool record's per-number last_group_closed_at.
 */
function closedAtOf(conv: ConversationItem): string | undefined {
  if (conv.status === 'closed' && typeof conv.close_announced_at === 'string') {
    return conv.close_announced_at;
  }
  return undefined;
}

function toGroupRow(conv: ConversationItem): PoolNumberGroupRow {
  const closedAt = closedAtOf(conv);
  return {
    conversationId: conv.conversationId,
    label: serverLabel(conv),
    memberCount: (conv.participants ?? []).length,
    // status is typed `string`; relay_group values are exactly 'open' | 'closed'.
    status: conv.status as 'open' | 'closed',
    createdAt: conv.created_at,
    ...(closedAt !== undefined && { closedAt }),
    lastActivityAt: conv.last_activity_at,
  };
}

/** Max ISO-8601 stamp (lexicographic == chronological for UTC 'Z'); omit when empty. */
function maxIso(values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((a, b) => (a >= b ? a : b));
}

/**
 * The retirement eligibility MIRROR - matches services/poolNumbers.ts
 * retireEligible EXACTLY: eligible = lifecycle_state === 'active' AND openGroups
 * === 0 AND totalGroups >= 1 AND last_group_closed_at defined AND
 * Date.parse(last_group_closed_at) <= now() - RELEASE_GRACE_MS (exactly-at-grace
 * IS eligible). Two DELIBERATE non-mirrors (spec sec 3): the sweep's
 * `if (!config.relayNumberReleaseEnabled) return []` flag gate is NOT applied (the
 * page shows what the sweep WOULD consider), and the sweep gets active-only for
 * free from listActive whereas this mirror iterates ALL states so it checks
 * lifecycle_state EXPLICITLY. daysRemaining counts down only while idle + hosted +
 * not yet eligible. RELEASE_GRACE_MS is imported (a second 180-day literal is a defect).
 */
function retireMirror(
  rec: PoolNumberItem,
  openGroups: number,
  totalGroups: number,
  nowMs: number,
): { eligible: boolean; daysRemaining?: number } {
  const closedAt = rec.last_group_closed_at;
  if (
    rec.lifecycle_state !== 'active' ||
    openGroups !== 0 ||
    totalGroups < 1 ||
    closedAt === undefined
  ) {
    return { eligible: false };
  }
  const closedMs = Date.parse(closedAt);
  // W2/W4: a corrupt / unparseable last_group_closed_at parses to NaN. Both sides
  // now treat that as NOT eligible: the SWEEP (services/poolNumbers.ts
  // retireEligible) skips the number and error-logs the corrupt stamp, and this
  // page returns plain not-eligible with no countdown - so page and sweep AGREE
  // (no divergence). Reporting not-eligible here also avoids emitting NaN artifacts
  // (Math.ceil(NaN) = NaN, which JSON.stringify serializes to null so the client
  // would render "nulld remaining").
  if (Number.isNaN(closedMs)) return { eligible: false };
  if (closedMs <= nowMs - RELEASE_GRACE_MS) return { eligible: true };
  const daysRemaining = Math.ceil((closedMs + RELEASE_GRACE_MS - nowMs) / ONE_DAY_MS);
  return { eligible: false, daysRemaining };
}

export function createPoolNumbersAdminRouter(deps: PoolNumbersAdminRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const poolNumbers = deps.poolNumbersRepo ?? createPoolNumbersRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const now = deps.now ?? (() => new Date());

  const router = Router();

  // Admin-only inventory surface (mirrors adminUsers).
  router.use(requireRole('admin'));

  // GET /api/pool-numbers - the whole inventory (active, releasing, released);
  // the client filters. N+1 group lookups are accepted at launch scale (spec sec 3).
  router.get('/', async (_req, res) => {
    const states: PoolNumberLifecycleState[] = ['active', 'releasing', 'released'];
    const flat = (await Promise.all(states.map((s) => poolNumbers.listByState(s)))).flat();
    // W1: these three Queries are NOT a consistent snapshot. A number changing
    // state as we read can be projected under TWO partitions at once (a stale old
    // + a fresh new), so `flat` would carry it TWICE and render a duplicate row
    // (and duplicate React keys downstream). De-dupe by poolNumber, keeping the
    // furthest-along lifecycle state (see LIFECYCLE_RANK). This heals the
    // DUPLICATE half; the mirror-image VANISH half (dropped from the old
    // partition before it lands in the new) is inherently transient and
    // self-heals on the next reload.
    const byNumber = new Map<string, PoolNumberItem>();
    for (const rec of flat) {
      const seen = byNumber.get(rec.poolNumber);
      if (
        seen === undefined ||
        LIFECYCLE_RANK[rec.lifecycle_state] > LIFECYCLE_RANK[seen.lifecycle_state]
      ) {
        byNumber.set(rec.poolNumber, rec);
      }
    }
    const records = [...byNumber.values()];
    const nowMs = now().getTime();

    const numbers: PoolNumberRow[] = await Promise.all(
      records.map(async (rec): Promise<PoolNumberRow> => {
        // getAllByPoolNumber has no order guarantee - sort newest-first by created_at.
        const groups = (await conversations.getAllByPoolNumber(rec.poolNumber)).sort((a, b) =>
          a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
        );
        const openGroups = groups.filter((g) => g.status === 'open').length;
        const burned = rec.burned_phones;
        const burnedCount =
          burned instanceof Set ? burned.size : Array.isArray(burned) ? burned.length : 0;
        const lastActivityAt = maxIso(groups.map((g) => g.last_activity_at));
        return {
          number: rec.poolNumber,
          state: rec.lifecycle_state,
          openGroups,
          totalGroups: groups.length,
          burnedCount,
          ...(lastActivityAt !== undefined && { lastActivityAt }),
          ...(rec.last_group_closed_at !== undefined && {
            lastGroupClosedAt: rec.last_group_closed_at,
          }),
          ...(rec.released_at !== undefined && { releasedAt: rec.released_at }),
          retire: retireMirror(rec, openGroups, groups.length, nowMs),
          groups: groups.map(toGroupRow),
        };
      }),
    );

    // PII: counts only - never a poolNumber or a participant phone/name.
    log.info(
      { numberCount: numbers.length, groupCount: numbers.reduce((n, r) => n + r.groups.length, 0) },
      'pool-numbers admin inventory served',
    );
    res.json({ numbers });
  });

  return router;
}
