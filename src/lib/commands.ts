import type { z } from "zod";

/*
 * Shared by every module that writes: who acts, how a write is refused, and
 * how form data becomes input for a zod schema.
 */

export interface Actor {
  personId: string;
  isAdmin: boolean;
}

export type FieldErrors = Record<string, string>;

/** A refused write. Form Server Actions show the message, or the field errors next to their fields. */
export class CommandError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "invalid",
    message: string,
    readonly fieldErrors: FieldErrors = {},
  ) {
    super(message);
    this.name = "CommandError";
  }
}

/**
 * Form fields as an object for zod. A field listed in `listFields`, or sent
 * more than once, becomes an array; every other field is a string.
 */
export function formDataToObject(formData: FormData, listFields: readonly string[] = []): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(formData.keys())) {
    if (key.startsWith("$ACTION")) continue;
    const values = formData.getAll(key).filter((value): value is string => typeof value === "string");
    result[key] = listFields.includes(key) || values.length > 1 ? values : (values[0] ?? "");
  }
  return result;
}

/** The first message per field, keyed by the top-level field name. */
export function fieldErrorsOf(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    errors[field] ??= issue.message;
  }
  return errors;
}
