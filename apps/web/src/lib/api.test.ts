import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmTagDeactivation,
  createTagAlias,
  createTagCatalogItem,
  deleteTagAlias,
  listManagedTagCatalog,
  listProblemFiles,
  listTags,
  previewTagDeactivation,
  problemFileDownloadUrl,
  problemFileReferenceUrl,
  updateTagAlias,
  updateTagCatalogItem,
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

describe("知识点目录管理 API client", () => {
  it("普通目录读取保留搜索说明、别名和停用状态", async () => {
    const body = {
      version: 4,
      items: [{
        id: "tag.shortest-path",
        name: "最短路",
        group: "图论",
        itemKind: "tag",
        active: false,
        category: { id: "category.graph", name: "图论" },
        description: "求带权图中的最小距离",
        aliases: ["Shortest Path"]
      }]
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body)));

    await expect(listTags()).resolves.toEqual({ items: body.items });
  });

  it("校验管理目录响应并保留目录版本和别名", async () => {
    const body = {
      version: 3,
      items: [{
        id: "category.algorithm",
        itemKind: "category",
        parentId: null,
        name: "基础算法",
        description: "常见算法方法",
        sortOrder: 1,
        active: true
      }],
      aliases: []
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listManagedTagCatalog()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/admin/tag-catalog",
      expect.objectContaining({ method: "GET", credentials: "include" })
    );
  });

  it("对目录项、别名和两步停用使用带版本的专用路径", async () => {
    const preview = {
      confirmationId: "11111111-1111-4111-8111-111111111111",
      catalogVersion: 7,
      expiresAt: "2026-08-02T12:00:00.000Z",
      impact: {
        currentProblemCount: 1,
        soleCurrentTagCount: 0,
        historicalRevisionCount: 2,
        reviewOpinionCount: 3,
        childTagCount: 0
      }
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: 8 }))
      .mockResolvedValueOnce(jsonResponse({ version: 9 }))
      .mockResolvedValueOnce(jsonResponse({ version: 10, aliasId: "22222222-2222-4222-8222-222222222222" }))
      .mockResolvedValueOnce(jsonResponse({ version: 11 }))
      .mockResolvedValueOnce(jsonResponse({ version: 12 }))
      .mockResolvedValueOnce(jsonResponse(preview))
      .mockResolvedValueOnce(jsonResponse({ version: 13 }));
    vi.stubGlobal("fetch", fetchMock);

    await createTagCatalogItem({
      expectedVersion: 7,
      id: "custom.tag.example",
      itemKind: "tag",
      parentId: "category.algorithm",
      name: "示例知识点",
      description: "",
      sortOrder: 0
    });
    await updateTagCatalogItem("tag/a", { expectedVersion: 8, name: "新名称" });
    await createTagAlias("tag/a", { expectedVersion: 9, name: "旧名称" });
    await updateTagAlias("tag/a", "22222222-2222-4222-8222-222222222222", { expectedVersion: 10, name: "旧写法" });
    await deleteTagAlias("tag/a", "22222222-2222-4222-8222-222222222222", { expectedVersion: 11 });
    await previewTagDeactivation("tag/a", { replacementTagId: "tag.sort" });
    await confirmTagDeactivation("tag/a", {
      confirmationId: preview.confirmationId,
      catalogVersion: preview.catalogVersion
    });

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body
    }));
    expect(calls).toEqual([
      { url: "/api/v1/admin/tag-catalog/items", method: "POST", body: expect.objectContaining({ expectedVersion: 7 }) },
      { url: "/api/v1/admin/tag-catalog/items/tag%2Fa", method: "PATCH", body: { expectedVersion: 8, name: "新名称" } },
      { url: "/api/v1/admin/tag-catalog/items/tag%2Fa/aliases", method: "POST", body: { expectedVersion: 9, name: "旧名称" } },
      { url: "/api/v1/admin/tag-catalog/items/tag%2Fa/aliases/22222222-2222-4222-8222-222222222222", method: "PATCH", body: { expectedVersion: 10, name: "旧写法" } },
      { url: "/api/v1/admin/tag-catalog/items/tag%2Fa/aliases/22222222-2222-4222-8222-222222222222", method: "DELETE", body: { expectedVersion: 11 } },
      { url: "/api/v1/admin/tag-catalog/items/tag%2Fa/deactivation-preview", method: "POST", body: { replacementTagId: "tag.sort" } },
      { url: "/api/v1/admin/tag-catalog/items/tag%2Fa/deactivate", method: "POST", body: { confirmationId: preview.confirmationId, catalogVersion: 7 } }
    ]);
  });
});
