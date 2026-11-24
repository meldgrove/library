/*
 * The options an SMTP URL may carry after `?`. Nodemailer reads every option
 * from there, also ones that run a program on the server (`sendmail`, `path`),
 * log messages (`logger`, `debug`) or send through another host (`proxy`). An
 * admin sets the URL, so only these options count; the page and the command
 * refuse the others, and the transport never gets them, whatever is stored.
 */
export const SMTP_URL_OPTIONS: readonly string[] = [
  "requireTLS",
  "ignoreTLS",
  "name",
  "authMethod",
  "pool",
  "maxConnections",
  "maxMessages",
  "connectionTimeout",
  "greetingTimeout",
  "socketTimeout",
  "tls.rejectUnauthorized",
  "tls.servername",
];

/** The options of an SMTP URL that do not count. Throws when the value is no URL. */
export function otherSmtpOptions(value: string): string[] {
  return [...new Set(new URL(value).searchParams.keys())].filter((option) => !SMTP_URL_OPTIONS.includes(option));
}

/** The URL as it may reach nodemailer: without the options that do not count. Throws when the value is no URL. */
export function safeSmtpUrl(value: string): string {
  const url = new URL(value);
  for (const option of otherSmtpOptions(value)) url.searchParams.delete(option);
  // Serialized, so nodemailer's parser reads the URL that was checked here.
  return url.href;
}

/** The login in a URL of `safeSmtpUrl`: user and password as written and decoded, and both as AUTH PLAIN sends them. */
export function smtpLogin(value: string): string[] {
  // Not read with `URL`: nodemailer also takes a URL without the slashes, where `URL` sees no login.
  const [, username = "", password = ""] = /^smtps?:(?:\/\/)?([^/?#:]*):?([^/?#]*)@/i.exec(value) ?? [];
  const [user, pass] = [username, password].map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  }) as [string, string];
  return [username, password, user, pass, ...(user && pass ? [`\0${user}\0${pass}`] : [])];
}
