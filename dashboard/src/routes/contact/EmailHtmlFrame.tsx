// EmailHtmlFrame -- renders server-sanitized INBOUND email HTML inside a fully
// sandboxed, CSP-locked iframe (email-channel v1, B7; plan review F16).
//
// WHY THIS IS SAFE, and why it does NOT violate the repo's
// no-dangerouslySetInnerHTML rule:
//   - The markup is injected via the iframe's `srcDoc`, NOT via
//     dangerouslySetInnerHTML into our own document. srcDoc into a fully
//     sandboxed iframe is the sanctioned pattern: the HTML renders in an
//     isolated, script-disabled, origin-less browsing context that can never
//     touch our DOM, cookies, or storage.
//   - `sandbox=""` (EMPTY string) grants ZERO capabilities. No `allow-scripts`
//     means inline and external JS is inert (a script-bearing email fires no
//     dialog). No `allow-same-origin` means the frame gets an opaque origin, so
//     it cannot read our cookies/localStorage/DOM or issue same-origin requests.
//     An empty sandbox is the strongest possible setting.
//   - The prepended CSP meta is the GUARANTEE that blocks remote fetches (F16):
//     the sandbox alone does NOT stop remote image/tracker loads.
//     `default-src 'none'` forbids every network origin; `img-src data:` permits
//     ONLY inline data: images, so a `<img src="https://tracker/pixel">` never
//     loads (no open-tracking, no IP leak). `style-src 'unsafe-inline'` is a
//     belt-and-braces directive only: the ingest sanitize STRIPS inline `style`
//     attributes (they are not in sanitize-html's allowedAttributes), so no
//     inline styling actually reaches this frame - it is retained purely as
//     harmless defense-in-depth. sanitize-html's scheme + protocol-relative +
//     srcset strip at ingest is the first layer; THIS CSP is the render-time
//     guarantee.
//
// HEIGHT (adjudicated divergence from the plan's "auto-height via onLoad
// measurement capped at 480px"): an empty sandbox (no allow-same-origin) makes
// the frame's `contentDocument` UNREADABLE by design, so onLoad height
// measurement is impossible -- we cannot introspect the framed document at all.
// We therefore use a STATIC height capped at the plan's 480px (see the module
// CSS) with the iframe's own native scrolling for taller mail. Trading the
// auto-height nicety for the strict security contract is deliberate.
import styles from './EmailHtmlFrame.module.css';

/** The CSP meta that locks the framed document down (plan F16). Kept VERBATIM
 *  from the plan: no network origins, `data:` images only (blocks remote
 *  trackers), inline styles allowed. */
const EMAIL_CSP_META =
  '<meta http-equiv="Content-Security-Policy" ' +
  "content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\">";

/** Build the exact `srcDoc` string: the CSP meta PREPENDED to the
 *  server-sanitized HTML, so the guarantee travels INSIDE the sandboxed
 *  document. Pure + exported so a unit test can assert the CSP is present and
 *  first (the F16 guarantee). */
export function buildFramedEmailHtml(sanitizedHtml: string): string {
  return EMAIL_CSP_META + sanitizedHtml;
}

/** Render sanitized inbound email HTML. `html` is the server's
 *  `email_html_sanitized` (already sanitize-html'd at ingest); this component
 *  adds the sandbox + CSP defense-in-depth at render time. */
export function EmailHtmlFrame({ html }: { html: string }): React.JSX.Element {
  return (
    <iframe
      className={styles.frame}
      // sandbox="" -> NO capabilities (no scripts, no same-origin). See header.
      sandbox=""
      srcDoc={buildFramedEmailHtml(html)}
      title="Email message"
    />
  );
}
