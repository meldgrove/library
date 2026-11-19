export type ErrorDetails = { name?: unknown; message?: unknown; stack?: unknown; code?: unknown; severity?: unknown; cause?: unknown };

function postgresCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const { code, severity } = error as ErrorDetails;
  return typeof severity === "string" && typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

// Drizzle includes query values and PostgreSQL can repeat them in errors.
// Accept the plain error objects emitted by pg-boss as well as Error instances.
export function databaseErrorSummary(message: string, error?: ErrorDetails): string | undefined {
  if (message.startsWith("Failed query: ") && message.includes("\nparams: ")) {
    const code = postgresCode(error?.cause);
    return code ? `Database query failed (PostgreSQL ${code})` : "Database query failed";
  }
  const code = postgresCode(error);
  return code ? `PostgreSQL error (${code})` : undefined;
}
