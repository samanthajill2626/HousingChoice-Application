# DNS records the operator must enter BY HAND in Namecheap (the housingchoice.org
# zone is not in Route 53 - the same manual-DNS deviation as the acm module).
# Emitted at phase 0; enter them, let the domain verify, THEN flip
# mail_domain_phase to 1 to turn on inbound routing. Namecheap auto-appends the
# base domain, so strip the trailing ".<zone>" from each Host (see RUNBOOK
# "Email (SES)").
locals {
  dkim_records = [
    for token in aws_ses_domain_dkim.mail.dkim_tokens : {
      name  = "${token}._domainkey.${var.mail_domain}"
      type  = "CNAME"
      value = "${token}.dkim.amazonses.com"
    }
  ]

  verification_record = {
    name  = "_amazonses.${var.mail_domain}"
    type  = "TXT"
    value = aws_ses_domain_identity.mail.verification_token
  }

  mx_record = {
    name  = var.mail_domain
    type  = "MX"
    value = "10 inbound-smtp.${data.aws_region.current.region}.amazonaws.com"
  }

  spf_record = {
    name  = var.mail_domain
    type  = "TXT"
    value = "v=spf1 include:amazonses.com ~all"
  }
}

output "identity_arn" {
  description = "SES domain identity ARN - the resource ses:SendEmail/SendRawEmail is scoped to (fed to the ec2 instance role)."
  value       = aws_ses_domain_identity.mail.arn
}

output "verification_token" {
  description = "SES domain verification token - the value of the _amazonses.<domain> TXT record (see verification_record / dns_records for the full record)."
  value       = aws_ses_domain_identity.mail.verification_token
}

output "verification_record" {
  description = "The _amazonses.<domain> TXT verification record to enter in Namecheap."
  value       = local.verification_record
}

output "dkim_tokens" {
  description = "The 3 SES DKIM tokens (raw). See dkim_records for the full CNAME name+value pairs to enter in Namecheap."
  value       = aws_ses_domain_dkim.mail.dkim_tokens
}

output "dkim_records" {
  description = "The 3 DKIM CNAME records (name + value) to enter in Namecheap: <token>._domainkey.<domain> -> <token>.dkim.amazonses.com."
  value       = local.dkim_records
}

output "mx_record" {
  description = "Inbound MX record to enter in Namecheap on the mail domain: 10 inbound-smtp.<region>.amazonaws.com."
  value       = local.mx_record
}

output "spf_record" {
  description = "SPF TXT record to enter in Namecheap on the mail domain (authorizes SES to send): v=spf1 include:amazonses.com ~all."
  value       = local.spf_record
}

output "dns_records" {
  description = "Every Namecheap DNS record for the mail domain in one list (verification TXT + 3 DKIM CNAMEs + MX + SPF TXT) - the phase-0 operator worklist."
  value       = concat([local.verification_record], local.dkim_records, [local.mx_record, local.spf_record])
}

output "config_set_name" {
  description = "SES configuration set name - outbound sends set this so bounce/complaint/delivery events fan out to the mail-events topic (B5)."
  value       = aws_ses_configuration_set.mail.name
}

output "bucket_name" {
  description = "Inbound-mail S3 bucket name (INBOUND_MAIL_BUCKET) - the SES receipt rule writes raw MIME here."
  value       = aws_s3_bucket.inbound.bucket
}

output "bucket_arn" {
  description = "Inbound-mail S3 bucket ARN - the ec2 instance role's s3:GetObject scope."
  value       = aws_s3_bucket.inbound.arn
}

output "queue_url" {
  description = "Inbound-mail SQS queue URL (INBOUND_MAIL_QUEUE_URL) - the worker's second SqsJobConsumer long-polls it."
  value       = aws_sqs_queue.inbound_mail.url
}

output "queue_arn" {
  description = "Inbound-mail SQS queue ARN - the ec2 instance role's Receive/Delete/GetQueueAttributes scope + the SNS subscription target."
  value       = aws_sqs_queue.inbound_mail.arn
}

output "dlq_url" {
  description = "Inbound-mail dead-letter queue URL (inspect/redrive poison inbound notifications)."
  value       = aws_sqs_queue.inbound_mail_dlq.url
}

output "mail_events_topic_arn" {
  description = "SNS topic ARN for SES outbound events (bounce/complaint/delivery)."
  value       = aws_sns_topic.mail_events.arn
}

output "mail_inbound_topic_arn" {
  description = "SNS topic ARN for SES inbound-received notifications (the receipt-rule S3 action)."
  value       = aws_sns_topic.mail_inbound.arn
}
