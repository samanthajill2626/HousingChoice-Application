// Wire types for the fake-phones UI.
//
// These MIRROR the engine's types (`fake-twilio/src/engine/types.ts`) and the
// `EngineEvent` union (`fake-twilio/src/engine/engine.ts`). The UI is a separate
// package by design, so the shapes are re-declared here rather than imported.
// If the engine types change, update BOTH places.

// 'unknown' = a party the engine AUTO-REGISTERED (an app send to a number with
// no persona), labeled by its bare number. Auto-only — the ad-hoc dialog does
// not offer it.
export type Role = 'landlord' | 'tenant' | 'pm' | 'staff' | 'unknown';

export type DeliveryState = 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed';

/** How the fake should drive an outbound message's status callbacks. */
export interface DeliveryProfile {
  kind: 'normal' | 'stall' | 'fail';
  /** For kind==='stall': the last state to emit before stopping (default 'sent'). */
  stallAt?: DeliveryState;
  /** For kind==='fail': 'failed' | 'undelivered' (default 'failed') + an ErrorCode. */
  failState?: 'failed' | 'undelivered';
  errorCode?: string;
}

export interface Persona {
  id: string;
  label: string;
  role: Role;
  /** E.164, e.g. +15550100001. */
  number: string;
  /** Optional pointer to seeded app data (contactId), for humans reading the roster. */
  seededRef?: string;
  adHoc: boolean;
}

export interface ThreadMessage {
  /** Twilio-style SID: SM... (or MM... when media is present). */
  sid: string;
  direction: 'inbound' | 'outbound';
  /** Sender E.164 (app number for outbound, party number for inbound). */
  from: string;
  /** Recipient E.164. */
  to: string;
  body?: string;
  mediaUrls?: string[];
  state: DeliveryState;
  /** Twilio ErrorCode, set only when the message resolved to a failure state. */
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

/** A conversation thread between the app and exactly one party number. */
export interface Thread {
  /** The party's E.164 number (the non-app side). */
  partyNumber: string;
  messages: ThreadMessage[];
}

/** The app's business number (mirrors `fake-twilio/src/engine/registry.ts`
 *  APP_NUMBER). An outbound message whose `from` differs from this was sent
 *  from a relay POOL number — group traffic, which renders ONLY in the
 *  GroupPanel (see isDirectMessage). */
export const APP_NUMBER = '+15550009999';

/**
 * True iff a message is ordinary app↔party BUSINESS traffic — one side is the
 * app's business number. Relay-group traffic fails this in both directions (a
 * fan-out leg's `from` is the pool; a member's group send's `to` is the pool)
 * and belongs ONLY in the GroupPanel transcript: the 1:1 pane and its unread
 * rule filter on this predicate so group texts don't show up twice (2026-07-07
 * UX decision, revising spec §3's "badged in the 1:1 too" simplification). The
 * raw `threads` state stays UNFILTERED — it mirrors `GET /control/threads`,
 * which the e2e scenario steps assert pool legs INTO.
 */
export function isDirectMessage(message: ThreadMessage): boolean {
  return message.from === APP_NUMBER || message.to === APP_NUMBER;
}

// ---- Relay groups (traffic-derived; mirror engine/types.ts) ----
// Groups are an ADDITIONAL view over the same traffic — pool legs still land in
// the recipient persona's raw thread (mirroring /control/threads), but the 1:1
// PANE hides them (isDirectMessage): they render only here. Served by
// `GET /control/groups` and pushed whole per mutation as `group.updated` SSE.

export interface GroupMember {
  /** Member E.164. */
  number: string;
  /** Persona label when known, else the bare number (auto-registered recipients). */
  label: string;
}

/** One fan-out leg's delivery slot on a collapsed outbound entry. The leg keeps
 *  its own SID so the existing status-callback flow advances per-recipient
 *  state (rendered as one StatusChip per slot in the group view). */
export interface GroupOutboundRecipient {
  number: string;
  sid: string;
  state: DeliveryState;
  /** Twilio ErrorCode, set only when the leg resolved to a failure state. */
  errorCode?: string;
}

/** An ordered group-transcript entry: an inbound member→pool message, or an
 *  outbound burst (same-(body,media) fan-out legs collapsed into one logical
 *  message with per-recipient delivery slots). `id` is a stable render key.
 *  Optional fields are ABSENT (never null) when unset. */
export type GroupEntry =
  | { kind: 'inbound'; id: string; from: string; fromLabel: string; body?: string; mediaUrls?: string[]; at: string }
  | { kind: 'outbound'; id: string; body?: string; mediaUrls?: string[]; at: string; recipients: GroupOutboundRecipient[] };

/** The whole-group DTO: `GET /control/groups` item + `group.updated` payload.
 *  `lastActivityAt` tracks TRANSCRIPT activity (a new leg or inbound), not
 *  delivery-slot status changes — unread/sorting should key off it. */
export interface GroupSnapshot {
  /** The pool E.164 the group is keyed by. */
  poolNumber: string;
  /** Current inferred roster (set semantics). */
  members: GroupMember[];
  entries: GroupEntry[];
  lastActivityAt: string;
}

// ---- Control API DTOs ----
export interface SendAsPartyInput {
  /** Party number (must be a known persona or ad-hoc). */
  from: string;
  /** App number the text is sent to (defaults to the configured app number). */
  to?: string;
  body?: string;
  mediaUrls?: string[];
}

export interface SetDeliveryOutcomeInput {
  /** Party number whose NEXT outbound message uses this profile. */
  partyNumber: string;
  profile: DeliveryProfile;
}

export interface AddAdHocInput {
  label: string;
  role: Role;
  /** Optional explicit E.164; otherwise the registry mints one. */
  number?: string;
}

// ---- Live event union (mirrors `EngineEvent` in engineEvents.ts) ----
// NB: every variant name here must ALSO be in `EVENT_TYPES` (useFakeEvents.ts) —
// the SSE listener list is an explicit allowlist; unlisted frames are dropped.
export type EngineEvent =
  | { type: 'message.appended'; partyNumber: string; message: ThreadMessage }
  | { type: 'message.updated'; partyNumber: string; message: ThreadMessage }
  | { type: 'persona.added'; persona: Persona }
  | { type: 'group.updated'; group: GroupSnapshot }
  | { type: 'reset' };
