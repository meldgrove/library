import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { CommandError } from "@/lib/commands";
import type { Database } from "@/lib/db/client";
import { operator } from "@/lib/settings/actor";
import { isSettingName, SETTING_NAMES, SETTINGS, type SettingName } from "@/lib/settings/definitions";
import { LEGACY_VARIABLES, leftoverVariables, workerSettingsMode } from "@/lib/settings/legacy-env";
import { applySetting, listSettings, showSetting } from "@/lib/settings/service";
import { isTestable, testSetting, type TestDeps } from "@/lib/settings/tests";
import { UsageError, type CliIo } from "./io";

/*
 * `cli settings …`: list, show, apply and test the settings of
 * Admin › Integrations, as an operator with an admin's rights. Every command
 * calls the same functions as the admin page (`src/lib/settings/`); none
 * checks anything itself.
 */

export interface SettingsDeps {
  db: Database;
  /** Null in a container without BETTER_AUTH_SECRET: list and show work, apply and test do not. */
  key: Buffer | null;
  /** Stand-ins for the tests of `cli settings test`. */
  testDeps?: TestDeps;
}

type OptionValues = Record<string, string | boolean | undefined>;

const USAGE = "cli settings list|show|apply|test <name>";
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const NAMES = SETTING_NAMES.join(", ");

/** The options of a command. Messages never repeat what was typed: it could be a secret. */
function parse(args: string[], options: ParseArgsOptionsConfig, usage: string): OptionValues {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (error) {
    const known = (error as { code?: unknown }).code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE";
    throw new UsageError(known ? "An option is missing its value." : "Unknown option.", usage);
  }
  if (parsed.positionals.length > 0) throw new UsageError("Too many arguments. A body goes on stdin, never in an argument.", usage);
  return parsed.values as OptionValues;
}

function parseJson(text: string, usage: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError("The body on stdin is not JSON.", usage);
  }
}

const needsKey = (key: Buffer | null): Buffer => {
  if (key) return key;
  throw new CommandError(
    "invalid",
    "This container has no BETTER_AUTH_SECRET, so it cannot open or save the settings' secrets. Run the command with `docker compose run --rm -T migrate cli …` and the compose.yaml of this release.",
  );
};

/** `cli settings …`. Returns the exit code. */
export async function settingsCommand(args: string[], io: CliIo, deps: SettingsDeps): Promise<number> {
  const [command, ...rest] = args;

  if (command === "list") {
    const values = parse(rest, { json: { type: "boolean" } }, "cli settings list [--json]");
    const [statuses, leftovers, workerMode] = await Promise.all([listSettings(deps.db, deps.key), leftoverVariables(deps.db), workerSettingsMode(deps.db)]);
    const rows = statuses.map(({ name, state, hints }) => ({
      name,
      state,
      hints,
      oldVariables: leftovers.filter(({ variable }) => variable in LEGACY_VARIABLES[name]),
    }));
    if (values.json) {
      io.out(json(rows));
      return 0;
    }
    const width = Math.max(...rows.map((row) => row.name.length));
    for (const row of rows) {
      io.out(`${`${row.name.padEnd(width)}  ${row.state.padEnd(10)}  ${row.hints.join(", ")}`.trimEnd()}\n`);
      if (row.oldVariables.length > 0) {
        const names = row.oldVariables.map(({ variable, processes }) => `${variable} (${processes.join(", ")})`).join(", ");
        io.out(`${" ".repeat(width + 2)}old variables still set: ${names}${workerMode === "environment" ? "" : ". Delete them from .env: the settings are in the database"}\n`);
      }
    }
    if (workerMode === "environment") {
      io.out("\nThe worker has no BETTER_AUTH_SECRET (a compose.yaml of 0.3.2 or earlier): it reads the old variables, not these settings. Update compose.yaml.\n");
    }
    return 0;
  }

  if (command !== "show" && command !== "apply" && command !== "remove" && command !== "test") throw new UsageError("Unknown command.", USAGE);
  const [name, ...optionArgs] = rest;
  const usage = `cli settings ${command} <name>`;
  if (!name || name.startsWith("-")) throw new UsageError(`Name the setting: ${NAMES}.`, usage);
  if (!isSettingName(name)) throw new UsageError(`Unknown setting. The settings are ${NAMES}.`, usage);
  const setting: SettingName = name;
  // Every setting of the library is a single one; none is a list of entries.
  const single = (values: OptionValues) => {
    if (values.id !== undefined) throw new UsageError(`${setting} is a single setting: leave out --id.`, usage);
  };
  const id = { id: { type: "string" } } as const;

  switch (command) {
    case "show": {
      single(parse(optionArgs, id, usage));
      io.out(json(await showSetting(deps.db, setting, deps.key)));
      return 0;
    }
    case "apply": {
      single(parse(optionArgs, id, `${usage} < body.json`));
      // The whole body first: nothing is loaded or locked while someone pastes.
      const body = parseJson(await io.readStdin(), `${usage} < body.json`);
      const key = needsKey(deps.key);
      io.out(json(await applySetting(deps.db, key, setting, body, operator(`cli settings apply ${setting}`))));
      return 0;
    }
    case "remove":
      throw new UsageError(`${setting} is a single setting, not a list: apply a body that clears its fields (null) to turn it off.`);
    case "test": {
      if (!isTestable(setting)) throw new UsageError(`${setting} has no test. The settings with a test are ${Object.keys(SETTINGS).filter((candidate) => isTestable(candidate as SettingName)).join(", ")}.`);
      const testUsage = setting === "email" ? "cli settings test email --to <address>" : usage;
      const values = parse(optionArgs, { ...id, ...(setting === "email" ? { to: { type: "string" } } : {}) }, testUsage);
      single(values);
      if (setting === "email" && typeof values.to !== "string") throw new UsageError("Name the address for the test email with --to.", testUsage);
      const key = needsKey(deps.key);
      const result = await testSetting(deps.db, key, setting, { to: typeof values.to === "string" ? values.to : undefined }, deps.testDeps);
      io.out(json(result));
      if (result.ok) return 0;
      io.err(`${result.message}\n`);
      return 1;
    }
  }
}
