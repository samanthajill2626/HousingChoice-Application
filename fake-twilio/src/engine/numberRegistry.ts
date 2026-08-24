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
  /**
   * The Messaging Service this number is attached to as an A2P sender, if any
   * (the post-buy `attachToMessagingService` step). One service per number -
   * that is Twilio's own rule (error 21710 on a duplicate attach).
   */
  messagingServiceSid?: string;
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

  /**
   * Commit a SPECIFIC, app-chosen number into the pool + mint its PN sid (the
   * REST two-step: AvailablePhoneNumbers lists candidates, IncomingPhoneNumbers
   * POST commits the one the app picked). Mirrors Twilio's purchase-by-number.
   * Idempotent: re-committing an already-recorded number returns its record
   * unchanged (a redelivered create never double-mints a sid).
   */
  provisionSpecific(phoneNumber: string): { phoneNumber: string; sid: string } {
    const existing = this.byNumber.get(phoneNumber);
    if (existing) return { phoneNumber: existing.phoneNumber, sid: existing.sid };
    this.seq += 1;
    const sid = `PNfake${String(this.seq).padStart(8, '0')}`;
    this.byNumber.set(phoneNumber, { phoneNumber, sid });
    return { phoneNumber, sid };
  }

  /** Look up a recorded pool number by its PN sid (the update-by-sid path). */
  getBySid(sid: string): NumberRecord | undefined {
    for (const rec of this.byNumber.values()) {
      if (rec.sid === sid) return rec;
    }
    return undefined;
  }

  /** Record/update the SMS/voice webhooks for a provisioned number (partial merge). */
  setWebhooks(number: string, urls: { smsUrl?: string; voiceUrl?: string }): void {
    const existing = this.byNumber.get(number);
    if (!existing) throw new Error(`setWebhooks: ${number} is not a provisioned pool number`);
    if (urls.smsUrl !== undefined) existing.smsUrl = urls.smsUrl;
    if (urls.voiceUrl !== undefined) existing.voiceUrl = urls.voiceUrl;
  }

  /**
   * Attach a purchased number to a Messaging Service as an A2P sender - the
   * fake of `messaging.v1.services(svc).phoneNumbers.create(...)`, the step
   * `warmOneNumber` finishes every buy with. Until 2026-08-23 this endpoint
   * did not exist, so every hermetic warm buy died post-purchase with a
   * swallowed 404 job failure (docs/issues/fake-twilio-messaging-attach-404.md).
   *
   * Outcomes mirror the real service's contract, because the adapter branches
   * on them: 'already' maps to Twilio error 21710, which
   * attachToMessagingService treats as idempotent success.
   */
  attachToMessagingService(
    serviceSid: string,
    phoneNumberSid: string,
  ): { outcome: 'attached' | 'already' | 'unknown_sid'; record?: NumberRecord } {
    const record = this.getBySid(phoneNumberSid);
    if (!record) return { outcome: 'unknown_sid' };
    if (record.messagingServiceSid !== undefined) return { outcome: 'already', record };
    record.messagingServiceSid = serviceSid;
    return { outcome: 'attached', record };
  }

  /** Detach by PN sid. False when the sid is unknown or not attached to `serviceSid`. */
  detachFromMessagingService(serviceSid: string, phoneNumberSid: string): boolean {
    const record = this.getBySid(phoneNumberSid);
    if (!record || record.messagingServiceSid !== serviceSid) return false;
    delete record.messagingServiceSid;
    return true;
  }

  /** Every number currently attached to `serviceSid` (the detach path's list-by-E.164). */
  listAttachedToMessagingService(serviceSid: string): NumberRecord[] {
    return [...this.byNumber.values()].filter((r) => r.messagingServiceSid === serviceSid);
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
