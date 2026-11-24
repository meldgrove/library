import type { Actor } from "@/lib/commands";

/*
 * Who changes a setting: an admin on the admin page, or the operator command
 * (`cli settings …`, `src/cli/`). Only `src/cli/` calls `operator()`; a unit
 * test checks it. The brand is a symbol, so no request body or Server Action
 * argument can stand for the operator: JSON and React's serialization drop it.
 */

const OPERATOR = Symbol("library.operator");

export interface OperatorPrincipal {
  readonly [OPERATOR]: true;
  /** The command, such as "cli settings apply email", for the audit log. */
  readonly command: string;
}

export type SettingsActor = Actor | OperatorPrincipal;

/** The operator running `command`. Command line only. */
export function operator(command: string): OperatorPrincipal {
  return { [OPERATOR]: true, command };
}

export function isOperator(actor: unknown): actor is OperatorPrincipal {
  return typeof actor === "object" && actor !== null && OPERATOR in actor;
}
