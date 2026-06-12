output "identity_arn" {
  description = "SES email identity ARN."
  value       = aws_ses_email_identity.sender.arn
}

output "verification_note" {
  description = "Operator reminder about the apply-time side effect."
  value       = "SES sends a verification email to ${var.sender_email} on apply; sending works only after the link is clicked (account is in the SES sandbox)."
}
