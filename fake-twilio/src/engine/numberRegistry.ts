// fake-twilio/src/engine/numberRegistry.ts
//
// A deterministic registry of provisioned "pool" phone numbers — the fake of
// Twilio's IncomingPhoneNumbers. The app routes masked calls to these pool
// numbers; the CallEngine uses isPool(to) to decide masked vs founder routing.
//
// Numbers are minted from the +1555019xxxx pool (sequential, distinct). The
// `+1555019` prefix matches the spec'd pool range; sequence is deterministic so
// tests never depend on time/random.

/** A provisioned pool number + its recorded webhooks. */
export interface NumberRecord {
  phoneNumber: string;
  sid: string;
  smsUrl?: string;
  voiceUrl?: string;
}

export interface ProvisionOpts {
  /** Optional area-code hint (cosmetic for the deterministic pool; kept for parity
   *  with Twilio's available-numbers search). The pool stays distinct regardless. */
  areaCode?: string;
}

export class NumberRegistry {
  private readonly byNumber = new Map<string, NumberRecord>();
  private seq = 0;

  /** Mint a fresh, distinct pool number + PN sid. */
  provision(_opts: ProvisionOpts = {}): { phoneNumber: string; sid: string } {
    this.seq += 1;
    // +1 555 019 xxxx — 4-digit sequential suffix keeps each call distinct.
    const phoneNumber = `+1555019${String(this.seq).padStart(4, '0')}`;
    const sid = `PNfake${String(this.seq).padStart(8, '0')}`;
    this.byNumber.set(phoneNumber, { phoneNumber, sid });
    return { phoneNumber, sid };
  }

  /** Record/update the SMS/voice webhooks for a provisioned number (partial merge). */
  setWebhooks(number: string, urls: { smsUrl?: string; voiceUrl?: string }): void {
    const existing = this.byNumber.get(number);
    if (!existing) throw new Error(`setWebhooks: ${number} is not a provisioned pool number`);
    if (urls.smsUrl !== undefined) existing.smsUrl = urls.smsUrl;
    if (urls.voiceUrl !== undefined) existing.voiceUrl = urls.voiceUrl;
  }

  get(number: string): NumberRecord | undefined {
    return this.byNumber.get(number);
  }

  list(): NumberRecord[] {
    return [...this.byNumber.values()];
  }

  /** True once `number` has been provisioned from the pool. */
  isPool(number: string): boolean {
    return this.byNumber.has(number);
  }
}
