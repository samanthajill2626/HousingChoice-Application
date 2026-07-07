# fake-twilio — local Twilio impersonator + fake-phones UI

`@housingchoice/fake-twilio` is a local stand-in for Twilio's REST API and
webhooks. The app's real Twilio driver is pointed at it (never real Twilio), so
messaging and voice flows can be driven end-to-end on a laptop and in the e2e
suite. It ships a **fake-phones web UI** (the seeded personas as little phones)
for interactively sending inbound SMS/MMS and now for driving **relay groups**
(masked group texts).

It runs two ways:

- **Via the dev loop:** `npm run dev -- --local --mock` boots the app + worker +
  dashboard *and* this host on `:8889`, with the app's messaging redirected here
  (`TWILIO_API_BASE_URL=http://localhost:8889`). Add `--seeded` to load the demo
  fixtures. Open the fake phones at **http://localhost:8889**.
- **Standalone:** `npm run start -w @housingchoice/fake-twilio` (honors
  `FAKE_TWILIO_PORT`, `APP_BASE_URL`, `APP_PUBLIC_BASE_URL`, `FAKE_TWILIO_UI_DIST`).

The e2e suite drives the same host through `scripts/e2e-session.mjs`.

## Control surface (selected)

The web UI talks to a small control API on the same port; the useful bits:

- `GET  /control/personas` — the seeded + ad-hoc personas.
- `GET  /control/threads` — app ↔ party 1:1 transcripts.
- `GET  /control/groups` — traffic-inferred **relay groups** (pool number,
  roster, unified transcript, per-recipient delivery). Updates stream live as
  `group.updated` frames on `GET /control/events` (SSE).
- `POST /control/send-as-party` `{ from, to?, body, mediaUrls? }` — impersonate an
  inbound send. Omit `to` (or set the app business number) for a 1:1; set
  `to = <poolNumber>` to text a relay group (this is what triggers the app's real
  fan-out). The fake-phones GroupPanel does exactly this from its member picker.
- `POST /control/reset` — clear threads **and** groups (personas persist).

## Relay groups (masked group texts)

A relay group is a masked thread fronted by a **pool number**: members text the
pool, the app fans each message out to the *other* members from the pool number,
so nobody sees anyone else's real number. The fake **infers** groups purely from
traffic — an outbound leg whose `from` is a pool number (not the business
number), or an inbound `send-as-party` whose `to` is a pool number, creates or
updates the group. There is no static group config in the fake.

Because seeds write straight to DynamoDB, a **seeded** relay group
(`conv-live-relay-group`, pool `+15550160001`, members Diana `+15550170001` /
Gloria `+15550170003`) has never sent any traffic through the fake, so it would
be invisible in the fake phones until its first live message. To fix that, the
app exposes a dev-only replay seam and the dev loop calls it at boot.

### Startup replay (automatic under `--mock --seeded`)

`POST /__dev/relay/replay-intros` (on the app, `:8080`; triple-gated dev-only,
structurally absent in every deployed env) scans the **open** `relay_group`
conversations and, for each one with a pool number **and** a well-formed
participants roster (member objects carrying phones), re-fires the **real**
`relay.intro` job — per-member intro legs sent from the pool number. The fake
sees those legs and infers the group, exactly as if it had been created live.
The response is `{ replayed, skipped }` (cast/matrix seeds with bare-id or empty
rosters, and closed groups, are skipped and counted).

The intro job is a system announcement — it **persists no message rows** — so
replaying it never changes the DB. `scripts/dev.mjs` POSTs this seam **once**,
best-effort, after the app is healthy, whenever you run with **both** `--mock`
and `--seeded` in local mode. A slow or failed boot only logs a warning; it never
tears down the dev loop.

### Re-hydrating after a manual reseed

The replay is deliberately **NOT** wired into `POST /__dev/reseed` — reseed must
stay byte-stable for the e2e outbox assertions. So if you reseed a **running**
stack with the full profile, the seeded relay group won't reappear in the fake
until you re-fire the replay yourself:

```sh
# on a running `npm run dev -- --local --mock --seeded` stack
curl -X POST 'http://localhost:8080/__dev/reseed?profile=full'      # wipe + reseed
curl -X POST 'http://localhost:8080/__dev/relay/replay-intros'      # re-hydrate the fake
```

(You can also just POST `/__dev/relay/replay-intros` on its own at any time to
re-fire the intros — repeat POSTs are safe for the DB, they only add more fake
legs.)

## Manual verification checklist (relay groups)

Drive the interactive relay path once after any change to this area:

1. `npm run dev -- --local --mock --seeded`, then open the fake phones at
   http://localhost:8889 and the dashboard at http://localhost:5174.
2. **Group visible at startup:** the **"Group texts"** section of the fake-phones
   roster rail shows the live group (pool `+15550160001`, 2 members) with no
   manual action — the boot replay populated it.
3. **Reply as a member:** open the group, pick **Diana** in the member picker,
   and send a message from the GroupPanel composer.
4. **Dashboard shows the inbound:** the dashboard's relay-group view shows Diana's
   inbound message.
5. **Fanned leg is badged:** in the fake phones, **Gloria**'s 1:1 thread shows the
   fanned-out leg carrying a small **"via ‹pool number›"** badge (a pool-origin
   message, not business-number traffic).
6. **Team reply collapses:** send a reply to the group from the dashboard; in the
   fake-phones GroupPanel it appears as **one** collapsed group entry with **two**
   per-recipient delivery chips (one per member), not two scattered messages.

## Tests

- `npm run test -w @housingchoice/fake-twilio` — engine + control unit tests.
- `npm run typecheck -w @housingchoice/fake-twilio` — `tsc --noEmit`.
- The fake-phones web UI is a separate workspace
  (`@housingchoice/fake-twilio-web`); run its **build** to typecheck it
  (`npm run build -w @housingchoice/fake-twilio-web`).
- The app-side replay seam is covered by `app/test/devRelayReplay.test.ts`.
