/*
 * The operator command, `cli` in the image (docs/deployment.md, "Settings
 * from the command line"): `cli settings …` sets what admins set under
 * Admin › Integrations, with the same functions. Stdout carries only the
 * command's output; logs go to stderr. It starts no web server and no
 * worker, closes the database pool and exits. Like the other scripts, it
 * reports nothing to Sentry.
 */
import { logToStderr } from "@/lib/log-target";

logToStderr();
// Loaded only now: the logger reads the target when it loads.
const { runCli } = await import("./run");
const { processIo } = await import("./io");
const { closePool, getDb } = await import("@/lib/db/client");
const { getSettingsKey } = await import("@/lib/settings/secret-box");

const code = await runCli(process.argv.slice(2), processIo(), () => ({ db: getDb(), key: getSettingsKey() }));
await closePool().catch(() => undefined);
// Exit only once the output is written: a pipe can take it slower than it comes.
const flushed = (stream: NodeJS.WriteStream) => new Promise((resolve) => stream.write("", resolve));
await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
process.exit(code);
