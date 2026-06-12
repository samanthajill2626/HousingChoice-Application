# ses — sender email identity (account stays in the SES sandbox for Phase 0).
#
# NOTE (apply-time side effect): creating this identity sends a verification
# email to the address; outbound mail works only after the link is clicked.
#
# NOTE (account-level resource): SES email identities are account+region
# scoped, not stack scoped. dev and prod both declare the same address, so the
# second stack's apply adopts the already-verified identity (the underlying
# VerifyEmailIdentity call is idempotent) — but DESTROYING either stack would
# delete the identity for both. Acceptable for Phase 0; revisit if stacks ever
# need independent sender identities.

resource "aws_ses_email_identity" "sender" {
  email = var.sender_email
}
