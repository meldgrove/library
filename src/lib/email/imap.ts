import { ImapFlow } from "imapflow";
import type { IntakeMailbox } from "@/lib/library/email-intake";

/*
 * The intake mailbox over IMAP (imapflow). The URL carries the account:
 * imaps://user:password@host:993 (TLS), or imap://… with STARTTLS, which
 * is then required: a server that does not offer it is refused. A message
 * larger than `maxMessageBytes` is fetched with its headers only, so the
 * worker can answer the sender without loading it.
 */

export interface ImapMailboxOptions {
  url: string;
  mailbox: string;
  /** Where handled messages go; they stay in the mailbox, seen, without it. */
  doneMailbox?: string;
  maxMessageBytes: number;
}

export async function openImapMailbox(options: ImapMailboxOptions): Promise<IntakeMailbox> {
  const url = new URL(options.url);
  const secure = url.protocol === "imaps:";
  const client = new ImapFlow({
    host: url.hostname,
    port: Number(url.port) || (secure ? 993 : 143),
    secure,
    // imap:// must upgrade with STARTTLS: without it, the password and the mail would cross the network in clear text.
    doSTARTTLS: secure ? undefined : true,
    auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) },
    logger: false,
    connectionTimeout: 30_000,
    socketTimeout: 120_000,
  });
  await client.connect();
  let lock: { release(): void };
  try {
    lock = await client.getMailboxLock(options.mailbox);
  } catch (error) {
    await client.logout().catch(() => undefined);
    throw error;
  }
  return {
    async *unseen(limit) {
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      for (const uid of uids.sort((a, b) => a - b).slice(0, limit)) {
        const meta = await client.fetchOne(String(uid), { size: true }, { uid: true });
        if (!meta) continue;
        const tooLarge = (meta.size ?? 0) > options.maxMessageBytes;
        const message = await client.fetchOne(String(uid), tooLarge ? { headers: true } : { source: true }, { uid: true });
        const bytes = message ? (tooLarge ? message.headers : message.source) : undefined;
        if (bytes) yield { uid, source: new Uint8Array(bytes), tooLarge };
      }
    },
    async done(uid) {
      // Moved, or marked seen, never both: a failed move leaves the message
      // unseen here, so the next run takes it up again (the Message-ID table
      // keeps it from being handled twice).
      if (options.doneMailbox) await client.messageMove(String(uid), options.doneMailbox, { uid: true });
      else await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
    },
    async close() {
      lock.release();
      await client.logout();
    },
  };
}
