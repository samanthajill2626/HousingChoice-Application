// The one-to-one sender pin (retry-send-adoption R1): the number a one-to-one
// text is sent FROM - an explicit `from` (a relay pool number), else the
// business number (config.businessPhoneNumber; undefined in an unpinned dev
// loop, where the Messaging Service picks). sendMessage and the retry job's
// attempt facts read it from THIS function so the record's `sender` is the
// number the provider call pins.
export function pinnedSender(config: { businessPhoneNumber?: string | undefined }, from?: string): string | undefined {
  return from ?? config.businessPhoneNumber;
}
