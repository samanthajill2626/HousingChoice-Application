// fake-twilio/src/engine/registry.ts
import type { AddAdHocInput, Persona } from './types.js';

/** The app's own business number in the hermetic stack (mirrors OUR_PHONE_NUMBERS). */
export const APP_NUMBER = '+15550009999';

/**
 * Seeded roster — mirrors the phone numbers in app/src/lib/seedData.ts and
 * app/src/lib/seed/cast.ts (source of truth for the data the app itself holds).
 * Kept as a small standalone list so the fake-twilio service stays decoupled from
 * the app package. Drift is caught by app/test/seedPersonaDrift.test.ts.
 */
export const SEEDED_PERSONAS: ReadonlyArray<Persona> = [
  // --- Lean base (original trio — do NOT change phones/ids) ---
  { id: 'seed-tenant', label: 'Tasha Nguyen (tenant)', role: 'tenant', number: '+15550100001', seededRef: 'contact-tenant-0001', adHoc: false },
  { id: 'seed-landlord', label: 'Marcus Bell (landlord)', role: 'landlord', number: '+15550100002', seededRef: 'contact-landlord-0001', adHoc: false },
  { id: 'seed-hastaff', label: 'Renee Carter (HA staff)', role: 'pm', number: '+15550100003', seededRef: 'contact-hastaff-0001', adHoc: false },

  // --- Cast personas (Task 3; phones from +1555010010X block) ---
  // Drivable from the fake-phones UI — each has a seededRef pointing to the cast contact.
  { id: 'cast-unknown-texter', label: 'Alexis Monroe (unknown texter)', role: 'unknown', number: '+15550100101', seededRef: 'contact-cast-unknown-texter', adHoc: false },
  { id: 'cast-mid-intake-tenant', label: 'Destiny Holloway (mid-intake tenant)', role: 'tenant', number: '+15550100102', seededRef: 'contact-cast-mid-intake-tenant', adHoc: false },
  { id: 'cast-parked-norta', label: 'Jamal Okonkwo (parked, no RTA)', role: 'tenant', number: '+15550100103', seededRef: 'contact-cast-parked-norta-tenant', adHoc: false },
  { id: 'cast-searching-tenant', label: 'Monique Everett (searching tenant)', role: 'tenant', number: '+15550100104', seededRef: 'contact-cast-searching-tenant', adHoc: false },
  { id: 'cast-toured-yes', label: 'Brianna Whitfield (toured, move forward)', role: 'tenant', number: '+15550100106', seededRef: 'contact-cast-toured-yes-tenant', adHoc: false },
  { id: 'cast-cold-call-landlord', label: 'Theodore Vinson (cold-call landlord lead)', role: 'landlord', number: '+15550100107', seededRef: 'contact-cast-cold-call-landlord', adHoc: false },
  { id: 'cast-never-signed', label: 'Patricia Shelton (never-signed landlord)', role: 'landlord', number: '+15550100108', seededRef: 'contact-cast-never-signed-landlord', adHoc: false },
  { id: 'cast-parked-landlord', label: 'Raymond Cordova (parked landlord)', role: 'landlord', number: '+15550100109', seededRef: 'contact-cast-parked-landlord', adHoc: false },
  // Note: Constance Merritt (mid-intake-unit-landlord, +15550100110) is NOT drivable —
  // no persona here. Her calls are internal staff workflow, not external-party demo.
];

const AD_HOC_BASE = 199000; // +1555019900X range, distinct from seed +1555010000X

export class PersonaRegistry {
  private readonly byNum = new Map<string, Persona>();
  private adHocSeq = 0;

  constructor() {
    for (const p of SEEDED_PERSONAS) this.byNum.set(p.number, { ...p });
  }

  list(): Persona[] {
    return [...this.byNum.values()];
  }

  byNumber(number: string): Persona | undefined {
    return this.byNum.get(number);
  }

  isAppNumber(number: string): boolean {
    return number === APP_NUMBER;
  }

  addAdHoc(input: AddAdHocInput): Persona {
    let number = input.number;
    if (number === undefined) {
      this.adHocSeq += 1;
      number = `+1555${String(AD_HOC_BASE + this.adHocSeq).padStart(7, '0')}`;
    }
    if (this.byNum.has(number) || number === APP_NUMBER) {
      throw new Error(`addAdHoc: a persona for ${number} already exists`);
    }
    const persona: Persona = { id: `adhoc-${number}`, label: input.label, role: input.role, number, adHoc: true };
    this.byNum.set(number, persona);
    return persona;
  }
}
