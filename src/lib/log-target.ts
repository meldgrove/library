/**
 * Where logs go: stdout, except in the operator command (`src/cli/main.ts`),
 * whose stdout carries only its output. Set before the logger loads.
 */
let target: "stdout" | "stderr" = "stdout";

export const logTarget = () => target;

export function logToStderr() {
  target = "stderr";
}
