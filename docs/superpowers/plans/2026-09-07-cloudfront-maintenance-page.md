# CloudFront Maintenance Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace CloudFront's default 502/504 document with an independent, branded availability page without changing successful responses or typed 503 failures.

**Architecture:** The existing CloudFront module owns one private S3 bucket, one HTML object, an OAC and an exact read-only behavior. Two custom responses preserve their status and select that object. Terraform renders one template from a static message catalog; local browser proof uses the same Terraform renderer.

**Tech Stack:** Existing Terraform >= 1.15 and locked AWS provider 6.x, Node >= 24, TypeScript, Vitest, Playwright. No new package or app runtime dependency.

**Spec:** W:\tmp\cloudfront-maintenance-page\docs\superpowers\specs\2026-09-05-cloudfront-maintenance-page-design.md (human-approved 2026-09-07, reviewed through R2).

**Worktree:** W:\tmp\cloudfront-maintenance-page
**Branch:** codex/cloudfront-maintenance-page
**Planning base:** 114bf0f6; main f82c149cf8523cbdb2f6d6ff3bdedc6583951ab4.
**Status:** Independently reviewed through R2; final precision correction included. Cameron authorized AUTO build with 15-minute check-ins on 2026-09-07. Implementation may proceed; merge and live activation remain separate actions.

## Global Constraints

