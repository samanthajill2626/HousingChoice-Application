# infra/modules/

Terraform modules arrive in M0.4 (Terraform >= 1.15, AWS provider v6). Planned modules: `network`, `ec2`, `dynamodb` (9 on-demand tables with PITR, streams, and TTL where needed), `s3`, `ecr`, `ses`, `parameter-store`, `cloudfront`, `observability`, and `budget`. The AWS console stays read-only — every infrastructure change goes through `npm run plan` / `npm run apply`.
