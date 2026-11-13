import type { ScreenFinding } from "./constants";

/*
 * The screen every upload passes before the AI model sees it. Plain code, no
 * I/O: a finding quarantines the upload, and a steward releases or deletes it.
 *
 * The injection and credential rules catch copy-pasted boilerplate and are
 * tuned for few false positives; they are not a trust boundary. The real
 * defence is structural: the model has no tools, its output is checked
 * against a schema, and the uploader reviews every draft.
 *
 * The prohibited-data rules keep out what a shared reading library should
 * never hold: bank details, special-category data, criminal records,
 * credentials, and personnel files. Studies often name one bank account or a
 * few authors' addresses, so the rules look for lists, not single values.
 */

/** Letters and digits in any script: JavaScript's `\b` and `\w` only know ASCII. */
const WORD = "[\\p{L}\\p{N}_]";
const start = `(?<!${WORD})`;
const end = `(?!${WORD})`;
/** One of the words, as whole words. */
const words = (...alternatives: string[]) => `${start}(?:${alternatives.join("|")})${end}`;
/** One of the stems, followed by any word characters. */
const stems = (...alternatives: string[]) => `${start}(?:${alternatives.join("|")})${WORD}*`;
const re = (source: string) => new RegExp(source, "giu");

const ROLE_LABEL = `(?:${words("system", "developer", "assistant")}\\s*(?:(?:instruction|prompt|message)\\s*)?(?::|,)|${words("ai model", "ai agent", "ki-modell", "ki-agent", "assistent")}\\s+${words("must", "should", "shall", "to", "muss", "soll")})`;
const NOT = "(?<!not )(?<!never )";

const INJECTION_RULES: readonly (readonly [string, RegExp])[] = [
  [
    "injection_ignore_governing_instructions",
    re(
      `${NOT}${words("ignore", "disregard", "override", "forget", "bypass", "ignoriere", "missachte", "überschreibe", "umgehe")}[\\s\\S]{0,80}` +
        `${stems("previous", "prior", "above", "system", "developer", "governing", "security", "safety", "vorherig", "bisherig", "obig", "sicherheits")}[\\s\\S]{0,40}` +
        stems("instruction", "prompt", "rule", "policy", "message", "anweisung", "regel", "richtlinie", "nachricht"),
    ),
  ],
  [
    "injection_reveal_secrets",
    re(
      `(?:${ROLE_LABEL}[\\s\\S]{0,80}${NOT}${words("reveal", "show", "print", "return", "exfiltrate", "leak", "dump", "zeige", "verrate", "enthülle", "gib", "drucke")}` +
        `[\\s\\S]{0,80}${stems("system prompt", "secret", "credential", "password", "api key", "access token", "private key", "systemprompt", "geheimnis", "zugangsdaten", "passwort", "api.schlüssel", "zugriffstoken")}` +
        `|${NOT}${words("reveal", "show", "print", "return", "exfiltrate", "leak", "dump", "zeige", "verrate", "enthülle")}` +
        `[\\s\\S]{0,80}${stems("system prompt", "secret", "credential", "password", "api key", "access token", "private key", "systemprompt", "geheimnis", "zugangsdaten", "passwort")}` +
        `[\\s\\S]{0,40}${words("to me", "in (?:your|the) response", "right now", "mir", "in deiner antwort", "sofort")})`,
    ),
  ],
  [
    "injection_tool_or_execution_request",
    re(
      `${ROLE_LABEL}[\\s\\S]{0,60}${words("call", "invoke", "use", "run", "execute", "launch", "rufe", "verwende", "nutze", "starte", "führe")}[\\s\\S]{0,60}` +
        words("tool", "function", "shell", "terminal", "command", "script", "code", "browser", "curl", "wget", "werkzeug", "funktion", "befehl"),
    ),
  ],
  [
    "injection_external_fetch_request",
    re(
      `${ROLE_LABEL}[\\s\\S]{0,60}${words("fetch", "download", "open", "visit", "request", "browse", "lade", "öffne", "besuche", "rufe")}[\\s\\S]{0,40}(?:https?://|www\\.|${words("url", "link")})`,
    ),
  ],
  [
    "injection_authorization_change",
    re(
      `${ROLE_LABEL}[\\s\\S]{0,60}${words("grant", "widen", "change", "disable", "remove", "bypass", "override", "gewähre", "erweitere", "ändere", "deaktiviere", "entferne", "umgehe")}[\\s\\S]{0,80}` +
        stems("permission", "authorization", "access control", "acl", "allowed group", "admin", "berechtigung", "autorisierung", "zugriffskontrolle", "erlaubte gruppe"),
    ),
  ],
];