- "This feature configures automatic fallback for HTTP 502 and 504."
- "Already-open dashboards keep their existing API error behavior."
- "The action is a normal same-origin link with href `/`, styled as a button."
- "There is no JavaScript, auto-refresh, health polling, form submission, tracking, external font, external stylesheet, or app-served asset dependency."
- "No Node or dashboard build is needed to run Terraform."
- "Keep force_destroy false; no bucket versioning or object-retention subsystem is added for this replaceable static artifact."
- "Do not forward viewer cookies, query strings, Authorization, or the app's origin-request policy to the maintenance origin."
- "Never remap to 200, never change errors to 503, and leave 400/401/403/404/405/500/503 and all other codes and bodies alone."
- "The distribution cannot depend on that policy" is enforced by the resource graph; policy depends on distribution ARN, not conversely.
- Preserve /api/*, /webhooks/*, /auth/*, /public/*, default and /unit-media/* methods, targets, security and caching. No deployment-process, app-service, worker, schema, seed, live configuration, secret or parameter change.
- Catalog text is exactly: brand "HousingChoice"; title "HousingChoice - Temporarily unavailable"; heading "Temporarily unavailable"; body "HousingChoice is temporarily unavailable. Please try again shortly."; action "Try again".
- Object key maintenance/index.html; path /maintenance/index.html; Content-Type text/html; charset=utf-8; Cache-Control no-store, max-age=0; error minimum TTL 0; marker data-hc-maintenance="1".
- All authored text is ASCII. Stage explicit paths only, read bare git status and check MERGE_HEAD before each commit, and include the authoring model's Co-Authored-By trailer.
- Records go to docs/superpowers/reviews/2026-09-05-cloudfront-maintenance-page/ and are committed as produced; logs/rendered previews go to .superpowers/ or .playwright-mcp/. No memory writes are authorized.
- Do not merge, deploy, run live Terraform plan/apply, mutate AWS, change real .env files, delete other work, or induce an outage. Complete the branch and hand it back for human merge/activation.
- Standalone Terraform rendering is now a prerequisite of the new local page tests. The repository already requires Terraform for infrastructure work; fail clearly when it is absent, never skip these tests or replace Terraform with a hand-written renderer.

## Work map and ownership

| Task | Owned files | Deliverable |
| --- | --- | --- |
| S1 | app/src/messages/edgeMaintenance.json; infra/modules/cloudfront/templates/maintenance.html.tftpl; e2e/support/maintenancePage.ts; e2e/support/maintenancePage.test.ts | Canonical copy, self-contained page and actual-template renderer proof |
| S2 | infra/modules/cloudfront/maintenance.tf; infra/modules/cloudfront/main.tf; infra/modules/cloudfront/tests/maintenance.tftest.hcl; scripts/check-maintenance-infra.mjs | Restrictive independent origin, status-preserving mappings, mocked Terraform, six fault probes and both root validations |
| S3 | e2e/tests/dashboard-next/maintenance-page.spec.ts; dashboard/src/api/client.maintenance.test.ts | Browser GET/POST recovery, layout and API failure proof |
| S4 | RUNBOOK.md; e2e/README.md; mission records | Reproducible verification, operator activation/rollback instructions, gates and handback |

S1 precedes S2 and S3. S2 and S3 can be implemented by separate owners only after S1's interface is committed. S4 follows both. Every worker must be told that others may be active and to leave unrelated files alone.

Before any implementation, check live worktree ownership and status. Dependencies are currently absent in this worktree: run npm ci here, not in the shared main checkout. Do not create another worktree. Follow AGENTS.md, documentation/FEATURE-DEVELOPMENT-WORKFLOW.md, documentation/GLOSSARY.md and e2e/README.md.

## Planning feasibility evidence

An isolated, provider-free Terraform console probe on 2026-09-07 exited 0 and rendered escaped HTML from templatefile. Its raw output encoded this document: <h1>A &amp; &lt;B&gt; &quot;Q&quot;</h1>. It needed no init, provider, backend, app process or AWS access. This establishes the renderer mechanism, not the feature or AWS routing.

## S1: Canonical static page and actual-template rendering

**Interfaces:** maintenancePage.ts exports readMaintenanceCopy(): MaintenanceCopy and renderMaintenancePage(copy?: MaintenanceCopy): string. Terraform consumes the same JSON and .tftpl directly; no production code imports this test helper.

- [ ] Write e2e/support/maintenancePage.test.ts first:

```ts
import { describe, expect, it } from 'vitest';
import { readMaintenanceCopy, renderMaintenancePage } from './maintenancePage.js';

describe('maintenance page template', () => {
  it('renders the canonical copy with no executable or app asset dependency', () => {
    const copy = readMaintenanceCopy();
    expect(copy).toEqual({
      brand: 'HousingChoice',
      title: 'HousingChoice - Temporarily unavailable',
      heading: 'Temporarily unavailable',
      body: 'HousingChoice is temporarily unavailable. Please try again shortly.',
      action: 'Try again',
    });
    const html = renderMaintenancePage();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('data-hc-maintenance="1"');
    expect(html).toContain('<h1>Temporarily unavailable</h1>');
    expect(html).toContain(copy.body);
    expect(html).toContain('<p class="brand">' + copy.brand + '</p>');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('href="/"');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<(script|img|iframe|form|link)\b/i);
    expect(html).not.toMatch(/\b(src|srcset|on[a-z]+)\s*=/i);
    expect(html).not.toMatch(/http-equiv=["']refresh/i);
    expect(html).not.toContain('${');
  });

  it('escapes copy as text, including template-looking input', () => {
    const special = '& <script> "quote" \'apostrophe\' ${not_code} %{not_code}';
    const html = renderMaintenancePage({
      ...readMaintenanceCopy(),
      brand: special,
      action: special,
      heading: special,
      body: special,
      title: special,
    });
    expect(html).toContain('&amp; &lt;script&gt; &quot;quote&quot; &#39;apostrophe&#39;');
    expect(html).toContain('${not_code} %{not_code}');
    expect(html).not.toContain('<script>');
    const escaped = '&amp; &lt;script&gt; &quot;quote&quot; &#39;apostrophe&#39; ${not_code} %{not_code}';
    for (const [open, close] of [
      ['<title>', '</title>'], ['<p class="brand">', '</p>'], ['<h1>', '</h1>'],
      ['<p class="message">', '</p>'], ['<a class="action" href="/">', '</a>'],
    ]) {
      expect(html).toContain(open + escaped + close);
    }
  });

  it('rejects missing, additional, non-string, empty or non-ASCII copy', () => {
    const copy = readMaintenanceCopy();
    for (const malformed of [
      { ...copy, heading: '' },
      { ...copy, heading: '   ' },
      { ...copy, heading: 123 },
      { ...copy, heading: '\u00e9' },
      { ...copy, extra: 'not allowed' },
      { body: copy.body },
    ]) {
      expect(() => renderMaintenancePage(malformed as unknown as typeof copy))
        .toThrow(/maintenance copy/);
    }
  });
});
```

- [ ] Run `npm run test -w @housingchoice/e2e -- support/maintenancePage.test.ts`. RED must identify the missing helper/template/copy, not an unrelated infrastructure error. Capture the exit code.
- [ ] Create app/src/messages/edgeMaintenance.json:

```json
{
  "brand": "HousingChoice",
  "title": "HousingChoice - Temporarily unavailable",
  "heading": "Temporarily unavailable",
  "body": "HousingChoice is temporarily unavailable. Please try again shortly.",
  "action": "Try again"
}
```
- [ ] Create e2e/support/maintenancePage.ts:

```ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const templatePath = path.join(repoRoot, 'infra/modules/cloudfront/templates/maintenance.html.tftpl');
const copyPath = path.join(repoRoot, 'app/src/messages/edgeMaintenance.json');
const keys = ['action', 'body', 'brand', 'heading', 'title'] as const;
export type MaintenanceCopy = Record<(typeof keys)[number], string>;

function validateCopy(value: unknown): MaintenanceCopy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid maintenance copy object');
  }
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(keys) ||
      keys.some((key) => typeof record[key] !== 'string' ||
        (record[key] as string).trim().length === 0 ||
        /[^\x20-\x7e]/.test(record[key] as string))) {
    throw new Error('Invalid maintenance copy keys or text');
  }
  return record as MaintenanceCopy;
}

export function readMaintenanceCopy(): MaintenanceCopy {
  return validateCopy(JSON.parse(readFileSync(copyPath, 'utf8')) as unknown);
}

function hclPath(value: string): string {
  return JSON.stringify(value.replaceAll('\\', '/'))
    .replaceAll('${', () => '$${')
    .replaceAll('%{', () => '%%{');
}

export function renderMaintenancePage(copy = readMaintenanceCopy()): string {
  validateCopy(copy);
  const root = path.resolve(tmpdir());
  const scratch = mkdtempSync(path.join(root, 'hc-maintenance-render-'));
  try {
    const inputPath = path.join(scratch, 'copy.json');
    writeFileSync(inputPath, JSON.stringify(copy), 'utf8');
    const expression = 'base64encode(templatefile(' + hclPath(templatePath) +
      ', { copy = jsondecode(file(' + hclPath(inputPath) + ')) }))\n';
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('TF_')),
    );
    const result = spawnSync('terraform', ['console', '-no-color'], {
      cwd: scratch,
      shell: false,
      input: expression,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...env, TF_INPUT: '0', TF_IN_AUTOMATION: '1' },
    });
    if (result.error || result.status !== 0) {
      throw new Error('Terraform maintenance renderer failed; Terraform >=1.15 must be on PATH. ' +
        (result.error?.message ?? result.stderr));
    }
    const encoded: unknown = JSON.parse(result.stdout.trim());
    if (typeof encoded !== 'string') throw new Error('Unexpected Terraform render output');
    return Buffer.from(encoded, 'base64').toString('utf8');
  } finally {
    const resolved = path.resolve(scratch);
    if (path.dirname(resolved) !== root ||
        !path.basename(resolved).startsWith('hc-maintenance-render-')) {
      throw new Error('Refusing maintenance scratch cleanup outside owned temporary directory');
    }
    rmSync(resolved, { recursive: true, force: true });
  }
}
```

- [ ] Create templates/maintenance.html.tftpl. Escaping stays inside the actual Terraform template, so test and production use exactly one escaping implementation:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${replace(replace(replace(replace(replace(copy.title, "&", "&amp;"), "<", "&lt;"), ">", "&gt;"), "\"", "&quot;"), "'", "&#39;")}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      padding: 24px; background: #f7f8fa; color: #1a1d23;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
    }
    main {
      width: 100%; max-width: 480px; padding: 40px 32px;
      background: #ffffff; border: 1px solid #e2e5ea; border-radius: 12px;
      box-shadow: 0 4px 12px rgba(16, 24, 40, 0.06);
      overflow-wrap: anywhere;
    }
    .brand { margin: 0 0 24px; color: #1f6feb; font-size: 1rem; font-weight: 700; }
    h1 { margin: 0 0 12px; font-size: 1.75rem; line-height: 1.2; }
    .message { margin: 0 0 28px; color: #5b6472; }
    .action {
      display: inline-block; padding: 12px 20px; border-radius: 8px;
      background: #1f6feb; color: #ffffff; font-weight: 600;
      text-decoration: none;
    }
    .action:hover { background: #1a5fd0; }
    .action:focus-visible { outline: 3px solid #1a1d23; outline-offset: 4px; }
    @media (max-width: 360px) {
      body { padding: 16px; }
      main { padding: 28px 20px; }
      h1 { font-size: 1.5rem; }
    }
  </style>
</head>
<body>
  <main data-hc-maintenance="1">
    <p class="brand">${replace(replace(replace(replace(replace(copy.brand, "&", "&amp;"), "<", "&lt;"), ">", "&gt;"), "\"", "&quot;"), "'", "&#39;")}</p>
    <h1>${replace(replace(replace(replace(replace(copy.heading, "&", "&amp;"), "<", "&lt;"), ">", "&gt;"), "\"", "&quot;"), "'", "&#39;")}</h1>
    <p class="message">${replace(replace(replace(replace(replace(copy.body, "&", "&amp;"), "<", "&lt;"), ">", "&gt;"), "\"", "&quot;"), "'", "&#39;")}</p>
    <a class="action" href="/">${replace(replace(replace(replace(replace(copy.action, "&", "&amp;"), "<", "&lt;"), ">", "&gt;"), "\"", "&quot;"), "'", "&#39;")}</a>
  </main>
</body>
</html>
```

- [ ] Run the same focused Vitest command, then `npm run typecheck -w @housingchoice/e2e`. GREEN must come from real Terraform templatefile; no mock renderer or skip.
- [ ] Commit the four S1 files, then write/commit the S1 report with RED/GREEN exit codes. No app build or dashboard asset is part of the page.

## S2: Private origin and status-preserving CloudFront mappings

**Interfaces:** Consumes S1's catalog and template. Produces aws_s3_object.maintenance, local.maintenance_path and local.maintenance_origin_id inside the existing CloudFront module. Both environment roots already instantiate that module and need no new variables or app permissions.

- [ ] Create infra/modules/cloudfront/tests/maintenance.tftest.hcl first. These runs use only a mocked provider; "apply" below evaluates Terraform expressions against mocks, never AWS:

```hcl
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_cloudfront_cache_policy" {
    defaults = { id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" }
  }
  mock_data "aws_cloudfront_origin_request_policy" {
    defaults = { id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn                         = "arn:aws:s3:::hc-test-maintenance-123456789012"
      bucket_regional_domain_name = "hc-test-maintenance-123456789012.s3.us-east-1.amazonaws.com"
    }
  }
  mock_resource "aws_cloudfront_distribution" {
    defaults = { arn = "arn:aws:cloudfront::123456789012:distribution/TEST123" }
  }
}

variables {
  name_prefix        = "hc-test-"
  origin_domain_name = "origin.example.test"
  origin_secret      = "test-only-origin-secret"
}

run "maintenance_contract" {
  command = apply

  assert {
    condition = (
      length(aws_cloudfront_distribution.this.custom_error_response) == 2 &&
      toset([for r in aws_cloudfront_distribution.this.custom_error_response : r.error_code]) == toset([502, 504]) &&
      alltrue([for r in aws_cloudfront_distribution.this.custom_error_response :
        r.response_code == r.error_code && r.error_caching_min_ttl == 0 &&
        r.response_page_path == "/maintenance/index.html"
      ])
    )
    error_message = "HC_MAINTENANCE_MAPPINGS: exactly 502 and 504 must keep their status and use the page with zero error TTL."
  }

  assert {
    condition = (
      length([for b in aws_cloudfront_distribution.this.ordered_cache_behavior : b if b.path_pattern == "/maintenance/index.html"]) == 1 &&
      alltrue([for b in aws_cloudfront_distribution.this.ordered_cache_behavior :
        b.target_origin_id == local.maintenance_origin_id &&
        toset(b.allowed_methods) == toset(["GET", "HEAD"]) &&
        toset(b.cached_methods) == toset(["GET", "HEAD"]) &&
        b.viewer_protocol_policy == "redirect-to-https" && b.compress &&
        b.cache_policy_id == data.aws_cloudfront_cache_policy.caching_disabled.id &&
        (b.origin_request_policy_id == null || b.origin_request_policy_id == "") &&
        length(b.forwarded_values) == 0
        if b.path_pattern == "/maintenance/index.html"
      ])
    )
    error_message = "HC_MAINTENANCE_BEHAVIOR: exact path, independent origin, read-only methods, disabled caching and no viewer forwarding required."
  }

  assert {
    condition = alltrue([for o in aws_cloudfront_distribution.this.origin :
      o.domain_name == aws_s3_bucket.maintenance.bucket_regional_domain_name &&
      o.origin_access_control_id == aws_cloudfront_origin_access_control.maintenance.id &&
      length(o.custom_header) == 0 && length(o.custom_origin_config) == 0
      if o.origin_id == local.maintenance_origin_id
    ]) && length([for o in aws_cloudfront_distribution.this.origin : o if o.origin_id == local.maintenance_origin_id]) == 1
    error_message = "HC_MAINTENANCE_ORIGIN: S3 REST origin with its own OAC and no application secret required."
  }

  assert {
    condition = (
      length(jsondecode(aws_s3_bucket_policy.maintenance.policy).Statement) == 1 &&
      jsondecode(aws_s3_bucket_policy.maintenance.policy).Statement[0].Effect == "Allow" &&
      jsondecode(aws_s3_bucket_policy.maintenance.policy).Statement[0].Principal == { Service = "cloudfront.amazonaws.com" } &&
      toset(jsondecode(aws_s3_bucket_policy.maintenance.policy).Statement[0].Action) == toset(["s3:GetObject"]) &&
      toset(jsondecode(aws_s3_bucket_policy.maintenance.policy).Statement[0].Resource) == toset(["${aws_s3_bucket.maintenance.arn}/maintenance/index.html"]) &&
      jsondecode(aws_s3_bucket_policy.maintenance.policy).Statement[0].Condition == {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.this.arn }
      }
    )
    error_message = "HC_MAINTENANCE_POLICY: only this distribution may GetObject on the single maintenance object."
  }

  assert {
    condition = (
      aws_s3_bucket.maintenance.bucket == "hc-test-maintenance-123456789012" &&
      !aws_s3_bucket.maintenance.force_destroy &&
      aws_s3_bucket_public_access_block.maintenance.block_public_acls &&
      aws_s3_bucket_public_access_block.maintenance.block_public_policy &&
      aws_s3_bucket_public_access_block.maintenance.ignore_public_acls &&
      aws_s3_bucket_public_access_block.maintenance.restrict_public_buckets &&
      one(aws_s3_bucket_ownership_controls.maintenance.rule).object_ownership == "BucketOwnerEnforced" &&
      one(one(aws_s3_bucket_server_side_encryption_configuration.maintenance.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256" &&
      aws_cloudfront_origin_access_control.maintenance.origin_access_control_origin_type == "s3" &&
      aws_cloudfront_origin_access_control.maintenance.signing_behavior == "always" &&
      aws_cloudfront_origin_access_control.maintenance.signing_protocol == "sigv4"
    )
    error_message = "HC_MAINTENANCE_PRIVACY: private account-scoped bucket, SSE-S3, owner enforcement and always-signed OAC required."
  }

  assert {
    condition = (
      aws_s3_object.maintenance.key == "maintenance/index.html" &&
      aws_s3_object.maintenance.content_type == "text/html; charset=utf-8" &&
      aws_s3_object.maintenance.cache_control == "no-store, max-age=0" &&
      aws_s3_object.maintenance.source_hash == sha256(local.maintenance_html) &&
      aws_s3_object.maintenance.content == local.maintenance_html &&
      strcontains(local.maintenance_html, "data-hc-maintenance=\"1\"")
    )
    error_message = "HC_MAINTENANCE_OBJECT: exact rendered document, metadata and content hash required."
  }

  assert {
    condition = (
      length(aws_cloudfront_distribution.this.origin) == 2 &&
      length(aws_cloudfront_distribution.this.ordered_cache_behavior) == 5 &&
      alltrue([for b in aws_cloudfront_distribution.this.ordered_cache_behavior :
        b.target_origin_id == local.origin_id &&
        toset(b.allowed_methods) == toset(["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]) &&
        toset(b.cached_methods) == toset(["GET", "HEAD"]) &&
        b.viewer_protocol_policy == "redirect-to-https" && b.compress &&
        b.cache_policy_id == data.aws_cloudfront_cache_policy.caching_disabled.id &&
        b.origin_request_policy_id == data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
        if contains(["/api/*", "/webhooks/*", "/auth/*", "/public/*"], b.path_pattern)
      ]) &&
      toset([for b in aws_cloudfront_distribution.this.ordered_cache_behavior : b.path_pattern]) ==
        toset(["/api/*", "/webhooks/*", "/auth/*", "/public/*", "/maintenance/index.html"]) &&
      aws_cloudfront_distribution.this.default_cache_behavior[0].target_origin_id == local.origin_id &&
      toset(aws_cloudfront_distribution.this.default_cache_behavior[0].allowed_methods) == toset(["GET", "HEAD", "OPTIONS"]) &&
      toset(aws_cloudfront_distribution.this.default_cache_behavior[0].cached_methods) == toset(["GET", "HEAD"]) &&
      aws_cloudfront_distribution.this.default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https" &&
      aws_cloudfront_distribution.this.default_cache_behavior[0].compress &&
      aws_cloudfront_distribution.this.default_cache_behavior[0].cache_policy_id == data.aws_cloudfront_cache_policy.caching_disabled.id &&
      aws_cloudfront_distribution.this.default_cache_behavior[0].origin_request_policy_id == data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id &&
      length([for o in aws_cloudfront_distribution.this.origin : o if o.origin_id == local.origin_id]) == 1 &&
      alltrue([for o in aws_cloudfront_distribution.this.origin :
        o.domain_name == var.origin_domain_name &&
        length(o.custom_header) == 1 &&
        one(o.custom_header).name == "x-origin-verify" &&
        one(o.custom_header).value == var.origin_secret &&
        length(o.custom_origin_config) == 1 &&
        one(o.custom_origin_config).http_port == var.origin_http_port &&
        one(o.custom_origin_config).https_port == 443 &&
        one(o.custom_origin_config).origin_protocol_policy == "http-only" &&
        toset(one(o.custom_origin_config).origin_ssl_protocols) == toset(["TLSv1.2"]) &&
        one(o.custom_origin_config).origin_read_timeout == 30 &&
        one(o.custom_origin_config).origin_keepalive_timeout == 5
        if o.origin_id == local.origin_id
      ])
    )
    error_message = "HC_MAINTENANCE_APP_PARITY: existing app paths and methods must survive."
  }
}

run "media_stays_independent" {
  command = apply
  variables {
    media_origin_domain_name = "media.example.test"
  }
  assert {
    condition = (
      length(aws_cloudfront_distribution.this.origin) == 3 &&
      length(aws_cloudfront_distribution.this.ordered_cache_behavior) == 6 &&
      aws_cloudfront_cache_policy.unit_media[0].min_ttl == 1 &&
      aws_cloudfront_cache_policy.unit_media[0].default_ttl == 604800 &&
      aws_cloudfront_cache_policy.unit_media[0].max_ttl == 604800 &&
      length([for o in aws_cloudfront_distribution.this.origin : o if o.origin_id == local.media_origin_id]) == 1 &&
      alltrue([for o in aws_cloudfront_distribution.this.origin :
        o.domain_name == var.media_origin_domain_name &&
        o.origin_access_control_id == aws_cloudfront_origin_access_control.media[0].id &&
        length(o.custom_header) == 0 && length(o.custom_origin_config) == 0
        if o.origin_id == local.media_origin_id
      ]) &&
      aws_cloudfront_origin_access_control.media[0].origin_access_control_origin_type == "s3" &&
      aws_cloudfront_origin_access_control.media[0].signing_behavior == "always" &&
      aws_cloudfront_origin_access_control.media[0].signing_protocol == "sigv4" &&
      length([for b in aws_cloudfront_distribution.this.ordered_cache_behavior : b if b.path_pattern == "/unit-media/*"]) == 1 &&
      alltrue([for b in aws_cloudfront_distribution.this.ordered_cache_behavior :
        b.target_origin_id == local.media_origin_id &&
        b.cache_policy_id == aws_cloudfront_cache_policy.unit_media[0].id &&
        b.response_headers_policy_id == aws_cloudfront_response_headers_policy.unit_media[0].id &&
        toset(b.allowed_methods) == toset(["GET", "HEAD"]) &&
        toset(b.cached_methods) == toset(["GET", "HEAD"]) &&
        b.viewer_protocol_policy == "redirect-to-https" && b.compress &&
        (b.origin_request_policy_id == null || b.origin_request_policy_id == "")
        if b.path_pattern == "/unit-media/*"
      ])
    )
    error_message = "HC_MAINTENANCE_MEDIA_PARITY: media origin and seven-day read-only caching must survive."
  }
}
```

- [ ] Create scripts/check-maintenance-infra.mjs. It makes disposable configuration mirrors, initializes the locked providers there, validates real HCL, executes mocked module tests, then requires each deliberately broken configuration to fail its named contract. It also compares shared dev/prod composition files and runs backend-disabled init/validate in both copied roots, each with its own lockfile. It never runs tests, plan, apply or provisioners in those environment roots. No live environment root or Terraform state is loaded. Provider initialization can download the already-locked AWS/random providers; it never authenticates to AWS. Optional argument is an existing provider mirror directory containing both locked providers.

```js
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const tempRoot = path.resolve(tmpdir());
const scratch = mkdtempSync(path.join(tempRoot, 'hc-maintenance-infra-'));
const moduleDir = path.join(scratch, 'infra/modules/cloudfront');
const artifactDir = path.join(repo, '.superpowers/maintenance-infra', path.basename(scratch));
mkdirSync(artifactDir, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('TF_') && !key.startsWith('AWS_')));
Object.assign(env, { TF_INPUT: '0', TF_IN_AUTOMATION: '1', AWS_EC2_METADATA_DISABLED: 'true' });
let sequence = 0;

function includeConfig(source) {
  const name = path.basename(source);
  if (name === '.terraform' || name.includes('tfstate')) return false;
  return statSync(source).isDirectory() || /\.(tf|tftpl|hcl|json)$/.test(name);
}

function terraform(label, args, expectedMarker, cwd = moduleDir) {
  const result = spawnSync('terraform', args, {
    cwd, env, shell: false, encoding: 'utf8',
    timeout: 300_000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = result.stdout + result.stderr;
  writeFileSync(path.join(artifactDir, String(++sequence).padStart(2, '0') + '-' + label + '.log'), output, 'utf8');
  if (result.error || result.signal) throw new Error(label + ': ' + (result.error?.message ?? result.signal));
  if (expectedMarker) {
    if (result.status === 0 || !output.includes(expectedMarker) ||
        !output.includes('Test assertion failed')) {
      throw new Error(label + ': expected the named contract assertion to fail; exit=' + result.status);
    }
  } else if (result.status !== 0) {
    throw new Error(label + ': unexpected Terraform exit ' + result.status + '; see ' + artifactDir);
  }
  process.stdout.write(label + ': expected result (Terraform exit ' + result.status + ')\n');
}

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Fault target must occur exactly once: ' + before);
  return source.replace(before, () => after);
}

try {
  cpSync(path.join(repo, 'infra/modules/cloudfront'), moduleDir, {
    recursive: true,
    filter: (source) => path.basename(source) !== '.terraform.lock.hcl' && includeConfig(source),
  });
  const copyDir = path.join(scratch, 'app/src/messages');
  mkdirSync(copyDir, { recursive: true });
  cpSync(path.join(repo, 'app/src/messages/edgeMaintenance.json'), path.join(copyDir, 'edgeMaintenance.json'));
  cpSync(path.join(repo, 'infra/envs/dev/.terraform.lock.hcl'), path.join(moduleDir, '.terraform.lock.hcl'));
  const initArgs = ['init', '-backend=false', '-input=false', '-lockfile=readonly', '-no-color'];
  if (process.argv[2]) {
    const mirror = path.resolve(process.argv[2]);
    if (!existsSync(mirror)) throw new Error('Provider mirror does not exist: ' + mirror);
    initArgs.push('-plugin-dir=' + mirror);
  }
  terraform('init', initArgs);
  terraform('validate', ['validate', '-no-color']);
  const testArgs = ['test', '-no-color', '-filter=tests/maintenance.tftest.hcl'];
  terraform('baseline', testArgs);
  const mainPath = path.join(moduleDir, 'main.tf');
  const maintenancePath = path.join(moduleDir, 'maintenance.tf');
  const main = readFileSync(mainPath, 'utf8');
  const maintenance = readFileSync(maintenancePath, 'utf8');
  const blocks = main.match(/  custom_error_response \{[^{}]*\}/g) ?? [];
  const block504 = blocks.find((block) => /error_code\s*=\s*504\b/.test(block));
  if (!block504) throw new Error('No unique 504 block available for fault tests');
  const defaultBlock = main.match(/  default_cache_behavior \{[^{}]*\}/)?.[0];
  if (!defaultBlock) throw new Error('No default behavior block available for fault tests');
  const mutations = [
    ['missing-504', mainPath, replaceOne(main, block504, ''), 'HC_MAINTENANCE_MAPPINGS'],
    ['extra-503', mainPath, replaceOne(main, block504, block504 + '\n' + block504.replaceAll('504', '503')), 'HC_MAINTENANCE_MAPPINGS'],
    ['false-success', mainPath, replaceOne(main, block504, block504.replace(/response_code\s*=\s*504\b/, 'response_code = 200')), 'HC_MAINTENANCE_MAPPINGS'],
    ['wide-s3-read', maintenancePath, replaceOne(maintenance,
      '"${aws_s3_bucket.maintenance.arn}/${aws_s3_object.maintenance.key}"',
      '"${aws_s3_bucket.maintenance.arn}/*"'), 'HC_MAINTENANCE_POLICY'],
    ['media-oac-removed', mainPath, replaceOne(main,
      'aws_cloudfront_origin_access_control.media[0].id', 'null'), 'HC_MAINTENANCE_MEDIA_PARITY'],
    ['default-forwarding-removed', mainPath, replaceOne(main, defaultBlock,
      replaceOne(defaultBlock, 'data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id', 'null')),
      'HC_MAINTENANCE_APP_PARITY'],
  ];
  for (const [label, target, changed, marker] of mutations) {
    writeFileSync(mainPath, main, 'utf8');
    writeFileSync(maintenancePath, maintenance, 'utf8');
    writeFileSync(target, changed, 'utf8');
    terraform(label, testArgs, marker);
  }
  writeFileSync(mainPath, main, 'utf8');
  writeFileSync(maintenancePath, maintenance, 'utf8');
  terraform('restored-baseline', testArgs);
  const compositionRoot = path.join(scratch, 'compositions');
  cpSync(path.join(repo, 'infra'), path.join(compositionRoot, 'infra'), {
    recursive: true,
    filter: includeConfig,
  });
  cpSync(copyDir, path.join(compositionRoot, 'app/src/messages'), { recursive: true });
  for (const file of ['stack.tf', 'outputs.tf']) {
    const dev = readFileSync(path.join(compositionRoot, 'infra/envs/dev', file), 'utf8');
    const prod = readFileSync(path.join(compositionRoot, 'infra/envs/prod', file), 'utf8');
    if (dev !== prod) throw new Error('Dev/prod composition differs: ' + file);
  }
  for (const environment of ['dev', 'prod']) {
    const root = path.join(compositionRoot, 'infra/envs', environment);
    terraform(environment + '-init', initArgs, undefined, root);
    terraform(environment + '-validate', ['validate', '-no-color'], undefined, root);
  }
  process.stdout.write('Maintenance HCL, both root compositions, mock contracts and all six fault probes passed. Logs: ' + artifactDir + '\n');
} finally {
  const resolved = path.resolve(scratch);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('hc-maintenance-infra-')) {
    throw new Error('Refusing cleanup outside owned maintenance scratch directory');
  }
  rmSync(resolved, { recursive: true, force: true });
}
```

- [ ] Run `node scripts/check-maintenance-infra.mjs` for RED. The expected failure is undeclared maintenance resources/local values in validate or tests. Missing Terraform/provider installation is an environment failure, not RED evidence. Read the captured log.
- [ ] Create infra/modules/cloudfront/maintenance.tf with this content. The module's provider declaration matches the environment roots; the lockfile continues to live in the roots.

```hcl
terraform {
  required_version = ">= 1.15"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

data "aws_caller_identity" "maintenance" {}

locals {
  maintenance_origin_id = "${var.name_prefix}maintenance-origin"
  maintenance_path      = "/${aws_s3_object.maintenance.key}"
  maintenance_copy      = jsondecode(file("${path.module}/../../../app/src/messages/edgeMaintenance.json"))
  maintenance_html      = templatefile("${path.module}/templates/maintenance.html.tftpl", { copy = local.maintenance_copy })
  maintenance_copy_valid = try(
    toset(keys(local.maintenance_copy)) == toset(["action", "body", "brand", "heading", "title"]) &&
    alltrue([for value in local.maintenance_copy :
      value == tostring(value) && trimspace(value) != "" && length(regexall("[^ -~]", value)) == 0
    ]),
    false
  )
}

resource "aws_s3_bucket" "maintenance" {
  bucket        = "${var.name_prefix}maintenance-${data.aws_caller_identity.maintenance.account_id}"
  force_destroy = false
}

resource "aws_s3_bucket_ownership_controls" "maintenance" {
  bucket = aws_s3_bucket.maintenance.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "maintenance" {
  bucket                  = aws_s3_bucket.maintenance.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "maintenance" {
  bucket = aws_s3_bucket.maintenance.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_object" "maintenance" {
  bucket        = aws_s3_bucket.maintenance.id
  key           = "maintenance/index.html"
  content       = local.maintenance_html
  content_type  = "text/html; charset=utf-8"
  cache_control = "no-store, max-age=0"
  source_hash   = sha256(local.maintenance_html)

  depends_on = [
    aws_s3_bucket_ownership_controls.maintenance,
    aws_s3_bucket_public_access_block.maintenance,
    aws_s3_bucket_server_side_encryption_configuration.maintenance,
  ]

  lifecycle {
    precondition {
      condition     = local.maintenance_copy_valid
      error_message = "Maintenance copy must have exactly action, body, brand, heading and title as non-empty printable ASCII strings."
    }
  }
}

resource "aws_cloudfront_origin_access_control" "maintenance" {
  name                              = "${var.name_prefix}maintenance-oac"
  description                       = "Read the independent maintenance page"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "maintenance" {
  bucket = aws_s3_bucket.maintenance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontReadMaintenancePage"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = ["s3:GetObject"]
      Resource  = ["${aws_s3_bucket.maintenance.arn}/${aws_s3_object.maintenance.key}"]
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.this.arn }
      }
    }]
  })
}
```

- [ ] Replace the obsolete "Custom error pages: deliberately NONE" header comment in main.tf with: `# Custom error pages: independent S3 document for 502/504; status codes preserved.` Add this origin inside aws_cloudfront_distribution.this after the existing app origin:

```hcl
  origin {
    origin_id                = local.maintenance_origin_id
    domain_name              = aws_s3_bucket.maintenance.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.maintenance.id
  }
```

- [ ] Add this exact ordered behavior immediately before default_cache_behavior. Add both error blocks inside the same distribution. Do not edit any existing origin, dynamic behavior, default behavior, viewer certificate or header policy.

```hcl
  ordered_cache_behavior {
    path_pattern           = local.maintenance_path
    target_origin_id       = local.maintenance_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_disabled.id
  }

  custom_error_response {
    error_code            = 502
    response_code         = 502
    response_page_path    = local.maintenance_path
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 504
    response_code         = 504
    response_page_path    = local.maintenance_path
    error_caching_min_ttl = 0
  }
```

The response path refers to aws_s3_object.maintenance.key, so the distribution waits for the uploaded object. The bucket policy refers to the distribution ARN, so it follows distribution creation. Do not add a distribution dependency on that policy. The direct private-object access check belongs after policy propagation, as specified in S4.

- [ ] Run `terraform fmt infra/modules/cloudfront/main.tf infra/modules/cloudfront/maintenance.tf infra/modules/cloudfront/tests/maintenance.tftest.hcl`, then `terraform fmt -check infra/modules/cloudfront/main.tf infra/modules/cloudfront/maintenance.tf infra/modules/cloudfront/tests/maintenance.tftest.hcl`.
- [ ] Run `node scripts/check-maintenance-infra.mjs` for GREEN. Baseline, restored baseline and both dev/prod root validations must exit 0; six faulty copies must fail their named assertions. A syntax failure, provider error or missing field is never accepted as fault detection. Run `node --check scripts/check-maintenance-infra.mjs` because the repository ESLint config does not cover .mjs rules.
- [ ] Run `npm run test -w @housingchoice/app -- test/cloudfrontBehaviors.test.ts` to preserve the existing app-prefix guard.
- [ ] Review the diff and module graph for only this object read grant, no application IAM/CORS/versioning resources, no distribution-policy cycle and unchanged existing security/header/caching blocks. Terraform validate plus mocked apply must be green. Record both copied dev/prod root init/validate exits, shared composition equality and module instantiation paths in the S2 report, without calling their live backends.
- [ ] Commit the four S2 files and the S2 evidence report. These tests establish configuration semantics locally; they do not prove that AWS has propagated the configuration.

## S3: Browser recovery and API failure contracts

**Interfaces:** Import renderMaintenancePage() and readMaintenanceCopy() from ../../support/maintenancePage.js in the browser spec. The API test exercises the existing exported request<T>() and ApiError from ./client.js. There is no production client change.

- [ ] Create dashboard/src/api/client.maintenance.test.ts:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from './client.js';

afterEach(() => vi.restoreAllMocks());

describe('maintenance response API contract', () => {
  it.each([502, 504])('throws status %s for HTML and does not replay a POST', async (status) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '<!doctype html><title>Temporarily unavailable</title>',
      { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ));
    const error: unknown = await request('/api/maintenance-contract', {
      method: 'POST', body: { submitted: true },
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, code: 'http_' + status, body: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/maintenance-contract',
      expect.objectContaining({ method: 'POST', body: '{"submitted":true}' }));
  });

  it.each(['relay_provisioning_disabled', 'pool_number_unavailable', 'push_not_configured'])(
    'preserves typed 503 refusal %s', async (code) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
        JSON.stringify({ error: code }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ));
      await expect(request('/api/maintenance-contract')).rejects.toMatchObject({
        status: 503, code, body: { error: code },
      });
    },
  );

  it('preserves successful JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await expect(request('/api/maintenance-contract')).resolves.toEqual({ ok: true });
  });
});
```

This is a characterization test: it should pass against the existing client because the spec deliberately preserves it. Do not manufacture a failing state or edit production transport merely to obtain RED. This HTML fixture tests MIME handling only; actual page rendering and browser proof below use S1's Terraform template.

- [ ] Run `npm run test -w @housingchoice/dashboard -- src/api/client.maintenance.test.ts src/routes/contact/CreateRelayGroupModal.test.tsx src/routes/settings/NotificationsSection.test.tsx`. Preserve all existing typed-503 assertions and ambiguous-502/504 decisions.
- [ ] Create e2e/tests/dashboard-next/maintenance-page.spec.ts. Every route fulfillment is confined to its test-owned hermetic URL; the recovery root is served by the real hermetic dashboard. A native POST never reaches the application backend because its exact route is fulfilled by Playwright.

```ts
import { expect, test } from '@playwright/test';
import { readMaintenanceCopy, renderMaintenancePage } from '../../support/maintenancePage.js';
import { dashboardUrl } from '../../support/urls.js';
import { expectNoHorizontalOverflow } from '../../support/viewport.js';

const parsed = new URL(dashboardUrl);
if (!process.env['E2E_LANE'] || !process.env['E2E_DASHBOARD_URL'] ||
    parsed.hostname !== '127.0.0.1' || ['5174', '8080'].includes(parsed.port)) {
  throw new Error('Maintenance browser tests require the hermetic e2e workspace lane');
}

test.describe('CloudFront maintenance document', () => {
  let html: string;
  test.beforeAll(() => { html = renderMaintenancePage(); });

  for (const status of [502, 504]) {
    for (const method of ['GET', 'POST'] as const) {
      for (const width of [320, 1280]) {
        test(status + ' ' + method + ' recovers with GET home at width ' + width, async ({ page }) => {
          await page.setViewportSize({ width, height: 800 });
          const copy = readMaintenanceCopy();
          const failedUrl = dashboardUrl + '/__maintenance-proof?original=must-not-replay';
          const startUrl = dashboardUrl + '/__maintenance-form';
          const failures: { method: string; body: string | null }[] = [];
          const dependencies: string[] = [];
          page.on('request', (request) => {
            if (['script', 'stylesheet', 'font', 'image'].includes(request.resourceType())) {
              dependencies.push(request.url());
            }
          });
          await page.route(failedUrl, async (route) => {
            failures.push({ method: route.request().method(), body: route.request().postData() });
            await route.fulfill({
              status, contentType: 'text/html; charset=utf-8',
              headers: { 'cache-control': 'no-store, max-age=0' }, body: html,
            });
          });

          if (method === 'GET') {
            const response = await page.goto(failedUrl);
            expect(response?.status()).toBe(status);
          } else {
            await page.route(startUrl, (route) => route.fulfill({
              contentType: 'text/html',
              body: '<!doctype html><form method="post" action="/__maintenance-proof?original=must-not-replay">' +
                '<input type="hidden" name="submission" value="once"><button>Submit test form</button></form>',
            }));
            await page.goto(startUrl);
            const response = page.waitForResponse((item) =>
              item.url() === failedUrl && item.request().method() === 'POST');
            await page.getByRole('button', { name: 'Submit test form' }).click();
            expect((await response).status()).toBe(status);
          }

          await expect(page.getByRole('main')).toHaveAttribute('data-hc-maintenance', '1');
          await expect(page.getByRole('heading', { name: copy.heading, exact: true })).toBeVisible();
          await expect(page.getByText(copy.body, { exact: true })).toBeVisible();
          await expect(page).toHaveTitle(copy.title);
          const action = page.getByRole('link', { name: copy.action, exact: true });
          await expect(action).toHaveAttribute('href', '/');
          await expect(action).toBeVisible();
          await expectNoHorizontalOverflow(page, 'maintenance document at ' + width);

          // Text enlargement is a reflow check; actual browser zoom is also inspected during self-QA.
          await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
          await expect(action).toBeVisible();
          await expectNoHorizontalOverflow(page, 'maintenance document with enlarged text at ' + width);
          expect(dependencies).toEqual([]);
          expect(failures).toEqual([{
            method, body: method === 'POST' ? 'submission=once' : null,
          }]);

          await page.keyboard.press('Tab');
          await expect(action).toBeFocused();
          expect(await action.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none');
          const homeResponse = page.waitForResponse((response) =>
            response.request().isNavigationRequest() &&
            response.url() === dashboardUrl + '/');
          await page.keyboard.press('Enter');
          const healthy = await homeResponse;
          expect(healthy.status()).toBe(200);
          expect(healthy.request().method()).toBe('GET');
          expect(healthy.request().postData()).toBeNull();
          expect(new URL(healthy.url()).search).toBe('');
          await expect(page.getByRole('link', { name: 'Sign in with Google', exact: true })).toBeVisible();
          await expect(page.locator('[data-hc-maintenance]')).toHaveCount(0);
          expect(failures).toHaveLength(1);
        });
      }
    }
  }
});
```

The rendering/recovery suite is expected to pass after S1; the genuinely new page already has its RED-before-implementation evidence in S1. Browser routes do not emulate CloudFront substitution or assert live activation.

- [ ] Run `npm run typecheck -w @housingchoice/dashboard` and `npm run typecheck -w @housingchoice/e2e`.
- [ ] Run `npm run e2e -- tests/dashboard-next/maintenance-page.spec.ts`. Expect eight scenarios: both statuses x both original methods x two widths. Use the harness only; no root Playwright invocation, live dashboard port, live AWS request, data reseed or real POST endpoint is needed.
- [ ] Commit both S3 files and its report with exact targeted command exits and browser results. Treat an unexpected layout, retry, focus or transport result as a defect to diagnose; do not weaken its assertion.

## S4: Operational handoff, final proof and review

**Interfaces:** RUNBOOK.md documents the operator boundary, not a new automation. e2e/README.md documents local test requirements. Reports cite the actual source, test results and artifact paths.

- [ ] Add the following operational section to RUNBOOK.md near its existing CloudFront/deployment instructions. The commands are documentation for the human operator after merge; writing them is not permission to execute them.

```markdown
### CloudFront maintenance fallback (502/504)

The shared CloudFront module serves an independent private-S3 HTML document when CloudFront returns 502 or 504. It keeps the failure status. It takes effect after the failure/timeout; it does not eliminate deployment downtime or the wait before a 504. All other status codes, including typed 503 responses, keep their existing bodies. Already-open dashboards retain their API error handling.

The error configuration is distribution-wide: an API, webhook, public/auth POST, script or photo request can receive the HTML body for 502/504. The action on the document performs a fresh GET of the app home, without replaying a form submission. The normal deployment process is unchanged.

Provisioning is a separate operator task after review and merge. Keep the application healthy and avoid concurrent deployments during the first apply: the distribution must exist before its exact-ARN S3 policy can be installed. The fallback is not established until both the apply and propagation complete.

1. From the repository root, run `npm run plan -- dev`. Review the proposed dedicated bucket/object/OAC/policy and the two CloudFront mappings. Resolve unrelated drift separately.
2. Run `npm run apply -- dev` using the repository account guard and its normal confirmation. Wait for the distribution deployment and S3 policy propagation.
3. Verify `https://dev.app.housingchoice.org/maintenance/index.html` returns 200, `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store, max-age=0`, and the expected page containing `data-hc-maintenance="1"`. Verify normal `/health` and the application still respond successfully.
4. Actual substitution proof requires a separately authorized dev deployment or dev-only failure exercise. Capture an application URL OTHER THAN `/maintenance/index.html` returning 502 or 504, `text/html`, and `data-hc-maintenance="1"` in the same response. After recovery, prove that same URL returns its healthy application response. Record the exact status witnessed; one status does not prove the other. Do not induce a production outage for this check.
5. After dev acceptance, repeat `npm run plan -- prod`, review, then `npm run apply -- prod`. Verify the direct page, `/health`, and application at `https://app.housingchoice.org`. No app redeploy is required by this feature.

A direct maintenance-page 200 proves object access only. Until the separately authorized application-error observation is recorded, report "configured; hosted substitution unverified." Record environment, UTC time, URL, status, content type, marker presence and subsequent healthy response; do not store credentials or request bodies.

Rollback: remove ONLY the 502 and 504 `custom_error_response` blocks from `infra/modules/cloudfront/main.tf`, then plan/apply the target environment using the same guarded commands. Keep the maintenance origin, exact behavior, object, OAC, policy and bucket. This restores the normal CloudFront error screen without deleting infrastructure. Full resource removal is separately authorized cleanup.
```

- [ ] Add this local-testing section to e2e/README.md and mention Terraform in the first-time prerequisites:

```markdown
### Maintenance-page verification

Terraform >=1.15 must be on PATH for maintenance template tests. The renderer runs `terraform console` in an empty temporary directory, reads the actual module template and JSON copy, and deletes only that owned temporary directory. It requires no provider initialization, backend, AWS credentials, app build or cloud access. Missing Terraform fails the test instead of silently skipping it.

From the repository root:

- `npm run test -w @housingchoice/e2e -- support/maintenancePage.test.ts`
- `npm run e2e -- tests/dashboard-next/maintenance-page.spec.ts`
- `node scripts/check-maintenance-infra.mjs`

The browser command uses the ordinary hermetic harness and tests both GET- and POST-originated 502/504 documents, safe GET-home recovery, keyboard focus, narrow/desktop layout and text enlargement. It does not induce an outage or prove AWS substitution.

The infrastructure command initializes locked providers in owned disposable configuration mirrors, validates HCL and executes only `mock_provider` tests in the CloudFront module. It requires six deliberately broken module copies to fail named assertions. It also compares the shared dev/prod composition and runs backend-disabled init/validate in copies of both roots with their respective lockfiles; no root plan, apply, test or provisioner runs. Provider installation may need network access; an existing filesystem mirror containing the locked AWS/random providers can be supplied as the sole argument. Logs are under `.superpowers/maintenance-infra/`. It never loads live environment state or invokes a live plan/apply.
```

- [ ] State the full-feature lane and exact checks before running final validation. Check live main drift and synchronize main ONCE before final gates. If synchronization conflicts with active work, ask before proceeding; never change HEAD in the shared main checkout. Record the resulting branch SHA and current main SHA.
- [ ] Run these bare gates separately from W:\tmp\cloudfront-maintenance-page, with their unmodified exit codes. Ensure DynamoDB Local is reachable; use the existing shared service without restarting other lanes. If absent, start the sanctioned service as the repository workflow permits. Never set a common AWS_ACCESS_KEY_ID to "fix" contention.

```text
npm run typecheck
npm test
npm run smoke
npm run e2e
```

- [ ] Run the touched-file ESLint ratchet using explicit paths from the committed main...HEAD diff, excluding non-JS/TS files. Do not invoke ESLint with an empty list. If it reports errors, compare the same files at the merge base, record existing errors, and fix new errors. Also run `node --check scripts/check-maintenance-infra.mjs` because existing ESLint does not check .mjs rules.
- [ ] Run the focused infrastructure command after final sync: `node scripts/check-maintenance-infra.mjs`, and the touched Terraform fmt check from S2. These are additional required checks; Node/Vitest cannot prove HCL validity.
- [ ] For independent live self-QA, start a hermetic `npm run e2e:session` after full-suite teardown. Use the repository browser tooling on that lane. Serve S1's actual rendered page through the same test-owned route fulfillment (reuse the S3 spec headed within the e2e workspace if the interactive tool cannot fulfill routes). Inspect both status documents at 320px and desktop, focus/Enter recovery and actual 200% browser zoom, taking screenshots under .playwright-mcp/. Do not substitute a hand-authored mockup. A headed run alone without inspection does not count as visual QA. Report any tooling limit explicitly instead of claiming visual proof. Stop only this owned session with `npm run e2e:stop`.
- [ ] Follow the feature-mission independent spec-compliance and adversarial code-review/fix-wave process. Reviewers must not start competing test suites during the interactive lane. Commit findings/adjudications/fix reports as produced under the records path. Rerun affected checks after fixes; final full gates must correspond to the delivered code.
- [ ] Before final handback, report later main drift without repeatedly syncing, verify bare git status and absence of MERGE_HEAD, and commit explicit remaining feature record/doc paths. Provide gate exit codes, targeted infrastructure/browser proof, review outcomes, limitations, artifact paths and "UNMERGED (human gate)".
- [ ] The operator obligations remain dev/prod plan/apply, propagation/direct-page checks and separately authorized actual dev substitution proof. Do not perform merge, AWS changes or cleanup during this build mission.

## Plan self-review checklist

- [x] Map each spec section to S1-S4: page/copy/escaping -> S1; origin/security/mappings/preservation -> S2; navigation/API behavior -> S3; rollout, rollback and full proof -> S4.
- [x] Confirm no app service, data model, seed, job, deployment script, environment secret or existing 503 reader is changed.
- [x] Confirm helpers and task imports use the exact S1 interfaces; production Terraform depends only on template/catalog, not Node.
- [x] Confirm mocked Terraform, browser fulfillment and direct page access are never described as live edge-substitution evidence.
- [x] Record independent plan findings and adjudications before the mission launch gate.

## Primary references for implementation checks

- Terraform templatefile: https://developer.hashicorp.com/terraform/language/functions/templatefile
- Terraform console: https://developer.hashicorp.com/terraform/cli/commands/console
- Terraform mocked providers: https://developer.hashicorp.com/terraform/language/tests/mocking
- AWS custom error responses: https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_CustomErrorResponse.html
- AWS error caching: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html
