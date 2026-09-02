# Task 13 focused regression finding

## Failing focused test

`app/test/relayFanOut.test.ts` failed in the planned 12-file regression bundle and
again in isolation. Its persisted `relay.intro` opted-out recipient expectation
listed only delivery status and suppression code, but versioned persisted
announcements now correctly retain requested `sms` intent and excluded aggregation
state. The received value was:

```ts
{
  status: 'failed',
  errorCode: 'contact_opted_out',
  requestedTransport: 'sms',
  transportAggregationState: 'excluded',
}
```

This is a stale exact-object test contract, not a source behavior defect.
