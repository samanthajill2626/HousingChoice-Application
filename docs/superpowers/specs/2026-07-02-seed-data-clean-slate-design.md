# Seed data, clean slate — story cast + coverage matrix + live showcase

**Date:** 2026-07-02 · **Status:** design (approved in brainstorm; implementation follows)
**Related:** `app/src/lib/seedData.ts` (current seed), `app/src/lib/devReset.ts`,
`app/scripts/db-seed.ts`, `scripts/dev.mjs` (`--seeded`), `fake-twilio/src/engine/registry.ts`
(`SEEDED_PERSONAS`), `app/test/seedData.test.ts` (tripwire), the four sequence-diagram
writeups under `documentation/`.

## 1. Why

The current seed is a rushed minimal sample: 3 contacts, 2 units, 1 placement, 1 conversation
— nothing for tours, reminders, relay groups, broadcasts, listing sends, consent variety,
calls, the triage queue, or most entity states. Now that the sequence diagrams document how
the product is actually used, `npm run dev -- --seeded` should boot a world that (a)
**demonstrates** every flow mid-state and (b) **covers** every entity status so any screen,
filter, and guard can be exercised without hand-building data.

## 2. Decisions (locked in brainstorm)

1. **Keep the pinned trio byte-compatible.** Tasha Nguyen / Marcus Bell / Renee Carter, their
   phones (+1555010000X), `conv-0001`, `placement-0001`, `unit-0001/0002` stay exactly as
   today. The tripwire test, fake-twilio registry, and e2e dependencies on them don't churn.
   Everything new is additive around them.
2. **Breadth ≥2 per state.** Every placement stage (17) ×2 plus `moved_in` ×2 and `lost` ×2
   (distinct reason categories); every unit status ×2 (plus ~6 tourable `available` units);
   every tenant status ×2; every landlord status ×2; every tour status ×2. Multiple personas.
3. **Mixed clock.** A small live-clock showcase is computed relative to NOW at seed time
   (Today board + upcoming tours look alive); everything else uses fixed past dates
   (byte-stable reseeds). The live items are documented as non-byte-stable.
4. **Personas for the story-active cast only** (~10 incl. the trio). Matrix/background
   contacts get real phones but NO fake-twilio persona (dashboard-visible, not drivable).
5. **Hybrid authoring.** Hand-written story cast for narrative quality; deterministic
   generators for the coverage matrix (fixed ID patterns, fixed name pools, no randomness).
6. **Seed profiles (scope guard).** `seedAll(endpoint, profile)` with `'lean'` = exactly
   today's world (the trio + supporting rows, byte-compatible) and `'full'` = lean + cast +
   matrix + live. `npm run dev -- --seeded` seeds **full**; `/__dev/reseed` and the e2e
   session keep seeding **lean** so the hermetic suite's world stays stable. (The e2e suite
   builds its own data per spec; flooding it with ~200 entities and live Today items would
   destabilize count- and state-sensitive specs for no benefit.) Profile selection for
   `db-seed.ts` via `SEED_PROFILE=full` env (set by `dev.mjs --seeded`); default lean.

## 3. Architecture

New `app/src/lib/seed/` module; `seedData.ts` becomes a thin re-export (devReset/db-seed
imports unchanged):

- **`cast.ts`** — the hand-authored story personas: items + threads + calls + consent stamps.
- **`matrix.ts`** — generators: `placementsMatrix()`, `unitsMatrix()`, `tenantsMatrix()`,
  `landlordsMatrix()`, `toursMatrix()`, plus broadcasts/listing-sends/invoices/pool-numbers/
  activity-events/settings builders. Deterministic: IDs like `tenant-mx-onhold-02`; names
  from fixed pools; statuses derived via the REAL `deriveStatuses` for placement-linked rows.
- **`live.ts`** — now-relative showcase; arms reminders by calling the REAL
  `armTourReminders` (never hand-written rows) so dueAts match backend computation and the
  reminders invariant holds by construction.
- **`index.ts`** — `seedAll(endpoint, profile)`: lean = current SEED verbatim; full = lean +
  cast + matrix + live. Also folds the inbound-voice-line holder stamp into `seedAll` (both
  profiles) — today only `/__dev/reseed` stamps it, so a `--seeded` dev boot has no voice
  line until the first reseed; that inconsistency ends here.

## 4. The story cast (full profile; ~7 new personas + the trio)

Each freezes a sequence-diagram snapshot with a real thread. (Names/phones final at
implementation; phones from the +1555010010X block; consent methods, flags, and multi-phone
examples distributed as noted.)

| Persona | Snapshot frozen | Notable state |
|---|---|---|
| Tasha Nguyen (kept) | placing tenant, placement awaiting_inspection | as today |
| Marcus Bell (kept) | active signed landlord, 2 units | as today |
| Renee Carter (kept) | HA staff | as today |
| Unknown texter | triage-queue front door | `unknown`/`needs_review`, one inbound msg in `unknown_1to1`; no consent yet (inbound_text auto-stamp demo pending triage) |
| Mid-intake tenant | tenant-onboarding step 3 | `onboarding`; name/voucherSize/housingAuthority set; pets answered in-thread, evictions/tenure pending; consent `inbound_text` |
| Parked no-RTA tenant | RTA gate = no | `on_hold`, `porting: true`, intake complete in-thread; consent `web_form` (+`consent_version`) |
| Searching tenant | sending-unit loop + timeless tour | `searching`; rich `preferences_notes` from feedback; 2 listing-sends (one "too many stairs" reply); anchors a **`requested` tour** (landlord_led) with masked **group thread** + pool number; consent `inbound_call`; second phone number (multi-phone + pointer row) |
| Toured-exit-YES tenant | tours exit gate | `searching`; tour `toured`, `outcome: move_forward`, `moveForward: true` (convertible); group-thread history incl. reminder sends; consent `verbal_phone` |
| Cold-call landlord lead | landlord-onboarding first touch | `needs_review`, phone only, NO thread (the masked-outbound-call demo target); `voice_opt_out: false` |
| Never-signed landlord | contract limbo | `interested`, `contract_status: 'unsigned'`, scheduling thread |
| Parked landlord | decline w/ reason | `parked`, `park_reason: 'A property manager, not the owner'`; timeline holds a **completed recorded masked call** (recording object seeded in MinIO — §7) |
| Mid-intake unit landlord | property intake loop | landlord `active`/signed; unit `setup` missing `voucher_size_accepted`; MMS photo in-thread (media object in MinIO); Team follow-up outstanding |

