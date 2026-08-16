import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProfileView } from "@urmotiv/contracts";
import type * as ApiModule from "../lib/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getMyProfile: vi.fn(),
  updateMyProfile: vi.fn(),
  uploadMyAvatar: vi.fn(),
  deleteMyAvatar: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return { ...original, ...api };
});

import { ProfilePage } from "./profile-page";

const baseProfile: ProfileView = {
  id: "author",
  nickname: "作者演示账号",
  accountType: "human",
  email: "author@example.test",
  emailVerified: true,
  qq: null,
  avatarSource: "none",
  avatarUrl: null,
  studentIds: [{ attribute: "cas:studentId", value: "PB22000001" }]
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(profile: ProfileView | null = baseProfile): HTMLDivElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  if (profile !== null) {
    api.getMyProfile.mockResolvedValue(profile);
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ProfilePage />
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  return container;
}

async function waitFor(assertion: () => void): Promise<void> {
  let latestError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      latestError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  throw latestError;
}

function typeInto(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function nicknameInput(): HTMLInputElement {
  return document.querySelector('input[maxlength="120"]') as HTMLInputElement;
}

function qqInput(): HTMLInputElement {
  return document.querySelector('input[placeholder*="5–11"]') as HTMLInputElement;
}

function emailInput(): HTMLInputElement {
  return document.querySelector('input[readonly]') as HTMLInputElement;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

describe("个人资料页", () => {
  it("渲染资料字段与身份标识，无头像时显示首字默认头像", async () => {
    mount();
    await waitFor(() => {
      expect(nicknameInput()?.value).toBe("作者演示账号");
    });
    expect(qqInput()?.value).toBe("");
    expect(emailInput()?.value).toBe("author@example.test");
    expect(document.querySelector('[data-testid="identifier-list"]')?.textContent).toContain(
      "PB22000001"
    );
    expect(document.querySelector('[data-testid="avatar-initial"]')?.textContent).toContain("作");
    expect(document.querySelector('[data-testid="avatar-source-qq"]')?.hasAttribute("disabled")).toBe(
      true
    );
  });

  it("保存昵称与 QQ，成功后提示并刷新", async () => {
    const saved = { ...baseProfile, nickname: "新昵称", qq: "123456789" };
    api.updateMyProfile.mockResolvedValue(saved);
    api.getMyProfile.mockResolvedValueOnce(baseProfile).mockResolvedValueOnce(saved);
    mount();

    await waitFor(() => expect(nicknameInput()).toBeTruthy());
    typeInto(nicknameInput(), "新昵称");
    typeInto(qqInput(), "123456789");
    act(() => {
      document
        .querySelector('[data-testid="profile-form"]')
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await waitFor(() => {
      expect(api.updateMyProfile.mock.calls[0]?.[0]).toEqual({ nickname: "新昵称", qq: "123456789" });
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="save-success"]')?.textContent).toContain("已保存");
    });
  });

  it("QQ 头像选项在填写 QQ 前禁用，填写后可切换", async () => {
    const withQq = { ...baseProfile, qq: "66668888" };
    api.getMyProfile.mockResolvedValue(withQq);
    mount(withQq);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="avatar-source-qq"]')?.hasAttribute("disabled")).toBe(
        false
      );
    });
    api.updateMyProfile.mockResolvedValue({ ...withQq, avatarSource: "qq" });
    act(() => {
      (
        document.querySelector('[data-testid="avatar-source-qq"]') as HTMLButtonElement
      ).click();
    });
    await waitFor(() => {
      expect(api.updateMyProfile.mock.calls[0]?.[0]).toEqual({ avatarSource: "qq" });
    });
  });

  it("上传头像调用上传接口，非法格式在客户端被拦截", async () => {
    mount();
    await waitFor(() => expect(document.querySelector('[data-testid="avatar-upload-button"]')).toBeTruthy());

    const pdf = new File(["x"], "avatar.pdf", { type: "application/pdf" });
    const inputEl = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(inputEl, "files", { value: [pdf], configurable: true });
    act(() => {
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="avatar-upload-error"]')?.textContent).toContain(
        "只支持"
      );
    });
    expect(api.uploadMyAvatar).not.toHaveBeenCalled();

    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "a.png", {
      type: "image/png"
    });
    api.uploadMyAvatar.mockResolvedValue({ ...baseProfile, avatarSource: "uploaded" });
    Object.defineProperty(inputEl, "files", { value: [png], configurable: true });
    act(() => {
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => {
      expect(api.uploadMyAvatar).toHaveBeenCalledWith(png);
    });
  });

  it("已上传头像时可删除", async () => {
    const uploaded = {
      ...baseProfile,
      avatarSource: "uploaded" as const,
      avatarUrl: "/api/v1/users/author/avatar"
    };
    mount(uploaded);
    await waitFor(() => {
      expect(document.querySelector('[data-testid="avatar-remove-button"]')).toBeTruthy();
    });
    api.deleteMyAvatar.mockResolvedValue(baseProfile);
    act(() => {
      (document.querySelector('[data-testid="avatar-remove-button"]') as HTMLButtonElement).click();
    });
    await waitFor(() => {
      expect(api.deleteMyAvatar).toHaveBeenCalled();
    });
  });

  it("加载失败时显示错误与重试按钮", async () => {
    api.getMyProfile.mockRejectedValue(new Error("boom"));
    mount(null);
    await waitFor(() => {
      expect(document.body.textContent).toContain("无法加载个人资料");
    });
    expect(document.body.textContent).toContain("重试");
  });

  it("机器人账号显示只读提示且不能修改", async () => {
    const robot = { ...baseProfile, id: "robot", nickname: "审核助手", accountType: "robot" as const };
    mount(robot);
    await waitFor(() => {
      expect(document.body.textContent).toContain("机器人账号");
    });
    expect(
      document.querySelector('[data-testid="profile-form"] button[type="submit"]')?.hasAttribute(
        "disabled"
      )
    ).toBe(true);
    expect(nicknameInput()?.hasAttribute("disabled")).toBe(true);
  });
});