import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Loader2,
  Play,
  RefreshCw,
  Save
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { FermataPublicSettings, SessionUser } from "@urmotiv/contracts";
import { AdminLayout } from "../components/admin-layout";
import {
  ApiError,
  getFermataHealth,
  getFermataSettings,
  updateFermataSettings,
  wakeFermata
} from "../lib/api";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}

function sameSettings(left: FermataPublicSettings, right: FermataPublicSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function FermataAdminPage({ session }: { session: SessionUser }) {
  const allowed = session.accountType === "human"
    && session.canManagePlugins
    && session.canManageSystem === true;
  if (!allowed) {
    return (
      <AdminLayout session={session} title="Fermata 审核服务">
        <div className="plain-panel">设置不存在或当前账号不能访问。</div>
      </AdminLayout>
    );
  }
  return <FermataControlPanel session={session} />;
}

function FermataControlPanel({ session }: { session: SessionUser }) {
  const client = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["fermata-settings", session.id],
    queryFn: getFermataSettings,
    retry: false
  });
  const healthQuery = useQuery({
    queryKey: ["fermata-health", session.id],
    queryFn: getFermataHealth,
    retry: false
  });
  const [draft, setDraft] = useState<FermataPublicSettings | null>(null);

  useEffect(() => {
    if (settingsQuery.data !== undefined && draft === null) {
      setDraft(settingsQuery.data.settings);
    }
  }, [draft, settingsQuery.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (draft === null || settingsQuery.data === undefined) {
        throw new Error("Fermata 设置尚未读取完成。");
      }
      return updateFermataSettings({
        expectedRevision: settingsQuery.data.revision,
        settings: draft
      });
    },
    onSuccess: (result) => {
      client.setQueryData(["fermata-settings", session.id], result);
      setDraft(result.settings);
    }
  });
  const wake = useMutation({
    mutationFn: wakeFermata,
    onSuccess: async () => {
      await healthQuery.refetch();
    }
  });

  const reload = async () => {
    setDraft(null);
    save.reset();
    await Promise.all([settingsQuery.refetch(), healthQuery.refetch()]);
  };

  const saved = settingsQuery.data?.settings;
  const dirty = draft !== null && saved !== undefined && !sameSettings(draft, saved);
  const health = healthQuery.data?.health;

  return (
    <AdminLayout
      session={session}
      title="Fermata 审核服务"
      description="独立管理 AI 审题服务的运行状态、模型档位和任务并发，不与原题检索配置混用。"
      actions={
        <button
          type="button"
          className="secondary-button"
          disabled={settingsQuery.isFetching || healthQuery.isFetching}
          onClick={() => void reload()}
        >
          <RefreshCw
            className={settingsQuery.isFetching || healthQuery.isFetching ? "spin" : ""}
            size={15}
            aria-hidden="true"
          />
          重新读取
        </button>
      }
    >
      {(settingsQuery.isError || healthQuery.isError) && draft === null ? (
        <section className="plain-panel admin-load-error" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>暂时无法连接 Fermata</strong>
            <p>{message(settingsQuery.error ?? healthQuery.error)}</p>
            <p>
              先在<Link to="/admin/plugins">插件</Link>中启用 Fermata，并填写服务地址和管理令牌。
            </p>
          </div>
        </section>
      ) : null}

      <section className="admin-status-grid" aria-label="Fermata 运行状态">
        <article className="plain-panel admin-status-card">
          <span className={`status-badge ${health?.status === "ok" ? "success" : "danger"}`}>
            {health?.status === "ok" ? "服务正常" : healthQuery.isLoading ? "读取中" : "服务异常"}
          </span>
          <strong>{health?.workerRunning === true ? "审核 Worker 正在运行" : "审核 Worker 未运行"}</strong>
          <small>当前处理任务：{health?.activeTasks ?? "—"}</small>
        </article>
        <article className="plain-panel admin-status-card">
          <span className={`status-badge ${settingsQuery.data?.secretsConfigured === true ? "success" : "danger"}`}>
            {settingsQuery.data?.secretsConfigured === true ? "模型凭据已配置" : "模型凭据未就绪"}
          </span>
          <strong>{saved?.modelProfileName ?? "尚未读取模型档位"}</strong>
          <small>实验版本：{saved?.experimentVersion ?? "—"}</small>
        </article>
      </section>

      {draft !== null && settingsQuery.data !== undefined ? (
        <section className="plain-panel fermata-settings-panel">
          <div className="admin-section-heading">
            <div>
              <p className="eyebrow">AI 审题运行设置</p>
              <h2>模型档位与任务调度</h2>
              <p>这里的设置实时写入 Fermata；模型档位必须与 Fermata 部署中已有的名称一致。</p>
            </div>
            <Cpu size={25} aria-hidden="true" />
          </div>

          <label className="settings-form-toggle">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={save.isPending}
              onChange={(event) => {
                setDraft({ ...draft, enabled: event.currentTarget.checked });
                save.reset();
              }}
            />
            <span>允许 Fermata 领取待审核题目</span>
          </label>

          <div className="settings-form-grid">
            <label className="field">
              <span>轮询间隔（秒）</span>
              <input
                type="number"
                min={5}
                max={3600}
                value={draft.pollingIntervalSeconds}
                disabled={save.isPending}
                onChange={(event) => setDraft({
                  ...draft,
                  pollingIntervalSeconds: Number(event.currentTarget.value)
                })}
              />
              <small>无新任务时，两次检查之间等待多久。</small>
            </label>
            <label className="field">
              <span>最多并发审核任务</span>
              <input
                type="number"
                min={1}
                max={32}
                value={draft.maximumConcurrentTasks}
                disabled={save.isPending}
                onChange={(event) => setDraft({
                  ...draft,
                  maximumConcurrentTasks: Number(event.currentTarget.value)
                })}
              />
              <small>范围 1–32；它限制整道题任务，不等于模型内部调用数。</small>
            </label>
            <label className="field">
              <span>模型档位名称</span>
              <input
                value={draft.modelProfileName}
                maxLength={120}
                disabled={save.isPending}
                onChange={(event) => setDraft({
                  ...draft,
                  modelProfileName: event.currentTarget.value
                })}
              />
              <small>对应 Fermata 的 config/models.yaml 中 profiles 下的名称。</small>
            </label>
            <label className="field">
              <span>实验版本</span>
              <input
                value={draft.experimentVersion}
                maxLength={120}
                disabled={save.isPending}
                onChange={(event) => setDraft({
                  ...draft,
                  experimentVersion: event.currentTarget.value
                })}
              />
              <small>用于绑定本次提示词、阈值和流程版本，不能与部署配置不一致。</small>
            </label>
          </div>

          <div className="fermata-provider-note">
            <strong>AI 服务地址和密钥在哪里配置？</strong>
            <p>
              在 Fermata 服务自己的 <code>config/models.yaml</code> 中定义模型、思考强度和角色分配；
              在 Fermata 的 <code>.env</code> 中填写对应的 <code>*_BASE_URL</code> 与
              <code>*_API_KEY</code>，再重启 Fermata。模型密钥不会进入 Urmotiv 数据库。
            </p>
            <p>
              插件中的“管理令牌”另有用途：运行 <code>openssl rand -hex 32</code>，将同一值分别填入
              Fermata 的 <code>FERMATA_MANAGEMENT_TOKEN</code> 和 Urmotiv 的 Fermata 插件。
            </p>
          </div>

          {save.isError ? (
            <p className="inline-error" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              {save.error instanceof ApiError && save.error.status === 409
                ? "设置已被其他管理员修改，请重新读取后再保存。"
                : message(save.error)}
            </p>
          ) : null}
          {save.isSuccess && !dirty ? (
            <p className="admin-save-success" role="status">
              <CheckCircle2 size={16} aria-hidden="true" />
              Fermata 运行设置已保存。
            </p>
          ) : null}

          <div className="admin-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={wake.isPending || save.isPending}
              onClick={() => wake.mutate()}
            >
              {wake.isPending ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
              立即检查任务
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
              保存 Fermata 设置
            </button>
          </div>
          {wake.isSuccess ? <p className="admin-save-success" role="status">已请求 Fermata 立即检查任务队列。</p> : null}
          {wake.isError ? <p className="inline-error" role="alert">{message(wake.error)}</p> : null}
        </section>
      ) : null}
    </AdminLayout>
  );
}
