# certificate_arn: when validation is enabled this reads through the validation
# resource, so its value is only known AFTER the cert is ISSUED — consumers (the
# CloudFront alias attach) then implicitly wait for issuance. Before validation
# it falls back to the raw cert ARN (still useful to surface as an output).
output "certificate_arn" {
  description = "ACM certificate ARN for the custom domain. Gated on issuance once validation is enabled."
  value       = var.enable_validation ? aws_acm_certificate_validation.this[0].certificate_arn : aws_acm_certificate.this.arn
}

# The DNS-validation CNAME(s) the operator must enter in Namecheap. Populated by
# ACM as soon as the cert is requested (even while PENDING). NOTE the Namecheap
# host-stripping gotcha (Namecheap auto-appends the zone): strip the trailing
# ".<zone>." from `name` before pasting — see RUNBOOK "Custom domain & TLS".
output "validation_records" {
  description = "DNS validation CNAME(s) to add in Namecheap and LEAVE in place (ACM reuses them for auto-renewal)."
  value = [
    for o in aws_acm_certificate.this.domain_validation_options : {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  ]
}
