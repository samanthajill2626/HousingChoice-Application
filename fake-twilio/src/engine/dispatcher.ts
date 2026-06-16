// fake-twilio/src/engine/dispatcher.ts
import { signTwilioWebhook, type WebhookParams } from './signer.js';

export interface WebhookDispatcherDeps {
  /** Where to actually POST (the app's real address). */
  appBaseUrl: string;
  /** The app's PUBLIC_BASE_URL — used to compute the signed URL the app reconstructs. */
  appPublicBaseUrl: string;
  authToken: string;
  /**
   * Origin-secret the hermetic app expects in `x-origin-verify` (the Vite proxy
   * injects this in dev). Defaults to the dev placeholder when unset.
   */
  originSecret?: string;
}

/**
 * POSTs correctly-signed, form-encoded webhooks to the app. Signs against
 * `${appPublicBaseUrl}${path}` (what the app's signature middleware reconstructs)
 * while POSTing to `${appBaseUrl}${path}` (its real address) — the two may differ
 * in the e2e stack (sign vs deliver).
 */
export class WebhookDispatcher {
  constructor(private readonly deps: WebhookDispatcherDeps) {}

  async post(path: string, params: WebhookParams): Promise<number> {
    const signedUrl = `${this.deps.appPublicBaseUrl}${path}`;
    const signature = signTwilioWebhook({ authToken: this.deps.authToken, url: signedUrl, params });
    const body = new URLSearchParams(params).toString();
    const res = await fetch(`${this.deps.appBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
        // The hermetic app sits behind an origin-secret check; mirror the Vite dev header.
        'x-origin-verify': this.deps.originSecret ?? 'dev-placeholder-not-a-secret',
      },
      body,
      // A hung connection during `e2e:restart` must not block forever (FIX 7).
      signal: AbortSignal.timeout(5000),
    });
    return res.status;
  }
}
