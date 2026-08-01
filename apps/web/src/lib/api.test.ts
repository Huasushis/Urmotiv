import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listProblemFiles,
  problemFileDownloadUrl,
  problemFileReferenceUrl,
  uploadProblemFile
} from "./api";

const fileId = "7293643f-8197-449c-b48b-f674ab0b3772";
const fileSummary = {
  id: fileId,
  category: "statement_image" as const,
  logicalPath: "assets/synthetic.png",
  position: 0,
  originalName: "synthetic.png",
  mediaType: "image/png",
  byteSize: 9,
  sha256: "a".repeat(64),
  createdAt: "2026-08-01T00:00:00.000Z"
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("题目文件 API client", () => {
  it("从题目范围内列出文件并校验响应", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ items: [fileSummary] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listProblemFiles("42")).resolves.toEqual({ items: [fileSummary] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/problems/42/files",
      expect.objectContaining({ method: "GET", credentials: "include" })
    );
  });

  it("以二进制正文上传文件并传递版本与文件类别", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ item: fileSummary, revision: 3 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["synthetic"], "synthetic.png", { type: "image/png" });

    await expect(
      uploadProblemFile("42", {
        file,
        expectedRevision: 2,
        category: "statement_image",
        logicalPath: "assets/synthetic.png"
      })
    ).resolves.toEqual({ item: fileSummary, revision: 3 });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/api/v1/problems/42/files?");
    const parameters = new URL(String(url), "http://localhost").searchParams;
    expect(Object.fromEntries(parameters)).toMatchObject({
      expectedRevision: "2",
      category: "statement_image",
      logicalPath: "assets/synthetic.png",
      originalName: "synthetic.png",
      mediaType: "image/png",
      replaceExisting: "false"
    });
    expect(init).toMatchObject({
      method: "PUT",
      credentials: "include",
      body: file,
      headers: expect.objectContaining({ "Content-Type": "application/octet-stream" })
    });
  });

  it("只生成带题目编号的预览与下载地址", () => {
    expect(problemFileReferenceUrl("42", fileId)).toBe(
      `/api/v1/problems/42/files/${fileId}`
    );
    expect(problemFileDownloadUrl("42", fileId)).toBe(
      `/api/v1/problems/42/files/${fileId}`
    );
  });
});
