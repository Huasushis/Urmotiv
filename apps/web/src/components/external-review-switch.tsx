import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Problem } from "@urmotiv/contracts";
import { updateExternalReview } from "../lib/api";

export function ExternalReviewSwitch({ problem, disabled = false, onChange }: {
  problem: Problem;
  disabled?: boolean | undefined;
  onChange?: ((problem: Problem) => void) | undefined;
}) {
  const client = useQueryClient();
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);
  const save = useMutation({
    mutationFn: (enabled: boolean) => updateExternalReview(problem.id, { enabled, expectedRevision: problem.revision }),
    onSuccess: async updated => {
      onChange?.(updated);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["problem", problem.id] }),
        client.invalidateQueries({ queryKey: ["problems"] })
      ]);
      setPendingValue(null);
    },
    onError: () => setPendingValue(null)
  });
  return <section className="form-section" aria-label="AI 审题设置">
    <label className="checkbox-row">
      <input type="checkbox"
        checked={pendingValue ?? problem.externalReviewEnabled !== false}
        disabled={disabled || save.isPending || !problem.capabilities.canConfigureExternalReview}
        onChange={event => {
          const enabled = event.currentTarget.checked;
          setPendingValue(enabled);
          save.mutate(enabled);
        }} />
      允许 AI 审题
    </label>
    <p className="field-help">提交审核后，允许已授权的外部审核服务读取本题的题面和题解并提供意见。关闭不影响人工审核，也不会删除已有意见。</p>
    {disabled ? <p className="field-help">请先保存其他修改，再调整 AI 审题。</p> : null}
    {save.isPending ? <p role="status">正在保存 AI 审题设置…</p> : null}
    {save.error ? <p className="form-error" role="alert">{save.error.message}</p> : null}
  </section>;
}
