import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionResponse } from "@urmotiv/contracts";
import type * as ApiModule from "../lib/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  listTags: vi.fn(),
  createProblem: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return { ...original, ...api };
});

import { CreateProblemPage } from "./create-problem-page";

const authorSession: SessionResponse = {
  user: {
    id: "author",
    nickname: "作者",
    accountType: "human",
    permissions: ["problem.create"],
    roles: ["投稿人"],
    isRoot: false,
    canManageReviewPolicy: false,
    canManagePlugins: false,
    canManageTags: false
  },
  auth: {
    emailEnabled: false,
    emailRegistrationEnabled: false,
    casEnabled: false,
    demoEnabled: true
  }
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(): HTMLDivElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  client.setQueryData(["session"], authorSession);
  api.getSession.mockResolvedValue(authorSession);
  api.listTags.mockResolvedValue({ items: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CreateProblemPage />
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
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  throw latestError;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

describe("新建题目页冻结说明", () => {
  it("明确说明待审核后只冻结题面和题解，题目名称仍可修改", async () => {
    mount();

    await waitFor(() => expect(container!.textContent).toContain("基础审核内容"));

    const text = container!.textContent;

    expect(text).toContain("这两项会冻结");
    expect(text).toContain("题目名称仍可修改");
    expect(text).not.toContain("题目名称会冻结");
    expect(text).not.toContain("名称会冻结");
  });
});
