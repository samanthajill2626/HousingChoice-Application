// fake-twilio/src/engine/registry.ts
import type { AddAdHocInput, Persona } from './types.js';

/** The app's own business number in the hermetic stack (mirrors OUR_PHONE_NUMBERS). */
export const APP_NUMBER = '+15550009999';

/**
 * Seeded roster — mirrors the phone numbers in app/src/lib/seedData.ts (source of
 * truth for the data the app itself holds). Kept as a small standalone list so the
 * fake-twilio service stays decoupled from the app package.
 */
export const SEEDED_PERSONAS: ReadonlyArray<Persona> = [
  { id: 'seed-tenant', label: 'Tasha Nguyen (tenant)', role: 'tenant', number: '+15550100001', seededRef: 'contact-tenant-0001', adHoc: false },
  { id: 'seed-landlord', label: 'Marcus Bell (landlord)', role: 'landlord', number: '+15550100002', seededRef: 'contact-landlord-0001', adHoc: false },
  { id: 'seed-hastaff', label: 'Renee Carter (HA staff)', role: 'pm', number: '+15550100003', seededRef: 'contact-hastaff-0001', adHoc: false },
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
