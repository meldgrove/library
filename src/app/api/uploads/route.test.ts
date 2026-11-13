import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCurrentPerson: vi.fn(), submitFile: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getCurrentPerson: mocks.getCurrentPerson }));
vi.mock("@/lib/config", () => ({
  getAuthConfig: () => ({ LIBRARY_BASE_URL: "https://library.example" }),
  getUploadConfig: () => ({ UPLOAD_MAX_MB: 1 }),
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/storage", () => ({ getStorage: () => ({}) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({ ...(await importOriginal<object>()), consumeRateLimit: vi.fn() }));
vi.mock("@/lib/library/submissions", () => ({ submitFile: mocks.submitFile, submitLink: vi.fn() }));

const { POST } = await import("./route");

const upload = (init: { headers?: Record<string, string>; body?: BodyInit }) =>
  POST(
    new Request("https://library.example/api/uploads", {
      method: "POST",
      headers: { origin: "https://library.example", ...init.headers },
      body: init.body,
      duplex: "half",
    } as RequestInit),
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentPerson.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000001" });
});

describe("POST /api/uploads", () => {
  it("refuses other origins", async () => {
    expect((await upload({ headers: { origin: "https://evil.example" }, body: "x" })).status).toBe(403);
  });

  it("refuses a body without a declared length before reading it", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(10)));
        controller.close();
      },
    });
    const response = await upload({ body: stream });
    expect(response.status).toBe(411);
    expect(mocks.submitFile).not.toHaveBeenCalled();
  });

  it("refuses a declared length over the limit", async () => {
    const response = await upload({ headers: { "content-length": String(2 * 1_048_576) }, body: "x" });
    expect(response.status).toBe(413);
  });

  it("passes a file to the submissions module", async () => {
    mocks.submitFile.mockResolvedValue({ submissionId: "s1" });
    const form = new FormData();
    form.set("kind", "file");
    form.set("reason", "Numbers on heat");
    form.set("confirmed", "on");
    form.set("file", new File(["%PDF-1.7"], "study.pdf", { type: "application/pdf" }));
    const body = new Response(form);
    const bytes = new Uint8Array(await body.arrayBuffer());
    const response = await upload({ headers: { "content-type": body.headers.get("content-type")!, "content-length": String(bytes.byteLength) }, body: bytes });
    expect(response.status).toBe(201);
    expect(mocks.submitFile).toHaveBeenCalledWith({}, {}, expect.objectContaining({ fileName: "study.pdf", reason: "Numbers on heat", channel: "web" }), 1_048_576);
  });
});
