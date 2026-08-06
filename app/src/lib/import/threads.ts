// Conversation shaping + per-phone traffic (spec §2.4, §3.2).
//
// Two jobs, both driven off the same single pass over messages and calls:
//
// 1. Fold Quo's 707 conversations into OUR thread model. Quo keys a thread by
//    its own `CN...` id; we key a 1:1 thread by the counterparty phone
//    (byParticipantPhone is one thread per phone) and a group by its sorted
//    participant set. 133 phones appear in more than one Quo conversation, so
//    this is a genuine many-to-one fold, not a relabel.
//
// 2. Per-phone traffic totals — message counts, call counts, first/last contact,
//    and whether the person has ever sent us anything INBOUND. The last one
//    matters beyond curiosity: inbound traffic is the consent basis for
//    importing a number into a system that sends SMS (spec §3.7).

import { normalizeToE164 } from '../phone.js';
import { conversationIdForGroup, conversationIdFor1to1 } from './ids.js';
import { counterpartiesOf, type QuoCall, type QuoExport, type QuoMessage } from './quoSource.js';

export interface TrafficStats {
  messageCount: number;
  inboundMessageCount: number;
  callCount: number;
  /** ISO 8601 of the earliest message or call. */
  firstContactAt?: string;
  /** ISO 8601 of the most recent message or call. */
  lastContactAt?: string;
}

export interface ImportedThread {
  /** Our deterministic conversationId. */
  conversationId: string;
  /** Outside participants (E.164), sorted. Never includes an org number. */
  participants: string[];
  isGroup: boolean;
  /** Every Quo conversationId that folded into this thread. */
  quoConversationIds: string[];
  messages: QuoMessage[];
  calls: QuoCall[];
  /** ISO 8601 of the newest message or call — our `last_activity_at`. */
  lastActivityAt: string;
  firstActivityAt: string;
}

export interface ThreadIndex {
  threads: ImportedThread[];
  /** Traffic per counterparty phone (E.164). */
  traffic: Map<string, TrafficStats>;
  /** Phones with traffic that Quo has no contact row for (80 in the real export). */
  orphanPhones: Set<string>;
  /**
   * Messages and calls that belong to NO importable thread, because their
   * conversation has no outside participant. Counted and surfaced rather than
   * quietly dropped: on the real export this is 2 messages Sam sent to her own
   * number and 1 call from a withheld caller ID, and "17,852 of 17,854 written"
   * with no explanation is indistinguishable from a bug.
   */
  unroutable: {
    messages: QuoMessage[];
    calls: QuoCall[];
    /** Withheld caller ID (`Anonymous` in the `from` column) — recurs in production. */
    anonymousCalls: number;
    /** Traffic where every participant is one of our own numbers (self-texts). */
    selfAddressed: number;
  };
  warnings: string[];
}

function bump(stats: Map<string, TrafficStats>, phone: string): TrafficStats {
  let s = stats.get(phone);
  if (!s) {
    s = { messageCount: 0, inboundMessageCount: 0, callCount: 0 };
    stats.set(phone, s);
  }
  return s;
}

function noteTime(stats: TrafficStats, iso: string): void {
  if (!stats.firstContactAt || iso < stats.firstContactAt) stats.firstContactAt = iso;
  if (!stats.lastContactAt || iso > stats.lastContactAt) stats.lastContactAt = iso;
}

/**
 * Build the thread index.
 *
 * Participants are resolved per Quo conversation from the UNION of every
 * message's counterparties, not per message: a group thread's roster is only
 * fully visible across the whole thread (an outbound message lists the members,
 * an inbound one lists the sender plus the other recipients).
 */
