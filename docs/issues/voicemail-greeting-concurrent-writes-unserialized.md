---
id: voicemail-greeting-concurrent-writes-unserialized
title: Voicemail greeting - concurrent upload/remove writes are not serialized (accepted by spec 4.3; two hardening options recorded)
type: improvement
severity: low
status: deferred
area: app/voice
created: 2026-09-27
refs: app/src/routes/settings.ts:369, app/src/routes/settings.ts:414, app/src/routes/settings.ts:445, app/src/middleware/rateLimit.ts:19, docs/superpowers/specs/2026-09-26-voicemail-greeting-design.md
---

**Problem.** The greeting's two write routes touch the same fixed media key
and the same settings map with no coordination between requests:

- upload (`PUT /api/settings/voicemail-greeting`): `mediaStore.put` of the
  fixed key (`settings.ts:369`), then the record SET (`settings.ts:414`);
- remove (`DELETE`): the record REMOVE (`settings.ts:445`), then a
  best-effort `deleteObject` of the fixed key.

Two admin writes that land inside one put-to-record or remove-to-delete
window leave a persistent inconsistent state, and both admins are told they
succeeded:

1. PUT vs DELETE (put A -> REMOVE record + delete object -> SET record A;
   or DELETE first, REMOVE record -> put A -> SET record A -> delete object): a
   record with NO object. `GET /api/settings` lists greeting A, the audio
   route answers 404, and every missed business-line call logs WARN "voicemail
   greeting object missing" and speaks the built-in prompt - until someone
   re-uploads or removes. The dashboard shows it: the player fails to load and
   the block reads "The greeting file is missing or can't be played. Upload it
   again.", kept visible across a refused Replace since fix wave R1 (FW3).
2. PUT vs PUT (put A -> put B -> record B -> record A): the object holds B's
   bytes and the record A's metadata. Callers hear B while the page shows A's
   name, size and date (and A's `?v=` cache-buster). The next upload repairs it.

Both end states are ACCEPTED by the approved spec, 4.3 "Concurrency (single
org, admin-only, accepted; the end states are named so nobody is
surprised)". Likelihood is low: it takes two admin writes inside one
such window, from two admins or two tabs (one tab's `busy` flag
prevents it). Found by code review round 1 (adversarial finding A1,
CONFIRMED with a probe that paused A's record write until B finished);
ruled accept-by-spec, no code change, in the round 1 adjudications.

**Suggested fix (two hardening options, if this ever matters).**

1. In-process lock: one promise-chain lock in the settings router, held
   across [put + record SET] and across [record REMOVE + deleteObject], so a
   DELETE waits for an in-flight upload and uploads run one at a time. The
   app is explicitly one process (the SINGLE-INSTANCE ASSUMPTION note in
   `middleware/rateLimit.ts`). Costs: a stalled or slow upload holds the lock
   until its request ends - up to Node's default 300 s `requestTimeout` - so
   a Remove (or another upload) blocks behind it unless the lock gets its own
   timeout or refuses while busy; and it silently stops protecting anything
   if the app ever runs more than one instance. Side benefit: it caps the
   in-memory lib-storage buffer at one 5 MiB upload at a time.
2. Pin the record to the object version: store the `VersionId` that the
   upload's PutObject returns in the record, and HEAD / presign / GET that
   version. On the versioned media bucket a later overwrite or delete marker
   can then never desynchronize the record from its bytes (the record always
   plays the bytes it describes; the loser of a race is simply
   last-writer-wins on the record). Multi-instance safe. Costs: an adapter
   change (`put` returns the version; `head` / `presign` / `getStream` take a
   version), a new record field in the projection and its tests, reliance on
   bucket versioning staying on, and an IAM change - a GET or HEAD by version
   needs `s3:GetObjectVersion`, which the EC2 role does not grant today
   (`infra/modules/ec2/main.tf`, statement MediaObjects), and the presigned
   `<Play>` URL is signed with that role.

Either option should land with one interleaving test that pauses the first
request's record write (wrap `putOrgSettings`) until the second finishes.
