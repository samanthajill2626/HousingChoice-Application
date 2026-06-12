# adapters/

Intentional seam — must stay empty in Phase 0. This is where thin wrappers around external systems land in later phases: the Twilio messaging adapter (Phase 1), the EventBridge Scheduler adapter (one-off schedules with `ActionAfterCompletion: DELETE`), SES mail, and the Claude/AI client. Adapters are the only place third-party SDKs are imported; services and jobs depend on the adapter interfaces, never on vendor SDKs directly.
