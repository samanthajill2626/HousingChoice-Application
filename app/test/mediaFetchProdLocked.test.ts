import { describe, expect, it } from 'vitest';
import { TwilioMessagingDriver } from '../src/adapters/messaging.js';

// Production shape: config.twilioApiBaseUrl is REJECTED in prod, so the driver
// is constructed with NO apiBaseUrl. The media-fetch guard must then stay locked
// to https://api.twilio.com — a forged non-Twilio host is refused with the
// `host_not_allowed` reason specifically (not merely a message match).
function driver(apiBaseUrl?: string) {
  return new TwilioMessagingDriver({
    accountSid: 'ACx', apiKeySid: 'SKx', apiKeySecret: 'secret', messagingServiceSid: 'MGx',
    ...(apiBaseUrl !== undefined && { apiBaseUrl }),
    client: {} as never, // not used for media fetch (raw fetch)
  });
}

describe('media-fetch prod-locked (no apiBaseUrl)', () => {
  it('refuses a non-api.twilio.com host with reason host_not_allowed', async () => {
    // MediaFetchRefusedError exposes the code under `reason`, not `code`.
    await expect(driver(undefined).getRecordingStream('http://evil.example/x.mp3'))
      .rejects.toMatchObject({ reason: 'host_not_allowed' });
  });
});