const CREDENTIAL_RULES: readonly (readonly [string, RegExp])[] = [
  ["private_key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/gi],
  ["secret_value", /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*['"]?[^'"\s]{8,}/gi],
];

/** Several valid IBANs: a list of bank details, such as a payment file. */
export const IBAN_LIST_THRESHOLD = 3;
/** Many distinct email addresses: a contact list rather than a study's authors. */
export const EMAIL_LIST_THRESHOLD = 25;
/** Personnel documents are recognised by their heading, so only the start of the text counts. */
const HEADING_CHARS = 2_000;

const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PERSONNEL_HEADINGS = re(
  words(
    "arbeitsvertrag",
    "lebenslauf",
    "personalakte",
    "gehaltsabrechnung",
    "lohnabrechnung",
    "entgeltabrechnung",
    "arbeitsunfähigkeitsbescheinigung",
    "krankmeldung",
    "arbeitszeugnis",
    "abmahnung",
    "curriculum vitae",
    "payslip",
    "pay slip",
    "employment contract",
    "personnel file",
    "sick note",
    "führungszeugnis",
  ),
);

/** IBAN check digits (ISO 13616, mod 97). */
export function isValidIban(candidate: string): boolean {
  const iban = candidate.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** The Luhn check of payment card numbers. */
export function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

const countMatches = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

/** Zero-width and bidirectional control characters hide text from people, not from models. */
function normalize(text: string): string {
  return text.normalize("NFKC").replace(/[​-‍⁠﻿؜‎‏‪-‮⁦-⁩]/g, "");
}

/** Every rule that matched, with how often. Empty means the text passed. Never returns the matched text. */
export function screenText(raw: string): ScreenFinding[] {
  const text = normalize(raw);
  const findings: ScreenFinding[] = [];
  for (const [rule, pattern] of INJECTION_RULES) {
    const count = countMatches(text, pattern);
    if (count > 0) findings.push({ rule, category: "prompt_injection", count });
  }
  for (const [rule, pattern] of CREDENTIAL_RULES) {
    const count = countMatches(text, pattern);
    if (count > 0) findings.push({ rule, category: "credential", count });
  }

  const ibans = new Set((text.match(IBAN) ?? []).map((value) => value.replace(/\s+/g, "")).filter(isValidIban));
  if (ibans.size >= IBAN_LIST_THRESHOLD) findings.push({ rule: "bank_details_list", category: "prohibited_data", count: ibans.size });

  const cards = new Set((text.match(CARD) ?? []).map((value) => value.replace(/\D/g, "")).filter(passesLuhn));
  // Long numbers in tables pass Luhn by chance about one time in ten; two distinct ones are a pattern.
  if (cards.size >= 2) findings.push({ rule: "payment_card_numbers", category: "prohibited_data", count: cards.size });

  const emails = new Set((text.match(EMAIL) ?? []).map((value) => value.toLowerCase()));
  if (emails.size >= EMAIL_LIST_THRESHOLD) findings.push({ rule: "contact_list", category: "prohibited_data", count: emails.size });

  const headings = countMatches(text.slice(0, HEADING_CHARS), PERSONNEL_HEADINGS);
  if (headings > 0) findings.push({ rule: "personnel_document", category: "prohibited_data", count: headings });

  return findings;
}

const CATEGORY_LABELS: Record<ScreenFinding["category"], string> = {
  prohibited_data: "possible prohibited data",
  credential: "a possible password or key",
  prompt_injection: "text that tries to instruct an AI model",
};

/** One line for the uploader and the steward. */
export function describeFindings(findings: readonly ScreenFinding[]): string {
  const categories = [...new Set(findings.map((finding) => CATEGORY_LABELS[finding.category]))];
  return `The screen found ${categories.join(" and ")} (${findings.map((finding) => finding.rule).join(", ")}).`;
}
