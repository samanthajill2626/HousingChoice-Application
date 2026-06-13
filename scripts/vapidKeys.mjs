// VAPID keypair generator (M1.4 Web Push). Powers:
//   npm run vapid:keys
//
// GENERATION ONLY — by design this script touches NOTHING:
//   - it does NOT write .env / .env.dev / .env.prod (the template-first rule:
//     the operator pastes these into .env.<env> by hand, then runs
//     `npm run secrets:push -- <env>` to land them in Parameter Store, and the
//     next deploy hydrates them onto the instance);
//   - it does NOT call AWS (no account guard needed — it reaches no account);
//   - it prints the keypair to stdout for the operator to copy.
//
// VAPID keys are OPERATOR-managed secrets (the private key is secret; the
// public key is shipped to browsers and is not secret, but both live in
// .env.<env> for simplicity) — they are NOT Terraform-managed, so they are
// NOT on the secrets denylist (MANAGED_BY_OTHERS) and push:secrets CAN push
// them.
//
// Run once per environment, store the result, reuse it for ALL future pushes:
// rotating VAPID keys invalidates every existing browser subscription (every
// device must re-subscribe), so treat the keypair as long-lived.
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

// stderr for the human-readable preamble, stdout for the pasteable block, so
// `npm run vapid:keys 2>/dev/null` yields just the three env lines.
console.error('Generated a VAPID keypair. Paste these into .env.<env> (gitignored), then:');
console.error('  npm run secrets:push -- <dev|prod>     # lands them in Parameter Store');
console.error('  npm run deploy:<env>                    # hydrates them onto the instance');
console.error('');
console.error('Set VAPID_SUBJECT to a mailto: or https:// URI that identifies the sender,');
console.error('e.g. mailto:ops@housingchoice.org. The private key is a SECRET — never commit it.');
console.error('Reuse this keypair forever: rotating it forces every device to re-subscribe.');
console.error('');

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:ops@housingchoice.org');
