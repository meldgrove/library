import { spawnSync } from "node:child_process";
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

/** Turns the terminal's echo off while a body is pasted, so its secret is not shown. True when it worked. */
const echo = (on: boolean) => spawnSync("stty", [on ? "echo" : "-echo"], { stdio: ["inherit", "ignore", "ignore"] }).status === 0;

function restoreEchoAndExit() {
  echo(true);
  process.exit(130);
}

export function processIo(): CliIo {
  return {
    async readStdin() {
      const terminal = process.stdin.isTTY;
      if (terminal) {
        // Echo goes off before the prompt: nothing pasted after the prompt is shown.
        if (!echo(false)) throw new UsageError("The terminal's echo cannot be turned off: pipe the body in instead.", "cli settings apply <name> < body.json");
        process.once("SIGINT", restoreEchoAndExit);
        process.stderr.write("Paste the JSON body (it is not shown), then press Enter and Ctrl-D.\n");
      }
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) throw new CommandError("invalid", "The body is larger than 512 KiB.");
          chunks.push(chunk);
        }
        // An editor may start the file with a byte order mark.
        return Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "");
      } finally {
        if (terminal) {
          process.off("SIGINT", restoreEchoAndExit);
          echo(true);
        }
      }
    },
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
  };
}
