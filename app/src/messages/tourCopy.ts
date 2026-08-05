// The ONE composer for tour reminder bodies.
//
// WHY THIS EXISTS: there are six places that need a rung's text - the poll's 1:1
// and group sends, the human force-send, both tour-reminder route surfaces, and
// the contact timeline's Upcoming bucket. Three of those are PREVIEWS the staff
// read as "this is what will be sent". If any of them built the string
// differently the dashboard would be lying, so every one of them calls this
// function and nothing else (enforced by app/test/tourCopyCallSites.test.ts).
//
// Pure: no repos, no clock, no I/O. Callers supply the instant, the zone and the
// address.
//
// PARTIAL BY DESIGN: this function THROWS UncomposableReminderError when
// scheduledAt is unusable. {when} and {time} sit mid-sentence and have no
// graceful empty shape, so there is nothing to degrade to HERE. Every caller is
// required to contain it - send paths claim-skip the rung with
// 'invalid_schedule', read paths fall back to body: '' - because an uncontained
// throw means either a 500 on a read path or an unclaimed row retried every 60s
// forever. See the spec's section 5 and W6/W7.
import type { Address } from '../lib/address.js';
import { formatStreet } from '../lib/address.js';
import { formatLocalDate, formatLocalTime } from '../lib/localTime.js';
import type { MessageId } from './catalog.js';
import { resolveMessage } from './resolve.js';
import type { ReminderKind } from '../repos/tourRemindersRepo.js';

/** Thrown when a rung's scheduledAt cannot produce a time. Callers MUST catch. */
export class UncomposableReminderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UncomposableReminderError';
  }
}

export interface ComposeTourReminderInput {
  kind: ReminderKind;
  /** REQUIRED even though TourItem.scheduledAt is optional: a reminder row cannot
   *  exist for a time-less tour (armTourReminders returns early without one, and
   *  PATCH cannot clear it), so every caller has one in hand. */
  scheduledAt: string;
  /** IANA zone. Resolve it via resolveQuietHoursTimezone - never read
   *  settings.timezone directly (spec D8). */
  timezone: string;
  address?: Address | string;
  overrides?: Partial<Record<MessageId, string>>;
}

export function composeTourReminderBody(input: ComposeTourReminderInput): string {
  const { kind, scheduledAt, timezone, address, overrides } = input;

  // no_show_checkin is manual-send only and deliberately token-free (spec D2):
  // when you are not certain someone no-showed, vaguer wording is kinder.
  if (kind === 'no_show_checkin') {
    return resolveMessage('tour.no_show_checkin', undefined, overrides);
  }

  if (Number.isNaN(new Date(scheduledAt).getTime())) {
    throw new UncomposableReminderError(
      `tour reminder body needs a usable scheduledAt (kind=${kind})`,
    );
  }

  // Composed but unused until Task 9 flips the catalog templates. Computing them
  // now means Task 9 is a catalog-and-selection change only.
  void formatStreet(address);
  void formatLocalDate(scheduledAt, timezone);
  void formatLocalTime(scheduledAt, timezone);

  return resolveMessage(`tour.${kind}`, undefined, overrides);
}
