# routes/webhooks/

Intentional seam — must stay empty in Phase 0. Inbound webhook routes land here in later phases: Twilio SMS/voice status callbacks (Phase 1) and any other provider callbacks. These routes sit behind the locked middleware chain (correlation ID → redacted logger → CloudFront origin-secret validator → body parsers with raw-body capture, which webhook signature verification depends on) and must hand work off via `jobs.enqueue()` rather than doing it inline.
