// pushSignOut - forget THIS browser's push subscription on sign-out.
//
// WHY: sign-out is global revocation on the server, and that write also DROPS
// the user's push subscriptions (a subscription is a device credential, and
// message pushes carry contact names + bodies). If the browser kept its own
// subscription object, the Settings toggle would read On for a subscription
// the server no longer has - the same lie the pushsubscriptionchange gap
// produces. So the signing-out browser unsubscribes itself too. BEST-EFFORT
// and silent: sign-out must never be blocked by the push service, a missing
// service worker, or a denied permission - so this never throws.
//
// Only THIS device is touched; other devices re-arm push in Settings after
// they sign back in (their toggle re-probes the truth on visit).

/** Unsubscribe the current browser push subscription, if any. Never throws.
 *  Resolves true when a subscription was unsubscribed. */
export async function forgetBrowserPushSubscription(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return false;
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription === null || subscription === undefined) return false;
    return await subscription.unsubscribe();
  } catch {
    return false;
  }
}
