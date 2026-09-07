# Live self-QA: maintenance page

Date: 2026-09-07

## Scope and boundary

This was an actual-template visual and recovery preview, not real dashboard
recovery or hosted CloudFront substitution evidence. A local loopback helper
rendered `infra/modules/cloudfront/templates/maintenance.html.tftpl` through
the real Terraform renderer and returned the resulting document at a 502
endpoint. Its healthy `/` response was a purpose-built local page, not the
HousingChoice dashboard. The focused hermetic S3 browser specification is the
separate dashboard-recovery proof; real CloudFront substitution remains an
authorized post-apply operator check.

## Measured observations

- At 320x800, the 502 document had its expected title and maintenance marker;
  document and `main` horizontal overflow were both 0 pixels. Its DOM had no
  script, stylesheet, font, image, or source dependency.
- At 1280x900, document and `main` horizontal overflow were both 0 pixels and
  the recovery link remained visible.
- Keyboard Tab focused `Try again`; the measured focus indicator was a solid
  3px outline. Enter navigated to the local healthy `/` page.
- A local form submitted `submission=once` by POST to the 502 document. The
  same keyboard recovery then made one fresh GET to `/` with no request body.
- Root-font enlargement to 200 percent measured 32px from a 16px root font at
  320px width. The link stayed visible and both overflow readings remained 0.

The available Playwright driver could inject `Control++`, but its measured
`innerWidth`, `devicePixelRatio`, `visualViewport.scale`, and root font stayed
320, 1, 1, and 16px. It therefore did not change native browser zoom. This
preview does not claim a native 200 percent browser-zoom check; the existing
focused browser test separately covers root-font enlargement only.

## Artifacts and cleanup state

- Narrow focused screenshot:
  `.playwright-mcp/maintenance-selfqa-narrow-focused.png`
- Narrow root-font-200 screenshot:
  `.playwright-mcp/maintenance-selfqa-narrow-root-font-200.png`
- Desktop screenshot:
  `.playwright-mcp/maintenance-selfqa-desktop.png`

The owned loopback listener was stopped and port 59007 was confirmed closed.
The ignored helper and browser artifacts remain available for review; no
worktree cleanup was performed.
