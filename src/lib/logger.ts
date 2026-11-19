import pino, { type DestinationStream } from "pino";
import { envValue } from "./env";

/** JSON logs to stdout, for the container logs. */
export function createLogger(destination?: DestinationStream) {
  return pino({
    level: envValue("LOG_LEVEL") ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
    base: { service: envValue("LIBRARY_PROCESS") ?? "web" },
    redact: {
      paths: ["*.password", "*.secret", "*.token", "*.accessToken", "*.refreshToken", "*.idToken", "*.authorization"],
      censor: "[redacted]",
    },
    serializers: { err: serializeError },
  }, destination);
}

export const logger = createLogger();

type ErrorDetails = { name?: unknown; message?: unknown; stack?: unknown; code?: unknown; severity?: unknown; cause?: unknown };

function postgresCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const { code, severity } = error as ErrorDetails;
  return typeof severity === "string" && typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

// Drizzle includes query values and PostgreSQL can repeat them in errors.
// Accept the plain error objects emitted by pg-boss as well as Error instances.
function databaseErrorMessage(message: string, error?: ErrorDetails): string | undefined {
  if (message.startsWith("Failed query: ") && message.includes("\nparams: ")) {
    const code = postgresCode(error?.cause);
    return code ? `Database query failed (PostgreSQL ${code})` : "Database query failed";
  }
  const code = postgresCode(error);
  return code ? `PostgreSQL error (${code})` : undefined;
}

function serializeError(value: unknown) {
  if (!value || typeof value !== "object") return errorMessage(value);
  const error = value as ErrorDetails;
  const message = typeof error.message === "string" ? error.message : "Unknown error";
  const databaseMessage = databaseErrorMessage(message, error);
  if (databaseMessage) return { message: databaseMessage };
  // The default serializer copies arbitrary fields and includes cause messages.
  return {
    type: typeof error.name === "string" ? error.name : "Error",
    message,
    stack: typeof error.stack === "string" ? error.stack : undefined,
  };
}

export function errorMessage(error: unknown): string {
  const details = error && typeof error === "object" ? error as ErrorDetails : undefined;
  const message = typeof details?.message === "string" ? details.message : String(error);
  return databaseErrorMessage(message, details) ?? message;
}
