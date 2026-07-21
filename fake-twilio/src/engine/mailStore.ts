// fake-twilio/src/engine/mailStore.ts
//
// In-memory store of the outbound emails the fake-SES surface captured, keyed by
// the minted sesMessageId. Mirrors engine/store.ts (ConversationStore): a Map +
// list() + reset(). Test double only - outbound MIME is stored RAW (a string),
// never parsed with a real MIME library (ADJ-10: mailparser is an app-only dep,
// unreachable from this workspace).

/** One captured outbound email. `rawMime` is the full decoded MIME the app POSTed
 *  (the SESv2 Content.Raw.Data, base64-decoded); to/cc/subject/messageIdHeader are
 *  string-scanned from its TOP-LEVEL header block (see mailEngine.recordOutbound). */
export interface StoredEmail {
  sesMessageId: string;
  rawMime: string;
  to: string[];
  cc: string[];
  subject: string;
  messageIdHeader?: string;
  /** ISO timestamp the fake captured the send. */
  receivedAt: string;
  state: 'sent';
}

/** In-memory outbound-email store, keyed by sesMessageId. */
export class MailStore {
  private readonly emails = new Map<string, StoredEmail>();

  add(email: StoredEmail): void {
    this.emails.set(email.sesMessageId, email);
  }

  get(sesMessageId: string): StoredEmail | undefined {
    return this.emails.get(sesMessageId);
  }

  /** All captured emails, NEWEST FIRST (insertion order reversed). */
  list(): StoredEmail[] {
    return [...this.emails.values()].reverse();
  }

  reset(): void {
    this.emails.clear();
  }
}
