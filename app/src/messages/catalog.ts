// Message catalog — the single registry of every automated/pinned message the
// system sends (tour reminders, placement nudges, the housing-fair welcome, the
// missed-call auto-text, the relay group intro, voice <Say> prompts, the cell-
// verification code SMS, and the A2P keyword replies).
//
// This module is deliberately PURE: data + type only, no I/O, no repo imports
// (same discipline as smsCompliance.ts). Send-sites call the resolver
// (./resolve.ts), which picks an override-or-default and interpolates.
//
// COMPLIANCE COPY IS NEVER RE-LITERALED HERE. The compliance-locked entries and
// the two compliance-derived editable defaults (welcome.sms, missed_call.autotext)
// and the relay identity REFERENCE the smsCompliance.ts constants by import —
// smsCompliance.ts stays the A2P single source of truth for that filed copy.
import {
  DEFAULT_MISSED_CALL_AUTOTEXT,
  HELP_REPLY,
  RELAY_INTRO_IDENTITY,
  STOP_CONFIRMATION,
  WEB_FORM_CONSENT_COPY,
  WELCOME_SMS,
} from '../lib/smsCompliance.js';

/** Which subsystem a message belongs to (shapes editability + review posture). */
export type MessageClass = 'operational' | 'compliance-locked' | 'voice' | 'transactional';

/** Every stable message id (also the future operator-override key). */
export type MessageId =
  // Operational — tour reminders (jobs/tourReminders.ts)
  | 'tour.confirmation'
  | 'tour.day_before'
  | 'tour.morning_of'
  | 'tour.en_route'
  | 'tour.no_show_checkin'
  // Operational — placement nudges (jobs/placementNudges.ts)
  | 'nudge.receipt_check'
  | 'nudge.completion_check'
  | 'nudge.approval_check'
  | 'nudge.rta_window_closing'
  // Operational — relay group intro (jobs/relayFanOut.ts)
  | 'relay.intro'
  // Operational - relay group media-only fan-out body (jobs/relayFanOut.ts)
  | 'relay.media_only'
  // Compliance-derived, already editable
  | 'welcome.sms'
  | 'missed_call.autotext'
  // Compliance-locked (never freely editable)
  | 'keyword.stop'
  | 'keyword.help'
  | 'consent.web_form'
  | 'relay.identity'
  // Voice <Say> (routes/webhooks/voice.ts)
  | 'voice.whisper_founder'
  | 'voice.whisper_relay'
  | 'voice.whisper_outbound'
  | 'voice.caller_label_default'
  | 'voice.team_unreachable'
  | 'voice.greeting_no_holder'
  | 'voice.self_call'
  | 'voice.founder_refuse'
  | 'voice.thread_closed'
  | 'voice.masked_refuse'
  | 'voice.outbound_unavailable'
  | 'voice.missed_call_goodbye'
  // Transactional
  | 'verify.cell_code';

export interface MessageDef {
  /** Stable key — also the future override key. Equals its catalog map key. */
  id: MessageId;
  /** Canonical copy, with {token} placeholders where it interpolates. */
  default: string;
  class: MessageClass;
  /** May an operator override it later? (does NOT expose it now — no override map/UI) */
  editable: boolean;
  channel: 'sms' | 'voice';
  /** Allowed interpolation tokens, e.g. ['firstName'], ['callerLabel']. */
  vars: readonly string[];
  /** First-contact compliance floor: an override must contain "STOP". */
  requiresOptOut?: boolean;
  /** Segment cap for future validation (default 320 for sms). */
  maxChars?: number;
  /** Marks a currently-unreachable/dead code path (documented, kept for completeness). */
  dead?: boolean;
}

