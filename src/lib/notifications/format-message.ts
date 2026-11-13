import { renderDateTokens, type DateFormatter } from "@/lib/format";
import type { DigestSection, NotificationMessage } from "./types";

/* Turns a channel-neutral message into Slack mrkdwn or an email, in the reader's date format. */

const escapeSlack = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const absolute = (path: string, baseUrl: string) => `${baseUrl.replace(/\/+$/, "")}${path}`;

const slackSection = (section: DigestSection, baseUrl: string) => [
  `*${escapeSlack(section.heading)}*`,
  ...section.items.map((item) => {
    const link = `<${absolute(item.path, baseUrl)}|${escapeSlack(`${item.ref} · ${item.title}`)}>`;
    const meta = item.meta ? ` _${escapeSlack(item.meta)}_` : "";
    return `• ${link}: ${escapeSlack(item.summary)}${meta}`;
  }),
];

/** A Slack message: the linked title, the text, and the digest sections. */
export function slackText(message: NotificationMessage, baseUrl: string, formatter: DateFormatter): string {
  const lines = [
    `*<${absolute(message.path, baseUrl)}|${escapeSlack(message.title)}>*`,
    escapeSlack(renderDateTokens(message.text, formatter)),
  ];
  for (const section of message.sections ?? []) lines.push("", ...slackSection(section, baseUrl));
  return lines.join("\n");
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

const DEFAULT_FOOTER = "You get this email because you use the library.";

/** An email in plain text and HTML. Without a recipient name (a list address), it greets nobody by name. */
export function emailContent(message: NotificationMessage, recipientName: string | null, baseUrl: string, formatter: DateFormatter): EmailContent {
  const greeting = recipientName ? `Hello ${recipientName},` : "Hello,";
  const url = absolute(message.path, baseUrl);
  const body = renderDateTokens(message.text, formatter);
  const footer = message.footer ?? DEFAULT_FOOTER;
  const sections = message.sections ?? [];
  const textSections = sections.flatMap((section) => [
    "",
    section.heading,
    ...section.items.map((item) => `- ${item.ref} · ${item.title}: ${item.summary}${item.meta ? ` (${item.meta})` : ""}\n  ${absolute(item.path, baseUrl)}`),
  ]);
  const text = [greeting, "", body, ...textSections, "", message.title, url, "", footer].join("\n");
  const htmlSections = sections.map((section) =>
    [
      `<h3>${escapeHtml(section.heading)}</h3>`,
      "<ul>",
      ...section.items.map(
        (item) =>
          `<li><a href="${escapeHtml(absolute(item.path, baseUrl))}">${escapeHtml(`${item.ref} · ${item.title}`)}</a>: ${escapeHtml(item.summary)}${item.meta ? ` <em>${escapeHtml(item.meta)}</em>` : ""}</li>`,
      ),
      "</ul>",
    ].join("\n"),
  );
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>`,
    ...htmlSections,
    `<p><a href="${escapeHtml(url)}">${escapeHtml(message.title)}</a></p>`,
    `<p style="color:#666;font-size:12px">${escapeHtml(footer)}</p>`,
  ].join("\n");
  return { subject: renderDateTokens(message.subject, formatter), text, html };
}
