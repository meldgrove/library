import type { ReadStream } from "node:tty";
import { CommandError } from "@/lib/commands";

/** What a command reads and writes; tests pass their own. */
export interface CliIo {
  /** Everything on stdin, as text. */
  readStdin(): Promise<string>;
  /** The command's output: JSON or lines, never a secret. */
  out(text: string): void;
  /** Messages for the person at the terminal. */
  err(text: string): void;
}

/** A wrong command or option, or a body that is not JSON: exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
  constructor(
    message: string,
    /** The command's syntax, printed after the message. */
    readonly usage?: string,
  ) {
    super(message);
  }
}

/** The largest body: settings are small. */
const MAX_BODY_BYTES = 512 * 1024;

const tooLarge = () =>
  new CommandError("invalid", "The body is larger than 512 KiB.");

/**
 * A body pasted into a terminal (Coolify's): read in raw mode, so the terminal shows
 * nothing and does not cut a line at its 4 KiB limit. Ctrl-D ends the body; Ctrl-C
 * stops the command. The rest of a body over the limit is read and dropped, still in
 * raw mode, until Ctrl-D. Node restores the terminal's mode when the process exits.
 */
function readPasted(): Promise<Buffer> {
  const stdin = process.stdin as ReadStream;
  // Raw mode comes before the prompt: nothing pasted after the prompt is shown.
  stdin.setRawMode(true);
  process.stderr.write("Paste the JSON body (it is not shown), then press Ctrl-D.\n");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer) => {
      const end = chunk.indexOf(0x04);
      const cancel = chunk.indexOf(0x03);
      if (cancel !== -1 && (end === -1 || cancel < end)) {
        finish();
        process.exit(130);
      }
      const part = end === -1 ? chunk : chunk.subarray(0, end);
      size += part.length;
      if (size > MAX_BODY_BYTES) chunks.length = 0;
      else chunks.push(part);
      if (end !== -1) finish(size > MAX_BODY_BYTES ? tooLarge() : undefined);
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

async function readPiped(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function processIo(): CliIo {
  return {
    async readStdin() {
      const body = process.stdin.isTTY ? await readPasted() : await readPiped();
      // An editor may start the file with a byte order mark.
      return body.toString("utf8").replace(/^\uFEFF/, "");
    },
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
  };
}
