# infra/modules/

Terraform modules arrive in M0.4 (Terraform >= 1.15, AWS provider v6). Planned modules: `network`, `ec2`, `dynamodb` (9 on-demand tables with PITR, streams, and TTL where needed), `s3`, `ecr`, `ses`, `parameter-store`, `cloudfront`, `observability`, and `budget`. The AWS console stays read-only — every infrastructure change goes through `npm run plan` / `npm run apply`.

`acm` (Change Order 3) issues the per-stack custom-domain TLS certificate (DNS-validated, us-east-1) for the CloudFront alias. Because the `housingchoice.org` zone is at Namecheap (not Route 53), the validation records are entered by hand — the module stages the apply via the stack's `custom_domain_phase` so the first apply never deadlocks waiting on DNS it cannot create.