Also distributed across cast: one `sms_opt_out` contact, one `sms_unreachable`, one
`voice_opt_out` landlord, one contact with NO consent (blocked-proactive-send demo), the
remaining consent methods (`verbal_in_person`, `paper_form`, `imported`, `client_inbound`)
on matrix rows so all 8 appear at least once.

## 5. The coverage matrix (full profile; generated)

- **Placements:** 17 stages ×2 + `moved_in` ×2 + `lost` ×2 (different `lost_reason`
  categories + free text). Each gets its own generated tenant + unit; tenant/unit statuses
  come from `deriveStatuses(stage)` with `status_source: 'derived'` (the §7 tripwire extends
  over ALL of them). Deadline coverage: every `next_deadline_type` appears ≥1, fixed past
  dates (overdue archive) except the live items (§6). A few placements carry `attention`.
- **Units:** every status ×2 net of placement-derived ones; ~6 `available` tourable units
  spread across authorities (atlanta_housing / ga_dca / dekalb…), bed sizes 1–4, varied
  `tour_process` strings mapping to all three tour types; one `off_market`, two `on_hold`
  (pinned, `status_source: 'manual'`).
- **Tenants / landlords:** every status ×2 net of story+placement coverage; landlord booleans
  (`registered_landlord`, `rta_within_48h`, `pass_inspection_first_try`,
  `income_includes_voucher`) varied; tenants across authorities + voucher sizes.
- **Tours:** all 7 statuses ×2 net of story tours; `no_show` w/ `no_show_checkin` sent;
  `canceled` reschedulable; matrix tours use searching-pool tenants + available units;
  fixed past dates except live (§6). Reminder rows ONLY where the real arm logic would
  create them (invariant test over the whole seed).
- **Conversations/messages:** every 1:1 type incl. a second `unknown_1to1`; ≥2 tour-owned
  `relay_group` threads (backed by seeded **pool_numbers** rows); story threads carry
  realistic message history (~60 messages total incl. call entries: one missed inbound call
  w/ auto-text, one completed recorded outbound).
- **Broadcasts:** one `sent` with results incl. `skipped_no_consent` > 0, one draft.
  **Listing-sends:** the searching tenant's 2 + a couple matrix rows. **Invoices:** existing
  + `draft` + `paid`. **Activity events:** milestones for story placements
  (placement_opened, stage_changed, tour_scheduled). **Settings:** org defaults row
  (welcome text, quick replies, missedCallAutoText, preRingPauseSeconds) so Settings UI
  boots non-empty. **Users:** founder + va kept; add `user-0003` (second VA, `va2@example.com`)
  for assignment-filter demos; founder keeps verified cell + inbound-voice-line, va has NO
  verified cell (the 409 `cell_not_verified` demo).

## 6. The live-clock showcase (full profile; `live.ts`)

Computed from `new Date()` at seed time: a **self-guided tour TODAY** (Today board), a
**landlord-led tour TOMORROW** with group thread + full reminder ladder armed via the real
`armTourReminders`, a **confirmed tour** day-after-tomorrow, one placement with an **overdue
RTA deadline** (needs_you_now), one with a **due follow-up**. ~6 items; documented as
non-byte-stable across reseeds. Everything else in the seed stays fixed-date.

## 7. MinIO niceties (full profile)

One small seeded MMS image + one short call-recording audio object under the standard
`MEDIA_BUCKET` keys referenced by the cast items (mid-intake unit's photo; parked landlord's
call `recording_s3_key`) so media rendering + playback demo out of the box. Seeded by the
seed module via the existing media-store client; skipped gracefully if MinIO is absent.

## 8. Lockstep + tests

- **fake-twilio `SEEDED_PERSONAS`** gains the ~7 new cast personas (label/role/number/
  `seededRef`) — registry stays deliberately decoupled; a new **drift-alarm test** asserts
  the app cast's phones ⊆ registry numbers and vice-versa for `seededRef`-bearing entries
  (same pinned-tables pattern as the phone lib).
- **`seedData.test.ts` extensions:** matrix coverage (every stage/status ≥2 per entity
  dimension), §7 derivation over ALL placements, reminders invariant over ALL seeded tours
  (rows ⇢ only scheduled/confirmed), exactly-one-primary on every multi-phone contact,
  phone-pointer rows present, profile contract (lean output byte-equals today's SEED for
  the pinned trio + supporting rows).
- Existing tripwires keep passing unchanged (trio untouched).

## 9. Out of scope

- Changing the e2e suite's world (lean profile preserves it exactly).
- Seeding deployed AWS environments (dev.mjs live mode still never seeds).
- A seed-data admin UI; localization of copy; photo-realistic media assets.
