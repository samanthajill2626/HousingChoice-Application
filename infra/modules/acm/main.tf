# acm — the custom-domain TLS certificate fronting the stack's CloudFront
# distribution (Change Order 3).
#
# CloudFront certs MUST live in us-east-1; the whole stack already runs there,
# so the inherited default provider is correct (no provider alias needed).
#
# DNS for housingchoice.org lives at NAMECHEAP, not Route 53 (a deliberate,
# documented deviation from the "everything in IaC" principle — see README
# deviations table + RUNBOOK "Custom domain & TLS"). Terraform therefore CANNOT
# create the DNS-validation records itself. The apply is staged so it never
# deadlocks on the first run:
#
#   enable_validation = false (custom_domain_phase 0)
#     -> create the cert in PENDING_VALIDATION and expose its validation
#        CNAME via the `validation_records` output. No waiting; apply returns.
#        Operator copies the CNAME into Namecheap (leave it forever — ACM reuses
#        it for auto-renewal).
#   enable_validation = true (custom_domain_phase >= 1)
#     -> aws_acm_certificate_validation blocks until ACM observes the
#        operator-entered record and marks the cert ISSUED, then `certificate_arn`
#        resolves to a value that only exists post-issuance. Anything consuming
#        it (the CloudFront alias attach) is thereby gated on issuance.

resource "aws_acm_certificate" "this" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  # Replacing a cert in use by the distribution must mint the new one before the
  # old is destroyed, or the alias is briefly certless.
  lifecycle {
    create_before_destroy = true
  }
}

# DNS validation records are entered by hand in Namecheap (zone not in Route 53),
# so we deliberately OMIT `validation_record_fqdns`: with no FQDNs to wait on,
# this resource simply polls until the certificate reaches ISSUED. count gates
# it out of the first (cert-request-only) apply so that apply can never block.
resource "aws_acm_certificate_validation" "this" {
  count           = var.enable_validation ? 1 : 0
  certificate_arn = aws_acm_certificate.this.arn

  timeouts {
    create = "30m"
  }
}
