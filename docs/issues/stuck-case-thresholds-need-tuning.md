---
id: stuck-case-thresholds-need-tuning
title: Per-stage stuck-placement thresholds are engineering defaults; founder should tune them
type: decision
severity: low
status: open
area: app
created: 2026-06-19
refs: app/src/lib/statusModel.ts:STAGE_STUCK_THRESHOLDS
---

**Problem.** `STAGE_STUCK_THRESHOLDS` in `app/src/lib/statusModel.ts` drives the
"stuck too long" follow-up nudges (STATUS-MODEL.md §8 — stuck placements are the
dominant reason placements die). The current per-stage day values
(send_application 3d, awaiting_authority_approval 10d, awaiting_hap_contract
14d, etc.) are **engineering defaults**, not founder-validated SLAs. They were
picked to be plausible, not measured.

**Suggested fix.** The founder should review and tune each per-stage threshold
against real operational experience (how long is "too long" before a navigator
should chase each stage). A future option (STATUS-MODEL.md §9) is to move the
thresholds out of code into a **config record** so non-engineers can retune them
without a deploy — at which point this map becomes the fallback default. Until
then, edit the single map in `statusModel.ts` (the one place all stage knowledge
lives) and the change lands everywhere automatically.
