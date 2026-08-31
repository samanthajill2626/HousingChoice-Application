// The ONE composer for tour reminder bodies.
//
// WHY THIS EXISTS: there are six places that need a rung's text - the poll's 1:1
// and group sends, the human force-send, both tour-reminder route surfaces, and
// the contact timeline's Upcoming bucket. Three of those are PREVIEWS the staff
// read as "this is what will be sent". If any of them built the string
// differently the dashboard would be lying, so every one of them calls this
// function and nothing else (enforced by app/test/tourCopyCallSites.test.ts).
//
// Pure: no repos, no clock, no I/O. Callers supply the instant, the zone, the
// address, the tour type and the already-RESOLVED names (spec 6.3a) - name
// resolution is async and lives in lib/tourContacts.ts, which every caller
// runs BEFORE composing.
//
// IMPORT LAYERING: the Playwright harness value-imports this module
// (e2e/scenarios/steps.ts), so it must stay free of AWS-SDK value imports.
// lib/tourContacts.ts value-imports repos/unitsRepo.js and therefore the SDK -
// import ONLY its TYPE here, and re-export that type (below) so downstream
// consumers never have to reach for the module itself. For the same reason,
// never point this file at messages/index.js: that barrel value-exports
// resolveWithSettings, which pulls the settings repo and the SDK with it.
//
// PARTIAL BY DESIGN: this function THROWS UncomposableReminderError when
// scheduledAt is unusable. {when} and {time} sit mid-sentence and have no
// graceful empty shape, so there is nothing to degrade to HERE. Every caller is
// required to contain it - send paths claim-skip the rung with
// 'invalid_schedule', read paths fall back to body: '' - because an uncontained
// throw means either a 500 on a read path or an unclaimed row retried every poll
// forever. See the spec's section 5 and W6/W7.
import type { Address } from '../lib/address.js';
import { formatStreet } from '../lib/address.js';
import { formatLocalDate, formatLocalTime } from '../lib/localTime.js';
import type { MessageId } from './catalog.js';
import { MESSAGE_CATALOG } from './catalog.js';
import { resolveMessage } from './resolve.js';
import type { ReminderKind } from '../repos/tourRemindersRepo.js';
import type { TourContactNames } from '../lib/tourContacts.js';
import type { TourType } from '../lib/toursModel.js';

/** Thrown when a rung's scheduledAt cannot produce a time. Callers MUST catch. */
export class UncomposableReminderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UncomposableReminderError';
  }
}

/** Re-exported so the harness and the test helpers import BOTH names from the
 *  composer. `export type` is erased at runtime, so the e2e bundle stays
 *  AWS-free (a plain re-export would not be). */
export type { TourContactNames } from '../lib/tourContacts.js';

export interface ComposeTourReminderInput {
  kind: ReminderKind;
  /** REQUIRED even though TourItem.scheduledAt is optional: a reminder row cannot
   *  exist for a time-less tour (armTourReminders returns early without one, and
   *  PATCH cannot clear it), so every caller has one in hand. */
  scheduledAt: string;
  /** IANA zone. Resolve it via resolveQuietHoursTimezone - never read
   *  settings.timezone directly (spec D8). */
  timezone: string;
  /** REQUIRED, no default: a defaulted tourType would silently give a
   *  landlord-led tour the self-guided wording at any call site that forgot
   *  it (spec 9.0). */
  tourType: TourType;
  /** REQUIRED (may be {}): resolved by the CALLER via
   *  lib/tourContacts.ts - this composer stays pure and synchronous (spec
   *  6.3a). Absent fields compose the fallbacks (spec 6.3). */
  names: TourContactNames;
  address?: Address | string;
  overrides?: Partial<Record<MessageId, string>>;
}

