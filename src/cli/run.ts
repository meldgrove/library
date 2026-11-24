import { CommandError } from "@/lib/commands";
import { databaseErrorSummary } from "@/lib/db/error-summary";
import { errorMessage, logger } from "@/lib/logger";
import { SETTINGS_IN_ORDER } from "@/lib/settings/definitions";
import { TESTABLE_SETTINGS } from "@/lib/settings/tests";
import { UsageError, type CliIo } from "./io";
import { settingsCommand, type SettingsDeps } from "./settings";

const DOCS = "https://github.com/meldgrove/library/blob/main/docs/deployment.md#settings-from-the-command-line";

function help(): string {
  const width = Math.max(...SETTINGS_IN_ORDER.map((setting) => setting.name.length));
  return `Meldgrove Library: the operator command. On a server with compose.yaml:
  docker compose run --rm -T migrate cli <command>
In a terminal of the app's container (Coolify): cli <command>

Commands:
  cli settings list [--json]              every setting: set, not set or incomplete, with hints
  cli settings show <name>                the setting as JSON, as the admin page reads it
  cli settings apply <name> < body.json   save the admin page's JSON body from stdin
  cli settings test <name>                what the page's test button does (${TESTABLE_SETTINGS.join(", ")})
  cli settings test email --to <address>  send a test email
  cli help                                this text

Settings (Admin › Integrations):
${SETTINGS_IN_ORDER.map((setting) => `  ${setting.name.padEnd(width)}  ${setting.label}`).join("\n")}

Secrets go only on stdin, never in an argument; output shows hints only.
Exit codes: 0 done, 1 refused (the page's message on stderr), 2 wrong command
or a body that is not JSON. Example bodies: ${DOCS}
`;
}

/** What went wrong, for stderr. A database error gets the page's generic message: its text can quote values. */
function report(error: unknown, io: CliIo): number {
  if (error instanceof UsageError) {
    io.err(`${error.message}\n${error.usage ? `Usage: ${error.usage}\n` : ""}Run "cli help" for the commands.\n`);
    return 2;
  }
  if (error instanceof CommandError) {
    io.err(`${error.message}\n`);
    for (const [field, message] of Object.entries(error.fieldErrors)) io.err(`  ${field}: ${message}\n`);
    return 1;
  }
  const details = error && typeof error === "object" ? (error as { message?: unknown; cause?: unknown }) : undefined;
  const summary = typeof details?.message === "string" ? databaseErrorSummary(details.message, details) : undefined;
  // The log line carries no query values (the logger's error serializer).
  logger.error({ err: error }, "cli failed");
  io.err(summary ? `Something went wrong. Try again. (${summary})\n` : `Something went wrong: ${errorMessage(error)}\n`);
  return 1;
}

/** Runs `cli <args>` and returns the exit code. */
export async function runCli(args: string[], io: CliIo, deps: () => SettingsDeps): Promise<number> {
  try {
    const [command, ...rest] = args;
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        if (rest.length > 0) throw new UsageError("help takes no arguments.");
        io.out(help());
        return 0;
      case "settings":
        return await settingsCommand(rest, io, deps());
      case "tokens":
        throw new UsageError("Meldgrove Library issues no tokens.");
      case undefined:
        io.err(help());
        return 2;
      default:
        throw new UsageError("Unknown command.");
    }
  } catch (error) {
    return report(error, io);
  }
}
