# Phase 1 — Change Order 3 (paste into the build agent mid-flight)

**Scope:** stand up the production/dev **custom domains + TLS** in front of the existing CloudFront distributions, retiring the random `*.cloudfront.net` hostnames as the canonical surface. This resolves the architecture doc's §13 open question ("where does DNS for the domain live?") and closes the Phase 0 ⚠️ carry-over (`PHASE0_EXIT.md`: "ACM/custom domain NOT done"). **Integrate, do not restart** — audit what's deployed first, then add the cert + alias + DNS layer and re-point the things that reference the hostname.

## Settled decisions (operator-confirmed — do not re-litigate)

- **Domains:** production = `app.housingchoice.org`; dev = `dev.app.housingchoice.org`. (Note: prior doc text said `housingchoice.com` — that was a placeholder. The real registered zone is **`housingchoice.org`** on **Namecheap**. Correct every `.com` reference as you touch it.)
- **DNS stays at Namecheap.** The operator has confirmed access and can add CNAME and other records. We are **not** migrating the zone to Route 53 in this change order (that remains a parked nicety in doc §14). Consequence to internalize and document: the **DNS records live outside Terraform** — this is a deliberate, documented deviation from the "everything in IaC / zero drift" principle. The **ACM certificate and the CloudFront alias/cert wiring ARE in Terraform**, per stack; only the DNS records (ACM validation CNAMEs + the app CNAMEs) are hand-entered in Namecheap.
- **One cert + one alias per environment**, owned by that env's existing stack (`hc-dev-` → dev distro `d2w86qra2rq9iz`, `hc-prod-` → prod distro `d3v3fqgxdcoxv9`). ACM certs for CloudFront **must be in us-east-1** — you already are.
- **Apex and `www` are out of scope.** Only the two subdomains above. (Subdomains mean plain CNAMEs work everywhere — no apex ALIAS/ANAME problem.)

## Architecture to produce

1. **ACM (Terraform, per stack).** `aws_acm_certificate` (DNS validation) for the stack's hostname, in us-east-1. Because DNS is in Namecheap (not Route 53), Terraform **cannot** auto-create the validation records — so do **not** rely on `aws_acm_certificate_validation` racing against a Route 53 record resource. Architect the apply as a **staged flow**: (a) apply creates the cert in `PENDING_VALIDATION` and **exposes the validation `name`/`type`/`value` as Terraform outputs**; (b) operator enters those CNAMEs in Namecheap; (c) a follow-up apply (with `aws_acm_certificate_validation` gating downstream resources) completes once ACM sees the records. Decide and document whether you keep the validation resource behind a flag/`-target` or split it into a second apply — either is fine; it must not deadlock on first apply.
2. **CloudFront (Terraform, per stack).** Add the hostname as an **Alternate Domain Name (CNAME/alias)** on the existing distribution and attach the validated cert; SNI-only, **minimum TLS 1.2**. Everything else about the distribution is unchanged — the origin-secret header, `/api/*` + `/webhooks/*` uncached behaviors, and the locked middleware chain do not care about the Host header.
3. **DNS records in Namecheap (manual, operator-entered).** Two kinds: the ACM **validation CNAME(s)**, and the **app CNAME** (`app` / `dev.app` → the distribution domain). Give the operator the exact host/value pairs as copy-paste blocks (see walk-through). **Hard ordering rule to prevent an outage/TLS error window:** the app CNAME that points the hostname at CloudFront must be cut **only after** the cert is issued **and** attached as an alias on the distribution — pointing the hostname first yields CloudFront 403 / cert-mismatch for live users.
4. **Canonical URL config.** Introduce a per-env canonical base-URL Parameter Store value (e.g. `/hc/<env>/app_base_url` = `https://app.housingchoice.org`). All absolute-URL generation (OAuth callback, PWA `start_url`/manifest, public flyer + housing-fair links, web-push endpoints, any email links) reads it. No hardcoded `*.cloudfront.net`.

## What must move to the new hostname (the "what breaks if you forget" list)

- **Google OAuth redirect URIs (M1.3).** Add the new-domain callback URIs in the Google Cloud console **alongside** the existing CloudFront ones — do not remove the old ones until cutover is verified. Update the stored config to use the canonical URL.
- **Twilio webhooks (M1.0 / M1.11).** Dev SMS/voice/status webhooks can move to `https://dev.app.housingchoice.org/webhooks/...` now; **production webhook re-point stays bundled with the M1.11 Quo-number cutover** (re-point once, against the ported number, to avoid a double move). HMAC verification is host-agnostic — confirm signatures still validate through the new host.
- **PWA origin + web push (M1.4) — real gotcha.** Web-push subscriptions and the installed PWA are **origin-scoped**. Moving the dev origin from `d2w86qra2rq9iz.cloudfront.net` to `dev.app.housingchoice.org` **invalidates the dev push subscriptions created in M1.4** and the installed PWA is a different origin. Plan for the team to **re-install the PWA on the new domain and re-grant push**; production push is set up directly on `app.housingchoice.org`. Call this out in the RUNBOOK and the live-test checklist.
- **Session cookies.** If cookies are host-bound to the CloudFront host, the domain change forces re-login (acceptable). If a cookie `Domain` is set explicitly, update it to the new host. Keep `Secure`/`HttpOnly`/`SameSite` as-is.
- **Public links (M1.5).** Per-unit flyer URLs and the housing-fair form URL must generate on the new domain via the canonical-URL config.

