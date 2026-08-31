import { describe, expect, it } from 'vitest';
import {
  assessNamesReadFailure,
  composeTourReminderBody,
  reminderNamesUsed,
  UncomposableReminderError,
} from '../src/messages/tourCopy.js';
import { MESSAGE_CATALOG } from '../src/messages/catalog.js';
import { TOUR_TYPES } from '../src/lib/toursModel.js';
import type { ReminderKind } from '../src/repos/tourRemindersRepo.js';
import { analyzeSms } from '../src/lib/smsEncoding.js';
import type { Address } from '../src/lib/address.js';

const NY = 'America/New_York';
const AT = '2026-07-23T19:00:00.000Z'; // Jul 23 15:00 EDT -> time "3:00 PM"

const base = { scheduledAt: AT, timezone: NY, tourType: 'self_guided', names: {} } as const;
const NAMES = {
  tenantFirstName: 'Alice', tenantName: 'Alice Rivera',
  propertyContactFirstName: 'Dana', propertyContactName: 'Dana Ortiz',
} as const;

describe('composeTourReminderBody: the founder copy (Sam, 2026-08-24)', () => {
  it('day_before greets by first name and uses the BARE time', () => {
    const body = composeTourReminderBody({ ...base, kind: 'day_before', names: NAMES });
    expect(body).toBe('Hey Alice, confirming your tour tomorrow at 3:00 PM. Does that still work for you?');
    expect(body, 'the date would double up with "tomorrow"').not.toContain('Jul 23');
  });

  it('morning_of carries the address as a trailing sentence', () => {
    expect(composeTourReminderBody({ ...base, kind: 'morning_of', names: NAMES, address: '412 Oak St' }))
      .toBe('Hey Alice, looking forward to having you tour at 3:00 PM today. Does that still work for you? Address is 412 Oak St.');
  });

  it('morning_of with NO address ends cleanly - no trailing "Address is", no {where}, no double space', () => {
    const body = composeTourReminderBody({ ...base, kind: 'morning_of', names: NAMES });
    expect(body).toBe('Hey Alice, looking forward to having you tour at 3:00 PM today. Does that still work for you?');
    expect(body).not.toContain('Address is');
    expect(body).not.toContain('{');
    expect(body).not.toContain('  ');
    expect(body.endsWith(' ')).toBe(false);
  });

  it('en_route forks on TOUR TYPE, and pm_team takes the landlord-led wording', () => {
    expect(composeTourReminderBody({ ...base, kind: 'en_route', names: NAMES }))
      .toBe("Hey Alice, can you please text me when you're on the way?");
    const landlordLed =
      "Hey Alice, Dana will be headed that way shortly. Can you please text here when you're on the way?";
    expect(composeTourReminderBody({ ...base, kind: 'en_route', tourType: 'landlord_led', names: NAMES }))
      .toBe(landlordLed);
    expect(composeTourReminderBody({ ...base, kind: 'en_route', tourType: 'pm_team', names: NAMES }))
      .toBe(landlordLed);
  });

  it('no property-contact name DEGRADES landlord-led AND pm_team to the self-guided wording', () => {
    for (const tourType of ['landlord_led', 'pm_team'] as const) {
      expect(composeTourReminderBody({
        ...base, kind: 'en_route', tourType, names: { tenantFirstName: 'Alice' },
      })).toBe("Hey Alice, can you please text me when you're on the way?");
    }
  });

  it('no tenant first name greets with "there"', () => {
    expect(composeTourReminderBody({ ...base, kind: 'day_before', names: {} }))
      .toBe('Hey there, confirming your tour tomorrow at 3:00 PM. Does that still work for you?');
  });

  it('no_show_checkin greets by name (D2 reversed - ruled, spec section 3)', () => {
    expect(composeTourReminderBody({ ...base, kind: 'no_show_checkin', names: NAMES }))
      .toBe('Hi Alice! Do you need to reschedule?');
    expect(composeTourReminderBody({ ...base, kind: 'no_show_checkin', names: {} }))
      .toBe('Hi there! Do you need to reschedule?');
  });

  it('confirmation is UNTOUCHED in Phase A - old copy, address fork intact', () => {
    expect(composeTourReminderBody({ ...base, kind: 'confirmation', names: NAMES, address: '412 Oak St Apt 2' }))
      .toBe('Hey, your tour is set for Thu, Jul 23 at 3:00 PM at 412 Oak St Apt 2.');
    expect(composeTourReminderBody({ ...base, kind: 'confirmation', names: NAMES }))
      .toBe('Hey, your tour is set for Thu, Jul 23 at 3:00 PM.');
  });
});

