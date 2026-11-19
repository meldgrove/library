import pino, { type DestinationStream } from "pino";
import { databaseErrorSummary, type ErrorDetails } from "./db/error-summary";
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
    hooks: {
      logMethod(args, method) {
        // Pino otherwise copies the original message before serializing err.
        const [first, explicitMessage] = args;
        if (explicitMessage === undefined && first && typeof first === "object") {
          const { err, msg } = first as { err?: ErrorDetails; msg?: unknown };
          const error = first instanceof Error ? first : err;
          if (msg === undefined && typeof error?.message === "string") {
            const message = databaseErrorSummary(error.message, error);
            if (message) return method.call(this, first, message);
          }
        }
        return method.apply(this, args);
      },
    },
  }, destination);
}

export const logger = createLogger();

function serializeError(value: unknown) {
  if (!value || typeof value !== "object") return errorMessage(value);
  const error = value as ErrorDetails;
  const message = typeof error.message === "string" ? error.message : "Unknown error";
  const databaseMessage = databaseErrorSummary(message, error);
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
  return databaseErrorSummary(message, details) ?? message;
}
