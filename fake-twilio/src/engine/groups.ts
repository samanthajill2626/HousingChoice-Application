// fake-twilio/src/engine/groups.ts
//
// Traffic-derived relay-group state (spec §4), ALONGSIDE the party-keyed thread
// store — never replacing it. The engine feeds this store from its two entry
// points (recordOutboundFromApp with a non-app `from`; sendAsParty with an
// explicit non-app `to`) and from the status-callback progression; the store
// answers with immutable GroupSnapshot DTOs the engine emits/serves.
import type {
  DeliveryState, GroupEntry, GroupMember, GroupOutboundRecipient, GroupSnapshot,
} from './types.js';

/**
 * The rolling burst window (spec §4.2/§9). Fan-out legs are sequential and
 * token-bucket-paced at ~1 leg/second by default (`A2P_RATE_LIMIT_PER_SEC`
 * defaults to 1.0 and scripts/dev.mjs does not override it), so a sub-second
 * quiet-gap would put EVERY leg in its own burst. 5s comfortably exceeds the
 * 1/s pacing + jitter; each leg refreshes the deadline (rolling), so an
 * N-member fan-out stays one burst regardless of N. The opposing risk — two
 * unrelated byte-identical sends within 5s merging — is negligible for a
 * hand-driven dev tool. NOTE the coupling: an operator who sets
 * A2P_RATE_LIMIT_PER_SEC below ~0.25 (>4s/leg) would fragment bursts here.
 */
export const BURST_WINDOW_MS = 5000;

interface OutboundEntryState {
  kind: 'outbound';
  id: string;
  body?: string;
  mediaUrls?: string[];
  at: string;
  recipients: GroupOutboundRecipient[];
}

interface InboundEntryState {
  kind: 'inbound';
  id: string;
  from: string;
  fromLabel: string;
  body?: string;
  mediaUrls?: string[];
  at: string;
}

type EntryState = OutboundEntryState | InboundEntryState;

interface OpenBurst {
  /** Rolling quiet-gap deadline — ANY leg of the burst refreshes it. */
  deadlineAtMs: number;
  /** (body, media) identity → the entry same-content legs collapse into.
   *  Differing-content legs in one burst stay separate entries (spec §4.2)
   *  but still share the burst's roster contribution. */
  entriesByContent: Map<string, OutboundEntryState>;
}

interface GroupState {
  poolNumber: string;
  /** number → last-seen label, kept all-time so a re-appearing member is
   *  labeled instantly even after aging out of the roster. */
  labels: Map<string, string>;
  /** Increments each time a new burst STARTS. */
  burstEpoch: number;
  /** Recipients of the CURRENT (most recent) burst, in first-leg order. */
  burstRecipients: Set<string>;
  /** sender → burstEpoch at their last inbound. Retained in the roster while
   *  epoch >= burstEpoch - 1: the -1 keeps the sender whose inbound TRIGGERED
   *  the current burst (their own relay fan-out excludes them) — the
   *  load-bearing ∪ clause of spec §4.3. */
  inboundSenderEpochs: Map<string, number>;
  openBurst?: OpenBurst;
  entries: EntryState[];
  lastActivityAt: string;
}

/** Direct pointer from a fan-out leg's SID to its delivery slot, so the
 *  status-callback flow can advance exactly the right slot. */
interface SlotRef {
  group: GroupState;
  slot: GroupOutboundRecipient;
}

export class GroupStore {
  private readonly groups = new Map<string, GroupState>();
  private readonly slotsBySid = new Map<string, SlotRef>();