describe('address shapes (all through the morning_of clause)', () => {
  const M = 'Hey Alice, looking forward to having you tour at 3:00 PM today. Does that still work for you?';
  it('an all-empty structured address takes the no-address rendering', () => {
    expect(composeTourReminderBody({ ...base, kind: 'morning_of', names: NAMES, address: {} })).toBe(M);
  });
  it('a NULL address composes cleanly instead of throwing (seeds write raw items)', () => {
    // `address: null` is reachable at runtime even though the type says
    // optional: the seeds write unit items with a RAW PutCommand around
    // unitsRepo (which strips nulls). A TypeError here is NOT an
    // UncomposableReminderError, so no caller's containment block would catch it.
    expect(composeTourReminderBody({
      ...base, kind: 'morning_of', names: NAMES, address: null as unknown as Address,
    })).toBe(M);
  });
  it('a structured address contributes street only', () => {
    expect(composeTourReminderBody({
      ...base, kind: 'morning_of', names: NAMES,
      address: { line1: '412 Oak St', line2: 'Apt 2', city: 'Atlanta', state: 'GA', zip: '30312' },
    })).toBe(`${M} Address is 412 Oak St Apt 2.`);
  });
  it('a legacy string address passes through whole', () => {
    expect(composeTourReminderBody({
      ...base, kind: 'morning_of', names: NAMES, address: '350 Boulevard SE, Atlanta, GA 30312',
    })).toBe(`${M} Address is 350 Boulevard SE, Atlanta, GA 30312.`);
  });
});

