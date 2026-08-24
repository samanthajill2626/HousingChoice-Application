// Parse the SMS-reply half of a TwiML webhook response.
//
// Real Twilio renders a webhook response's <Message> verbs as SMS back to the
// sender. The fake's inbound dispatch used to read only the response STATUS,
// so a keyword confirmation (STOP/HELP/START, closed-group intercept, the
// open-path keywords) rode a body nobody parsed - the fake-phones UI showed
// the member's STOP with no reply, and manual QA of every keyword flow was
// half-blind. See docs/issues/fake-phones-no-twiml-replies.md.
//
// Deliberately a SUBSET parser: the two shapes the TwiML spec defines for
// Message are inline text (`<Message>ok</Message>`) and nested verbs
// (`<Message><Body>ok</Body><Media>url</Media></Message>`). Attributes
// (to/from overrides) are accepted and ignored - the app's replies never set
// them, and the fake's rendering rule (reply goes to the sender, from the
// number they texted) is Twilio's default. A non-XML or Message-less body
// yields [] rather than an error: most webhook responses are empty TwiML.

export interface TwimlSmsReply {
  body?: string;
  mediaUrls?: string[];
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function unescapeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m);
}

/** Every <Message> verb in a TwiML response, in document order. */
export function parseTwimlMessages(xml: string): TwimlSmsReply[] {
  const replies: TwimlSmsReply[] = [];
  // Non-greedy body match is safe here: Message verbs cannot nest.
  const messageRe = /<Message(?:\s[^>]*)?>([\s\S]*?)<\/Message>/g;
  for (const match of xml.matchAll(messageRe)) {
    const inner = match[1] ?? '';
    const bodyTags = [...inner.matchAll(/<Body(?:\s[^>]*)?>([\s\S]*?)<\/Body>/g)].map((m) =>
      unescapeXml((m[1] ?? '').trim()),
    );
    const mediaUrls = [...inner.matchAll(/<Media(?:\s[^>]*)?>([\s\S]*?)<\/Media>/g)]
      .map((m) => unescapeXml((m[1] ?? '').trim()))
      .filter((u) => u.length > 0);
    // Nested verbs win; otherwise the inner text IS the body (the common shape).
    const body =
      bodyTags.length > 0
        ? bodyTags.join('\n')
        : unescapeXml(inner.replace(/<[^>]*>/g, '').trim());
    const reply: TwimlSmsReply = {
      ...(body.length > 0 && { body }),
      ...(mediaUrls.length > 0 && { mediaUrls }),
    };
    // An entirely empty <Message/> renders nothing on a real handset either.
    if (reply.body !== undefined || reply.mediaUrls !== undefined) replies.push(reply);
  }
  return replies;
}