export function composeTourReminderBody(input: ComposeTourReminderInput): string {
  const { kind, scheduledAt, timezone, tourType, names, address, overrides } = input;

  // Fallbacks (spec 6.3): a missing tenant first name greets "there"; the
  // property-contact tokens fall back to '' but are never RENDERED blank -
  // idFor() degrades to the self-guided entry before that could happen.
  const nameVars = {
    tenantFirstName: names.tenantFirstName ?? 'there',
    tenantName: names.tenantName ?? names.tenantFirstName ?? 'there',
    propertyContactFirstName: names.propertyContactFirstName ?? '',
    propertyContactName: names.propertyContactName ?? '',
  };

  // no_show_checkin stays ABOVE the scheduledAt validation: it is manual-send
  // only and must compose for past (and even timeless) tours. Its copy now
  // greets by first name (D2 reversed - spec section 3), so it takes the name
  // vars; it uses no time token.
  if (kind === 'no_show_checkin') {
    return resolveMessage('tour.no_show_checkin', nameVars, overrides).trim();
  }

  if (Number.isNaN(new Date(scheduledAt).getTime())) {
    throw new UncomposableReminderError(
      `tour reminder body needs a usable scheduledAt (kind=${kind})`,
    );
  }

  const street = formatStreet(address);
  const date = formatLocalDate(scheduledAt, timezone);
  const time = formatLocalTime(scheduledAt, timezone);
  // The address clause lives in CODE, not the catalog (spec 6.4): street
  // present -> a whole trailing sentence; absent -> the empty string, and the
  // final trim() removes the space the empty clause leaves behind.
  const addressLine = street.length > 0 ? `Address is ${street}.` : '';

  const id = idFor(kind, street.length > 0, nameVars.propertyContactFirstName.length > 0, tourType);

  return resolveMessage(
    id,
    {
      ...nameVars,
      when: `${date} at ${time}`,
      time,
      addressLine,
      ...(street.length > 0 && { where: street }),
    },
    overrides,
  ).trim();
}

/** Exhaustive id selection - replaces the unguarded string cast
 *  (docs/issues/tourcopy-messageid-cast-unguarded.md): the compiler now
 *  fails on a new ReminderKind instead of a bare TypeError escaping every
 *  containment block at runtime. */
function idFor(
  kind: ReminderKind,
  hasStreet: boolean,
  hasPropertyContactFirstName: boolean,
  tourType: TourType,
): MessageId {
  switch (kind) {
    case 'confirmation':
      // UNTOUCHED in Phase A (spec section 2): keeps its address twin because
      // its copy uses {where} MID-sentence. Phase B disposes of both entries.
      return hasStreet ? 'tour.confirmation' : 'tour.confirmation_no_address';
    case 'day_before':
      return 'tour.day_before';
    case 'morning_of':
      return 'tour.morning_of';
    case 'en_route':
      // Branch on === 'self_guided' ONLY - pm_team takes the landlord-led
      // wording (spec 9.0); never enumerate landlord_led alone. No
      // property-contact name DEGRADES to the self-guided entry: "will be
      // headed that way shortly" with a blank name asserts what we cannot
      // back (spec 6.3).
      return tourType === 'self_guided' || !hasPropertyContactFirstName
        ? 'tour.en_route_self_guided'
        : 'tour.en_route_landlord_led';
    case 'no_show_checkin':
      return 'tour.no_show_checkin';
  }
}

/** Which name reads the copy for (kind, tourType) actually RENDERS - derived
 *  from the CATALOG TEMPLATES themselves, never hand-mirrored, so the copy
 *  edit spec section 6 promises is "a pure string edit" can never silently
 *  desync the failure semantics: change a template's tokens and this answer
 *  changes with it (and the pinned truth-table test goes red, forcing the
 *  semantics to be re-ruled consciously).
 *
 *  Inspects the entries idFor would select WHEN NAMES RESOLVE (both address
 *  branches - the landlord-led entry for a non-self_guided en_route, both
 *  twins where an address pair exists), because the question is "did the
 *  failed read corrupt what we MEANT to compose", not what the degraded
 *  fallback would render. DEFAULTS only: no tour.* operator override can
 *  exist in Phase A (settingsToOverrides maps only welcome.sms and
 *  missed_call.autotext - messages/resolve.ts:74-79, and no tour compose
 *  site passes an overrides argument at all).
 *  TODO(tour-reminder-ladder-phase-b): the day a generic override map lands,
 *  widen this to the EFFECTIVE template - ComposeTourReminderInput.overrides
 *  already exists, so activating the hazard is one call-site argument away,
 *  and an override could add a name token the default lacks. */
