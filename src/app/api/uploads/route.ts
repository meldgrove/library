import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentPerson } from "@/lib/auth/session";
import { CommandError } from "@/lib/commands";
import { getAuthConfig, getUploadConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { NOTE_LIMITS } from "@/lib/library/constants";
import { submitFile, submitLink } from "@/lib/library/submissions";
import { consumeRateLimit, RateLimitError, WRITE_LIMIT } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";

/*
 * Uploads: a route handler, not a Server Action, so files up to UPLOAD_MAX_MB
 * do not hit the Server Action body limit. Same-origin only: the session
 * cookie is SameSite=Lax, and the Origin header must be the library's.
 */

const fieldsSchema = z.object({
  kind: z.enum(["file", "link"]),
  reason: z.string().trim().min(3, "Say in one line why this is useful.").max(NOTE_LIMITS.reason, `At most ${NOTE_LIMITS.reason} characters.`),
  confirmed: z.literal("on", { error: "Confirm that the upload follows the rules." }),
  url: z.string().trim().max(2_000).optional(),
});

const errorResponse = (status: number, body: { formError?: string; fieldErrors?: Record<string, string> }) => NextResponse.json(body, { status });

export async function POST(request: Request) {
  const person = await getCurrentPerson();
  if (!person) return errorResponse(401, { formError: "Your session ended. Sign in again." });
  const origin = request.headers.get("origin");
  if (origin !== new URL(getAuthConfig().LIBRARY_BASE_URL).origin) return errorResponse(403, { formError: "This upload came from another site." });

  const maxBytes = getUploadConfig().UPLOAD_MAX_MB * 1_048_576;
  // The body is read whole, so its size must be known first. Browsers always
  // send it for a form; a request without it could fill the memory.
  const declared = request.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared)) return errorResponse(411, { formError: "The upload has no length. Try again." });
  // The form adds a few kilobytes around the file.
  if (Number(declared) > maxBytes + 64 * 1_024) {
    return errorResponse(413, { fieldErrors: { file: `The file is larger than ${getUploadConfig().UPLOAD_MAX_MB} MB.` } });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, { formError: "The upload could not be read. Try again." });
  }
  const parsed = fieldsSchema.safeParse({
    kind: form.get("kind"),
    reason: form.get("reason") ?? "",
    confirmed: form.get("confirmed") ?? "",
    url: typeof form.get("url") === "string" ? form.get("url") : undefined,
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
    return errorResponse(400, { fieldErrors });
  }

  try {
    await consumeRateLimit(getDb(), `write:${person.id}`, WRITE_LIMIT);
    const base = { submitterId: person.id, channel: "web" as const, reason: parsed.data.reason };
    let result: { submissionId: string };
    if (parsed.data.kind === "file") {
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) return errorResponse(400, { fieldErrors: { file: "Choose a file." } });
      result = await submitFile(
        getDb(),
        getStorage(),
        { ...base, fileName: file.name, declaredMimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
        maxBytes,
      );
    } else {
      if (!parsed.data.url) return errorResponse(400, { fieldErrors: { url: "Enter a link." } });
      result = await submitLink(getDb(), { ...base, url: parsed.data.url });
    }
    return NextResponse.json({ submissionId: result.submissionId }, { status: 201 });
  } catch (error) {
    if (error instanceof CommandError) return errorResponse(400, { formError: error.message, fieldErrors: error.fieldErrors });
    if (error instanceof RateLimitError) return errorResponse(429, { formError: error.message });
    throw error;
  }
}
