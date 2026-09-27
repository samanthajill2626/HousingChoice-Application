// app/src/adapters/messagingErrors.ts
// Errors the messaging adapter throws that other leaves must name without
// importing the adapter (lib/sendOutcome.ts). Keep this file dependency-free.
// adapters/messaging.ts re-exports everything here, so existing importers of
// the adapter module are unaffected.

/**
 * The outbound-SMS kill-switch (A2P) tripped (config.smsSendingEnabled false):
 * the Twilio driver REFUSES to hand a message to Twilio before A2P approval, so
 * a deployed stack can't emit unregistered-A2P traffic (30034) and damage
 * sender reputation. This is the lowest-level BACKSTOP - the send wrapper
 * (services/sendMessage.ts) refuses earlier with a SendRefusedError so the
 * common paths degrade gracefully; this guards any direct-adapter caller.
 *
 * Not to be confused with services/sendMessage.ts's own
 * `SmsSendingDisabledError` (a SendRefusedError subclass): refusals are never
 * classified (spec D3); only THIS adapter-level class is (spec D1).
 */
export class SmsSendingDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
