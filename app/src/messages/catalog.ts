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
  FOUNDER_MISSED_CALL_AUTOTEXT,
  HELP_REPLY,
  OPT_IN_CONFIRMATION,
  RELAY_INTRO_IDENTITY,
  STOP_CONFIRMATION,
  WEB_FORM_CONSENT_COPY,
  WELCOME_SMS,
} from '../lib/smsCompliance.js';

/** Which subsystem a message belongs to (shapes editability + review posture). */
export type MessageClass = 'operational' | 'compliance-locked' | 'voice' | 'transactional';

/** Every stable message id (also the future operator-override key). */
export type MessageId =
  // Operational - tour reminders (jobs/tourReminders.ts). Only the CONFIRMATION
  // pair still has a `_no_address` twin: its copy names the address MID-sentence,
  // so there is nothing to degrade to. Every other rung either never mentions an
  // address or takes the computed {addressLine} clause (messages/tourCopy.ts),
  // and en_route forks on TOUR TYPE instead.
  | 'tour.confirmation'
  | 'tour.confirmation_no_address'
  | 'tour.day_before'
  | 'tour.morning_of'
  | 'tour.en_route_self_guided'
  | 'tour.en_route_landlord_led'
  | 'tour.no_show_checkin'
  // Operational — placement nudges (jobs/placementNudges.ts)
  | 'nudge.receipt_check'
  | 'nudge.completion_check'
  | 'nudge.approval_check'
  | 'nudge.rta_window_closing'
  // Operational — relay group intro (jobs/relayFanOut.ts)
  | 'relay.intro'
  // Operational - relay group intro, TOUR-owned, tour is TODAY in the org
  // timezone (jobs/relayFanOut.ts). Split from the dated variant because the
  // no-dead-tokens rule forbids one entry declaring both {time} and {when}.
  | 'relay.intro_tour_today'
  // Operational - relay group intro, TOUR-owned, any other day (jobs/relayFanOut.ts)
  | 'relay.intro_tour'
  // Operational - relay group intro, PLACEMENT-owned (jobs/relayFanOut.ts)
  | 'relay.intro_placement'
  // Operational - relay group member-added announcement (jobs/relayFanOut.ts)
  | 'relay.member_added'
  // Operational - relay group member-added announcement, role RESOLVED
  // (jobs/relayFanOut.ts). Separate entry, not an empty clause: {role} sits
  // MID-sentence and cannot blank out cleanly.
  | 'relay.member_added_role'
  // Operational - relay group media-only fan-out body (jobs/relayFanOut.ts)
  | 'relay.media_only'
  // Operational - relay group closed final message (routes/relayGroups.ts close)
  | 'relay.group_closed'
  // Compliance-derived, already editable
  | 'welcome.sms'
  | 'missed_call.autotext'
  // Compliance-locked (never freely editable)
  | 'keyword.stop'
  | 'keyword.help'
  | 'keyword.optin'
  | 'consent.web_form'
  | 'relay.identity'
  // Voice <Say> (routes/webhooks/voice.ts)
  | 'voice.whisper_founder'
  | 'voice.whisper_relay'
  | 'voice.whisper_outbound'
  | 'voice.caller_label_default'
  | 'voice.greeting_no_holder'
  | 'voice.self_call'
  | 'voice.founder_refuse'
  | 'voice.thread_closed'
  | 'voice.masked_refuse'
  | 'voice.outbound_unavailable'
  | 'voice.missed_call_goodbye'
  | 'voice.voicemail_prompt'
  | 'voice.voicemail_thanks'
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
  channel: 'sms' | 'voice' | 'email';
  /** Allowed interpolation tokens, e.g. ['firstName'], ['callerLabel']. */
  vars: readonly string[];
  /** First-contact compliance floor: an override must contain "STOP". */
  requiresOptOut?: boolean;
  /** Segment cap for future validation (default 320 for sms). */
  maxChars?: number;
  /** Marks a currently-unreachable/dead code path (documented, kept for completeness). */
  dead?: boolean;
}