export function reminderNamesUsed(
  kind: ReminderKind,
  tourType: TourType,
): { tenantName: boolean; propertyContact: boolean } {
  // BOTH address branches, deduped - fully derived, no kind list: for
  // confirmation this yields its two twins automatically, everywhere else it
  // collapses to one id. Never special-case a kind here - "which kinds have
  // address twins" is itself a catalog fact, and hand-listing it inside the
  // function that exists to stop hand-listing catalog facts is how the
  // no-address half of a future twin gets silently skipped.
  const ids = [...new Set([
    idFor(kind, true, true, tourType),
    idFor(kind, false, true, tourType),
  ])];
  const templates = ids.map((id) => MESSAGE_CATALOG[id].default).join(' ');
  return {
    tenantName:
      templates.includes('{tenantFirstName}') || templates.includes('{tenantName}'),
    propertyContact:
      templates.includes('{propertyContactFirstName}') ||
      templates.includes('{propertyContactName}'),
  };
}

/** What a set of failed reads MEANS for one rung (spec 6.3a/6.3b, as ruled
 *  2026-08-26). Two distinct severities, because the two spec sentences
 *  collide in exactly one place:
 *  - blocksSend: the failed read blanks or corrupts something the composed
 *    copy RENDERS, so a send would be a wrong-but-valid message (6.3b) -
 *    the poll defers, force-send and the no-show draft refuse.
 *  - withholdPreview: the failed read would change WHICH ENTRY composes ON
 *    THE NAME AXIS (today, exactly the en_route tour-type fork), so a
 *    preview rendering the degraded entry would show text the send never
 *    produces - 6.3a's "never a different ENTRY". Previews render body: ''
 *    there, and ONLY there: for a mere blanked token (a tenant-read blip on
 *    a day_before) 6.3b's read-path instruction stands unopposed and the
 *    preview degrades to the absence fallbacks ("Hey there,") - a truthful
 *    preview of the copy shape, NOT a blank ladder.
 *  NOTE the ADDRESS axis also flips an entry (confirmation's twins, on
 *  hasStreet, which a failed unit read flips) and is DELIBERATELY exempt:
 *  preview and send degrade the address identically, so no preview/send
 *  divergence can arise, and "a reminder must never be lost over a missing
 *  street" governs. The unit read blocks only where it feeds the property
 *  contact. */
export function assessNamesReadFailure(args: {
  kind: ReminderKind;
  tourType: TourType;
  tenantReadFailed: boolean;
  propertyReadFailed: boolean;
  unitReadFailed: boolean;
}): { blocksSend: boolean; withholdPreview: boolean } {
  const used = reminderNamesUsed(args.kind, args.tourType);
  const propertyReadLost = args.propertyReadFailed || args.unitReadFailed;
  // Does the ENTRY CHOICE itself hinge on the property-contact NAME? Derived
  // structurally from idFor across BOTH address branches, not from token
  // usage - the two coincide today (only the en_route type fork), but they
  // answer different questions and a future entry could use the token
  // without forking on it.
  //
  // THE ADDRESS FORK IS DELIBERATELY EXEMPT: confirmation's idFor branch
  // also flips ENTRY on hasStreet, and a failed unit read does flip it
  // (tour.confirmation vs its twin). That one is never blocked, knowingly -
  // preview and send degrade the address IDENTICALLY, so 6.3a's actual
  // concern (a preview showing text the send never produces) cannot arise,
  // and "a reminder must never be lost over a missing street" governs. Only
  // the NAME axis blocks.
  const forksOnPropertyName =
    idFor(args.kind, true, true, args.tourType) !==
      idFor(args.kind, true, false, args.tourType) ||
    idFor(args.kind, false, true, args.tourType) !==
      idFor(args.kind, false, false, args.tourType);
  const entryCorrupted = forksOnPropertyName && propertyReadLost;
  // The second disjunct below is STRUCTURALLY UNREACHABLE under today's
  // catalog: used.propertyContact is true only where forksOnPropertyName is
  // too (the derived-table test's tripwire row pins that invariant). It
  // exists for a future entry that renders the property token WITHOUT
  // forking on it - and if that entry ever ships, note what this code then
  // does: blocksSend goes true while withholdPreview stays false, so the
  // PREVIEW would render a blank name mid-sentence, which spec 6.3 forbids.
  // Whoever creates such an entry owes a preview rule along with it.
  const tokenBlanked =
    (used.tenantName && args.tenantReadFailed) ||
    (used.propertyContact && !forksOnPropertyName && propertyReadLost);
  return {
    blocksSend: entryCorrupted || tokenBlanked,
    withholdPreview: entryCorrupted,
  };
}