## Manual steps — 🖐 walk me through these one at a time, waiting for confirmation between each

1. **Dev cert request:** run the staged `npm run plan`/`apply` for the dev stack to create the dev ACM cert; print the validation CNAME(s).
2. **Namecheap validation record (dev):** give me the exact Namecheap **Advanced DNS** row — Host and Value. ⚠️ **Namecheap auto-appends the base domain**, so strip the trailing `.housingchoice.org.` from the ACM-provided name: e.g. ACM name `_abc123.dev.app.housingchoice.org.` → Namecheap **Host = `_abc123.dev.app`**, Type = CNAME, Value = the `…acm-validations.aws.` target. **Leave this record in place permanently** — ACM reuses it for auto-renewal.
3. **Confirm issuance**, then apply the CloudFront alias + cert attach for dev.
4. **Namecheap app CNAME (dev):** Host = `dev.app`, Value = `d2w86qra2rq9iz.cloudfront.net` (low TTL while we test). Verify `https://dev.app.housingchoice.org/health` → 200 and the cert chain is the new ACM cert.
5. **Re-point dev** OAuth redirect URIs + Twilio dev webhooks to the dev domain; re-install the dev PWA and re-grant push; smoke-test login, an inbound text, and a push end-to-end.
6. **Repeat 1–4 for production** (`app.housingchoice.org` → `d3v3fqgxdcoxv9.cloudfront.net`). Hold the production OAuth/Twilio/PWA cutover to coincide with **M1.11** (ported number) unless I say otherwise.

## Tests / verification to add

- TLS handshake + correct cert (CN/SAN) on both hostnames; HTTP→HTTPS as configured; min TLS 1.2 enforced.
- CloudFront serves the alias only when listed (request with an unconfigured Host does not get served).
- `/health` 200 through each new hostname; origin still reachable only via the secret-header CloudFront path (direct-to-EC2 still fails).
- OAuth login completes on the new domain; Twilio webhook signature verifies via the new host.
- Push: subscribe on the new origin and receive a test push; assert old-origin subscriptions are gracefully handled (no crash on stale endpoints).
- Public flyer/form links render with the canonical domain.

## Documentation to update (in the same change as the code)

- **Architecture doc** (bump **v2.18 → v2.19**, dated decision note in the version line): resolve §13 from an open question to a recorded decision (DNS at Namecheap, subdomains `app`/`dev.app` on `housingchoice.org`, ACM us-east-1 DNS-validated, manual validation records, Route 53 migration parked in §14); add the custom-domain/TLS design to the IaC/delivery section (§8) and fix every `housingchoice.com` → `housingchoice.org`.
- **`PHASE1_KICKOFF_PROMPT.md`:** add a short **M1.10.5 — Custom domain + TLS** milestone sequenced **before** M1.11, and amend M1.11 so the production OAuth/webhook/PWA re-point explicitly happens on the ported-number cutover.
- **`PHASE0_EXIT.md`:** update the ⚠️ CloudFront/ACM line to "scheduled in Phase 1 via Change Order 3"; remove the inaccurate "tracked in RUNBOOK backlog" claim (there is no such backlog section).
- **`RUNBOOK.md`:** update the CloudFront row in the env table with the friendly hostnames; add a **"Custom domain & TLS"** section (Namecheap record inventory, the validation-record-must-stay note, cert auto-renewal, the PWA-reinstall-on-origin-change behavior, and rollback).
- **`README.md`:** stack line mentions the custom domains; add a **deviations-table row** for "DNS records managed manually in Namecheap, outside Terraform (zone not migrated to Route 53)."

## Process

Audit the live distributions/stacks before writing Terraform. Spawn the **adversarial review agent** on this delta with fresh context (it reads doc §8/§13 itself, checks the apply doesn't deadlock on first run, the no-downtime ordering, and that nothing still hardcodes a `*.cloudfront.net` URL). Then re-review and present both reports at the checkpoint. **Cost:** ≈ $0 — public ACM certs are free, CloudFront alternate domains add no charge, Namecheap DNS is included.

## Unchanged

Everything in `PHASE1_KICKOFF_PROMPT.md`, Change Order 1, and Change Order 2 stands. **A2P approval is still pending** — live-traffic milestones remain gated, and the production Twilio re-point rides with the M1.11 cutover regardless of when the domain is ready.