// Closes docs/issues/tourcopy-messageid-cast-unguarded.md (spec 9.1): every
// reachable input composes, so a kind without a catalog entry can no longer
// fail OPEN into a bare TypeError at runtime. Doubles as the ASCII guard for
// OUR copy in every variant (spec 5 keeps ASCII, drops the segment budget).
describe('EXHAUSTIVE compose matrix', () => {
  const NON_ASCII = /[^\x20-\x7e]/;
  const kinds: ReminderKind[] = ['confirmation', 'day_before', 'morning_of', 'en_route', 'no_show_checkin'];
  it('every kind x {address, none} x tourType x {names, none} composes, ASCII-clean', () => {
    for (const kind of kinds) {
      for (const address of [undefined, '350 Boulevard SE, Atlanta, GA 30312'] as const) {
        for (const tourType of TOUR_TYPES) {
          for (const names of [NAMES, {}] as const) {
            const label = `${kind}/${address === undefined ? 'no-addr' : 'addr'}/${tourType}/${names === NAMES ? 'named' : 'anon'}`;
            let body = '';
            expect(() => {
              body = composeTourReminderBody({
                ...base, kind, tourType, names, ...(address !== undefined && { address }),
              });
            }, label).not.toThrow();
            expect(body.length, label).toBeGreaterThan(0);
            expect(body, label).not.toMatch(NON_ASCII);
            // interpolate() silently ignores a var that is not DECLARED on the
            // entry, so a typo in a var key ("addresLine") would leave the
            // token standing in the body with nothing else catching it.
            expect(body, label).not.toMatch(/\{[A-Za-z]/);
          }
        }
      }
    }
  });
});

describe('token declarations', () => {
  const NAME_VARS = ['tenantFirstName', 'tenantName', 'propertyContactFirstName', 'propertyContactName'];
  it('every tour entry declares all four name tokens plus when/time (spec 6)', () => {
    const tourIds = (Object.keys(MESSAGE_CATALOG) as Array<keyof typeof MESSAGE_CATALOG>)
      .filter((id) => id.startsWith('tour.'));
    expect(tourIds.length).toBe(7); // 2 confirmation + day_before + morning_of + 2 en_route + no_show
    for (const id of tourIds) {
      const vars = MESSAGE_CATALOG[id].vars;
      for (const v of [...NAME_VARS, 'when', 'time']) {
        expect(vars, `${id} must declare {${v}}`).toContain(v);
      }
      // Declaring unused tokens is legal ONLY on editable entries
      // (catalog.test.ts's no-dead-tokens rule) - do not flip this flag.
      expect(MESSAGE_CATALOG[id].editable, `${id} must stay editable`).toBe(true);
      // messageCatalogAscii.test.ts filters on channel !== 'sms', so a tour
      // entry written with the wrong channel escapes BOTH the ASCII and the
      // GSM-7 guard - the two guards spec 5 leans on when it drops the
      // segment rule.
      expect(MESSAGE_CATALOG[id].channel, `${id} must stay an sms entry`).toBe('sms');
    }
  });
  it('the confirmation no-address twin still does NOT declare where (the leak guard)', () => {
    expect(MESSAGE_CATALOG['tour.confirmation_no_address'].vars).not.toContain('where');
    expect(MESSAGE_CATALOG['tour.confirmation'].vars).toContain('where');
  });
  it('morning_of declares BOTH where and addressLine (spec 6.4: where stays for future edits)', () => {
    expect(MESSAGE_CATALOG['tour.morning_of'].vars).toContain('where');
    expect(MESSAGE_CATALOG['tour.morning_of'].vars).toContain('addressLine');
  });
});

// THE COPY-EDIT TRIPWIRE. assessNamesReadFailure is DERIVED from the catalog
// templates, so these pins are how a future "pure string edit" that adds or
// removes a name token announces itself: the derived answer flips, a row here
// goes red, and the failure semantics get re-ruled consciously instead of
// silently desyncing (the drift class spec 6.3a names). Do not re-baseline a
// failing row without re-deriving what the send/preview paths should now do.
describe('assessNamesReadFailure - the derived failure-scope table', () => {
  const ok = { tenantReadFailed: false, propertyReadFailed: false, unitReadFailed: false };
  const NONE = { blocksSend: false, withholdPreview: false };

  it('reminderNamesUsed reads the TEMPLATES: confirmation renders no name, everything else greets the tenant', () => {
    for (const tourType of TOUR_TYPES) {
      expect(reminderNamesUsed('confirmation', tourType))
        .toEqual({ tenantName: false, propertyContact: false });
      expect(reminderNamesUsed('day_before', tourType).tenantName).toBe(true);
      expect(reminderNamesUsed('no_show_checkin', tourType).tenantName).toBe(true);
    }
    expect(reminderNamesUsed('en_route', 'self_guided').propertyContact).toBe(false);
    expect(reminderNamesUsed('en_route', 'landlord_led').propertyContact).toBe(true);
    expect(reminderNamesUsed('en_route', 'pm_team').propertyContact).toBe(true);
  });

  it('confirmation is never blocked - its untouched copy renders no name', () => {
    expect(assessNamesReadFailure({
      kind: 'confirmation', tourType: 'landlord_led',
      tenantReadFailed: true, propertyReadFailed: true, unitReadFailed: true,
    })).toEqual(NONE);
  });

  it('a tenant-read failure BLOCKS THE SEND but does NOT withhold the preview (6.3b: previews degrade to "Hey there,")', () => {
    // EVERY tour type, not just self_guided: en_route's landlord-led entry
    // greets the tenant too, and it is the one template no other row
    // watches - sweeping only self_guided would let a copy edit remove
    // {tenantFirstName} from tour.en_route_landlord_led with zero red (the
    // ninth of nine plausible edits; the other eight trip other rows).
    for (const tourType of TOUR_TYPES) {
      for (const kind of ['day_before', 'morning_of', 'en_route', 'no_show_checkin'] as const) {
        expect(assessNamesReadFailure({
          kind, tourType, ...ok, tenantReadFailed: true,
        }), `${kind}/${tourType}`).toEqual({ blocksSend: true, withholdPreview: false });
      }
    }
  });

  it('a property/unit read failure on the en_route type fork blocks send AND withholds the preview (never a different ENTRY)', () => {
    for (const tourType of ['landlord_led', 'pm_team'] as const) {
      expect(assessNamesReadFailure({
        kind: 'en_route', tourType, ...ok, propertyReadFailed: true,
      })).toEqual({ blocksSend: true, withholdPreview: true });
      expect(assessNamesReadFailure({
        kind: 'en_route', tourType, ...ok, unitReadFailed: true,
      })).toEqual({ blocksSend: true, withholdPreview: true });
      // The name the copy does not use must not block the copy that has none.
      expect(assessNamesReadFailure({
        kind: 'day_before', tourType, ...ok, propertyReadFailed: true,
      })).toEqual(NONE);
    }
    expect(assessNamesReadFailure({
      kind: 'en_route', tourType: 'self_guided', ...ok, propertyReadFailed: true,
    })).toEqual(NONE);
  });

  it('a unit-read failure alone never blocks an address-only rung (never lost over a missing street)', () => {
    expect(assessNamesReadFailure({
      kind: 'morning_of', tourType: 'landlord_led', ...ok, unitReadFailed: true,
    })).toEqual(NONE);
  });

  it('TRIPWIRE: no entry renders the property token without FORKING on it - red here means a copy edit just activated the dead tokenBlanked branch and owes a preview rule (see assessNamesReadFailure)', () => {
    // Pins the invariant that keeps assessNamesReadFailure's second
    // tokenBlanked disjunct structurally dead: wherever the property token
    // is USED, a property failure blocks via the ENTRY FORK (withholdPreview
    // true), never via the blanked-token path (which would let a preview
    // render a blank name mid-sentence - spec 6.3 forbids that). A future
    // entry using the token without forking flips withholdPreview away from
    // used.propertyContact and fails HERE, which is the point.
    const KINDS = ['confirmation', 'day_before', 'morning_of', 'en_route', 'no_show_checkin'] as const;
    for (const tourType of TOUR_TYPES) {
      for (const kind of KINDS) {
        const used = reminderNamesUsed(kind, tourType);
        const impact = assessNamesReadFailure({
          kind, tourType, ...ok, propertyReadFailed: true,
        });
        expect(impact.blocksSend, `${kind}/${tourType} blocksSend`).toBe(used.propertyContact);
        expect(impact.withholdPreview, `${kind}/${tourType} withholdPreview`).toBe(used.propertyContact);
      }
    }
  });
});

describe('the ASCII boundary, pinned from BOTH sides (spec D6)', () => {
  // RENAMED 2026-08-26: the segment assertion that used to sit here is GONE
  // (RULED, spec 5 - there is no business rule that a tour reminder fit one
  // SMS segment), so the title no longer claims one.
  it('OUR copy is ASCII with the seeded address', () => {
    const NON_ASCII = /[^\x20-\x7e]/;
    for (const kind of ['confirmation', 'day_before', 'morning_of', 'en_route'] as const) {
      const body = composeTourReminderBody({
        ...base, kind, address: '350 Boulevard SE, Atlanta, GA 30312',
      });
      expect(body).not.toMatch(NON_ASCII);
    }
  });

  it("THEIR data is NEVER sanitized - a non-ASCII address survives UNCHANGED", () => {
    // This is an anti-regression test against a future "helpful" normalizer.
    // Rewriting a landlord's address is the same category of mistake as stripping
    // the accent from a tenant named Jose. We accept the UCS-2 cost instead.
    const street = "O\u2019Brien Court caf\u00E9";
    const body = composeTourReminderBody({ ...base, kind: 'morning_of', address: street });
    expect(body).toContain(street);
    expect(analyzeSms(body).encoding).toBe('UCS-2');
  });
});

describe('composeTourReminderBody: scheduledAt is a precondition', () => {
  it('throws UncomposableReminderError on an unparseable instant', () => {
    expect(() => composeTourReminderBody({ ...base, kind: 'morning_of', scheduledAt: 'nope' }))
      .toThrow(UncomposableReminderError);
  });

  it('throws UncomposableReminderError on an empty instant', () => {
    expect(() => composeTourReminderBody({ ...base, kind: 'morning_of', scheduledAt: '' }))
      .toThrow(UncomposableReminderError);
  });

  it('the error names the tour-copy origin, not a bare RangeError', () => {
    try {
      composeTourReminderBody({ ...base, kind: 'morning_of', scheduledAt: 'nope' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UncomposableReminderError);
      expect((err as Error).name).toBe('UncomposableReminderError');
    }
  });
});
