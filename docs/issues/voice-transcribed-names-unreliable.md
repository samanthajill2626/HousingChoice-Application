---
id: voice-transcribed-names-unreliable
title: Names heard via voice transcription are not trustworthy enough for direct writes
type: decision
severity: medium
status: open
area: app
created: 2026-07-20
refs: app/src/services/extraction/apply.ts, app/src/services/extraction/prompt.ts, app/src/jobs/extraction.ts
---

**Problem (observed live, 2026-07-20).** Voice Intelligence transcribed
Cameron's surname "Abt" as "Apt" - a homophone-class error transcription
makes routinely on proper nouns. The extraction pipeline then treats the
transcript text as ground truth: on an empty contact, firstName/lastName
from a voice utterance are DIRECT-written with an ai provenance stamp and
an Auto badge, exactly like an SMS where the client typed their own name.
A typed name is self-reported spelling; a transcribed name is the ASR
model's guess at spelling. The two do not deserve the same trust.

**Decision needed (Cameron): how to handle name facts whose supporting
content is voice-only.** Options on the table:

1. **Channel-aware demotion at apply (recommended core).** The job already
   tags every utterance with its channel. If a name write (firstName /
   lastName) is supported ONLY by voice utterances in the window, demote
   the direct write to a suggestion (reuse the Layer-3 demotion plumbing,
   new audit reason `voice_name_demoted`). SMS-typed names keep direct
   writes. Deterministic, no model-judgment involved. Requires the model
   to say WHICH channel supported the fact, or a simpler proxy: demote
   name writes whenever the window's newest (post-cursor) content is
   voice-only.
2. **Prompt rule.** Tell the model: names heard on a call are unreliable
   spellings - use op "suggest" (never "write") for firstName/lastName
   sourced from voice lines, and note the uncertainty in the reason.
   Cheap, but trusts model compliance.
3. **Phonetic equivalence guard.** When a proposed name is a near-homophone
   of the existing value (e.g. Metaphone match: Apt ~ Abt), treat it as
   op "none" (same fact, unreliable respelling) instead of a conflict
   suggestion - prevents transcription noise from nagging staff with
   Apt-vs-Abt chips.

Likely shape: 1 + 2 together (deterministic demotion with a prompt rule as
belt), 3 as a follow-up refinement if voice-vs-stored name chips get noisy.

**Scope note.** The same argument applies in principle to housingAuthority
(vocab-constrained, so lower risk) and future email (typed, trustworthy).
Names are the acute case: they are identity-bearing, badge-visible, and
homophone-prone.
