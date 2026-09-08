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