export const MESSAGE_CATALOG: Record<MessageId, MessageDef> = {
  // --- Operational: tour reminders (moved out of jobs/tourReminders.ts) ---
  'tour.confirmation': {
    id: 'tour.confirmation',
    default: "Your tour is confirmed. We'll send reminders as it approaches.",
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [],
  },
  'tour.day_before': {
    id: 'tour.day_before',
    default: 'Reminder: your property tour is tomorrow.',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [],
  },
  'tour.morning_of': {
    id: 'tour.morning_of',
    default: 'Good morning! Your property tour is today.',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [],
  },
  'tour.en_route': {
    id: 'tour.en_route',
    default: 'Your tour is coming up soon. Text us when you\'re on the way!',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [],
  },
  'tour.no_show_checkin': {
    id: 'tour.no_show_checkin',
    default: 'Hi! We noticed you may have missed your tour. Want to reschedule?',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [],
  },

  // --- Operational: placement nudges (moved out of jobs/placementNudges.ts) ---
  'nudge.receipt_check': {
    id: 'nudge.receipt_check',
    default:
      'Just checking in — did the rental application come through? Let us know if you need it re-sent.',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [],
  },
  'nudge.completion_check': {
    id: 'nudge.completion_check',
    default: 'How is the application coming along? Text us here if you are stuck on anything.',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [],
  },
  'nudge.approval_check': {
    id: 'nudge.approval_check',
    default: 'Checking in — any decision yet on the application we sent over?',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [],
  },
  'nudge.rta_window_closing': {
    id: 'nudge.rta_window_closing',
    default:
      'Friendly reminder — the 48-hour RTA window is closing. Have you been able to submit it?',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [],
  },

  // --- Operational: relay group intro ---
  // §7: the RELAY_INTRO_IDENTITY prefix + a space folds INTO the default; the
  // {members} token is the count-plurality / Oxford-list `connection` string,
  // computed in code (jobs/relayFanOut.ts composeIntroBody) and passed in.
  'relay.intro': {
    id: 'relay.intro',
    default: `${RELAY_INTRO_IDENTITY} {members}`,
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: ['members'],
  },
  // Body for a MEDIA-ONLY message fanned out to a relay group (no text to
  // relay). "<name> sent an attachment." - the media rides along on the leg.
  'relay.media_only': {
    id: 'relay.media_only',
    default: '{name} sent an attachment.',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: ['name'],
  },

  // --- Compliance-derived, already editable (reference smsCompliance consts) ---
  'welcome.sms': {
    id: 'welcome.sms',
    // WELCOME_SMS carries no {firstName} token; an operator OVERRIDE may still use
    // it (today's renderWelcome convention) — so firstName is a declared, default-
    // unused var (allowed because the entry is editable).
    default: WELCOME_SMS,
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: ['firstName'],
    requiresOptOut: true,
  },
  'missed_call.autotext': {
    id: 'missed_call.autotext',
    default: DEFAULT_MISSED_CALL_AUTOTEXT,
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [],
    requiresOptOut: true,
  },

  // --- Compliance-locked (never freely editable; reference smsCompliance consts) ---
  'keyword.stop': {
    id: 'keyword.stop',
    default: STOP_CONFIRMATION,
    class: 'compliance-locked',
    editable: false,
    channel: 'sms',
    vars: [],
  },
  'keyword.help': {
    id: 'keyword.help',
    default: HELP_REPLY,
    class: 'compliance-locked',
    editable: false,
    channel: 'sms',
    vars: [],
  },
  'consent.web_form': {
    id: 'consent.web_form',
    default: WEB_FORM_CONSENT_COPY,
    class: 'compliance-locked',
    editable: false,
    channel: 'sms',
    vars: [],
  },
  'relay.identity': {
    id: 'relay.identity',
    default: RELAY_INTRO_IDENTITY,
    class: 'compliance-locked',
    editable: false,
    channel: 'sms',
    vars: [],
  },

  // --- Voice <Say> copy (routes/webhooks/voice.ts). editable:false. ---
  'voice.whisper_founder': {
    id: 'voice.whisper_founder',
    default: 'You have a Housing Choice call from {callerLabel}. Press 1 to accept.',
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: ['callerLabel'],
  },
  'voice.whisper_relay': {
    id: 'voice.whisper_relay',
    default:
      'You have a Housing Choice call from {callerLabel}. Press 1 to accept, or press 0 to reach the team.',
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: ['callerLabel'],
  },
  'voice.whisper_outbound': {
    id: 'voice.whisper_outbound',
    default: 'Calling {targetLabel}. Press 1 to connect.',
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: ['targetLabel'],
  },
  'voice.caller_label_default': {
    // Not a <Say> — the default value for the callerLabel query param, later
    // interpolated into voice.whisper_founder / voice.whisper_relay.
    id: 'voice.caller_label_default',
    default: 'a Housing Choice contact',
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: [],
  },
  'voice.team_unreachable': {
    id: 'voice.team_unreachable',
    default: 'Sorry, the team is not reachable right now. Please try again later.',
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: [],
  },
  'voice.greeting_no_holder': {
    id: 'voice.greeting_no_holder',
    default:
      'Thank you for calling Housing Choice. Please send us a text message, and we will get back to you.',
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: [],
  },
  'voice.self_call': {
    id: 'voice.self_call',
    default:
      'Thanks for calling Housing Choice. Please reach us from a different line, or send a text message. Goodbye.',
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: [],
  },
  'voice.founder_refuse': {
    // Dead path today: decideFounderRouting only returns 'ring-founder'.
    id: 'voice.founder_refuse',
    default: 'Sorry, no one is available to take your call right now.',
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: [],
    dead: true,
  },
  'voice.thread_closed': {
    id: 'voice.thread_closed',
    default:
      'Sorry, this Housing Choice connection is no longer available. Please send us a text message instead.',
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: [],
  },
  'voice.masked_refuse': {
    // Dead path today: decideRouting only returns 'bridge'.
    id: 'voice.masked_refuse',
    default: 'Sorry, this Housing Choice connection is not available right now.',
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: [],
    dead: true,
  },
  'voice.outbound_unavailable': {
    id: 'voice.outbound_unavailable',
    default: 'Sorry, this Housing Choice call is no longer available. Goodbye.',
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: [],
  },
  'voice.missed_call_goodbye': {
    id: 'voice.missed_call_goodbye',
    default:
      'Sorry we missed your call. Please send us a text message and we will get right back to you. Goodbye.',
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: [],
  },

  // --- Transactional ---
  // Uses the INTERNAL name "HousingChoice" (NOT the SMS brand) — preserve verbatim.
  'verify.cell_code': {
    id: 'verify.cell_code',
    default: 'Your HousingChoice verification code is {code}. It expires in 10 minutes.',
    class: 'transactional',
    editable: false,
    channel: 'sms',
    vars: ['code'],
  },
};
