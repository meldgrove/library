import type { Actor } from "@/lib/commands";

/*
 * Who changes a setting: an admin on the admin page, the operator command
 * (`cli settings …`, `src/cli/`), or the import of an old variable at start.
 * Only `src/cli/` calls `operator()`; a unit test checks it. The brand is a
 * symbol, so no request body or Server Action argument can stand for the
 * operator: JSON and React's serialization drop it.
 */

const OPERATOR = Symbol("library.operator");
const ENVIRONMENT = Symbol("library.environment");

export interface OperatorPrincipal {
  readonly [OPERATOR]: true;
  /** The command, such as "cli settings apply email", for the audit log. */
  readonly command: string;
}

/** An old variable copied into the database at start (`legacy-env.ts`). */
export interface EnvironmentPrincipal {
  readonly [ENVIRONMENT]: true;
  /** The process that copied it: web, worker, migrate. */
  readonly process: string;
}

export type SettingsActor = Actor | OperatorPrincipal | EnvironmentPrincipal;

/** The operator running `command`. Command line only. */
export function operator(command: string): OperatorPrincipal {
  return { [OPERATOR]: true, command };
}

export function isOperator(actor: unknown): actor is OperatorPrincipal {
  return typeof actor === "object" && actor !== null && OPERATOR in actor;
}

/** The import of old variables in `process`. Only `legacy-env.ts` calls it. */
export function environment(process: string): EnvironmentPrincipal {
  return { [ENVIRONMENT]: true, process };
}

export function isEnvironment(actor: unknown): actor is EnvironmentPrincipal {
  return typeof actor === "object" && actor !== null && ENVIRONMENT in actor;
}
