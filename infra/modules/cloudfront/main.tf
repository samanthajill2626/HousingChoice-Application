# cloudfront — the public entry point for the stack.
#
# Viewers hit the custom domain (Change Order 3: app / dev.app on
# housingchoice.org) — or, before/without the alias, https://<dist>.cloudfront.net.
# CloudFront forwards to the EC2 EIP public DNS over plain HTTP on the app
# port and stamps the secret x-origin-verify header (value lives in Parameter
# Store via the params module). App middleware rejects any request missing the
# header (GET /health exempt), so the instance only ever serves CloudFront.
# Custom error pages: deliberately NONE (spec: custom error responses OFF).
#
# The Host header does NOT reach the origin (Managed-AllViewerExceptHostHeader),
# so the alias is transparent to the app — the origin secret, /api/* + /webhooks/*
# behaviors, and middleware chain are unchanged by the custom domain.

# AWS-managed policies — never create our own for these.
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

locals {
  origin_id = "${var.name_prefix}app-origin"
}

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  comment         = "${var.name_prefix}app"
  price_class     = "PriceClass_100"
  http_version    = "http2and3"
  is_ipv6_enabled = true

  # Alternate domain name(s). Empty until the custom-domain phase attaches the
  # alias alongside the validated ACM cert (must move together — an alias with
  # no matching cert is rejected). CloudFront only serves a Host that is either
  # the distribution's own *.cloudfront.net or a listed alias.
  aliases = var.aliases

  origin {
    origin_id   = local.origin_id
    domain_name = var.origin_domain_name

    custom_origin_config {
      http_port                = var.origin_http_port
      https_port               = 443 # unused (http-only) but required
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 30
      origin_keepalive_timeout = 5
    }

    custom_header {
      name  = "x-origin-verify"
      value = var.origin_secret
    }
  }

  # API + webhooks + auth: fully dynamic, all methods, nothing cached, full
  # viewer request forwarded (minus Host, which must be the origin's own
  # hostname). /auth/* is here for POST /auth/logout — the default behavior
  # below only allows GET/HEAD/OPTIONS (M1.3).
  dynamic "ordered_cache_behavior" {
    for_each = ["/api/*", "/webhooks/*", "/auth/*"]
    content {
      path_pattern             = ordered_cache_behavior.value
      target_origin_id         = local.origin_id
      viewer_protocol_policy   = "redirect-to-https"
      allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods           = ["GET", "HEAD"]
      compress                 = true
      cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    }
  }

  # Default behavior: same origin, also CachingDisabled FOR NOW — since M1.3
  # the app serves the built dashboard from here (DASHBOARD_DIST_DIR static +
  # SPA fallback). Tiny asset set, so CachingDisabled stays correct-first;
  # revisit CachingOptimized once the M1.4 UI ships real asset weight.
  default_cache_behavior {
    target_origin_id         = local.origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # Default *.cloudfront.net cert when no ACM cert is wired; otherwise the custom
  # cert, SNI-only at min TLS 1.2 (TLSv1.2_2021). Exactly one branch is active:
  # setting acm_certificate_arn omits cloudfront_default_certificate (null).
  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == null ? true : null
    acm_certificate_arn            = var.acm_certificate_arn
    ssl_support_method             = var.acm_certificate_arn == null ? null : "sni-only"
    minimum_protocol_version       = var.acm_certificate_arn == null ? null : "TLSv1.2_2021"
  }
}
