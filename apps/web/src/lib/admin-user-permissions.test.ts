import { afterEach, describe, expect, it, vi } from "vitest";
import { updateAdminUserPermissions } from "./api";

const responseBody = {
  delta: {
    userId: "author",
    roles: ["contributor"],
    allows: ["problem.review"],
    denies: ["problem.create"],
    effective: ["problem.review"],
    revision: 4
  },
  effective: {
    permissions: ["problem.review"],
    entries: [
      { name: "problem.review", allowed: true, sources: ["role:contributor", "user:allow"] },
      { name: "problem.create", allowed: false, sources: ["role:contributor", "user:deny"] }
    ]
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("用户权限 delta 请求契约", () => {
  it("使用浏览器 PUT endpoint 和服务端 envelope 并返回新 revision", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      expectedRevision: 3,
      allows: ["problem.review"],
      denies: ["problem.create"]
    };

    const result = await updateAdminUserPermissions("author", input);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/admin/users/author/permissions",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
        body: JSON.stringify(input),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json"
        })
      })
    );
    expect(result.delta.revision).toBe(4);
    expect(result.effective.entries[1]?.allowed).toBe(false);
  });
});