  /** An outbound fan-out leg from a pool number. Returns the recomputed snapshot. */
  observeOutboundLeg(input: {
    poolNumber: string;
    to: string;
    toLabel: string;
    sid: string;
    state: DeliveryState;
    body?: string;
    mediaUrls?: string[];
    atIso: string;
  }): GroupSnapshot {
    const g = this.getOrCreate(input.poolNumber);
    const nowMs = Date.parse(input.atIso);
    if (!g.openBurst || nowMs > g.openBurst.deadlineAtMs) {
      // A new burst starts: roster is SET from this burst (spec §4.3), so the
      // previous burst's recipients are dropped, and inbound senders age out
      // once they are older than the PREVIOUS burst (see inboundSenderEpochs).
      g.burstEpoch += 1;
      g.burstRecipients.clear();
      for (const [num, epoch] of g.inboundSenderEpochs) {
        if (epoch < g.burstEpoch - 1) g.inboundSenderEpochs.delete(num);
      }
      g.openBurst = { deadlineAtMs: nowMs + BURST_WINDOW_MS, entriesByContent: new Map() };
    } else {
      g.openBurst.deadlineAtMs = nowMs + BURST_WINDOW_MS; // rolling window
    }
    g.burstRecipients.add(input.to);
    g.labels.set(input.to, input.toLabel);
    // Burst identity = (body, media). Real fan-outs send identical body AND
    // media to every member, so this collapses exactly them; including media
    // keeps a synthetic same-body/different-media pair from merging.
    const contentKey = JSON.stringify([input.body ?? null, input.mediaUrls ?? []]);
    let entry = g.openBurst.entriesByContent.get(contentKey);
    if (!entry) {
      entry = {
        kind: 'outbound',
        id: input.sid, // first leg's SID = stable entry id
        at: input.atIso,
        recipients: [],
        ...(input.body !== undefined && { body: input.body }),
        ...(input.mediaUrls !== undefined && { mediaUrls: input.mediaUrls }),
      };
      g.openBurst.entriesByContent.set(contentKey, entry);
      g.entries.push(entry);
    }
    const slot: GroupOutboundRecipient = { number: input.to, sid: input.sid, state: input.state };
    entry.recipients.push(slot);
    this.slotsBySid.set(input.sid, { group: g, slot });
    g.lastActivityAt = input.atIso;
    return this.snapshotOf(g);
  }

  /** An inbound member→pool message (sendAsParty with an explicit pool `to`). */
  observeInbound(input: {
    poolNumber: string;
    from: string;
    fromLabel: string;
    sid: string;
    body?: string;
    mediaUrls?: string[];
    atIso: string;
  }): GroupSnapshot {
    const g = this.getOrCreate(input.poolNumber);
    g.labels.set(input.from, input.fromLabel);
    g.inboundSenderEpochs.set(input.from, g.burstEpoch);
    g.entries.push({
      kind: 'inbound',
      id: input.sid,
      from: input.from,
      fromLabel: input.fromLabel,
      at: input.atIso,
      ...(input.body !== undefined && { body: input.body }),
      ...(input.mediaUrls !== undefined && { mediaUrls: input.mediaUrls }),
    });
    g.lastActivityAt = input.atIso;
    return this.snapshotOf(g);
  }

  /** Advance the delivery slot for a fan-out leg's SID (status-callback flow).
   *  Returns the recomputed snapshot, or undefined when the SID is not a
   *  group-tracked leg (plain app→party sends never are). */
  updateSlotState(sid: string, state: DeliveryState, errorCode?: string): GroupSnapshot | undefined {
    const ref = this.slotsBySid.get(sid);
    if (!ref) return undefined;
    ref.slot.state = state;
    if (errorCode !== undefined) ref.slot.errorCode = errorCode;
    return this.snapshotOf(ref.group);
  }

  listGroups(): GroupSnapshot[] {
    return [...this.groups.values()].map((g) => this.snapshotOf(g));
  }

  reset(): void {
    this.groups.clear();
    this.slotsBySid.clear();
  }

  private getOrCreate(poolNumber: string): GroupState {
    let g = this.groups.get(poolNumber);
    if (!g) {
      g = {
        poolNumber,
        labels: new Map(),
        burstEpoch: 0,
        burstRecipients: new Set(),
        inboundSenderEpochs: new Map(),
        entries: [],
        lastActivityAt: '',
      };
      this.groups.set(poolNumber, g);
    }
    return g;
  }

  /** roster := recipients(most recent burst) ∪ senders(inbound since the
   *  previous burst started), recipients first, in first-seen order. */
  private rosterOf(g: GroupState): GroupMember[] {
    const numbers: string[] = [...g.burstRecipients];
    for (const [num, epoch] of g.inboundSenderEpochs) {
      if (epoch >= g.burstEpoch - 1 && !g.burstRecipients.has(num)) numbers.push(num);
    }
    return numbers.map((number) => ({ number, label: g.labels.get(number) ?? number }));
  }

  /** A fresh deep copy — emitted snapshots must not mutate under later traffic. */
  private snapshotOf(g: GroupState): GroupSnapshot {
    return {
      poolNumber: g.poolNumber,
      members: this.rosterOf(g),
      entries: g.entries.map((e): GroupEntry =>
        e.kind === 'inbound'
          ? { ...e, ...(e.mediaUrls !== undefined && { mediaUrls: [...e.mediaUrls] }) }
          : {
              ...e,
              ...(e.mediaUrls !== undefined && { mediaUrls: [...e.mediaUrls] }),
              recipients: e.recipients.map((r) => ({ ...r })),
            },
      ),
      lastActivityAt: g.lastActivityAt,
    };
  }
}
