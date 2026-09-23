import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Problem, ProblemFileSummary } from "@urmotiv/contracts";
import { readStandardProgram, uploadProblemFile } from "../lib/api";
import { sourceLanguage, sourceLanguages, type StandardProgram } from "../lib/standard-program";
import { StandardProgramEditor } from "./standard-program-editor";

export function StandardProgramPanel({
  problem,
  files,
  disabled,
  onRevisionChange,
  onPendingChange,
}: {
  problem: Problem;
  files: ProblemFileSummary[];
  disabled: boolean;
  onRevisionChange?: ((revision: number) => void) | undefined;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}) {
  const client = useQueryClient();
  const programs = files.filter((file) => file.category === "standard_solution");
  const [selected, setSelected] = useState<string | null>(null);
  const [value, setValue] = useState<StandardProgram>({ source: "", language: "cpp" });
  const dirty = useRef(false);
  const [message, setMessage] = useState("");
  const initialized = useRef(false);
  const current = programs.find((file) => file.id === selected);
  useEffect(() => {
    if (!initialized.current && programs.length) {
      initialized.current = true;
      setSelected(programs[0]!.id);
    }
  }, [programs[0]?.id]);
  const canRead =
    problem.capabilities.canReadStandardSolution ?? problem.capabilities.canReadTestdata;
  const canWrite =
    problem.capabilities.canEdit &&
    (problem.capabilities.canWriteStandardSolution ?? problem.capabilities.canWriteTestdata);
  const source = useQuery({
    queryKey: ["standard-program", problem.id, selected],
    queryFn: () => readStandardProgram(problem.id, selected!),
    enabled: !!selected && canRead,
    retry: false,
  });
  useEffect(() => {
    if (source.data !== undefined && !dirty.current && current)
      setValue({ source: source.data, language: sourceLanguage(current.originalName) });
  }, [source.data, current?.id]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  const choose = (id: string | null) => {
    if (dirty.current && !window.confirm("放弃尚未保存的标准程序修改？")) return;
    initialized.current = true;
    dirty.current = false;
    setSelected(id);
    setValue({ source: "", language: "cpp" });
    setMessage("");
  };
  const save = useMutation({
    mutationFn: async () => {
      onPendingChange?.(true);
      const ext = sourceLanguages.find((item) => item.id === value.language)?.extension ?? "txt";
      return uploadProblemFile(problem.id, {
        file: new File([value.source], `std.${ext}`, { type: "text/plain" }),
        category: "standard_solution",
        logicalPath: `solutions/std/${crypto.randomUUID()}.${ext}`,
        expectedRevision: problem.revision,
        ...(current ? { replaceFileId: current.id } : {}),
      });
    },
    onSuccess: (result) => {
      dirty.current = false;
      setSelected(result.item.id);
      setMessage("标准程序已保存。");
      client.setQueryData(["standard-program", problem.id, result.item.id], value.source);
      onRevisionChange?.(result.revision);
      void client.invalidateQueries({ queryKey: ["problem-files", problem.id] });
    },
    onSettled: () => onPendingChange?.(false),
  });
  if (!canRead && !canWrite) return null;
  return (
    <section className="standard-program-panel" aria-label="标准程序">
      <h3>标准程序（std）</h3>
      <div className="inline-actions">
        <label>
          已保存的标准程序
          <select
            value={selected ?? ""}
            disabled={save.isPending}
            onChange={(event) => choose(event.target.value || null)}
          >
            <option value="">新增标准程序</option>
            {programs.map((file) => (
              <option key={file.id} value={file.id}>
                {file.originalName}
              </option>
            ))}
          </select>
        </label>
      </div>
      {selected && source.isPending ? (
        <p role="status">正在读取源码…</p>
      ) : source.isError ? (
        <p role="alert">{source.error.message}</p>
      ) : (
        <StandardProgramEditor
          value={value}
          onChange={(next) => {
            dirty.current = true;
            setValue(next);
            setMessage("");
          }}
          readOnly={!canWrite || save.isPending}
        />
      )}
      {save.error ? (
        <p role="alert" className="inline-error">
          {save.error.message} 原文仍保留，可以重试。
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {canWrite ? (
        <button
          className="secondary-button"
          type="button"
          disabled={
            disabled ||
            save.isPending ||
            !value.source.trim() ||
            (!!selected && (!current || source.isPending || source.isError))
          }
          onClick={() => save.mutate()}
        >
          {save.isPending ? "正在保存源码…" : "保存标准程序"}
        </button>
      ) : null}
      {disabled ? <p className="field-help">请先等待题目正文保存完成。</p> : null}
    </section>
  );
}