export function buildThreadIndex(quo: QuoExport): ThreadIndex {
  const warnings: string[] = [];
  const { ownNumbers } = quo;

  // --- pass 1: resolve each Quo conversation's participant set ---
  const partsByQuoConv = new Map<string, Set<string>>();
  const addParts = (convId: string, phones: readonly string[]): void => {
    let set = partsByQuoConv.get(convId);
    if (!set) {
      set = new Set();
      partsByQuoConv.set(convId, set);
    }
    for (const p of phones) set.add(p);
  };

  for (const m of quo.messages) addParts(m.conversationId, counterpartiesOf(m, ownNumbers));
  for (const c of quo.calls) {
    const phones = counterpartiesOf(
      { to: [c.to], from: c.from, direction: c.direction },
      ownNumbers,
    );
    addParts(c.conversationId, phones);
  }

  // --- pass 2: map each Quo conversation onto OUR deterministic thread id ---
  const threadIdOf = new Map<string, string>();
  const threads = new Map<string, ImportedThread>();

  const unroutableConvIds = new Set<string>();
  for (const [quoConvId, partSet] of partsByQuoConv) {
    const participants = [...partSet].sort();
    if (participants.length === 0) {
      // No outside participant: either we texted ourselves, or the counterparty
      // number is unusable (a withheld caller ID). Nothing to attach a thread
      // to. Recorded so the totals reconcile against the export.
      unroutableConvIds.add(quoConvId);
      continue;
    }
    const isGroup = participants.length > 1;
    const conversationId = isGroup
      ? conversationIdForGroup(participants)
      : conversationIdFor1to1(participants[0]!);
    threadIdOf.set(quoConvId, conversationId);

    let thread = threads.get(conversationId);
    if (!thread) {
      thread = {
        conversationId,
        participants,
        isGroup,
        quoConversationIds: [],
        messages: [],
        calls: [],
        lastActivityAt: '',
        firstActivityAt: '',
      };
      threads.set(conversationId, thread);
    } else {
      // Two Quo conversations folded together. Union the rosters so a member who
      // only appears in one of them is not lost.
      const merged = new Set([...thread.participants, ...participants]);
      thread.participants = [...merged].sort();
    }
    thread.quoConversationIds.push(quoConvId);
  }

  // --- pass 3: file messages/calls onto their thread + accumulate traffic ---
  const traffic = new Map<string, TrafficStats>();

  for (const m of quo.messages) {
    const conversationId = threadIdOf.get(m.conversationId);
    if (conversationId) threads.get(conversationId)!.messages.push(m);

    for (const phone of counterpartiesOf(m, ownNumbers)) {
      const s = bump(traffic, phone);
      s.messageCount += 1;
      if (m.direction === 'incoming') s.inboundMessageCount += 1;
      noteTime(s, m.createdAt);
    }
  }

  for (const c of quo.calls) {
    const conversationId = threadIdOf.get(c.conversationId);
    if (conversationId) threads.get(conversationId)!.calls.push(c);

    const phones = counterpartiesOf(
      { to: [c.to], from: c.from, direction: c.direction },
      ownNumbers,
    );
    for (const phone of phones) {
      const s = bump(traffic, phone);
      s.callCount += 1;
      noteTime(s, c.createdAt);
    }
  }

  // --- pass 4: sort each thread chronologically + stamp activity bounds ---
  for (const thread of threads.values()) {
    thread.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    thread.calls.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const times = [
      ...thread.messages.map((m) => m.createdAt),
      ...thread.calls.map((c) => c.createdAt),
    ].sort();
    thread.firstActivityAt = times[0] ?? '';
    thread.lastActivityAt = times[times.length - 1] ?? '';
  }

  // --- orphans: traffic with no Quo contact row ---
  const contactPhones = new Set<string>();
  for (const c of quo.contacts) if (c.phone) contactPhones.add(c.phone);
  const orphanPhones = new Set<string>();
  for (const phone of traffic.keys()) if (!contactPhones.has(phone)) orphanPhones.add(phone);

  // --- reconcile: everything the export held that no thread claimed ---
  const unroutableMessages = quo.messages.filter((m) => unroutableConvIds.has(m.conversationId));
  const unroutableCalls = quo.calls.filter((c) => unroutableConvIds.has(c.conversationId));
  const anonymousCalls = unroutableCalls.filter(
    (c) => !normalizeToE164(c.direction === 'incoming' ? c.from : c.to),
  ).length;
  const selfAddressed =
    unroutableMessages.filter((m) => {
      const ends = [m.from, ...m.to].map((p) => normalizeToE164(p));
      return ends.every((p) => p !== undefined && ownNumbers.has(p));
    }).length + (unroutableCalls.length - anonymousCalls);

  if (unroutableMessages.length > 0 || unroutableCalls.length > 0) {
    warnings.push(
      `${unroutableMessages.length} message(s) and ${unroutableCalls.length} call(s) belong to no ` +
        `importable thread and were NOT imported: ${selfAddressed} addressed only to our own ` +
        `number(s), ${anonymousCalls} from a withheld caller ID. ` +
        `Import totals will be short by exactly this much.`,
    );
  }

  return {
    threads: [...threads.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
    traffic,
    orphanPhones,
    unroutable: {
      messages: unroutableMessages,
      calls: unroutableCalls,
      anonymousCalls,
      selfAddressed,
    },
    warnings,
  };
}

/**
 * The single STOP in the real corpus must be honoured on import (spec §3.7).
 *
 * Deliberately narrow: only a message whose ENTIRE body is an opt-out keyword
 * counts. "stop by tomorrow at 5" is not an opt-out, and treating it as one
 * would silently suppress a live tenant.
 */
const STOP_KEYWORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout|opt-out)\s*$/i;

/** Phones that sent a bare STOP keyword — these import with `sms_opt_out` set. */
export function findOptOutPhones(quo: QuoExport): Set<string> {
  const out = new Set<string>();
  for (const m of quo.messages) {
    if (m.direction !== 'incoming') continue;
    if (!STOP_KEYWORDS.test(m.body)) continue;
    const e164 = normalizeToE164(m.from);
    if (e164 && !quo.ownNumbers.has(e164)) out.add(e164);
  }
  return out;
}
