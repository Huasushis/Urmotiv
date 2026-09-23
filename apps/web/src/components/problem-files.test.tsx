import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Problem, ProblemFileSummary } from "@urmotiv/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listProblemFiles: vi.fn(),
  uploadProblemFile: vi.fn(),
  removeProblemFile: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return { ...original, ...api };
});

import {
  bindJudgeProgramConfig,
  JudgeProgramPanel,
  ProblemFilesPanel,
  judgeProgramCategoryForType
} from "./problem-files";

const timestamp = "2026-08-01T08:00:00.000Z";

function problem(type: Problem["type"] = "traditional"): Problem {
  return {
    id: "problem-1",
    title: "评测程序界面测试题",
    type,
    tagIds: ["algorithm.implementation"],
    codeforcesDifficulty: null,
    thinkingLevel: null,
    codingLevel: null,
    content: {
      basicStatement: "输出输入。",
      basicSolution: "直接输出。",
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: ""
    },
    samples: [],
    judgeConfig: {
      version: 1,
      limits: { timeMs: 1000, memoryMiB: 512 },
      scoring: { total: 100, subtaskMode: "sum" },
      subtasks: [],
      testcases: [],
      ...(type === "traditional" ? { checker: { type: "standard" as const } } : {})
    },
    status: "draft",
    owner: { id: "author", nickname: "作者", accountType: "human" },
    revision: 1,
    reviewRound: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    capabilities: {
      canView: true,
      canEdit: true,
      canEditTitle: true,
      canEditFrozen: false,
      canSubmit: true,
      canWithdraw: false,
      canReview: false,
      canChangeStatus: false,
      canReadTestdata: true,
      canWriteTestdata: true,
      canExport: false,
      canViewAccessLog: false
    }
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(element: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  act(() => {
    root?.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
  return container;
}

async function waitFor(assertion: () => void): Promise<void> {
  let latest: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      latest = error;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    }
  }
  throw latest;
}

async function selectFile(view: HTMLElement, file: File): Promise<void> {
  const input = view.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("找不到评测程序文件输入框。");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

describe("评测程序上传与绑定", () => {
  it('删除叉号需确认，失败保留附件且不伪造版本',async()=>{
    const current=problem();current.capabilities.canReadTestdata=false;current.capabilities.canWriteTestdata=false;
    const file={id:'11111111-1111-4111-8111-111111111111',category:'public_attachment',logicalPath:'attachments/x.txt',originalName:'x.txt',position:0,mediaType:'text/plain',byteSize:1,sha256:'a'.repeat(64),createdAt:timestamp};
    api.listProblemFiles.mockResolvedValue({items:[file]});api.removeProblemFile.mockRejectedValue(new Error('版本冲突，请刷新'));
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(false),onRevisionChange=vi.fn();
    const view=mount(<ProblemFilesPanel problem={current} onRevisionChange={onRevisionChange}/>);
    await waitFor(()=>expect(view.querySelector('[aria-label="删除 x.txt"]')).not.toBeNull());
    await act(async()=>view.querySelector<HTMLButtonElement>('[aria-label="删除 x.txt"]')!.click());expect(api.removeProblemFile).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);await act(async()=>view.querySelector<HTMLButtonElement>('[aria-label="删除 x.txt"]')!.click());
    await waitFor(()=>expect(view.textContent).toContain('版本冲突'));expect(onRevisionChange).not.toHaveBeenCalled();expect(view.textContent).toContain('x.txt');
    confirm.mockRestore();
  });
  it('只有阅读权限时附件没有删除入口',async()=>{
    const current=problem();current.capabilities.canEdit=false;current.capabilities.canReadTestdata=false;current.capabilities.canWriteTestdata=false;
    api.listProblemFiles.mockResolvedValue({items:[{id:'11111111-1111-4111-8111-111111111111',category:'public_attachment',logicalPath:'attachments/x.txt',originalName:'x.txt',position:0,mediaType:'text/plain',byteSize:1,sha256:'a'.repeat(64),createdAt:timestamp}]});
    const view=mount(<ProblemFilesPanel problem={current}/>);await waitFor(()=>expect(view.textContent).toContain('x.txt'));expect(view.querySelector('[aria-label="删除 x.txt"]')).toBeNull();
  });
  it("三种题型只生成各自的程序字段", () => {
    expect(judgeProgramCategoryForType("traditional")).toBe("checker");
    expect(judgeProgramCategoryForType("interactive")).toBe("interactor");
    expect(judgeProgramCategoryForType("submit_answer")).toBe("answer_checker");

    expect(bindJudgeProgramConfig(problem().judgeConfig, "interactive", "judge/interactor/i.cpp"))
      .toEqual(expect.objectContaining({ interactor: { source: "judge/interactor/i.cpp" } }));
    expect(bindJudgeProgramConfig(problem().judgeConfig, "interactive", "judge/interactor/i.cpp"))
      .not.toHaveProperty("checker");
  });

  it("上传成功后才通知工作区绑定，并明确请求原子绑定", async () => {
    const current = problem("interactive");
    const item: ProblemFileSummary = {
      id: "11111111-1111-4111-8111-111111111111",
      category: "interactor",
      logicalPath: "judge/interactor/new.cpp",
      position: 0,
      originalName: "new.cpp",
      mediaType: "text/x-c++src",
      byteSize: 10,
      sha256: "a".repeat(64),
      createdAt: timestamp
    };
    api.listProblemFiles.mockResolvedValue({ items: [] });
    api.uploadProblemFile.mockResolvedValue({ item, revision: 2 });
    const onBound = vi.fn();
    const pending = vi.fn();
    const view = mount(
      <JudgeProgramPanel problem={current} onBound={onBound} onPendingChange={pending} />
    );

    await waitFor(() => expect(view.textContent).toContain("尚未绑定交互程序"));
    await selectFile(view, new File(["int main(){}"], "new.cpp", { type: "text/x-c++src" }));
    await waitFor(() => expect(onBound).toHaveBeenCalledTimes(1));

    expect(api.uploadProblemFile).toHaveBeenCalledWith(
      current.id,
      expect.objectContaining({
        expectedRevision: 1,
        category: "interactor",
        bindJudgeProgram: true
      })
    );
    expect(onBound).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ interactor: { source: item.logicalPath } })
    );
    expect(pending.mock.calls).toEqual([[true], [false]]);
  });

  it("上传或 409 保存失败时保留原显示且不通知假绑定", async () => {
    const current = problem();
    api.listProblemFiles.mockResolvedValue({ items: [] });
    api.uploadProblemFile.mockRejectedValue(new Error("题目已被其他操作修改，请刷新后重试。"));
    const onBound = vi.fn();
    const view = mount(<JudgeProgramPanel problem={current} onBound={onBound} />);

    await waitFor(() => expect(view.textContent).toContain("当前使用标准比较"));
    await selectFile(view, new File(["checker"], "check.cpp", { type: "text/x-c++src" }));
    await waitFor(() => expect(view.textContent).toContain("题目已被其他操作修改"));

    expect(onBound).not.toHaveBeenCalled();
    expect(view.textContent).toContain("当前使用标准比较");
    expect(view.textContent).not.toContain("已绑定");
  });
});
