# cloudfront — the public entry point for the stack.
#
# Viewers hit https://<dist>.cloudfront.net (default *.cloudfront.net cert);
# CloudFront forwards to the EC2 EIP public DNS over plain HTTP on the app
# port and stamps the secret x-origin-verify header (value lives in Parameter
# Store via the params module). App middleware rejects any request missing the
# header (GET /health exempt), so the instance only ever serves CloudFront.
# Custom error pages: deliberately NONE (spec: custom error responses OFF).

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

  # API + webhooks: fully dynamic, all methods, nothing cached, full viewer
  # request forwarded (minus Host, which must be the origin's own hostname).
  dynamic "ordered_cache_behavior" {
    for_each = ["/api/*", "/webhooks/*"]
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

  # Default behavior: same origin, also CachingDisabled FOR NOW — where the
  # dashboard is hosted (S3+CF vs served by the app) is decided later; once
  # static assets exist this likely becomes CachingOptimized.
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

  viewer_certificate {
    cloudfront_default_certificate = true # *.cloudfront.net; custom domain is post-Phase-0
  }
}
