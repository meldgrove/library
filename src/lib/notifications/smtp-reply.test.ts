import { createServer, type AddressInfo, type Socket } from "node:net";
import nodemailer from "nodemailer";
import { afterEach, describe, expect, it } from "vitest";
import { safeSmtpUrl, smtpLogin } from "@/lib/settings/smtp-url";
import { smtpReply } from "./smtp-reply";
import { createSmtpTransport, type DeliveryError } from "./transports";

const base64 = (text: string) => Buffer.from(text).toString("base64");
const failure = (response: unknown) => Object.assign(new Error("Message failed"), { response });
const [user, password] = ["library@example.org", "p@ss  wörd+1"];
const login = smtpLogin("smtps://library%40example.org:p%40ss%20%20w%C3%B6rd%2B1@mail.example.org:465");

describe("smtpReply", () => {
  it("is the server's answer on one line", () => {
    expect(smtpReply(failure("550-5.7.1 Sender address rejected\r\n550 5.7.1\tsee the docs\u0007"), login)).toBe(
      "550-5.7.1 Sender address rejected 550 5.7.1 see the docs",
    );
  });

  it("holds no login: decoded, as written in the URL, or as AUTH sends it", () => {
    const plain = base64(`\0${user}\0${password}`);
    for (const form of [user, password, "library%40example.org", "p%40ss%20%20w%C3%B6rd%2B1", base64(user), base64(password), plain, plain.replace(/=+$/, "")]) {
      expect(smtpReply(failure(`535 5.7.8 no: ${form} end`), login), form).toBe("535 5.7.8 no: *** end");
    }
    // Longer ones first.
    expect(smtpReply(failure("550 no secret-of-user, only user"), smtpLogin("smtp://user:secret-of-user@mail.example.org"))).toBe("550 no ***, only ***");
  });

  it("hides a login before it cuts the line", () => {
    const reply = smtpReply(failure(`535 ${"x".repeat(190)}${password}`), login)!;
    expect(reply).toHaveLength(197);
    expect(reply.endsWith("x***")).toBe(true);
    expect(smtpReply(failure(`535 ${"x".repeat(500)}`), login)).toHaveLength(200);
  });

  it("is the code when the server sends no text", () => {
    expect(smtpReply(failure("550"), login)).toBe("550");
  });

  it("works without a login", () => {
    expect(smtpReply(failure("550 AAA No such user"), smtpLogin("smtp://mail.example.org:25?name=a@b"))).toBe("550 AAA No such user");
  });

  it.each([
    "smtp://ada%40example.org:p%40ss%2B1@mail.example.org",
    "smtp://ada@example.org:p@ss@mail.example.org",
    "smtp://ada:pass\t-0123@mail.example.org",
    "smtp://ada:p@ss%zz@mail.example.org",
    "smtp:ada:pass-0123@mail.example.org",
    "SMTPS:ada:pass-0123@mail.example.org:99999",
  ])("hides the login that nodemailer reads from %j", (value) => {
    const url = safeSmtpUrl(value);
    const { user, pass } = (nodemailer.createTransport({ url }) as unknown as { transporter: { options: { auth: { user: string; pass: string } } } }).transporter.options.auth;
    expect(smtpReply(failure(`535 no ${user}, ${pass}, ${base64(user)}, ${base64(pass)}`), smtpLogin(url))).toBe("535 no ***, ***, ***, ***");
  });

  it.each([
    ["no answer", failure(undefined)],
    ["an answer that is no refusal", failure("220 ftp.example.org ready")],
    ["another kind of server", failure("HTTP/1.1 400 Bad Request")],
    ["a longer number", failure("4501")],
    ["a server that does not know EHLO", { ...failure("500 what?"), command: "HELO" }],
    ["no error", null],
  ])("is null for %s", (_, error) => {
    expect(smtpReply(error, login)).toBeNull();
  });
});

describe("a failed email over SMTP", () => {
  let stop = async () => {};
  afterEach(() => stop());

  /** Sends to a server that greets, then answers each line with `answer`; the error. */
  async function send(greeting: string, answer: (line: string) => string): Promise<DeliveryError> {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.write(`${greeting}\r\n`);
      socket.on("data", (data) => socket.write(`${answer(String(data).trim())}\r\n`));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    stop = async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    };
    const url = `smtp://library%40example.org:p%40ss%20%20w%C3%B6rd%2B1@127.0.0.1:${(server.address() as AddressInfo).port}`;
    const transport = createSmtpTransport({ url, from: "library@example.org", fromName: "Meldgrove Library" });
    return (await transport.send({ to: "ada@example.org", subject: "Test", text: "Test", html: "<p>Test</p>" }).catch((error: unknown) => error)) as DeliveryError;
  }

  it("has what the mail server answered, without the login", async () => {
    const error = await send("220 mail.example.org ESMTP", (line) =>
      line.startsWith("EHLO") ? "250-mail.example.org\r\n250 AUTH PLAIN" : `535 5.7.8 Authentication failed: ${line} is not ${base64(password)}`,
    );
    expect(error).toMatchObject({ code: "EAUTH", reply: "535 5.7.8 Authentication failed: AUTH PLAIN *** is not ***" });
  });

  it.each([
    ["HTTP/1.1 400 internal-only text", ""],
    ["220 FTP server ready", "500 internal-only text"],
  ])("has no answer of a server that is no mail server (%s)", async (greeting, answer) => {
    const error = await send(greeting, () => answer);
    expect(error.code).toBe("EPROTOCOL");
    expect(error.reply).toBeNull();
  });
});