/** The token set EVERY tour entry declares (see the TOKEN CONTRACT below). */
const TOUR_NAME_VARS = [
  'when', 'time', 'tenantFirstName', 'tenantName',
  'propertyContactFirstName', 'propertyContactName',
] as const;

export const MESSAGE_CATALOG: Record<MessageId, MessageDef> = {
  // --- Operational: tour reminders (moved out of jobs/tourReminders.ts) ---
  // TOKEN CONTRACT (founder rewrite, Sam 2026-08-24, applied 2026-08-26).
  // Every tour entry declares the FULL token set - when/time/where plus the
  // four name tokens - even where the current copy does not use one:
  // interpolate() iterates DECLARED vars and skips tokens absent from the
  // template, so declaring is what lets a future wording change be a pure
  // string edit (legal ONLY because these entries are editable:true; the
  // no-dead-tokens rule in catalog.test.ts applies to non-editable entries).
  //   - {time} is the TIME ALONE ("3:00 PM"): day_before/morning_of say
  //     "tomorrow"/"today" in the copy, so {when} there would double up.
  //   - {when} is DATE + TIME - used only by the confirmation, which can go
  //     out weeks ahead.
  //   - {addressLine} (morning_of only) is a WHOLE trailing sentence computed
  //     in code (tourCopy.ts): "Address is <street>." or the empty string, so
  //     a unit with no address degrades to a sentence that simply ends -
  //     never "Address is ." and never a literal {where}. The _no_address
  //     twin mechanism survives ONLY on the confirmation pair, whose copy
  //     uses {where} MID-sentence (untouched in Phase A - spec section 2).
  //   - en_route forks on TOUR TYPE, not address: self_guided vs landlord-led
  //     wording, with pm_team taking the landlord-led entry (spec 9.0).
  'tour.confirmation': {
    id: 'tour.confirmation',
    default: 'Hey, your tour is set for {when} at {where}.',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [...TOUR_NAME_VARS, 'where'],
  },
  // The one surviving twin, and the one place {where} is still load-bearing:
  // it sits MID-sentence, so the addressless case needs its own copy rather
  // than a computed clause. Declaring {where} here would reopen the leak the
  // split exists to close (spec 6.5) - do not add it.
  'tour.confirmation_no_address': {
    id: 'tour.confirmation_no_address',
    default: 'Hey, your tour is set for {when}.',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [...TOUR_NAME_VARS],
  },
  'tour.day_before': {
    id: 'tour.day_before',
    default: 'Hey {tenantFirstName}, confirming your tour tomorrow at {time}. Does that still work for you?',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [...TOUR_NAME_VARS, 'where'],
  },
  'tour.morning_of': {
    id: 'tour.morning_of',
    default:
      'Hey {tenantFirstName}, looking forward to having you tour at {time} today. Does that still work for you? {addressLine}',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [...TOUR_NAME_VARS, 'where', 'addressLine'],
  },
  'tour.en_route_self_guided': {
    id: 'tour.en_route_self_guided',
    default: "Hey {tenantFirstName}, can you please text me when you're on the way?",
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [...TOUR_NAME_VARS, 'where'],
  },
  // Also the pm_team wording (spec 9.0): {propertyContactFirstName} resolves
  // to the unit's PRIMARY CONTACT, which is what makes the sentence true for
  // a PM-run tour rather than naming the owner.
  'tour.en_route_landlord_led': {
    id: 'tour.en_route_landlord_led',
    default: "Hey {tenantFirstName}, {propertyContactFirstName} will be headed that way shortly. Can you please text here when you're on the way?",
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [...TOUR_NAME_VARS, 'where'],
  },
  // D2 REVERSED (Sam via Cameron, 2026-08-26): the founder asked for the
  // name here; "vaguer is kinder" was considered and overruled - spec s3.
  'tour.no_show_checkin': {
    id: 'tour.no_show_checkin',
    default: 'Hi {tenantFirstName}! Do you need to reschedule?',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [...TOUR_NAME_VARS],
  },

  // --- Operational: placement nudges (moved out of jobs/placementNudges.ts) ---
  'nudge.receipt_check': {
    id: 'nudge.receipt_check',
    default:
      'Just checking in - did the rental application come through? Let us know if you need it re-sent.',
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
    default: 'Checking in - any decision yet on the application we sent over?',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [],
  },
  'nudge.rta_window_closing': {
    id: 'nudge.rta_window_closing',
    default: 'Hey, can you please share your RTA with me? sam@mail.housingchoice.org',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [],
  },

  // --- Operational: relay group intro ---
  //
  // do-not-remove-without-reading — FOUNDER DECISION, 2026-08-18.
  //
  // These two entries NO LONGER carry "Reply STOP to opt out.". Both are
  // FIRST-CONTACT messages, so that line is the TCPA/CTIA floor for our filed
  // A2P campaign, and engineering advised AGAINST removing it. The founder
  // (Sam, relayed by Cameron 2026-08-18) directed the removal anyway so the
  // group intro reads like a person rather than a compliance notice. Recording
  // the attribution here so a later reader does not mistake it for a developer
  // oversight and does not "helpfully" restore it without asking.
  //
  // FOLLOW-UP FOUNDER DECISION, 2026-08-20: the brand is now gone from
  // relay.intro too, on Sam's explicit instruction (relayed by Cameron). The
  // 2026-08-18 note below claimed the identity half was kept "see
  // relay.identity" - that was already misleading: relay.identity has NO send
  // site anywhere in the app, so this entry's own "with <brand>" was the ONLY
  // thing identifying us on a first-contact text. With it removed, the group
  // intro now carries NEITHER business identity NOR opt-out language, and a
  // stranger's first text from an unknown number no longer says who it is
  // from. Engineering stated that exposure; the founder directed it anyway.
  // Same removal for the housing-authority sentence: updates come from the
  // landlord, not from Sam.
  //
  // Superseded wording, for reference:
  //   relay.intro        `${SMS_BRAND_NAME}. {members} Reply STOP to opt out.`
  //   relay.member_added `${SMS_BRAND_NAME}. {joined} {members} Reply STOP to opt out.`
  //   relay.intro (2026-08-18..2026-08-20)
  //     `Hey, it's Sam with ${SMS_BRAND_NAME}. {members} Use this group text for
  //      anything that comes up - I'll share updates as I get them from the
  //      housing authority. It can be a long process, so ask me anything in here!`
  //
  // PHASE B, 2026-08-31: {members} is GONE, replaced by {names}. {members} was a
  // whole computed SENTENCE (jobs/relayFanOut.ts, the composer now called
  // composeNameList) carrying fixed copy that never varied - copy belongs here,
  // where it is visible, not buried in a composer. {names} is the bare list
  // only ("Alicia,
  // Marcus, and Dana"), built by composeNameList. The SENT TEXT is byte-identical
  // to the pre-change body for every roster except a single nameless member,
  // where the old code restructured the sentence ("You're now connected on this
  // number.") and a token cannot: 9.2's table routes that row to the "1 other
  // person" phrasing instead. {names} is TOTAL - it never returns the empty
  // string - because an unvalued token in a non-editable default THROWS rather
  // than degrading, which would lose an intro after its idempotency claim.
  //
  // "Sam" is hardcoded, accepted by Cameron 2026-08-18 while she is the only
  // person opening groups. Revisit if that changes - the greeting would name
  // the wrong person. TODO(founder-message-template-updates-owed).
  // editable:false is NOT a demotion - it is this entry finally telling the
  // truth (2026-08-20, relay-intro-editable-but-never-overridden). Three things
  // all have to exist for an operator override to reach a send, and for the two
  // relay entries NONE of them do: OrgSettings has no field to store one,
  // settingsToOverrides maps only welcomeText + missedCallAutoText, and
  // composeIntroBody calls resolveMessage with no overrides argument at all.
  // Marked editable:true it advertised a capability nothing in the system could
  // honor, and - worse - the day someone adds the generic messageOverrides map
  // to settingsToOverrides, this entry would go on being ignored silently,
  // because the missing overrides argument in composeIntroBody is a SECOND
  // break. Flipping the flag makes that impossible to reintroduce by accident:
  // wiring the override means changing this line, and changing this line means
  // reading this comment. Wiring it for real is a separate, still-wanted piece
  // of work - the founder does want to edit this copy herself.
  'relay.intro': {
    id: 'relay.intro',
    default:
      "Hey, it's Sam. You're now connected with {names} on this number. Reply here and " +
      'everyone in the group sees it. Use this group text for anything that comes up. It ' +
      'can be a long process, so ask me anything in here!',
    class: 'operational',
    editable: false,
    channel: 'sms',
    vars: ['names'],
  },
  // --- Operational: relay group intro, OWNER-ROUTED variants ---
  //
  // do-not-remove-without-reading - FOUNDER WORDING, Sam 2026-08-24, authorised
  // by Cameron 2026-08-31 (Phase B spec 9.1). Byte-exact from her text; the
  // three entries below are hers, not a paraphrase.
  //
  // The intro job holds the conversation already, so routing on getOwner(conv)
  // is free. Precedence, highest first: an operator-edited intro_body sends
  // verbatim; then tour; then placement; then the naked entry above. Any missing
  // input (no landlord, no address, no tour time) falls back to the naked intro
  // rather than emptying a clause - both variants use {where} MID-sentence,
  // which is exactly the case the empty-clause trick cannot handle.
  //
  // "on {when}" vs Sam's "at {when}": our {when} renders "Tue, Sep 8 at 3:00 PM",
  // so "at Tue, Sep 8 at 3:00 PM" reads badly. Cameron approved "on" for the
  // dated form (spec 9.1). The TODAY form drops the date entirely and uses
  // {time} - "on Monday, August 31st at 3:00 PM" for a tour later the same day
  // is confusing. There is deliberately NO "tomorrow" variant.
  //
  // "Today" is decided in the SAME timezone the booked-too-late rules use for
  // their same-day test (resolveQuietHoursTimezone), so the two can never
  // disagree.
  //
  // STOP is omitted here for the same logged A2P decision that removed it from
  // relay.intro (changelog 1.2.1 #7). Note these two carry NO sender identity at
  // all - not even the "it's Sam" the naked intro opens with. Engineering stated
  // that exposure (see the 2026-08-20 note above); it goes to the founder as a
  // question rather than being invented here, and until she rules her copy ships
  // as written. TODO(founder-message-template-updates-owed).
  //
  // {where} is declared LAST in every entry per spec 9.3: it is the one value
  // that is not brace-stripped, and with the single-pass interpolate fix that is
  // belt-and-braces rather than load-bearing.
  'relay.intro_tour_today': {
    id: 'relay.intro_tour_today',
    default:
      'Hey {tenantFirstName}! Putting you in a group text with {propertyContactFirstName} ' +
      'to tour {where} at {time}. Looking forward to you seeing the property and meeting ' +
      "{propertyContactFirstName}! Please let us know when you're on the way.",
    class: 'operational',
    editable: false,
    channel: 'sms',
    vars: ['tenantFirstName', 'propertyContactFirstName', 'time', 'where'],
  },
  'relay.intro_tour': {
    id: 'relay.intro_tour',
    default:
      'Hey {tenantFirstName}! Putting you in a group text with {propertyContactFirstName} ' +
      'to tour {where} on {when}. Looking forward to you seeing the property and meeting ' +
      "{propertyContactFirstName}! Please let us know when you're on the way.",
    class: 'operational',
    editable: false,
    channel: 'sms',
    vars: ['tenantFirstName', 'propertyContactFirstName', 'when', 'where'],
  },
  // The housing-authority sentence the 2026-08-20 note above records REMOVING
  // from relay.intro comes back HERE, and that is not drift. The stated
  // rationale for the removal was "updates come from the landlord, not from
  // Sam"; this wording HONOURS it - the updates are attributed to
  // {propertyContactFirstName}, not to Sam. The existing assertion is scoped to
  // relay.intro, which is a different id (spec 9.1, recorded with its date so
  // the next reader of that comment does not file this as drift).
  'relay.intro_placement': {
    id: 'relay.intro_placement',
    default:
      'Hey {tenantFirstName}! Excited to have you move into {where}. Please use this group ' +
      'text for all future communication and {propertyContactFirstName} will share updates ' +
      'as they receive them from the housing authority. This can be a long process so if ' +
      'you have any questions feel free to ask in here! We are committed to the process and ' +
      'are excited to have you move in.',
    class: 'operational',
    editable: false,
    channel: 'sms',
    vars: ['tenantFirstName', 'propertyContactFirstName', 'where'],
  },
  // Member added to an EXISTING group: announced to the WHOLE group. {joined} =
  // "<Name> joined this group chat." and {members} = the connection sentence,
  // both computed in code (jobs/relayFanOut.ts composeMemberAddedBody). The
  // founder's wording also wanted the new member's ROLE ("who is
  // tenant/landlord/property manager"); there is no role token on this job, so
  // it is left out rather than faked. TODO(founder-message-template-updates-owed).
  // editable:false for the same reason as relay.intro above - composeMemberAdded-
  // Body passes no overrides either, and nothing can store one.
  'relay.member_added': {
    id: 'relay.member_added',
    default: 'Hey! {joined} {members}',
    class: 'operational',
    editable: false,
    channel: 'sms',
    vars: ['joined', 'members'],
  },
  // do-not-remove-without-reading - FOUNDER WORDING, Sam 2026-08-24, authorised
  // by Cameron 2026-08-31 (Phase B spec 9.4). This is the role clause the
  // member_added entry above records as OWED ("there is no role token on this
  // job, so it is left out rather than faked") - Phase B supplies it from
  // UnitContact.role, NOT ContactItem.type, which has no property-manager value.
  //
  // It is a SEPARATE entry rather than an empty clause because {role} sits
  // MID-sentence: Phase A spec 6.4's empty-clause trick only works for a
  // trailing sentence. When the role does not resolve, the no-role wording lives
  // on relay.member_added instead.
  //
  // Written and pinned in Task 13; WIRED in Task 14, which also rewrites
  // relay.member_added to the no-role wording and splits the announcement per
  // recipient (the new member gets the naked intro, not this).
  //
  // {name} is the FIRST name and is TOTAL - "a new member" when nothing
  // resolves, lower-cased so it reads mid-sentence, never a phone. An unvalued
  // {name} in a non-editable default THROWS, killing the handler AFTER its
  // idempotency claim, so the announcement would be LOST rather than retried.
  //
  // STOP omitted per the same logged A2P decision (changelog 1.2.1 #7).
  // editable:false for the same reason as the entries above - nothing can store
  // or route an override for a relay entry.
  'relay.member_added_role': {
    id: 'relay.member_added_role',
    default: 'Hey, adding {name} to the group as the {role}.',
    class: 'operational',
    editable: false,
    channel: 'sms',
    vars: ['name', 'role'],
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
  // Final message sent to every member when a relay group is CLOSED (spec 4.5):
  // the group is closed, and texting this number still reaches the team (true
  // under the closed-group->1:1 interception). No tokens. editable:true so an
  // operator can override it via the existing catalog machinery (resolveWith-
  // Settings) - no new override map/UI is built here.
  'relay.group_closed': {
    id: 'relay.group_closed',
    default:
      'This group chat is now closed. You can still text this number and a Housing Choice ' +
      'team member will see your message and follow up.',
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [],
  },

  // --- Compliance-derived, already editable (reference smsCompliance consts) ---
  'welcome.sms': {
    id: 'welcome.sms',
    // WELCOME_SMS carries no {firstName} token; an operator OVERRIDE may still use
    // it (today's renderWelcome convention) — so firstName is a declared, default-
    // unused var (allowed because the entry is editable).
    //
    // TWO USES, ONE OF WHICH THE APP NO LONGER SENDS. As the housing-fair /
    // web-form welcome it is sent by the app exactly as before. As the OPT-IN
    // (START/JOIN/HOME/YES/UNSTOP) confirmation it is sent by Twilio Advanced
    // Opt-Out, console-configured from this default - the app does not send it;
    // see RUNBOOK "Keyword auto-replies (Advanced Opt-Out)". An operator
    // `welcomeText` override therefore reaches the web-form path only; changing
    // the keyword confirmation is a console edit.
    default: WELCOME_SMS,
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: ['firstName'],
    requiresOptOut: true,
  },
  // FOUNDER DECISION 2026-08-18 - no opt-out line. The full rationale and the
  // attribution live on FOUNDER_MISSED_CALL_AUTOTEXT in lib/smsCompliance.ts;
  // `requiresOptOut` is correspondingly gone, which is also what lets an admin
  // save wording like this through PUT /api/settings (routes/settings.ts).
  //
  // HEADS UP - THIS DEFAULT IS UNREACHABLE AT RUNTIME. OrgSettings.missedCallAutoText
  // is a REQUIRED string that falls back to DEFAULT_ORG_SETTINGS, so
  // settingsToOverrides() always produces a `missed_call.autotext` override and
  // the override always wins. The value that actually goes out is
  // DEFAULT_ORG_SETTINGS.missedCallAutoText (repos/settingsRepo.ts) or whatever
  // an admin saved over it. Both are pointed at the same constant so they can
  // never disagree, but edit BOTH or neither. (welcome.sms is NOT like this:
  // welcomeText is optional and clearable, so its catalog default is live.)
  'missed_call.autotext': {
    id: 'missed_call.autotext',
    default: FOUNDER_MISSED_CALL_AUTOTEXT,
    class: 'operational',
    editable: true,
    channel: 'sms',
    vars: [],
  },

  // --- Compliance-locked (never freely editable; reference smsCompliance consts) ---
  //
  // BOTH ENTRIES ARE SENT BY TWILIO ADVANCED OPT-OUT (console-configured from
  // these constants) - the app does not send either one; see RUNBOOK "Keyword
  // auto-replies (Advanced Opt-Out)". They stay here because this catalog is
  // still the SOURCE OF TRUTH the console is configured FROM: the copy is
  // authored, reviewed and version-controlled here, and the RUNBOOK's
  // copy-change procedure is edit-constant -> update-console -> canary.
  // runtime-orphaned by design - the string is the source of truth for the Twilio Advanced Opt-Out console (RUNBOOK 3b); do not prune.
  'keyword.stop': {
    id: 'keyword.stop',
    default: STOP_CONFIRMATION,
    class: 'compliance-locked',
    editable: false,
    channel: 'sms',
    vars: [],
  },
  // runtime-orphaned by design - the string is the source of truth for the Twilio Advanced Opt-Out console (RUNBOOK 3b); do not prune.
  'keyword.optin': {
    id: 'keyword.optin',
    default: OPT_IN_CONFIRMATION,
    class: 'compliance-locked',
    editable: false,
    channel: 'sms',
    vars: [],
  },
  // runtime-orphaned by design - the string is the source of truth for the Twilio Advanced Opt-Out console (RUNBOOK 3b); do not prune.
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
    // Byte-identical to voice.whisper_founder since the press-0 team escape was
    // removed (docs/issues/press-0-team-escape-removed.md). KEEP BOTH IDS: they
    // address different contexts (masked relay leg vs founder bridge) and are
    // independently editable; collapsing them couples two unrelated surfaces.
    id: 'voice.whisper_relay',
    default: 'You have a Housing Choice call from {callerLabel}. Press 1 to accept.',
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
  // FOUNDER VOICE, 2026-08-18 (second pass). The first pass gave FIVE different
  // situations the same sentence; each now says something true about the
  // situation the caller is actually in. The plural "we"/"us" is the founder's
  // own wording and is kept deliberately - it was never the problem.
  //
  // ONE EXCEPTION, do not "unify" it: voice.outbound_unavailable is heard by
  // STAFF, not a tenant (see its own note), so it stays plain and diagnostic
  // like the whispers.
  'voice.greeting_no_holder': {
    id: 'voice.greeting_no_holder',
    default:
      "Hey, sorry we can't get to the phone right now! Please text us your first name, last name and voucher size, and we'll get right back to you. Thanks!",
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: [],
  },
  // Heard ONLY when the business line is dialed from the very number it forwards
  // to - in practice staff calling their own line. Asking that caller to text
  // their voucher size made no sense, so it explains the actual problem.
  'voice.self_call': {
    id: 'voice.self_call',
    default:
      "This line can't connect a call from its own number. Please try from a different phone, or send us a text instead. Goodbye.",
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
  // Heard by a TENANT OR LANDLORD who dialed one of our pool numbers after that
  // thread closed, or after they were taken off it. The old wording was a dead
  // end; texting that same number DOES still reach the team (closed-group ->
  // 1:1 interception), so the caller is handed a route that works. Deliberately
  // avoids "no longer available" - wrong for the removed-member case, where
  // nothing was closed.
  'voice.thread_closed': {
    id: 'voice.thread_closed',
    default:
      "Hey, we can't connect this call, but you can still text this number and we'll get right back to you. Thanks!",
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
  // STAFF-FACING, unlike every other line in this block. It plays on the
  // NAVIGATOR's own leg when they start a call from the dashboard and the target
  // cannot be resolved (routes/webhooks/voice.ts /outbound-bridge). A tenant
  // never hears it, so it names the likely cause and the next action instead of
  // adopting the founder's warm phone voice.
  'voice.outbound_unavailable': {
    id: 'voice.outbound_unavailable',
    default:
      "This call can't be connected - the conversation may no longer be available. Please check the dashboard and try again. Goodbye.",
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: [],
  },
  // A masked/outbound call was missed and NO voicemail is offered, so this has
  // to end the call. Kept short on purpose: the caller is being hung up on, and
  // asking for a full name plus voucher size at that moment is too much.
  'voice.missed_call_goodbye': {
    id: 'voice.missed_call_goodbye',
    default: "Sorry we missed you! Please send us a text and we'll get right back to you. Goodbye.",
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: [],
  },
  // Spoken IMMEDIATELY BEFORE the recording beep, so it must invite a message -
  // that is the entire job of the prompt. It also carries the founder's "text us
  // your name and voucher size" ask and flags texting as the faster route, so
  // both goals are served without dropping the voicemail invitation.
  'voice.voicemail_prompt': {
    id: 'voice.voicemail_prompt',
    default:
      'Hey, sorry we missed your call! Leave a message after the tone, or text us your first name, last name and voucher size for the fastest response.',
    class: 'voice',
    editable: false,
    channel: 'voice',
    vars: [],
  },
  // Plays AFTER the caller has already left their message, so it confirms the
  // voicemail landed. Never re-run the prompt's "leave a message" here, and keep
  // the texting line phrased as an option ("you can always") rather than an
  // instruction - they have already done what was asked.
  'voice.voicemail_thanks': {
    id: 'voice.voicemail_thanks',
    default:
      "Got it, thanks! We'll listen and get back to you soon. You can always text this number too. Goodbye.",
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
