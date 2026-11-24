/**
 * The mail server's own answer to a refused email, for the test of the email
 * setting: one line, without the `secrets` (the login), at most 200
 * characters. Null when the error holds none, or when what answered is no
 * mail server (its text is never quoted).
 */
export function smtpReply(error: unknown, secrets: string[]): string | null {
  const { response, command } = (error ?? {}) as { response?: unknown; command?: unknown };
  if (typeof response !== "string" || !/^[45]\d\d(?:[ -]|$)/.test(response)) return null;
  // A server that does not know EHLO is no mail server (FTP greets and refuses alike).
  if (command === "EHLO" || command === "HELO") return null;
  const oneLine = (text: string) => text.replace(/[\p{C}\s]+/gu, " ").trim();
  const hidden = secrets
    .flatMap((secret) => {
      const base64 = Buffer.from(secret).toString("base64");
      return [oneLine(secret), base64, base64.replace(/=+$/, "")];
    })
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let reply = oneLine(response);
  for (const secret of hidden) reply = reply.replaceAll(secret, "***");
  return reply.slice(0, 200);
}
