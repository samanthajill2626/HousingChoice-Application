// Ambient type shim for `nodemailer/lib/mail-composer` (consumed ONLY by
// adapters/email.ts, the email adapter-rule file).
//
// WHY THIS FILE EXISTS: nodemailer ships no types of its own and `@types/
// nodemailer` DOES declare `lib/mail-composer/index.d.ts` - but under this
// repo's `moduleResolution: NodeNext`, TypeScript resolves a deep subpath
// (`nodemailer/lib/mail-composer`) against the RUNTIME package (which has the
// `.js` but no co-located `.d.ts`) and does NOT fall back to the `@types`
// package for the subpath (it only maps the bare `nodemailer` name). The
// result is a TS2307 "cannot find module ... or its type declarations". A
// standalone ambient `declare module` (this file has no top-level import/
// export, so it is an ambient declaration, not a module augmentation) supplies
// the minimal surface email.ts uses and wins over the failed real resolution.
// The runtime import still resolves to the real JS file via esbuild/tsx.
//
// Scope: only the subset of nodemailer's Mail.Options + MimeNode that the
// outbound composer needs (plain-text body, explicit threading headers,
// attachments). Widen deliberately if a future slice needs more.

declare module 'nodemailer/lib/mail-composer' {
  interface MailComposerAddress {
    name?: string;
    address: string;
  }

  interface MailComposerAttachment {
    filename?: string | false;
    content?: string | Buffer;
    contentType?: string;
    cid?: string;
    encoding?: string;
  }

  interface MailComposerOptions {
    from?: string | MailComposerAddress;
    to?: string | Array<string | MailComposerAddress>;
    cc?: string | Array<string | MailComposerAddress>;
    replyTo?: string | MailComposerAddress;
    subject?: string;
    text?: string | Buffer;
    html?: string | Buffer;
    messageId?: string;
    inReplyTo?: string;
    references?: string | string[];
    headers?: Record<string, string>;
    attachments?: MailComposerAttachment[];
    date?: Date | string;
  }

  interface MailComposerMimeNode {
    /** Build the full MIME message as a Buffer (promise form). */
    build(): Promise<Buffer>;
  }

  class MailComposer {
    constructor(mail: MailComposerOptions);
    /** Compile the options into a MimeNode ready to build(). */
    compile(): MailComposerMimeNode;
  }

  export = MailComposer;
}
